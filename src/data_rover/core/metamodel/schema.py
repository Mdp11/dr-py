from __future__ import annotations

from collections.abc import Mapping as ABCMapping
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, Field, PrivateAttr, model_validator

from .multiplicity import Multiplicity

PRIMITIVES = frozenset({"string", "integer", "float", "boolean", "date"})


class PropertyDef(BaseModel):
    name: str
    datatype: str
    multiplicity: str = "0..1"
    # facets (all optional)
    min: float | None = None
    max: float | None = None
    pattern: str | None = None
    max_length: int | None = None


class Mapping(BaseModel):
    """An allowed (source, target) element-type pair for a relationship type."""

    source: str
    target: str


class ElementType(BaseModel):
    name: str
    abstract: bool = False
    extends: str | None = None
    properties: list[PropertyDef] = Field(default_factory=list)
    key: list[str] | None = None


class RelationshipType(BaseModel):
    name: str
    abstract: bool = False
    extends: str | None = None
    containment: bool = False
    # `mappings` is the source of truth for allowed endpoint pairs. `source`/
    # `target` are a single-pair shorthand kept for backward compatibility; after
    # validation they always mirror `mappings[0]` (or are None when there are no
    # mappings, e.g. an abstract base type).
    source: str | None = None
    target: str | None = None
    mappings: list[Mapping] = Field(default_factory=list)
    source_multiplicity: str = "0..*"
    target_multiplicity: str = "0..*"
    properties: list[PropertyDef] = Field(default_factory=list)

    @model_validator(mode="after")
    def _normalize_endpoints(self) -> RelationshipType:
        if not self.mappings and self.source is not None and self.target is not None:
            self.mappings = [Mapping(source=self.source, target=self.target)]
        if self.mappings:
            # keep the shorthand fields in sync with the first declared mapping
            self.source = self.mappings[0].source
            self.target = self.mappings[0].target
        return self


@dataclass(frozen=True)
class EndConstraint:
    """A relationship-end multiplicity constraint binding an element type.

    Direction semantics match the multiplicity validator:

    - ``end == "target"``: the element's type is a subtype of a mapping
      *source* of ``rel_type_name``; the relationship type's *target*
      multiplicity is checked against the element's OUTGOING count.
    - ``end == "source"``: the element's type is a subtype of a mapping
      *target*; the *source* multiplicity is checked against the INCOMING
      count.
    """

    rel_type_name: str
    end: Literal["source", "target"]
    multiplicity: Multiplicity


@dataclass
class _Caches:
    """Derived lookup tables for a Metamodel (see Metamodel docstring)."""

    types_by_name: dict[str, ElementType]
    rel_types_by_name: dict[str, RelationshipType]
    element_ancestors: dict[str, tuple[str, ...]]
    relationship_ancestors: dict[str, tuple[str, ...]]
    element_ancestor_sets: dict[str, frozenset[str]]
    relationship_ancestor_sets: dict[str, frozenset[str]]
    effective_element_props: dict[str, list[PropertyDef]]
    effective_relationship_props: dict[str, list[PropertyDef]]
    effective_element_keys: dict[str, tuple[str, ...] | None]
    containment: dict[str, bool]
    end_constraints: dict[str, list[EndConstraint]]

    def __eq__(self, other: object) -> bool:
        # Caches are derived state, fully determined by the Metamodel fields.
        # Keep them out of pydantic equality (which compares private attrs):
        # a Metamodel with built caches must equal an identical cold one.
        return other is None or isinstance(other, _Caches)


def _ancestor_chain(
    name: str, types: ABCMapping[str, ElementType | RelationshipType]
) -> tuple[str, ...]:
    chain: list[str] = []
    seen: set[str] = set()
    current: str | None = name
    while current and current not in seen:
        t = types.get(current)
        if t is None:
            break
        chain.append(current)
        seen.add(current)
        current = t.extends
    return tuple(chain)


def _effective_props(
    chain: tuple[str, ...], types: ABCMapping[str, ElementType | RelationshipType]
) -> list[PropertyDef]:
    props: list[PropertyDef] = []
    seen: set[str] = set()
    # walk root -> leaf so overrides by closer types win; here child appends
    # after parent
    for type_name in reversed(chain):
        t = types[type_name]
        for p in t.properties:
            if p.name not in seen:
                props.append(p)
                seen.add(p.name)
    return props


def _parse_or_none(spec: str) -> Multiplicity | None:
    # Tolerate invalid multiplicity strings: caches may be built while
    # check_metamodel() is still inspecting an invalid metamodel, and the
    # loader must keep reporting friendly errors instead of a ValueError here.
    try:
        return Multiplicity.parse(spec)
    except ValueError:
        return None


def _binding_multiplicity(spec: str) -> Multiplicity | None:
    """The parsed multiplicity, or None when it can never be violated."""
    mult = _parse_or_none(spec)
    if mult is None or (mult.lower == 0 and mult.upper is None):
        return None
    return mult


def _build_end_constraints(
    relationships: list[RelationshipType],
    element_ancestor_sets: dict[str, frozenset[str]],
) -> dict[str, list[EndConstraint]]:
    out: dict[str, list[EndConstraint]] = {n: [] for n in element_ancestor_sets}
    for rt in relationships:
        if rt.abstract or not rt.mappings:
            continue
        target_mult = _binding_multiplicity(rt.target_multiplicity)
        source_mult = _binding_multiplicity(rt.source_multiplicity)
        if target_mult is None and source_mult is None:
            continue
        mapping_sources = {m.source for m in rt.mappings}
        mapping_targets = {m.target for m in rt.mappings}
        for type_name, ancestors in element_ancestor_sets.items():
            if target_mult is not None and not mapping_sources.isdisjoint(ancestors):
                out[type_name].append(EndConstraint(rt.name, "target", target_mult))
            if source_mult is not None and not mapping_targets.isdisjoint(ancestors):
                out[type_name].append(EndConstraint(rt.name, "source", source_mult))
    return out


