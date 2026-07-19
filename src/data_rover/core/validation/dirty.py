"""Dirty-set computation for incremental (scoped) validation.

A single model mutation can only change the validation verdict of a bounded
set of entities; everything else is untouched. This module computes that set
— the "dirty set" — for every mutation kind, so callers can re-validate
``Scope(dirty)`` instead of the whole model and splice the scoped issues into
a :class:`~data_rover.core.validation.state.ValidationState`.

Two entry points:

* :class:`DirtyCollector` — hook-style API for live mutations through the
  Model mutation boundary (also the Phase-C ops endpoint). Prefer the
  mutate-and-collect WRAPPERS, which call the Model method with the correct
  before/after hooks around it (snapshotting whatever the after-hook needs)
  so hooks cannot be mispaired:

  =========================  =========================================  ========================
  Model method               (before hook, after hook)                  wrapper
  =========================  =========================================  ========================
  ``create_element``         (—, ``after_element_create``)              ``create_element``
  ``set_property`` (elem)    (``before_element_props_change``,          ``set_property``
                             ``after_element_props_change``)
  ``set_property`` (rel)     (—, ``after_relationship_props_change``)   ``set_property``
  ``delete_property`` (elem) (``before_element_props_change``,          ``delete_property``
                             ``after_element_props_change``)
  ``delete_property`` (rel)  (—, ``after_relationship_props_change``)   ``delete_property``
  ``connect``                (``before_connect``, ``after_connect``)    ``connect``
  ``disconnect``             (``before_disconnect``,                    ``disconnect``
                             ``after_disconnect``)
  ``delete_element``         (``before_element_delete``, —)             ``delete_element``
  =========================  =========================================  ========================

  The raw hooks stay public (the CR diff path and callers that mutate
  through other means use them): call the ``before_*`` hook immediately
  BEFORE the mutation (it captures pre-mutation contributions such as the
  old uniqueness-group members) and the ``after_*`` hook immediately AFTER.
  Hooks only ever ADD ids and keep no pairing state, so they nest and
  interleave freely; one collector can span a whole operation batch.

* :func:`change_request_dirty_ids` — post-hoc diff for the CR-apply path:
  ``apply_change_request`` is pure (base untouched, result freshly indexed),
  so old-state contributions are read from the base model's indexes and
  new-state contributions from the result's. No hooks around individual ops
  are needed.

The dirty set may legitimately contain ids of deleted entities: the
validation pipeline silently skips ids that resolve to nothing, while
``ValidationState.replace`` uses them to drop the deleted entities' issues.
Sets pulled from the indexes are sorted before insertion so the collected
order — and therefore scoped-validation issue order — is deterministic.

Known over-approximations (erring larger is safe — a too-small set is the
only correctness hazard):

* deleting an element adds the ids of its incident relationships even
  though they vanish in the same operation (harmless: the pipeline skips
  them and the issue store drops their issues);
* changing an element's type dirties all incident relationships and all
  referencers even when the specific change cannot flip their verdicts.

Known limitation (inherent to the scoped-pipeline contract): a FULL run
reports a containment cycle once, naming one arbitrary representative
element. A scoped run walks only the parent chains of dirty entities, so a
newly created cycle IS reported (the connect's endpoints are dirty and their
chains reach it) but with the dirty entities as representatives, and a
representative issue minted by an earlier full run is only cleaned up when
that representative itself becomes dirty. The full-validation path remains
the authority for cycle bookkeeping.
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from collections.abc import Iterable, KeysView

from ..model.relationship import Relationship
from .scope import Scope

if TYPE_CHECKING:
    from ..model.change_request import ChangeRequest
    from ..model.element import Element
    from ..model.model import Model


def containment_closure(model: Model, element_id: str) -> list[str]:
    """The elements ``Model.delete_element(element_id)`` would remove.

    Computed BEFORE the deletion via the containment indexes (the least
    invasive way to observe the cascade: no Model hooks needed). Includes
    ``element_id`` itself; child order is deterministic (sorted rel ids).
    """
    order = [element_id]
    seen = {element_id}
    queue = [element_id]
    indexes = model.indexes
    is_containment = model.metamodel.is_containment
    while queue:
        eid = queue.pop()
        for rid in sorted(indexes.outgoing_ids(eid)):
            rel = model.relationships[rid]
            if not is_containment(rel.type_name):
                continue
            child = rel.target_id
            if child not in seen and child in model.elements:
                seen.add(child)
                order.append(child)
                queue.append(child)
    return order


class DirtyCollector:
    """Ordered accumulator of entity ids whose verdict may have changed."""

    def __init__(self) -> None:
        # dict.fromkeys idiom: ordered set (deterministic scope order)
        self._ids: dict[str, None] = {}

    @property
    def ids(self) -> KeysView[str]:
        """Collected ids in insertion order — live view, do NOT mutate."""
        return self._ids.keys()

    def add(self, *entity_ids: str) -> None:
        for eid in entity_ids:
            self._ids[eid] = None

    def update(self, entity_ids: Iterable[str]) -> None:
        for eid in entity_ids:
            self._ids[eid] = None

    def to_scope(self) -> Scope:
        return Scope(self._ids)

    def add_uniqueness_group_of(self, model: Model, element_id: str) -> None:
        """All CURRENT uniqueness-group members of ``element_id`` (incl.
        itself). Call before a mutation for the old group, after for the new
        one. No-op when the element is not in the model."""
        key = model.indexes.uniq_key_of.get(element_id)
        if key is None:
            return
        self.update(sorted(model.indexes.uniq_groups[key]))

    # -- element hooks ------------------------------------------------------

    def after_element_create(self, model: Model, element_id: str) -> None:
        """AFTER an element was created/inserted (indexes already updated).

        Dirties the element, its uniqueness group (a new duplicate can flip
        existing members), and any entity holding a previously-dangling
        reference to this id (their dangling-reference verdict changes).
        """
        self.add(element_id)
        self.add_uniqueness_group_of(model, element_id)
        self.update(sorted(model.indexes.referencers_of(element_id)))

    def before_element_props_change(self, model: Model, element_id: str) -> None:
        """BEFORE an element's properties change: the element + OLD group."""
        self.add(element_id)
        self.add_uniqueness_group_of(model, element_id)

    def after_element_props_change(self, model: Model, element_id: str) -> None:
        """AFTER an element's properties changed: the NEW group."""
        self.add_uniqueness_group_of(model, element_id)

    def before_element_delete(self, model: Model, element_id: str) -> None:
        """BEFORE ``Model.delete_element``: contributions of the whole
        containment cascade, captured while the state still exists.

        Per cascade-deleted element: the element itself, every incident
        relationship and its other endpoint (end-multiplicity counts change),
        its referencers (their references dangle), its containment parents,
        and its uniqueness-group members. Transient regroupings during the
        cascade are net-zero (every intermediate group both gains and loses
        the deleted element), so pre-delete groups suffice.
        """
        indexes = model.indexes
        for eid in containment_closure(model, element_id):
            self.add(eid)
            for rid in sorted(indexes.outgoing_ids(eid)):
                self.add(rid, model.relationships[rid].target_id)
            for rid in sorted(indexes.incoming_ids(eid)):
                self.add(rid, model.relationships[rid].source_id)
            self.update(sorted(indexes.referencers_of(eid)))
            # NOTE: containment parents need no separate contribution — they
            # are sources of incoming relationships, i.e. a subset of the
            # incoming-endpoint ids already added above.
            self.add_uniqueness_group_of(model, eid)

    # -- relationship hooks --------------------------------------------------

    def before_connect(
        self, model: Model, rel_type_name: str, source_id: str, target_id: str
    ) -> None:
        """BEFORE ``Model.connect``: both endpoints; for containment also the
        target's OLD uniqueness group (re-parenting changes owner context)."""
        self.add(source_id, target_id)
        if model.metamodel.is_containment(rel_type_name):
            self.add_uniqueness_group_of(model, target_id)

    def after_connect(self, model: Model, rel_id: str) -> None:
        """AFTER ``Model.connect``: the relationship; for containment also the
        target's NEW uniqueness group."""
        self.add(rel_id)
        rel = model.relationships[rel_id]
        if model.metamodel.is_containment(rel.type_name):
            self.add_uniqueness_group_of(model, rel.target_id)

    def before_disconnect(self, model: Model, rel_id: str) -> None:
        """BEFORE ``Model.disconnect``: the relationship, both endpoints, and
        for containment the target's OLD uniqueness group."""
        rel = model.relationships[rel_id]
        self.add(rel.id, rel.source_id, rel.target_id)
        if model.metamodel.is_containment(rel.type_name):
            self.add_uniqueness_group_of(model, rel.target_id)

    def after_disconnect(
        self, model: Model, rel_type_name: str, target_id: str
    ) -> None:
        """AFTER ``Model.disconnect``: for containment the target's NEW
        uniqueness group (it may have re-keyed to another owner/None)."""
        if model.metamodel.is_containment(rel_type_name):
            self.add_uniqueness_group_of(model, target_id)

    def after_relationship_props_change(self, rel_id: str) -> None:
        """A relationship's properties changed: only its own verdict moves."""
        self.add(rel_id)

    # -- mutate-and-collect wrappers ------------------------------------------
    # Preferred entry points for live mutations: each calls the matching
    # before-hook(s), the Model method, and the matching after-hook(s) in the
    # right order (snapshotting what the after-hook needs before mutating),
    # so callers cannot mispair hooks. See the module-docstring table.

    def create_element(self, model: Model, type_name: str) -> Element:
        """``Model.create_element`` + ``after_element_create``."""
        element = model.create_element(type_name)
        self.after_element_create(model, element.id)
        return element

    def set_property(
        self, model: Model, target: Element | Relationship, prop: str, value: object
    ) -> None:
        """``Model.set_property`` + the matching props-change hook(s)."""
        if isinstance(target, Relationship):
            model.set_property(target, prop, value)
            self.after_relationship_props_change(target.id)
            return
        self.before_element_props_change(model, target.id)
        model.set_property(target, prop, value)
        self.after_element_props_change(model, target.id)

    def delete_property(
        self, model: Model, target: Element | Relationship, prop: str
    ) -> None:
        """``Model.delete_property`` + the matching props-change hook(s)."""
        if isinstance(target, Relationship):
            model.delete_property(target, prop)
            self.after_relationship_props_change(target.id)
            return
        self.before_element_props_change(model, target.id)
        model.delete_property(target, prop)
        self.after_element_props_change(model, target.id)

    def connect(
        self, model: Model, rel_type: str, source_id: str, target_id: str
    ) -> Relationship:
        """``Model.connect`` between ``before_connect`` and ``after_connect``."""
        self.before_connect(model, rel_type, source_id, target_id)
        rel = model.connect(rel_type, source_id, target_id)
        self.after_connect(model, rel.id)
        return rel

    def disconnect(self, model: Model, rel_id: str) -> None:
        """``Model.disconnect`` between ``before_disconnect`` and
        ``after_disconnect`` (the relationship's type/target are snapshotted
        first — the after-hook needs them and the mutation destroys them)."""
        rel = model.get_relationship(rel_id)
        rel_type_name, target_id = rel.type_name, rel.target_id
        self.before_disconnect(model, rel_id)
        model.disconnect(rel_id)
        self.after_disconnect(model, rel_type_name, target_id)

    def delete_element(self, model: Model, element_id: str) -> None:
        """``Model.delete_element`` after ``before_element_delete`` (which
        captures the whole containment cascade's contributions)."""
        self.before_element_delete(model, element_id)
        model.delete_element(element_id)


