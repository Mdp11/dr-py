"""Session-level rule compilation: pipeline seam, seeding, hydration, sweep."""

from __future__ import annotations

from collections.abc import Iterable

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, validation_sweep
from data_rover.api.artifact_ops import ArtifactBatchResult, artifact_header
from data_rover.api.db import db_session
from data_rover.api.db_models import ArtifactKind
from data_rover.api.main import create_app
from data_rover.api.rules import (
    applies_population,
    expand_dirty,
    load_compiled_rules,
    rules_touched,
    session_pipeline,
)
from data_rover.api.schemas import CreateArtifactOp
from data_rover.api.session import (
    DEFAULT_PROJECT_ID,
    Session,
    get_registry,
    get_session,
)
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.issue import Issue
from data_rover.core.validation.rules.compile import (
    CompiledRules,
    RuleSetSource,
    compile_rule_sets,
)
from data_rover.core.validation.dirty import DirtyCollector
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import IssuesDelta, ValidationState

from .conftest import AUTH_HEADERS, papi, seed_default_project

# `code` is required, so an element created bare carries a built-in
# multiplicity error alongside whatever the rules say — the pipeline
# comparisons below are then non-trivial.
_MM = """
elements:
  - name: Building
    properties:
      - {name: name, datatype: string, multiplicity: "0..1"}
      - {name: code, datatype: string, multiplicity: "1"}
  - name: Tower
    extends: Building
  - name: Zone
relationships:
  - name: Owns
    containment: true
    source: Building
    target: Zone
"""

_RULES_YAML = (
    "rules:\n"
    "  - name: has-name\n"
    "    applies_to: Building\n"
    "    then: {property: name, exists: true}\n"
    "    message: buildings need a name\n"
)

_RULE_CHECK = "rule:has-name"

# a relationship rule: its reverse-reach path is what widens a dirty set
_REACH_YAML = (
    "rules:\n"
    "  - name: owns-zone\n"
    "    applies_to: Building\n"
    "    then:\n"
    "      relationship: {type: Owns, direction: outgoing, to: Zone, exists: true}\n"
)

# the same schema with the property the rule reads renamed: the rule drifts
_MM_RENAMED_PROP = _MM.replace("{name: name, datatype", "{name: title, datatype")


def _rules_payload() -> dict:
    return {"schema_version": 1, "yaml": _RULES_YAML}


# --- core-level: the pipeline seam ----------------------------------------


def _core_session() -> tuple[Session, Model, str]:
    """A Session over a one-Building model violating the rule."""
    mm = load_metamodel_str(_MM)
    model = Model(mm)
    el = model.create_element("Building")
    return Session(metamodel=mm, model=model), model, el.id


def test_session_pipeline_includes_rules_validator() -> None:
    session, model, eid = _core_session()
    session.compiled_rules = compile_rule_sets(
        [RuleSetSource("a1", "house-rules", _RULES_YAML)], model.metamodel
    )
    issues = session_pipeline(session).validate(model, Scope.all())
    rule_issues = [i for i in issues if i.check == _RULE_CHECK]
    assert len(rule_issues) == 1
    assert rule_issues[0].target_ids == [eid]
    assert rule_issues[0].message == "buildings need a name"


def test_empty_rules_pipeline_matches_default() -> None:
    session, model, _ = _core_session()
    assert session.compiled_rules.total == 0  # the untouched-project default
    got = session_pipeline(session).validate(model, Scope.all())
    assert got  # non-trivial: the missing required `code` is reported
    assert got == default_pipeline().validate(model, Scope.all())


