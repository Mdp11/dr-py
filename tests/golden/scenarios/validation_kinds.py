"""The six built-in validators: one violation of every message they write,
the values whose rendering is easy to get wrong, dates as
``date.fromisoformat`` reads them, types the metamodel lacks, scoped runs in
orders unlike state order, and the uniqueness groups as batches move them."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, run_steps, validate_step

_METAMODEL = {
    "enums": {"Color": ["red", "green"]},
    "elements": [
        {
            "name": "Base",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "Blk",
            "extends": "Base",
            "properties": [
                {"name": "s", "datatype": "string"},
                # int bounds: the validator renders them as the floats they are
                {"name": "n", "datatype": "integer", "min": 0, "max": 5},
                {"name": "f", "datatype": "float", "min": -1.5, "max": 2},
                {"name": "b", "datatype": "boolean"},
                {"name": "d", "datatype": "date", "multiplicity": "0..*"},
                {"name": "c", "datatype": "Color", "multiplicity": "0..*"},
                {
                    "name": "code",
                    "datatype": "string",
                    "pattern": "[A-Z]+",
                    "max_length": 3,
                },
                {"name": "label", "datatype": "string", "max_length": 3},
                {"name": "ref", "datatype": "Blk"},
                {"name": "refs", "datatype": "Base", "multiplicity": "0..*"},
            ],
        },
        {"name": "Sub", "extends": "Blk"},
        {"name": "Other", "extends": "Base"},
        {"name": "Kid", "extends": "Base"},
        {
            "name": "M",
            "extends": "Base",
            "properties": [
                {"name": "req", "datatype": "string", "multiplicity": "1"},
                {
                    "name": "many",
                    "datatype": "integer",
                    "multiplicity": "1..*",
                    "max": 10,
                },
                {"name": "opt", "datatype": "string", "multiplicity": "0..1"},
                {"name": "two", "datatype": "string", "multiplicity": "0..2"},
            ],
        },
        {"name": "Car", "extends": "Base"},
        {"name": "Wheel", "extends": "Base"},
        {
            "name": "K",
            "extends": "Base",
            "properties": [
                {"name": "a", "datatype": "string", "multiplicity": "0..*"},
                {"name": "b", "datatype": "string"},
            ],
            "key": ["a", "b", "out:KL", "in:KL"],
        },
        {
            "name": "L",
            "extends": "Base",
            "properties": [{"name": "v", "datatype": "float"}],
        },
    ],
    "relationships": [
        {"name": "Owns", "containment": True, "source": "Base", "target": "Base"},
        {
            "name": "Link",
            "mappings": [
                {"source": "Blk", "target": "Other"},
                {"source": "Other", "target": "Sub"},
            ],
            "source_multiplicity": "0..1",
            "target_multiplicity": "0..2",
            "properties": [
                {"name": "lbl", "datatype": "string", "multiplicity": "1"},
                {"name": "w", "datatype": "float", "max": 2},
                {"name": "to", "datatype": "Blk"},
            ],
        },
        {
            "name": "Needs",
            "source": "Car",
            "target": "Wheel",
            "source_multiplicity": "0..1",
            "target_multiplicity": "1..*",
        },
        {"name": "KL", "source": "K", "target": "K"},
    ],
}

#: `date.fromisoformat` accepts these, the last three for the two bytes past
#: an eight-byte date that it never reads
_DATES_OK = [
    "2024-01-01", "20240101", "2024-W01", "2024-W01-1", "2024W011", "2024W01",
    "0001-01-01", "9999-12-31", "2020-W53-7", "2020-W53", "2024-02-29",
    "20240101xx", "20240101é", "2024W011xx",
]  # fmt: skip

#: and refuses these
_DATES_BAD = [
    "2024-001", "2024-1-1", "２０２４-01-01", "2024-01-01 ",
    "2024-02-30", "0000-01-01", "2024-01-01T00:00", "+2024-01-01", "2024-W53",
    "2024-W00-1", "2024-W01-8", "2024-01", "202401", "2024-0101", "2023-02-29",
    "2021-W53", "9999-W52-6", "2024-01-0é", "2024W01-1", "",
]  # fmt: skip


def _el(entity_id: str, type_name: str, **properties: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{entity_id}",
        "id": entity_id,
        "type_name": type_name,
        "properties": properties,
    }


def _rel(
    entity_id: str, type_name: str, source: str, target: str, **properties: Any
) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": f"tmp_{entity_id}",
        "id": entity_id,
        "type_name": type_name,
        "source_id": source,
        "target_id": target,
        "properties": properties,
    }


def _update(entity_id: str, **patch: Any) -> dict[str, Any]:
    return {"kind": "update_element", "id": entity_id, "properties_patch": patch}


def _delete(entity_id: str) -> dict[str, Any]:
    return {"kind": "delete_element", "id": entity_id}


def _delete_rel(rel_id: str) -> dict[str, Any]:
    return {"kind": "delete_relationship", "id": rel_id}


_ELEMENTS = [
    # conformance and facets
    _el(
        "b-ok", "Blk", name="ok", s="x", n=3, f=1.5, b=True, d=_DATES_OK,
        c=["red", "green"], code="AB", label="\U0001f600\U0001f600\U0001f600",
        ref="b-sub", refs=["b-ok", "o-1"],
    ),
    _el(
        "b-bad1", "Blk", name="bad1", s=5, n=1.0, f=True, b=1,
        c=["blue", "red", 1], code="abcd", label="héllo", ref="nope",
        refs=["o-1", 5, ["x"], None, "gone"],
    ),
    _el(
        "b-bad2", "Blk", name="bad2", s={"k": [1, 2.5, None, True]}, n=-3, f=2.5,
        b="true", d=_DATES_BAD, code="it's", label="\U0001f600" * 4, ref="o-1",
    ),
    _el(
        "b-big", "Blk", name="big", n=10**20, f=1e20, c="red", ref=5,
        code="ÉÉ", label=None,
    ),
    _el("b-sub", "Sub", name="sub", n=6, f=-2, code=["AB", "cd", "EFGH"]),
    _el("b-inf", "Blk", name="inf", n="3", f="Infinity", d="2024-02-29"),
    _el("b-ninf", "Blk", name="ninf", f="-Infinity", n=True, d=20240101),
    # a dict and a list on a float property: neither is a float
    _el("b-dict", "Blk", name="dict", f={"a": 1.5}),
    _el("b-nest", "Blk", name="nest", f=[[1], {"a": 1}, 0.5]),
    _el("o-1", "Other", name="o1"),
    _el("o-2", "Other", name="o2"),
    _el("kid-1", "Kid", name="kid1"),
    # property multiplicities
    _el("m-1", "M"),
    _el("m-2", "M", req=None, many=[3, 11, 12], opt=["a", "b"], two=["a", "b", "c"]),
    _el("m-3", "M", req="x", many=7, opt="o", two=["a", "b"]),
    # end multiplicities
    _el("car-1", "Car", name="car1"),
    _el("car-2", "Car", name="car2"),
    _el("car-3", "Car", name="car3"),
    _el("wheel-1", "Wheel", name="wheel1"),
    _el("wheel-2", "Wheel", name="wheel2"),
    # containment: two parents; a cycle with two elements hanging below it
    _el("p-1", "Other", name="p1"),
    _el("p-2", "Other", name="p2"),
    _el("x-1", "Kid", name="x1"),
    _el("c-1", "Kid", name="c1"),
    _el("c-2", "Kid", name="c2"),
    _el("c-3", "Kid", name="c3"),
    _el("h-1", "Kid", name="h1"),
    _el("h-2", "Kid", name="h2"),
    # keyless duplicates: 1 == 1.0 == True
    _el("u-1", "L", v=1),
    _el("u-2", "L", v=1.0),
    _el("u-3", "L", v=True),
    _el("u-4", "L", v=2),
    # keyed duplicates: list and dict values, out: and in: keys
    _el("k-1", "K", name="k1", a=["x"], b="it's"),
    _el("k-2", "K", name="k2", a=["x"], b="it's"),
    _el("k-3", "K", name="k3", a=[], b={"z": [1, 2], "y": 1}),
    _el("k-4", "K", name="k4", a=[], b={"y": 1, "z": [1, 2]}),
    _el("k-5", "K", name="k5"),
    _el("k-6", "K", name="k6"),
    _el("k-7", "K", name="k7", a=[1], b="n"),
    _el("k-8", "K", name="k8", a=[1.0], b="n"),
    _el("k-9", "K", name="k9"),
    _el("k-10", "K", name="k10"),
    _el("k-11", "K", name="k11", a=[True], b="n"),
]  # fmt: skip

_RELATIONSHIPS = [
    # endpoint typing: fine, the pair alone, the source, the target, both
    _rel("l-ok", "Link", "b-ok", "o-1", lbl="a"),
    _rel("l-pair", "Link", "b-ok", "b-sub", lbl="b", w=2.5),
    _rel("l-src", "Link", "kid-1", "o-1"),
    _rel("l-tgt", "Link", "o-2", "kid-1", lbl="d", to="nope"),
    _rel("l-both", "Link", "kid-1", "kid-1", lbl="e", to="o-1", w=[1, 3.5]),
    # b-ok has three targets and o-1 three sources
    _rel("l-3", "Link", "b-ok", "o-2", lbl="f", to="b-sub"),
    _rel("l-4", "Link", "b-bad1", "o-1", lbl=7),
    _rel("n-1", "Needs", "car-2", "wheel-1"),
    _rel("n-2", "Needs", "car-3", "wheel-1"),
    _rel("n-3", "Needs", "car-2", "wheel-2"),
    _rel("own-1", "Owns", "p-1", "x-1"),
    _rel("own-2", "Owns", "p-2", "x-1"),
    _rel("own-3", "Owns", "c-1", "c-2"),
    _rel("own-4", "Owns", "c-2", "c-3"),
    _rel("own-5", "Owns", "c-3", "c-1"),
    _rel("own-6", "Owns", "c-3", "h-1"),
    _rel("own-7", "Owns", "h-1", "h-2"),
    _rel("kl-1", "KL", "k-5", "k-9"),
    _rel("kl-2", "KL", "k-5", "k-10"),
    _rel("kl-3", "KL", "k-6", "k-10"),
    _rel("kl-4", "KL", "k-6", "k-9"),
]  # fmt: skip

_ALL_IDS = [op["id"] for op in _ELEMENTS + _RELATIONSHIPS] + [
    "g-1",
    "g-2",
    "z-1",
    "l-gad",
]


def _insert_element(
    entity_id: str, type_name: str, properties: dict[str, Any]
) -> dict[str, Any]:
    return {
        "do": "insert_element",
        "id": entity_id,
        "type": type_name,
        "_value": properties,
        "rev": 3,
    }


_STEPS: list[dict[str, Any]] = [
    batch(_ELEMENTS),
    batch(_RELATIONSHIPS),
    # types the metamodel lacks; the two Gad elements share every property
    _insert_element("g-1", "Gad", {"x": 1}),
    _insert_element("g-2", "Gad", {"x": 1.0}),
    {
        "do": "insert_relationship",
        "id": "z-1",
        "type": "Zap",
        "source": "b-ok",
        "target": "o-2",
        "_value": {"q": 1},
        "rev": 2,
    },
    batch([_rel("l-gad", "Link", "g-1", "o-2", lbl="g")]),
    validate_step("all_ids"),
    # unknown ids, an id twice, duplicates without their primaries
    validate_step(["u-3", "nope", "u-3", "k-2", "ghost", "z-1", "l-pair", "k-8"]),
    # below a cycle, then in it; a cycle member alone
    validate_step(["h-2", "c-2"]),
    validate_step(["c-3"]),
    validate_step(["x-1", "p-2", "p-1", "g-2", "l-gad", "k-10", "k-6"]),
    validate_step(sorted(_ALL_IDS, reverse=True)),
    # k-2 leaves k-1's group; b-bad1 mends two properties
    batch([_update("k-2", b="other"), _update("b-bad1", n=2, b=False)]),
    validate_step("all_ids"),
    # the primary goes: u-2 takes its place
    batch([_delete("u-1")]),
    validate_step(["u-3", "u-2", "u-1"]),
    # an owner moves u-3 out of its group; k-6 and k-9 lose an edge of their key
    batch([_rel("own-8", "Owns", "p-1", "u-3"), _delete_rel("kl-4")]),
    validate_step("all_ids"),
    # a new member after the others; the cycle goes, cascading below it
    batch(
        [
            _el("u-5", "L", v=2.0),
            _update("k-9", name="k9b"),
            _rel("kl-5", "KL", "k-6", "k-9"),
            _delete("c-1"),
        ]
    ),
    validate_step("all_ids"),
    validate_step(["c-1", "h-2", "u-5", "u-4", "k-9", "k-10", "k-6", "k-5"]),
]


@scenario("validation_kinds")
def validation_kinds() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
