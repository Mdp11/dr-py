"""Exports as ``POST /tables/export``, ``POST /tables/json-preview`` and
``POST /exports/run`` answer them, over ``table_rows``' model plus elements
holding a ``score`` of every value kind and people with names a filename
cannot hold. Steps are named by case, and later replays pick them by prefix:

- ``text_*``: CSV, JSON and JSONL of one table, and ``text_json_*`` every
  per-column JSON option; ``text_preview_*`` the JSON preview's window;
- ``split_*``: a table's own ``json_split`` as JSON and as JSONL;
- ``xlsx_*``: workbooks read back as cell grids;
- ``run_*``: exporters, saved and drafted, zipped and bare, and their
  refusals;
- ``reach_*``: exports that reach a script or a transform, as the server
  answers them with no runner;
- ``script_*``: exports and transform previews whose snippets run, on the
  trusted runner in a child (see ``scripted.py``): script cells in every
  format and an export's transform, each file of it, its refusals and the
  preview; they come last, after a batch of bulk gadgets.
"""

from __future__ import annotations

import copy
from typing import Any

from data_rover.core.metamodel.schema import Metamodel

from ..driver import scenario
from ..model_steps import batch, export_step, read_step
from ..scripted import run_scripted
from .table_rows import (
    _CODE,
    _ELEMENTS,
    _METAMODEL,
    _RELATIONSHIPS,
    _ROW,
    _ROW_EITHER,
    _ROW_LINKS,
    _ROW_TAGS,
    _asc,
    _create,
    _desc,
    _el,
    _exists,
    _hop,
    _inline,
    _nav,
    _path,
    _prop,
    _ref,
    _scope,
    _scope_rows,
    _script,
    _script_step,
    _step,
    _table,
)

_DATE = "20240229"


def _metamodel() -> dict[str, Any]:
    """``table_rows``' metamodel, its things carrying a ``score``."""
    doc = copy.deepcopy(_METAMODEL)
    (thing,) = [e for e in doc["elements"] if e["name"] == "Thing"]
    thing["properties"].append({"name": "score", "datatype": "float"})
    return doc


#: after the 26 elements and 22 relationships of ``table_rows``: one gadget per
#: value kind, in ``score``
_PROBES: list[tuple[str, Any]] = [
    ("p-str", "s"),
    ("p-empty", ""),
    ("p-none", None),
    ("p-true", True),
    ("p-false", False),
    ("p-int", 1),
    ("p-float", 1.0),
    ("p-half", 2.5),
    ("p-neg", -3),
    ("p-big", 2**60),
    ("p-past53", 2**53 + 1),
    ("p-negzero", -0.0),
    ("p-1e16", 1e16),
    ("p-list", [1, "a"]),
    ("p-dict", {"a": 1}),
    ("p-formula", "=1+1"),
    ("p-url", "http://x"),
    ("p-lines", "a\nb\nlonger line"),
    ("p-quotes", 'q"u,o\r\nte'),
    ("p-lead", "  lead"),
    ("p-wide", "x" * 40),
    ("p-cjk", "日本語テキスト"),
    ("p-astral", "𝒜𝒜𝒜𝒜"),
]
_FIRST_PROBE = 49
_PROBE_ELEMENTS = [
    _create(
        n,
        "Gadget",
        {"name": name, "score": value, "tags": [name, value] if n % 3 == 0 else []},
    )
    for n, (name, value) in enumerate(_PROBES, _FIRST_PROBE)
]
_CAP = _FIRST_PROBE + len(_PROBES)
_CAP_ELEMENT = _create(_CAP, "Gadget", {"name": "p-cap", "s": "m" * 200})

#: people named as no filename can be: unsafe characters, astral and CJK,
#: past 120 code points, all dots, blank, a control character, and names that
#: collide once rendered
_NAMES = [
    'a/b\\c:d*e?f"g<h>i|j',
    "𝒜𝒜𝒜 日本",
    "長" * 130,
    "𝒜" * 125,
    "...",
    "   ",
    "\x01ctrl\x1f",
    "dup",
    "dup",
    "dup_2",
    "DUP",
    "  dup  ",
]
_FIRST_NAMED = _CAP + 1
_NAMED_PEOPLE = [
    _create(n, "Person", {"name": name, "s": f"s{i}"})
    for i, (n, name) in enumerate(enumerate(_NAMES, _FIRST_NAMED))
]
#: a named person linked to blocks, so its partition holds several rows
_NAMED_LINKS = [
    {
        "kind": "create_relationship",
        "temp_id": f"tmp_nl{k}",
        "type_name": "Links",
        "source_id": f"id-{_FIRST_NAMED + 7}",
        "target_id": target,
        "properties": {},
    }
    for k, target in enumerate(["id-13", "id-14", "id-20"])
]

_NAME_IS = {"type": "name_id", "field": "name", "op": "equals"}

_BLOCKS = _scope_rows(["Block"])
_PEOPLE = _scope_rows(["Person"])
_PROBE_ROWS = _scope_rows(
    ["Gadget"], {"type": "name_id", "field": "name", "op": "contains", "value": "p-"}
)
_CAP_ROWS = _scope_rows(["Gadget"], {**_NAME_IS, "value": "p-cap"})
_NONE = _scope_rows(["Nope"])
_EVERYTHING = _path(_scope())

_TRANSFORM_CODE = {"code": "def transform(doc):\n    return doc\n"}

#: a sheet title's forbidden characters; its 31st code point is a quote the
#: title strips
_LATIN_TITLE = "a[b]:c*d?e/f\\g'" + "é" * 2 + "x" * 13 + "'" + "y" * 24
#: the same past Latin-1 and the Basic Multilingual Plane
_ASTRAL_TITLE = "a[b]:c*d?e/f\\g'𝒜日" + "x" * 13 + "'" + "y" * 24


def _header(column: dict[str, Any], header: str) -> dict[str, Any]:
    return {**column, "header": header}


def _json(column: dict[str, Any], **options: Any) -> dict[str, Any]:
    return {**column, "json_export": options}


def _exported(column: dict[str, Any], **options: Any) -> dict[str, Any]:
    return {**column, "export": options}


def _with(definition: dict[str, Any], **fields: Any) -> dict[str, Any]:
    return {**definition, **fields}


# -- tables ----------------------------------------------------------------------

#: element, property (collapse over lists) and navigation columns
_COLUMNS = _table(
    _BLOCKS,
    _header(_el(), "Block"),
    _prop("s"),
    _prop("tags"),
    _prop("mixed"),
    _prop("owner"),
    _prop("parts"),
    _nav(_inline(_ROW_LINKS)),
    _nav(_inline(_ROW_TAGS)),
    _nav(_inline(_ROW_EITHER), "expand"),
    sort=[_asc(0)],
)
_PROBE_TABLE = _table(
    _PROBE_ROWS,
    _header(_el(), "Probe"),
    _header(_prop("score"), "Score"),
    _header(_prop("tags"), "Tags"),
    _header(_nav(_inline(_path(_ROW, _step("tags")))), "Tag values"),
)
_PEOPLE_LINKED = _table(
    _PEOPLE,
    _header(_el(), "Person"),
    _header(_prop("s"), "S"),
    _header(_nav(_inline(_path(_ROW, _hop("Links", "either"))), "expand"), "Linked"),
)


def _split(template: str) -> dict[str, Any]:
    return {"enabled": True, "filename_template": template}


