"""A table's rows as the tables route builds and orders them: every row
source (scopes with types and criteria, navigations projected at a step,
chains whole and unique, unconfigured, by ref and dangling); every column kind
in both modes with and without ``keep_empty``; row slots and column refs with
a step index; the row cap at its edges, later columns still running over a
capped build; and sorts ascending and descending over several keys — repeated
and out of range, empties last, numbers, booleans, strings and element-id
strings, ints past 2^53, names only ``casefold`` orders, and a property that is
element-typed on one type and scalar on another. Which tables reach a script
is recorded, and such a table is not built."""

from __future__ import annotations

from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, run_steps

_METAMODEL = {
    "elements": [
        {
            "name": "Base",
            "abstract": True,
            "properties": [{"name": "name", "datatype": "string"}],
        },
        {
            "name": "Person",
            "extends": "Base",
            "properties": [{"name": "s", "datatype": "string"}],
        },
        {
            "name": "Thing",
            "abstract": True,
            "extends": "Base",
            "properties": [
                {"name": "s", "datatype": "string"},
                {"name": "i", "datatype": "integer"},
                {"name": "f", "datatype": "float"},
                {"name": "b", "datatype": "boolean"},
                {"name": "d", "datatype": "date"},
                {"name": "tags", "datatype": "string", "multiplicity": "0..*"},
                {"name": "mixed", "datatype": "string", "multiplicity": "0..*"},
            ],
        },
        {
            "name": "Block",
            "extends": "Thing",
            "properties": [
                {"name": "owner", "datatype": "Person"},
                {"name": "parts", "datatype": "Block", "multiplicity": "0..*"},
            ],
        },
        {"name": "Part", "extends": "Block"},
        {"name": "Leaf", "extends": "Part"},
        {
            "name": "Gadget",
            "extends": "Thing",
            "properties": [{"name": "owner", "datatype": "string"}],
        },
    ],
    "relationships": [
        {"name": "Links", "source": "Base", "target": "Base"},
        {"name": "SubLinks", "extends": "Links", "source": "Base", "target": "Base"},
        {"name": "Owns", "containment": True, "source": "Base", "target": "Base"},
    ],
}

#: people 1-12, blocks 13-22, gadgets 23-26; names only casefold orders
_PEOPLE: list[dict[str, Any]] = [
    {"name": "Straße"},
    {"name": "STRASSE"},
    {"name": "Strasze"},
    {"name": "ςb"},
    {"name": "σa"},
    {"name": "Ꭰx", "s": "ꭰ"},
    {"name": "ᐁ"},
    {"name": "ﬁle", "s": "FILE"},
    {"name": "fim"},
    {"name": "µ"},
    {"name": "İstanbul"},
    {},
]

_BLOCKS: list[tuple[str, dict[str, Any]]] = [
    (
        "Block",
        {
            "name": "alpha",
            "s": "b",
            "i": 2**53,
            "f": 1.5,
            "b": True,
            "d": "2024-01-01",
            "tags": ["x", "y"],
            "mixed": [1, "id-1"],
            "owner": "id-1",
            "parts": ["id-14", "id-15", "id-14", "ghost"],
        },
    ),
    (
        "Block",
        {
            "name": "Beta",
            "i": 2**53 + 1,
            "f": -0.0,
            "b": False,
            "tags": [],
            "mixed": ["B", 2.5],
            "owner": "id-2",
            "parts": ["id-13"],
        },
    ),
    (
        "Part",
        {
            "name": "gamma",
            "s": "C",
            "i": 2**64,
            "f": 2.0,
            "tags": ["x"],
            "mixed": [True, 1.0],
            "owner": "id-12",
            "parts": [],
        },
    ),
    (
        "Part",
        {
            "name": "Delta",
            "s": "a",
            "i": -3,
            "tags": ["z", "x", "x"],
            "mixed": "solo",
            "owner": "id-99",
        },
    ),
    (
        "Leaf",
        {
            "name": "epsilon",
            "i": 0,
            "f": 1e16,
            "b": True,
            "tags": ["single", "x"],
            "mixed": [None, {"k": 1}, [1, 2]],
            "parts": ["id-17"],
        },
    ),
    ("Leaf", {"name": "Straße", "s": "ß", "tags": ["ß", "SS"], "owner": "id-2"}),
    ("Block", {"name": "zeta", "tags": "solo-tag"}),
    (
        "Part",
        {
            "name": "Eta",
            "s": "b",
            "i": 2**53,
            "tags": [1, 1.0, True, "1"],
            "mixed": ["id-13", "ALPHA"],
            "owner": "id-6",
        },
    ),
    ("Leaf", {"name": "theta", "s": None, "i": 10**20, "owner": "id-8"}),
    ("Block", {"name": "iota", "f": 1.0, "tags": ["ﬁ", "Ꭰ"], "owner": "id-4"}),
]

