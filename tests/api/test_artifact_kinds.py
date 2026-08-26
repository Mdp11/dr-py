"""Registry contract tests: every registered kind must round-trip its adapter,
extract its artifact refs, and rewrite them under an id map. These pin the
generic `"ref"`-key walk against each schema so a schema change that moves
refs breaks HERE, not silently in export."""

from __future__ import annotations

from data_rover.api.artifact_kinds import ArtifactKindSpec, extract_refs, get_spec, rewrite_refs
from data_rover.api.db_models import ArtifactKind

NAV_PAYLOAD = {
    "kind": "set_op",
    "op": "union",
    "operands": [
        {"ref": "nav-artifact-1"},
        {
            "definition": {
                "kind": "path",
                "start": {"kind": "scope", "types": ["Block"]},
                "steps": [{"kind": "script", "snippet": {"ref": "snip-artifact-1"}}],
            }
        },
    ],
}

TABLE_PAYLOAD = {
    "schema_version": 1,
    "row_source": {"kind": "navigation", "navigation": {"ref": "nav-artifact-2"}},
    "columns": [
        {"kind": "element"},
        {"kind": "navigation", "navigation": {"ref": "nav-artifact-1"}},
        {"kind": "script", "snippet": {"ref": "snip-artifact-1"}},
    ],
}

SNIPPET_PAYLOAD = {
    "schema_version": 1,
    "language": "python",
    "code": "def value(el):\n    return el.name\n",
}

RULES_PAYLOAD = {
    "schema_version": 1,
    "yaml": (
        "rules:\n"
        "  - name: has-name\n"
        "    applies_to: Building\n"
        "    then: {property: name, exists: true}\n"
    ),
}


def _spec(kind: ArtifactKind) -> ArtifactKindSpec:
    """`get_spec` returns `ArtifactKindSpec | None`; the tests below only ever
    call it for kinds they know are registered, so assert that here once
    rather than repeating a None-check per call site."""
    spec = get_spec(kind)
    assert spec is not None
    return spec


def test_all_current_kinds_are_registered() -> None:
    for kind in (
        ArtifactKind.navigation,
        ArtifactKind.table,
        ArtifactKind.code_snippet,
        ArtifactKind.exporter,
        ArtifactKind.validation_rules,
    ):
        assert get_spec(kind) is not None
    assert get_spec(ArtifactKind.diagram) is None
    assert get_spec(ArtifactKind.diagram_kind) is None


def test_registered_adapters_validate_payloads() -> None:
    _spec(ArtifactKind.navigation).adapter.validate_python(NAV_PAYLOAD)
    _spec(ArtifactKind.table).adapter.validate_python(TABLE_PAYLOAD)
    _spec(ArtifactKind.code_snippet).adapter.validate_python(SNIPPET_PAYLOAD)
    _spec(ArtifactKind.validation_rules).adapter.validate_python(RULES_PAYLOAD)


def test_navigation_deps_cover_operand_and_snippet_refs() -> None:
    assert extract_refs(NAV_PAYLOAD) == {"nav-artifact-1", "snip-artifact-1"}


def test_table_deps_cover_row_source_columns_and_snippets() -> None:
    assert extract_refs(TABLE_PAYLOAD) == {
        "nav-artifact-1",
        "nav-artifact-2",
        "snip-artifact-1",
    }


def test_snippet_has_no_deps() -> None:
    assert extract_refs(SNIPPET_PAYLOAD) == set()


def test_rules_has_no_deps() -> None:
    # stereotype/relationship/property names travel as plain strings inside
    # the yaml text, not as "ref" dict entries — nothing for the generic
    # walk to find.
    assert extract_refs(RULES_PAYLOAD) == set()


def test_rewrite_refs_remaps_known_and_keeps_unknown() -> None:
    out = rewrite_refs(TABLE_PAYLOAD, {"nav-artifact-1": "NEW-1"})
    assert out["columns"][1]["navigation"]["ref"] == "NEW-1"
    assert out["row_source"]["navigation"]["ref"] == "nav-artifact-2"  # untouched
    # original payload is never mutated
    assert TABLE_PAYLOAD["columns"][1]["navigation"]["ref"] == "nav-artifact-1"