_ARTIFACTS: dict[str, dict[str, Any]] = {
    "n_links": {"kind": "navigation", "payload": _ROW_LINKS},
    "n_script": {
        "kind": "navigation",
        "payload": _path(_ROW, _script_step({"definition": _CODE})),
    },
    "s_transform": {"kind": "code_snippet", "payload": _TRANSFORM_CODE},
    "s_step": {"kind": "code_snippet", "payload": _CODE},
    "t_blocks": {
        "kind": "table",
        "payload": _table(
            _BLOCKS,
            _header(_el(), "Block"),
            _header(_prop("s"), "S"),
            _header(_prop("tags"), "Tags"),
            _header(_nav({"ref": "n_links"}), "Links"),
            sort=[_desc(0)],
        ),
    },
    "t_probes": {"kind": "table", "payload": _PROBE_TABLE},
    "t_people": {
        "kind": "table",
        "payload": _with(_PEOPLE_LINKED, json_split=_split("${name}")),
    },
    "t_tags": {
        "kind": "table",
        "payload": _table(
            _BLOCKS,
            _header(_el(), "Block"),
            _json(_header(_prop("tags", "expand"), "Tags"), group=True),
        ),
    },
    "t_empty": {"kind": "table", "payload": _table(_NONE, _el(), _prop("s"))},
    "t_s": {
        "kind": "table",
        "payload": _table(_scope_rows(["Block"], _exists("s")), _el(), _prop("s")),
    },
    "t_doc_tags": {
        "kind": "table",
        "payload": _table(
            _scope_rows(["Block"], {**_NAME_IS, "value": "Eta"}),
            _header(_el(), "Block"),
            _header(_prop("tags", "expand"), "Tag"),
        ),
    },
    "manifest": {"kind": "table", "payload": _table(_BLOCKS, _el())},
    "t_script": {
        "kind": "table",
        "payload": _table(
            _BLOCKS,
            _el(),
            _script({"definition": {"code": "def value(el):\n    return 1\n"}}),
        ),
    },
    "t_script_nav": {
        "kind": "table",
        "payload": _table(_BLOCKS, _el(), _nav({"ref": "n_script"})),
    },
    "t_transform": {
        "kind": "table",
        "payload": _with(
            _table(_BLOCKS, _el(), _prop("s")), transform={"ref": "s_transform"}
        ),
    },
    _LATIN_TITLE: {"kind": "table", "payload": _table(_BLOCKS, _el())},
    "'''": {"kind": "table", "payload": _table(_BLOCKS, _el())},
    "日本": {"kind": "table", "payload": _table(_BLOCKS, _el())},
    "t_alpha": {
        "kind": "table",
        "payload": _table(
            _scope_rows(["Block"], {**_NAME_IS, "value": "alpha"}),
            _header(_el(), "Block"),
            _header(_prop("tags", "expand"), "Tag"),
        ),
    },
}


def _entry(ref: str, **fields: Any) -> dict[str, Any]:
    return {"source": {"ref": ref}, **fields}


def _exporter(*entries: dict[str, Any], **output: Any) -> dict[str, Any]:
    return {"schema_version": 1, "output": output, "entries": list(entries)}


_FULL = _exporter(
    _entry("t_blocks", format="xlsx"),
    _entry("t_blocks", format="csv"),
    _entry("t_blocks", format="json", folder="${name}/${rev}"),
    _entry("t_probes", format="jsonl", name="${name}-${date}"),
    _entry("t_people", format="json", json_split=_split("${name}")),
    _entry(
        "t_people",
        format="jsonl",
        name="flat",
        split_folder=False,
        json_split=_split("${id}_${name}"),
    ),
    _entry("manifest", format="csv"),
    _entry("t_blocks", format="csv", name="manifest"),
    _entry("t_blocks", format="json", name="t_people"),
    _entry("t_blocks", format="csv", folder="t_people"),
    _entry("t_blocks", format="json", name="dup", folder="f/g"),
    _entry("t_blocks", format="json", name="dup", folder="f/g"),
)

_ARTIFACTS.update(
    {
        "x_full": {"kind": "exporter", "payload": _FULL},
        "x_bare": {
            "kind": "exporter",
            "payload": _exporter(_entry("t_blocks", format="csv"), mode="bare"),
        },
        "x_empty": {"kind": "exporter", "payload": _exporter()},
    }
)


# -- cases -----------------------------------------------------------------------


def _export(case: str, fmt: str, *, date: str = _DATE, **source: Any) -> Any:
    return export_step(case, "exportTable", date, format=fmt, **source)


def _preview(case: str, **params: Any) -> dict[str, Any]:
    return {**read_step("previewTableJson", **params), "case": case}


def _draft(case: str, definition: Any, *, date: str = _DATE, **body: Any) -> Any:
    return export_step(case, "runExporterDraft", date, definition=definition, **body)


def _saved_run(case: str, artifact_id: str, *, date: str = _DATE) -> Any:
    return export_step(case, "runExporter", date, artifact_id=artifact_id)


_TEXT_FORMATS = ("csv", "json", "jsonl")


def _text() -> list[dict[str, Any]]:
    rownum_mid = _with(
        _table(_BLOCKS, _header(_el(), "Block"), _prop("s"), _prop("tags")),
        show_row_numbers=True,
        export_order=[0, 99, -1, 0, 2],
        export_row_number={"header": "No.", "key": "n"},
    )
    hidden = _table(
        _BLOCKS,
        {
            **_header(_el(), "Hidden, shown"),
            "hidden": True,
            "export": {"include": True},
        },
        {**_prop("s"), "hidden": True},
        _exported(_header(_prop("tags"), "Shown, left out"), include=False),
        _exported(_header(_prop("i"), "I"), header='Over"ride'),
    )
    headers = _table(
        _BLOCKS,
        _header(_el(), 'comma, "quote"'),
        _header(_prop("s"), "line\nbreak"),
        _header(_prop("f"), "cr\rhere"),
        _header(_prop("b"), " lead space"),
    )
    blanks = _table(_scope_rows(["Gadget"]), _prop("undeclared"))
    two_blanks = _table(_scope_rows(["Gadget"]), _prop("undeclared"), _prop("s"))
    cases: list[dict[str, Any]] = []
    for fmt in _TEXT_FORMATS:
        cases += [
            _export(f"text_columns_{fmt}", fmt, definition=_COLUMNS),
            _export(
                f"text_rownum_first_{fmt}",
                fmt,
                definition=_with(_COLUMNS, show_row_numbers=True),
            ),
            _export(f"text_rownum_mid_{fmt}", fmt, definition=rownum_mid),
            _export(
                f"text_rownum_left_out_{fmt}",
                fmt,
                definition=_with(
                    rownum_mid, export_row_number={"include": False, "header": "x"}
                ),
            ),
            _export(f"text_hidden_{fmt}", fmt, definition=hidden),
            _export(f"text_headers_{fmt}", fmt, definition=headers),
            _export(f"text_values_{fmt}", fmt, definition=_PROBE_TABLE),
            _export(f"text_blank_{fmt}", fmt, definition=blanks),
            _export(f"text_two_blanks_{fmt}", fmt, definition=two_blanks),
            _export(f"text_empty_{fmt}", fmt, artifact_id="t_empty"),
            _export(f"text_saved_{fmt}", fmt, artifact_id="t_blocks"),
            _export(f"text_people_{fmt}", fmt, definition=_PEOPLE_LINKED),
        ]
    cases += [
        # the table's own split ignored by CSV
        _export("text_split_ignored_csv", "csv", artifact_id="t_people"),
        _export("text_unknown_artifact_csv", "csv", artifact_id="gone"),
        _export("text_not_a_table_csv", "csv", artifact_id="n_links"),
        _export(
            "text_unknown_navigation_json",
            "json",
            definition=_table(_BLOCKS, _nav({"ref": "gone"})),
        ),
        _export(
            "text_bad_body_csv",
            "csv",
            definition=_table(_BLOCKS, _el()),
            artifact_id="t_blocks",
        ),
        _export("text_bad_format", "yaml", definition=_table(_BLOCKS, _el())),
    ]
    return cases


