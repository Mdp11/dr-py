from __future__ import annotations

from dataclasses import dataclass, field

from .element import Element
from .model import Model
from .relationship import Relationship


# ---------------------------------------------------------------------------
# Change-request dataclasses
# ---------------------------------------------------------------------------


@dataclass
class ModifiedElement:
    id: str
    before: Element
    after: Element


@dataclass
class ModifiedRelationship:
    id: str
    before: Relationship
    after: Relationship


@dataclass
class ChangeRequest:
    elements_added: list[Element] = field(default_factory=list)
    elements_modified: list[ModifiedElement] = field(default_factory=list)
    elements_deleted: list[Element] = field(default_factory=list)
    relationships_added: list[Relationship] = field(default_factory=list)
    relationships_modified: list[ModifiedRelationship] = field(default_factory=list)
    relationships_deleted: list[Relationship] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Conflict types
# ---------------------------------------------------------------------------


@dataclass
class CRConflict:
    kind: str  # "id_exists" | "missing" | "before_mismatch"
    entity: str  # "element" | "relationship"
    id: str
    reason: str


class CRConflictError(Exception):
    def __init__(self, conflicts: list[CRConflict]) -> None:
        self.conflicts = conflicts
        super().__init__(f"{len(conflicts)} change-request conflict(s)")


# ---------------------------------------------------------------------------
# Match helpers (rev is intentionally ignored)
# ---------------------------------------------------------------------------


def _element_matches(a: Element, b: Element) -> bool:
    return a.type_name == b.type_name and a.properties == b.properties


def _relationship_matches(a: Relationship, b: Relationship) -> bool:
    return (
        a.type_name == b.type_name
        and a.source_id == b.source_id
        and a.target_id == b.target_id
        and a.properties == b.properties
    )


# ---------------------------------------------------------------------------
# apply_change_request — pure; never mutates the input model
# ---------------------------------------------------------------------------


