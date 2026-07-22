"""Translate one applied op batch into the read-keys it touches (Phase B,
spec 2026-07-21).

`touched_keys` is the commit-side half of incremental cell-cache
invalidation: the guest facade records what each cell READ (`ReadKey`
tuples on `CallResult.reads`), this module computes what a commit WROTE in
the same vocabulary, and `ScriptCellCache.evict_touched` drops the
intersection. Everything here is conservative by construction:

- A changed element also touches its ancestors' `("scan", ...)` keys and ALL
  of its containment parents' `("children", ...)` keys — not just the first —
  because scan pages and `children()` responses inline full element
  projections: `children()` is derived per-parent from that parent's
  OUTGOING containment edges (`bridge.py`'s `_op_children`), not from a single
  `container_of`/first-parent lookup, so a multi-parent element (a structural
  validation issue this engine deliberately holds rather than rejects) is
  inlined into every one of its parents' `children()` responses, and a
  property change is visible through them, not just through `("el", id)`.
- Every typed `("scan", T)` key is emitted alongside `("scan", None)`: an
  untyped `dr.elements()` scan's page also inlines every element regardless
  of type, so it is touched by ANY element change. `evict_touched` does a
  plain set intersection with no expansion of its own, so a cell that only
  recorded `("scan", None)` would survive a touched set of `{("scan",
  "Building")}` alone — a stale-value bug. Pairing the two here is what
  keeps that cell honest.
- Deleted-entity metadata (types, endpoints) is recovered from the batch's
  inverse units — the only place it survives the apply. If any expected
  metadata is missing, the function returns ``None`` ("unknown — clear
  everything"): over-invalidation is the only safe failure mode.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.script.runner import ReadKey

from .schemas import CreateElementOp, CreateRelationshipOp

if TYPE_CHECKING:
    from .routes.ops import _BatchResult


def touched_keys(
    model: Model, metamodel: Metamodel, res: _BatchResult
) -> frozenset[ReadKey] | None:
    """Read-keys touched by ``res`` (an applied batch), or ``None`` for
    "unknown — caller must clear everything". ``model`` is the POST-apply
    model (changed entities are still present; deleted ones are gone)."""
    touched: set[ReadKey] = set()
    scan_seen: set[str | None] = set()

    def scan_keys(type_name: str) -> None:
        if None not in scan_seen:
            scan_seen.add(None)
            touched.add(("scan", None))
        for t in {type_name, *metamodel.element_ancestors(type_name)}:
            if t not in scan_seen:
                scan_seen.add(t)
                touched.add(("scan", t))

    def rel_keys(type_name: str, source_id: str, target_id: str) -> None:
        touched.add(("out", source_id))
        touched.add(("in", target_id))
        if metamodel.is_containment(type_name):
            touched.add(("children", source_id))
            touched.add(("parent", target_id))

    # Deleted-entity metadata from the inverse units (delete inverses are
    # the creates that would restore them, carrying type/endpoints).
    deleted_el_types: dict[str, str] = {}
    deleted_rels: dict[str, tuple[str, str, str]] = {}
    for unit in res.inverse_units:
        for op in unit:
            if isinstance(op, CreateElementOp):
                deleted_el_types[op.temp_id] = op.type_name
            elif isinstance(op, CreateRelationshipOp):
                deleted_rels[op.temp_id] = (op.type_name, op.source_id, op.target_id)

    for eid in res.changed_element_ids:
        el = model.elements.get(eid)
        if el is None:
            return None  # changed entity missing post-apply: unknown state
        touched.add(("el", eid))
        for parent in model.indexes.parents_of(eid):
            touched.add(("children", parent))
        scan_keys(el.type_name)

    for eid in res.deleted_element_ids:
        touched.add(("el", eid))
        type_name = deleted_el_types.get(eid)
        if type_name is None:
            return None  # unreachable by construction; stay conservative
        scan_keys(type_name)

    for rid in res.changed_relationship_ids:
        rel = model.relationships.get(rid)
        if rel is None:
            return None
        rel_keys(rel.type_name, rel.source_id, rel.target_id)

    for rid in res.deleted_relationship_ids:
        meta = deleted_rels.get(rid)
        if meta is None:
            return None
        rel_keys(*meta)

    return frozenset(touched)