def _text_json() -> list[dict[str, Any]]:
    links = _nav(_inline(_ROW_LINKS))
    owner = _nav(_inline(_path(_ROW, _step("owner"))))
    parts = _nav(_inline(_path(_ROW, _step("parts"))))
    keys = _table(
        _BLOCKS,
        _json(_header(_el(), "Block"), key="block"),
        _header(_prop("s"), "Name"),
        _header(_prop("i"), "Name"),
        _header(_prop("f"), "Name_2"),
        _prop("b"),
        _json(_header(_prop("d"), "D"), key="block"),
        _json(_prop("tags"), key=""),
    )
    group = _table(
        _BLOCKS,
        _header(_el(), "Block"),
        _json(_header(_nav(_inline(_ROW_LINKS), "expand"), "Links"), group=True),
        _header(_prop("name", source=_ref(1)), "Link name"),
        _header(_prop("tags", source=_ref(1)), "Link tags"),
        sort=[_asc(0)],
    )
    nested = _table(
        _BLOCKS,
        _header(_el(), "Block"),
        _json(
            _header(_nav(_inline(_ROW_EITHER), "expand"), "Near"),
            group=True,
            item_key="near",
        ),
        _json(
            _header(_prop("tags", "expand", source=_ref(1)), "Tags"),
            group=True,
            item_key="Near",
        ),
        _header(_prop("s", source=_ref(1)), "Near s"),
        _json(_header(_prop("i", source=_ref(1)), "I"), key="near"),
    )
    lone = _table(
        _BLOCKS,
        _header(_el(), "Block"),
        _json(_header(_prop("tags", "expand"), "Tags"), group=True, item_key="tag"),
        _json(_header(_nav(_inline(_ROW_LINKS), "expand"), "Links"), group=True),
    )
    stale_group = _table(
        _BLOCKS,
        _header(_el(), "Block"),
        _json(_header(_prop("tags"), "Collapsed"), group=True),
        {
            **_json(_header(_prop("mixed", "expand"), "Hidden"), group=True),
            "hidden": True,
        },
    )
    cases: list[dict[str, Any]] = [
        _export("text_json_keys", "json", definition=keys),
        *[
            _export(
                f"text_json_value_{mode}",
                "json",
                definition=_table(
                    _scope_rows(["Block", "Gadget"]),
                    _json(_header(_el(), "El"), value=mode),
                    _json(_header(links, "Links"), value=mode),
                    _json(_header(_prop("owner"), "Owner"), value=mode),
                    _json(_header(_prop("parts"), "Parts"), value=mode),
                    _json(_header(owner, "Owner nav"), value=mode),
                    _json(_header(parts, "Parts nav"), value=mode),
                    _json(
                        _header(_nav(_inline(_ROW_LINKS), "expand"), "Each"), value=mode
                    ),
                ),
            )
            for mode in ("name", "id", "object")
        ],
        _export(
            "text_json_single_ok",
            "json",
            definition=_table(
                _BLOCKS,
                _header(_el(), "Block"),
                _json(_header(owner, "Owner"), single=True),
                _json(_header(owner, "Owner id"), single=True, value="id"),
                _json(
                    _header(_nav(_inline(_path(_ROW, _step("s")))), "S"), single=True
                ),
                _json(_header(_prop("tags"), "Tags"), single=True),
            ),
        ),
        _export(
            "text_json_single_many_elements",
            "json",
            definition=_table(
                _BLOCKS, _el(), _json(_header(links, "Links"), single=True)
            ),
        ),
        _export(
            "text_json_single_many_values",
            "json",
            definition=_table(
                _BLOCKS,
                _el(),
                _json(_header(_nav(_inline(_ROW_TAGS)), "T"), single=True),
            ),
        ),
        _export("text_json_group", "json", definition=group),
        _export("text_jsonl_group", "jsonl", definition=group),
        _export(
            "text_json_group_rownum",
            "json",
            definition=_with(
                group, show_row_numbers=True, export_order=[1, -1, 0, 2, 3]
            ),
        ),
        _export("text_json_group_nested", "json", definition=nested),
        _export("text_json_group_lone", "json", definition=lone),
        _export("text_json_group_stale", "json", definition=stale_group),
        _export("text_json_group_equal", "json", artifact_id="t_tags"),
        _export(
            "text_json_bucket_equal",
            "json",
            definition=_table(
                _BLOCKS,
                _header(_prop("tags", "expand"), "Tag"),
                _json(
                    _header(_nav(_inline(_ROW_LINKS), "expand"), "Links"), group=True
                ),
            ),
        ),
        # element-typed properties naming no element: dropped, in every mode
        *[
            _export(
                f"text_json_dangling_{mode}",
                "json",
                definition=_table(
                    _scope_rows(["Block"], {**_NAME_IS, "value": "Delta"}),
                    _json(_header(_prop("owner"), "Owner"), value=mode),
                    _json(_header(_prop("parts"), "Parts"), value=mode),
                    _json(_header(parts, "Parts nav"), value=mode),
                ),
            )
            for mode in ("name", "object")
        ],
    ]
    return cases


def _text_preview() -> list[dict[str, Any]]:
    wide = _table(
        _scope_rows(),
        _header(_el(), "El"),
        _header(_nav(_inline(_EVERYTHING), "expand"), "Other"),
    )
    grouped = _table(
        _scope_rows(),
        _header(_el(), "El"),
        _json(_header(_nav(_inline(_EVERYTHING), "expand"), "Other"), group=True),
    )
    tags_grouped = _table(
        _BLOCKS,
        _header(_el(), "Block"),
        _json(_header(_prop("tags", "expand"), "Tags"), group=True),
    )
    return [
        _preview("text_preview_truncated", definition=wide),
        _preview("text_preview_grouped_truncated", definition=grouped),
        _preview(
            "text_preview_one_group",
            definition=_table(
                _scope_rows(["Leaf"], {**_NAME_IS, "value": "epsilon"}),
                _el(),
                _json(_nav(_inline(_EVERYTHING), "expand"), group=True),
            ),
        ),
        _preview("text_preview_whole", definition=_COLUMNS),
        _preview(
            "text_preview_rownum",
            definition=_with(tags_grouped, show_row_numbers=True),
        ),
        _preview("text_preview_saved", artifact_id="t_blocks"),
        _preview("text_preview_split_ignored", artifact_id="t_people"),
        _preview("text_preview_empty", artifact_id="t_empty"),
        _preview(
            "text_preview_unknown_navigation",
            definition=_table(_BLOCKS, _nav({"ref": "gone"})),
        ),
        _preview("text_preview_bad_body"),
    ]


def _splits() -> list[dict[str, Any]]:
    tags = _table(
        _BLOCKS,
        _header(_el(), "Block"),
        _header(_prop("tags", "expand"), "Tag"),
    )
    cases: list[dict[str, Any]] = []
    for fmt in ("json", "jsonl"):
        cases += [
            _export(f"split_{fmt}_saved", fmt, artifact_id="t_people"),
            *[
                _export(
                    f"split_{fmt}_{label}",
                    fmt,
                    definition=_with(_PEOPLE_LINKED, json_split=_split(template)),
                )
                for label, template in (
                    ("name", "${name}"),
                    ("id_name", "${id} ${name}"),
                    ("context", "${name}-${rev}-${date}-${project}"),
                    ("unsafe", "${name}/..\\${name}"),
                    ("dots", "..${name}.."),
                )
            ],
            _export(
                f"split_{fmt}_equal_values",
                fmt,
                definition=_with(tags, json_split=_split("${name}")),
            ),
            _export(
                f"split_{fmt}_grouped",
                fmt,
                definition=_with(
                    _table(
                        _BLOCKS,
                        _header(_el(), "Block"),
                        _json(_header(_prop("tags", "expand"), "Tags"), group=True),
                    ),
                    json_split=_split("${name}"),
                ),
            ),
            _export(
                f"split_{fmt}_empty",
                fmt,
                definition=_with(_table(_NONE, _el()), json_split=_split("${name}")),
            ),
            _export(
                f"split_{fmt}_disabled",
                fmt,
                definition=_with(
                    tags, json_split={"enabled": False, "filename_template": ""}
                ),
            ),
            _export(
                f"split_{fmt}_no_name",
                fmt,
                definition=_with(tags, json_split=_split("${id}")),
            ),
            _export(
                f"split_{fmt}_unknown_token",
                fmt,
                definition=_with(tags, json_split=_split("${name}${nope}${a}")),
            ),
        ]
    return cases


def _xlsx() -> list[dict[str, Any]]:
    types = _with(
        _table(
            _PROBE_ROWS,
            _header(_el(), "Probe"),
            _header(_prop("score"), "Score"),
            _header(_prop("tags"), "Tags"),
            _header(_nav(_inline(_path(_ROW, _step("tags")))), "Tag values"),
            _header(_nav(_inline(_path(_scope(["Person"]), _hop("Links")))), "Links"),
        ),
        show_row_numbers=True,
        export_order=[0, -1],
    )
    return [
        _export("xlsx_types", "xlsx", definition=types),
        _export(
            "xlsx_autofit_cap",
            "xlsx",
            definition=_table(
                _CAP_ROWS, _header(_el(), "Cap"), _header(_prop("s"), "S")
            ),
        ),
        _export("xlsx_title", "xlsx", artifact_id=_LATIN_TITLE),
        _export("xlsx_title_blank", "xlsx", artifact_id="'''"),
        _export("xlsx_title_non_latin1", "xlsx", artifact_id="日本"),
        _export("xlsx_empty", "xlsx", artifact_id="t_empty"),
        _export("xlsx_split", "xlsx", artifact_id="t_people"),
        _export("xlsx_columns", "xlsx", definition=_COLUMNS),
        _export(
            "xlsx_headers_long",
            "xlsx",
            definition=_table(
                _BLOCKS,
                _header(_el(), "A header far wider than any block name"),
                _header(_prop("b"), "B"),
                _header(_prop("i"), "i"),
            ),
        ),
    ]