def test_snippet_spec_derives_entry_points() -> None:
    payload = dict(SNIPPET_PAYLOAD)
    derive_metadata = _spec(ArtifactKind.code_snippet).derive_metadata
    assert derive_metadata is not None
    derive_metadata(payload)
    assert "value" in payload["entry_points"]


EXPORTER_PAYLOAD = {
    "schema_version": 1,
    "entries": [
        {"source": {"ref": "tbl-artifact-1"}, "name": "a", "format": "xlsx"},
        {
            "source": {"ref": "tbl-artifact-2"},
            "name": "b",
            "format": "json",
            "json_split": {"enabled": True, "filename_template": "${name}"},
        },
    ],
}


def test_exporter_is_registered_and_roundtrips():
    spec = get_spec(ArtifactKind.exporter)
    assert spec is not None
    obj = spec.adapter.validate_python(EXPORTER_PAYLOAD)
    assert [e.source.ref for e in obj.entries] == ["tbl-artifact-1", "tbl-artifact-2"]


def test_exporter_refs_extract_and_rewrite():
    spec = get_spec(ArtifactKind.exporter)
    assert spec is not None
    assert spec.extract_deps(EXPORTER_PAYLOAD) == {
        "tbl-artifact-1",
        "tbl-artifact-2",
    }
    out = spec.rewrite_refs(EXPORTER_PAYLOAD, {"tbl-artifact-1": "NEW"})
    assert out["entries"][0]["source"]["ref"] == "NEW"
    assert out["entries"][1]["source"]["ref"] == "tbl-artifact-2"  # tolerant
    assert EXPORTER_PAYLOAD["entries"][0]["source"]["ref"] == "tbl-artifact-1"


def test_transform_ref_is_walked_for_deps_and_rewrite():
    payload = {
        "entries": [
            {"source": {"ref": "tbl-1"}, "transform": {"ref": "snip-1"}},
        ]
    }
    assert "snip-1" in extract_refs(payload)
    rewritten = rewrite_refs(payload, {"snip-1": "snip-2"})
    assert rewritten["entries"][0]["transform"]["ref"] == "snip-2"


# `ExporterEntry.transform` / `TableDefinition.transform` are `SnippetSource |
# None`: at most one of `ref` (saved snippet) / `definition` (inline code) is
# set. The generic "ref"-key walk must treat both shapes correctly — ref mode
# is a dependency, inline mode is not — without the inline `definition`
# subtree (itself full of plain strings: `code`, `language`, `entry_points`)
# leaking into the walk or masking a real ref sitting beside it.

_INLINE_TRANSFORM_DEFINITION = {
    "definition": {
        "schema_version": 1,
        "language": "python",
        "code": "def transform(doc):\n    return doc\n",
        "entry_points": ["transform"],
    }
}


def test_table_transform_shapes_are_valid_payloads() -> None:
    # sanity: the dict fixtures below are real TableDefinition payloads, not
    # just shapes the generic walk happens to tolerate.
    adapter = _spec(ArtifactKind.table).adapter
    adapter.validate_python({**TABLE_PAYLOAD, "transform": {"ref": "snip-transform-1"}})
    adapter.validate_python({**TABLE_PAYLOAD, "transform": _INLINE_TRANSFORM_DEFINITION})
    adapter.validate_python({**TABLE_PAYLOAD, "transform": {}})


def test_exporter_transform_shapes_are_valid_payloads() -> None:
    adapter = _spec(ArtifactKind.exporter).adapter
    entry = {"source": {"ref": "tbl-1"}, "name": "a"}
    adapter.validate_python({"entries": [{**entry, "transform": {"ref": "snip-transform-1"}}]})
    adapter.validate_python({"entries": [{**entry, "transform": _INLINE_TRANSFORM_DEFINITION}]})
    adapter.validate_python({"entries": [{**entry, "transform": {}}]})


def test_table_transform_ref_mode_is_a_dependency() -> None:
    payload = {**TABLE_PAYLOAD, "transform": {"ref": "snip-transform-1"}}
    assert extract_refs(payload) == {
        "nav-artifact-1",
        "nav-artifact-2",
        "snip-artifact-1",
        "snip-transform-1",
    }
    out = rewrite_refs(payload, {"snip-transform-1": "NEW"})
    assert out["transform"]["ref"] == "NEW"


