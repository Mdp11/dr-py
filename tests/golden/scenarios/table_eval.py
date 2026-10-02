"""A table page as ``POST /tables/evaluate`` answers it, over ``table_rows``'
model, two more gadgets holding exact values (``2**60``, ``-0.0``, ``1e16``,
``2**64``, quotes, non-ASCII, nested lists, dicts) and one holding a property
its type does not declare: pages at their edges; every column kind in both
modes, over one element and over many; element-typed
properties, dangling references and ``_Stereotype``; navigation cells at the
cell cap (1, 20 and 21; 2, 20, 21 reached, and more); a build cut at the
route's 50,000 rows with expand columns after the cut; sorts over value labels;
the route's refusals; saved tables. ``cell_text`` records a page as an export
renders it, a page of a capped build included, and one cell joining ``None``, a
dict, nested lists, ``1e16`` and ``2**64``. ``table_eval_scripted`` runs the
script columns and script steps those tables reach, on the oracle's trusted
runner."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, read_step, run_steps
from ..scripted import run_scripted
from .table_rows import (
    _BLOCKS_SCOPE,
    _ELEMENTS,
    _LINKED,
    _METAMODEL,
    _RELATIONSHIPS,
    _ROW,
    _ROW_EITHER,
    _ROW_LINK_TAGS,
    _ROW_LINKS,
    _ROW_PARTS,
    _ROW_TAGS,
    _TWO_HOPS,
    _asc,
    _chains,
    _column,
    _create,
    _desc,
    _el,
    _exists,
    _inline,
    _nav,
    _nav_rows,
    _path,
    _prop,
    _ref,
    _row,
    _scope,
    _scope_rows,
    _script,
    _script_step,
    _step,
    _table,
)

#: after the 26 elements and 22 relationships of ``table_rows``
_GADGETS = batch(
    [
        _create(
            27,
            "Gadget",
            {
                "name": 'Quote "q" — it\'s ünï',
                "s": "say \"hi\" \\ 'there' ✓ 日本",
                "i": 2**60,
                "f": -0.0,
                "b": False,
                "tags": ['"quoted"', "it's", "ünï"],
                "mixed": [[1, [2, [3]]], {"a": {"b": [1, 2.5]}, "z": None}, None],
                "owner": 'He said "x"',
            },
        ),
        _create(
            28,
            "Gadget",
            {
                "name": "big",
                "i": -(2**63),
                "f": 1e16,
                "d": "2025-12-31",
                "tags": [1e16, 2**64, "x", 2**60],
                "mixed": {"k": [1, 1.0, True]},
            },
        ),
    ]
)

#: committed state holding a property its type does not declare, which no op may set
_STRAY = {
    "do": "insert_element",
    "id": "stray",
    "type": "Gadget",
    "_value": {"undeclared": "stray", "tags": ["s"]},
    "rev": 1,
}


def _saved_table(navigation: str) -> dict[str, Any]:
    return _table(
        _scope_rows(["Block"]),
        _column("element", None, header="Block", width_px=160),
        _column("property", None, name="s", header="S"),
        _column("navigation", None, navigation={"ref": navigation}, header="Links"),
        sort=[_desc(0)],
    )


_ARTIFACTS = {
    "n1": {"kind": "navigation", "payload": _LINKED},
    "nr": {"kind": "navigation", "payload": _ROW_LINKS},
    "ne": {"kind": "navigation", "payload": _ROW_EITHER},
    "t1": {"kind": "table", "payload": _saved_table("nr")},
    "t1e": {"kind": "table", "payload": _saved_table("ne")},
    "t2": {"kind": "table", "payload": _saved_table("nope")},
}

_ALL = _scope_rows()
_BLOCKS = _scope_rows(["Block"])
_THINGS = _scope_rows(["Block", "Gadget"])
_GADGET_ROWS = _scope_rows(["Gadget"])

_PROPERTIES = (
    "name",
    "s",
    "i",
    "f",
    "b",
    "d",
    "tags",
    "mixed",
    "owner",
    "parts",
    "undeclared",
    "_Stereotype",
)

#: 20 elements with a name, 22 in all (``id-12`` and ``stray`` have none)
_REACH_20 = _path(_scope(["Person", "Gadget", "Leaf"], _exists("name")))
_REACH_21 = _path(
    _scope(
        ["Person", "Gadget", "Leaf"],
        {"type": "name_id", "field": "id", "op": "contains", "value": "id-"},
    )
)
_REACH_22 = _path(_scope(["Person", "Gadget", "Leaf"]))
#: the two people with an ``s``
_REACH_2 = _path(_scope(["Person"], _exists("s")))
_ALL_TAGS = _path(_scope(), _step("tags"))
_EVERYTHING = _path(_scope())


def _eval(definition: dict[str, Any], **params: Any) -> dict[str, Any]:
    return read_step("evaluateTable", definition=definition, **params)


def _saved(artifact_id: str, **params: Any) -> dict[str, Any]:
    return read_step("evaluateTable", artifact_id=artifact_id, **params)


def _texts(
    definition: dict[str, Any], max_rows: int | None = None, **page: int
) -> dict[str, Any]:
    step: dict[str, Any] = {"do": "cell_text", "definition": definition, **page}
    if max_rows is not None:
        step["limits"] = {"max_rows": max_rows, "max_cell_elements": 20}
    return step


def _capped(navigation: dict[str, Any], cell_cap: int | None) -> dict[str, Any]:
    return _column(
        "navigation", None, navigation=_inline(navigation), cell_cap=cell_cap
    )


# -- tables ----------------------------------------------------------------------

_WIDE = _table(
    _ALL,
    _column("element", None, header="Element", width_px=200),
    _prop("s"),
    _prop("_Stereotype"),
)
_EVERY_PROPERTY = _table(_ALL, _el(), *[_prop(name) for name in _PROPERTIES])
_MANY_OWNERS = _table(
    _BLOCKS,
    _nav(_inline(_ROW_EITHER)),
    *[_prop(name, source=_ref(0)) for name in ("s", "tags", "owner", "parts")],
    _prop("_Stereotype", source=_ref(0)),
    _prop("undeclared", source=_ref(0)),
)
_NAVIGATIONS = _table(
    _BLOCKS,
    _el(),
    _nav(_inline(_ROW_LINKS)),
    _nav(_inline(_ROW_EITHER)),
    _nav(_inline(_ROW_TAGS)),
    _nav(_inline(_ROW_LINK_TAGS)),
    _nav(_inline(_ROW_LINK_TAGS), step_index=1),
    _nav(_inline(_ROW_PARTS)),
    _nav(_inline(_TWO_HOPS)),
    _nav({}),
    # element-typed on blocks, a string on gadgets: element names among values
    _nav(_inline(_path(_scope(["Block", "Gadget"]), _step("owner")))),
)
_CAPS = _table(
    _scope_rows(["Leaf"]),
    _el(),
    _capped(_REACH_20, 20),
    _capped(_REACH_20, None),
    _capped(_REACH_22, 20),
    _capped(_REACH_22, 21),
    _capped(_REACH_22, 1),
    _capped(_ALL_TAGS, None),
    _capped(_ALL_TAGS, 1),
    _capped(_ALL_TAGS, 21),
)
_CHAINS = _table(
    _chains(_inline(_TWO_HOPS)),
    _el(),
    _el(_row(1)),
    _prop("name", source=_row(2)),
    _nav(_inline(_ROW_TAGS), "expand", source=_row(2)),
)
#: 29 rows, x29, x29, then x29 cut at 50,000; the tags and the later columns still run
_CUT = _table(
    _ALL,
    _nav(_inline(_EVERYTHING), "expand"),
    _nav(_inline(_EVERYTHING), "expand"),
    _nav(_inline(_EVERYTHING), "expand"),
    _prop("tags", "expand", source=_row()),
    _el(_ref(2)),
    _prop("name", source=_ref(1)),
    _prop("tags", source=_ref(0)),
)
_SMALL_CUT = _table(
    _BLOCKS,
    _prop("tags", "expand"),
    _nav(_inline(_ROW_EITHER), "expand"),
    _el(_ref(1)),
    _prop("name", source=_ref(1)),
    _prop("tags", "expand", source=_ref(1)),
)


# -- cases -----------------------------------------------------------------------


def _pages() -> list[dict[str, Any]]:
    return [
        _eval(_WIDE),
        _eval(_WIDE, limit=1),
        _eval(_WIDE, offset=10, limit=5),
        _eval(_WIDE, offset=28),
        _eval(_WIDE, offset=29),
        _eval(_WIDE, offset=1000, limit=500),
        _eval(_WIDE, offset=20, limit=500),
    ]


def _properties() -> list[dict[str, Any]]:
    return [
        _eval(_EVERY_PROPERTY),
        _eval(_MANY_OWNERS),
        *[
            _eval(_table(_THINGS, _el(), _prop(name, "expand")))
            for name in (
                "s",
                "tags",
                "mixed",
                "owner",
                "parts",
                "_Stereotype",
                "undeclared",
            )
        ],
        _eval(_table(_THINGS, _el(), _prop("tags", "expand", False))),
        _eval(
            _table(
                _BLOCKS,
                _nav(_inline(_ROW_EITHER)),
                _prop("tags", "expand", False, _ref(0)),
                _prop("owner", "expand", source=_ref(0)),
            )
        ),
        _eval(
            _table(
                _BLOCKS,
                _nav(_inline(_ROW_LINKS), "expand", False),
                _prop("s", source=_ref(0)),
                _prop("parts", "expand", source=_ref(0)),
            )
        ),
    ]


def _navigations() -> list[dict[str, Any]]:
    return [
        _eval(_NAVIGATIONS),
        _eval(_CAPS),
        _eval(
            _table(
                _BLOCKS,
                _el(),
                _nav(_inline(_ROW_LINKS), "expand"),
                _nav(_inline(_ROW_TAGS), "expand"),
            )
        ),
        _eval(
            _table(
                _BLOCKS,
                _nav(_inline(_ROW_LINK_TAGS), "expand", False),
                _nav(_inline(_ROW_TAGS), source=_ref(0, 1)),
                _nav(_inline(_ROW_LINKS), "expand", source=_ref(0, 0)),
            )
        ),
        _eval(_table(_BLOCKS, _nav({}, "expand"), _nav(_inline(_ROW_PARTS), "expand"))),
        _eval(_CHAINS),
        _eval(
            _table(_chains(_inline(_path(_BLOCKS_SCOPE, _step("tags")))), _el(_row(1)))
        ),
        _eval(_table(_nav_rows({"ref": "n1"}), _el(), _prop("tags"))),
        _eval(
            _table(_BLOCKS, _el(), _script({}), _script({}, "expand", source=_row()))
        ),
    ]


def _sorts() -> list[dict[str, Any]]:
    return [
        *[
            _eval(
                _table(
                    _THINGS,
                    _el(),
                    _prop("tags"),
                    _nav(_inline(_ROW_TAGS), sort_mode="value"),
                    sort=[key(2)],
                )
            )
            for key in (_asc, _desc)
        ],
        # value labels are Python's str(): 1e+16, 18446744073709551616, True, 1.0
        *[
            _eval(
                _table(
                    _GADGET_ROWS,
                    _el(),
                    _nav(_inline(_ROW_TAGS), "expand"),
                    sort=[key(1)],
                )
            )
            for key in (_asc, _desc)
        ],
        *[
            _eval(
                _table(_THINGS, _el(), _prop("tags", "expand"), sort=[key(1), _asc(0)])
            )
            for key in (_asc, _desc)
        ],
        _eval(_table(_ALL, _el(), _prop("_Stereotype"), sort=[_desc(1), _asc(0)])),
        _eval(_table(_ALL, _el(), _prop("i"), _prop("f"), sort=[_asc(1)]), limit=10),
    ]


def _cuts() -> list[dict[str, Any]]:
    return [
        _eval(_CUT, limit=3),
        _eval(_CUT, offset=49_997, limit=5),
        _texts(_CUT, offset=49_998),
        *[_texts(_SMALL_CUT, max_rows) for max_rows in (6, 9, 10)],
    ]


def _texts_of_pages() -> list[dict[str, Any]]:
    return [
        _texts(_EVERY_PROPERTY),
        _texts(_MANY_OWNERS),
        _texts(_NAVIGATIONS),
        _texts(_CAPS),
        _texts(_CHAINS),
        _texts(_table(_THINGS, _el(), _prop("mixed", "expand")), offset=3, limit=8),
        _texts(_table(_GADGET_ROWS, _nav(_inline(_ROW_TAGS), "expand"), _el())),
        _texts(_table(_BLOCKS, _el(), _script({}), _script({}, "expand"))),
        # a value its type does not declare: shown by an expand column, not written
        _texts(
            _table(_GADGET_ROWS, _prop("undeclared"), _prop("undeclared", "expand"))
        ),
    ]


def _refusals() -> list[dict[str, Any]]:
    everything = _table(_ALL, _el())
    nested = {"kind": "set_op", "op": "union", "operands": [{"ref": "nope"}]}
    return [
        # the request body, refused before the route runs
        read_step("evaluateTable"),
        read_step("evaluateTable", definition=everything, artifact_id="t1"),
        read_step("evaluateTable", definition=None, artifact_id=None),
        _eval(everything, limit=0),
        _eval(everything, limit=501),
        _eval(everything, offset=-1),
        _eval(_table(_ALL)),
        _eval(_table(_ALL, _el(_ref(1)), _el())),
        # the route's own
        _eval(_table(_BLOCKS, _nav({"ref": "nope"}))),
        _eval(_table(_nav_rows({"ref": "nope"}), _el())),
        _eval(_table(_BLOCKS, _nav(_inline(nested)))),
        _eval(_table(_BLOCKS, _nav(_inline(_ROW_LINKS), step_index=5))),
        _eval(_table(_nav_rows(_inline(_TWO_HOPS), 3), _el())),
        _eval(_table(_chains(_inline(_LINKED)), _el(_row(5)))),
        _eval(_table(_nav_rows(_inline(_ROW_LINKS)), _el())),
        _saved("gone"),
        _saved("n1"),
        _saved("t2"),
    ]


def _saved_tables() -> list[dict[str, Any]]:
    return [
        _saved("t1"),
        _saved("t1e"),
        _saved("t1", offset=2, limit=3),
    ]


_CAP_EDGES = _table(
    _scope_rows(["Leaf"]), _el(), _capped(_REACH_21, None), _capped(_REACH_2, 1)
)
#: every gadget's ``mixed`` joined in one cell, after ``id-50``'s is set below
_ALL_MIXED = _table(
    _scope_rows(["Leaf"]),
    _nav(_inline(_path(_scope(["Gadget"])))),
    _prop("mixed", source=_ref(0)),
)


def _edges() -> list[dict[str, Any]]:
    return [
        _eval(_CAP_EDGES, limit=1),
        _texts(_CAP_EDGES, limit=1),
        batch(
            [
                {
                    "kind": "update_element",
                    "id": "id-50",
                    "properties_patch": {
                        "mixed": [None, {"k": [1]}, [1, [2, [3]]], 1e16, 2**64]
                    },
                }
            ]
        ),
        _eval(_ALL_MIXED, limit=1),
        _texts(_ALL_MIXED, limit=1),
    ]


_STEPS: list[dict[str, Any]] = [
    batch(_ELEMENTS),
    batch(_RELATIONSHIPS),
    _GADGETS,
    _STRAY,
    {"do": "artifacts", "_artifacts": _ARTIFACTS},
    *_pages(),
    *_properties(),
    *_navigations(),
    *_sorts(),
    *_cuts(),
    *_texts_of_pages(),
    *_refusals(),
    *_saved_tables(),
    *_edges(),
]


@scenario("table_eval")
def table_eval() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)


# -- script columns ---------------------------------------------------------------


def _code(args: str, body: str) -> str:
    lines = "".join(f"    {line}\n" for line in body.splitlines())
    return f"def value({args}):\n{lines}"


def _value(body: str) -> dict[str, Any]:
    return {"definition": {"code": _code("els", body)}}


def _valued(body: str) -> dict[str, Any]:
    return {"definition": {"code": _code("els, inputs", body)}}


def _step_def(body: str) -> dict[str, Any]:
    lines = "".join(f"    {line}\n" for line in body.splitlines())
    return {"definition": {"code": f"def step(el):\n{lines}"}}


def _in(name: str, index: int, step_index: int | None = None) -> dict[str, Any]:
    return {"name": name, "ref": _ref(index, step_index)}


def _run(definition: dict[str, Any], **params: Any) -> dict[str, Any]:
    return read_step("evaluateTable", scripted=True, definition=definition, **params)


def _run_saved(artifact_id: str, **params: Any) -> dict[str, Any]:
    return read_step("evaluateTable", scripted=True, artifact_id=artifact_id, **params)


def _preview(definition: dict[str, Any]) -> dict[str, Any]:
    return read_step("previewTableJson", scripted=True, definition=definition)


_NAME = _value("return els[0].name")
_NAMES = _value("return [e.name for e in els]")
_RANGE = _value("return list(range(25))")
_OR_NONE = _value('return els[0].get("s")')
_MIXED = _value('return [1, 1.0, True, "1", None, 2**70, -0.0, 1e16, "ünï"]')
_BIG = _value("return 2**70")
_TAGS = _value('return els[0].get("tags") or []')
_TAG_COUNT = _value('return len(els[0].get("tags") or [])')
_FIRST_LINK = _value(
    'out = els[0].outgoing(stereotype="Links")\nreturn out[0].destination() if out else None'
)
_ALL_LINKS = _value(
    'return [r.destination() for r in els[0].outgoing(stereotype="Links")] * 2'
)
_LINK_OR_NOTHING = _value(
    'out = els[0].outgoing(stereotype="Links")\nreturn out[0].destination() if out else []'
)
_EVERYTHING = _value("return list(dr.elements())")
#: the same elements in an order that moves with the row, so that sorting them matters
_PAIRS = _value(
    'if int(els[0].id.split("-")[1]) % 2 == 0:\n'
    '    return [dr.element("id-16"), dr.element("id-13")]\n'
    'return [dr.element("id-13"), dr.element("id-15")]'
)
_NONES = _value("return [None, None]")
_HALF_NONES = _value(
    'return [None, None] if int(els[0].id.split("-")[1]) % 2 else [None, "x", None]'
)
_NULLY = _value(
    'name = str(els[0].name)\n'
    'return [None, name] if int(els[0].id.split("-")[1]) % 2 else [name, None]'
)
_GHOST = _value(
    'return type(els[0])({"id": "ghost", "type": "Block", "name": None, "properties": {}})'
)
_GHOSTS = _value(
    "return [type(els[0])({\"id\": \"ghost\", \"type\": \"Block\", \"name\": None, \"properties\": {}}), els[0]]"
)
_BOOM = _value('raise ValueError("boom " + els[0].id)')
_BOOM_THIRDS = _value(
    'if int(els[0].id.split("-")[1]) % 3 == 0:\n    raise KeyError(els[0].id)\nreturn els[0].name'
)
_SYNTAX = {"definition": {"code": "def value(els:\n    return 1\n"}}
_NO_VALUE = {"definition": {"code": "x = 1\n"}}
_BAD_RETURN = _value('return {"a": 1}')
_KINDS = _value(
    'n = int(els[0].id.split("-")[1])\nreturn els[0].name if n % 3 == 0 else (n if n % 3 == 1 else els[0])'
)
_SHOW_INPUTS = _valued(
    'return "|".join(k + "=" + str([getattr(x, "id", x) for x in inputs[k]]) for k in inputs)'
)
_JOIN = _valued('return "<" + ",".join(str(x) for x in inputs["a"]) + ">"')
_WIDTH = _valued('return len(inputs["b"][0])')

_THINGS_ROWS = _scope_rows(["Block", "Gadget"])
_BLOCK_ROWS = _scope_rows(["Block"])
_ROW_OWNER = _path(_ROW, _step("owner"))

#: owners are elements on blocks and a mix of elements and text on gadgets
_MIXED_OWNER = _nav(_inline(_ROW_OWNER))
#: a hop that fails for some elements, and a step that is not defined
_HOP = _step_def(
    'return [r.destination().id for r in el.outgoing(stereotype="Links")]'
)
_HOP_OR_BOOM = _step_def(
    'if int(el.id.split("-")[1]) % 4 == 0:\n    raise ValueError("no hop " + el.id)\n'
    'return [r.destination().id for r in el.outgoing(stereotype="Links")]'
)


def _values() -> list[dict[str, Any]]:
    scalars = _table(
        _BLOCK_ROWS,
        _el(),
        _script(_NAME),
        _script(_RANGE),
        _script(_OR_NONE),
        _script(_MIXED),
        _script(_BIG),
        _script(_TAGS),
        _script(_TAG_COUNT),
    )
    elements = _table(
        _BLOCK_ROWS,
        _el(),
        _nav(_inline(_ROW_LINKS)),
        _script(_FIRST_LINK),
        _script(_ALL_LINKS),
        _script(_LINK_OR_NOTHING),
        _script(_GHOST),
        _script(_GHOSTS),
        _script(_EVERYTHING),
        _script(_NAMES, source=_ref(1)),
        _script(_NAME, source=_ref(1)),
        _script(_FIRST_LINK, source=_ref(1)),
    )
    failures = _table(
        _BLOCK_ROWS,
        _el(),
        _script(_BOOM),
        _script(_BOOM_THIRDS),
        _script(_SYNTAX),
        _script(_NO_VALUE),
        _script(_BAD_RETURN),
    )
    return [
        _run(scalars),
        _run(scalars, offset=3, limit=4),
        _run(elements),
        _run(failures),
        _run(failures, offset=8, limit=2),
        # over people, one of whom has no name
        _run(_table(_scope_rows(["Person"]), _el(), _script(_NAME), _script(_OR_NONE))),
        # unconfigured, and no source elements
        _run(_table(_BLOCK_ROWS, _el(), _script({}), _script(_NAME, source=_ref(1)))),
        _run(_table(_scope_rows(["Leaf"]), _nav({}), _script(_NAME, source=_ref(0)))),
    ]


def _inputs() -> list[dict[str, Any]]:
    collapse = _table(
        _THINGS_ROWS,
        _el(),
        _prop("s"),
        _prop("tags"),
        _nav(_inline(_ROW_LINKS)),
        _nav(_inline(_ROW_TAGS)),
        _MIXED_OWNER,
        _nav(_inline(_ROW_LINK_TAGS), step_index=1),
        _script(_NAME),
        _script(_NAMES, source=_ref(3)),
        _script(_FIRST_LINK),
        _script(_ALL_LINKS),
        _script(
            _SHOW_INPUTS,
            inputs=[_in(f"c{k}", k) for k in range(11)]
            + [_in("step0", 3, 0), _in("step1", 3, 1)],
        ),
        # the same inputs, named and ordered another way
        _script(_SHOW_INPUTS, inputs=[_in("z", 8), _in("y", 1), _in("x", 0)]),
        # a column that is a source and an input at once
        _script(_SHOW_INPUTS, source=_ref(3), inputs=[_in("n", 3), _in("only", 8)]),
    )
    expand = _table(
        _BLOCK_ROWS,
        _el(),
        _prop("tags", "expand"),
        _nav(_inline(_ROW_LINKS), "expand"),
        _nav(_inline(_ROW_TAGS), "expand", False),
        _prop("owner", "expand"),
        _script(_NAME, "expand"),
        _script(_FIRST_LINK, "expand", False),
        _script(_BOOM_THIRDS, "expand"),
        _script(_SHOW_INPUTS, inputs=[_in(f"e{k}", k) for k in range(1, 8)]),
    )
    failing = _table(
        _BLOCK_ROWS,
        _el(),
        _script(_BOOM_THIRDS),
        _script(_SHOW_INPUTS, inputs=[_in("x", 1)]),
        _script(_SHOW_INPUTS, inputs=[_in("x", 1), _in("y", 0)]),
        _script(_BOOM_THIRDS, "expand"),
        _script(_SHOW_INPUTS, inputs=[_in("x", 4)]),
        _script(_SYNTAX),
        _script(_SHOW_INPUTS, inputs=[_in("x", 6)]),
    )
    one_arg = _value("return len(els)")
    two_args = _valued("return len(inputs)")
    # a snippet by ref is held to its arity when it runs
    by_ref = _table(
        _BLOCK_ROWS,
        _el(),
        _script({"ref": "one_arg"}, inputs=[_in("x", 0)]),
        _script({"ref": "one_arg"}, inputs=[_in("x", 0), _in("y", 0)]),
        _script({"ref": "two_args"}),
        _script({"ref": "two_args"}, inputs=[_in("x", 0)]),
        _script({"ref": "one_arg"}),
        _script({"ref": "two_args"}, "expand", False),
    )
    # inline code is held to it before anything runs, and these are not mismatches
    runs = _table(
        _BLOCK_ROWS,
        _el(),
        _script({"definition": {"code": "def value(*els):\n    return len(els)\n"}}),
        _script(
            {"definition": {"code": "def value(a, b, c):\n    return 3\n"}},
            inputs=[_in("x", 0)],
        ),
        _script({"definition": {"code": "def other(els):\n    return 1\n"}}),
        _script(
            {"definition": {"code": "def value(els, inputs=None):\n    return 1\n"}},
            inputs=[_in("x", 0)],
        ),
    )
    mismatch = [
        _run(by_ref),
        _run(runs),
        _run(_table(_BLOCK_ROWS, _el(), _script(one_arg, inputs=[_in("x", 0)]))),
        _run(_table(_BLOCK_ROWS, _el(), _script(one_arg, inputs=[_in("x", 0), _in("y", 0)]))),
        _run(_table(_BLOCK_ROWS, _el(), _script(two_args))),
        _run(_table(_BLOCK_ROWS, _el(), _script(two_args, inputs=[_in("x", 0)]))),
    ]
    chain = _table(
        _BLOCK_ROWS,
        _el(),
        _script(_NAME),
        _script(_JOIN, inputs=[_in("a", 1)]),
        _script(_WIDTH, inputs=[_in("b", 2)]),
        _script(_JOIN, inputs=[_in("a", 3)]),
    )
    return [
        _run(collapse),
        _run(collapse, offset=2, limit=3),
        _run(expand, limit=40),
        _run(expand, offset=30, limit=40),
        _run(failing),
        *mismatch,
        _run(chain),
    ]


def _expand_and_keep() -> list[dict[str, Any]]:
    sourced = _table(
        _BLOCK_ROWS,
        _el(),
        _script(_ALL_LINKS, "expand"),
        _el(_ref(1)),
        _prop("name", source=_ref(1)),
        _script(_TAGS, "expand", False),
        _script(_NAME, source=_ref(1)),
    )
    errors = _table(
        _BLOCK_ROWS,
        _el(),
        _script(_BOOM_THIRDS, "expand", False),
        _script(_BOOM_THIRDS, "expand", True),
        _script(_NAME, source=_ref(1)),
    )
    return [
        _run(_table(_BLOCK_ROWS, _el(), _script(_TAGS, "expand"))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_TAGS, "expand", False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_LINK_OR_NOTHING, "expand"))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_MIXED, "expand"))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_GHOSTS, "expand"))),
        _run(sourced),
        _run(errors),
        # one value, none, or an error: how many rows each keeps
        _run(_table(_BLOCK_ROWS, _el(), _script(_OR_NONE, "expand", False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_OR_NONE, "expand", True))),
        # keep_empty over collapse columns: empty, none and errors
        _run(_table(_BLOCK_ROWS, _el(), _script(_OR_NONE, keep_empty=False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_TAGS, keep_empty=False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_BOOM_THIRDS, keep_empty=False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_LINK_OR_NOTHING, keep_empty=False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_GHOST, keep_empty=False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_GHOSTS, keep_empty=False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_ALL_LINKS, keep_empty=False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_NONES, keep_empty=False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_HALF_NONES, keep_empty=False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_HALF_NONES, "expand", False))),
        _run(_table(_BLOCK_ROWS, _el(), _script(_PAIRS, "expand"))),
        _run(
            _table(
                _BLOCK_ROWS,
                _el(),
                _script(_OR_NONE, keep_empty=False),
                _script(_TAGS, keep_empty=False),
                _script(_BOOM_THIRDS, keep_empty=False),
            )
        ),
        # a script column keeping nothing leaves no rows, and a nav column feeds it
        _run(_table(_BLOCK_ROWS, _el(), _script(_value_none(), keep_empty=False))),
        _run(
            _table(
                _BLOCK_ROWS,
                _nav(_inline(_ROW_LINKS), "expand", False),
                _script(_NAMES, keep_empty=False, source=_ref(0)),
            )
        ),
    ]


def _value_none() -> dict[str, Any]:
    return _value("return None")


def _sorts_of_scripts() -> list[dict[str, Any]]:
    def table(col: dict[str, Any], *sort: Any) -> dict[str, Any]:
        return _table(_BLOCK_ROWS, _el(), col, sort=list(sort))

    return [
        *[_run(table(_script(_NAME), key(1))) for key in (_asc, _desc)],
        *[_run(table(_script(_OR_NONE), key(1))) for key in (_asc, _desc)],
        *[_run(table(_script(_TAGS), key(1))) for key in (_asc, _desc)],
        *[_run(table(_script(_MIXED), key(1))) for key in (_asc, _desc)],
        *[_run(table(_script(_KINDS), key(1))) for key in (_asc, _desc)],
        *[_run(table(_script(_FIRST_LINK), key(1))) for key in (_asc, _desc)],
        *[_run(table(_script(_ALL_LINKS), key(1))) for key in (_asc, _desc)],
        *[_run(table(_script(_GHOSTS), key(1))) for key in (_asc, _desc)],
        *[_run(table(_script(_PAIRS), key(1))) for key in (_asc, _desc)],
        *[_run(table(_script(_NULLY), key(1))) for key in (_asc, _desc)],
        *[_run(table(_script(_BOOM_THIRDS), key(1))) for key in (_asc, _desc)],
        _run(table(_script(_TAG_COUNT), _desc(1), _asc(0))),
        _run(table(_script(_NAME), _asc(1), _desc(0))),
        # an expand script column sorts by the value it promoted
        *[_run(table(_script(_TAGS, "expand"), key(1))) for key in (_asc, _desc)],
        _run(table(_script(_FIRST_LINK, "expand", False), _desc(1))),
        # a script column beside a plain one, sorted with a page cut out of the order
        _run(
            _table(
                _BLOCK_ROWS,
                _el(),
                _prop("name"),
                _script(_TAG_COUNT),
                sort=[_desc(2), _asc(1)],
            ),
            offset=2,
            limit=3,
        ),
        # a sort by a script column that errors on a source nothing has
        _run(
            _table(
                _scope_rows(["Leaf"]),
                _nav({}),
                _script(_NAME, source=_ref(0)),
                sort=[_asc(1)],
            )
        ),
        # the column that is sorted fed by one that is not
        _run(
            _table(
                _BLOCK_ROWS,
                _el(),
                _script(_NAME),
                _script(_JOIN, inputs=[_in("a", 1)]),
                sort=[_desc(2)],
            )
        ),
    ]


def _navigations_with_scripts() -> list[dict[str, Any]]:
    scripted = _path(_BLOCKS_SCOPE, _script_step(_HOP))
    failing = _path(_BLOCKS_SCOPE, _script_step(_HOP_OR_BOOM))
    hop = _path(_ROW, _script_step(_HOP))
    hop_or_boom = _path(_ROW, _script_step(_HOP_OR_BOOM))
    return [
        # script row sources, by step and as chains
        _run(_table(_nav_rows(_inline(scripted)), _el(), _prop("name"), _script(_NAME))),
        _run(_table(_nav_rows(_inline(scripted), 0), _el(), _script(_NAME))),
        _run(_table(_nav_rows(_inline(failing)), _el(), _script(_NAME))),
        _run(_table(_chains(_inline(scripted)), _el(), _el(_row(1)), _script(_NAME, source=_row(1)))),
        _run(_table(_chains(_inline(scripted), True), _el(_row(1)), _script(_NAME, source=_row(1)))),
        _run(_table(_nav_rows(_inline(_path(_BLOCKS_SCOPE, _script_step({"ref": "gone"})))), _el())),
        # a navigation column holding a script step, as a cell, an expand, a filter and a source
        _run(_table(_BLOCK_ROWS, _el(), _nav(_inline(hop)), _nav(_inline(hop_or_boom)))),
        _run(_table(_BLOCK_ROWS, _el(), _nav(_inline(hop), "expand"), _script(_NAME, source=_ref(1)))),
        _run(_table(_BLOCK_ROWS, _el(), _nav(_inline(hop_or_boom), "expand", False))),
        _run(_table(_BLOCK_ROWS, _el(), _nav(_inline(hop_or_boom), keep_empty=False))),
        _run(
            _table(
                _BLOCK_ROWS,
                _el(),
                _nav(_inline(hop)),
                _script(_NAMES, source=_ref(1)),
                _script(_SHOW_INPUTS, inputs=[_in("n", 1)]),
            )
        ),
        # a sort cannot drive a script step: build order, and a warning
        _run(_table(_BLOCK_ROWS, _el(), _nav(_inline(hop)), sort=[_desc(1)])),
        _run(
            _table(
                _BLOCK_ROWS,
                _el(),
                _nav(_inline(hop)),
                _script(_NAME),
                _prop("name", source=_ref(1)),
                sort=[_asc(1), _desc(2)],
            )
        ),
        _run(_table(_BLOCK_ROWS, _el(), _el(_ref(1)), _nav(_inline(hop)), sort=[_asc(2)])),
        _run(_table(_BLOCK_ROWS, _el(), _nav(_inline(hop), "expand"), sort=[_desc(1)])),
        # the same navigation without a script step sorts
        _run(_table(_BLOCK_ROWS, _el(), _nav(_inline(_ROW_LINKS)), sort=[_desc(1)])),
        # and a snippet by ref in a step
        _run(
            _table(
                _BLOCK_ROWS,
                _el(),
                _nav(_inline(_path(_ROW, _script_step({"ref": "hop"})))),
                _nav(_inline(_path(_ROW, _script_step({"ref": "gone"})))),
            )
        ),
    ]


def _refs() -> list[dict[str, Any]]:
    by_ref = _table(
        _BLOCK_ROWS,
        _el(),
        _script({"ref": "snip"}),
        _script({"ref": "gone"}),
        _script({"ref": "not_a_snippet"}),
        _script({"ref": "snip"}, "expand", False),
        _script({"ref": "gone"}, "expand"),
        _script({"ref": "snip"}, keep_empty=False),
    )
    sorted_by_ref = _table(
        _BLOCK_ROWS, _el(), _script({"ref": "snip"}), sort=[_desc(1)]
    )
    # a preview reads its row order cache-only, so what it sorts by is no script
    preview_by_ref = _table(
        _BLOCK_ROWS,
        _el(),
        _prop("name"),
        _script({"ref": "snip"}),
        sort=[_desc(1)],
    )
    inputs_by_ref = _table(
        _BLOCK_ROWS,
        _el(),
        _script({"ref": "snip"}),
        _script({"ref": "inputs"}, inputs=[_in("a", 1)]),
        _script({"ref": "gone"}),
        _script({"ref": "inputs"}, inputs=[_in("a", 3)]),
    )
    return [
        _run(by_ref),
        _run(sorted_by_ref),
        _run(inputs_by_ref),
        _run_saved("saved"),
        _preview(preview_by_ref),
        # the snippet edited, the same tables again
        {"do": "artifacts", "_artifacts": _SNIPPET_EDITED},
        _run(by_ref),
        _run(sorted_by_ref),
        _run(inputs_by_ref),
        _run_saved("saved"),
        _preview(preview_by_ref),
        # and the snippet that was gone, now defined
        {"do": "artifacts", "_artifacts": {**_SNIPPET_EDITED, "gone": _SNIPPET_EDITED["snip"]}},
        _run(by_ref),
        _run_saved("saved"),
        {"do": "artifacts", "_artifacts": _SNIPPET_ARTIFACTS},
        _run(by_ref),
    ]


_SNIPPET_ARTIFACTS: dict[str, Any] = {
    "snip": {"kind": "code_snippet", "payload": _NAME["definition"]},
    "inputs": {"kind": "code_snippet", "payload": _JOIN["definition"]},
    "hop": {"kind": "code_snippet", "payload": _HOP["definition"]},
    "one_arg": {"kind": "code_snippet", "payload": _value("return len(els)")["definition"]},
    "two_args": {"kind": "code_snippet", "payload": _valued("return len(inputs)")["definition"]},
    "not_a_snippet": {"kind": "navigation", "payload": _path(_scope(["Block"]))},
    "saved": {
        "kind": "table",
        "payload": _table(
            _BLOCK_ROWS,
            _el(),
            _script({"ref": "snip"}),
            _script({"ref": "snip"}, "expand", False),
            sort=[_desc(1), _asc(0)],
        ),
    },
}
_SNIPPET_EDITED: dict[str, Any] = {
    **_SNIPPET_ARTIFACTS,
    "snip": {
        "kind": "code_snippet",
        "payload": _value('return "edited " + str(els[0].name)')["definition"],
    },
}


def _definitions() -> list[dict[str, Any]]:
    def snippet(**fields: Any) -> dict[str, Any]:
        return {"definition": fields}

    def column(definition: dict[str, Any]) -> dict[str, Any]:
        return _table(_BLOCK_ROWS, _el(), _script(definition))

    code = _code("els", "return 1")
    return [
        # a definition the oracle's schema reads, in forms it admits
        _run(column(snippet(code=code, language="python", entry_points=["value"]))),
        _run(column(snippet(code=code, schema_version="1", future="ignored"))),
        _run(column(snippet(code=code, schema_version=True))),
        _run(column(snippet(code=code, schema_version=1.0))),
        _run(column(snippet(code=code, entry_points=[]))),
        # and ones it refuses, before anything runs
        _run(column({"definition": {}})),
        _run(column(snippet(code=5))),
        _run(column(snippet(code=None))),
        _run(column(snippet(code=["def value(els): return 1"]))),
        _run(column(snippet(code=code, language="js"))),
        _run(column(snippet(code=code, language=None))),
        _run(column(snippet(code=code, entry_points="value"))),
        _run(column(snippet(code=code, entry_points=[1]))),
        _run(column(snippet(code=code, entry_points=None))),
        _run(column(snippet(code=code, schema_version="one"))),
        _run(column(snippet(code=code, schema_version=1.5))),
        _run(column(snippet(code=code, schema_version=None))),
        _run(column(snippet(code="x" * (64 * 1024 + 1)))),
        # characters, not UTF-16 units: this is 66,000 of those and 33,000 of the first
        _run(column(snippet(code="😀" * 33_000))),
        _run(column(snippet(code="😀" * (64 * 1024 + 1)))),
        # a step of a navigation column is held to the same schema
        _run(
            _table(
                _BLOCK_ROWS,
                _el(),
                _nav(_inline(_path(_ROW, _script_step(snippet(code=7))))),
            )
        ),
        _run(
            _table(
                _BLOCK_ROWS,
                _el(),
                _nav(_inline(_path(_ROW, _script_step(snippet(code="x", language="js"))))),
            )
        ),
        _run(
            _table(
                _nav_rows(_inline(_path(_BLOCKS_SCOPE, _script_step(snippet(entry_points=3))))),
                _el(),
            )
        ),
    ]


def _previews() -> list[dict[str, Any]]:
    values = _table(
        _BLOCK_ROWS,
        _el(),
        _script(_NAME),
        _script(_TAGS),
        _script(_FIRST_LINK),
        _script(_BOOM_THIRDS),
    )
    # a preview's rows and their order are read cache-only and its cells live, so a
    # script that decides either would show the cold answer: these decide neither
    plain_sort = _table(
        _BLOCK_ROWS,
        _el(),
        _prop("name"),
        _script(_TAGS),
        _script(_SHOW_INPUTS, inputs=[_in("n", 1)]),
        sort=[_desc(1)],
    )
    return [
        _run(values),
        _preview(values),
        _run(plain_sort),
        _preview(plain_sort),
    ]


_SCRIPTED_STEPS: list[dict[str, Any]] = [
    batch(_ELEMENTS),
    batch(_RELATIONSHIPS),
    {"do": "artifacts", "_artifacts": _SNIPPET_ARTIFACTS},
    *_values(),
    *_inputs(),
    *_expand_and_keep(),
    *_sorts_of_scripts(),
    *_navigations_with_scripts(),
    *_refs(),
    *_definitions(),
    *_previews(),
    # the model moves under the cells
    batch(
        [{"kind": "update_element", "id": "id-13", "properties_patch": {"name": "alpha2", "tags": ["t"]}}]
    ),
    _run(_table(_BLOCK_ROWS, _el(), _script(_NAME), _script(_TAGS), sort=[_asc(1)])),
    {"do": "delete_element", "id": "id-14"},
    _run(_table(_BLOCK_ROWS, _el(), _script(_FIRST_LINK), _script(_NAMES, source=_ref(1)))),
]


@scenario("table_eval_scripted")
def table_eval_scripted() -> Any:
    metamodel = Metamodel.model_validate(_METAMODEL)
    return {
        "metamodel": metamodel.model_dump(mode="json"),
        "steps": run_scripted(metamodel, _SCRIPTED_STEPS),
    }