def _runs() -> list[dict[str, Any]]:
    overrides = _exporter(
        _entry(
            "t_blocks",
            format="csv",
            columns=[
                {"index": 99, "export": {"header": "never"}},
                {"index": 1, "export": {"header": "First S"}},
                {"index": 1, "export": {"header": "Second S"}},
                {"index": 2, "export": {"include": False}},
            ],
            export_order=[3, -1, 1],
            show_row_numbers=True,
            export_row_number={"header": "Row", "key": "row"},
        ),
        _entry(
            "t_blocks",
            format="json",
            columns=[
                {"index": 0, "json_export": {"key": "id", "value": "id"}},
                {"index": 0, "json_export": {"key": "late"}},
                {"index": 3, "json_export": {"value": "object"}},
            ],
            export_order=[3, 0],
        ),
        _entry("t_people", format="json", name="plain people"),
        _entry("t_tags", format="json", name="no group"),
    )

    def doc(**options: Any) -> dict[str, Any]:
        return _exporter(_entry("t_blocks", format="json", json_doc=options))

    return [
        _saved_run("run_zip_manifest", "x_full"),
        _draft("run_zip_draft", _FULL, name="My export: v1/2"),
        _draft("run_zip_draft_unnamed", _FULL),
        _draft(
            "run_zip_no_manifest",
            _exporter(
                _entry("manifest", format="csv"),
                _entry("t_blocks", format="xlsx", name="manifest"),
                manifest=False,
            ),
        ),
        _draft(
            "run_zip_filename_tokens",
            _exporter(
                _entry("t_blocks", format="csv", name="${name}_${rev}_${date}"),
                filename="${name}-${rev}-${date}-${project}",
            ),
            date="20261231",
            name="tok",
        ),
        _draft(
            "run_zip_filename_unsafe",
            _exporter(_entry("t_blocks", format="csv"), filename="../${name}/.."),
            name="a:b",
        ),
        _draft(
            "run_zip_filename_blank",
            _exporter(_entry("t_blocks", format="csv"), filename="   "),
            name="///",
        ),
        _draft(
            "run_zip_filename_non_ascii",
            _exporter(_entry("t_blocks", format="csv")),
            name="日本 𝒜é",
        ),
        _draft(
            "run_bare_non_ascii",
            _exporter(_entry("t_blocks", format="csv", name="日本 é"), mode="bare"),
        ),
        _draft(
            "run_zip_filename_unknown",
            _exporter(_entry("t_blocks", format="csv"), filename="${name}${id}${x}"),
        ),
        _saved_run("run_bare_one", "x_bare"),
        _draft(
            "run_bare_json",
            _exporter(
                _entry("t_blocks", format="json", folder="deep/er"),
                mode="bare",
                filename="ignored",
            ),
        ),
        _draft(
            "run_bare_xlsx",
            _exporter(
                _entry("t_probes", format="xlsx", name="probe book"), mode="bare"
            ),
        ),
        _draft(
            "run_bare_two",
            _exporter(
                _entry("t_blocks", format="csv"),
                _entry("t_blocks", format="json"),
                mode="bare",
            ),
        ),
        _draft(
            "run_bare_split",
            _exporter(
                _entry("t_people", format="json", json_split=_split("${name}")),
                mode="bare",
            ),
        ),
        _draft(
            "run_bare_split_many",
            _exporter(
                _entry(
                    "t_blocks",
                    format="jsonl",
                    split_folder=False,
                    json_split=_split("${name}"),
                ),
                mode="bare",
            ),
        ),
        *[
            _draft(
                f"run_bare_split_one_{label}",
                _exporter(
                    _entry(
                        "t_alpha",
                        format="json",
                        folder="f",
                        split_folder=split_folder,
                        json_split=_split("${name}-${id}"),
                    ),
                    mode="bare",
                ),
            )
            for label, split_folder in (("flat", False), ("folder", True))
        ],
        _draft(
            "run_xlsx_title_astral",
            _exporter(_entry("t_blocks", format="xlsx", name=_ASTRAL_TITLE)),
        ),
        _draft("run_no_entries", _exporter()),
        _saved_run("run_no_entries_saved", "x_empty"),
        _saved_run("run_unknown_id", "gone"),
        _saved_run("run_kind_table", "t_blocks"),
        _draft(
            "run_refuse_lists",
            _exporter(
                _entry("gone", format="csv", name="missing one"),
                _entry("n_links", format="csv"),
                _entry("t_blocks", format="csv", name="${nope}"),
                _entry("t_blocks", format="csv", folder="/abs"),
            ),
        ),
        _draft(
            "run_refuse_templates",
            _exporter(
                _entry("t_blocks", format="csv", name="${nope}${name}${b}"),
                _entry("t_blocks", format="csv", folder="/abs"),
                _entry("t_blocks", name="named", format="csv", folder="a//b"),
                _entry("t_blocks", format="csv", folder="\\back"),
                _entry("t_blocks", format="csv", folder="${id}"),
                _entry("t_blocks", format="json", json_split=_split("${id}")),
                _entry("t_blocks", format="jsonl", json_split=_split("${name}${rev2}")),
                # a split template on csv is never read
                _entry("t_blocks", format="csv", json_split=_split("${id}")),
            ),
        ),
        _draft("run_overrides", overrides),
        _draft(
            "run_json_doc_object",
            doc(shape="object", key_column=0, pretty=False),
        ),
        _draft("run_json_doc_object_pretty", doc(shape="object", key_column=0)),
        _draft("run_json_doc_key_empty", doc(shape="object", key_column=1)),
        _draft(
            "run_json_doc_key_duplicate",
            _exporter(
                _entry(
                    "t_s",
                    format="json",
                    json_doc={"shape": "object", "key_column": 1},
                ),
            ),
        ),
        _draft("run_json_doc_compact", doc(pretty=False)),
        _draft("run_json_doc_on_error", doc(on_error="fail")),
        _draft(
            "run_json_doc_object_no_key",
            doc(shape="object"),
        ),
        _draft(
            "run_json_doc_key_out_of_range",
            doc(shape="object", key_column=9),
        ),
        _draft(
            "run_json_doc_key_list",
            doc(shape="object", key_column=2),
        ),
        _draft(
            "run_json_doc_key_navigation",
            doc(shape="object", key_column=3),
        ),
        _draft(
            "run_json_doc_key_equal",
            _exporter(
                _entry(
                    "t_doc_tags",
                    format="json",
                    json_doc={"shape": "object", "key_column": 1},
                )
            ),
        ),
        _draft(
            "run_json_doc_jsonl",
            _exporter(
                _entry(
                    "t_blocks",
                    format="jsonl",
                    json_doc={"shape": "object", "key_column": 0, "pretty": True},
                )
            ),
        ),
        _draft(
            "run_json_doc_split_object",
            _exporter(
                _entry(
                    "t_blocks",
                    format="json",
                    json_split=_split("${name}"),
                    json_doc={"shape": "object", "key_column": 0, "pretty": False},
                )
            ),
        ),
        _draft(
            "run_json_doc_csv_ignored",
            _exporter(
                _entry(
                    "t_blocks",
                    format="csv",
                    json_doc={"shape": "object", "key_column": 99},
                )
            ),
        ),
        _draft(
            "run_bad_body",
            {"schema_version": 1, "entries": [{"source": {}}]},
        ),
    ]