# ---------------------------------------------------------------------------
# Change-request path: post-hoc diff between base and result
# ---------------------------------------------------------------------------


def change_request_dirty_ids(
    base: Model, result: Model, cr: ChangeRequest
) -> list[str]:
    """Union of the dirty sets of every operation in *cr*.

    ``apply_change_request(base, cr) == result`` is assumed: *base* carries
    the pre-CR indexes (old uniqueness groups, old adjacency, referencers)
    and *result* the post-CR ones, so no per-op hooks are required.

    Note that CR element deletes do NOT cascade (the CR must list every
    deletion explicitly, and dangling relationships are rejected by the API
    gate), so unlike ``DirtyCollector.before_element_delete`` no closure walk
    happens here — each listed op contributes its own dirty set.
    """
    d = DirtyCollector()
    is_containment = base.metamodel.is_containment

    for e in cr.elements_added:
        d.add(e.id)
        d.add_uniqueness_group_of(result, e.id)
        # entities whose reference to this id was dangling in the base
        d.update(sorted(base.indexes.referencers_of(e.id)))

    for me in cr.elements_modified:
        d.add(me.id)
        d.add_uniqueness_group_of(base, me.id)
        d.add_uniqueness_group_of(result, me.id)
        current = base.elements.get(me.id)
        if current is not None and current.type_name != me.after.type_name:
            # a type change can flip incident relationships' endpoint-typing
            # verdicts and referencers' reference-type verdicts
            indexes = base.indexes
            d.update(sorted(indexes.outgoing_ids(me.id) | indexes.incoming_ids(me.id)))
            d.update(sorted(indexes.referencers_of(me.id)))

    for e in cr.elements_deleted:
        d.add(e.id)
        indexes = base.indexes
        for rid in sorted(indexes.outgoing_ids(e.id)):
            d.add(rid, base.relationships[rid].target_id)
        for rid in sorted(indexes.incoming_ids(e.id)):
            d.add(rid, base.relationships[rid].source_id)
        d.update(sorted(indexes.referencers_of(e.id)))
        d.add_uniqueness_group_of(base, e.id)

    for r in cr.relationships_added:
        d.add(r.id, r.source_id, r.target_id)
        if is_containment(r.type_name):
            d.add_uniqueness_group_of(base, r.target_id)
            d.add_uniqueness_group_of(result, r.target_id)

    for mr in cr.relationships_modified:
        d.add(mr.id)
        before = base.relationships.get(mr.id)
        after = result.relationships.get(mr.id)
        # endpoints on both sides: end-multiplicity counts move on all four
        for rel in (before, after):
            if rel is not None:
                d.add(rel.source_id, rel.target_id)
        # containment on either side: targets' old AND new uniqueness groups
        # (re-targeting/re-typing re-parents elements)
        if any(
            rel is not None and is_containment(rel.type_name) for rel in (before, after)
        ):
            targets = dict.fromkeys(
                rel.target_id for rel in (before, after) if rel is not None
            )
            for t in targets:
                d.add_uniqueness_group_of(base, t)
                d.add_uniqueness_group_of(result, t)

    for r in cr.relationships_deleted:
        before = base.relationships.get(r.id)
        rel = before if before is not None else r
        d.add(r.id, rel.source_id, rel.target_id)
        if is_containment(rel.type_name):
            d.add_uniqueness_group_of(base, rel.target_id)
            d.add_uniqueness_group_of(result, rel.target_id)

    return list(d.ids)
