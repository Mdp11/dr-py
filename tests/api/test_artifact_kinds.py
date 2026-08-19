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
    ):
        assert get_spec(kind) is not None
    assert get_spec(ArtifactKind.diagram) is None
    assert get_spec(ArtifactKind.diagram_kind) is None


def test_registered_adapters_validate_payloads() -> None:
    _spec(ArtifactKind.navigation).adapter.validate_python(NAV_PAYLOAD)
    _spec(ArtifactKind.table).adapter.validate_python(TABLE_PAYLOAD)
    _spec(ArtifactKind.code_snippet).adapter.validate_python(SNIPPET_PAYLOAD)


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