def _reach() -> list[dict[str, Any]]:
    inline = {"definition": _TRANSFORM_CODE}
    return [
        _draft(
            "reach_entry_inline",
            _exporter(_entry("t_blocks", format="json", transform=inline)),
        ),
        _draft(
            "reach_entry_ref",
            _exporter(
                _entry("t_blocks", format="csv"),
                _entry("t_blocks", format="jsonl", transform={"ref": "s_transform"}),
            ),
        ),
        _draft(
            "reach_entry_script_table",
            _exporter(
                _entry("t_blocks", format="csv"), _entry("t_script", format="csv")
            ),
        ),
        _draft(
            "reach_entry_script_navigation",
            _exporter(_entry("t_script_nav", format="json")),
        ),
        _export("reach_script_column_csv", "csv", artifact_id="t_script"),
        _export("reach_script_column_xlsx", "xlsx", artifact_id="t_script"),
        _export("reach_script_navigation_json", "json", artifact_id="t_script_nav"),
        _export(
            "reach_script_inline_json",
            "json",
            definition=_table(
                _BLOCKS,
                _el(),
                _nav(_inline(_path(_ROW, _script_step({"ref": "s_step"})))),
            ),
        ),
        _export("reach_table_transform_json", "json", artifact_id="t_transform"),
        _export("reach_table_transform_csv", "csv", artifact_id="t_transform"),
        _export(
            "reach_table_transform_inline_jsonl",
            "jsonl",
            definition=_with(_table(_BLOCKS, _el()), transform=inline),
        ),
        _preview("reach_preview_script", artifact_id="t_script"),
        # a transform on xlsx and csv is a bad transform, after the other lists
        _draft(
            "reach_refuse_lists",
            _exporter(
                _entry("gone", format="csv"),
                _entry("t_blocks", format="csv", name="${nope}"),
                _entry("t_blocks", format="xlsx", transform=inline),
            ),
        ),
        _draft(
            "reach_refuse_templates_transforms",
            _exporter(
                _entry("t_blocks", format="json", transform={"ref": "gone"}),
                _entry("t_blocks", format="csv", folder="/abs"),
            ),
        ),
        _draft(
            "reach_refuse_transforms",
            _exporter(
                _entry("t_blocks", format="xlsx", name="book", transform=inline),
                _entry("t_blocks", format="csv", transform={"ref": "s_transform"}),
                _entry("t_blocks", format="json", transform={"ref": "gone"}),
                _entry("t_blocks", format="json", transform={"ref": "s_step"}),
                _entry(
                    "t_blocks",
                    format="json",
                    transform={"definition": {"code": "def nope(:\n"}},
                ),
                _entry("t_blocks", format="json", transform={}),
            ),
        ),
    ]


# -- scripts ---------------------------------------------------------------------

#: more gadgets than a transform preview's 200 files, named for a criterion no
#: other table reads; ``i`` is an index-like key
_BULK = 205
_BULK_ELEMENTS = [
    {
        "kind": "create_element",
        "temp_id": f"tmp_bulk{n}",
        "type_name": "Gadget",
        "properties": {"name": f"bulk-{n:03d}", "i": n},
    }
    for n in range(_BULK)
]
_BULK_ROWS = _scope_rows(
    ["Gadget"], {"type": "name_id", "field": "name", "op": "contains", "value": "bulk-"}
)


def _fn(args: str, *lines: str, name: str = "value") -> dict[str, Any]:
    body = "".join(f"    {line}\n" for line in lines)
    return {"definition": {"code": f"def {name}({args}):\n{body}"}}


_V_NAME = _fn("els", "return els[0].name")
_V_TAGS = _fn("els", 'return els[0].get("tags") or []')
_V_NUMBERS = _fn("els", "return [1, 1.0, 2.5, -0.0, 1e16, 2**70, None, True]")
_V_NONE = _fn("els", "return None")
_V_LINK = _fn(
    "els",
    'out = els[0].outgoing(stereotype="Links")',
    "return out[0].destination() if out else None",
)
_V_BOOM = _fn(
    "els",
    'if int(els[0].id.split("-")[1]) % 3 == 0:',
    '    raise KeyError("boom " + els[0].id)',
    "return els[0].name",
)
_V_SYNTAX = {"definition": {"code": "def value(els:\n    return 1\n"}}
_V_BAD_RETURN = _fn("els", 'return {"a": 1}')
_V_BIG = _fn("els", 'return "y" * 45000')

_T_WRAP = (
    'def transform(doc):\n    print("n=%d" % len(doc))\n'
    '    return {"count": len(doc), "doc": doc}\n'
)
_T_LIST = (
    "def transform(doc):\n"
    '    return [{"row": d} for d in doc] + [None, 1.5, "é", [1, [2]]]\n'
)
_T_DICT = 'def transform(doc):\n    return {"n": len(doc)}\n'
_T_RAISE = 'def transform(doc):\n    raise ValueError("no way")\n'
_T_BOOT = 'raise RuntimeError("boot")\n\ndef transform(doc):\n    return doc\n'
_T_ORDER = "def transform(doc):\n    return dict(sorted(doc.items(), reverse=True))\n"
_T_KEYS = (
    "def transform(doc):\n"
    '    return {"3": 1, "1": 2, "2": 3, "a": 4, "10": {"7": 0, "5": [1.0, 2**70]}}\n'
)
_T_ANY_ARITY = (
    "def transform(a, b):\n    return None\n\ndef transform(doc):\n    return doc\n"
)
_T_ARITY_TWO = "def transform(a, b):\n    return None\n"
_T_NOTHING = "x = 1\n"
_T_BIG_RESULT = 'def transform(doc):\n    return ["x" * 1000] * 9000\n'
_T_SURROGATE = 'def transform(doc):\n    return ["\\ud800"]\n'
_T_SOME = (
    "def transform(doc):\n"
    '    if "dup" in str(doc):\n        raise KeyError("dup file")\n'
    '    return {"ok": len(doc)}\n'
)
_T_NUMBERS = (
    "def transform(doc):\n"
    '    return {"a": 1.0, "b": 2**70, "c": -0.0, "d": [1e16, 0.1], "e": "é\\u2028"}\n'
)

#: code the scan of the engine cannot tell from valid code, which `ast.parse` refuses
_T_NO_COLON = "def transform(doc)\n    return doc\n"
_T_DANGLING = "def transform(doc):\n    return doc +\n"
_T_INDENT = "def transform(doc):\nreturn doc\n"

