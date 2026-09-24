"""Runs steps against a real ``Model`` and records what happened.

A step is a JSON-ready dict: ``do`` names a method of the mutation boundary,
the other keys are its arguments (property values tagged, see ``tagged.py``);
``batch`` runs an op batch through the server's applier and ``undo`` runs the
inverse ops of an earlier batch in restore mode. ``read`` calls a read route
function on the recorder's model and records the response body; ``view`` and
``drop_view`` keep the views a read may name, ``artifacts`` the project
artifacts it may fetch. ``navigate`` and ``has_script`` run the navigation
core itself on a definition whose refs resolve against those artifacts.
``validate`` runs the six built-in validators over a scope of ids and records
the issues as the server's routes send them. ``insert_element`` and
``insert_relationship`` put an entity in as committed state arrives, its type
unchecked. After every step the recorder
adds the outcome (``result`` or ``error``) and what the step left behind: the
state digest and a fingerprint of the entity lines plus the index dump. Every
``full_every``-th step, and the last, carries the lines and the dump
themselves, so a mismatch can be read, not just seen. A step that changed
nothing says ``"unchanged": true`` instead. The engine's golden runner replays
the same steps and compares all of it.

A batch runs on the recorder's own model, as it does on a session's. A refused
batch leaves no trace — the applier puts every touched entity back, ``rev``
and place in insertion order included — and the recorder holds the oracle to
it: a refusal that changed the state, the index dump or the digest fails the
run instead of entering a fixture. The ids a refused batch drew go back to the
generator, which is the recorder's scaffolding and no part of the state.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Iterable
from types import SimpleNamespace
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, TypeAdapter

from data_rover.api.db_models import ArtifactKind, ArtifactRow
from data_rover.api.deps import Session
from data_rover.api.routes import artifacts as artifact_routes
from data_rover.api.routes import read
from data_rover.api.routes.elements import get_element
from data_rover.api.routes.ops import _apply_batch, _BatchResult
from data_rover.api.schemas import (
    ElementOut,
    EvaluateNavigationIn,
    IssueOut,
    ModelOpIn,
    RelationshipOut,
)
from data_rover.api.search import SearchQueryIn
from data_rover.api.serialize import iter_entity_lines
from data_rover.api.settings import Settings
from data_rover.api.state_digest import model_digest
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.navigation.evaluate import EvalLimits, evaluate
from data_rover.core.navigation.resolve import navigation_has_script, resolve_refs
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER, NavigationDefinition
from data_rover.core.validation.pipeline import ValidationPipeline, default_validators
from data_rover.core.validation.scope import Scope
from data_rover.core.view.schema import View

from .index_dump import dump_indexes
from .tagged import tag


_MODEL_OPS: TypeAdapter[list[ModelOpIn]] = TypeAdapter(list[ModelOpIn])


def _line(doc: BaseModel) -> str:
    """One op or entity as the compact JSON text the server writes."""
    return json.dumps(
        doc.model_dump(), separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def fingerprint(state: list[str], indexes: str) -> str:
    """16 hex digits over the entity lines and the index dump text."""
    text = "\n".join(state) + "\n" + indexes
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def observe(model: Model) -> dict[str, Any]:
    """The state, index dump and digest of a model the oracle agrees with.

    The dump travels as compact JSON text: indented, its id lists would take
    a line per id and dwarf everything else in the fixture.
    """
    model.indexes.verify_consistent()
    state = list(iter_entity_lines(model))
    indexes = json.dumps(dump_indexes(model), separators=(",", ":"), ensure_ascii=False)
    return {
        "digest": model_digest(model),
        "fingerprint": fingerprint(state, indexes),
        "state": state,
        "indexes": indexes,
    }


def set_property(entity_id: str, prop: str, value: Any, **extra: Any) -> dict[str, Any]:
    """A ``set_property`` step. The raw value rides along under ``_value``;
    the recorder applies it and writes its tagged form."""
    return {
        "do": "set_property",
        "id": entity_id,
        "prop": prop,
        "_value": value,
        **extra,
    }


def batch(ops: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    """A ``batch`` step. The raw ops ride along under ``_ops``; the recorder
    validates them as the ops route does and writes each as one line of text."""
    return {"do": "batch", "_ops": ops, **extra}


def read_step(method: str, **params: Any) -> dict[str, Any]:
    """A ``read`` step: a method of the engine's read or evaluation table, with
    its params."""
    return {"do": "read", "method": method, "params": params}


def validate_step(scope: list[str] | str) -> dict[str, Any]:
    """A ``validate`` step over the ids of ``scope``, in its order, or over
    ``"all_ids"``: every element id in state order, then every relationship
    id."""
    return {"do": "validate", "scope": scope}


def view_step(view_id: str, folders: list[dict[str, Any]]) -> dict[str, Any]:
    """A ``view`` step. The folders ride along under ``_folders``; the recorder
    records the element ids the view places, as a client would register them."""
    return {"do": "view", "view_id": view_id, "_folders": folders}


#: an artifact as the recorder keeps it: its kind and its payload
Artifacts = dict[str, dict[str, Any]]


class _ArtifactDb:
    """Stands in for the database session the navigation route fetches
    artifacts through: every artifact belongs to project ``p``."""

    def __init__(self, artifacts: Artifacts) -> None:
        self._artifacts = artifacts

    def get(self, row_type: type[ArtifactRow], artifact_id: str) -> Any:
        assert row_type is ArtifactRow
        artifact = self._artifacts.get(artifact_id)
        if artifact is None:
            return None
        return SimpleNamespace(
            project_id="p",
            kind=ArtifactKind(artifact["kind"]),
            payload=artifact["payload"],
        )


def _fetch(artifacts: Artifacts, artifact_id: str) -> NavigationDefinition:
    """The route's own fetch: a navigation artifact's payload, or a
    ``LookupError``."""
    artifact = artifacts.get(artifact_id)
    if artifact is None or artifact["kind"] != ArtifactKind.navigation:
        raise LookupError(artifact_id)
    return NAVIGATION_ADAPTER.validate_python(artifact["payload"])


def _resolved(artifacts: Artifacts, definition: Any) -> NavigationDefinition:
    return resolve_refs(
        NAVIGATION_ADAPTER.validate_python(definition),
        lambda artifact_id: _fetch(artifacts, artifact_id),
    )


def _navigate(model: Model, artifacts: Artifacts, step: dict[str, Any]) -> Any:
    """The evaluator's own result: element nodes as ids, value nodes tagged."""
    limits = step["limits"]
    result = evaluate(
        model.metamodel,
        model,
        _resolved(artifacts, step["definition"]),
        EvalLimits(max_visited=limits["max_visited"], max_chains=limits["max_chains"]),
        row_elements=step.get("row_elements"),
    )
    return {
        "step_types": result.step_types,
        "chains": [
            [
                node if isinstance(node, str) else {"value": tag(node.value)}
                for node in chain
            ]
            for chain in result.chains
        ],
        "truncated": result.truncated,
    }