_GADGETS: list[dict[str, Any]] = [
    {"name": "gadget-a", "s": "b", "owner": "text owner"},
    {"name": "Gadget-B", "owner": "alpha"},
    {"name": "gadget-c", "owner": "id-1", "tags": ["q"]},
    {"name": "gadget-d"},
]


def _create(n: int, type_name: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{n}",
        "type_name": type_name,
        "properties": properties,
    }


_ELEMENTS = [
    *[_create(n, "Person", props) for n, props in enumerate(_PEOPLE, 1)],
    *[
        _create(n, type_name, props)
        for n, (type_name, props) in enumerate(_BLOCKS, len(_PEOPLE) + 1)
    ],
    *[
        _create(n, "Gadget", props)
        for n, props in enumerate(_GADGETS, len(_PEOPLE) + len(_BLOCKS) + 1)
    ],
]

_EDGES = [
    ("Links", 13, 14),
    ("SubLinks", 13, 14),
    ("Links", 14, 15),
    ("Links", 15, 16),
    ("Links", 16, 17),
    ("SubLinks", 17, 13),
    ("Links", 18, 18),
    ("SubLinks", 19, 19),
    ("Links", 20, 13),
    ("Links", 20, 14),
    ("SubLinks", 21, 20),
    ("Links", 13, 1),
    ("Links", 14, 2),
    ("Links", 15, 1),
    ("Links", 16, 3),
    ("Links", 23, 13),
    ("Links", 24, 23),
    ("Links", 5, 13),
    ("Owns", 13, 18),
    ("Owns", 13, 19),
    ("Owns", 20, 21),
    ("Owns", 23, 24),
]

_RELATIONSHIPS = [
    {
        "kind": "create_relationship",
        "temp_id": f"tmp_r{k}",
        "type_name": rel,
        "source_id": f"id-{source}",
        "target_id": f"id-{target}",
        "properties": {},
    }
    for k, (rel, source, target) in enumerate(_EDGES)
]


# -- navigations -----------------------------------------------------------------


def _scope(types: list[str] | None = None, *criteria: Any) -> dict[str, Any]:
    scope: dict[str, Any] = {"kind": "scope"}
    if types is not None:
        scope["types"] = types
    if criteria:
        scope["criteria"] = list(criteria)
    return scope


def _path(start: dict[str, Any], *steps: Any) -> dict[str, Any]:
    return {"kind": "path", "start": start, "steps": list(steps)}


def _hop(rel: str, direction: str | None = None) -> dict[str, Any]:
    step: dict[str, Any] = {"kind": "relationship", "relationship_type": rel}
    if direction is not None:
        step["direction"] = direction
    return step


def _step(name: str) -> dict[str, Any]:
    return {"kind": "property", "property_name": name}


def _script_step(snippet: dict[str, Any]) -> dict[str, Any]:
    return {"kind": "script", "snippet": snippet}


def _exists(name: str) -> dict[str, Any]:
    return {"type": "property", "name": name, "op": "exists"}


_ROW = {"kind": "row"}
_CODE = {"code": "def step(el):\n    return el\n"}
_BLOCKS_SCOPE = _scope(["Block"])