def test_exporter_transform_ref_mode_is_a_dependency() -> None:
    payload = {
        "entries": [{"source": {"ref": "tbl-1"}, "transform": {"ref": "snip-transform-1"}}]
    }
    assert extract_refs(payload) == {"tbl-1", "snip-transform-1"}
    out = rewrite_refs(payload, {"snip-transform-1": "NEW"})
    assert out["entries"][0]["transform"]["ref"] == "NEW"


def test_table_transform_inline_mode_contributes_no_dependency() -> None:
    payload = {
        "row_source": {"kind": "navigation", "navigation": {"ref": "nav-1"}},
        "columns": [{"kind": "element"}],
        "transform": _INLINE_TRANSFORM_DEFINITION,
    }
    assert extract_refs(payload) == {"nav-1"}


def test_exporter_transform_inline_mode_contributes_no_dependency() -> None:
    payload = {"entries": [{"transform": _INLINE_TRANSFORM_DEFINITION}]}
    assert extract_refs(payload) == set()


def test_table_transform_inline_mode_survives_rewrite_unchanged() -> None:
    payload = {
        "row_source": {"kind": "navigation", "navigation": {"ref": "nav-1"}},
        "columns": [{"kind": "element"}],
        "transform": _INLINE_TRANSFORM_DEFINITION,
    }
    out = rewrite_refs(payload, {"nav-1": "NEW", "unrelated-id": "x"})
    assert out["transform"] == _INLINE_TRANSFORM_DEFINITION
    assert out["row_source"]["navigation"]["ref"] == "NEW"
    # the input is untouched
    assert payload["row_source"]["navigation"]["ref"] == "nav-1"
    assert payload["transform"] == _INLINE_TRANSFORM_DEFINITION


def test_exporter_transform_inline_mode_survives_rewrite_unchanged() -> None:
    payload = {
        "entries": [{"source": {"ref": "tbl-1"}, "transform": _INLINE_TRANSFORM_DEFINITION}]
    }
    out = rewrite_refs(payload, {"tbl-1": "NEW", "unrelated-id": "x"})
    assert out["entries"][0]["transform"] == _INLINE_TRANSFORM_DEFINITION
    assert out["entries"][0]["source"]["ref"] == "NEW"
    # the input is untouched
    assert payload["entries"][0]["source"]["ref"] == "tbl-1"
    assert payload["entries"][0]["transform"] == _INLINE_TRANSFORM_DEFINITION


def test_table_transform_empty_contributes_and_rewrites_nothing() -> None:
    payload = {
        "row_source": {"kind": "navigation", "navigation": {"ref": "nav-1"}},
        "columns": [{"kind": "element"}],
        "transform": {},
    }
    assert extract_refs(payload) == {"nav-1"}
    out = rewrite_refs(payload, {"nav-1": "NEW"})
    assert out["transform"] == {}
    assert out["row_source"]["navigation"]["ref"] == "NEW"


def test_exporter_transform_empty_contributes_and_rewrites_nothing() -> None:
    payload = {"entries": [{"source": {"ref": "tbl-1"}, "transform": {}}]}
    assert extract_refs(payload) == {"tbl-1"}
    out = rewrite_refs(payload, {"tbl-1": "NEW"})
    assert out["entries"][0]["transform"] == {}
    assert out["entries"][0]["source"]["ref"] == "NEW"


def test_table_transform_inline_does_not_mask_or_add_neighbouring_refs() -> None:
    # an inline transform sits beside a real ref elsewhere in the same
    # payload (a script column's snippet ref); extract_refs must return
    # exactly that neighbour — neither swallowed nor supplemented by
    # anything from the inline `definition` subtree.
    payload = {
        "row_source": {"kind": "navigation", "navigation": {"ref": "nav-mix-1"}},
        "columns": [
            {"kind": "element"},
            {"kind": "script", "snippet": {"ref": "snip-col-1"}},
        ],
        "transform": _INLINE_TRANSFORM_DEFINITION,
    }
    assert extract_refs(payload) == {"nav-mix-1", "snip-col-1"}


def test_exporter_transform_inline_does_not_mask_or_add_neighbouring_refs() -> None:
    payload = {
        "entries": [
            {"source": {"ref": "tbl-mix-1"}, "transform": _INLINE_TRANSFORM_DEFINITION}
        ]
    }
    assert extract_refs(payload) == {"tbl-mix-1"}
