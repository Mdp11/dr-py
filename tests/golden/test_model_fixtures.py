"""The model core, the bulk loader, the metamodel caches and the structural
validators reproduce the frozen fixtures."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from data_rover.api.routes._snapshot import build_model_from_dicts
from data_rover.api.serialize import parse_model_json
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.metamodel.multiplicity import Multiplicity
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.indexes import _frozen
from tests.golden.reader import ROOT, load_fixture, observe, replay, tag, untag

_EXAMPLES = ROOT / "examples"


@pytest.mark.parametrize(
    "name",
    [
        "model_mutations",
        "model_cascades",
        "model_indexes",
        "model_churn",
        "validation_dirty",
        "validation_kinds",
    ],
)
def test_steps_match_the_fixture(name: str) -> None:
    pairs = replay(load_fixture(name))
    assert pairs
    for index, (recorded, replayed) in enumerate(pairs):
        assert replayed == recorded, f"{name} step {index}"


def _load(mm: Metamodel, elements: list[str], relationships: list[str]) -> Any:
    raw = {
        "elements": [parse_model_json(text) for text in elements],
        "relationships": [parse_model_json(text) for text in relationships],
    }
    return build_model_from_dicts(mm, raw, strict=False)


def test_bulk_loader_matches_the_fixture() -> None:
    doc = load_fixture("model_load")
    mm = Metamodel.model_validate(doc["metamodel"])
    accepted = doc["accepted"]
    seen = observe(_load(mm, accepted["elements"], accepted["relationships"]))
    assert seen == {
        key: accepted[key] for key in ("digest", "fingerprint", "state", "indexes")
    }
    assert doc["refused"]
    for case in doc["refused"]:
        with pytest.raises(HTTPException) as caught:
            _load(mm, case["elements"], case["relationships"])
        assert caught.value.detail == case["error"], case["name"]


def test_smart_city_loads_as_the_fixture_says() -> None:
    doc = load_fixture("smart_city")
    mm = load_metamodel_str(
        (_EXAMPLES / "smart-city.metamodel.yaml").read_text(encoding="utf-8")
    )
    assert mm.model_dump(mode="json") == doc["metamodel"]
    raw = parse_model_json((ROOT / doc["model_file"]).read_bytes())
    model = build_model_from_dicts(mm, raw, strict=False)
    seen = observe(model)
    assert len(model.elements) == doc["elements"]
    assert len(model.relationships) == doc["relationships"]
    for key in ("digest", "fingerprint", "indexes"):
        assert seen[key] == doc[key]


def test_json_parse_matches_the_fixture() -> None:
    cases = load_fixture("json_parse")
    assert cases
    for case in cases:
        assert tag(parse_model_json(case["text"])) == case["value"], case["text"]


def test_frozen_groups_match_the_fixture() -> None:
    doc = load_fixture("frozen_groups")
    groups: dict[Any, list[int]] = {}
    for index, node in enumerate(doc["values"]):
        groups.setdefault(_frozen(untag(node)), []).append(index)
    assert sorted(groups.values()) == doc["groups"]


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


def test_metamodel_caches_match_the_fixture() -> None:
    doc = load_fixture("metamodel_caches")
    mm = Metamodel.model_validate(doc["metamodel"])
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

    assert [element(n) for n in element_names] == doc["elements"]
    assert [relationship(n) for n in relationship_names] == doc["relationships"]
    assert [_multiplicity(m["spec"]) for m in doc["multiplicities"]] == (
        doc["multiplicities"]
    )
