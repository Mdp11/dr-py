"""POST /exports/run — the custom_export artifact's zip assembly (spec §4.3)."""

import io
import json
import zipfile

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


def _mk_export(client, entries, name="drop"):
    r = client.post(
        papi("/artifacts"),
        json={"kind": "custom_export", "name": name,
              "payload": {"entries": entries}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    return r.json()["id"]


def _run(client, artifact_id):
    return client.post(
        papi("/exports/run"), json={"artifact_id": artifact_id},
        headers=AUTH_HEADERS,
    )


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
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
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
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert names and all(n.startswith("per-el/") and n.endswith(".json") for n in names)


def test_entry_name_falls_back_to_the_table_name(client):
    _bootstrap_model(client)
    t = _mk_table(client, "delta")
    art = _mk_export(client, [{"source": {"ref": t}, "format": "json"}])
    names = zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist()
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
    assert _run(client, t).status_code == 404          # a table, not a custom_export
    assert _run(client, "nope").status_code == 404


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
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
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
