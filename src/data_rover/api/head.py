"""The head tables: the project's current elements, relationships and
element-valued references as rows, written in the transaction that changes the
model.

Invariants the writers keep:

- Rows ordered by ``seq`` are the model's dict order, the order
  ``serialize.iter_entity_lines`` writes. An entity that exists before and
  after a batch keeps its ``seq``; one the batch created, or deleted and
  created again, takes the next one. Elements and relationships have a
  ``seq`` space each, drawn from the one counter ``ModelRow.next_seq`` (a
  baseline numbers each table from 0, so the counter starts at the larger
  table's size).
- ``entity_refs`` holds exactly the pairs the model's referencer index holds.
- ``properties`` is the JSON text of the snapshot line encoder, read back
  through ``parse_model_json``.
- Nothing here commits: the caller's transaction carries the rows with the
  ``Commit`` and ``ModelRow`` writes.
"""

from __future__ import annotations

import weakref
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from itertools import batched
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, insert, select, update
from sqlalchemy.orm import Session

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship

from . import content
from .db_models import ElementRow, EntityRefRow, RelationshipRow
from .serialize import _LINE_ENCODER, parse_model_json
from .state_digest import digest_value, format_digest

if TYPE_CHECKING:
    from .routes.ops import _BatchResult

#: rows per bulk statement
CHUNK = 500
#: rows read per page by ``rebuild_refs``
REBUILD_CHUNK = 1000


@dataclass(frozen=True)
class RefProps:
    """The element-valued property names of each type, in declaration order."""

    element: Mapping[str, tuple[str, ...]]
    relationship: Mapping[str, tuple[str, ...]]


_ref_props_cache: dict[int, tuple[weakref.ref[Metamodel], RefProps]] = {}


def ref_props(metamodel: Metamodel) -> RefProps:
    """The reference-property names per type, cached per Metamodel instance
    (one is frozen after load). Same rule as ``IndexSet._ref_prop_names``: the
    properties whose datatype is an element type."""
    key = id(metamodel)
    cached = _ref_props_cache.get(key)
    if cached is not None and cached[0]() is metamodel:
        return cached[1]

    def names(props: Sequence[Any]) -> tuple[str, ...]:
        return tuple(p.name for p in props if metamodel.is_element_type(p.datatype))

    built = RefProps(
        element={
            t.name: names(metamodel.effective_element_properties(t.name))
            for t in metamodel.elements
        },
        relationship={
            t.name: names(metamodel.effective_relationship_properties(t.name))
            for t in metamodel.relationships
        },
    )

    def forget(_ref: object) -> None:
        _ref_props_cache.pop(key, None)

    _ref_props_cache[key] = (weakref.ref(metamodel, forget), built)
    return built


def refs_of(properties: Mapping[str, Any], names: Sequence[str]) -> set[str]:
    """The ids held by the properties named in ``names``: string values, as a
    scalar or as the items of a list. Other values are not references."""
    refs: set[str] = set()
    for name in names:
        value = properties.get(name)
        if value is None:
            continue
        for item in value if isinstance(value, list) else (value,):
            if isinstance(item, str):
                refs.add(item)
    return refs


def encode_properties(properties: Mapping[str, Any]) -> str:
    """The snapshot line encoder's text for one properties dict. Raises
    ``ValueError`` for a non-finite float, which no writer here can emit."""
    return _LINE_ENCODER.encode(properties)


def _element_values(project_id: str, element: Element, seq: int) -> dict[str, Any]:
    return {
        "project_id": project_id,
        "id": element.id,
        "type_name": element.type_name,
        "properties": encode_properties(element.properties),
        "rev": element.rev,
        "seq": seq,
    }


def _relationship_values(
    project_id: str, rel: Relationship, seq: int
) -> dict[str, Any]:
    return {
        "project_id": project_id,
        "id": rel.id,
        "type_name": rel.type_name,
        "source_id": rel.source_id,
        "target_id": rel.target_id,
        "properties": encode_properties(rel.properties),
        "rev": rel.rev,
        "seq": seq,
    }


def _insert_refs(
    db: Session, project_id: str, pairs: Sequence[tuple[str, str]]
) -> None:
    for chunk in batched(pairs, CHUNK):
        db.execute(
            insert(EntityRefRow),
            [
                {"project_id": project_id, "referencer_id": r, "target_id": t}
                for r, t in chunk
            ],
        )