_SCRIPT_ARTIFACTS: dict[str, dict[str, Any]] = {
    "s_t_no_colon": {"kind": "code_snippet", "payload": {"code": _T_NO_COLON}},
    "s_t_dangling": {"kind": "code_snippet", "payload": {"code": _T_DANGLING}},
    "s_t_wrap": {"kind": "code_snippet", "payload": {"code": _T_WRAP}},
    "s_t_list": {"kind": "code_snippet", "payload": {"code": _T_LIST}},
    "s_t_dict": {"kind": "code_snippet", "payload": {"code": _T_DICT}},
    "s_t_raise": {"kind": "code_snippet", "payload": {"code": _T_RAISE}},
    "s_t_boot": {"kind": "code_snippet", "payload": {"code": _T_BOOT}},
    "s_t_order": {"kind": "code_snippet", "payload": {"code": _T_ORDER}},
    "s_t_keys": {"kind": "code_snippet", "payload": {"code": _T_KEYS}},
    "s_t_any_arity": {"kind": "code_snippet", "payload": {"code": _T_ANY_ARITY}},
    "s_t_arity_two": {"kind": "code_snippet", "payload": {"code": _T_ARITY_TWO}},
    "s_t_nothing": {"kind": "code_snippet", "payload": {"code": _T_NOTHING}},
    "s_t_big_result": {"kind": "code_snippet", "payload": {"code": _T_BIG_RESULT}},
    "s_t_surrogate": {"kind": "code_snippet", "payload": {"code": _T_SURROGATE}},
    "s_t_some": {"kind": "code_snippet", "payload": {"code": _T_SOME}},
    "s_t_numbers": {"kind": "code_snippet", "payload": {"code": _T_NUMBERS}},
    "t_sv": {
        "kind": "table",
        "payload": _table(
            _BLOCKS,
            _header(_el(), "Block"),
            _header(_script(_V_NAME), "Name"),
            _header(_script(_V_TAGS), "Tags"),
            _header(_script(_V_NUMBERS), "Numbers"),
            _header(_script(_V_NONE), "Nothing"),
            _header(_script(_V_LINK), "Link"),
            sort=[_asc(0)],
        ),
    },
    "t_serr": {
        "kind": "table",
        "payload": _table(
            _BLOCKS,
            _header(_el(), "Block"),
            _header(_script(_V_NAME), "Name"),
            _header(_script(_V_BOOM), "Boom"),
            _header(_script(_V_SYNTAX), "Syntax"),
            _header(_script(_V_BAD_RETURN), "Bad"),
            _header(_script({}), "Unset"),
            sort=[_asc(0)],
        ),
    },
    "t_tr_wrap": {
        "kind": "table",
        "payload": _with(
            _table(_BLOCKS, _header(_el(), "Block"), _header(_prop("s"), "S")),
            transform={"ref": "s_t_wrap"},
        ),
    },
    "t_tr_list": {
        "kind": "table",
        "payload": _with(
            _table(_BLOCKS, _header(_el(), "Block"), _header(_prop("s"), "S")),
            transform={"ref": "s_t_list"},
        ),
    },
    "t_tr_split": {
        "kind": "table",
        "payload": _with(
            _PEOPLE_LINKED,
            json_split=_split("${name}"),
            transform={"ref": "s_t_wrap"},
        ),
    },
    "t_tr_scripts": {
        "kind": "table",
        "payload": _with(
            _table(
                _BLOCKS,
                _header(_el(), "Block"),
                _header(_script(_V_NAME), "Name"),
                _header(_script(_V_BOOM), "Boom"),
                sort=[_asc(0)],
            ),
            transform={"ref": "s_t_wrap"},
        ),
    },
    "t_bulk": {
        "kind": "table",
        "payload": _table(
            _BULK_ROWS,
            _header(_prop("i"), "I"),
            _header(_prop("name"), "Name"),
            sort=[_desc(0)],
        ),
    },
    "t_bulk_split": {
        "kind": "table",
        "payload": _with(
            _table(_BULK_ROWS, _header(_prop("i"), "I"), _header(_el(), "Gadget")),
            json_split=_split("${name}"),
            transform={"ref": "s_t_wrap"},
        ),
    },
    "t_big": {
        "kind": "table",
        "payload": _table(
            _BULK_ROWS, _header(_prop("i"), "I"), _header(_script(_V_BIG), "Big")
        ),
    },
}
_SCRIPT_ARTIFACTS["x_script"] = {
    "kind": "exporter",
    "payload": _exporter(
        _entry("t_sv", format="csv"),
        _entry("t_serr", format="csv", name="errors"),
        _entry(
            "t_blocks",
            format="json",
            name="wrapped",
            transform={"ref": "s_t_wrap"},
        ),
    ),
}


def _scripted(step: dict[str, Any]) -> dict[str, Any]:
    return {**step, "scripted": True}


def _s_export(case: str, fmt: str, **source: Any) -> dict[str, Any]:
    return _scripted(_export(f"script_{case}", fmt, **source))


def _s_draft(case: str, definition: Any) -> dict[str, Any]:
    return _scripted(_draft(f"script_{case}", definition))


def _s_preview(case: str, entry: dict[str, Any]) -> dict[str, Any]:
    step = read_step(
        "previewTransform",
        scripted=True,
        entry=entry,
        date=_DATE,
        project="p",
    )
    return {**step, "case": f"script_{case}"}


def _inline_transform(code: str) -> dict[str, Any]:
    return {"definition": {"code": code}}


def _scripts_cells() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for fmt in ("csv", "xlsx", "json", "jsonl"):
        cases += [
            _s_export(f"values_{fmt}", fmt, artifact_id="t_sv"),
            _s_export(f"errors_{fmt}", fmt, artifact_id="t_serr"),
        ]
    cases += [
        _s_export(
            "expand_json",
            "json",
            definition=_table(
                _BLOCKS,
                _el(),
                _nav(_inline(_ROW_LINKS)),
                _script(_V_TAGS, "expand"),
                _script(_V_NAME, source=_ref(1)),
            ),
        ),
        _s_draft(
            "run_clean",
            _exporter(
                _entry("t_sv", format="csv"),
                _entry("t_sv", format="json", folder="j"),
                _entry("t_sv", format="xlsx"),
            ),
        ),
        _s_draft(
            "run_errors",
            _exporter(
                _entry("t_sv", format="csv"),
                _entry("t_serr", format="csv", name="errors"),
                _entry("t_serr", format="xlsx", name="book"),
                _entry("t_blocks", format="csv"),
            ),
        ),
        _scripted(_saved_run("script_run_saved", "x_script")),
        _s_draft(
            "run_bare_errors",
            _exporter(_entry("t_serr", format="json"), mode="bare"),
        ),
    ]
    return cases


def _scripts_transforms() -> list[dict[str, Any]]:
    inline = _inline_transform("def transform(doc):\n    return doc\n")

    def entry(table: str, **fields: Any) -> dict[str, Any]:
        return _entry(table, **fields)

    cases: list[dict[str, Any]] = [
        _s_export("transform_table_json", "json", artifact_id="t_tr_wrap"),
        _s_export("transform_table_jsonl_dict", "jsonl", artifact_id="t_tr_wrap"),
        _s_export("transform_table_jsonl_list", "jsonl", artifact_id="t_tr_list"),
        _s_export("transform_table_csv", "csv", artifact_id="t_tr_wrap"),
        _s_export("transform_table_xlsx", "xlsx", artifact_id="t_tr_wrap"),
        _s_export(
            "transform_table_inline_json",
            "json",
            definition=_with(_table(_BLOCKS, _el(), _prop("s")), transform=inline),
        ),
        _s_export("transform_table_split_json", "json", artifact_id="t_tr_split"),
        _s_export(
            "transform_table_split_jsonl_list",
            "jsonl",
            definition=_with(
                _PEOPLE_LINKED,
                json_split=_split("${name}"),
                transform={"ref": "s_t_list"},
            ),
        ),
        _s_export("transform_table_scripts_json", "json", artifact_id="t_tr_scripts"),
        _s_export("transform_table_bulk_split_json", "json", artifact_id="t_bulk_split"),
        _s_export(
            "transform_table_bad_split",
            "json",
            definition=_with(
                _table(_BLOCKS, _el()),
                json_split=_split("${name}${nope}"),
                transform=inline,
            ),
        ),
        _s_export(
            "transform_table_bad_format_and_split",
            "csv",
            definition=_with(
                _table(_BLOCKS, _el()),
                json_split=_split("${name}${nope}"),
                transform=inline,
            ),
        ),
        _s_export(
            "transform_table_empty",
            "json",
            definition=_with(_table(_BLOCKS, _el()), transform={}),
        ),
        _s_export(
            "transform_table_not_a_snippet",
            "json",
            definition=_with(_table(_BLOCKS, _el()), transform={"ref": "n_links"}),
        ),
        _s_export(
            "transform_table_gone",
            "json",
            definition=_with(_table(_BLOCKS, _el()), transform={"ref": "gone"}),
        ),
        _s_export(
            "transform_table_floats",
            "json",
            definition=_with(
                _table(_BLOCKS, _el()), transform={"ref": "s_t_numbers"}
            ),
        ),
    ]
    runs: list[tuple[str, dict[str, Any]]] = [
        (
            "run_transform_inline",
            _exporter(
                entry("t_blocks", format="json", transform=inline),
                entry(
                    "t_blocks",
                    format="json",
                    name="compact",
                    json_doc={"pretty": False},
                    transform=inline,
                ),
            ),
        ),
        (
            "run_transform_mixed",
            _exporter(
                entry("t_blocks", format="csv"),
                entry("t_blocks", format="json", transform={"ref": "s_t_wrap"}),
                entry("t_probes", format="jsonl", transform={"ref": "s_t_list"}),
                entry("t_blocks", format="json", name="same", transform=inline),
                entry("t_blocks", format="json", name="same", transform=inline),
                entry("t_blocks", format="jsonl", transform={}),
            ),
        ),
        (
            "run_transform_shared_code",
            _exporter(
                entry("t_blocks", format="json", transform={"ref": "s_t_dict"}),
                entry(
                    "t_probes",
                    format="json",
                    name="by ref",
                    transform=_inline_transform(_T_DICT),
                ),
            ),
        ),
        (
            "run_transform_split",
            _exporter(
                entry(
                    "t_people",
                    format="json",
                    json_split=_split("${name}"),
                    transform={"ref": "s_t_wrap"},
                ),
            ),
        ),
        (
            "run_transform_split_fails",
            _exporter(
                entry(
                    "t_people",
                    format="json",
                    json_split=_split("${name}"),
                    transform={"ref": "s_t_some"},
                ),
            ),
        ),
        (
            "run_transform_split_two",
            _exporter(
                entry(
                    "t_alpha",
                    format="json",
                    json_split=_split("${name}-${id}"),
                    transform={"ref": "s_t_wrap"},
                ),
                entry(
                    "t_blocks",
                    format="jsonl",
                    json_split=_split("${name}"),
                    split_folder=False,
                    transform={"ref": "s_t_list"},
                ),
                mode="zip",
            ),
        ),
        (
            "run_transform_object_keys",
            _exporter(
                entry(
                    "t_bulk",
                    format="json",
                    json_doc={"shape": "object", "key_column": 0, "pretty": False},
                    transform={"ref": "s_t_order"},
                ),
            ),
        ),
        (
            "run_transform_object_keys_identity",
            _exporter(
                entry(
                    "t_bulk",
                    format="json",
                    json_doc={"shape": "object", "key_column": 0},
                    transform=inline,
                ),
            ),
        ),
        (
            "run_transform_key_order",
            _exporter(entry("t_blocks", format="json", transform={"ref": "s_t_keys"})),
        ),
        (
            "run_transform_scripts",
            _exporter(
                entry("t_sv", format="json", transform={"ref": "s_t_wrap"}),
                entry("t_serr", format="jsonl", transform={"ref": "s_t_list"}),
            ),
        ),
        (
            "run_transform_dict_for_jsonl",
            _exporter(entry("t_blocks", format="jsonl", transform={"ref": "s_t_dict"})),
        ),
        (
            "run_transform_raise",
            _exporter(
                entry("t_blocks", format="json", transform={"ref": "s_t_raise"})
            ),
        ),
        (
            "run_transform_raise_named",
            _exporter(
                entry("t_blocks", format="csv"),
                entry(
                    "t_blocks",
                    format="json",
                    name="after ${name}",
                    transform={"ref": "s_t_raise"},
                ),
            ),
        ),
        (
            "run_transform_boot",
            _exporter(entry("t_blocks", format="json", transform={"ref": "s_t_boot"})),
        ),
        (
            "run_transform_over_input",
            _exporter(entry("t_big", format="json", transform=inline)),
        ),
        (
            "run_transform_over_result",
            _exporter(
                entry("t_blocks", format="json", transform={"ref": "s_t_big_result"})
            ),
        ),
        (
            "run_transform_surrogate",
            _exporter(
                entry("t_blocks", format="json", transform={"ref": "s_t_surrogate"})
            ),
        ),
        (
            "run_transform_on_error_fail",
            _exporter(
                entry(
                    "t_serr",
                    format="json",
                    json_doc={"on_error": "fail"},
                    transform=inline,
                )
            ),
        ),
        (
            "run_transform_any_arity",
            _exporter(
                entry("t_blocks", format="json", transform={"ref": "s_t_any_arity"}),
                entry(
                    "t_blocks",
                    format="json",
                    name="inline",
                    transform=_inline_transform(_T_ANY_ARITY),
                ),
            ),
        ),
        (
            "run_transform_bare",
            _exporter(
                entry("t_blocks", format="json", transform={"ref": "s_t_wrap"}),
                mode="bare",
            ),
        ),
        (
            "run_transform_object_key_missing",
            _exporter(
                entry(
                    "t_blocks",
                    format="json",
                    json_doc={"shape": "object"},
                    transform=inline,
                )
            ),
        ),
    ]
    cases += [_s_draft(case, definition) for case, definition in runs]
    return cases


