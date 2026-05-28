from __future__ import annotations

import re

from .multiplicity import Multiplicity
from .schema import PRIMITIVES, Metamodel, PropertyDef


def _valid_datatype(mm: Metamodel, datatype: str) -> bool:
    return (
        datatype in PRIMITIVES or datatype in mm.enums or mm.is_element_type(datatype)
    )


def _check_properties(
    mm: Metamodel, owner: str, props: list[PropertyDef], errors: list[str]
) -> None:
    for p in props:
        if not _valid_datatype(mm, p.datatype):
            errors.append(f"{owner}.{p.name}: unknown datatype {p.datatype!r}")
        try:
            Multiplicity.parse(p.multiplicity)
        except ValueError:
            errors.append(f"{owner}.{p.name}: invalid multiplicity {p.multiplicity!r}")
        if p.pattern is not None:
            try:
                re.compile(p.pattern)
            except re.error:
                errors.append(f"{owner}.{p.name}: invalid regex pattern {p.pattern!r}")


def _check_extend_cycles(objects, types) -> list[str]:
    errors: list[str] = []

    in_cycle: set[str] = set()
    for o in objects:
        if o.name in in_cycle:
            continue
        visited: list[str] = []
        seen_set: set[str] = set()
        node: str | None = o.name
        while node is not None and node not in seen_set:
            seen_set.add(node)
            visited.append(node)
            nxt = types(node)
            node = nxt.extends if nxt else None
        if node is not None:  # re-entered a visited node => cycle starting at `node`
            if node not in in_cycle:
                errors.append(f"Inheritance cycle involving {node!r}")
            for member in visited[visited.index(node) :]:
                in_cycle.add(member)

    return errors


def check_metamodel(mm: Metamodel) -> list[str]:
    """Return a list of human-readable error strings; empty means valid."""
    errors: list[str] = []
    element_names = {e.name for e in mm.elements}

    for name in element_names & set(mm.enums):
        errors.append(f"Name {name!r} is used both as enum and element type")
    for name in element_names & PRIMITIVES:
        errors.append(f"Name {name!r} is used both as primitive and element type")
    for name in set(mm.enums) & PRIMITIVES:
        errors.append(f"Name {name!r} is used both as primitive and enum")

    for et in mm.elements:
        if et.extends is not None and et.extends not in element_names:
            errors.append(f"Element {et.name!r} extends unknown type {et.extends!r}")
        _check_properties(mm, et.name, et.properties, errors)

    errors.extend(_check_extend_cycles(mm.elements, mm.element_type))
    errors.extend(_check_extend_cycles(mm.relationships, mm.relationship_type))

    for et in mm.elements:
        if et.key is not None:
            if len(et.key) == 0:
                errors.append(
                    f"Element {et.name!r}: key must be non-empty (omit to mean 'no key')"
                )
            else:
                effective = {p.name for p in mm.effective_element_properties(et.name)}
                for k in et.key:
                    if k not in effective:
                        errors.append(
                            f"Element {et.name!r}: key references unknown property {k!r}"
                        )

    for et in mm.elements:
        e_ancestor_props: dict[str, str] = {}
        for ancestor_name in mm.element_ancestors(et.name)[1:]:
            e_ancestor = mm.element_type(ancestor_name)
            if e_ancestor is None:
                continue
            for p in e_ancestor.properties:
                e_ancestor_props.setdefault(p.name, ancestor_name)
        for p in et.properties:
            if p.name in e_ancestor_props:
                errors.append(
                    f"Element {et.name!r} redefines property {p.name!r} "
                    f"from ancestor {e_ancestor_props[p.name]!r}"
                )

    rel_names = {r.name for r in mm.relationships}
    for rt in mm.relationships:
        if rt.extends is not None and rt.extends not in rel_names:
            errors.append(
                f"Relationship {rt.name!r} extends unknown type {rt.extends!r}"
            )
        if rt.source not in element_names:
            errors.append(
                f"Relationship {rt.name!r} source {rt.source!r} is not an element type"
            )
        if rt.target not in element_names:
            errors.append(
                f"Relationship {rt.name!r} target {rt.target!r} is not an element type"
            )
        for spec in (rt.source_multiplicity, rt.target_multiplicity):
            try:
                Multiplicity.parse(spec)
            except ValueError:
                errors.append(
                    f"Relationship {rt.name!r}: invalid multiplicity {spec!r}"
                )
        _check_properties(mm, rt.name, rt.properties, errors)

    for rt in mm.relationships:
        r_ancestor_props: dict[str, str] = {}
        for ancestor_name in mm.relationship_ancestors(rt.name)[1:]:
            r_ancestor = mm.relationship_type(ancestor_name)
            if r_ancestor is None:
                continue
            for p in r_ancestor.properties:
                r_ancestor_props.setdefault(p.name, ancestor_name)
        for p in rt.properties:
            if p.name in r_ancestor_props:
                errors.append(
                    f"Relationship {rt.name!r} redefines property {p.name!r} "
                    f"from ancestor {r_ancestor_props[p.name]!r}"
                )

    return errors