_LINKED = _path(_BLOCKS_SCOPE, _hop("Links"))
_TWO_HOPS = _path(_BLOCKS_SCOPE, _hop("Links"), _hop("Links"))
_ROW_LINKS = _path(_ROW, _hop("Links"))
_ROW_EITHER = _path(_ROW, _hop("Links", "either"))
_ROW_TAGS = _path(_ROW, _step("tags"))
_ROW_PARTS = _path(_ROW, _step("parts"))
_ROW_LINK_TAGS = _path(_ROW, _hop("Links"), _step("tags"))
_ROW_EITHER_TAGS = _path(_ROW, _hop("Links", "either"), _step("tags"))

_ARTIFACTS = {
    "n1": {"kind": "navigation", "payload": _LINKED},
    "n2": {
        "kind": "navigation",
        "payload": {
            "kind": "set_op",
            "op": "union",
            "operands": [{"ref": "n1", "step_index": 0}],
        },
    },
    "n3": {
        "kind": "navigation",
        "payload": _path(_ROW, _script_step({"definition": _CODE})),
    },
    "t1": {"kind": "table", "payload": {"schema_version": 1}},
    "s1": {"kind": "code_snippet", "payload": _CODE},
}


# -- tables ----------------------------------------------------------------------


def _inline(definition: dict[str, Any]) -> dict[str, Any]:
    return {"definition": definition}


def _scope_rows(types: list[str] | None = None, *criteria: Any) -> dict[str, Any]:
    return _scope(types, *criteria)


def _nav_rows(
    navigation: dict[str, Any], step_index: int | None = None
) -> dict[str, Any]:
    rows: dict[str, Any] = {"kind": "navigation", "navigation": navigation}
    if step_index is not None:
        rows["step_index"] = step_index
    return rows


def _chains(navigation: dict[str, Any], unique: bool | None = None) -> dict[str, Any]:
    rows: dict[str, Any] = {"kind": "chains", "navigation": navigation}
    if unique is not None:
        rows["unique"] = unique
    return rows


def _row(chain_index: int | None = None) -> dict[str, Any]:
    source: dict[str, Any] = {"kind": "row"}
    if chain_index is not None:
        source["chain_index"] = chain_index
    return source


def _ref(index: int, step_index: int | None = None) -> dict[str, Any]:
    source: dict[str, Any] = {"kind": "column", "index": index}
    if step_index is not None:
        source["step_index"] = step_index
    return source


def _column(kind: str, source: dict[str, Any] | None, **fields: Any) -> dict[str, Any]:
    column: dict[str, Any] = {"kind": kind}
    if source is not None:
        column["source"] = source
    column.update({key: value for key, value in fields.items() if value is not None})
    return column


def _el(source: dict[str, Any] | None = None) -> dict[str, Any]:
    return _column("element", source)