def _scripts_refusals() -> list[dict[str, Any]]:
    inline = _inline_transform("def transform(doc):\n    return doc\n")
    return [
        _s_draft(
            "refuse_lists",
            _exporter(
                _entry("gone", format="csv"),
                _entry("t_blocks", format="csv", name="${nope}"),
                _entry("t_blocks", format="xlsx", transform=inline),
            ),
        ),
        _s_draft(
            "refuse_templates_transforms",
            _exporter(
                _entry("t_blocks", format="json", transform={"ref": "gone"}),
                _entry("t_blocks", format="csv", folder="/abs"),
            ),
        ),
        _s_draft(
            "refuse_transforms",
            _exporter(
                _entry("t_blocks", format="xlsx", name="book", transform=inline),
                _entry("t_blocks", format="csv", transform={"ref": "s_transform"}),
                _entry("t_blocks", format="json", transform={"ref": "gone"}),
                _entry("t_blocks", format="json", transform={"ref": "s_step"}),
                _entry("t_blocks", format="json", transform={"ref": "n_links"}),
                _entry("t_blocks", format="json", transform={"ref": "s_t_arity_two"}),
                _entry("t_blocks", format="json", transform={"ref": "s_t_nothing"}),
                _entry(
                    "t_blocks",
                    format="json",
                    name="inline parse",
                    transform={"definition": {"code": "def nope(:\n"}},
                ),
                _entry(
                    "t_blocks",
                    format="json",
                    name="inline nothing",
                    transform=_inline_transform(_T_NOTHING),
                ),
                _entry(
                    "t_blocks",
                    format="json",
                    name="inline arity",
                    transform=_inline_transform(_T_ARITY_TWO),
                ),
                _entry(
                    "t_blocks",
                    format="json",
                    name="async",
                    transform=_inline_transform(
                        "async def transform(doc):\n    return doc\n"
                    ),
                ),
                _entry(
                    "t_blocks",
                    format="json",
                    name="nested",
                    transform=_inline_transform(
                        "if True:\n    def transform(doc):\n        return doc\n"
                    ),
                ),
                _entry("t_blocks", format="json", transform={}),
            ),
        ),
        _s_draft(
            "refuse_transform_bad_definition",
            _exporter(
                _entry(
                    "t_blocks",
                    format="json",
                    transform={"definition": {"code": "x", "language": "js"}},
                )
            ),
        ),
        _s_draft(
            "refuse_transform_both",
            _exporter(
                _entry(
                    "t_blocks",
                    format="json",
                    transform={"ref": "s_t_wrap", "definition": {"code": "x"}},
                )
            ),
        ),
    ]


def _scripts_syntax() -> list[dict[str, Any]]:
    """Transforms that do not parse, which the oracle refuses before anything runs."""
    inline = _inline_transform("def transform(doc):\n    return doc\n")
    bad = _inline_transform(_T_NO_COLON)
    wrap = {"ref": "s_t_wrap"}
    return [
        _s_export(
            "syntax_table_inline",
            "json",
            definition=_with(_table(_BLOCKS, _el()), transform=bad),
        ),
        _s_export(
            "syntax_table_saved",
            "jsonl",
            definition=_with(_table(_BLOCKS, _el()), transform={"ref": "s_t_dangling"}),
        ),
        _s_export(
            "syntax_table_indent",
            "json",
            definition=_with(
                _table(_BLOCKS, _el()), transform=_inline_transform(_T_INDENT)
            ),
        ),
        _s_draft(
            "syntax_run_inline",
            _exporter(_entry("t_blocks", format="json", transform=bad)),
        ),
        _s_draft(
            "syntax_run_saved",
            _exporter(_entry("t_blocks", format="json", transform={"ref": "s_t_no_colon"})),
        ),
        _s_draft(
            "syntax_run_all_listed",
            _exporter(
                _entry("t_blocks", format="json", name="first", transform=bad),
                _entry("t_blocks", format="json", name="fine", transform=inline),
                _entry("t_sv", format="json", transform={"ref": "s_t_dangling"}),
                _entry("t_blocks", format="jsonl", name="third", transform=bad),
            ),
        ),
        # an entry before it that would fail is not reached: the oracle refuses first
        _s_draft(
            "syntax_run_before_a_failure",
            _exporter(
                _entry("t_blocks", format="json", transform={"ref": "s_t_raise"}),
                _entry("t_blocks", format="json", name="syntax", transform=bad),
            ),
        ),
        _s_draft(
            "syntax_run_with_failure_alone",
            _exporter(
                _entry("t_blocks", format="json", transform={"ref": "s_t_raise"}),
                _entry("t_blocks", format="json", name="fine", transform=wrap),
            ),
        ),
        _s_preview(
            "syntax_preview_inline",
            _entry_preview("t_blocks", format="json", transform=bad),
        ),
        _s_preview(
            "syntax_preview_saved",
            _entry_preview("t_blocks", format="json", transform={"ref": "s_t_no_colon"}),
        ),
        _s_preview(
            "syntax_preview_split",
            _entry_preview(
                "t_people",
                format="json",
                json_split=_split("${name}"),
                transform=_inline_transform(_T_DANGLING),
            ),
        ),
    ]


