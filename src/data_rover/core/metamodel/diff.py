"""Structural metamodel diff (artefacts revamp, Phase 4).

One pure differ, two API surfaces: ``POST /metamodel/diff`` (pre-rebind
review) and the commit-diff renderer (post-hoc history of rebind commits).
Lives in core because it compares two core ``Metamodel`` objects and core has
no api imports.

Rules (spec 2026-08-10):
- Identity is the NAME everywhere (types, properties, enums); a rename is
  remove+add. No rename detection.
- The diff mirrors the RAW document — ``extends`` chains are not flattened
  and inherited properties do not appear on subtypes. Inherited-property
  IMPACT is the validation-impact section's job, not this differ's.
- Relationship ``source``/``target`` are NOT diffed as attributes: a model
  validator keeps them mirroring ``mappings[0]``, so diffing them would
  duplicate every mappings change. The mappings diff is authoritative.
- Enum-literal and type/property ORDER changes are not changes (the model is
  order-insensitive); output lists are name-sorted for determinism.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .schema import ElementType, Mapping, Metamodel, PropertyDef, RelationshipType

#: Scalar attributes compared on a changed element type.
_EL_ATTRS = ("abstract", "extends", "key")
#: Scalar attributes compared on a changed relationship type (no source/target
#: — see module docstring).
_REL_ATTRS = (
    "abstract",
    "extends",
    "containment",
    "source_multiplicity",
    "target_multiplicity",
)
#: Facets compared on a changed property.
_PROP_FACETS = ("datatype", "multiplicity", "min", "max", "pattern", "max_length")


class FieldChange(BaseModel):
    """One scalar field's before/after. Wire keys are ``field``/``from``/``to``
    (``from`` is a python keyword, hence the alias)."""

    model_config = ConfigDict(populate_by_name=True)

    field: str
    from_: Any = Field(default=None, alias="from")
    to: Any = None


class EnumEntry(BaseModel):
    name: str
    literals: list[str] = Field(default_factory=list)


class EnumChange(BaseModel):
    name: str
    added: list[str] = Field(default_factory=list)
    removed: list[str] = Field(default_factory=list)


class EnumsDiff(BaseModel):
    added: list[EnumEntry] = Field(default_factory=list)
    removed: list[EnumEntry] = Field(default_factory=list)
    changed: list[EnumChange] = Field(default_factory=list)


class PropertyChange(BaseModel):
    name: str
    fields: list[FieldChange] = Field(default_factory=list)


class PropertiesDiff(BaseModel):
    added: list[PropertyDef] = Field(default_factory=list)
    removed: list[PropertyDef] = Field(default_factory=list)
    changed: list[PropertyChange] = Field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not (self.added or self.removed or self.changed)


class MappingsDiff(BaseModel):
    added: list[Mapping] = Field(default_factory=list)
    removed: list[Mapping] = Field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not (self.added or self.removed)


class ElementTypeChange(BaseModel):
    name: str
    attributes: list[FieldChange] = Field(default_factory=list)
    properties: PropertiesDiff = Field(default_factory=PropertiesDiff)


class ElementTypesDiff(BaseModel):
    added: list[ElementType] = Field(default_factory=list)
    removed: list[ElementType] = Field(default_factory=list)
    changed: list[ElementTypeChange] = Field(default_factory=list)


class RelationshipTypeChange(BaseModel):
    name: str
    attributes: list[FieldChange] = Field(default_factory=list)
    properties: PropertiesDiff = Field(default_factory=PropertiesDiff)
    mappings: MappingsDiff = Field(default_factory=MappingsDiff)


class RelationshipTypesDiff(BaseModel):
    added: list[RelationshipType] = Field(default_factory=list)
    removed: list[RelationshipType] = Field(default_factory=list)
    changed: list[RelationshipTypeChange] = Field(default_factory=list)


class MetamodelStructuralDiff(BaseModel):
    enums: EnumsDiff = Field(default_factory=EnumsDiff)
    element_types: ElementTypesDiff = Field(default_factory=ElementTypesDiff)
    relationship_types: RelationshipTypesDiff = Field(
        default_factory=RelationshipTypesDiff
    )

    @property
    def is_empty(self) -> bool:
        """Convenience for "no structural changes" rendering; deliberately a
        python property (clients derive emptiness from the arrays)."""
        return not (
            self.enums.added
            or self.enums.removed
            or self.enums.changed
            or self.element_types.added
            or self.element_types.removed
            or self.element_types.changed
            or self.relationship_types.added
            or self.relationship_types.removed
            or self.relationship_types.changed
        )


def _field_changes(
    old: BaseModel, new: BaseModel, fields: tuple[str, ...]
) -> list[FieldChange]:
    out: list[FieldChange] = []
    for f in fields:
        a, b = getattr(old, f), getattr(new, f)
        if a != b:
            # Constructed via the wire alias, not the `from_` keyword: mypy's
            # PEP 681 (dataclass_transform) support synthesizes the __init__
            # parameter name from the pydantic `alias`, not `populate_by_name`
            # (that's runtime-only), so a `from_=` keyword call statically
            # resolves against the reserved-word alias and fails typecheck.
            out.append(FieldChange.model_validate({"field": f, "from": a, "to": b}))
    return out


def _props_diff(old: list[PropertyDef], new: list[PropertyDef]) -> PropertiesDiff:
    old_by = {p.name: p for p in old}
    new_by = {p.name: p for p in new}
    changed: list[PropertyChange] = []
    for n in sorted(old_by.keys() & new_by.keys()):
        fields = _field_changes(old_by[n], new_by[n], _PROP_FACETS)
        if fields:
            changed.append(PropertyChange(name=n, fields=fields))
    return PropertiesDiff(
        added=[new_by[n] for n in sorted(new_by.keys() - old_by.keys())],
        removed=[old_by[n] for n in sorted(old_by.keys() - new_by.keys())],
        changed=changed,
    )


def _mappings_diff(old: list[Mapping], new: list[Mapping]) -> MappingsDiff:
    old_set = {(m.source, m.target) for m in old}
    new_set = {(m.source, m.target) for m in new}
    return MappingsDiff(
        added=[Mapping(source=s, target=t) for s, t in sorted(new_set - old_set)],
        removed=[Mapping(source=s, target=t) for s, t in sorted(old_set - new_set)],
    )


def _enums_diff(old: dict[str, list[str]], new: dict[str, list[str]]) -> EnumsDiff:
    changed: list[EnumChange] = []
    for n in sorted(old.keys() & new.keys()):
        a, b = set(old[n]), set(new[n])
        added, removed = sorted(b - a), sorted(a - b)
        if added or removed:
            changed.append(EnumChange(name=n, added=added, removed=removed))
    return EnumsDiff(
        added=[
            EnumEntry(name=n, literals=new[n]) for n in sorted(new.keys() - old.keys())
        ],
        removed=[
            EnumEntry(name=n, literals=old[n]) for n in sorted(old.keys() - new.keys())
        ],
        changed=changed,
    )


def _element_types_diff(
    old: list[ElementType], new: list[ElementType]
) -> ElementTypesDiff:
    old_by = {t.name: t for t in old}
    new_by = {t.name: t for t in new}
    changed: list[ElementTypeChange] = []
    for n in sorted(old_by.keys() & new_by.keys()):
        attrs = _field_changes(old_by[n], new_by[n], _EL_ATTRS)
        props = _props_diff(old_by[n].properties, new_by[n].properties)
        if attrs or not props.is_empty:
            changed.append(ElementTypeChange(name=n, attributes=attrs, properties=props))
    return ElementTypesDiff(
        added=[new_by[n] for n in sorted(new_by.keys() - old_by.keys())],
        removed=[old_by[n] for n in sorted(old_by.keys() - new_by.keys())],
        changed=changed,
    )


def _relationship_types_diff(
    old: list[RelationshipType], new: list[RelationshipType]
) -> RelationshipTypesDiff:
    old_by = {t.name: t for t in old}
    new_by = {t.name: t for t in new}
    changed: list[RelationshipTypeChange] = []
    for n in sorted(old_by.keys() & new_by.keys()):
        attrs = _field_changes(old_by[n], new_by[n], _REL_ATTRS)
        props = _props_diff(old_by[n].properties, new_by[n].properties)
        mappings = _mappings_diff(old_by[n].mappings, new_by[n].mappings)
        if attrs or not props.is_empty or not mappings.is_empty:
            changed.append(
                RelationshipTypeChange(
                    name=n, attributes=attrs, properties=props, mappings=mappings
                )
            )
    return RelationshipTypesDiff(
        added=[new_by[n] for n in sorted(new_by.keys() - old_by.keys())],
        removed=[old_by[n] for n in sorted(old_by.keys() - new_by.keys())],
        changed=changed,
    )


def diff_metamodels(old: Metamodel, new: Metamodel) -> MetamodelStructuralDiff:
    """Compare two metamodel documents structurally. Pure: neither input is
    touched, and the inputs' immutability (schema.py) makes the result stable
    for a given pair."""
    return MetamodelStructuralDiff(
        enums=_enums_diff(old.enums, new.enums),
        element_types=_element_types_diff(old.elements, new.elements),
        relationship_types=_relationship_types_diff(
            old.relationships, new.relationships
        ),
    )
