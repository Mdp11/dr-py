"""``POST .../artifacts/navigation/evaluate`` as the route answers it, and the
navigation core underneath: every step kind over subtypes, parallel edges, a
self-loop and a cycle; scopes with and without types and criteria; every set
operation, nested, by ref and inline; row starts; refs missing, of another
kind, in a cycle and in a diamond; saved navigations; paging; the evaluator's
caps; and which definitions reach a script. ``nav_eval_scripted`` runs the
script steps those definitions reach, on the oracle's trusted runner."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, read_step, run_steps
from ..scripted import run_scripted

_METAMODEL = {
    "elements": [
        {
            "name": "Base",
            "abstract": True,
            "properties": [
                {"name": "name", "datatype": "string"},
                {"name": "s", "datatype": "string"},
                {"name": "i", "datatype": "integer"},
                {"name": "f", "datatype": "float"},
                {"name": "b", "datatype": "boolean"},
                {"name": "d", "datatype": "date"},
                {"name": "mixed", "datatype": "string", "multiplicity": "0..*"},
                {"name": "ref", "datatype": "Node"},
                {"name": "refs", "datatype": "Base", "multiplicity": "0..*"},
            ],
        },
        {"name": "Node", "extends": "Base"},
        {"name": "Part", "extends": "Node"},
        {"name": "Leaf", "extends": "Part"},
        {"name": "Other", "extends": "Base"},
    ],
    "relationships": [
        {"name": "Links", "source": "Base", "target": "Base"},
        {"name": "SubLinks", "extends": "Links", "source": "Base", "target": "Base"},
        {"name": "Owns", "containment": True, "source": "Base", "target": "Base"},
    ],
}

_ELEMENT_COUNT = 30


def _type(i: int) -> str:
    if i <= 10:
        return "Node"
    if i <= 18:
        return "Part"
    if i <= 24:
        return "Leaf"
    return "Other"


#: properties by element number, beside the name every element but id-30 has
_PROPS: dict[int, dict[str, Any]] = {
    1: {
        "s": "alpha",
        "i": 1,
        "f": 1.5,
        "b": True,
        "d": "2024-01-01",
        "mixed": [1.0, 1, True, "1"],
        "ref": "id-2",
        "refs": ["id-4", "id-3", "id-4", "ghost-ref"],
    },
    # a dangling single reference, and a list holding a dict and a list
    2: {
        "s": "beta",
        "f": 1.0,
        "i": 1,
        "mixed": "solo",
        "ref": "missing",
        "refs": [{"id": "id-5"}, "id-5", ["id-6"]],
    },
    # a reference back to id-1, a self-reference, values no chain can hold
    3: {
        "s": "gamma",
        "refs": ["id-1", "id-3"],
        "ref": "id-3",
        "mixed": [None, {"k": 1}, "x", 2.5, 2**64, False],
    },
    4: {"i": 1, "b": False, "mixed": []},
    # an element reference to an `Other`: not checked against the datatype
    5: {"s": "", "ref": "id-25"},
    11: {"s": "alpha", "refs": ["id-12", "id-13"]},
    12: {"s": "delta", "i": 7},
    13: {"s": "Alpha"},
    19: {"s": "alpha", "b": None},
    25: {"s": "omega", "refs": ["id-26"]},
    26: {"refs": "id-1"},
}


def _element(i: int) -> dict[str, Any]:
    properties: dict[str, Any] = {} if i == _ELEMENT_COUNT else {"name": f"e{i:02d}"}
    properties.update(_PROPS.get(i, {}))
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{i}",
        "type_name": _type(i),
        "properties": properties,
    }


def _rel(kind: str, source: int, target: int) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "type_name": kind,
        "source_id": f"id-{source}",
        "target_id": f"id-{target}",
        "properties": {},
    }


_EDGES = [
    # a chain id-1 -> ... -> id-10
    *[_rel("Links", k, k + 1) for k in range(1, 10)],
    # a cycle id-11 -> id-12 -> id-13 -> id-11
    _rel("Links", 11, 12),
    _rel("Links", 12, 13),
    _rel("Links", 13, 11),
    # self-loops
    _rel("Links", 14, 14),
    _rel("SubLinks", 15, 15),
    # parallel edges
    _rel("Links", 16, 17),
    _rel("Links", 16, 17),
    _rel("SubLinks", 16, 17),
    _rel("SubLinks", 1, 11),
    _rel("SubLinks", 2, 12),
    _rel("SubLinks", 3, 19),
    # containment; id-20 has a second parent, which does not own it
    _rel("Owns", 1, 20),
    _rel("Owns", 1, 21),
    _rel("Owns", 11, 22),
    _rel("Owns", 11, 23),
    _rel("Owns", 25, 24),
    _rel("Owns", 26, 20),
    _rel("Links", 19, 25),
    _rel("Links", 20, 26),
    _rel("Links", 21, 27),
    _rel("Links", 28, 1),
    _rel("Links", 29, 1),
]
_RELATIONSHIPS = [{**rel, "temp_id": f"tmp_r{i}"} for i, rel in enumerate(_EDGES)]


# -- definitions ---------------------------------------------------------------


def _scope(types: list[str] | None = None, *criteria: Any) -> dict[str, Any]:
    scope: dict[str, Any] = {"kind": "scope"}
    if types is not None:
        scope["types"] = types
    if criteria:
        scope["criteria"] = list(criteria)
    return scope


def _path(start: dict[str, Any], *steps: Any, **extra: Any) -> dict[str, Any]:
    return {"kind": "path", "start": start, "steps": list(steps), **extra}


def _set(op: str, *operands: Any) -> dict[str, Any]:
    return {"kind": "set_op", "op": op, "operands": list(operands)}


def _inline(
    definition: dict[str, Any], step_index: int | None = None
) -> dict[str, Any]:
    operand: dict[str, Any] = {"definition": definition}
    if step_index is not None:
        operand["step_index"] = step_index
    return operand


def _ref(artifact_id: str, step_index: int | None = None) -> dict[str, Any]:
    operand: dict[str, Any] = {"ref": artifact_id}
    if step_index is not None:
        operand["step_index"] = step_index
    return operand


def _hop(rel: str, direction: str | None = None, *targets: str) -> dict[str, Any]:
    step: dict[str, Any] = {"kind": "relationship", "relationship_type": rel}
    if direction is not None:
        step["direction"] = direction
    if targets:
        step["target_types"] = list(targets)
    return step


def _filter(*criteria: Any) -> dict[str, Any]:
    return {"kind": "filter", "criteria": list(criteria)}


def _prop_step(name: str) -> dict[str, Any]:
    return {"kind": "property", "property_name": name}


def _script(snippet: dict[str, Any], comment: str | None = None) -> dict[str, Any]:
    step: dict[str, Any] = {"kind": "script", "snippet": snippet}
    if comment is not None:
        step["comment"] = comment
    return step


def _prop(name: str, op: str, value: str | None = None) -> dict[str, Any]:
    criterion: dict[str, Any] = {"type": "property", "name": name, "op": op}
    if value is not None:
        criterion["value"] = value
    return criterion


_ROW = {"kind": "row"}
_NODES = _scope(["Node"])
_CODE = {"code": "def step(el):\n    return el\n"}

_N1 = _path(_scope(["Node"], _prop("s", "exists")), _hop("Links"))
_N2 = _set("union", _ref("n1", 1), _inline(_path(_scope(["Leaf"]))))
_N3 = _path(_scope(["Other"]), _script({"definition": _CODE}))

_ARTIFACTS = {
    "n1": {"kind": "navigation", "payload": _N1},
    "n2": {"kind": "navigation", "payload": _N2},
    "n3": {"kind": "navigation", "payload": _N3},
    "t1": {"kind": "table", "payload": {"schema_version": 1, "columns": []}},
    "s1": {"kind": "code_snippet", "payload": _CODE},
}

#: the same ids later: n2 and n3 now name each other
_CYCLIC = {
    **_ARTIFACTS,
    "n2": {"kind": "navigation", "payload": _set("union", _ref("n3"))},
    "n3": {"kind": "navigation", "payload": _set("intersection", _ref("n2", 0))},
}


def _artifacts(artifacts: dict[str, Any]) -> dict[str, Any]:
    return {"do": "artifacts", "_artifacts": artifacts}


def _nav(definition: dict[str, Any], **params: Any) -> dict[str, Any]:
    return read_step("evaluateNavigation", definition=definition, **params)


def _saved(artifact_id: str, **params: Any) -> dict[str, Any]:
    return read_step("evaluateNavigation", artifact_id=artifact_id, **params)


def _navigate(
    definition: dict[str, Any],
    *,
    max_visited: int = 100_000,
    max_chains: int = 5_000,
    row_elements: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "do": "navigate",
        "definition": definition,
        "limits": {"max_visited": max_visited, "max_chains": max_chains},
        "row_elements": row_elements,
    }


def _has_script(definition: dict[str, Any]) -> dict[str, Any]:
    return {"do": "has_script", "definition": definition}


# -- cases ---------------------------------------------------------------------


def _step_kinds() -> list[dict[str, Any]]:
    return [
        _nav(_path(_NODES, _hop("Links"))),
        _nav(_path(_NODES, _hop("Links", "in"))),
        # a self-loop counts once; parallel edges give one continuation
        _nav(_path(_scope(["Part"]), _hop("Links", "either"))),
        _nav(_path(_scope(["Part"]), _hop("SubLinks", "either"))),
        _nav(_path(_scope(["Part"]), _hop("Owns", "out"))),
        # target types, subtype-inclusive
        *[
            _nav(_path(_scope(), _hop("Links", "out", *targets)))
            for targets in (["Leaf"], ["Part"], ["Other"], ["Part", "Other"], ["x"])
        ],
        _nav(_path(_scope(), _hop("Base"))),
        # filters add no column and gate on the property's presence
        _nav(_path(_NODES, _hop("Links"), _filter(_prop("s", "equals", "beta")))),
        _nav(_path(_scope(), _filter(_prop("s", "not_equals", "x")))),
        _nav(_path(_scope(), _filter(_prop("s", "is_empty")))),
        _nav(_path(_scope(), _filter(_prop("b", "exists")))),
        _nav(_path(_scope(["Part"]), _filter())),
        # property hops: single, list, inherited, dangling, a dict in a list
        *[
            _nav(_path(_scope(), _prop_step(name)))
            for name in ("ref", "refs", "mixed", "s", "i", "f", "b", "d", "x")
        ],
        _nav(_path(_scope(), _prop_step("refs"), _prop_step("refs"))),
        _nav(
            _path(
                _scope(), _prop_step("refs"), _prop_step("ref"), exclude_visited=False
            )
        ),
        # past a value, nothing
        _nav(_path(_scope(), _prop_step("mixed"), _hop("Links"))),
        _nav(_path(_scope(), _prop_step("s"), _filter())),
        # an unconfigured script step prunes; its label is its comment
        _nav(_path(_NODES, _script({}))),
        _nav(_path(_NODES, _script({}, "label"), _hop("Links"))),
        _nav(_path(_NODES, _script({"ref": None, "definition": None}, ""))),
        _nav(_path(_NODES, _hop("Links"), _prop_step("refs"), _hop("Links", "either"))),
    ]


def _cycles() -> list[dict[str, Any]]:
    around = [_hop("Links"), _hop("Links"), _hop("Links")]
    start = _scope(["Part"], _prop("s", "exists"))
    return [
        _nav(_path(start, *around)),
        _nav(_path(start, *around, exclude_visited=True)),
        _nav(_path(start, *around, exclude_visited=False)),
        _nav(_path(_scope(["Part"]), _hop("Links", "either"), exclude_visited=False)),
        _nav(
            _path(
                _scope(["Part"]),
                _hop("Links", "either"),
                _hop("Links", "either"),
                exclude_visited=False,
            )
        ),
    ]


def _scopes() -> list[dict[str, Any]]:
    return [
        _nav(_path(_scope())),
        _nav(_path(_scope([]))),
        *[
            _nav(_path(_scope(types)))
            for types in (["Base"], ["Part"], ["Leaf", "Node"], ["Other"], ["x"])
        ],
        _nav(_path(_scope(None, _prop("s", "not_equals", "zeta")))),
        _nav(_path(_scope(None, _prop("s", "contains", "ALPHA")))),
        _nav(_path(_scope(["Part"], _prop("s", "equals", "alpha")))),
        _nav(_path(_scope(["Part"], _prop("s", "exists")))),
        _nav(_path(_scope(None, _prop("i", "gte", "1")))),
        _nav(_path(_scope(None, _prop("s", "matches", r"^[ab]")))),
        _nav(
            _path(
                _scope(
                    None,
                    {
                        "type": "name_id",
                        "field": "name",
                        "op": "matches",
                        "value": r"^e1\d$",
                    },
                )
            )
        ),
        _nav(_path(_scope(None, {"type": "entity_type", "names": ["Part"]}))),
        _nav(_path(_scope(None, {"type": "orphan"}))),
        # an empty group matches; a group's members are gated one by one
        _nav(_path(_scope(["Other"], {"type": "any_of", "criteria": []}))),
        _nav(_path(_scope(["Other"], {"type": "any_of"}))),
        _nav(
            _path(
                _scope(
                    None,
                    {
                        "type": "any_of",
                        "criteria": [
                            _prop("missing", "not_equals", "x"),
                            _prop("s", "equals", "omega"),
                        ],
                    },
                )
            )
        ),
        _nav(
            _path(
                _scope(
                    ["Node"],
                    {
                        "type": "relation_count",
                        "op": "at_least",
                        "count": 2,
                        "direction": "either",
                        "relTypes": ["Links", "SubLinks"],
                    },
                )
            )
        ),
    ]


def _sets() -> list[dict[str, Any]]:
    leaf = _inline(_path(_scope(["Leaf"])))
    linked = _inline(_path(_NODES, _hop("Links")), 1)
    starts = _inline(_path(_NODES, _hop("Links")), 0)
    ends = _inline(_path(_NODES, _hop("Links")))
    return [
        *[
            _nav(_set(op, starts, ends, leaf))
            for op in ("union", "intersection", "difference", "symmetric_difference")
        ],
        _nav(_set("difference", starts, linked)),
        _nav(_set("intersection", linked, _ref("n1", 1))),
        _nav(_set("union", _ref("n1"))),
        _nav(_set("union", _ref("n1", 0))),
        # nested, with a set operand at step 0 and with none
        _nav(
            _set(
                "difference",
                _inline(_set("union", starts, leaf), 0),
                _inline(_set("union", ends)),
            )
        ),
        _nav(
            _set(
                "symmetric_difference",
                _inline(_set("intersection", starts, ends)),
                leaf,
            )
        ),
        # out of range
        _nav(_set("union", _inline(_set("union", starts), 1))),
        _nav(_set("union", _inline(_path(_NODES, _hop("Links")), 2))),
        _nav(_set("union", leaf, _inline(_path(_NODES, _hop("Links")), 5))),
        _nav(_set("union", _inline(_path(_NODES), 0))),
        _nav(_set("union", _inline(_path(_NODES), 1))),
        # a value at the projected step contributes nothing
        _nav(_set("union", _inline(_path(_scope(), _prop_step("mixed"))))),
        _nav(_set("union", _inline(_path(_scope(), _prop_step("refs"))))),
        # a set as a path's start
        _nav(_path(_set("union", linked, leaf), _hop("Links", "either"))),
        _nav(_path(_set("intersection", starts, _ref("n2")), _prop_step("refs"))),
        _nav(_path(_set("difference", _ref("n2"), linked))),
    ]


def _rows() -> list[dict[str, Any]]:
    kinds = [
        [],
        [_hop("Links")],
        [_hop("Links", "either")],
        [_filter()],
        [_filter(_prop("s", "exists"))],
        [_prop_step("refs")],
        [_script({})],
        [_hop("Links"), _filter()],
    ]
    return [
        *[_nav(_path(_ROW, *steps), row_element_id="id-1") for steps in kinds],
        *[_nav(_path(_ROW, *steps)) for steps in kinds[:3]],
        *[_nav(_path(_ROW, *steps), row_element_id="ghost") for steps in kinds],
        _nav(_path(_ROW, _hop("Links")), row_element_id="id-30"),
        # a row bound inside a set operand, and unbound there
        _nav(
            _set(
                "union",
                _inline(_path(_ROW, _hop("Links"))),
                _inline(_path(_scope(["Leaf"]))),
            ),
            row_element_id="id-2",
        ),
        _nav(_set("union", _inline(_path(_ROW, _hop("Links"))))),
        _nav(
            _path(_set("union", _inline(_path(_ROW))), _hop("Links")),
            row_element_id="id-2",
        ),
        _nav(_set("union", _inline(_path(_ROW, _filter()))), row_element_id="ghost"),
    ]


def _refs() -> list[dict[str, Any]]:
    return [
        _nav(_set("union", _ref("nope"))),
        _nav(_set("union", _ref("t1"))),
        _nav(_set("union", _ref("s1"))),
        _nav(_path(_set("union", _ref("n1"), _ref("nope")))),
        # a diamond: n1 directly and through n2
        _nav(_set("union", _ref("n1", 1), _ref("n2"))),
        _nav(_path(_set("intersection", _ref("n2"), _ref("n1", 0)), _hop("Owns"))),
        _saved("n1"),
        _saved("n2"),
        _saved("n2", limit=3, offset=2),
        _saved("nope"),
        _saved("t1"),
        _saved("s1"),
    ]


def _cyclic_refs() -> list[dict[str, Any]]:
    return [
        _saved("n2"),
        _saved("n3"),
        _nav(_set("union", _ref("n3"))),
        _nav(_path(_set("union", _ref("n1"), _ref("n2")))),
        _saved("n1"),
    ]


def _pages() -> list[dict[str, Any]]:
    everything = _path(_scope())
    return [
        _nav(everything, limit=1),
        _nav(everything, limit=3, offset=2),
        _nav(everything, offset=29),
        _nav(everything, offset=30),
        _nav(everything, limit=500, offset=1000),
        _nav(_path(_scope(), _prop_step("mixed")), limit=2, offset=1),
    ]


def _navigations() -> list[dict[str, Any]]:
    around = _path(_scope(["Part"]), _hop("Links", "either"), _hop("Links", "either"))
    return [
        _navigate(_path(_scope(), _prop_step("mixed"))),
        _navigate(_path(_scope(), _prop_step("refs"), _prop_step("mixed"))),
        # the chain cap: stops when one more chain would pass it
        *[_navigate(around, max_chains=n) for n in (0, 1, 3, 4)],
        _navigate(around, max_chains=3, max_visited=0),
        # the edge budget: every edge examined counts, a self-loop once
        *[_navigate(around, max_visited=n) for n in (0, 1, 2, 5, 12, 40)],
        *[
            _navigate(
                _path(_ROW, _hop(rel, direction), exclude_visited=False),
                max_visited=budget,
                row_elements=[row],
            )
            for row, budget in (("id-14", 1), ("id-15", 1), ("id-16", 3), ("id-16", 2))
            for rel, direction in (
                ("Links", "either"),
                ("Links", "in"),
                ("SubLinks", "out"),
            )
        ],
        _navigate(_path(_scope(), _prop_step("refs")), max_visited=3),
        _navigate(_path(_scope(), _prop_step("refs")), max_visited=9),
        # a start set that truncates marks the path truncated
        _navigate(_path(_set("union", _inline(around)), _hop("Links")), max_chains=2),
        _navigate(_path(_set("union", _inline(around))), max_chains=2),
        _navigate(_path(_set("union", _inline(around)), _script({})), max_chains=2),
        _navigate(_path(_set("union", _inline(around)), _filter()), max_chains=2),
        # every operand has its own budget; truncation still shows
        _navigate(_set("union", _inline(around), _inline(around, 1)), max_visited=5),
        _navigate(_set("union", _inline(around, 0), _inline(around, 1)), max_chains=1),
        _navigate(
            _path(_ROW, _hop("Links", "either")), row_elements=["id-2", "id-1", "id-2"]
        ),
        _navigate(_path(_ROW, _prop_step("refs")), row_elements=[]),
        _navigate(_path(_ROW, _filter()), row_elements=["ghost"]),
        _navigate(_path(_ROW)),
        _navigate(_set("union", _ref("n2"), _ref("n1", 0))),
        # a script step prunes: nothing runs it here
        _navigate(_path(_NODES, _script({"definition": _CODE}))),
        _navigate(_set("union", _ref("n3", 0), _ref("n3"))),
    ]


def _scripts() -> list[dict[str, Any]]:
    return [
        _has_script(_path(_NODES)),
        _has_script(_path(_NODES, _script({}))),
        _has_script(_path(_NODES, _script({"ref": None}))),
        _has_script(_path(_NODES, _script({"definition": _CODE}))),
        _has_script(_path(_NODES, _script({"ref": "s1"}))),
        _has_script(_path(_NODES, _script({"ref": "gone"}))),
        _has_script(_set("union", _inline(_path(_NODES, _script({"ref": "s1"}))))),
        _has_script(
            _path(_set("union", _inline(_path(_NODES, _script({"definition": _CODE})))))
        ),
        # only through a saved navigation
        _has_script(_set("union", _ref("n3"))),
        _has_script(_path(_set("union", _ref("n1"), _ref("n3", 0)), _hop("Links"))),
        _has_script(_set("union", _ref("n2"))),
    ]


_STEPS: list[dict[str, Any]] = [
    batch([_element(i) for i in range(1, _ELEMENT_COUNT + 1)]),
    batch(_RELATIONSHIPS),
    _artifacts(_ARTIFACTS),
    *_step_kinds(),
    *_cycles(),
    *_scopes(),
    *_sets(),
    *_rows(),
    *_refs(),
    *_pages(),
    *_navigations(),
    *_scripts(),
    _artifacts(_CYCLIC),
    *_cyclic_refs(),
]


@scenario("nav_eval")
def nav_eval() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)


# -- script steps -----------------------------------------------------------------


def _step_code(body: str) -> dict[str, Any]:
    return {"definition": {"code": f"def step(el):\n{body}\n"}}


_DEST = 'r.destination().id for r in el.outgoing(stereotype="Links")'
_HOP_SCRIPT = _step_code(f"    return [{_DEST}]")
_HOP_EITHER = _step_code(
    f"    return [{_DEST}] + "
    '[r.source().id for r in el.incoming(stereotype="Links")]'
)
#: ids and a value together: a chain ends at the value, the rest hop on
_HOP_AND_NAME = _step_code(f'    return [{_DEST}] + [el["name"]]')
#: duplicates across (type, value), a wide int, a signed zero, a name no element has
_TERMINALS = _step_code(
    '    return [el["name"], "alpha", 1, True, 1.0, "1", 1, 1.0, "alpha", 2**70, 2**70, 0.0, -0.0, None]'
)
_NON_FINITE = _step_code(
    '    return [float("nan"), float("inf"), "inf", float("-inf"), float("inf"), "nan"]'
)
_ONE_VALUE = _step_code('    return el["name"]')
_NOTHING = _step_code("    return None")
_CHILDREN = _step_code("    return el.children()")
_SELF = _step_code("    return el.id")
_BOOM = _step_code('    raise ValueError("boom")')
#: one failure kind per element: more kinds than the channel holds
_BOOM_EACH = _step_code('    raise ValueError("boom " + el.id)')
_BOOM_THIRDS = _step_code(
    '    if int(el.id.split("-")[1]) % 3 == 0:\n'
    "        raise KeyError(el.id)\n"
    f"    return [{_DEST}]"
)
_BAD_RETURN = _step_code('    return {"a": 1}')
_SYNTAX = {"definition": {"code": "def step(el:\n    return 1\n"}}
_NO_STEP = {"definition": {"code": "x = 1\n"}}
_BOOT_RAISE = {"definition": {"code": 'raise RuntimeError("boot failed")\n'}}

_SCRIPT_ARTIFACTS = {
    **_ARTIFACTS,
    "hop": {"kind": "code_snippet", "payload": _HOP_SCRIPT["definition"]},
    "nav_hop": {
        "kind": "navigation",
        "payload": _path(_scope(["Part"]), _script({"ref": "hop"}), _hop("Links")),
    },
}


def _run(definition: dict[str, Any], **params: Any) -> dict[str, Any]:
    return read_step("evaluateNavigation", scripted=True, definition=definition, **params)


def _run_saved(artifact_id: str, **params: Any) -> dict[str, Any]:
    return read_step("evaluateNavigation", scripted=True, artifact_id=artifact_id, **params)


def _hops() -> list[dict[str, Any]]:
    part = _scope(["Part"], _prop("s", "exists"))
    return [
        _run(_path(_NODES, _script(_HOP_SCRIPT))),
        _run(_path(_NODES, _script(_HOP_SCRIPT, "next"))),
        _run(_path(_NODES, _script(_HOP_EITHER))),
        _run(_path(_NODES, _script(_CHILDREN))),
        _run(_path(_NODES, _script(_SELF))),
        _run(_path(_NODES, _script(_SELF)), limit=3, offset=2),
        _run(_path(_NODES, _script(_SELF), exclude_visited=False)),
        _run(_path(_NODES, _script(_NOTHING))),
        # two script steps, and a script step among the others
        _run(_path(_NODES, _script(_HOP_SCRIPT), _script(_HOP_SCRIPT))),
        _run(_path(_NODES, _script(_HOP_SCRIPT), _script(_CHILDREN), _script(_HOP_SCRIPT))),
        _run(_path(_NODES, _hop("Links"), _script(_HOP_SCRIPT))),
        _run(_path(_NODES, _script(_HOP_SCRIPT), _hop("Links"))),
        _run(_path(_NODES, _script(_HOP_SCRIPT), _filter(_prop("s", "exists")))),
        _run(_path(_NODES, _script(_HOP_SCRIPT), _filter(_prop("s", "exists")), _hop("Links"))),
        _run(_path(_NODES, _script(_HOP_SCRIPT), _prop_step("refs"))),
        _run(_path(_NODES, _prop_step("refs"), _script(_HOP_SCRIPT))),
        _run(_path(_NODES, _script(_HOP_SCRIPT, "a"), _script(_HOP_SCRIPT, "b")), limit=2),
        # a cycle walked with and without the guard
        _run(_path(part, _script(_HOP_SCRIPT), _script(_HOP_SCRIPT), _script(_HOP_SCRIPT))),
        _run(
            _path(
                part,
                _script(_HOP_SCRIPT),
                _script(_HOP_SCRIPT),
                _script(_HOP_SCRIPT),
                exclude_visited=False,
            )
        ),
    ]


def _terminals() -> list[dict[str, Any]]:
    return [
        _run(_path(_scope(["Leaf"]), _script(_TERMINALS))),
        _run(_path(_scope(["Leaf"]), _script(_NON_FINITE))),
        _run(_path(_scope(["Leaf"]), _script(_ONE_VALUE))),
        _run(_path(_scope(["Part"]), _script(_HOP_AND_NAME))),
        # a value ends its chain: whatever follows prunes
        _run(_path(_scope(["Leaf"]), _script(_TERMINALS), _hop("Links"))),
        _run(_path(_scope(["Part"]), _script(_HOP_AND_NAME), _script(_HOP_SCRIPT))),
        _run(_path(_scope(["Leaf"]), _script(_ONE_VALUE), _filter())),
    ]


def _failures() -> list[dict[str, Any]]:
    return [
        _run(_path(_NODES, _script(_BOOM))),
        _run(_path(_NODES, _script(_BOOM_EACH))),
        _run(_path(_scope(["Leaf"]), _script(_BOOM_EACH))),
        _run(_path(_NODES, _script(_BOOM_THIRDS))),
        _run(_path(_NODES, _script(_BOOM_THIRDS), _script(_BOOM))),
        _run(_path(_NODES, _script(_BAD_RETURN))),
        _run(_path(_scope(["Leaf"]), _script(_SYNTAX))),
        _run(_path(_scope(["Leaf"]), _script(_NO_STEP))),
        _run(_path(_scope(["Leaf"]), _script(_BOOT_RAISE))),
        # the failing step prunes; another still runs
        _run(_path(_scope(["Leaf"]), _script(_BOOM), _script(_HOP_SCRIPT))),
    ]


def _snippet_refs() -> list[dict[str, Any]]:
    return [
        _run(_path(_NODES, _script({"ref": "hop"}))),
        _run(_path(_NODES, _script({"ref": "s1"}))),
        _run(_path(_NODES, _script({"ref": "s1"}), exclude_visited=False)),
        _run(_path(_NODES, _script({"ref": "hop"}), _script({"definition": _HOP_SCRIPT["definition"]}))),
        # a ref that names nothing, or no snippet
        _run(_path(_NODES, _script({"ref": "gone"}))),
        _run(_path(_NODES, _script({"ref": "n1"}))),
        _run(_path(_NODES, _script({"ref": "t1"}))),
        _run(_path(_scope(["Leaf"]), _script({"ref": "gone"}), _script({"ref": "hop"}))),
        _run(_path(_scope(["Leaf"]), _script({"ref": "gone"}, "missing"))),
        # unconfigured: nothing runs, nothing is said
        _run(_path(_NODES, _script({}))),
        _run(_path(_NODES, _script({}), _script({"ref": "hop"}))),
    ]


def _script_sets() -> list[dict[str, Any]]:
    scripted = _path(_NODES, _script(_HOP_SCRIPT))
    plain = _path(_NODES, _hop("Links"))
    return [
        _run(_set("union", _inline(scripted), _inline(_path(_scope(["Leaf"]))))),
        _run(_set("union", _inline(scripted, 0), _inline(scripted, 1))),
        _run(_set("difference", _inline(plain, 1), _inline(scripted, 1))),
        _run(_set("intersection", _inline(plain, 1), _inline(scripted, 1))),
        _run(_set("symmetric_difference", _inline(plain, 1), _inline(scripted))),
        # a value at the projected step contributes nothing
        _run(_set("union", _inline(_path(_NODES, _script(_TERMINALS)), 1))),
        _run(_set("union", _inline(_path(_NODES, _script(_HOP_AND_NAME)), 1))),
        _run(_set("union", _inline(_path(_NODES, _script(_BOOM)), 1))),
        _run(_set("union", _inline(_set("union", _inline(scripted, 1)), 0), _inline(plain))),
        # a set that starts a path with a script step in it
        _run(_path(_set("union", _inline(scripted, 1)), _script(_HOP_SCRIPT))),
        _run(_path(_set("union", _inline(scripted, 1), _inline(plain, 1)), _hop("Links"))),
        _run(_path(_set("union", _inline(_path(_NODES, _script({"ref": "gone"})))), _hop("Links"))),
        # by ref
        _run(_set("union", _ref("n3"), _inline(scripted))),
        _run(_set("union", _ref("nav_hop", 1))),
        _run_saved("n3"),
        _run_saved("nav_hop"),
        _run_saved("nav_hop", limit=2, offset=1),
    ]


def _script_rows() -> list[dict[str, Any]]:
    return [
        _run(_path(_ROW, _script(_HOP_SCRIPT)), row_element_id="id-1"),
        _run(_path(_ROW, _script(_HOP_SCRIPT), _script(_HOP_SCRIPT)), row_element_id="id-1"),
        _run(_path(_ROW, _script(_TERMINALS)), row_element_id="id-2"),
        _run(_path(_ROW, _hop("Links"), _script(_HOP_SCRIPT)), row_element_id="id-1"),
        _run(_path(_ROW, _script(_HOP_SCRIPT)), row_element_id="id-30"),
        _run(_path(_ROW, _script(_HOP_SCRIPT)), row_element_id="ghost"),
        _run(_path(_ROW, _script(_HOP_SCRIPT))),
        _run(
            _set(
                "union",
                _inline(_path(_ROW, _script(_HOP_SCRIPT))),
                _inline(_path(_scope(["Leaf"]))),
            ),
            row_element_id="id-2",
        ),
    ]


_SCRIPTED_STEPS: list[dict[str, Any]] = [
    batch([_element(i) for i in range(1, _ELEMENT_COUNT + 1)]),
    batch(_RELATIONSHIPS),
    _artifacts(_SCRIPT_ARTIFACTS),
    *_hops(),
    *_terminals(),
    *_failures(),
    *_snippet_refs(),
    *_script_sets(),
    *_script_rows(),
    # the elements move under a script step's feet
    {"do": "connect", "type": "Links", "source": "id-24", "target": "id-1"},
    _run(_path(_scope(["Leaf"]), _script(_HOP_SCRIPT), _script(_HOP_SCRIPT))),
    {"do": "delete_element", "id": "id-2"},
    _run(_path(_scope(["Node"]), _script(_HOP_SCRIPT))),
    _run(_path(_NODES, _hop("Links"))),
]


@scenario("nav_eval_scripted")
def nav_eval_scripted() -> Any:
    metamodel = Metamodel.model_validate(_METAMODEL)
    return {
        "metamodel": metamodel.model_dump(mode="json"),
        "steps": run_scripted(metamodel, _SCRIPTED_STEPS),
    }
