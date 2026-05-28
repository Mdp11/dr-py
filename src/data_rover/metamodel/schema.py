from __future__ import annotations

from pydantic import BaseModel, Field

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


class ElementType(BaseModel):
    name: str
    abstract: bool = False
    extends: str | None = None
    properties: list[PropertyDef] = Field(default_factory=list)


class RelationshipType(BaseModel):
    name: str
    abstract: bool = False
    extends: str | None = None
    containment: bool = False
    source: str
    target: str
    source_multiplicity: str = "0..*"
    target_multiplicity: str = "0..*"
    properties: list[PropertyDef] = Field(default_factory=list)


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