def _read(
    session: Session, artifacts: Artifacts, method: str, params: dict[str, Any]
) -> BaseModel:
    """Calls the route function behind ``method`` with every argument passed:
    called directly, a route keeps ``Query(...)`` objects as its defaults."""
    limit = params.get("limit", 100)
    offset = params.get("offset", 0)
    match method:
        case "getElement":
            return get_element(params["id"], session=session)
        case "getElementsBatch":
            return read.batch_elements(
                read.BatchElementsIn(ids=params["ids"]), session=session
            )
        case "listElementsPage":
            return read.list_elements(
                type=params.get("type"),
                q=params.get("q"),
                limit=limit,
                offset=offset,
                session=session,
            )
        case "listElementRelationships":
            return read.list_element_relationships(
                params["id"],
                direction=params.get("direction", "both"),
                limit=limit,
                offset=offset,
                session=session,
            )
        case "getModelSummary":
            return read.get_model_summary(session=session)
        case "getTreeItemsBatch":
            return read.batch_tree_items(
                read.TreeItemsIn(ids=params["ids"]), session=session
            )
        case "listContainmentRoots":
            return read.list_containment_roots(
                limit=limit, offset=offset, session=session
            )
        case "listExcludedRoots":
            return read.list_excluded_roots(
                limit=limit,
                offset=offset,
                view_id=params.get("view_id"),
                session=session,
            )
        case "listContainmentChildren":
            return read.list_containment_children(
                params["id"], limit=limit, offset=offset, session=session
            )
        case "searchModel":
            return read.search_model(
                SearchQueryIn.model_validate(params), session=session
            )
        case "evaluateNavigation":
            return artifact_routes.evaluate_navigation(
                EvaluateNavigationIn.model_validate(params),
                project_id="p",
                session=session,
                db=_ArtifactDb(artifacts),  # type: ignore[arg-type]
                runner=None,
                settings=Settings(),
            )
    raise AssertionError(f"unknown read {method!r}")