def _build_caches(mm: Metamodel) -> _Caches:
    # first-wins on duplicate names, matching the original linear scans
    types_by_name: dict[str, ElementType] = {}
    for et in mm.elements:
        types_by_name.setdefault(et.name, et)
    rel_types_by_name: dict[str, RelationshipType] = {}
    for rt in mm.relationships:
        rel_types_by_name.setdefault(rt.name, rt)

    element_ancestors = {n: _ancestor_chain(n, types_by_name) for n in types_by_name}
    relationship_ancestors = {
        n: _ancestor_chain(n, rel_types_by_name) for n in rel_types_by_name
    }
    element_ancestor_sets = {n: frozenset(c) for n, c in element_ancestors.items()}

    effective_element_keys: dict[str, tuple[str, ...] | None] = {}
    for name, chain in element_ancestors.items():
        key: tuple[str, ...] | None = None
        for type_name in chain:
            declared = types_by_name[type_name].key
            if declared is not None:
                key = tuple(declared)
                break
        effective_element_keys[name] = key

    return _Caches(
        types_by_name=types_by_name,
        rel_types_by_name=rel_types_by_name,
        element_ancestors=element_ancestors,
        relationship_ancestors=relationship_ancestors,
        element_ancestor_sets=element_ancestor_sets,
        relationship_ancestor_sets={
            n: frozenset(c) for n, c in relationship_ancestors.items()
        },
        effective_element_props={
            n: _effective_props(c, types_by_name) for n, c in element_ancestors.items()
        },
        effective_relationship_props={
            n: _effective_props(c, rel_types_by_name)
            for n, c in relationship_ancestors.items()
        },
        effective_element_keys=effective_element_keys,
        containment={
            n: any(rel_types_by_name[a].containment for a in c)
            for n, c in relationship_ancestors.items()
        },
        end_constraints=_build_end_constraints(mm.relationships, element_ancestor_sets),
    )


class Metamodel(BaseModel):
    """A metamodel document.

    Lookup methods are served from lazily built private caches. A Metamodel is
    treated as IMMUTABLE once constructed: nothing in the codebase mutates
    `enums`/`elements`/`relationships` after load (uploads replace the whole
    object). If a mutation path is ever introduced, reset `_cache` to None on
    that path (or replace the instance) to invalidate the caches.
    """

    enums: dict[str, list[str]] = Field(default_factory=dict)
    elements: list[ElementType] = Field(default_factory=list)
    relationships: list[RelationshipType] = Field(default_factory=list)

    _cache: _Caches | None = PrivateAttr(default=None)

    def _caches(self) -> _Caches:
        cache = self._cache
        if cache is None:
            cache = _build_caches(self)
            self._cache = cache
        return cache

    def model_copy(
        self, *, update: ABCMapping[str, Any] | None = None, deep: bool = False
    ) -> Metamodel:
        """Return a copy with a reset cache so it lazily rebuilds from new data.

        Pydantic's default ``model_copy`` shallow- or deep-copies private attrs
        along with the model, meaning the copy either shares the old cache
        (stale if ``update`` changes ``elements``/``relationships``) or carries
        a duplicate deep-copied cache object. Resetting ``_cache`` to ``None``
        on the copy ensures the first lookup rebuilds it from the copy's own
        fields, maintaining correctness and object-identity guarantees.
        """
        copy = super().model_copy(update=update, deep=deep)
        copy._cache = None
        return copy

    def element_type(self, name: str) -> ElementType | None:
        return self._caches().types_by_name.get(name)

    def is_element_type(self, name: str) -> bool:
        return name in self._caches().types_by_name

    def relationship_type(self, name: str) -> RelationshipType | None:
        return self._caches().rel_types_by_name.get(name)

    def element_ancestors(self, name: str) -> list[str]:
        return list(self._caches().element_ancestors.get(name, ()))

    def relationship_ancestors(self, name: str) -> list[str]:
        return list(self._caches().relationship_ancestors.get(name, ()))

    def is_element_subtype(self, sub: str, sup: str) -> bool:
        ancestors = self._caches().element_ancestor_sets.get(sub)
        return ancestors is not None and sup in ancestors

    def is_relationship_subtype(self, sub: str, sup: str) -> bool:
        ancestors = self._caches().relationship_ancestor_sets.get(sub)
        return ancestors is not None and sup in ancestors

    def effective_element_properties(self, name: str) -> list[PropertyDef]:
        # fresh outer list (callers may build/mutate); PropertyDef objects are
        # shared, as they were with the uncached implementation
        return list(self._caches().effective_element_props.get(name, ()))

    def effective_element_key(self, name: str) -> list[str] | None:
        """First declared key found walking from `name` up its `extends` chain.

        Child override wins; returns None if no ancestor declares one.
        """
        key = self._caches().effective_element_keys.get(name)
        return None if key is None else list(key)

    def effective_relationship_properties(self, name: str) -> list[PropertyDef]:
        return list(self._caches().effective_relationship_props.get(name, ()))

    def is_containment(self, rel_type_name: str) -> bool:
        return self._caches().containment.get(rel_type_name, False)

    def end_constraints(self, type_name: str) -> list[EndConstraint]:
        """Relationship-end multiplicity constraints binding `type_name`.

        Precomputed by expanding every non-abstract relationship type's
        mappings over all element types (abstract ones included, since model
        elements are matched purely by type name). Constraints whose
        multiplicity can never be violated (e.g. "0..*") are omitted. See
        `EndConstraint` for the direction semantics.
        """
        return list(self._caches().end_constraints.get(type_name, ()))
