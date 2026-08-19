"""POST /exports/run — the exporter artifact's zip assembly (spec §4.3)."""

import io
import json
import zipfile
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.routes.exports import _aggregate_pending
from data_rover.api.schemas import ScriptStatusOut

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


TABLE_PAYLOAD = {
    "row_source": {"kind": "scope", "types": ["Block"]},
    "columns": [
        {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
        {"kind": "property", "source": {"kind": "row"}, "name": "mass",
         "header": "Mass"},
    ],
}


def _mk_table(client, name):
    r = client.post(
        papi("/artifacts"),
        json={"kind": "table", "name": name, "payload": TABLE_PAYLOAD},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    return r.json()["id"]


def _mk_export(client, entries, name="drop", output=None):
    payload = {"entries": entries}
    if output is not None:
        payload["output"] = output
    r = client.post(
        papi("/artifacts"),
        json={"kind": "exporter", "name": name, "payload": payload},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    return r.json()["id"]


def _run(client, artifact_id):
    return client.post(
        papi("/exports/run"), json={"artifact_id": artifact_id},
        headers=AUTH_HEADERS,
    )


def _names(resp) -> list[str]:
    """Zip member names MINUS `manifest.json`. Most of this module's tests
    pin exact entry-naming/dedupe mechanics that predate the manifest
    (Task 7) — output.manifest defaults True, so every run now carries a
    root-level manifest member alongside the entries these tests actually
    exercise; filtering it out here keeps those assertions about entry
    naming, not about the manifest (which has its own tests below)."""
    return [
        n for n in zipfile.ZipFile(io.BytesIO(resp.content)).namelist()
        if n != "manifest.json"
    ]


def test_mixed_format_entries_land_in_one_zip(client):
    _bootstrap_model(client)
    t1, t2 = _mk_table(client, "alpha"), _mk_table(client, "beta")
    art = _mk_export(
        client,
        [
            {"source": {"ref": t1}, "name": "sheet", "format": "xlsx"},
            {"source": {"ref": t2}, "name": "doc", "format": "json"},
        ],
    )
    r = _run(client, art)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"] == 'attachment; filename="drop.zip"'
    names = _names(r)
    assert sorted(names) == ["doc.json", "sheet.xlsx"]


def test_split_entry_lands_in_a_folder(client):
    _bootstrap_model(client)
    t = _mk_table(client, "gamma")
    art = _mk_export(
        client,
        [{
            "source": {"ref": t}, "name": "per-el", "format": "json",
            "json_split": {"enabled": True, "filename_template": "${name}"},
        }],
    )
    r = _run(client, art)
    assert r.status_code == 200
    names = _names(r)
    assert names and all(n.startswith("per-el/") and n.endswith(".json") for n in names)


def test_entry_name_falls_back_to_the_table_name(client):
    _bootstrap_model(client)
    t = _mk_table(client, "delta")
    art = _mk_export(client, [{"source": {"ref": t}, "format": "json"}])
    names = _names(_run(client, art))
    assert names == ["delta.json"]


def test_entry_overrides_apply_without_touching_the_table(client):
    _bootstrap_model(client)
    t = _mk_table(client, "epsilon")
    art = _mk_export(
        client,
        [{
            "source": {"ref": t}, "name": "narrow", "format": "json",
            "columns": [{"index": 1, "export": {"include": False}}],
        }],
    )
    r = _run(client, art)
    docs = json.loads(zipfile.ZipFile(io.BytesIO(r.content)).read("narrow.json"))
    assert docs and "Mass" not in docs[0]  # excluded by the ENTRY
    # the table's own standalone export still contains Mass
    r2 = client.post(
        papi("/tables/export"), json={"artifact_id": t, "format": "json"},
        headers=AUTH_HEADERS,
    )
    assert "Mass" in json.loads(r2.content)[0]


def test_tokenless_split_template_is_a_422_naming_the_entry(client):
    """The dialog only gates a bad template while `format === 'json'`
    (EntryLayoutDialog's Save gate) — an entry saved under xlsx and later
    flipped to json can still carry a tokenless `json_split.filename_template`.
    The route must 422 by ENTRY NAME rather than an anonymous failure."""
    _bootstrap_model(client)
    t = _mk_table(client, "lambda_t")
    art = _mk_export(
        client,
        [{
            "source": {"ref": t}, "name": "no-token", "format": "json",
            "json_split": {"enabled": True, "filename_template": "static"},
        }],
    )
    r = _run(client, art)
    assert r.status_code == 422
    assert "no-token" in r.json()["detail"]


def test_dangling_ref_is_a_422_naming_the_entry(client):
    _bootstrap_model(client)
    art = _mk_export(client, [{"source": {"ref": "gone"}, "name": "lost"}])
    r = _run(client, art)
    assert r.status_code == 422
    assert "lost" in r.json()["detail"]


def test_empty_entries_422_and_wrong_kind_404(client):
    _bootstrap_model(client)
    empty = _mk_export(client, [])
    assert _run(client, empty).status_code == 422
    t = _mk_table(client, "zeta")
    assert _run(client, t).status_code == 404          # a table, not an exporter
    assert _run(client, "nope").status_code == 404


def test_traversal_entry_name_cannot_escape_the_archive_root_single_file(client):
    """A single-file entry (`json_split` off) names its zip member from
    `entry.name`/`t.name` — free-form text with no charset constraint at the
    API layer. `sanitize_stem` must neutralize the path separators before
    `_dedupe`, or `../../evil` writes a member that unzips OUTSIDE the
    archive root."""
    _bootstrap_model(client)
    t = _mk_table(client, "iota")
    art = _mk_export(
        client, [{"source": {"ref": t}, "name": "../../evil", "format": "json"}]
    )
    r = _run(client, art)
    assert r.status_code == 200
    names = _names(r)
    assert names == [".._.._evil.json"]
    assert all(not n.startswith("/") and ".." not in n.split("/") for n in names)


def test_traversal_entry_name_cannot_escape_the_archive_root_split(client):
    """Same hazard for a split entry, where the sanitized name becomes a ZIP
    FOLDER — a raw path segment, not just a filename stem. A stem of bare
    dots (`".."`) is not defanged by stripping separators alone (there are
    none to strip), so `sanitize_stem` must also neutralize an all-dots
    result or the folder itself IS the traversal token (`"../x.json"`)."""
    _bootstrap_model(client)
    t = _mk_table(client, "kappa")
    art = _mk_export(
        client,
        [{
            "source": {"ref": t}, "name": "..", "format": "json",
            "json_split": {"enabled": True, "filename_template": "${name}"},
        }],
    )
    r = _run(client, art)
    assert r.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert names  # at least the split's "root" partition
    for n in names:
        assert not n.startswith("/")
        assert ".." not in n.split("/")


def test_whitespace_entry_name_falls_back_rather_than_producing_an_absolute_member(
    client,
):
    """`sanitize_stem(" ") == ""` by design (its docstring: empty stays
    empty so callers reach their own fallback). The single-file branch must
    supply that fallback itself, or `f"{stem}{dot}{ext}"` with an empty stem
    writes a member like `.json` — and the split branch's
    `f"{folder}/{fn}"` would write `"/{fn}"`, an ABSOLUTE zip member (a
    naive `os.path.join(dest, member.filename)` extractor honors that as an
    override of the destination — the same zip-slip hazard class as the
    `../../evil` case, via a different mechanism)."""
    _bootstrap_model(client)
    t = _mk_table(client, "mu")
    art = _mk_export(
        client, [{"source": {"ref": t}, "name": " ", "format": "json"}]
    )
    r = _run(client, art)
    assert r.status_code == 200
    names = _names(r)
    assert names == ["export.json"]
    assert all(not n.startswith("/") and ".." not in n.split("/") for n in names)


def test_whitespace_entry_name_split_falls_back_rather_than_producing_a_root_member(
    client,
):
    """Same hazard as above, one level up: a whitespace-only entry name on a
    SPLIT entry must not leave the archive folder name empty, or every
    member in the entry lands at the archive ROOT with a leading `/`."""
    _bootstrap_model(client)
    t = _mk_table(client, "nu")
    art = _mk_export(
        client,
        [{
            "source": {"ref": t}, "name": " ", "format": "json",
            "json_split": {"enabled": True, "filename_template": "${name}"},
        }],
    )
    r = _run(client, art)
    assert r.status_code == 200
    names = _names(r)
    assert names  # at least the split's "root" partition
    for n in names:
        assert n.startswith("export/")
        assert not n.startswith("/")
        assert ".." not in n.split("/")


def test_colliding_whitespace_entry_names_dedupe_the_shared_fallback_stem(client):
    """Multiple entries that all sanitize to empty must not collide silently
    on the SAME literal member name — `_dedupe` has to suffix the shared
    fallback exactly like any other collision."""
    _bootstrap_model(client)
    t1, t2 = _mk_table(client, "xi"), _mk_table(client, "omicron")
    art = _mk_export(
        client,
        [
            {"source": {"ref": t1}, "name": " ", "format": "json"},
            {"source": {"ref": t2}, "name": "   ", "format": "json"},
        ],
    )
    r = _run(client, art)
    assert r.status_code == 200
    names = _names(r)
    assert names == ["export.json", "export_2.json"]


def test_colliding_entry_names_dedupe_with_a_suffix_in_entry_order(client):
    _bootstrap_model(client)
    t1, t2 = _mk_table(client, "eta"), _mk_table(client, "theta")
    art = _mk_export(
        client,
        [
            {"source": {"ref": t1}, "name": "sheet", "format": "json"},
            {"source": {"ref": t2}, "name": "sheet", "format": "json"},
        ],
    )
    r = _run(client, art)
    assert r.status_code == 200
    names = _names(r)
    # entry order: t1's entry lands first and keeps the bare name; t2's
    # entry collides and gets the `_2` suffix — never the reverse.
    assert names == ["sheet.json", "sheet_2.json"]


# --- _aggregate_pending: pure, so hand-built ScriptStatusOut values are
# enough — no DB, no app fixture, no runner (see task-7-report.md, Finding 2
# of the fix round). ---------------------------------------------------


def test_aggregate_pending_prefers_computing_over_failed():
    statuses = [
        ScriptStatusOut(state="failed", done=1, total=2, message="dead"),
        ScriptStatusOut(state="computing", done=3, total=5),
    ]
    agg = _aggregate_pending(statuses)
    assert agg.state == "computing"
    assert agg.done == 4
    assert agg.total == 7


def test_aggregate_pending_all_failed_is_failed():
    statuses = [
        ScriptStatusOut(state="failed", done=1, total=2, message="dead-1"),
        ScriptStatusOut(state="failed", done=2, total=3, message="dead-2"),
    ]
    agg = _aggregate_pending(statuses)
    assert agg.state == "failed"
    assert agg.done == 3
    assert agg.total == 5


def test_aggregate_pending_sums_done_and_total_across_entries():
    statuses = [
        ScriptStatusOut(state="computing", done=1, total=10),
        ScriptStatusOut(state="computing", done=2, total=None),
        ScriptStatusOut(state="computing", done=3, total=4),
    ]
    agg = _aggregate_pending(statuses)
    assert agg.state == "computing"
    assert agg.done == 6
    # `total=None` (an entry whose row count is not yet known) contributes 0,
    # never breaks the sum — same `or 0` narrowing as the route itself.
    assert agg.total == 14


# --- entry-name/folder templating + per-folder dedupe -------------------


def _entries(*tables: str, **extra: object) -> list[dict[str, object]]:
    return [{"source": {"ref": t}, **extra} for t in tables]


def test_folder_template_nests_entry_files(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(client, [{"source": {"ref": t}, "name": "f", "folder": "grp/sub"}])
    resp = _run(client, art)
    assert resp.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(resp.content)).namelist()
    assert "grp/sub/f.xlsx" in names


def test_shared_folder_prefix_and_per_folder_dedupe(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(
        client,
        [
            {"source": {"ref": t}, "name": "same", "folder": "a"},
            {"source": {"ref": t}, "name": "same", "folder": "a"},
            {"source": {"ref": t}, "name": "same", "folder": "b"},
        ],
    )
    names = zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist()
    # dedupe scoped to the folder: b/same needs no suffix
    assert {"a/same.xlsx", "a/same_2.xlsx", "b/same.xlsx"} <= set(names)


def test_folder_traversal_and_absolute_are_422(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    for bad in ("/abs", "a//b", "a/   /b"):
        art = _mk_export(client, [{"source": {"ref": t}, "folder": bad}], name=f"e-{bad!r}")
        resp = _run(client, art)
        assert resp.status_code == 422, bad
        assert "folder" in resp.json()["detail"]


def test_dotdot_folder_segment_is_neutralized_not_traversal(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(client, [{"source": {"ref": t}, "name": "f", "folder": "../up"}])
    names = zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist()
    assert "__/up/f.xlsx" in names  # sanitize_stem turns ".." into "__"


def test_unknown_template_token_is_422_naming_the_entry(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(client, [{"source": {"ref": t}, "name": "x${typo}"}])
    resp = _run(client, art)
    assert resp.status_code == 422
    assert "${typo}" in resp.json()["detail"]


def test_context_tokens_render_in_entry_names(client) -> None:
    """Pins ACTUAL rendering, not merely `${name}` substitution: a template
    that ships `${rev}`/`${date}`/`${project}` verbatim would still satisfy
    a loose `startswith("T_r")` check, so this asserts the exact rendered
    name against independently-computed expected values (the rev read off
    `GET /open`, the date computed the same way `export_context_vars` does)
    and that no `${...}` token survives anywhere in the zip."""
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    rev = client.get(papi("/open"), headers=AUTH_HEADERS).json()["model_rev"]
    date = datetime.now(UTC).strftime("%Y%m%d")
    art = _mk_export(
        client,
        [{"source": {"ref": t}, "name": "${name}_r${rev}_${date}_${project}"}],
    )
    names = _names(_run(client, art))
    assert not any("${" in n for n in names)
    assert names == [f"T_r{rev}_{date}_default.xlsx"]


def test_token_in_folder_template_renders_and_gets_sanitized(client) -> None:
    """`entry.folder`'s `${name}` substitution is the ACTUAL zip-slip
    surface (unlike a literal folder string): a hostile table name must
    still land under sanitized segments, never escape via `/` or `..`."""
    _bootstrap_model(client)
    t = _mk_table(client, "../x")
    art = _mk_export(
        client, [{"source": {"ref": t}, "name": "f", "folder": "${name}"}]
    )
    names = zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist()
    # naming.folder_segments -> sanitize_stem(".." ) turns the all-dots
    # segment into "__" (its length-preserving neutralization), "x" passes
    # through unchanged.
    assert "__/x/f.xlsx" in names
    assert all(not n.startswith("/") and ".." not in n.split("/") for n in names)


# --- zip filename template + bare (unzipped) output mode -----------------


def test_zip_filename_template(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(
        client, _entries(t), name="MyExport",
        output={"filename": "bundle_${name}_${project}"},
    )
    resp = _run(client, art)
    cd = resp.headers["content-disposition"]
    assert 'filename="bundle_MyExport_default.zip"' in cd


def test_bare_mode_ships_the_single_file_directly(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(
        client, [{"source": {"ref": t}, "name": "solo", "format": "json"}],
        output={"mode": "bare"},
    )
    resp = _run(client, art)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
    assert 'filename="solo.json"' in resp.headers["content-disposition"]
    json.loads(resp.content)  # it's the document, not a zip


def test_bare_mode_with_multiple_files_is_422(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(client, _entries(t, t), output={"mode": "bare"})
    resp = _run(client, art)
    assert resp.status_code == 422
    assert "bare" in resp.json()["detail"]


def test_unknown_zip_filename_token_is_422(client) -> None:
    """The zip filename template goes through the SAME `validate_tokens`
    up-front pass as an entry's `name`/`folder` (see
    `test_unknown_template_token_is_422_naming_the_entry`) — this pins that
    it actually fires for `cdef.output.filename`, not just entry fields."""
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(client, _entries(t), output={"filename": "x${typo}"})
    resp = _run(client, art)
    assert resp.status_code == 422
    assert "output filename" in resp.json()["detail"]
    assert "${typo}" in resp.json()["detail"]


# --- manifest.json ---------------------------------------------------------


def test_manifest_lands_at_the_zip_root_by_default(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(client, _entries(t), name="M")
    zf = zipfile.ZipFile(io.BytesIO(_run(client, art).content))
    doc = json.loads(zf.read("manifest.json"))
    assert doc["artifact_name"] == "M"
    assert doc["entries"][0]["files"] == ["T.xlsx"]


def test_manifest_off_omits_the_member(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(client, _entries(t), output={"manifest": False})
    names = zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist()
    assert "manifest.json" not in names


def test_user_file_named_manifest_dedupes_against_the_reserved_root_name(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(client, [{"source": {"ref": t}, "name": "manifest", "format": "json"}])
    names = set(zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist())
    assert "manifest.json" in names          # the real manifest
    assert "manifest_2.json" in names        # the user's file, deduped


def test_two_runs_at_one_rev_are_byte_identical(client) -> None:
    _bootstrap_model(client)
    t = _mk_table(client, "T")
    art = _mk_export(client, _entries(t))
    assert _run(client, art).content == _run(client, art).content
