"""A table page as ``POST /tables/evaluate`` answers it, over ``table_rows``'
model, two more gadgets holding exact values (``2**60``, ``-0.0``, ``1e16``,
``2**64``, quotes, non-ASCII, nested lists, dicts) and one holding a property
its type does not declare: pages at their edges; every column kind in both
modes, over one element and over many; element-typed
properties, dangling references and ``_Stereotype``; navigation cells at the
cell cap (1, 20 and 21; 20 reached, and more); a build cut at the route's
50,000 rows with expand columns after the cut; sorts over value labels; the
route's refusals; saved tables. ``cell_text`` records a page as an export
renders it, a page of a capped build included."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, read_step, run_steps
from .table_rows import (
    _BLOCKS_SCOPE,
    _ELEMENTS,
    _LINKED,
    _METAMODEL,
    _RELATIONSHIPS,
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
_REACH_22 = _path(_scope(["Person", "Gadget", "Leaf"]))
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
]


@scenario("table_eval")
def table_eval() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