def apply_change_request(model: Model, cr: ChangeRequest) -> Model:
    """Apply *cr* to *model* and return a new Model.

    Phase A: validate every precondition and collect all conflicts.  If any
    conflict exists the function raises CRConflictError and the input model is
    left completely untouched.

    Phase B: materialize a new Model from copies of the current state, then
    apply every operation.
    """
    conflicts: list[CRConflict] = []

    # --- Phase A: validate ---

    # Elements added: id must NOT already exist
    for e in cr.elements_added:
        if e.id in model.elements:
            conflicts.append(
                CRConflict(
                    kind="id_exists",
                    entity="element",
                    id=e.id,
                    reason=f"Element {e.id!r} already exists in the model",
                )
            )

    # Elements modified: id must exist; before must match (ignoring rev)
    for me in cr.elements_modified:
        current = model.elements.get(me.id)
        if current is None:
            conflicts.append(
                CRConflict(
                    kind="missing",
                    entity="element",
                    id=me.id,
                    reason=f"Element {me.id!r} does not exist in the model",
                )
            )
        elif not _element_matches(current, me.before):
            conflicts.append(
                CRConflict(
                    kind="before_mismatch",
                    entity="element",
                    id=me.id,
                    reason=f"Element {me.id!r} does not match the before snapshot",
                )
            )

    # Elements deleted: id must exist; snapshot must match (ignoring rev)
    for e in cr.elements_deleted:
        current = model.elements.get(e.id)
        if current is None:
            conflicts.append(
                CRConflict(
                    kind="missing",
                    entity="element",
                    id=e.id,
                    reason=f"Element {e.id!r} does not exist in the model",
                )
            )
        elif not _element_matches(current, e):
            conflicts.append(
                CRConflict(
                    kind="before_mismatch",
                    entity="element",
                    id=e.id,
                    reason=f"Element {e.id!r} does not match the deleted snapshot",
                )
            )

    # Relationships added: id must NOT already exist
    for r in cr.relationships_added:
        if r.id in model.relationships:
            conflicts.append(
                CRConflict(
                    kind="id_exists",
                    entity="relationship",
                    id=r.id,
                    reason=f"Relationship {r.id!r} already exists in the model",
                )
            )

    # Relationships modified: id must exist; before must match (ignoring rev)
    for mr in cr.relationships_modified:
        current_r = model.relationships.get(mr.id)
        if current_r is None:
            conflicts.append(
                CRConflict(
                    kind="missing",
                    entity="relationship",
                    id=mr.id,
                    reason=f"Relationship {mr.id!r} does not exist in the model",
                )
            )
        elif not _relationship_matches(current_r, mr.before):
            conflicts.append(
                CRConflict(
                    kind="before_mismatch",
                    entity="relationship",
                    id=mr.id,
                    reason=f"Relationship {mr.id!r} does not match the before snapshot",
                )
            )

    # Relationships deleted: id must exist; snapshot must match (ignoring rev)
    for r in cr.relationships_deleted:
        current_r = model.relationships.get(r.id)
        if current_r is None:
            conflicts.append(
                CRConflict(
                    kind="missing",
                    entity="relationship",
                    id=r.id,
                    reason=f"Relationship {r.id!r} does not exist in the model",
                )
            )
        elif not _relationship_matches(current_r, r):
            conflicts.append(
                CRConflict(
                    kind="before_mismatch",
                    entity="relationship",
                    id=r.id,
                    reason=f"Relationship {r.id!r} does not match the deleted snapshot",
                )
            )

    if conflicts:
        raise CRConflictError(conflicts)

    # --- Phase B: materialize ---

    # Build new element dict from copies of current state
    new_elements: dict[str, Element] = {
        eid: Element(
            id=e.id,
            type_name=e.type_name,
            properties=dict(e.properties),
            rev=e.rev,
        )
        for eid, e in model.elements.items()
    }

    # Build new relationship dict from copies of current state
    new_relationships: dict[str, Relationship] = {
        rid: Relationship(
            id=r.id,
            type_name=r.type_name,
            source_id=r.source_id,
            target_id=r.target_id,
            properties=dict(r.properties),
            rev=r.rev,
        )
        for rid, r in model.relationships.items()
    }

    # Insert added elements
    for e in cr.elements_added:
        new_elements[e.id] = Element(
            id=e.id,
            type_name=e.type_name,
            properties=dict(e.properties),
            rev=e.rev,
        )

    # Replace modified elements (rev = current.rev + 1)
    for me in cr.elements_modified:
        current_rev = new_elements[me.id].rev
        new_elements[me.id] = Element(
            id=me.id,
            type_name=me.after.type_name,
            properties=dict(me.after.properties),
            rev=current_rev + 1,
        )

    # Remove deleted elements
    for e in cr.elements_deleted:
        del new_elements[e.id]

    # Insert added relationships
    for r in cr.relationships_added:
        new_relationships[r.id] = Relationship(
            id=r.id,
            type_name=r.type_name,
            source_id=r.source_id,
            target_id=r.target_id,
            properties=dict(r.properties),
            rev=r.rev,
        )

    # Replace modified relationships (rev = current.rev + 1)
    for mr in cr.relationships_modified:
        current_rev = new_relationships[mr.id].rev
        new_relationships[mr.id] = Relationship(
            id=mr.id,
            type_name=mr.after.type_name,
            source_id=mr.after.source_id,
            target_id=mr.after.target_id,
            properties=dict(mr.after.properties),
            rev=current_rev + 1,
        )

    # Remove deleted relationships
    for r in cr.relationships_deleted:
        del new_relationships[r.id]

    # Assemble new Model
    result = Model(model.metamodel)
    result.elements = new_elements
    result.relationships = new_relationships
    # dicts were populated directly, bypassing the mutation boundary
    result.indexes.rebuild()
    return result
