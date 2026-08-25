"""Change request -> op batch translation (the propose half of apply-cr).

A CR describes entity states; the op protocol describes mutations. The
phase order below is what keeps the two equivalent under the applier's
own semantics:

1. element creates      — full properties inline, ``id`` hint = the CR's id
2. relationship creates — endpoints on same-CR additions use the TEMP id
3. element updates      — merge patch before -> after (None deletes a key)
4. relationship updates — property-only changes
5. relationship deletes, then REWIRES (endpoint or type change, which
   ``update_relationship`` cannot express) as delete + create with the
   same id
6. element deletes      — every incident relationship is already gone (the
   route's CR gate guarantees the CR deleted them), so ``delete_element``'s
   containment cascade never removes anything the CR did not name

An element whose type changes has no op (no retype op exists, and
delete + create would cascade through its containment children), so it is
refused as :class:`UnsupportedChangeError`.
"""

from __future__ import annotations

from typing import Any

from data_rover.core.model.change_request import ChangeRequest
from data_rover.core.model.element import Element
from data_rover.core.model.relationship import Relationship

from .routes.ops import TEMP_ID_PREFIX
from .schemas import (
    CreateElementOp,
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    ModelOpIn,
    UpdateElementOp,
    UpdateRelationshipOp,
)


class UnsupportedChangeError(ValueError):
    """The CR needs a mutation the op protocol cannot express."""


def _diff_to_merge_patch(
    before: dict[str, Any], after: dict[str, Any]
) -> dict[str, Any]:
    """JSON merge patch turning *before* into *after* (None deletes a key)."""
    patch: dict[str, Any] = {
        k: v for k, v in after.items() if k not in before or before[k] != v
    }
    for k in before:
        if k not in after:
            patch[k] = None
    return patch


def _is_rewire(before: Relationship, after: Relationship) -> bool:
    return (
        before.source_id != after.source_id
        or before.target_id != after.target_id
        or before.type_name != after.type_name
    )


def ops_for_change(cr: ChangeRequest) -> list[ModelOpIn]:
    """Translate *cr* into an op batch in the phase order documented above."""
    # Retype guard and phase-3 patches in one pass, but no op is BUILT here:
    # the guard must cover every modified element before the batch starts, or
    # a late retype would leave earlier ops already emitted.
    element_patches: list[tuple[str, dict[str, Any]]] = []
    for m in cr.elements_modified:
        if m.before.type_name != m.after.type_name:
            raise UnsupportedChangeError(
                f"Element {m.id!r} changes type "
                f"({m.before.type_name!r} -> {m.after.type_name!r}); element type "
                f"changes are not supported — delete and re-create it in the CR"
            )
        patch = _diff_to_merge_patch(m.before.properties, m.after.properties)
        if patch:
            element_patches.append((m.id, patch))

    ops: list[ModelOpIn] = []
    #: element id -> its temp id; only elements, because only an element id is
    #: ever dereferenced as an endpoint. One counter feeds both spaces, so a
    #: relationship temp id can never collide with an element's.
    temp_of: dict[str, str] = {}
    counter = 0

    def next_temp() -> str:
        nonlocal counter
        counter += 1
        return f"{TEMP_ID_PREFIX}{counter}"

    def ref(element_id: str) -> str:
        return temp_of.get(element_id, element_id)

    def create_rel(r: Relationship) -> CreateRelationshipOp:
        return CreateRelationshipOp(
            kind="create_relationship",
            temp_id=next_temp(),
            id=r.id,
            type_name=r.type_name,
            source_id=ref(r.source_id),
            target_id=ref(r.target_id),
            properties=dict(r.properties),
        )

    def create_el(e: Element) -> CreateElementOp:
        temp_of[e.id] = next_temp()
        return CreateElementOp(
            kind="create_element",
            temp_id=temp_of[e.id],
            id=e.id,
            type_name=e.type_name,
            properties=dict(e.properties),
        )

    ops.extend(create_el(e) for e in cr.elements_added)
    ops.extend(create_rel(r) for r in cr.relationships_added)

    ops.extend(
        UpdateElementOp(kind="update_element", id=eid, properties_patch=patch)
        for eid, patch in element_patches
    )

    rewires = [
        rm for rm in cr.relationships_modified if _is_rewire(rm.before, rm.after)
    ]
    for rm in cr.relationships_modified:
        if _is_rewire(rm.before, rm.after):
            continue
        patch = _diff_to_merge_patch(rm.before.properties, rm.after.properties)
        if patch:
            ops.append(
                UpdateRelationshipOp(
                    kind="update_relationship", id=rm.id, properties_patch=patch
                )
            )

    ops.extend(
        DeleteRelationshipOp(kind="delete_relationship", id=r.id)
        for r in cr.relationships_deleted
    )
    for rm in rewires:
        ops.append(DeleteRelationshipOp(kind="delete_relationship", id=rm.id))
        ops.append(create_rel(rm.after))

    ops.extend(
        DeleteElementOp(kind="delete_element", id=e.id) for e in cr.elements_deleted
    )
    return ops
