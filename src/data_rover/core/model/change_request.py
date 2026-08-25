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
# Entity copies (never alias an input entity's property dict)
# ---------------------------------------------------------------------------


def _copy_element(e: Element) -> Element:
    return Element(
        id=e.id, type_name=e.type_name, properties=dict(e.properties), rev=e.rev
    )


def _copy_relationship(r: Relationship) -> Relationship:
    return Relationship(
        id=r.id,
        type_name=r.type_name,
        source_id=r.source_id,
        target_id=r.target_id,
        properties=dict(r.properties),
        rev=r.rev,
    )


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

    new_elements: dict[str, Element] = {
        eid: _copy_element(e) for eid, e in model.elements.items()
    }

    new_relationships: dict[str, Relationship] = {
        rid: _copy_relationship(r) for rid, r in model.relationships.items()
    }

    for e in cr.elements_added:
        new_elements[e.id] = _copy_element(e)

    for me in cr.elements_modified:
        current_rev = new_elements[me.id].rev
        new_elements[me.id] = Element(
            id=me.id,
            type_name=me.after.type_name,
            properties=dict(me.after.properties),
            rev=current_rev + 1,
        )

    for e in cr.elements_deleted:
        del new_elements[e.id]

    for r in cr.relationships_added:
        new_relationships[r.id] = _copy_relationship(r)

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

    for r in cr.relationships_deleted:
        del new_relationships[r.id]

    result = Model(model.metamodel)
    result.elements = new_elements
    result.relationships = new_relationships
    # dicts were populated directly, bypassing the mutation boundary
    result.indexes.rebuild()
    return result


# ---------------------------------------------------------------------------
# diff_models / invert_change_request — pure; never alias input entities
# ---------------------------------------------------------------------------


def diff_models(base: Model, other: Model) -> ChangeRequest:
    """The change request that turns *base* into *other*.

    Same identity rules as the match helpers above (``rev`` ignored): an
    entity present only in *other* is added, only in *base* deleted, in
    both but not matching modified. Added/modified follow *other*'s
    insertion order, deleted follow *base*'s.
    """
    cr = ChangeRequest()
    for eid, e in other.elements.items():
        b = base.elements.get(eid)
        if b is None:
            cr.elements_added.append(_copy_element(e))
        elif not _element_matches(b, e):
            cr.elements_modified.append(
                ModifiedElement(id=eid, before=_copy_element(b), after=_copy_element(e))
            )
    for eid, b in base.elements.items():
        if eid not in other.elements:
            cr.elements_deleted.append(_copy_element(b))

    for rid, r in other.relationships.items():
        br = base.relationships.get(rid)
        if br is None:
            cr.relationships_added.append(_copy_relationship(r))
        elif not _relationship_matches(br, r):
            cr.relationships_modified.append(
                ModifiedRelationship(
                    id=rid, before=_copy_relationship(br), after=_copy_relationship(r)
                )
            )
    for rid, br in base.relationships.items():
        if rid not in other.relationships:
            cr.relationships_deleted.append(_copy_relationship(br))
    return cr


def invert_change_request(cr: ChangeRequest) -> ChangeRequest:
    """The change request that undoes *cr*: added↔deleted, before↔after."""
    return ChangeRequest(
        elements_added=[_copy_element(e) for e in cr.elements_deleted],
        elements_modified=[
            ModifiedElement(
                id=m.id, before=_copy_element(m.after), after=_copy_element(m.before)
            )
            for m in cr.elements_modified
        ],
        elements_deleted=[_copy_element(e) for e in cr.elements_added],
        relationships_added=[_copy_relationship(r) for r in cr.relationships_deleted],
        relationships_modified=[
            ModifiedRelationship(
                id=m.id,
                before=_copy_relationship(m.after),
                after=_copy_relationship(m.before),
            )
            for m in cr.relationships_modified
        ],
        relationships_deleted=[_copy_relationship(r) for r in cr.relationships_added],
    )