def _entity_refs(
    entities: Sequence[Element] | Sequence[Relationship],
    by_type: Mapping[str, tuple[str, ...]],
) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for entity in entities:
        names = by_type.get(entity.type_name, ())
        if names:
            pairs.extend((entity.id, t) for t in refs_of(entity.properties, names))
    return pairs


def write_baseline(
    db: Session, project_id: str, metamodel: Metamodel, model: Model
) -> None:
    """Replace the project's rows with ``model``: every entity in model order,
    each table numbered from 0, with their refs, the counts, the digest and the
    allocation counter."""
    row = content.get_model_row(db, project_id)
    if row is None:
        raise LookupError(f"project {project_id!r} has no model row")
    db.flush()
    _clear(db, project_id)
    rp = ref_props(metamodel)
    elements = list(model.elements.values())
    relationships = list(model.relationships.values())
    for page, chunk in enumerate(batched(elements, CHUNK)):
        first = page * CHUNK
        db.execute(
            insert(ElementRow),
            [_element_values(project_id, e, first + i) for i, e in enumerate(chunk)],
        )
        _insert_refs(db, project_id, _entity_refs(chunk, rp.element))
    for page, rchunk in enumerate(batched(relationships, CHUNK)):
        first = page * CHUNK
        db.execute(
            insert(RelationshipRow),
            [
                _relationship_values(project_id, r, first + i)
                for i, r in enumerate(rchunk)
            ],
        )
        _insert_refs(db, project_id, _entity_refs(rchunk, rp.relationship))
    row.element_count = len(elements)
    row.relationship_count = len(relationships)
    row.state_digest = format_digest(digest_value(model))
    row.next_seq = max(len(elements), len(relationships))


def _clear(db: Session, project_id: str) -> None:
    for table in (EntityRefRow, RelationshipRow, ElementRow):
        db.execute(
            delete(table)
            .where(table.project_id == project_id)
            .execution_options(synchronize_session=False)
        )


def write_batch(
    db: Session,
    project_id: str,
    metamodel: Metamodel,
    model: Model,
    res: _BatchResult,
) -> None:
    """Take one applied batch into the rows: the survivors it touched are
    updated in place, what it deleted (or deleted and created again) is
    deleted, what it created is inserted at the next ``seq`` in model order,
    the refs of every touched entity are replaced, and the counts and the
    allocation counter follow. ``state_digest`` is the commit path's.

    Does nothing for a project without a model row, or whose rows are not
    written yet (``next_seq`` NULL: hydration writes them)."""
    row = content.get_model_row(db, project_id)
    if row is None or row.next_seq is None:
        return
    db.flush()
    next_seq = row.next_seq

    deleted_elements: list[str] = []
    kept_elements: list[Element] = []
    new_elements: list[Element] = []
    order = model.indexes.element_order
    for eid, before in res.before_elements.items():
        element = model.elements.get(eid)
        survives = (
            before is not None
            and element is not None
            and order[eid] == res.before_element_orders[eid]
        )
        if survives:
            assert element is not None
            kept_elements.append(element)
            continue
        if before is not None:
            deleted_elements.append(eid)
        if element is not None:
            new_elements.append(element)
    new_elements.sort(key=lambda e: order[e.id])

    deleted_relationships: list[str] = []
    kept_relationships: list[Relationship] = []
    new_relationships: list[Relationship] = []
    rel_order = model.indexes.relationship_order
    for rid, rel_before in res.before_relationships.items():
        rel = model.relationships.get(rid)
        survives = (
            rel_before is not None
            and rel is not None
            and rel_order[rid] == res.before_relationship_orders[rid]
        )
        if survives:
            assert rel is not None
            kept_relationships.append(rel)
            continue
        if rel_before is not None:
            deleted_relationships.append(rid)
        if rel is not None:
            new_relationships.append(rel)
    new_relationships.sort(key=lambda r: rel_order[r.id])

    # encode first: a value no writer can emit refuses the batch before any
    # statement runs
    kept_element_values = [
        {
            "project_id": project_id,
            "id": e.id,
            "properties": encode_properties(e.properties),
            "rev": e.rev,
        }
        for e in kept_elements
    ]
    kept_rel_values = [
        {
            "project_id": project_id,
            "id": r.id,
            "properties": encode_properties(r.properties),
            "rev": r.rev,
        }
        for r in kept_relationships
    ]
    new_element_values = []
    for e in new_elements:
        new_element_values.append(_element_values(project_id, e, next_seq))
        next_seq += 1
    new_rel_values = []
    for r in new_relationships:
        new_rel_values.append(_relationship_values(project_id, r, next_seq))
        next_seq += 1

    for table, ids in (
        (ElementRow, deleted_elements),
        (RelationshipRow, deleted_relationships),
    ):
        for chunk in batched(ids, CHUNK):
            db.execute(
                delete(table)
                .where(table.project_id == project_id, table.id.in_(chunk))
                .execution_options(synchronize_session=False)
            )
    for table, values in (
        (ElementRow, kept_element_values),
        (RelationshipRow, kept_rel_values),
    ):
        for vchunk in batched(values, CHUNK):
            db.execute(update(table), list(vchunk))
    for table, values in (
        (ElementRow, new_element_values),
        (RelationshipRow, new_rel_values),
    ):
        for vchunk in batched(values, CHUNK):
            db.execute(insert(table), list(vchunk))

    _replace_refs(
        db,
        project_id,
        ref_props(metamodel),
        referencers=[*res.before_elements, *res.before_relationships],
        elements=[*kept_elements, *new_elements],
        relationships=[*kept_relationships, *new_relationships],
    )
    row.element_count = len(model.elements)
    row.relationship_count = len(model.relationships)
    row.next_seq = next_seq


