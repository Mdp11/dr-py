from __future__ import annotations

from .multiplicity import Multiplicity
from .schema import PRIMITIVES, Metamodel, PropertyDef


def _valid_datatype(mm: Metamodel, datatype: str) -> bool:
    return datatype in PRIMITIVES or datatype in mm.enums


def _check_properties(mm: Metamodel, owner: str, props: list[PropertyDef],
                      errors: list[str]) -> None:
    for p in props:
        if not _valid_datatype(mm, p.datatype):
            errors.append(f"{owner}.{p.name}: unknown datatype {p.datatype!r}")
        try:
            Multiplicity.parse(p.multiplicity)
        except ValueError:
            errors.append(
                f"{owner}.{p.name}: invalid multiplicity {p.multiplicity!r}")


def _has_cycle(get_extends, name: str) -> bool:
    seen: set[str] = set()
    current: str | None = name
    while current is not None:
        if current in seen:
            return True
        seen.add(current)
        current = get_extends(current)
    return False


def check_metamodel(mm: Metamodel) -> list[str]:
    """Return a list of human-readable error strings; empty means valid."""
    errors: list[str] = []
    element_names = {e.name for e in mm.elements}

    for et in mm.elements:
        if et.extends is not None and et.extends not in element_names:
            errors.append(f"Element {et.name!r} extends unknown type {et.extends!r}")
        _check_properties(mm, et.name, et.properties, errors)

    for et in mm.elements:
        if _has_cycle(lambda n: (mm.element_type(n).extends
                                 if mm.element_type(n) else None), et.name):
            errors.append(f"Inheritance cycle involving element {et.name!r}")
            break

    rel_names = {r.name for r in mm.relationships}
    for rt in mm.relationships:
        if rt.extends is not None and rt.extends not in rel_names:
            errors.append(
                f"Relationship {rt.name!r} extends unknown type {rt.extends!r}")
        if rt.source not in element_names:
            errors.append(f"Relationship {rt.name!r} source {rt.source!r} "
                          "is not an element type")
        if rt.target not in element_names:
            errors.append(f"Relationship {rt.name!r} target {rt.target!r} "
                          "is not an element type")
        for spec in (rt.source_multiplicity, rt.target_multiplicity):
            try:
                Multiplicity.parse(spec)
            except ValueError:
                errors.append(
                    f"Relationship {rt.name!r}: invalid multiplicity {spec!r}")
        _check_properties(mm, rt.name, rt.properties, errors)

    return errors
