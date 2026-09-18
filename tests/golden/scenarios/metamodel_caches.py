"""Every derived lookup of ``Metamodel``, over a metamodel built to hit the
corners: overrides, inherited and empty keys, inherited containment, binding
and non-binding multiplicities, a cycle, an unknown parent, a repeated name."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.multiplicity import Multiplicity
from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario

_METAMODEL = {
    "enums": {"Color": ["red", "green"]},
    "elements": [
        {
            "name": "Base",
            "abstract": True,
            "properties": [
                {"name": "name", "datatype": "string", "multiplicity": "1"},
                {"name": "shade", "datatype": "Color"},
            ],
            "key": ["name"],
        },
        {
            "name": "Mid",
            "extends": "Base",
            "properties": [
                {"name": "size", "datatype": "integer", "min": 0, "max": 10},
                # a redeclared name: the ancestor's definition stays in force
                {"name": "name", "datatype": "integer", "multiplicity": "0..*"},
            ],
        },
        {
            "name": "Leaf",
            "extends": "Mid",
            "properties": [{"name": "buddy", "datatype": "Leaf"}],
            "key": ["size", "out:Links", "in:Holds", "out:"],
        },
        {"name": "Keyless", "properties": [{"name": "note", "datatype": "string"}]},
        {"name": "EmptyKey", "extends": "Base", "key": []},
        {"name": "Orphan", "extends": "Missing"},
        {
            "name": "LoopA",
            "extends": "LoopB",
            "properties": [{"name": "a", "datatype": "string"}],
        },
        {
            "name": "LoopB",
            "extends": "LoopA",
            "properties": [{"name": "b", "datatype": "string"}],
        },
        {"name": "Selfish", "extends": "Selfish"},
        # a repeated name: the first declaration wins every lookup
        {"name": "Keyless", "properties": [{"name": "ignored", "datatype": "string"}]},
    ],
    "relationships": [
        {
            "name": "Holds",
            "containment": True,
            "abstract": True,
            "properties": [{"name": "since", "datatype": "date"}],
        },
        {
            "name": "Owns",
            "extends": "Holds",
            "source": "Base",
            "target": "Mid",
            "source_multiplicity": "0..1",
            "target_multiplicity": "0..*",
        },
        {
            "name": "Links",
            "mappings": [
                {"source": "Leaf", "target": "Keyless"},
                {"source": "Keyless", "target": "Leaf"},
            ],
            "source_multiplicity": "1..*",
            "target_multiplicity": "2",
            "properties": [{"name": "weight", "datatype": "float"}],
        },
        {"name": "Loose", "source": "Base", "target": "Base"},
        {
            "name": "Broken",
            "source": "Mid",
            "target": "Mid",
            "source_multiplicity": "many",
            "target_multiplicity": "1..1",
        },
        {"name": "Unmapped", "source_multiplicity": "1", "target_multiplicity": "1"},
        {"name": "RelLoop", "extends": "RelLoop", "source": "LoopA", "target": "LoopB"},
        # a repeated name still contributes its own mappings and constraints
        {
            "name": "Loose",
            "source": "Keyless",
            "target": "Keyless",
            "target_multiplicity": "0..3",
        },
    ],
}

_MULTIPLICITIES = [
    "1", "0..1", "0..*", "*", "1..*", " 2 .. 5 ", "+1", "1_0", "1..1_000", "-1", "-0", "00",
    "3..1", "* ", " * ", "1 ..*", "0.. *", "", "a", "1..", "..1", "1..2..3", "1.5",
    "0x1", "1__0", "_1", "1_", "many", "'",
]  # fmt: skip


def _props(props: list[Any]) -> list[list[str]]:
    return [[p.name, p.datatype, p.multiplicity] for p in props]


def _multiplicity(spec: str) -> dict[str, Any]:
    try:
        parsed = Multiplicity.parse(spec)
    except ValueError as exc:
        return {"spec": spec, "error": exc.args[0]}
    return {
        "spec": spec,
        "lower": parsed.lower,
        "upper": parsed.upper,
        "is_single": parsed.is_single,
        "required": parsed.required,
        "count_ok": [parsed.count_ok(n) for n in range(4)],
    }


@scenario("metamodel_caches")
def metamodel_caches() -> Any:
    mm = Metamodel.model_validate(_METAMODEL)
    element_names = [t.name for t in mm.elements] + ["Missing"]
    relationship_names = [t.name for t in mm.relationships] + ["Missing"]

    def element(name: str) -> dict[str, Any]:
        found = mm.element_type(name)
        spec = mm.effective_element_key_spec(name)
        return {
            "name": name,
            "is_element_type": mm.is_element_type(name),
            "own_properties": None if found is None else _props(found.properties),
            "ancestors": mm.element_ancestors(name),
            "properties": _props(mm.effective_element_properties(name)),
            "property_names": sorted(mm.effective_element_property_names(name)),
            "key": mm.effective_element_key(name),
            "key_spec": None
            if spec is None
            else {
                "properties": list(spec.properties),
                "relationships": [
                    [r.rel_type, r.direction] for r in spec.relationships
                ],
            },
            "end_constraints": [
                [c.rel_type_name, c.end, c.multiplicity.lower, c.multiplicity.upper]
                for c in mm.end_constraints(name)
            ],
            "descendants": sorted(mm.element_descendants(name)),
            "from": mm.relationship_types_from(name),
            "to": mm.relationship_types_to(name),
            "supertypes": [s for s in element_names if mm.is_element_subtype(name, s)],
        }

    def relationship(name: str) -> dict[str, Any]:
        found = mm.relationship_type(name)
        return {
            "name": name,
            "own_mappings": None
            if found is None
            else [[m.source, m.target] for m in found.mappings],
            "ancestors": mm.relationship_ancestors(name),
            "properties": _props(mm.effective_relationship_properties(name)),
            "property_names": sorted(mm.effective_relationship_property_names(name)),
            "containment": mm.is_containment(name),
            "descendants": sorted(mm.relationship_descendants(name)),
            "supertypes": [
                s for s in relationship_names if mm.is_relationship_subtype(name, s)
            ],
        }

    return {
        "metamodel": mm.model_dump(mode="json"),
        "elements": [element(name) for name in element_names],
        "relationships": [relationship(name) for name in relationship_names],
        "multiplicities": [_multiplicity(spec) for spec in _MULTIPLICITIES],
    }
