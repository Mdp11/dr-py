"""ExporterEntry.transform through POST /exports/run (spec §8/§15): per-entry
application, no-bleed (entry -> table direction), session sharing, split
per-file calls, jsonl list contract, manifest recording, 503/429."""

import io
import json
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner

from tests.script.trusted_runner import TrustedRunner

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model
from .test_exports_route import _mk_export, _mk_table, _run
from .test_table_export_transform import _mk_snippet


@pytest.fixture
def app():
    seed_default_project()
    application = create_app()
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    app.dependency_overrides[get_runner] = lambda: TrustedRunner()
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    return c


WRAP = "def transform(doc):\n    return {'rows': doc, 'count': len(doc)}\n"


def test_entry_transform_applies_and_manifest_records_it(client):
    _bootstrap_model(client)
    t = _mk_table(client, "alpha")
    snip = _mk_snippet(client, "wrap", WRAP)
    art = _mk_export(client, [
        {"source": {"ref": t}, "name": "doc", "format": "json",
         "transform": {"ref": snip}},
    ])
    r = _run(client, art)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    doc = json.loads(z.read("doc.json"))
    assert doc["count"] == 3
    manifest = json.loads(z.read("manifest.json"))
    assert manifest["entries"][0]["transform"] == snip


def test_no_bleed_entry_transform_never_touches_standalone_export(client):
    # §15, the other direction of test_table_export_transform's no-bleed
    # test: an exporter entry's transform must not affect the table's own
    # standalone export.
    _bootstrap_model(client)
    t = _mk_table(client, "beta")
    snip = _mk_snippet(client, "wrap2", WRAP)
    _mk_export(client, [{"source": {"ref": t}, "name": "doc", "format": "json",
                         "transform": {"ref": snip}}])
    r = client.post(
        papi("/tables/export"),
        json={"artifact_id": t, "format": "json"},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200
    assert isinstance(json.loads(r.content), list)  # untransformed row array


def test_transform_on_csv_entry_is_422_naming_it(client):
    _bootstrap_model(client)
    t = _mk_table(client, "gamma")
    snip = _mk_snippet(client, "wrap3", WRAP)
    art = _mk_export(client, [
        {"source": {"ref": t}, "name": "bad", "format": "csv",
         "transform": {"ref": snip}},
    ])
    r = _run(client, art)
    assert r.status_code == 422
    assert "bad" in r.json()["detail"]


def test_missing_transform_snippet_is_422_up_front(client):
    _bootstrap_model(client)
    t = _mk_table(client, "delta")
    art = _mk_export(client, [
        {"source": {"ref": t}, "name": "doc", "format": "json",
         "transform": {"ref": "nope"}},
    ])
    r = _run(client, art)
    assert r.status_code == 422
    assert "doc" in r.json()["detail"]


def test_split_entry_transform_called_once_per_file(client):
    _bootstrap_model(client)  # 3 Block elements -> 3 split files
    t = _mk_table(client, "eps")
    snip = _mk_snippet(client, "wrap4", WRAP)
    art = _mk_export(client, [{
        "source": {"ref": t}, "name": "per-el", "format": "json",
        "json_split": {"enabled": True, "filename_template": "${name}"},
        "transform": {"ref": snip},
    }])
    r = _run(client, art)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    members = [n for n in z.namelist() if n != "manifest.json"]
    assert len(members) == 3
    for m in members:
        assert json.loads(z.read(m))["count"] == 1  # each file's own doc


def test_jsonl_transform_must_return_list(client):
    _bootstrap_model(client)
    t = _mk_table(client, "zeta")
    bad = _mk_snippet(client, "notalist", "def transform(doc):\n    return {'a': 1}\n")
    art = _mk_export(client, [
        {"source": {"ref": t}, "name": "lines", "format": "jsonl",
         "transform": {"ref": bad}},
    ])
    r = _run(client, art)
    assert r.status_code == 422
    assert "must return a list" in r.json()["detail"]


def test_jsonl_list_transform_ships_lines(client):
    _bootstrap_model(client)
    t = _mk_table(client, "eta")
    keep = _mk_snippet(client, "first2", "def transform(doc):\n    return doc[:2]\n")
    art = _mk_export(client, [
        {"source": {"ref": t}, "name": "lines", "format": "jsonl",
         "transform": {"ref": keep}},
    ])
    r = _run(client, art)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    lines = z.read("lines.jsonl").decode().strip().split("\n")
    assert len(lines) == 2


def test_two_entries_same_snippet_share_a_session(client, app):
    # Observable via a module-level counter in the snippet: sessions exec
    # the module ONCE, so a shared session increments across calls.
    _bootstrap_model(client)
    t1, t2 = _mk_table(client, "s1"), _mk_table(client, "s2")
    code = ("_n = [0]\n"
            "def transform(doc):\n"
            "    _n[0] += 1\n"
            "    return {'call': _n[0]}\n")
    snip = _mk_snippet(client, "counter", code)
    art = _mk_export(client, [
        {"source": {"ref": t1}, "name": "a", "format": "json", "transform": {"ref": snip}},
        {"source": {"ref": t2}, "name": "b", "format": "json", "transform": {"ref": snip}},
    ])
    r = _run(client, art)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    calls = {json.loads(z.read("a.json"))["call"], json.loads(z.read("b.json"))["call"]}
    assert calls == {1, 2}  # one module exec, two calls — a shared warm session


def test_no_runner_is_503(app):
    c = TestClient(app)  # no get_runner override: default runner is None
    c.headers.update(AUTH_HEADERS)
    _bootstrap_model(c)
    t = _mk_table(c, "theta")
    snip = _mk_snippet(c, "wrap5", WRAP)
    art = _mk_export(c, [
        {"source": {"ref": t}, "name": "doc", "format": "json",
         "transform": {"ref": snip}},
    ])
    assert _run(c, art).status_code == 503


def test_busy_is_429(monkeypatch, app):
    # Settings are constructed per-request (get_settings), so the env var
    # takes effect immediately; hold the ONLY interactive slot ourselves so
    # open_transform_host's try_acquire_global fails.
    monkeypatch.setenv("DATA_ROVER_SNIPPET_CONCURRENCY", "1")
    app.dependency_overrides[get_runner] = lambda: TrustedRunner()
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    _bootstrap_model(c)
    t = _mk_table(c, "iota")
    snip = _mk_snippet(c, "wrap6", WRAP)
    art = _mk_export(c, [
        {"source": {"ref": t}, "name": "doc", "format": "json",
         "transform": {"ref": snip}},
    ])
    from data_rover.api.snippet_concurrency import concurrency_guard

    assert concurrency_guard.try_acquire_global(global_limit=1)
    try:
        assert _run(c, art).status_code == 429
    finally:
        concurrency_guard.release_global()
