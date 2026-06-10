"""Secondary indexes over a Model's elements and relationships.

This module is the SINGLE CHOKE-POINT for adjacency and count queries over a
Model: anything that needs "relationships touching element X", "how many R
edges leave X", "who contains X", "which entities reference X", or "which
elements share an identity" goes through the :class:`IndexSet` instead of
scanning ``model.elements`` / ``model.relationships``. If models ever exceed
roughly one million entities, swap the in-memory dict internals here for an
embedded store (e.g. SQLite/LMDB) without touching the callers.

The IndexSet is owned by :class:`~data_rover.core.model.model.Model` and is
maintained incrementally at the mutation boundary (``create_element``,
``connect``, ``disconnect``, ``set_property``, ``delete_element``). Bulk
loaders that populate the model dicts directly must call :meth:`IndexSet.
rebuild` afterwards; code that writes ``entity.properties`` directly must call
:meth:`IndexSet.on_properties_changed`.

Uniqueness grouping mirrors the UniquenessValidator exactly: two elements are
identical when they share ``type_name``, their first containment parent (or
both are unowned), and either match on the type's effective ``key`` properties
or, when no key is declared, on all properties.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Hashable, Set, Sequence
from typing import TYPE_CHECKING, Any

from .element import Element
from .relationship import Relationship

if TYPE_CHECKING:
    from .model import Model

# (type_name, containment owner id or None, signature of effective-key
#  property values — or of all properties when the type declares no key)
UniqKey = tuple[str, "str | None", Hashable]


def _frozen(value: Any) -> Hashable:
    """Deep-freeze a JSON-ish property value into a hashable signature."""
    if isinstance(value, dict):
        return tuple(sorted((k, _frozen(v)) for k, v in value.items()))
    if isinstance(value, list):
        return tuple(_frozen(v) for v in value)
    return value


class IndexSet:
    """Incrementally maintained secondary indexes for one Model.

    All structures are kept SPARSE: keys whose set/list/count becomes empty or
    zero are removed, so an incrementally maintained instance compares equal,
    structure by structure, to a freshly :meth:`rebuild`-t one.
    """

    def __init__(self, model: Model) -> None:
        self._model = model
        #: element_id -> ids of outgoing relationships
        self.out_rels: dict[str, set[str]] = {}
        #: element_id -> ids of incoming relationships
        self.in_rels: dict[str, set[str]] = {}
        #: (source_id, rel_type_name) -> number of such outgoing relationships
        self.out_count: Counter[tuple[str, str]] = Counter()
        #: (target_id, rel_type_name) -> number of such incoming relationships
        self.in_count: Counter[tuple[str, str]] = Counter()
        #: type_name -> ids of elements of exactly that type
        self.elements_by_type: dict[str, set[str]] = {}
        #: child id -> containment parent ids, in relationship insertion order
        self.containment_parents: dict[str, list[str]] = {}
        # child id -> containment relationship ids, aligned index-by-index with
        # containment_parents[child id]; removal happens by relationship id so
        # duplicate parallel edges to the same parent keep relative order (a
        # remove-by-parent-value would always drop the FIRST matching entry and
        # diverge from rebuild()'s relationship-insertion order)
        self._containment_rel_ids: dict[str, list[str]] = {}
        #: element_id -> ids of entities (elements AND relationships) whose
        #: reference-typed property values point at it; entries survive the
        #: deletion of the target as long as a dangling reference is held
        self.ref_targets: dict[str, set[str]] = {}
        #: uniqueness signature -> ids of elements sharing it
        self.uniq_groups: dict[UniqKey, set[str]] = {}
        #: element id -> its current uniqueness group key
        self.uniq_key_of: dict[str, UniqKey] = {}
        #: uniqueness keys whose group has >= 2 members
        self.duplicate_keys: set[UniqKey] = set()
        # entity id -> reference-target ids currently held in its properties
        # (reverse of ref_targets; needed to diff on property changes)
        self._refs_of: dict[str, set[str]] = {}
        # per-type caches (the metamodel is immutable, so these never need
        # invalidation); they bypass pydantic attribute-access overhead on the
        # per-entity hot paths
        self._element_ref_props: dict[str, tuple[str, ...]] = {}
        self._relationship_ref_props: dict[str, tuple[str, ...]] = {}
        self._key_props: dict[str, tuple[str, ...] | None] = {}
        self._is_containment: dict[str, bool] = {}

    # -- accessors (for query helpers and the validator rewrite) -----------
    #
    # Convention: every accessor returns a LIVE INTERNAL VIEW — do NOT mutate
    # the returned object.  Return types are annotated as abstract read-only
    # collections (Set / Sequence) to make this contract visible at call sites.

    def outgoing_ids(self, element_id: str) -> Set[str]:
        """Live view of outgoing relationship ids — do NOT mutate."""
        return self.out_rels.get(element_id) or frozenset()

    def incoming_ids(self, element_id: str) -> Set[str]:
        """Live view of incoming relationship ids — do NOT mutate."""
        return self.in_rels.get(element_id) or frozenset()

    def count_out(self, element_id: str, rel_type_name: str) -> int:
        return self.out_count[(element_id, rel_type_name)]

    def count_in(self, element_id: str, rel_type_name: str) -> int:
        return self.in_count[(element_id, rel_type_name)]

    def parents_of(self, element_id: str) -> Sequence[str]:
        """Live view of containment parent ids — do NOT mutate."""
        return self.containment_parents.get(element_id) or ()

    def first_parent(self, element_id: str) -> str | None:
        parents = self.containment_parents.get(element_id)
        return parents[0] if parents else None

    def referencers_of(self, element_id: str) -> Set[str]:
        """Live view of entity ids that reference this element — do NOT mutate."""
        return self.ref_targets.get(element_id) or frozenset()

    # -- mutation hooks (called from the Model mutation boundary) ----------

    def on_element_created(self, element: Element) -> None:
        self.elements_by_type.setdefault(element.type_name, set()).add(element.id)
        self._add_to_group(element)
        self._update_refs(element.id, self._element_refs(element))

    def on_element_deleted(self, element: Element) -> None:
        """Called after the element's relationships are gone and it has been
        removed from ``model.elements``."""
        ids = self.elements_by_type.get(element.type_name)
        if ids is not None:
            ids.discard(element.id)
            if not ids:
                del self.elements_by_type[element.type_name]
        self._remove_from_group(element.id)
        self._update_refs(element.id, set())

    def on_relationship_created(self, rel: Relationship) -> None:
        self.out_rels.setdefault(rel.source_id, set()).add(rel.id)
        self.in_rels.setdefault(rel.target_id, set()).add(rel.id)
        self.out_count[(rel.source_id, rel.type_name)] += 1
        self.in_count[(rel.target_id, rel.type_name)] += 1
        self._update_refs(rel.id, self._relationship_refs(rel))
        if self._containment(rel.type_name):
            self.containment_parents.setdefault(rel.target_id, []).append(rel.source_id)
            self._containment_rel_ids.setdefault(rel.target_id, []).append(rel.id)
            self._rekey_if_present(rel.target_id)

    def on_relationship_deleted(self, rel: Relationship) -> None:
        outs = self.out_rels.get(rel.source_id)
        if outs is not None:
            outs.discard(rel.id)
            if not outs:
                del self.out_rels[rel.source_id]
        ins = self.in_rels.get(rel.target_id)
        if ins is not None:
            ins.discard(rel.id)
            if not ins:
                del self.in_rels[rel.target_id]
        self._decrement(self.out_count, (rel.source_id, rel.type_name))
        self._decrement(self.in_count, (rel.target_id, rel.type_name))
        self._update_refs(rel.id, set())
        if self._containment(rel.type_name):
            rel_ids = self._containment_rel_ids.get(rel.target_id)
            if rel_ids is not None:
                try:
                    index = rel_ids.index(rel.id)
                except ValueError:
                    pass
                else:
                    del rel_ids[index]
                    parents = self.containment_parents[rel.target_id]
                    del parents[index]
                    if not rel_ids:
                        del self._containment_rel_ids[rel.target_id]
                        del self.containment_parents[rel.target_id]
            self._rekey_if_present(rel.target_id)

    def on_properties_changed(self, entity: Element | Relationship) -> None:
        """Re-derive property-driven indexes (references, uniqueness) for one
        entity. Also the explicit hook for code that writes
        ``entity.properties`` directly instead of using ``set_property``."""
        if isinstance(entity, Element):
            self._update_refs(entity.id, self._element_refs(entity))
            self._rekey(entity)
        else:
            self._update_refs(entity.id, self._relationship_refs(entity))

    # -- bulk load ----------------------------------------------------------

    def rebuild(self) -> None:
        """Recompute every index from the model dicts (bulk-load path)."""
        self.out_rels.clear()
        self.in_rels.clear()
        self.out_count.clear()
        self.in_count.clear()
        self.elements_by_type.clear()
        self.containment_parents.clear()
        self._containment_rel_ids.clear()
        self.ref_targets.clear()
        self.uniq_groups.clear()
        self.uniq_key_of.clear()
        self.duplicate_keys.clear()
        self._refs_of.clear()

        # relationships first so containment parents are known before grouping
        for rel in self._model.relationships.values():
            self.out_rels.setdefault(rel.source_id, set()).add(rel.id)
            self.in_rels.setdefault(rel.target_id, set()).add(rel.id)
            self.out_count[(rel.source_id, rel.type_name)] += 1
            self.in_count[(rel.target_id, rel.type_name)] += 1
            self._add_refs(rel.id, self._relationship_refs(rel))
            if self._containment(rel.type_name):
                self.containment_parents.setdefault(rel.target_id, []).append(
                    rel.source_id
                )
                self._containment_rel_ids.setdefault(rel.target_id, []).append(rel.id)
        for element in self._model.elements.values():
            self.elements_by_type.setdefault(element.type_name, set()).add(element.id)
            self._add_to_group(element)
            self._add_refs(element.id, self._element_refs(element))

    # -- debugging ----------------------------------------------------------

    def verify_consistent(self) -> None:
        """Recompute all indexes from scratch and assert they match.

        Test/debug helper only; never call this on production paths (it is a
        full O(model) pass).
        """
        fresh = IndexSet(self._model)
        fresh.rebuild()

        def _norm(name: str, obj: object) -> object:
            # Counter.__eq__ ignores zero-count entries, so compare as plain
            # dicts to catch spurious zeroes left in the live index.
            return dict(obj) if isinstance(obj, Counter) else obj  # type: ignore[arg-type]

        mismatched = [
            name
            for name in (
                "out_rels",
                "in_rels",
                "out_count",
                "in_count",
                "elements_by_type",
                "containment_parents",
                "_containment_rel_ids",
                "ref_targets",
                "uniq_groups",
                "uniq_key_of",
                "duplicate_keys",
                "_refs_of",
            )
            if _norm(name, getattr(self, name)) != _norm(name, getattr(fresh, name))
        ]
        if mismatched:
            raise AssertionError(
                "IndexSet inconsistent with a fresh rebuild in: "
                + ", ".join(mismatched)
            )

    # -- internals: uniqueness ----------------------------------------------

    def _uniq_key(self, element: Element) -> UniqKey:
        parents = self.containment_parents.get(element.id)
        owner = parents[0] if parents else None
        key = self._effective_key(element.type_name)
        if key is None:
            signature: Hashable = _frozen(element.properties)
        else:
            signature = tuple(_frozen(element.properties.get(k)) for k in key)
        return (element.type_name, owner, signature)

    def _effective_key(self, type_name: str) -> tuple[str, ...] | None:
        try:
            return self._key_props[type_name]
        except KeyError:
            key = self._model.metamodel.effective_element_key(type_name)
            frozen_key = None if key is None else tuple(key)
            self._key_props[type_name] = frozen_key
            return frozen_key

    def _containment(self, rel_type_name: str) -> bool:
        try:
            return self._is_containment[rel_type_name]
        except KeyError:
            value = self._model.metamodel.is_containment(rel_type_name)
            self._is_containment[rel_type_name] = value
            return value

    def _add_to_group(self, element: Element) -> None:
        key = self._uniq_key(element)
        self.uniq_key_of[element.id] = key
        group = self.uniq_groups.setdefault(key, set())
        group.add(element.id)
        if len(group) >= 2:
            self.duplicate_keys.add(key)

    def _remove_from_group(self, element_id: str) -> None:
        key = self.uniq_key_of.pop(element_id, None)
        if key is None:
            return
        group = self.uniq_groups.get(key)
        if group is None:
            return
        group.discard(element_id)
        if len(group) < 2:
            self.duplicate_keys.discard(key)
        if not group:
            del self.uniq_groups[key]

    def _rekey(self, element: Element) -> None:
        new_key = self._uniq_key(element)
        if self.uniq_key_of.get(element.id) == new_key:
            return
        self._remove_from_group(element.id)
        self.uniq_key_of[element.id] = new_key
        group = self.uniq_groups.setdefault(new_key, set())
        group.add(element.id)
        if len(group) >= 2:
            self.duplicate_keys.add(new_key)

    def _rekey_if_present(self, element_id: str) -> None:
        element = self._model.elements.get(element_id)
        if element is not None:
            self._rekey(element)

    # -- internals: references ----------------------------------------------

    def _ref_prop_names(self, type_name: str, of_element: bool) -> tuple[str, ...]:
        cache = self._element_ref_props if of_element else self._relationship_ref_props
        names = cache.get(type_name)
        if names is None:
            mm = self._model.metamodel
            defs = (
                mm.effective_element_properties(type_name)
                if of_element
                else mm.effective_relationship_properties(type_name)
            )
            names = tuple(p.name for p in defs if mm.is_element_type(p.datatype))
            cache[type_name] = names
        return names

    def _element_refs(self, element: Element) -> set[str]:
        return self._collect_refs(
            element.properties, self._ref_prop_names(element.type_name, True)
        )

    def _relationship_refs(self, rel: Relationship) -> set[str]:
        return self._collect_refs(
            rel.properties, self._ref_prop_names(rel.type_name, False)
        )

    @staticmethod
    def _collect_refs(
        properties: dict[str, Any], ref_props: tuple[str, ...]
    ) -> set[str]:
        refs: set[str] = set()
        for name in ref_props:
            value = properties.get(name)
            if value is None:
                continue
            values = value if isinstance(value, list) else [value]
            for item in values:
                # non-string values are not references (flagged by validation)
                if isinstance(item, str):
                    refs.add(item)
        return refs

    def _add_refs(self, entity_id: str, refs: set[str]) -> None:
        """Add-only fast path for ``rebuild`` (entity has no prior refs)."""
        if not refs:
            return
        self._refs_of[entity_id] = refs
        for target in refs:
            self.ref_targets.setdefault(target, set()).add(entity_id)

    def _update_refs(self, entity_id: str, new_refs: set[str]) -> None:
        old_refs = self._refs_of.get(entity_id) or set()
        if new_refs == old_refs:
            return
        for target in old_refs - new_refs:
            referencers = self.ref_targets.get(target)
            if referencers is not None:
                referencers.discard(entity_id)
                if not referencers:
                    del self.ref_targets[target]
        for target in new_refs - old_refs:
            self.ref_targets.setdefault(target, set()).add(entity_id)
        if new_refs:
            self._refs_of[entity_id] = new_refs
        else:
            self._refs_of.pop(entity_id, None)

    # -- internals: counters --------------------------------------------------

    @staticmethod
    def _decrement(counter: Counter[tuple[str, str]], key: tuple[str, str]) -> None:
        if key not in counter:
            raise RuntimeError(
                f"IndexSet count underflow for {key!r}: model dicts were mutated "
                "without index hooks; call rebuild()"
            )
        count = counter[key] - 1
        if count > 0:
            counter[key] = count
        else:
            del counter[key]