def _prop(
    name: str,
    mode: str | None = None,
    keep_empty: bool | None = None,
    source: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return _column("property", source, name=name, mode=mode, keep_empty=keep_empty)


def _nav(
    navigation: dict[str, Any],
    mode: str | None = None,
    keep_empty: bool | None = None,
    source: dict[str, Any] | None = None,
    step_index: int | None = None,
    sort_mode: str | None = None,
) -> dict[str, Any]:
    return _column(
        "navigation",
        source,
        navigation=navigation,
        mode=mode,
        keep_empty=keep_empty,
        step_index=step_index,
        sort_mode=sort_mode,
    )


def _script(
    snippet: dict[str, Any],
    mode: str | None = None,
    keep_empty: bool | None = None,
    source: dict[str, Any] | None = None,
    inputs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return _column(
        "script",
        source,
        snippet=snippet,
        mode=mode,
        keep_empty=keep_empty,
        inputs=inputs,
    )


def _asc(column: int) -> dict[str, Any]:
    return {"column": column}


def _desc(column: int) -> dict[str, Any]:
    return {"column": column, "direction": "desc"}


def _table(
    row_source: dict[str, Any], *columns: Any, sort: list[Any] | None = None
) -> dict[str, Any]:
    definition: dict[str, Any] = {"row_source": row_source, "columns": list(columns)}
    if sort is not None:
        definition["sort"] = sort
    return definition


def _rows(definition: dict[str, Any], max_rows: int | None = None) -> dict[str, Any]:
    step: dict[str, Any] = {"do": "table_rows", "definition": definition}
    if max_rows is not None:
        step["limits"] = {"max_rows": max_rows, "max_cell_elements": 20}
    return step


# -- cases -----------------------------------------------------------------------


def _row_sources() -> list[dict[str, Any]]:
    return [
        _rows(_table(_scope_rows(), _el())),
        _rows(_table(_scope_rows([]), _el())),
        _rows(_table(_scope_rows(["Block"]), _el())),
        _rows(_table(_scope_rows(["Part", "Gadget"]), _el())),
        _rows(_table(_scope_rows(["Block"], _exists("tags")), _el())),
        _rows(_table(_scope_rows(None, _exists("s")), _el())),
        _rows(_table(_scope_rows(["Nope"]), _el())),
        # navigations: projected at the last step, at a step, a negative one
        _rows(_table(_nav_rows(_inline(_LINKED)), _el())),
        _rows(_table(_nav_rows(_inline(_TWO_HOPS), 0), _el())),
        _rows(_table(_nav_rows(_inline(_TWO_HOPS), 1), _el())),
        _rows(_table(_nav_rows(_inline(_TWO_HOPS), -2), _el())),
        _rows(_table(_nav_rows(_inline(_TWO_HOPS), 3), _el())),
        _rows(_table(_nav_rows(_inline(_TWO_HOPS), -4), _el())),
        # a value at the projected step seeds no row; elements through a property do
        _rows(_table(_nav_rows(_inline(_path(_BLOCKS_SCOPE, _step("tags")))), _el())),
        _rows(_table(_nav_rows(_inline(_path(_BLOCKS_SCOPE, _step("parts")))), _el())),
        _rows(_table(_nav_rows({}), _el())),
        _rows(_table(_nav_rows(_inline(_ROW_LINKS)), _el())),
        _rows(_table(_nav_rows({"ref": "n1"}), _el())),
        _rows(_table(_nav_rows({"ref": "n2"}), _el())),
        _rows(_table(_nav_rows({"ref": "nope"}), _el())),
        _rows(_table(_nav_rows({"ref": "t1"}), _el())),
        _rows(
            _table(
                _nav_rows(
                    _inline(
                        {"kind": "set_op", "op": "union", "operands": [{"ref": "nope"}]}
                    )
                ),
                _el(),
            )
        ),
        # chains whole, unique by terminal, ending in values, unconfigured
        _rows(_table(_chains(_inline(_TWO_HOPS)), _el(), _el(_row(1)), _el(_row(2)))),
        _rows(_table(_chains(_inline(_TWO_HOPS), True), _el(_row(2)))),
        _rows(_table(_chains(_inline(_TWO_HOPS), False), _el(_row(2)))),
        _rows(_table(_chains(_inline(_path(_BLOCKS_SCOPE, _step("tags")))), _el())),
        _rows(
            _table(
                _chains(_inline(_path(_BLOCKS_SCOPE, _step("tags"))), True),
                _el(),
                sort=[_desc(0)],
            )
        ),
        _rows(_table(_chains({}), _el())),
        _rows(_table(_chains({"ref": "n1"}), _el(_row(1)))),
        _rows(_table(_chains(_inline(_LINKED)), _el(_row(1)), _el(_row(2)))),
        _rows(
            _table(
                _chains(_inline(_LINKED)), _el(_row(1)), _el(_row(2)), sort=[_asc(1)]
            )
        ),
    ]


def _columns() -> list[dict[str, Any]]:
    blocks = _scope_rows(["Block"])
    things = _scope_rows(["Block", "Gadget"])
    return [
        # property columns in both modes, with and without keep_empty
        _rows(_table(blocks, _prop("s"))),
        _rows(_table(blocks, _prop("s", keep_empty=False))),
        _rows(_table(blocks, _prop("tags", keep_empty=False))),
        _rows(_table(blocks, _prop("tags", "expand"))),
        _rows(_table(blocks, _prop("tags", "expand", False))),
        _rows(_table(blocks, _prop("mixed", "expand", False))),
        _rows(_table(blocks, _prop("parts", "expand"), _el(_ref(0)))),
        _rows(_table(things, _prop("owner", "expand", False), _el(_ref(0)))),
        _rows(
            _table(
                things,
                _prop("_Stereotype", "expand"),
                _prop("undeclared", keep_empty=False),
            )
        ),
        _rows(_table(things, _prop("_Stereotype", keep_empty=False))),
        # navigation columns in both modes, with and without keep_empty
        _rows(_table(blocks, _nav(_inline(_ROW_LINKS)))),
        _rows(_table(blocks, _nav(_inline(_ROW_LINKS), keep_empty=False))),
        _rows(_table(blocks, _nav(_inline(_ROW_LINKS), "expand"))),
        _rows(_table(blocks, _nav(_inline(_ROW_LINKS), "expand", False))),
        _rows(_table(blocks, _nav(_inline(_ROW_TAGS), "expand"))),
        _rows(_table(blocks, _nav(_inline(_ROW_LINK_TAGS), "expand", False))),
        # equal values of two elements are two values
        _rows(_table(blocks, _nav(_inline(_ROW_EITHER_TAGS), "expand", False))),
        _rows(_table(blocks, _nav(_inline(_ROW_LINK_TAGS), "expand", step_index=1))),
        _rows(_table(blocks, _nav({}, "expand"), _nav({}, keep_empty=False))),
        _rows(_table(blocks, _nav(_inline(_TWO_HOPS), "expand", False))),
        _rows(_table(blocks, _nav({"ref": "n1"}, "expand", False, step_index=0))),
        # element columns through refs, a slot of an expand column
        _rows(
            _table(
                blocks,
                _nav(_inline(_ROW_EITHER), "expand", False),
                _el(_ref(0)),
                _nav(_inline(_ROW_LINKS), "expand", False, _ref(1)),
                _el(_ref(2)),
            )
        ),
        # a collapse column as a source: its elements, or none for scalars
        _rows(
            _table(
                blocks,
                _prop("parts"),
                _nav(_inline(_ROW_LINKS), "expand", False, _ref(0)),
                _prop("tags"),
                _nav(_inline(_ROW_LINKS), keep_empty=False, source=_ref(2)),
            )
        ),
        _rows(
            _table(
                blocks,
                _nav(_inline(_ROW_EITHER)),
                _prop("name", "expand", False, _ref(0)),
            )
        ),
        # a step index on a reference: off a collapse column, off an expand one
        _rows(
            _table(
                blocks,
                _nav(_inline(_TWO_HOPS)),
                _nav(_inline(_ROW_EITHER), "expand", False, _ref(0, 1)),
            )
        ),
        _rows(
            _table(
                blocks,
                _nav(_inline(_ROW_LINK_TAGS), "expand", False),
                _nav(_inline(_ROW_TAGS), "expand", source=_ref(0, 1)),
                _nav(_inline(_ROW_LINKS), "expand", source=_ref(0, 0)),
            )
        ),
        _rows(
            _table(
                blocks,
                _nav(_inline(_ROW_LINKS), "expand"),
                _nav(_inline(_ROW_EITHER), "expand", False, _ref(0, -1)),
            )
        ),
        _rows(
            _table(
                blocks,
                _prop("s", keep_empty=False),
                _nav(_inline(_ROW_LINKS)),
                _nav(_inline(_ROW_LINKS), keep_empty=False, source=_ref(1, 2)),
            )
        ),
        # row slots under chains
        _rows(
            _table(
                _chains(_inline(_TWO_HOPS)),
                _prop("name", source=_row(1), keep_empty=False),
                _nav(_inline(_ROW_TAGS), "expand", source=_row(2)),
            )
        ),
        _rows(_table(_chains(_inline(_LINKED)), _el(_row(2)), sort=[_asc(0)])),
        _rows(
            _table(
                _chains(_inline(_path(_BLOCKS_SCOPE, _step("tags")))),
                _nav(_inline(_ROW_LINKS), keep_empty=False, source=_row(1)),
            )
        ),
        # unconfigured script columns: nothing, in either mode
        _rows(_table(blocks, _script({}))),
        _rows(_table(blocks, _script({}, keep_empty=False))),
        _rows(_table(blocks, _script({}, "expand"))),
        _rows(_table(blocks, _script({}, "expand", False))),
        _rows(
            _table(
                blocks,
                _el(),
                _script({}, inputs=[{"name": "x", "ref": {"index": 0}}], source=_row()),
                _nav(_inline(_ROW_LINKS), keep_empty=False, source=_ref(1)),
            )
        ),
        _rows(
            _table(
                blocks,
                _el(),
                _script({}, inputs=[{"name": "x", "ref": {"index": 0}}]),
                _nav(_inline(_ROW_LINKS), source=_ref(1)),
                sort=[_asc(1), _desc(2), _asc(0)],
            )
        ),
    ]


def _caps() -> list[dict[str, Any]]:
    blocks = _scope_rows(["Block"])
    return [
        _rows(_table(blocks, _el()), 1),
        _rows(_table(blocks, _el()), 10),
        _rows(_table(blocks, _el()), 9),
        _rows(_table(blocks, _prop("tags", "expand")), 1),
        # mid first expand; the second still runs and caps again
        _rows(
            _table(
                blocks, _prop("tags", "expand"), _nav(_inline(_ROW_LINKS), "expand")
            ),
            6,
        ),
        _rows(
            _table(
                blocks,
                _prop("tags", "expand"),
                _nav(_inline(_ROW_EITHER), "expand"),
                _el(_ref(1)),
                sort=[_asc(2)],
            ),
            6,
        ),
        # mid second expand
        _rows(
            _table(
                blocks,
                _prop("tags", "expand", False),
                _nav(_inline(_ROW_EITHER), "expand"),
            ),
            9,
        ),
        _rows(
            _table(
                _chains(_inline(_TWO_HOPS)),
                _prop("tags", "expand", source=_row(2)),
                _el(_row(1)),
            ),
            4,
        ),
        # a later collapse filter drops capped rows
        _rows(_table(blocks, _prop("tags", "expand"), _prop("s", keep_empty=False)), 6),
        _rows(
            _table(
                blocks,
                _prop("tags", "expand"),
                _nav(_inline(_ROW_LINKS), "expand", False),
                _nav(_inline(_ROW_TAGS), keep_empty=False, source=_ref(1)),
            ),
            5,
        ),
        _rows(_table(blocks, _prop("tags", "expand", False)), 7),
        _rows(_table(blocks, _prop("tags", "expand", False)), 8),
    ]


def _sorts() -> list[dict[str, Any]]:
    people = _scope_rows(["Person"])
    blocks = _scope_rows(["Block"])
    things = _scope_rows(["Block", "Gadget"])
    everything = _scope_rows()
    return [
        # names only casefold orders; equal names keep build order both ways
        _rows(_table(people, _el(), sort=[_asc(0)])),
        _rows(_table(people, _el(), sort=[_desc(0)])),
        _rows(_table(everything, _el(), sort=[_asc(0)])),
        _rows(_table(everything, _el(), _prop("s"), sort=[_desc(1)])),
        _rows(_table(everything, _el(), _prop("s"), sort=[_asc(1), _desc(0)])),
        # repeated and out-of-range keys are dropped, the first one wins
        _rows(
            _table(
                everything,
                _el(),
                _prop("s"),
                sort=[_asc(9), _asc(1), _desc(1), _desc(0), _asc(0), {"column": 2}],
            )
        ),
        # numbers, booleans, strings and element ids; ints past 2^53
        *[
            _rows(_table(blocks, _el(), _prop(name), sort=[key(1)]))
            for name in ("i", "f", "b", "d", "mixed", "tags", "parts", "owner")
            for key in (_asc, _desc)
        ],
        *[
            _rows(_table(blocks, _prop(name, "expand"), sort=[key(0)]))
            for name in ("i", "mixed", "tags", "parts", "owner")
            for key in (_asc, _desc)
        ],
        # one property element-typed on one type, scalar on another
        *[
            _rows(_table(things, _el(), _prop("owner", mode), sort=[key(1)]))
            for mode in ("collapse", "expand")
            for key in (_asc, _desc)
        ],
        _rows(
            _table(
                things, _el(), _prop("owner", source=_ref(0)), sort=[_desc(1), _asc(0)]
            )
        ),
        # navigations by count and by value, with value terminals
        *[
            _rows(
                _table(
                    blocks,
                    _el(),
                    _nav(_inline(nav), sort_mode=sort_mode),
                    sort=[key(1)],
                )
            )
            for nav in (_ROW_EITHER, _ROW_LINK_TAGS, _ROW_EITHER_TAGS, _ROW_TAGS)
            for sort_mode in ("count", "value")
            for key in (_asc, _desc)
        ],
        *[
            _rows(_table(blocks, _nav(_inline(nav), "expand"), sort=[key(0)]))
            for nav in (_ROW_EITHER, _ROW_TAGS, _ROW_PARTS)
            for key in (_asc, _desc)
        ],
        # script columns sort as empty
        _rows(_table(blocks, _el(), _script({}), sort=[_desc(1), _desc(0)])),
        _rows(_table(blocks, _el(), _script({}, "expand"), sort=[_asc(1)])),
        # sorting a chains table by its slots
        _rows(
            _table(
                _chains(_inline(_TWO_HOPS)),
                _el(_row(2)),
                _el(_row(1)),
                sort=[_desc(0), _asc(1)],
            )
        ),
        _rows(_table(_scope_rows(["Nope"]), _el(), sort=[_asc(0)])),
    ]


def _scripts() -> list[dict[str, Any]]:
    blocks = _scope_rows(["Block"])
    return [
        _rows(_table(blocks, _script({"ref": "s1"}))),
        _rows(_table(blocks, _script({"ref": "gone"}, "expand"))),
        _rows(_table(blocks, _script({"definition": {"code": ""}}))),
        _rows(
            _table(
                blocks, _nav(_inline(_path(_ROW, _script_step({"definition": _CODE}))))
            )
        ),
        _rows(
            _table(
                blocks,
                _nav(_inline(_path(_ROW, _script_step({"ref": "s1"}))), "expand"),
            )
        ),
        _rows(_table(blocks, _nav({"ref": "n3"}))),
        _rows(_table(_nav_rows({"ref": "n3"}), _el())),
        _rows(
            _table(
                _chains(
                    _inline(
                        {
                            "kind": "set_op",
                            "op": "union",
                            "operands": [{"ref": "n3"}],
                        }
                    )
                ),
                _el(),
            )
        ),
        # an unconfigured script step reaches nothing and prunes
        _rows(
            _table(blocks, _nav(_inline(_path(_ROW, _script_step({}), _hop("Links")))))
        ),
        _rows(
            _table(
                blocks,
                _nav(_inline(_path(_ROW, _hop("Links"), _script_step({}))), "expand"),
            )
        ),
    ]


_STEPS: list[dict[str, Any]] = [
    batch(_ELEMENTS),
    batch(_RELATIONSHIPS),
    {"do": "artifacts", "_artifacts": _ARTIFACTS},
    *_row_sources(),
    *_columns(),
    *_caps(),
    *_sorts(),
    *_scripts(),
]


@scenario("table_rows")
def table_rows() -> Any:
    return run_steps(Metamodel.model_validate(_METAMODEL), _STEPS)