# --- HTTP: seeding and hydration ------------------------------------------


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _create_building(c: TestClient) -> str:
    r = c.post(
        papi("/model/ops"),
        json={
            "base_rev": get_session().model_rev,
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_1",
                    "type_name": "Building",
                    "properties": {"code": "B1"},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id_map"]["tmp_1"]


def _save_rules(c: TestClient) -> str:
    r = c.post(
        papi("/artifacts"),
        json={
            "kind": "validation_rules",
            "name": "house-rules",
            "payload": _rules_payload(),
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _issue_checks(c: TestClient) -> set[str]:
    r = c.get(papi("/model/issues"))
    assert r.status_code == 200, r.text
    return {i["check"] for i in r.json()["issues"]}


def test_ensure_validation_seeded_includes_rule_issues(client: TestClient) -> None:
    """A re-seeded issue store runs the rules-aware pipeline, not the default."""
    eid = _create_building(client)
    _save_rules(client)

    session = get_session()
    assert session.metamodel is not None
    with db_session() as s:
        session.compiled_rules = load_compiled_rules(
            s, DEFAULT_PROJECT_ID, session.metamodel
        )
    session.validation = None  # what touch_model/metamodel_swap leave behind

    body = client.get(papi("/model/issues")).json()
    rule_issues = [i for i in body["issues"] if i["check"] == _RULE_CHECK]
    assert len(rule_issues) == 1
    assert rule_issues[0]["target_ids"] == [eid]


def test_hydration_compiles_rules(client: TestClient) -> None:
    """A cold project compiles its committed rule sets and the background
    sweep reports their issues — no Validate click involved."""
    eid = _create_building(client)
    _save_rules(client)
    # the legacy POST /artifacts route recompiles nothing, so the live
    # session is still on its empty rule set and its seeded issue store
    # stands: the rule only goes live once the project is rehydrated
    assert _RULE_CHECK not in _issue_checks(client)

    get_registry().evict(DEFAULT_PROJECT_ID)  # snapshot-then-drop

    body = client.get(papi("/model/issues")).json()  # rehydrates
    rule_issues = [i for i in body["issues"] if i["check"] == _RULE_CHECK]
    assert len(rule_issues) == 1
    assert rule_issues[0]["target_ids"] == [eid]
    assert get_session().compiled_rules.total == 1


def test_rule_sources_tolerates_a_malformed_payload(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``rule_sources`` runs inside hydration with no try around it, so a row
    whose payload is not a dict must degrade to an empty rule set rather than
    500 every route for the project."""
    from data_rover.api import rules as rules_mod

    class _Row:
        id = "a1"
        name = "broken"
        payload = ["not", "a", "dict"]

    monkeypatch.setattr(rules_mod.content, "list_artifacts", lambda *a, **k: [_Row()])
    with db_session() as s:
        got = rules_mod.rule_sources(s, DEFAULT_PROJECT_ID)
    assert [(src.artifact_id, src.yaml) for src in got] == [("a1", "")]

    mm = load_metamodel_str(_MM)
    assert compile_rule_sets(got, mm).total == 0


def test_metamodel_upload_recompiles_the_rules(client: TestClient) -> None:
    """A metamodel upload leaves the project's rule artifacts in place, so the
    compiled set must be rebuilt against the NEW schema: every applies-to
    closure, relationship-type closure and drift diagnostic in it was resolved
    against the outgoing one. Absent verdicts beat stale ones."""
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": get_session().model_rev,
            "ops": [
                {
                    "kind": "create_artifact",
                    "temp_id": "tmp_rules",
                    "artifact_kind": "validation_rules",
                    "name": "house-rules",
                    "payload": _rules_payload(),
                }
            ],
            "lock_tokens": [],
        },
    )
    assert r.status_code == 200, r.text
    artifact_id = r.json()["id_map"]["tmp_rules"]
    status = client.get(papi("/model/issues")).json()["rules_status"]
    assert (status["total"], status["skipped"]) == (1, [])

    res = client.post(
        papi("/metamodel"),
        content=_MM_RENAMED_PROP,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text
    # a metamodel upload clears the model with it (core semantics)
    res = client.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text

    status = client.get(papi("/model/issues")).json()["rules_status"]
    assert status["total"] == 0
    (skip,) = status["skipped"]
    assert skip["artifact_id"] == artifact_id
    assert skip["rule"] == "has-name"
    assert "'name'" in skip["reason"]


def test_clearing_the_metamodel_empties_the_compiled_rules(
    client: TestClient,
) -> None:
    """A populated rule set behind a `None` metamodel would report a nonzero
    `rules_status.total` for a project that can no longer validate anything."""
    session = get_session()
    assert session.metamodel is not None
    session.compiled_rules = compile_rule_sets(
        [RuleSetSource("a1", "house-rules", _RULES_YAML)], session.metamodel
    )
    assert session.compiled_rules.total == 1

    assert client.delete(papi("/metamodel")).status_code == 204
    assert get_session().compiled_rules.total == 0
    assert get_session().compiled_rules.sources == ()


class _SwapRulesOnSplice(ValidationState):
    """Issue store that swaps the session's rules the moment a chunk lands."""

    def __init__(self, session: Session, compiled: CompiledRules) -> None:
        super().__init__()
        self._session = session
        self._compiled = compiled

    def replace(self, dirty: Iterable[str], new_issues: list[Issue]) -> IssuesDelta:
        delta = super().replace(dirty, new_issues)
        self._session.compiled_rules = self._compiled
        return delta


def test_sweep_rebuilds_its_pipeline_when_rules_swap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A commit can swap the compiled rules mid-sweep; later chunks must
    validate against the NEW ones."""
    mm = load_metamodel_str(_MM)
    model = Model(mm)
    model.create_element("Building")  # chunk 1: swept before the swap
    second = model.create_element("Building")
    session = Session(metamodel=mm, model=model)
    session.validation = _SwapRulesOnSplice(
        session, compile_rule_sets([RuleSetSource("a1", "s", _RULES_YAML)], mm)
    )
    monkeypatch.setattr(validation_sweep, "CHUNK_SIZE", 1)

    validation_sweep.start_validation_sweep(session, sync=True)

    targets = {
        i.target_ids[0]
        for i in session.validation.iter_issues()
        if i.check == _RULE_CHECK
    }
    assert targets == {second.id}  # only the post-swap chunk sees the rule


def test_expand_dirty_adds_the_elements_rules_reach() -> None:
    """Touching a Zone can flip the verdict of the Building that owns it."""
    mm = load_metamodel_str(_MM)
    model = Model(mm)
    building = model.create_element("Building")
    zone = model.create_element("Zone")
    model.connect("Owns", building.id, zone.id)
    session = Session(metamodel=mm, model=model)
    session.compiled_rules = compile_rule_sets(
        [RuleSetSource("a1", "s", _REACH_YAML)], mm
    )

    dirty = DirtyCollector()
    dirty.add(zone.id)
    expand_dirty(session, model, dirty)
    assert list(dirty.ids) == [zone.id, building.id]

    # no rules: the dirty set is left exactly as the mutation built it
    bare = DirtyCollector()
    bare.add(zone.id)
    expand_dirty(Session(metamodel=mm, model=model), model, bare)
    assert list(bare.ids) == [zone.id]


# --- unit: the two helper seams -------------------------------------------


def test_applies_population_and_rules_touched() -> None:
    mm = load_metamodel_str(_MM)
    model = Model(mm)
    b1 = model.create_element("Building")
    b2 = model.create_element("Building")
    tower = model.create_element("Tower")  # subtype: inside the applies closure
    zone = model.create_element("Zone")
    compiled = compile_rule_sets([RuleSetSource("a1", "s", _RULES_YAML)], mm)

    population = applies_population(model, compiled)
    assert population == sorted([b1.id, b2.id]) + [tower.id]  # per type, sorted
    assert zone.id not in population

    seed_default_project()
    with db_session() as s:
        rules_id = content.create_artifact(
            s,
            DEFAULT_PROJECT_ID,
            kind=ArtifactKind.validation_rules,
            name="r",
            payload=_rules_payload(),
            updated_by=None,
        ).id
        table_id = content.create_artifact(
            s,
            DEFAULT_PROJECT_ID,
            kind=ArtifactKind.table,
            name="t",
            payload={},
            updated_by=None,
        ).id

    create_rules = CreateArtifactOp(
        kind="create_artifact",
        temp_id="tmp",
        artifact_kind="validation_rules",
        name="n",
    )
    create_table = CreateArtifactOp(
        kind="create_artifact", temp_id="tmp", artifact_kind="table", name="n"
    )

    with db_session() as s:
        assert rules_touched(s, [create_rules], None) is True
        assert rules_touched(s, [create_table], None) is False
        assert rules_touched(s, [], None) is False
        # real pre-delete headers, not hand-written dicts: the applier
        # snapshots them through artifact_header().model_dump(mode="json")
        def _header(artifact_id: str) -> dict:
            row = content.get_artifact(s, artifact_id)
            assert row is not None
            return artifact_header(row).model_dump(mode="json")

        rules_header = _header(rules_id)
        table_header = _header(table_id)
        assert rules_touched(s, [], ArtifactBatchResult(deleted=[table_header])) is False
        assert rules_touched(s, [], ArtifactBatchResult(deleted=[rules_header])) is True
        assert (
            rules_touched(s, [], ArtifactBatchResult(changed_ids={rules_id: None}))
            is True
        )
        assert (
            rules_touched(s, [], ArtifactBatchResult(changed_ids={table_id: None}))
            is False
        )
        # an id that no longer resolves is simply not a rules edit
        assert (
            rules_touched(s, [], ArtifactBatchResult(changed_ids={"gone": None}))
            is False
        )
