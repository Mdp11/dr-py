"""``POST /model/search`` as the route answers it: every criterion type and op
over properties of every scalar kind, Python's ``str()`` / ``float()``
coercions, patterns, exact type names, relationship counts over self-loops and
parallel edges, OR groups, relationship queries and paging — before and after
churn, so state order is held too."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, read_step, run_steps

_METAMODEL = {
    "elements": [
        {
            "name": "Base",
            "abstract": True,
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "Name", "datatype": "string"},
                {"name": "NAME", "datatype": "string"},
                {"name": "v", "datatype": "string"},
                {"name": "t", "datatype": "string"},
                {"name": "big", "datatype": "integer"},
            ],
        },
        {"name": "Node", "extends": "Base"},
        {"name": "Leaf", "extends": "Node"},
        {"name": "Other", "extends": "Base"},
    ],
    "relationships": [
        {
            "name": "Links",
            "source": "Base",
            "target": "Base",
            "properties": [
                {"name": "label", "datatype": "string"},
                {"name": "name", "datatype": "string"},
                {"name": "Name", "datatype": "string"},
            ],
        },
        {"name": "SubLinks", "extends": "Links", "source": "Base", "target": "Base"},
        {"name": "Owns", "containment": True, "source": "Base", "target": "Base"},
    ],
}

_ESCAPED = 'it\'s "quoted"\\back\ttab'
_CONTAINER_SCALARS: list[Any] = [1, 2**64, 1.0, 1.5, True, False, None, _ESCAPED]
_LIST = list(_CONTAINER_SCALARS)
_DICT = {"k": "v", "n": list(_CONTAINER_SCALARS), "esc": _ESCAPED}

#: ``v`` of id-1 .. id-25: one value per row of the coercion fixture's table
_V_VALUES: list[Any] = [
    0, -5, 1, 2**53, 2**64, -(2**64),
    1.0, -1.0, 0.5, 1.5, -0.0, 1e16, 1e21, 1e23, 5e-324, 1e308, 1e-5,
    True, False, None,
    "", "plain", _ESCAPED, _LIST, _DICT,
]  # fmt: skip

#: ``v`` of id-26 .. id-38: texts ``float()`` reads, or refuses
_V_TEXTS = [
    "1_000", " 1.5 ", "inf", "-Infinity", "nan", "٣", "１２", "\xa01\xa0",
    "0x10", "1 000", "  ", "+1", ".5",
]  # fmt: skip

#: names and texts by element number, where they differ from the default
_NAMES: dict[int, Any] = {
    2: "İstanbul",
    3: "ΟΔΟΣ",
    4: "Kelvin \u212a",
    5: "Straße",
    6: ["listed"],
    7: "",
    8: "café \U0001f600",
    39: ["only", "listed"],
}
_EXTRA: dict[int, dict[str, Any]] = {
    6: {"Name": "Cased"},
    7: {"NAME": "Upper"},
    9: {"t": "xx"},
    10: {"t": "a\n"},
    11: {"t": "xxy"},
    12: {"t": "xxxy"},
    13: {"t": "x٣"},
    14: {"t": "abc"},
}

#: id-39 and id-40 hold no ``v``; id-40 holds an int ``float()`` cannot take
_ELEMENT_COUNT = 40
_LEAVES = {4, 8, 12, 16, 24, 28, 32, 36}
_OTHERS = {5, 10, 15, 20, 25, 30, 35, 40}


def _type(i: int) -> str:
    if i in _LEAVES:
        return "Leaf"
    if i in _OTHERS:
        return "Other"
    return "Node"


def _element(i: int) -> dict[str, Any]:
    properties: dict[str, Any] = {"name": _NAMES.get(i, f"row {i:02d}")}
    if i <= len(_V_VALUES):
        properties["v"] = _V_VALUES[i - 1]
    elif i <= len(_V_VALUES) + len(_V_TEXTS):
        properties["v"] = _V_TEXTS[i - 1 - len(_V_VALUES)]
    if i == _ELEMENT_COUNT:
        properties["big"] = 10**400
    properties.update(_EXTRA.get(i, {}))
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{i}",
        "type_name": _type(i),
        "properties": properties,
    }


def _rel(kind: str, source: int, target: int, **props: Any) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "type_name": kind,
        "source_id": f"id-{source}",
        "target_id": f"id-{target}",
        "properties": props,
    }


#: relationships id-41 .. id-100; id-36 .. id-40 are orphans
_EDGES = [
    *[_rel("Links", k, k + 1) for k in range(1, 30)],
    *[_rel("SubLinks", k, k + 2) for k in range(1, 20, 2)],
    *[_rel("Owns", 1, k) for k in range(2, 7)],
    _rel("Links", 7, 7, label="self", name="loop"),
    _rel("SubLinks", 8, 8, label="self"),
    _rel("Links", 9, 10, label="parallel", name="Parallel One"),
    _rel("Links", 9, 10, label="parallel", name="parallel two"),
    _rel("SubLinks", 9, 10, label="PARALLEL", name=["listed"], Name="Cased"),
    _rel("Links", 31, 1),
    _rel("Links", 32, 1),
    _rel("Links", 33, 34),
    _rel("Links", 34, 35),
    _rel("Links", 35, 33, label=1.0),
    *[_rel("Owns", 30, k) for k in (31, 32, 33)],
    *[_rel("Links", k, 5) for k in (20, 21, 22)],
]
_RELATIONSHIPS = [{**rel, "temp_id": f"tmp_r{i}"} for i, rel in enumerate(_EDGES)]
assert len(_RELATIONSHIPS) == 60


def _search(target: str, criteria: list[Any] | None, **page: Any) -> dict[str, Any]:
    if criteria is None:
        return read_step("searchModel", target=target, **page)
    return read_step("searchModel", target=target, criteria=criteria, **page)


def _el(*criteria: Any, **page: Any) -> dict[str, Any]:
    return _search("element", list(criteria), **page)


def _rl(*criteria: Any, **page: Any) -> dict[str, Any]:
    return _search("relationship", list(criteria), **page)


def _prop(op: str, value: str | None = None, name: str = "v") -> dict[str, Any]:
    criterion: dict[str, Any] = {"type": "property", "name": name, "op": op}
    if value is not None:
        criterion["value"] = value
    return criterion


def _name_id(field: str, op: str, value: str) -> dict[str, Any]:
    return {"type": "name_id", "field": field, "op": op, "value": value}


def _count(op: str, count: int, direction: str, **extra: Any) -> dict[str, Any]:
    return {
        "type": "relation_count",
        "op": op,
        "count": count,
        "direction": direction,
        **extra,
    }


def _types(kind: str, names: list[str], **extra: Any) -> dict[str, Any]:
    return {"type": kind, "names": names, **extra}


_ORPHAN = {"type": "orphan"}

_EQUALS = [
    "", "1", "1.0", "0", "-1", "true", "True", "false", "None", "plain",
    _ESCAPED, "18446744073709551616", "-18446744073709551616", "9007199254740992",
    "10000000000000000", "1000000000000000000000", "99999999999999991611392",
    "1e+21", "5e-324", "1e+308", "1e-05", "0.5", repr(_LIST), repr(_DICT),
]  # fmt: skip

_CONTAINS = ["", "TRUE", "Plain", "'K'", "none", "1.0", "\\"]
_NAME_CONTAINS = ["İ", "i̇stanbul", "ΟΔΟΣ", "οδος", "k", "STRASSE", "straße", "É"]

_OPERANDS = [
    "0", "1_000", " 1.5 ", "inf", "-Infinity", "nan", "٣", "１２", "\xa01\xa0",
    ".5", "5.", "+1", "0x10", "1__0", "1 000", "", "  ", "1e21", "9007199254740992",
    "-1e400",
]  # fmt: skip

#: `lt` needs fewer: `gt` covers the coercions
_LT_OPERANDS = ["0", " 1.5 ", "inf", "-Infinity", "nan", "٣", "", "1e21"]

#: a read whose every entity matches: `total` says so, the page shows the first
_FIRST = {"limit": 3}

_PATTERNS = [
    r"(?P<a>x)(?P=a)", r"\d", r"a$", r"x{,2}y", r"^x{,2}y", "[", r"^\d$",
    r"(?i)PLAIN", r"^$", r"\bback\b", r"é",
]  # fmt: skip


def _element_reads() -> list[dict[str, Any]]:
    return [
        _search("element", None),
        _el(**_FIRST),
        # exact type names: a subtype is not its parent
        _el(_types("entity_type", []), **_FIRST),
        *[
            _el(_types("entity_type", names))
            for names in (["Leaf"], ["Node"], ["Base"], ["Node", "Other"], ["x"])
        ],
        *[_el(_prop("equals", value)) for value in _EQUALS],
        _el(_prop("not_equals", "")),
        _el(_prop("not_equals", "1")),
        _el(_prop("equals")),  # the value defaults to ""
        _el(_prop("contains", ""), **_FIRST),
        *[_el(_prop("contains", value)) for value in _CONTAINS if value],
        *[_el(_prop("contains", value, name="name")) for value in _NAME_CONTAINS],
        *[_el(_prop("gt", operand)) for operand in _OPERANDS],
        *[_el(_prop("lt", operand)) for operand in _LT_OPERANDS],
        _el(_prop("gte", "1")),
        _el(_prop("lte", "0")),
        _el(_prop("gte", "")),
        _el(_prop("lte", "nan")),
        # a numeric op on a missing property never matches
        _el(_prop("gt", "-inf", name="missing")),
        # criteria are ANDed in order: the int float() refuses is never reached
        _el(_types("entity_type", ["Leaf"]), _prop("gt", "0", name="big")),
        _el(_prop("exists", name="big")),
        _el(_prop("equals", "1" + "0" * 400, name="big")),
        _el(_prop("exists")),
        _el(_prop("is_empty")),
        _el(_prop("exists", name="t")),
        _el(_prop("is_empty", name="t")),
        *[_el(_prop("matches", pattern)) for pattern in _PATTERNS],
        *[_el(_prop("matches", pattern, name="t")) for pattern in _PATTERNS],
        # names: strings only, `name` first, then other casings in order
        _el(_name_id("name", "equals", "")),
        _el(_name_id("name", "equals", "Cased")),
        _el(_name_id("name", "equals", "listed")),
        _el(_name_id("name", "equals", "Upper")),
        _el(_name_id("name", "contains", "ROW 1")),
        _el(_name_id("name", "contains", "İ")),
        _el(_name_id("name", "matches", r"^row \d5$")),
        _el(_name_id("name", "matches", r"(?i)^straSSE$")),
        _el(_name_id("name", "matches", "(")),
        _el(_name_id("id", "equals", "id-1")),
        _el(_name_id("id", "contains", "D-3")),
        _el(_name_id("id", "matches", r"^id-\d$")),
        # counts: a self-loop once, parallel edges each, exact type names
        *[
            _el(_count(op, n, d))
            for op, n, d in (
                ("at_least", 3, "either"),
                ("at_least", 2, "outgoing"),
                ("at_most", 0, "incoming"),
                ("exactly", 1, "either"),
                ("exactly", 3, "outgoing"),
                ("exactly", 2, "either"),
                ("at_most", 3, "either"),
                ("exactly", 5, "either"),
            )
        ],
        _el(_count("at_least", 1, "outgoing", relTypes=["Links"])),
        _el(_count("at_least", 1, "outgoing", rel_types=["SubLinks"])),
        _el(_count("exactly", 1, "incoming", relTypes=["Links", "Owns"])),
        # given both, the alias wins
        _el(_count("at_least", 1, "either", relTypes=["Owns"], rel_types=["Links"])),
        _el(_count("at_least", 0, "either", relTypes=[]), **_FIRST),
        _el(_ORPHAN),
        *[
            _el({"type": "connected_to_type", "direction": d, "names": names})
            for d, names in (
                ("outgoing", ["Leaf"]),
                ("incoming", ["Node"]),
                ("either", ["Other"]),
                ("either", []),
                ("either", ["Links"]),
            )
        ],
        # a relationship-only criterion on an element query matches
        _el(_types("endpoint_type", ["Leaf"], endpoint="source"), **_FIRST),
        # OR groups: empty, one member, several, a member that always matches
        _el({"type": "any_of"}, **_FIRST),
        _el({"type": "any_of", "criteria": []}, _types("entity_type", ["Leaf"])),
        _el({"type": "any_of", "criteria": [_types("entity_type", ["Leaf"])]}),
        _el(
            {
                "type": "any_of",
                "criteria": [
                    _ORPHAN,
                    _prop("equals", "true"),
                    _types("entity_type", ["Other"]),
                ],
            }
        ),
        _el(
            {"type": "any_of", "criteria": [_ORPHAN, _prop("matches", "[")]},
            _types("entity_type", ["Node"]),
        ),
        _el(
            {
                "type": "any_of",
                "criteria": [_types("endpoint_type", ["x"], endpoint="target")],
            },
            **_FIRST,
        ),
        _el(_types("entity_type", ["Node", "Leaf"]), _prop("exists"), _ORPHAN),
        _el(_types("entity_type", ["Leaf"], unknown="ignored"), unknown="ignored"),
        # pages: `total` before paging, the 500 default
        _el(_types("entity_type", ["Node"]), limit=1),
        _el(_types("entity_type", ["Node"]), limit=3, offset=2),
        _el(_types("entity_type", ["Node"]), offset=40),
        _el(limit=500, offset=39),
    ]


def _relationship_reads() -> list[dict[str, Any]]:
    return [
        _search("relationship", None),
        *[
            _rl(_types("entity_type", names))
            for names in (["SubLinks"], ["Links"], ["Owns", "SubLinks"])
        ],
        _rl(_prop("equals", "parallel", name="label")),
        _rl(_prop("contains", "PARALLEL", name="label")),
        _rl(_prop("equals", "1", name="label")),
        _rl(_prop("exists", name="label")),
        _rl(_name_id("name", "contains", "parallel")),
        _rl(_name_id("name", "equals", "Cased")),
        _rl(_name_id("id", "matches", r"^id-4\d$")),
        _rl(_types("endpoint_type", ["Leaf"], endpoint="source")),
        _rl(_types("endpoint_type", ["Node"], endpoint="target")),
        _rl(_types("endpoint_type", [], endpoint="target")),
        # element-only criteria on a relationship query match
        _rl(_ORPHAN, _count("at_least", 99, "either"), **_FIRST),
        _rl(
            {"type": "connected_to_type", "direction": "either", "names": ["x"]},
            **_FIRST,
        ),
        _rl(
            {
                "type": "any_of",
                "criteria": [
                    _types("endpoint_type", ["Other"], endpoint="target"),
                    _types("entity_type", ["Owns"]),
                ],
            }
        ),
        _rl({"type": "any_of", "criteria": [_ORPHAN]}, _types("entity_type", ["Owns"])),
        _rl(limit=1),
        _rl(limit=2, offset=58),
        _rl(offset=60),
    ]


def _churned_reads() -> list[dict[str, Any]]:
    """The same reads again after churn: state order, and what the edits moved."""
    return [
        _search("element", None),
        _el(_types("entity_type", ["Leaf"])),
        _el(_prop("equals", "")),
        _el(_prop("equals", "true")),
        _el(_prop("gt", "1_000")),
        _el(_count("at_least", 3, "either")),
        _el(_count("at_least", 1, "outgoing", rel_types=["SubLinks"])),
        _el(_ORPHAN),
        _el({"type": "connected_to_type", "direction": "outgoing", "names": ["Leaf"]}),
        _el(_types("entity_type", ["Node"]), limit=3, offset=2),
        _search("relationship", None),
        _rl(_types("entity_type", ["SubLinks"])),
        _rl(_prop("exists", name="label")),
        _rl(_types("endpoint_type", ["Leaf"], endpoint="source")),
        _rl(limit=2, offset=57),
    ]


_STEPS: list[dict[str, Any]] = [
    batch([_element(i) for i in range(1, _ELEMENT_COUNT + 1)]),
    batch(_RELATIONSHIPS),
    *_element_reads(),
    *_relationship_reads(),
    *_churned_reads(),
    # churn: a cascade, an id back at the end, edits, a new element and edge
    batch(
        [
            {"kind": "delete_element", "id": "id-3"},
            {"kind": "update_element", "id": "id-1", "properties_patch": {"v": "true"}},
            {"kind": "update_element", "id": "id-9", "properties_patch": {"v": None}},
            {"kind": "delete_relationship", "id": "id-88"},
            {
                "kind": "create_element",
                "temp_id": "tmp_new",
                "type_name": "Leaf",
                "properties": {"name": "row new", "v": 2.5},
            },
            {
                "kind": "create_relationship",
                "temp_id": "tmp_edge",
                "type_name": "SubLinks",
                "source_id": "tmp_new",
                "target_id": "id-36",
            },
        ]
    ),
    {"do": "restore_element", "id": "id-3", "type": "Node"},
    *_churned_reads(),
]


@scenario("search_criteria")
def search_criteria() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
