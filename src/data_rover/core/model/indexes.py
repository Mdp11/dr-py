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
:meth:`IndexSet.on_properties_changed`. The containment-roots order index
(``roots_order`` / ``_root_key_of``) is maintained at that same boundary and
carries the same obligations: ``rebuild()`` recomputes it from scratch, and
any direct writer of ``entity.properties`` must go through
``on_properties_changed`` so a root's display-name reposition is not missed.
The trigram search index (``search_postings`` / ``_trigrams_of``) is
maintained at that same boundary with the same obligations; it feeds
``search_candidates`` (the fuzzy-search candidate generator) and, like the
reference index, is diffed on ``on_properties_changed``.

Uniqueness grouping mirrors the UniquenessValidator exactly: two elements are
identical when they share ``type_name``, their first containment parent (or
both are unowned), and either match on the type's effective ``key`` properties
or, when no key is declared, on all properties.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Hashable, Iterator, Set, Sequence
from typing import TYPE_CHECKING, Any

from ._sorted import Pair, SortedPairs
from .element import Element
from .naming import display_name, name_of
from .relationship import Relationship
from ..metamodel.schema import KeyRel, KeySpec

if TYPE_CHECKING:
    from .model import Model

# (type_name, containment owner id or None, signature). The signature is the
# frozen all-properties value when the type declares no key; for a keyed type it
# is a 2-tuple (property-value tuple, per-relationship endpoint-multiset tuple),
# each relationship multiset rendered as tuple(sorted(endpoint_ids)).
UniqKey = tuple[str, "str | None", Hashable]

