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

    def relationship_type(self, name: str) -> RelationshipType | None:
        return next((r for r in self.relationships if r.name == name), None)
