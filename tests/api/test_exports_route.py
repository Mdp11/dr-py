"""POST /exports/run — the exporter artifact's zip assembly."""

import io
import json
import zipfile
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Membership, Project, Role
from data_rover.api.main import create_app
from data_rover.api.routes.exports import _aggregate_pending
from data_rover.api.schemas import ScriptStatusOut

from .conftest import AUTH_HEADERS, TEST_USER_ID, papi, seed_default_project
from .test_artifacts_routes import EXAMPLE, _bootstrap_model


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


# A script column with no runner configured in this test app comes back
# `pending` and renders `{"$error": ...}` (see
# `test_table_export_json.py::test_uncomputed_script_cells_become_error_markers`,
# whose mechanism this is copied from) — the one cheap way to produce an
# in-band error marker for `json_doc.on_error` to react to.
SCRIPT_TABLE_PAYLOAD = {
    "row_source": {"kind": "scope", "types": ["Block"]},
    "columns": [
        {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
        {
            "kind": "script",
            "snippet": {
                "definition": {"code": "def value(elements):\n    return 1\n"}
            },
            "header": "Computed",
        },
    ],
}


def _mk_script_table(client, name):
    r = client.post(
        papi("/artifacts"),
        json={"kind": "table", "name": name, "payload": SCRIPT_TABLE_PAYLOAD},
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
    """Zip member names MINUS `manifest.json`. `output.manifest` defaults
    True, so every run carries a root-level manifest member alongside the
    entries these tests actually exercise; filtering it out here keeps those
    assertions about entry naming, not about the manifest (which has its own
    tests below)."""
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


def test_split_entry_without_split_folder_lands_directly_in_the_entry_folder(client):
    """`split_folder: false` drops the per-entry folder: the partitions land
    straight under the entry's own `folder` (here `grp/`), not `grp/per-el/`."""
    _bootstrap_model(client)
    t = _mk_table(client, "gamma")
    art = _mk_export(
        client,
        [{
            "source": {"ref": t}, "name": "per-el", "format": "json",
            "folder": "grp", "split_folder": False,
            "json_split": {"enabled": True, "filename_template": "${name}"},
        }],
    )
    r = _run(client, art)
    assert r.status_code == 200
    names = _names(r)
    assert names
    assert all(n.startswith("grp/") and n.endswith(".json") for n in names)
    assert not any(n.startswith("grp/per-el/") for n in names)
    assert all(n.count("/") == 1 for n in names)


def test_split_entry_without_split_folder_dedupes_against_siblings(client):
    """With the folder gone, a split file shares the entry folder's dedupe
    namespace: a plain sibling that renders to the same member path is
    suffixed rather than silently overwriting the split member."""
    _bootstrap_model(client)
    scoped_payload = {
        "row_source": {
            "kind": "scope", "types": ["Block"],
            "criteria": [{"type": "name_id", "field": "name", "op": "equals", "value": "root"}],
        },
        "columns": [{"kind": "element", "source": {"kind": "row"}, "header": "Block"}],
    }
    r = client.post(
        papi("/artifacts"),
        json={"kind": "table", "name": "solo", "payload": scoped_payload},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    t = r.json()["id"]
    art = _mk_export(
        client,
        [
            {
                "source": {"ref": t}, "name": "per-el", "folder": "grp",
                "format": "json", "split_folder": False,
                "json_split": {"enabled": True, "filename_template": "${name}"},
            },
            {"source": {"ref": t}, "name": "root", "folder": "grp", "format": "json"},
        ],
    )
    r = _run(client, art)
    assert r.status_code == 200
    names = _names(r)
    assert len(names) == len(set(names))
    assert set(names) == {"grp/root.json", "grp/root_2.json"}


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
# enough — no DB, no app fixture, no runner. ----------------------------


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
    # Positive assertion, not just absence: an empty (or entry-less) zip
    # would also satisfy the line above, so this pins that the entry's own
    # file still shipped rather than the whole assembly silently vanishing.
    assert names == ["T.xlsx"]


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


def test_split_entry_member_path_reserves_against_a_sibling_entry(client) -> None:
    """A split entry's PRODUCED member paths must occupy the dedupe
    namespace, not merely its `prefix + folder` reservation slot: entry A
    (`folder=""`, `name="X"`, split json) writes `X/root.json` (its one
    partition is the single Block named "root"), and entry B
    (`folder="X"`, `name="root"`, plain json) independently renders to the
    SAME member `X/root.json`. If `taken` only ever held `"X"` for entry A
    (never the actual `"X/root"` path its file landed at), `_dedupe_path`
    for entry B would see no collision and both entries would write the
    byte-identical zip member — `zipfile` warns and extraction is last-wins.
    Entry B's `root.json` must instead dedupe to `root_2.json`, with both
    members present and `len(names) == len(set(names))`."""
    _bootstrap_model(client)
    scoped_payload = {
        "row_source": {
            "kind": "scope", "types": ["Block"],
            "criteria": [{"type": "name_id", "field": "name", "op": "equals", "value": "root"}],
        },
        "columns": [{"kind": "element", "source": {"kind": "row"}, "header": "Block"}],
    }
    r = client.post(
        papi("/artifacts"),
        json={"kind": "table", "name": "solo", "payload": scoped_payload},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    t = r.json()["id"]
    art = _mk_export(
        client,
        [
            {
                "source": {"ref": t}, "name": "X", "folder": "", "format": "json",
                "json_split": {"enabled": True, "filename_template": "${name}"},
            },
            {"source": {"ref": t}, "name": "root", "folder": "X", "format": "json"},
        ],
        output={"manifest": False},
    )
    resp = _run(client, art)
    assert resp.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(resp.content)).namelist()
    assert len(names) == len(set(names)), f"duplicate zip member(s) in {names}"
    assert set(names) == {"X/root.json", "X/root_2.json"}


# ---- csv/jsonl entries + json_doc -----------------------------------------
#
# Coverage note on `on_error`: `contains_error_marker` itself has unit tests
# (`tests/table/test_json_export.py`) and `JsonDocumentOptions.on_error` has
# schema/round-trip tests (`tests/table/test_exporter.py`), but the two tests
# below are what exercises `table_export_engine._check_on_error` — the
# function that actually applies the policy to a rendered export — using
# `SCRIPT_TABLE_PAYLOAD` (a script column with no runner configured, the
# same mechanism `test_table_export_json.py`'s
# `test_uncomputed_script_cells_become_error_markers` uses) to produce a real
# `{"$error": ...}` cell through `/exports/run` end to end.


def test_csv_and_jsonl_entries_land_in_the_zip(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {"source": {"ref": t}, "name": "as-csv", "format": "csv"},
            {"source": {"ref": t}, "name": "as-jsonl", "format": "jsonl"},
        ],
    )
    r = _run(client, x)
    assert r.status_code == 200
    assert sorted(_names(r)) == ["as-csv.csv", "as-jsonl.jsonl"]


def test_json_doc_object_shape_keys_documents_by_column(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "keyed",
                "format": "json",
                # column 0 is the element column -> display name keys
                "json_doc": {"shape": "object", "key_column": 0, "pretty": False},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 200
    blob = zipfile.ZipFile(io.BytesIO(r.content)).read("keyed.json")
    doc = json.loads(blob)
    assert isinstance(doc, dict)
    assert set(doc) == {"root", "p1", "p2"}
    assert b"\n  " not in blob  # pretty=false -> compact


def test_json_doc_object_without_key_column_422s_naming_the_entry(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "broken",
                "format": "json",
                "json_doc": {"shape": "object"},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 422
    assert "broken" in r.json()["detail"]
    assert "key_column" in r.json()["detail"]


def test_json_doc_key_column_out_of_range_422s(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "broken",
                "format": "json",
                "json_doc": {"shape": "object", "key_column": 99},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 422
    assert "out of range" in r.json()["detail"]


def test_json_doc_on_xlsx_entry_is_tolerated_and_ignored(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "sheet",
                "format": "xlsx",
                "json_doc": {"shape": "object", "key_column": 99},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 200
    assert _names(r) == ["sheet.xlsx"]


def test_json_doc_on_csv_entry_is_tolerated_and_ignored(client):
    """Plan: "CSV: no split, no `json_doc`". Same `key_column: 99` probe as
    the xlsx sibling above — a value that would 422 if `json_doc` were
    actually consulted on this format."""
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "flat",
                "format": "csv",
                "json_doc": {"shape": "object", "key_column": 99},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 200
    assert _names(r) == ["flat.csv"]


def test_json_doc_shape_and_pretty_are_ignored_on_jsonl_entries(client):
    """On jsonl, `shape`/`pretty` are ignored with tolerance but `on_error`
    still applies. The same `key_column: 99` probe
    as the two siblings above pins that `shape: "object"` (and the key column
    it would otherwise require/validate) never reaches jsonl's rendering at
    all — a real consult would 422 on the out-of-range column exactly like
    `test_json_doc_key_column_out_of_range_422s` does for json."""
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "lines",
                "format": "jsonl",
                "json_doc": {"shape": "object", "key_column": 99},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 200
    assert _names(r) == ["lines.jsonl"]


def test_json_doc_on_error_fail_422s_when_export_contains_error_cells(client):
    """`on_error: "fail"` is the one exporter policy this branch shipped with
    zero end-to-end coverage of before this test (see the module comment
    above `test_csv_and_jsonl_entries_land_in_the_zip`). `SCRIPT_TABLE_PAYLOAD`
    produces a real in-band `{"$error": ...}` cell (no runner configured in
    this test app), which `_check_on_error` must catch and turn into a 422
    naming the offending entry — never a silently-shipped document."""
    _bootstrap_model(client)
    t = _mk_script_table(client, "flaky")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "strict",
                "format": "json",
                "json_doc": {"on_error": "fail"},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 422
    assert "strict" in r.json()["detail"]


def test_json_doc_default_on_error_still_ships_error_markers_in_band(client):
    """The other half of the same pair, on the SAME error-producing table:
    the default policy (`on_error: "emit"`, i.e. `json_doc` omitted
    entirely) must still ship 200 with the `$error` markers in-band. Without
    this, `test_json_doc_on_error_fail_422s_...` alone would only pin the
    failure branch — this pins that the policy actually branches on
    `on_error` rather than always rejecting an errored export."""
    _bootstrap_model(client)
    t = _mk_script_table(client, "flaky")
    x = _mk_export(
        client,
        [{"source": {"ref": t}, "name": "lenient", "format": "json"}],
    )
    r = _run(client, x)
    assert r.status_code == 200
    blob = zipfile.ZipFile(io.BytesIO(r.content)).read("lenient.json")
    docs = json.loads(blob)
    assert set(docs[0]["Computed"]) == {"$error"}


def test_bare_mode_ships_csv_and_jsonl_media_types(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    for fmt, ctype in [("csv", "text/csv"), ("jsonl", "application/x-ndjson")]:
        x = _mk_export(
            client,
            [{"source": {"ref": t}, "name": f"solo-{fmt}", "format": fmt}],
            name=f"bare-{fmt}",
            output={"mode": "bare"},
        )
        r = _run(client, x)
        assert r.status_code == 200
        assert r.headers["content-type"].startswith(ctype)
        assert r.headers["content-disposition"].endswith(f'solo-{fmt}.{fmt}"')


def test_jsonl_entry_split_files_nest_under_the_entry_folder(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "per-el",
                "format": "jsonl",
                "json_split": {"enabled": True, "filename_template": "${name}"},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 200
    names = _names(r)
    assert all(n.startswith("per-el/") and n.endswith(".jsonl") for n in names)
    assert len(names) == 3


# ---- draft runs -------------------------------------------------------


def _run_draft(client, definition, name="draft"):
    return client.post(
        papi("/exports/run"),
        json={"definition": definition, "name": name},
        headers=AUTH_HEADERS,
    )


def test_draft_run_exports_without_a_committed_artifact(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    r = _run_draft(
        client,
        {"entries": [{"source": {"ref": t}, "name": "as-json", "format": "json"}]},
        name="my-draft",
    )
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    # The request's `name` feeds the zip-stem fallback (no output.filename).
    assert r.headers["content-disposition"].endswith('my-draft.zip"')
    assert _names(r) == ["as-json.json"]


def test_draft_run_manifest_reports_null_artifact_id_and_request_name(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    r = _run_draft(
        client,
        {"entries": [{"source": {"ref": t}, "name": "e1", "format": "json"}]},
        name="my-draft",
    )
    assert r.status_code == 200
    manifest = json.loads(
        zipfile.ZipFile(io.BytesIO(r.content)).read("manifest.json")
    )
    assert manifest["artifact_id"] is None
    assert manifest["artifact_name"] == "my-draft"


def test_draft_run_default_name_is_export(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    r = client.post(
        papi("/exports/run"),
        json={"definition": {"entries": [{"source": {"ref": t}, "format": "json"}]}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200
    assert r.headers["content-disposition"].endswith('export.zip"')


def test_exactly_one_of_artifact_id_and_definition_is_required(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(client, [{"source": {"ref": t}, "format": "json"}])
    neither = client.post(papi("/exports/run"), json={}, headers=AUTH_HEADERS)
    assert neither.status_code == 422
    both = client.post(
        papi("/exports/run"),
        json={
            "artifact_id": x,
            "definition": {"entries": [{"source": {"ref": t}, "format": "json"}]},
        },
        headers=AUTH_HEADERS,
    )
    assert both.status_code == 422
    assert "exactly one" in both.json()["detail"]


def test_draft_run_flows_through_the_same_guards(client):
    _bootstrap_model(client)
    # Missing table: project scoping via the existing missing-table 422.
    r = _run_draft(
        client,
        {"entries": [{"source": {"ref": "no-such-table"}, "name": "ghost"}]},
    )
    assert r.status_code == 422
    assert "missing table" in r.json()["detail"]
    assert "ghost" in r.json()["detail"]
    # Templates validate up front, naming the entry.
    t = _mk_table(client, "parts")
    r = _run_draft(
        client,
        {"entries": [{"source": {"ref": t}, "name": "bad", "folder": "${bogus}"}]},
    )
    assert r.status_code == 422
    assert "invalid template" in r.json()["detail"]
    assert "bad" in r.json()["detail"]


def test_draft_run_with_no_entries_422s(client):
    _bootstrap_model(client)
    r = _run_draft(client, {"entries": []})
    assert r.status_code == 422
    assert "no entries" in r.json()["detail"]


# ---- run-by-name -------------------------------------------------------


def _run_by_name(client, name):
    return client.get(
        papi("/exports/run-by-name"), params={"name": name}, headers=AUTH_HEADERS
    )


def test_run_by_name_matches_the_post_contract(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client, [{"source": {"ref": t}, "name": "e1", "format": "json"}], name="nightly"
    )
    by_name = _run_by_name(client, "nightly")
    by_id = _run(client, x)
    assert by_name.status_code == by_id.status_code == 200
    assert by_name.headers["content-type"] == "application/zip"
    assert _names(by_name) == _names(by_id) == ["e1.json"]
    assert by_name.headers["content-disposition"].endswith('nightly.zip"')


def test_run_by_name_unknown_404s(client):
    _bootstrap_model(client)
    r = _run_by_name(client, "no-such-exporter")
    assert r.status_code == 404


def test_run_by_name_ignores_other_kinds(client):
    _bootstrap_model(client)
    _mk_table(client, "shadow")  # a TABLE named like the query
    r = _run_by_name(client, "shadow")
    assert r.status_code == 404


def test_run_by_name_ambiguous_409s_listing_candidates(client, monkeypatch):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x1 = _mk_export(client, [{"source": {"ref": t}, "format": "json"}], name="dup")
    # `project_artifacts` carries a genuine DB-level UNIQUE constraint on
    # (project_id, kind, name) (`db_models.ArtifactRow`), so a raw
    # content-layer insert cannot slip a duplicate past the create/rename
    # routes' 409 either — ANY insert of a second "exporter"/"dup" row —
    # through `content.
    # create_artifact` or raw SQL alike — raises `IntegrityError`; a true
    # duplicate is unreachable through any write path against this schema.
    # The route's ambiguity handling is still worth proving deterministic
    # (schema invariants can drift — a future migration, a manual DB edit),
    # so this simulates ambiguity at the query seam instead of the DB: a
    # second, genuinely distinct exporter is created normally, then
    # `find_artifacts_by_name` is patched to answer as if both rows matched
    # the same name. This still exercises the real route logic end to end
    # (status code, `detail` contents) — only the "how did two rows come to
    # share a name" premise is faked.
    x2 = _mk_export(client, [{"source": {"ref": t}, "format": "json"}], name="dup2")
    from data_rover.api import content
    from data_rover.api.routes import exports as exports_routes

    real_find = content.find_artifacts_by_name

    def fake_find(db, project_id, kind, name):
        if name == "dup":
            rows = real_find(db, project_id, kind, "dup") + real_find(
                db, project_id, kind, "dup2"
            )
            return sorted(rows, key=lambda r: r.id)
        return real_find(db, project_id, kind, name)

    monkeypatch.setattr(exports_routes.content, "find_artifacts_by_name", fake_find)
    r = _run_by_name(client, "dup")
    assert r.status_code == 409
    assert x1 in r.json()["detail"]
    assert x2 in r.json()["detail"]


# ---- project scoping on the two newly reachable paths --------------------
#
# The code is already correct (`t.project_id != project_id` in
# `_execute_export`; `ArtifactRow.project_id == project_id` in
# `content.find_artifacts_by_name`) — these pin it against a genuine second
# project owned by the SAME test user, same pattern as `test_multi_project.py`.

OTHER_PROJECT_ID = "other"


def _seed_other_project() -> None:
    """A second project, owned by the same TEST_USER_ID, so one AUTH_HEADERS
    client can reach both projects' data routes."""
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(Project, OTHER_PROJECT_ID) is None:
            s.add(Project(id=OTHER_PROJECT_ID, name="Other Project"))
            s.add(
                Membership(
                    user_id=TEST_USER_ID, project_id=OTHER_PROJECT_ID, role=Role.owner
                )
            )
            s.commit()
    finally:
        gen.close()


def _other_papi(path: str) -> str:
    return f"/api/v1/projects/{OTHER_PROJECT_ID}{path}"


def _bootstrap_other_model(client) -> None:
    """Same metamodel/model bootstrap as `_bootstrap_model`, scoped to
    OTHER_PROJECT_ID instead of the default project."""
    client.post(
        _other_papi("/metamodel"),
        content=EXAMPLE.read_text(encoding="utf-8"),
        headers={"content-type": "application/x-yaml"},
    )
    client.post(_other_papi("/model"), json={"elements": [], "relationships": []})


def _mk_table_other(client, name):
    r = client.post(
        _other_papi("/artifacts"),
        json={"kind": "table", "name": name, "payload": TABLE_PAYLOAD},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    return r.json()["id"]


def _mk_export_other(client, entries, name="drop"):
    r = client.post(
        _other_papi("/artifacts"),
        json={"kind": "exporter", "name": name, "payload": {"entries": entries}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    return r.json()["id"]


def test_draft_entry_referencing_another_projects_table_is_the_missing_table_422(
    client,
):
    """A table id that is perfectly valid — just in a DIFFERENT project —
    must 422 exactly like a dangling ref (`t.project_id != project_id` in
    `_execute_export`), never resolve across the project boundary."""
    _bootstrap_model(client)
    _seed_other_project()
    _bootstrap_other_model(client)
    other_table = _mk_table_other(client, "elsewhere")
    r = _run_draft(
        client,
        {"entries": [{"source": {"ref": other_table}, "name": "leak"}]},
    )
    assert r.status_code == 422
    assert "missing table" in r.json()["detail"]
    assert "leak" in r.json()["detail"]


def test_run_by_name_ignores_an_exporter_of_the_same_name_in_another_project(client):
    """A `name` that only resolves to an exporter in a DIFFERENT project must
    404 exactly like a genuinely unknown name (`content.find_artifacts_by_name`
    filters on `project_id`), never run the other project's artifact."""
    _seed_other_project()
    _bootstrap_other_model(client)
    t = _mk_table_other(client, "parts")
    _mk_export_other(
        client, [{"source": {"ref": t}, "name": "e1", "format": "json"}], name="only-there"
    )
    r = _run_by_name(client, "only-there")
    assert r.status_code == 404
