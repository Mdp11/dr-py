from __future__ import annotations

from pydantic import BaseModel, Field, model_validator

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


class Metamodel(BaseModel):
    enums: dict[str, list[str]] = Field(default_factory=dict)
    elements: list[ElementType] = Field(default_factory=list)
    relationships: list[RelationshipType] = Field(default_factory=list)

    def element_type(self, name: str) -> ElementType | None:
        return next((e for e in self.elements if e.name == name), None)

    def is_element_type(self, name: str) -> bool:
        return self.element_type(name) is not None

    def relationship_type(self, name: str) -> RelationshipType | None:
        return next((r for r in self.relationships if r.name == name), None)

    def element_ancestors(self, name: str) -> list[str]:
        chain: list[str] = []
        current: str | None = name
        seen: set[str] = set()
        while current and current not in seen:
            et = self.element_type(current)
            if et is None:
                break
            chain.append(current)
            seen.add(current)
            current = et.extends
        return chain

    def relationship_ancestors(self, name: str) -> list[str]:
        chain: list[str] = []
        current: str | None = name
        seen: set[str] = set()
        while current and current not in seen:
            rt = self.relationship_type(current)
            if rt is None:
                break
            chain.append(current)
            seen.add(current)
            current = rt.extends
        return chain

    def is_element_subtype(self, sub: str, sup: str) -> bool:
        return sup in self.element_ancestors(sub)

    def is_relationship_subtype(self, sub: str, sup: str) -> bool:
        return sup in self.relationship_ancestors(sub)

    def effective_element_properties(self, name: str) -> list[PropertyDef]:
        props: list[PropertyDef] = []
        seen: set[str] = set()
        # walk root -> leaf so overrides by closer types win; here child appends after parent
        for type_name in reversed(self.element_ancestors(name)):
            et = self.element_type(type_name)
            if et is None:
                continue
            for p in et.properties:
                if p.name not in seen:
                    props.append(p)
                    seen.add(p.name)
        return props

    def effective_element_key(self, name: str) -> list[str] | None:
        """First declared key found walking from `name` up its `extends` chain.

        Child override wins; returns None if no ancestor declares one.
        """
        for type_name in self.element_ancestors(name):
            et = self.element_type(type_name)
            if et is not None and et.key is not None:
                return list(et.key)
        return None

    def effective_relationship_properties(self, name: str) -> list[PropertyDef]:
        props: list[PropertyDef] = []
        seen: set[str] = set()
        for type_name in reversed(self.relationship_ancestors(name)):
            rt = self.relationship_type(type_name)
            if rt is None:
                continue
            for p in rt.properties:
                if p.name not in seen:
                    props.append(p)
                    seen.add(p.name)
        return props

    def is_containment(self, rel_type_name: str) -> bool:
        for t in self.relationship_ancestors(rel_type_name):
            rt = self.relationship_type(t)
            assert rt is not None  # relationship_ancestors only yields existing types
            if rt.containment:
                return True
        return False
