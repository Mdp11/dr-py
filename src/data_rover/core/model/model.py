from __future__ import annotations

from ..metamodel.schema import Metamodel
from .element import Element
from .ids import IdGenerator, Uuid7Generator
from .indexes import IndexSet
from .relationship import Relationship


class Model:
    """A collection of elements and relationships conforming to one metamodel.

    All mutation flows through this object's methods (the mutation boundary),
    which keep `self.indexes` in sync. Bulk loaders that populate `elements` /
    `relationships` directly must call `self.indexes.rebuild()` afterwards.
    """

    def __init__(
        self, metamodel: Metamodel, id_generator: IdGenerator | None = None
    ) -> None:
        self.metamodel = metamodel
        self._ids: IdGenerator = id_generator or Uuid7Generator()
        self.elements: dict[str, Element] = {}
        self.relationships: dict[str, Relationship] = {}
        self.indexes = IndexSet(self)

    # --- mutation boundary: elements ---
    def create_element(self, type_name: str) -> Element:
        et = self.metamodel.element_type(type_name)
        if et is None:
            raise KeyError(f"Unknown element type {type_name!r}")
        if et.abstract:
            raise ValueError(f"Cannot instantiate abstract type {type_name!r}")
        element = Element(id=self._ids.new_id(), type_name=type_name)
        self.elements[element.id] = element
        self.indexes.on_element_created(element)
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

    def set_property(self, target: Element | Relationship, prop: str, value) -> None:
        if (
            self.elements.get(target.id) is not target
            and self.relationships.get(target.id) is not target
        ):
            raise KeyError(f"Entity {target.id!r} is not part of this model")
        if isinstance(target, Element):
            defs = self.metamodel.effective_element_properties(target.type_name)
        else:
            defs = self.metamodel.effective_relationship_properties(target.type_name)
        if prop not in {p.name for p in defs}:
            raise KeyError(f"{target.type_name!r} has no property {prop!r}")
        target.properties[prop] = value
        target.rev += 1
        self.indexes.on_properties_changed(target)

    def connect(self, rel_type: str, source_id: str, target_id: str) -> Relationship:
        if self.metamodel.relationship_type(rel_type) is None:
            raise KeyError(f"Unknown relationship type {rel_type!r}")
        if source_id not in self.elements:
            raise KeyError(f"No source element {source_id!r}")
        if target_id not in self.elements:
            raise KeyError(f"No target element {target_id!r}")
        rel = Relationship(
            id=self._ids.new_id(),
            type_name=rel_type,
            source_id=source_id,
            target_id=target_id,
        )
        self.relationships[rel.id] = rel
        self.indexes.on_relationship_created(rel)
        return rel

    def disconnect(self, rel_id: str) -> None:
        if rel_id not in self.relationships:
            raise KeyError(f"No relationship with id {rel_id!r}")
        rel = self.relationships.pop(rel_id)
        self.indexes.on_relationship_deleted(rel)

    # NOTE: the index-backed helpers below return relationships in set
    # iteration order (unspecified), not in `relationships` dict insertion
    # order as the previous linear scans did. No caller depends on the order.
    def relationships_from(self, element_id: str) -> list[Relationship]:
        rel_ids = self.indexes.out_rels.get(element_id) or ()
        return [self.relationships[rid] for rid in rel_ids]

    def relationships_to(self, element_id: str) -> list[Relationship]:
        rel_ids = self.indexes.in_rels.get(element_id) or ()
        return [self.relationships[rid] for rid in rel_ids]

    def _containment_children(self, element_id: str) -> list[Relationship]:
        rel_ids = self.indexes.out_rels.get(element_id) or ()
        rels = (self.relationships[rid] for rid in rel_ids)
        return [r for r in rels if self.metamodel.is_containment(r.type_name)]

    def container_of(self, element_id: str) -> str | None:
        return self.indexes.first_parent(element_id)

    def delete_element(
        self, element_id: str, _visiting: set[str] | None = None
    ) -> None:
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
        outgoing = self.indexes.out_rels.get(element_id) or set()
        incoming = self.indexes.in_rels.get(element_id) or set()
        for rel_id in list(outgoing | incoming):
            self.disconnect(rel_id)
        element = self.elements.pop(element_id)
        self.indexes.on_element_deleted(element)
