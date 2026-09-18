"""Virtual properties a property column may name besides the metamodel's own.

`_Stereotype` reads an element's type name. The leading underscore keeps it
out of the namespace a metamodel author can declare, so it never shadows a
real property. A virtual property is declared on EVERY type, single-valued
and read-only; every property-column read site goes through the two helpers
here so the rule cannot drift between cells, expand promotion, sorting and
script inputs.
"""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element

STEREOTYPE_PROPERTY = "_Stereotype"
VIRTUAL_PROPERTIES: frozenset[str] = frozenset({STEREOTYPE_PROPERTY})


def is_virtual_property(name: str) -> bool:
    return name in VIRTUAL_PROPERTIES


def property_declared(mm: Metamodel, type_name: str, name: str) -> bool:
    """Whether `type_name` declares `name`; a virtual property always is."""
    if is_virtual_property(name):
        return True
    return any(pd.name == name for pd in mm.effective_element_properties(type_name))


def property_datatype(mm: Metamodel, type_name: str, name: str) -> str | None:
    """The datatype `type_name` declares for `name`; `None` when undeclared
    or virtual."""
    if is_virtual_property(name):
        return None
    return next(
        (
            pd.datatype
            for pd in mm.effective_element_properties(type_name)
            if pd.name == name
        ),
        None,
    )


def property_is_element_typed(mm: Metamodel, type_name: str, name: str) -> bool:
    """Whether `type_name` declares `name` with an ELEMENT datatype — the
    values are element ids, and a property column reading it produces
    elements. A virtual or undeclared property is never element-typed."""
    dt = property_datatype(mm, type_name, name)
    return dt is not None and mm.is_element_type(dt)


def raw_property(el: Element, name: str) -> Any:
    """The stored value of `name` on `el` (`None` when unset), or the virtual
    property's derived value. Does NOT check declaration — pair it with
    `property_declared` where an undeclared property must contribute nothing."""
    if name == STEREOTYPE_PROPERTY:
        return el.type_name
    return el.properties.get(name)
