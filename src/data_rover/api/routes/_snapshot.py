from __future__ import annotations

from collections.abc import Container
from typing import Any

from fastapi import HTTPException

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

from ..schemas import ElementOut, RelationshipOut
from .ops import TEMP_ID_PREFIX


def _reject_reserved_id(entity_id: str, *, element: bool) -> None:
    """Reject ids carrying the ops-protocol temp-id prefix.

    ``tmp_``-prefixed ids are reserved for client-generated provisional ids
    in POST /model/ops; a loaded entity carrying one would be ambiguous in
    the restore-mode applier (delete + undo would mint a fresh canonical id
    instead of reinstating the original), so they are banned at load time.
    """
    if entity_id.startswith(TEMP_ID_PREFIX):
        kind = "Element" if element else "Relationship"
        raise HTTPException(
            status_code=422,
            detail=(
                f"{kind} id {entity_id!r} uses the reserved {TEMP_ID_PREFIX!r} "
                f"prefix (client-side temporary ids of the ops protocol); "
                f"loaded models must not contain such ids"
            ),
        )


# ---------------------------------------------------------------------------
# Shared load guards
#
# Every model-load surface (pydantic payloads below, raw-dict file loads in
# build_model_from_dicts) funnels each entity through these two checkers so
# the guard semantics exist exactly once:
#
# - element/relationship type must exist in the metamodel
# - abstract types cannot be instantiated
# - element and relationship ids must be unique within the payload
# - ids must not use the reserved ops-protocol temp-id prefix
# - relationship endpoints must resolve to elements in the payload
# ---------------------------------------------------------------------------


def _guard_element(
    metamodel: Metamodel, seen_ids: set[str], entity_id: str, type_name: str
) -> None:
    """Apply the element load guards; records *entity_id* in *seen_ids*."""
    _reject_reserved_id(entity_id, element=True)
    et = metamodel.element_type(type_name)
    if et is None:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown element type {type_name!r}",
        )
    if et.abstract:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Element type {type_name!r} is abstract and cannot be instantiated"
            ),
        )
    if entity_id in seen_ids:
        raise HTTPException(
            status_code=422,
            detail=f"Duplicate element id {entity_id!r} in snapshot",
        )
    seen_ids.add(entity_id)


def _guard_relationship(
    metamodel: Metamodel,
    existing_element_ids: Container[str],
    *,
    seen_ids: set[str],
    entity_id: str,
    type_name: str,
    source_id: str,
    target_id: str,
) -> None:
    """Apply the relationship load guards; records *entity_id* in *seen_ids*.

    Only membership of *existing_element_ids* is used, so callers may pass
    any ``in``-capable container of element ids — in practice the model's
    ``elements`` dict, whose keys are the already-loaded element ids.
    """
    _reject_reserved_id(entity_id, element=False)
    if metamodel.relationship_type(type_name) is None:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown relationship type {type_name!r}",
        )
    if source_id not in existing_element_ids:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Relationship {entity_id!r} references unknown source {source_id!r}"
            ),
        )
    if target_id not in existing_element_ids:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Relationship {entity_id!r} references unknown target {target_id!r}"
            ),
        )
    if entity_id in seen_ids:
        raise HTTPException(
            status_code=422,
            detail=f"Duplicate relationship id {entity_id!r} in snapshot",
        )
    seen_ids.add(entity_id)


def _build_model_from_payload(
    metamodel: Metamodel,
    elements: list[ElementOut],
    relationships: list[RelationshipOut],
) -> Model:
    """Materialize a `Model` from snapshot/inline payload data.

    Shared by `POST /model`, `PUT /model/snapshot`, and the inline branch of
    `POST /model/validate` so all three endpoints apply the same guards (see
    the shared-guard section above for the list).
    """
    model = Model(metamodel)

    seen_element_ids: set[str] = set()
    for e in elements:
        _guard_element(metamodel, seen_element_ids, e.id, e.type_name)
        model.elements[e.id] = Element(
            id=e.id,
            type_name=e.type_name,
            properties=dict(e.properties),
            rev=e.rev,
        )

    seen_relationship_ids: set[str] = set()
    for r in relationships:
        _guard_relationship(
            metamodel,
            model.elements,
            seen_ids=seen_relationship_ids,
            entity_id=r.id,
            type_name=r.type_name,
            source_id=r.source_id,
            target_id=r.target_id,
        )
        model.relationships[r.id] = Relationship(
            id=r.id,
            type_name=r.type_name,
            source_id=r.source_id,
            target_id=r.target_id,
            properties=dict(r.properties),
            rev=r.rev,
        )

    # dicts were populated directly, bypassing the mutation boundary
    model.indexes.rebuild()
    return model