def _outcome(model: Model, res: _BatchResult) -> dict[str, Any]:
    """What a landed batch reports, and the delta a replica would be sent."""
    return {
        "id_map": [[temp, real] for temp, real in res.id_map.items()],
        "changed_element_ids": list(res.changed_element_ids),
        "changed_relationship_ids": list(res.changed_relationship_ids),
        "deleted_element_ids": list(res.deleted_element_ids),
        "deleted_relationship_ids": list(res.deleted_relationship_ids),
        "recreated_element_ids": list(res.recreated_element_ids),
        "recreated_relationship_ids": list(res.recreated_relationship_ids),
        "before_elements": [
            [eid, None if before is None else _line(before)]
            for eid, before in res.before_elements.items()
        ],
        "before_relationships": [
            [rid, None if before is None else _line(before)]
            for rid, before in res.before_relationships.items()
        ],
        "inverse_ops": [_line(op) for op in res.inverse_ops()],
        "changed_elements": [
            _line(ElementOut.from_core(model.elements[eid]))
            for eid in res.changed_element_ids
        ],
        "changed_relationships": [
            _line(RelationshipOut.from_core(model.relationships[rid]))
            for rid in res.changed_relationship_ids
        ],
    }


class _Ids:
    """``id-1``, ``id-2``, … with a counter the recorder can put back."""

    def __init__(self) -> None:
        self.drawn = 0

    def new_id(self) -> str:
        self.drawn += 1
        return f"id-{self.drawn}"