#: ``search_candidates`` gives up (returns None -> the caller scans) when the
#: SMALLEST posting set for the query is this large: intersecting and scoring
#: ~everything costs more than the plain scan it would replace (measured 5.6x
#: slower at 500k for a query matching every element). Fraction-of-model rule
#: with an absolute floor so small models never trip it.
_SEARCH_FALLBACK_FLOOR = 10_000
_SEARCH_FALLBACK_FRACTION = 4


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
        #: containment roots (elements with NO containment parent) as
        #: (display_name, id) pairs in ascending order — the exact order the
        #: containment-roots endpoints page in. Maintained by the same mutation
        #: hooks as containment_parents; rebuilt by rebuild().
        self.roots_order: SortedPairs = SortedPairs()
        # element id -> its CURRENT key in roots_order (needed to remove/reposition
        # after a rename, since the old display name is gone from the element)
        self._root_key_of: dict[str, Pair] = {}
        #: lowercased trigram -> ids of elements whose searchable text
        #: contains it. The searchable text is exactly the fields the fuzzy
        #: element search scores (routes/read.py _search_score): the id, the
        #: type name, and every top-level string property value. Candidate
        #: index only: a query's true hits are always a SUBSET of the
        #: intersection of its trigrams' postings (see search_candidates).
        self.search_postings: dict[str, set[str]] = {}
        # element id -> its current merged trigram set (reverse map; needed
        # to diff on property change and to drop postings on delete — by hook
        # time the old text is gone — mirroring _refs_of). No entry when the
        # set would be empty (sparse). Stored as a SORTED TUPLE of trigrams
        # canonicalized through ``_canon_trigrams`` — a tuple is ~4x smaller
        # than a frozenset, and canonicalization collapses the per-element
        # ``s[i:i+3]`` slice copies to one string object per distinct trigram
        # for this model's lifetime (the copies were the dominant index
        # memory cost at 500k).
        self._trigrams_of: dict[str, tuple[str, ...]] = {}
        # entity id -> reference-target ids currently held in its properties
        # (reverse of ref_targets; needed to diff on property changes)
        self._refs_of: dict[str, set[str]] = {}
        # per-type caches (the metamodel is immutable, so these never need
        # invalidation); they bypass pydantic attribute-access overhead on the
        # per-entity hot paths
        self._element_ref_props: dict[str, tuple[str, ...]] = {}
        self._relationship_ref_props: dict[str, tuple[str, ...]] = {}
        self._key_specs: dict[str, KeySpec | None] = {}
        # trigram -> the SAME trigram (canonical object). Dedups the per-element
        # s[i:i+3] slice copies (the dominant index memory cost at 500k) without
        # sys.intern's process-lifetime retention: this table dies with the
        # IndexSet. Grows with every trigram ever seen in THIS model (never
        # pruned on removal — entries are 3-char strings, negligible next to
        # the postings they canonicalize).
        self._canon_trigrams: dict[str, str] = {}
        # relationship-type names that appear with each direction in ANY element
        # type's effective key; built once (metamodel is immutable). None until
        # first built. Used to skip rekeying on edges that affect no key.
        self._out_key_rel_types: set[str] | None = None
        self._in_key_rel_types: set[str] | None = None
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

    def roots_count(self) -> int:
        """Number of containment roots — O(1)."""
        return len(self.roots_order)

    def roots_page(self, offset: int, limit: int) -> list[str]:
        """Root element ids in (display_name, id) order — O(log n + limit)."""
        return [eid for _, eid in self.roots_order.page(offset, limit)]

    def iter_roots(self) -> Iterator[str]:
        """All root ids in (display_name, id) order — lazily, O(1) per step."""
        return (eid for _, eid in self.roots_order.iter_all())

    def search_candidates(self, q: str) -> Set[str] | None:
        """Ids of elements that MAY fuzzy-match ``q`` — a guaranteed superset
        of the true hits — or ``None`` when the index cannot answer OR cannot
        beat a scan (``len(q) < 3``, or the query's rarest trigram is
        ubiquitous); the caller falls back to a scan either way. ``q`` must
        already be trimmed and lowercased. May return a live internal set —
        do NOT mutate.

        Superset argument: any string containing ``q`` contains every trigram
        of ``q``, so a matching element sits in ALL those posting sets and
        survives the intersection. Intersection starts from the smallest set,
        so cost is O(smallest posting); a degenerate all-common query
        approaches the scan it replaces, never exceeds it asymptotically.
        """
        if len(q) < 3:
            return None
        postings: list[set[str]] = []
        for i in range(len(q) - 2):
            ids = self.search_postings.get(q[i : i + 3])
            if not ids:
                # a true hit would contain ALL trigrams; one absent => none
                return frozenset()
            postings.append(ids)
        postings.sort(key=len)
        if len(postings[0]) >= max(
            _SEARCH_FALLBACK_FLOOR,
            len(self._model.elements) // _SEARCH_FALLBACK_FRACTION,
        ):
            # even the rarest trigram of ``q`` matches a large fraction of the
            # model: the scan is cheaper than intersecting + scoring it all
            return None
        result: Set[str] = postings[0]
        for ids in postings[1:]:
            result = result & ids
            if not result:
                break
        return result

    # -- mutation hooks (called from the Model mutation boundary) ----------

    def on_element_created(self, element: Element) -> None:
        self.elements_by_type.setdefault(element.type_name, set()).add(element.id)
        self._add_to_group(element)
        self._update_refs(element.id, self._element_refs(element))
        # a fresh element has no containment parent -> it is a root
        self._roots_add(element)
        self._update_trigrams(element.id, self._element_trigrams(element))

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
        self._roots_remove(element.id)
        self._update_trigrams(element.id, frozenset())

    def on_relationship_created(self, rel: Relationship) -> None:
        self.out_rels.setdefault(rel.source_id, set()).add(rel.id)
        self.in_rels.setdefault(rel.target_id, set()).add(rel.id)
        self.out_count[(rel.source_id, rel.type_name)] += 1
        self.in_count[(rel.target_id, rel.type_name)] += 1
        self._update_refs(rel.id, self._relationship_refs(rel))
        if self._containment(rel.type_name):
            self.containment_parents.setdefault(rel.target_id, []).append(rel.source_id)
            self._containment_rel_ids.setdefault(rel.target_id, []).append(rel.id)
            if len(self.containment_parents[rel.target_id]) == 1:
                # first containment parent: the target stops being a root
                self._roots_remove(rel.target_id)
            self._rekey_if_present(rel.target_id)
        self._rekey_key_rel_endpoints(rel)

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
                        target = self._model.elements.get(rel.target_id)
                        if target is not None:
                            # last containment parent gone: the target is a
                            # root again
                            self._roots_add(target)
            self._rekey_if_present(rel.target_id)
        self._rekey_key_rel_endpoints(rel)

    def on_properties_changed(self, entity: Element | Relationship) -> None:
        """Re-derive property-driven indexes (references, uniqueness) for one
        entity. Also the explicit hook for code that writes
        ``entity.properties`` directly instead of using ``set_property``."""
        if isinstance(entity, Element):
            self._update_refs(entity.id, self._element_refs(entity))
            self._rekey(entity)
            self._roots_reposition(entity)
            self._update_trigrams(entity.id, self._element_trigrams(entity))
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
        self.roots_order.clear()
        self._root_key_of.clear()
        self.search_postings.clear()
        self._trigrams_of.clear()
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
            trigs = self._element_trigrams(element)
            if trigs:
                self._trigrams_of[element.id] = tuple(sorted(trigs))
                for t in trigs:
                    self.search_postings.setdefault(t, set()).add(element.id)
            if element.id not in self.containment_parents:
                self._root_key_of[element.id] = (display_name(element), element.id)
        # bulk-construct in one O(n log n) pass instead of n incremental adds
        self.roots_order = SortedPairs(self._root_key_of.values())

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
            if isinstance(obj, Counter):
                return dict(obj)
            if isinstance(obj, SortedPairs):
                return obj.as_list()
            return obj

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
                "_root_key_of",
                "roots_order",
                "_refs_of",
                "search_postings",
                "_trigrams_of",
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
        spec = self._effective_key_spec(element.type_name)
        if spec is None:
            signature: Hashable = _frozen(element.properties)
        else:
            prop_values = tuple(
                _frozen(element.properties.get(k)) for k in spec.properties
            )
            rel_values = tuple(
                self._rel_endpoints(element.id, kr) for kr in spec.relationships
            )
            signature = (prop_values, rel_values)
        return (element.type_name, owner, signature)

    def _effective_key_spec(self, type_name: str) -> KeySpec | None:
        try:
            return self._key_specs[type_name]
        except KeyError:
            spec = self._model.metamodel.effective_element_key_spec(type_name)
            self._key_specs[type_name] = spec
            return spec

    def _rel_endpoints(self, element_id: str, kr: KeyRel) -> tuple[str, ...]:
        """Endpoint-id multiset for one relationship key, as a sorted tuple.

        Exact relationship-type match (subtypes of ``kr.rel_type`` do not
        count). ``out`` -> target ids of outgoing edges; ``in`` -> source ids of
        incoming edges.
        """
        rels = self._model.relationships
        if kr.direction == "out":
            rel_ids = self.out_rels.get(element_id) or ()
            endpoints = [
                rels[r].target_id for r in rel_ids if rels[r].type_name == kr.rel_type
            ]
        else:
            rel_ids = self.in_rels.get(element_id) or ()
            endpoints = [
                rels[r].source_id for r in rel_ids if rels[r].type_name == kr.rel_type
            ]
        return tuple(sorted(endpoints))

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

    def _ensure_key_rel_types(self) -> None:
        if self._out_key_rel_types is not None:
            return
        out: set[str] = set()
        inn: set[str] = set()
        mm = self._model.metamodel
        for et in mm.elements:
            spec = mm.effective_element_key_spec(et.name)
            if spec is None:
                continue
            for kr in spec.relationships:
                (out if kr.direction == "out" else inn).add(kr.rel_type)
        self._out_key_rel_types = out
        self._in_key_rel_types = inn

    # -- internals: roots order ----------------------------------------------

    def _roots_add(self, element: Element) -> None:
        key = (display_name(element), element.id)
        self._root_key_of[element.id] = key
        self.roots_order.add(key)

    def _roots_remove(self, element_id: str) -> None:
        key = self._root_key_of.pop(element_id, None)
        if key is not None:
            self.roots_order.remove(key)

    def _roots_reposition(self, element: Element) -> None:
        """Re-key a root after a property change (its display name may have
        moved). No-op for non-roots."""
        old = self._root_key_of.get(element.id)
        if old is None:
            return
        new = (display_name(element), element.id)
        if new == old:
            return
        self.roots_order.remove(old)
        self.roots_order.add(new)
        self._root_key_of[element.id] = new

    def _rekey_key_rel_endpoints(self, rel: Relationship) -> None:
        """Rekey an edge's endpoints when its type participates in a key.

        Endpoint ids are stable, so only the edge's own source/target need
        rekeying — no cascade. Call AFTER adjacency is updated so the signature
        reflects the post-mutation graph.
        """
        self._ensure_key_rel_types()
        assert self._out_key_rel_types is not None  # set by _ensure_key_rel_types
        assert self._in_key_rel_types is not None
        if rel.type_name in self._out_key_rel_types:
            self._rekey_if_present(rel.source_id)
        if rel.type_name in self._in_key_rel_types:
            self._rekey_if_present(rel.target_id)

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

    # -- internals: search trigrams -----------------------------------------

    def _element_trigrams(self, element: Element) -> frozenset[str]:
        """Merged lowercased trigram set of the element's searchable text —
        exactly the fields the fuzzy search scores: id, type name, every
        top-level string property value, and the resolved ``name_of`` name
        (which can live inside a LIST value the string sweep misses — without
        it a list-named element would be scoreable but never a candidate,
        breaking the superset guarantee). Fields shorter than 3 chars
        contribute nothing (they cannot contain a >=3-char query), and
        merging across fields is sound because candidates are score-verified
        by the caller (cross-field false positives are filtered there)."""
        trigs: set[str] = set()
        texts = [element.id, element.type_name]
        texts.extend(v for v in element.properties.values() if isinstance(v, str))
        name = name_of(element)
        if name is not None:
            texts.append(name)  # dedup via the set; only list-valued names are new
        for text in texts:
            s = text.lower()
            for i in range(len(s) - 2):
                t = s[i : i + 3]
                trigs.add(self._canon_trigrams.setdefault(t, t))
        return frozenset(trigs)

    def _update_trigrams(self, element_id: str, new: frozenset[str]) -> None:
        """Diff-apply an element's trigram set (mirrors _update_refs).
        Posting sets hold references to the id strings the model dicts own —
        no string duplication; empty posting sets are deleted (sparse)."""
        old = frozenset(self._trigrams_of.get(element_id) or ())
        if new == old:
            return
        for t in old - new:
            ids = self.search_postings.get(t)
            if ids is not None:
                ids.discard(element_id)
                if not ids:
                    del self.search_postings[t]
        for t in new - old:
            self.search_postings.setdefault(t, set()).add(element_id)
        if new:
            self._trigrams_of[element_id] = tuple(sorted(new))
        else:
            self._trigrams_of.pop(element_id, None)

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
