from __future__ import annotations

from ..metamodel.schema import Metamodel
from .element import Element
from .ids import IdGenerator, Uuid7Generator
from .relationship import Relationship


class Model:
    """A collection of elements and relationships conforming to one metamodel.

    All mutation flows through this object's methods (the mutation boundary).
    """

    def __init__(self, metamodel: Metamodel,
                 id_generator: IdGenerator | None = None) -> None:
        self.metamodel = metamodel
        self._ids: IdGenerator = id_generator or Uuid7Generator()
        self.elements: dict[str, Element] = {}
        self.relationships: dict[str, Relationship] = {}

    # --- mutation boundary: elements ---
    def create_element(self, type_name: str) -> Element:
        et = self.metamodel.element_type(type_name)
        if et is None:
            raise KeyError(f"Unknown element type {type_name!r}")
        if et.abstract:
            raise ValueError(f"Cannot instantiate abstract type {type_name!r}")
        element = Element(id=self._ids.new_id(), type_name=type_name)
        self.elements[element.id] = element
        return element

    # --- queries ---
    def get_element(self, element_id: str) -> Element:
        if element_id not in self.elements:
            raise KeyError(f"No element with id {element_id!r}")
        return self.elements[element_id]

    def get_relationship(self, rel_id: str) -> Relationship:
        if rel_id not in self.relationships:
            raise KeyError(f"No relationship with id {rel_id!r}")
        return self.relationships[rel_id]

    def set(self, target: Element | Relationship, prop: str, value) -> None:
        if isinstance(target, Element):
            defs = self.metamodel.effective_element_properties(target.type_name)
        else:
            defs = self.metamodel.effective_relationship_properties(target.type_name)
        if prop not in {p.name for p in defs}:
            raise KeyError(
                f"{target.type_name!r} has no property {prop!r}")
        target.properties[prop] = value
        target.rev += 1