def _replace_refs(
    db: Session,
    project_id: str,
    rp: RefProps,
    *,
    referencers: Sequence[str],
    elements: Sequence[Element],
    relationships: Sequence[Relationship],
) -> None:
    """Drop every ref the ``referencers`` held and write the ones the surviving
    ``elements`` and ``relationships`` hold now."""
    for chunk in batched(referencers, CHUNK):
        db.execute(
            delete(EntityRefRow)
            .where(
                EntityRefRow.project_id == project_id,
                EntityRefRow.referencer_id.in_(chunk),
            )
            .execution_options(synchronize_session=False)
        )
    _insert_refs(
        db,
        project_id,
        [
            *_entity_refs(elements, rp.element),
            *_entity_refs(relationships, rp.relationship),
        ],
    )


def rebuild_refs(db: Session, project_id: str, metamodel: Metamodel) -> None:
    """Recompute every ref of the project from its rows, for a metamodel that
    changed which properties are element-valued."""
    db.flush()
    db.execute(
        delete(EntityRefRow)
        .where(EntityRefRow.project_id == project_id)
        .execution_options(synchronize_session=False)
    )
    rp = ref_props(metamodel)
    for table, by_type in (
        (ElementRow, rp.element),
        (RelationshipRow, rp.relationship),
    ):
        last = -1
        while True:
            page = db.execute(
                select(table.id, table.type_name, table.properties, table.seq)
                .where(table.project_id == project_id, table.seq > last)
                .order_by(table.seq)
                .limit(REBUILD_CHUNK)
            ).all()
            if not page:
                break
            pairs: list[tuple[str, str]] = []
            for entity_id, type_name, text, _seq in page:
                names = by_type.get(type_name, ())
                if names:
                    pairs.extend(
                        (entity_id, t) for t in refs_of(parse_model_json(text), names)
                    )
            _insert_refs(db, project_id, pairs)
            last = page[-1].seq


def read_head(db: Session, project_id: str) -> tuple[list[dict], list[dict]]:
    """Every row in ``seq`` order, decoded to the dicts ``dataclasses.asdict``
    makes of the model's entities. For tests and contract checks."""

    def rows(table: Any, *columns: str) -> Iterator[dict]:
        for r in db.execute(
            select(table).where(table.project_id == project_id).order_by(table.seq)
        ).scalars():
            out = {c: getattr(r, c) for c in columns}
            out["properties"] = parse_model_json(r.properties)
            out["rev"] = r.rev
            yield out

    return (
        list(rows(ElementRow, "id", "type_name")),
        list(rows(RelationshipRow, "id", "type_name", "source_id", "target_id")),
    )
