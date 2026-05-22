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

    def connect(self, rel_type: str, source_id: str, target_id: str) -> Relationship:
        if self.metamodel.relationship_type(rel_type) is None:
            raise KeyError(f"Unknown relationship type {rel_type!r}")
        if source_id not in self.elements:
            raise KeyError(f"No source element {source_id!r}")
        if target_id not in self.elements:
            raise KeyError(f"No target element {target_id!r}")
        rel = Relationship(id=self._ids.new_id(), type_name=rel_type,
                           source_id=source_id, target_id=target_id)
        self.relationships[rel.id] = rel
        return rel

    def disconnect(self, rel_id: str) -> None:
        if rel_id not in self.relationships:
            raise KeyError(f"No relationship with id {rel_id!r}")
        del self.relationships[rel_id]

    def relationships_from(self, element_id: str) -> list[Relationship]:
        return [r for r in self.relationships.values()
                if r.source_id == element_id]

    def relationships_to(self, element_id: str) -> list[Relationship]:
        return [r for r in self.relationships.values()
                if r.target_id == element_id]

    def _containment_children(self, element_id: str) -> list[Relationship]:
        return [r for r in self.relationships.values()
                if r.source_id == element_id
                and self.metamodel.is_containment(r.type_name)]

    def container_of(self, element_id: str) -> str | None:
        for r in self.relationships.values():
            if (r.target_id == element_id
                    and self.metamodel.is_containment(r.type_name)):
                return r.source_id
        return None

    def delete_element(self, element_id: str, _visiting: set[str] | None = None) -> None:
        if element_id not in self.elements:
            raise KeyError(f"No element with id {element_id!r}")
        visiting = _visiting if _visiting is not None else set()
        if element_id in visiting:
            return
        visiting.add(element_id)
        # cascade: delete contained children first (recursively)
        for rel in self._containment_children(element_id):
            child_id = rel.target_id
            if rel.id in self.relationships:
                self.disconnect(rel.id)
            if child_id in self.elements:
                self.delete_element(child_id, visiting)
        # remove any remaining relationships touching this element
        incident = [r.id for r in self.relationships.values()
                    if r.source_id == element_id or r.target_id == element_id]
        for rel_id in incident:
            self.disconnect(rel_id)
        del self.elements[element_id]