def _entry_preview(table: str, **fields: Any) -> dict[str, Any]:
    return _entry(table, **fields)


def _scripts_previews() -> list[dict[str, Any]]:
    wrap = {"ref": "s_t_wrap"}
    inline = _inline_transform("def transform(doc):\n    return doc\n")
    cases = [
        _s_preview(
            "preview_unsplit",
            _entry_preview("t_blocks", format="json", transform=wrap),
        ),
        _s_preview(
            "preview_unsplit_named",
            _entry_preview(
                "t_blocks", format="json", name="my ${name}", transform=inline
            ),
        ),
        _s_preview(
            "preview_jsonl_list",
            _entry_preview("t_blocks", format="jsonl", transform={"ref": "s_t_list"}),
        ),
        _s_preview(
            "preview_jsonl_dict",
            _entry_preview("t_blocks", format="jsonl", transform={"ref": "s_t_dict"}),
        ),
        _s_preview(
            "preview_scripts",
            _entry_preview("t_sv", format="json", transform=wrap),
        ),
        _s_preview(
            "preview_script_errors",
            _entry_preview("t_serr", format="json", transform=wrap),
        ),
        _s_preview(
            "preview_object_keys",
            _entry_preview(
                "t_bulk",
                format="json",
                json_doc={"shape": "object", "key_column": 0, "pretty": False},
                transform={"ref": "s_t_order"},
            ),
        ),
        _s_preview(
            "preview_key_order",
            _entry_preview("t_blocks", format="json", transform={"ref": "s_t_keys"}),
        ),
        _s_preview(
            "preview_split_some_fail",
            _entry_preview(
                "t_people",
                format="json",
                json_split=_split("${name}"),
                transform={"ref": "s_t_some"},
            ),
        ),
        _s_preview(
            "preview_split_table_own",
            _entry_preview(
                "t_alpha",
                format="json",
                json_split=_split("${name}-${id}-${rev}-${date}-${project}"),
                transform=wrap,
            ),
        ),
        _s_preview(
            "preview_split_jsonl",
            _entry_preview(
                "t_blocks",
                format="jsonl",
                json_split=_split("${name}"),
                transform={"ref": "s_t_list"},
            ),
        ),
        _s_preview(
            "preview_split_empty",
            _entry_preview(
                "t_empty",
                format="json",
                json_split=_split("${name}"),
                transform=wrap,
            ),
        ),
        _s_preview(
            "preview_empty",
            _entry_preview("t_empty", format="json", transform=wrap),
        ),
        _s_preview(
            "preview_raise",
            _entry_preview("t_blocks", format="json", transform={"ref": "s_t_raise"}),
        ),
        _s_preview(
            "preview_boot",
            _entry_preview("t_blocks", format="json", transform={"ref": "s_t_boot"}),
        ),
        _s_preview(
            "preview_numbers",
            _entry_preview("t_blocks", format="json", transform={"ref": "s_t_numbers"}),
        ),
        _s_preview(
            "preview_bulk_unsplit",
            _entry_preview("t_bulk", format="json", transform=wrap),
        ),
        _s_preview(
            "preview_bulk_split",
            _entry_preview(
                "t_bulk_split",
                format="json",
                json_split=_split("${name}"),
                transform=wrap,
            ),
        ),
        _s_preview(
            "preview_bulk_split_jsonl",
            _entry_preview(
                "t_bulk",
                format="jsonl",
                json_split=_split("bulk ${name}"),
                transform={"ref": "s_t_list"},
            ),
        ),
        # refused
        _s_preview(
            "preview_over_input",
            _entry_preview("t_big", format="json", transform=inline),
        ),
        _s_preview(
            "preview_over_result",
            _entry_preview("t_blocks", format="json", transform={"ref": "s_t_big_result"}),
        ),
        _s_preview(
            "preview_surrogate",
            _entry_preview("t_blocks", format="json", transform={"ref": "s_t_surrogate"}),
        ),
        _s_preview("preview_xlsx", _entry_preview("t_blocks", format="xlsx", transform=wrap)),
        _s_preview("preview_csv", _entry_preview("t_blocks", format="csv", transform=wrap)),
        _s_preview(
            "preview_csv_named",
            _entry_preview("t_blocks", format="csv", name="book", transform=wrap),
        ),
        _s_preview("preview_none", _entry_preview("t_blocks", format="json")),
        _s_preview("preview_empty_transform", _entry_preview("t_blocks", format="json", transform={})),
        _s_preview(
            "preview_gone",
            _entry_preview("t_blocks", format="json", transform={"ref": "gone"}),
        ),
        _s_preview(
            "preview_not_a_snippet",
            _entry_preview("t_blocks", format="json", transform={"ref": "n_links"}),
        ),
        _s_preview(
            "preview_arity",
            _entry_preview("t_blocks", format="json", transform={"ref": "s_t_arity_two"}),
        ),
        _s_preview(
            "preview_any_arity",
            _entry_preview("t_blocks", format="json", transform={"ref": "s_t_any_arity"}),
        ),
        _s_preview(
            "preview_inline_arity",
            _entry_preview(
                "t_blocks", format="json", transform=_inline_transform(_T_ARITY_TWO)
            ),
        ),
        _s_preview(
            "preview_inline_parse",
            _entry_preview(
                "t_blocks",
                format="json",
                transform={"definition": {"code": "def nope(:\n"}},
            ),
        ),
        _s_preview(
            "preview_missing_table",
            _entry_preview("gone", format="json", transform=wrap),
        ),
        _s_preview(
            "preview_not_a_table",
            _entry_preview("n_links", format="json", transform=wrap),
        ),
        _s_preview(
            "preview_bad_split",
            _entry_preview(
                "t_blocks",
                format="json",
                json_split=_split("${name}${nope}"),
                transform=wrap,
            ),
        ),
        _s_preview(
            "preview_bad_split_and_key",
            _entry_preview(
                "t_blocks",
                format="json",
                json_split=_split("${name}${nope}"),
                json_doc={"shape": "object"},
                transform=wrap,
            ),
        ),
        _s_preview(
            "preview_key_missing",
            _entry_preview(
                "t_blocks",
                format="json",
                json_doc={"shape": "object"},
                transform=wrap,
            ),
        ),
        _s_preview(
            "preview_key_out_of_range",
            _entry_preview(
                "t_blocks",
                format="json",
                json_doc={"shape": "object", "key_column": 9},
                transform=wrap,
            ),
        ),
        _s_preview(
            "preview_bad_body",
            {"source": {}, "format": "json"},
        ),
    ]
    return cases


def _scripts() -> list[dict[str, Any]]:
    return [
        batch(_BULK_ELEMENTS),
        {"do": "artifacts", "_artifacts": {**_ARTIFACTS, **_SCRIPT_ARTIFACTS}},
        *_scripts_cells(),
        *_scripts_transforms(),
        *_scripts_refusals(),
        *_scripts_previews(),
        *_scripts_syntax(),
    ]


def _steps() -> list[dict[str, Any]]:
    cases = [
        *_text(),
        *_text_json(),
        *_text_preview(),
        *_splits(),
        *_xlsx(),
        *_runs(),
        *_reach(),
    ]
    scripts = _scripts()
    names = [step["case"] for step in [*cases, *scripts] if "case" in step]
    assert len(set(names)) == len(names), "case names are unique"
    return [
        batch(_ELEMENTS),
        batch(_RELATIONSHIPS),
        batch([*_PROBE_ELEMENTS, _CAP_ELEMENT, *_NAMED_PEOPLE]),
        batch(_NAMED_LINKS),
        {"do": "artifacts", "_artifacts": _ARTIFACTS},
        *cases,
        *scripts,
    ]


@scenario("export_bytes")
def export_bytes() -> Any:
    metamodel = Metamodel.model_validate(_metamodel())
    return {
        "metamodel": metamodel.model_dump(mode="json"),
        "steps": run_scripted(metamodel, _steps()),
    }