# ---------------------------------------------------------------------------
# Direct-dict builder (Phase C3 load endpoints)
# ---------------------------------------------------------------------------


def _shape_error(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _require_str(entity: dict[str, Any], key: str, where: str) -> str:
    value = entity.get(key)
    if not isinstance(value, str):
        raise _shape_error(f"{where}: field {key!r} must be a string")
    return value


def _optional_props(entity: dict[str, Any], where: str) -> dict[str, Any]:
    props = entity.get("properties", None)
    if props is None:
        return {}
    if not isinstance(props, dict):
        raise _shape_error(f"{where}: field 'properties' must be an object")
    return props


def _optional_rev(entity: dict[str, Any], where: str) -> int:
    rev = entity.get("rev", 0)
    if isinstance(rev, bool) or not isinstance(rev, int):
        raise _shape_error(f"{where}: field 'rev' must be an integer")
    return rev


def _entity_list(raw: dict[str, Any], key: str) -> list[Any]:
    items = raw.get(key, [])
    if not isinstance(items, list):
        raise _shape_error(f"Model payload field {key!r} must be a list")
    return items


def build_model_from_dicts(metamodel: Metamodel, raw: Any) -> Model:
    """Materialize a `Model` directly from a parsed save-file JSON object.

    Same guard semantics as `_build_model_from_payload` (shared checker
    functions) but WITHOUT the per-entity pydantic layer: on an ~80 MB model
    the pydantic validation pass costs multiples of the `json.load` itself
    and buys nothing the lightweight shape checks here don't (id/type_name
    strings, properties object, integer rev). The fresh-from-`json.load`
    property dicts are adopted as-is — no copies; the caller must not reuse
    *raw* afterwards.

    Accepts the exact save shape the frontend writes
    (``{"elements": [...], "relationships": [...]}``) and tolerates extra
    top-level keys (e.g. the ``rev`` key the benchmark fixtures carry).
    Missing ``elements``/``relationships`` keys mean empty lists.
    """
    if not isinstance(raw, dict):
        raise _shape_error("Model payload must be a JSON object")
    model = Model(metamodel)

    seen_element_ids: set[str] = set()
    for n, e in enumerate(_entity_list(raw, "elements")):
        where = f"elements[{n}]"
        if not isinstance(e, dict):
            raise _shape_error(f"{where}: must be an object")
        eid = _require_str(e, "id", where)
        type_name = _require_str(e, "type_name", where)
        _guard_element(metamodel, seen_element_ids, eid, type_name)
        model.elements[eid] = Element(
            id=eid,
            type_name=type_name,
            properties=_optional_props(e, where),
            rev=_optional_rev(e, where),
        )

    seen_relationship_ids: set[str] = set()
    for n, r in enumerate(_entity_list(raw, "relationships")):
        where = f"relationships[{n}]"
        if not isinstance(r, dict):
            raise _shape_error(f"{where}: must be an object")
        rid = _require_str(r, "id", where)
        type_name = _require_str(r, "type_name", where)
        source_id = _require_str(r, "source_id", where)
        target_id = _require_str(r, "target_id", where)
        _guard_relationship(
            metamodel,
            model.elements,
            seen_ids=seen_relationship_ids,
            entity_id=rid,
            type_name=type_name,
            source_id=source_id,
            target_id=target_id,
        )
        model.relationships[rid] = Relationship(
            id=rid,
            type_name=type_name,
            source_id=source_id,
            target_id=target_id,
            properties=_optional_props(r, where),
            rev=_optional_rev(r, where),
        )

    # dicts were populated directly, bypassing the mutation boundary
    model.indexes.rebuild()
    return model