class Recorder:
    """One scenario in the making: a model with sequential ids, and its log."""

    def __init__(self, metamodel: Metamodel, *, full_every: int = 5) -> None:
        self.metamodel = metamodel
        self._ids = _Ids()
        self.model = Model(metamodel, self._ids)
        self._full_every = full_every
        self._steps: list[dict[str, Any]] = []
        self._last: dict[str, Any] | None = None
        self._landed: dict[int, _BatchResult] = {}
        self._views: dict[str, View] = {}
        self._artifacts: Artifacts = {}

    def _entity(self, step: dict[str, Any]) -> Element | Relationship:
        detached = step.get("detached")
        if detached == "element":
            return Element(id=step["id"], type_name=step["type"])
        if detached == "relationship":
            return Relationship(
                id=step["id"], type_name=step["type"], source_id="", target_id=""
            )
        model = self.model
        entity = model.elements.get(step["id"]) or model.relationships.get(step["id"])
        if entity is None:
            raise AssertionError(f"scenario names an unknown entity {step['id']!r}")
        return entity

    def _batch(self, ops: list[ModelOpIn], *, restore: bool) -> dict[str, Any]:
        drawn = self._ids.drawn
        try:
            res = _apply_batch(self.model, ops, restore=restore)
        except HTTPException:
            self._ids.drawn = drawn
            raise
        self._landed[len(self._steps)] = res
        return _outcome(self.model, res)

    def _apply(self, step: dict[str, Any]) -> Any:
        model = self.model
        match step["do"]:
            case "batch":
                ops = _MODEL_OPS.validate_python(step["_ops"])
                return self._batch(ops, restore=bool(step.get("restore", False)))
            case "undo":
                return self._batch(self._landed[step["of"]].inverse_ops(), restore=True)
            case "read":
                session = Session(
                    metamodel=self.metamodel, model=model, views=self._views
                )
                body = _read(session, self._artifacts, step["method"], step["params"])
                return body.model_dump(mode="json")
            case "validate":
                scope = step["scope"]
                ids = (
                    [*model.elements, *model.relationships]
                    if scope == "all_ids"
                    else scope
                )
                issues = ValidationPipeline(default_validators()).validate(
                    model, Scope(ids)
                )
                return [IssueOut.from_core(i).model_dump(mode="json") for i in issues]
            case "artifacts":
                self._artifacts = dict(step["_artifacts"])
                return None
            case "navigate":
                return _navigate(model, self._artifacts, step)
            case "has_script":
                return navigation_has_script(
                    _resolved(self._artifacts, step["definition"])
                )
            case "view":
                view = View.model_validate(
                    {"name": step["view_id"], "folders": step["_folders"]}
                )
                self._views[step["view_id"]] = view
                return sorted(read._placed_element_ids(view))
            case "drop_view":
                self._views.pop(step["view_id"], None)
                return None
            case "create_element":
                return model.create_element(step["type"]).id
            case "restore_element":
                return model.restore_element(step["id"], step["type"]).id
            case "insert_element":
                return model.insert_element(
                    step["id"], step["type"], copy.deepcopy(step["_value"]), step["rev"]
                ).id
            case "insert_relationship":
                return model.insert_relationship(
                    step["id"],
                    step["type"],
                    step["source"],
                    step["target"],
                    copy.deepcopy(step["_value"]),
                    step["rev"],
                ).id
            case "get_element":
                return model.get_element(step["id"]).id
            case "get_relationship":
                return model.get_relationship(step["id"]).id
            case "set_property":
                model.set_property(self._entity(step), step["prop"], step["_value"])
                return None
            case "delete_property":
                model.delete_property(self._entity(step), step["prop"])
                return None
            case "connect":
                return model.connect(step["type"], step["source"], step["target"]).id
            case "restore_relationship":
                return model.restore_relationship(
                    step["id"], step["type"], step["source"], step["target"]
                ).id
            case "disconnect":
                model.disconnect(step["id"])
                return None
            case "delete_element":
                model.delete_element(step["id"])
                return None
            case "container_of":
                return model.container_of(step["id"])
            case "relationships_from":
                return sorted(r.id for r in model.relationships_from(step["id"]))
            case "relationships_to":
                return sorted(r.id for r in model.relationships_to(step["id"]))
        raise AssertionError(f"unknown step {step['do']!r}")

    def run(self, step: dict[str, Any]) -> Any:
        """Apply one step, log it, and return its result (``None`` on an error)."""
        entry = {key: item for key, item in step.items() if not key.startswith("_")}
        if "_value" in step:
            entry["value"] = tag(step["_value"])
        if "_artifacts" in step:
            entry["artifacts"] = {
                artifact_id: {"kind": item["kind"], "payload": tag(item["payload"])}
                for artifact_id, item in step["_artifacts"].items()
            }
        if "_ops" in step:
            entry["ops"] = [
                _line(op) for op in _MODEL_OPS.validate_python(step["_ops"])
            ]
        try:
            entry["result"] = self._apply(step)
            entry["error"] = None
        except (KeyError, ValueError) as exc:
            entry["result"] = None
            entry["error"] = {
                "kind": "key" if isinstance(exc, KeyError) else "value",
                "message": exc.args[0],
            }
        except HTTPException as exc:
            entry["result"] = None
            entry["error"] = {"status": exc.status_code, "detail": exc.detail}
        seen = observe(self.model)
        if entry["error"] is not None and "status" in entry["error"]:
            before = self._last or observe(Model(self.metamodel))
            if seen != before:
                raise AssertionError(
                    f"step {len(self._steps)}: a refused batch left a trace"
                )
        if seen == self._last:
            entry["unchanged"] = True
        else:
            entry["digest"] = seen["digest"]
            entry["fingerprint"] = seen["fingerprint"]
            if len(self._steps) % self._full_every == 0:
                entry.update(seen)
        self._steps.append(entry)
        self._last = seen
        return entry["result"]

    def document(self) -> dict[str, Any]:
        """The scenario document: the metamodel as ``GET /metamodel`` serves
        it, then every step with its outcome and what it left behind."""
        # The last step that changed anything always carries the full state.
        for entry in reversed(self._steps):
            if "unchanged" not in entry:
                assert self._last is not None
                entry.update(self._last)
                break
        return {
            "metamodel": self.metamodel.model_dump(mode="json"),
            "steps": self._steps,
        }


def run_steps(
    metamodel: Metamodel, steps: Iterable[dict[str, Any]], *, full_every: int = 5
) -> dict[str, Any]:
    recorder = Recorder(metamodel, full_every=full_every)
    for step in steps:
        recorder.run(step)
    return recorder.document()
