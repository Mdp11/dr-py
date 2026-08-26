"""`SnippetSource` inline transforms on both surfaces (`POST /tables/export`,
`POST /exports/run`): resolver behavior, the two 422 wordings, and the two
`is_empty` gate fixes. Ref-mode coverage stays in `test_table_export_transform.py`
/ `test_exports_transform.py` — this file is additive."""

import hashlib
import io
import json
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api import tenancy
from data_rover.api.db import db_session
from data_rover.api.db_models import Role
from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner

from tests.script.trusted_runner import TrustedRunner

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model
from .test_exports_route import TABLE_PAYLOAD, _mk_export, _mk_table, _run
from .test_table_export_transform import _export

WRAP = "def transform(doc):\n    return {'rows': doc, 'count': len(doc)}\n"
NO_ENTRY = "def not_transform(doc):\n    return doc\n"
SYNTAX_ERROR = "def transform(doc:\n    return doc\n"


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


def viewer_headers() -> dict[str, str]:
    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(
            s, project_id="default", user_id="viewer-1", role=Role.viewer
        )
    return {"x-user-id": "viewer-1", "x-user-email": "v@example.com"}


# ---------------------------------------------------------------------------
# standalone /tables/export
# ---------------------------------------------------------------------------


def test_inline_transform_applies_to_standalone_json_export(client):
    _bootstrap_model(client)
    r = _export(client, {**TABLE_PAYLOAD, "transform": {"definition": {"code": WRAP}}})
    assert r.status_code == 200
    doc = json.loads(r.content)
    assert doc["count"] == 3 and len(doc["rows"]) == 3


def test_inline_transform_applies_to_standalone_jsonl_export(client):
    _bootstrap_model(client)
    keep = "def transform(doc):\n    return doc[:2]\n"
    r = _export(
        client,
        {**TABLE_PAYLOAD, "transform": {"definition": {"code": keep}}},
        format="jsonl",
    )
    assert r.status_code == 200
    lines = r.content.decode().strip().split("\n")
    assert len(lines) == 2


def test_inline_no_transform_def_is_422_naming_the_entry(client):
    _bootstrap_model(client)
    r = _export(
        client, {**TABLE_PAYLOAD, "transform": {"definition": {"code": NO_ENTRY}}}
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "table" in detail
    assert "does not define a one-argument top-level transform(doc)" in detail
    assert "snippet" not in detail  # not the ref-mode wording


def test_inline_transform_ignores_claimed_entry_points(client):
    # `entry_points` on an inline `definition` is fully client-supplied (no
    # save-time server derivation touches a nested inline payload, unlike a
    # saved snippet artifact) — pin that `_resolve_transform_source` still
    # re-derives from the AST rather than trusting the claim. `NO_ENTRY`
    # defines `not_transform`, not `transform`; without re-derivation this
    # would resolve as if valid instead of 422ing.
    _bootstrap_model(client)
    r = _export(
        client,
        {
            **TABLE_PAYLOAD,
            "transform": {
                "definition": {"code": NO_ENTRY, "entry_points": ["transform"]}
            },
        },
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "table" in detail
    assert "does not define a one-argument top-level transform(doc)" in detail


def test_inline_syntax_error_is_422_with_syntax_wording(client):
    _bootstrap_model(client)
    r = _export(
        client, {**TABLE_PAYLOAD, "transform": {"definition": {"code": SYNTAX_ERROR}}}
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "table" in detail
    assert "does not parse" in detail
    assert "does not define" not in detail


def test_inline_transform_on_xlsx_is_422(client):
    _bootstrap_model(client)
    r = _export(
        client,
        {**TABLE_PAYLOAD, "transform": {"definition": {"code": WRAP}}},
        format="xlsx",
    )
    assert r.status_code == 422
    assert "JSON-family" in r.json()["detail"]


def test_empty_transform_on_xlsx_is_not_422(client):
    _bootstrap_model(client)
    r = _export(client, {**TABLE_PAYLOAD, "transform": {}}, format="xlsx")
    assert r.status_code == 200


def test_empty_transform_on_json_takes_no_concurrency_slot(client, monkeypatch):
    # `open_transform_host` sits inside the SAME `if` block as the gate this
    # test exercises (unlike the exporter side below, whose host-open is
    # gated separately at the run level), so pinning the real
    # `snippet_concurrency` limit to 1 and holding that one slot ourselves
    # directly proves an unfixed `is not None` gate would 429 on a `{}`
    # source instead of exporting cleanly. Settings are constructed
    # per-request (`get_settings`), so the env var takes effect immediately
    # — same idiom as `test_exports_transform.py::test_busy_is_429`.
    monkeypatch.setenv("DATA_ROVER_SNIPPET_CONCURRENCY", "1")
    _bootstrap_model(client)
    from data_rover.api.snippet_concurrency import concurrency_guard

    assert concurrency_guard.try_acquire_global(global_limit=1)
    try:
        r = _export(client, {**TABLE_PAYLOAD, "transform": {}})
    finally:
        concurrency_guard.release_global()
    assert r.status_code == 200


def test_viewer_can_run_draft_export_with_inline_transform(app):
    # Pins a deliberately-accepted surface: EvaluateTableIn.definition is
    # viewer-callable, so an inline transform lets a viewer run sandboxed
    # code — not an escalation, since POST /snippets/run already does.
    # Posts directly rather than through `_export`, which hardcodes
    # `headers=AUTH_HEADERS` (the owner identity) at the REQUEST level —
    # httpx merges client headers then overlays request headers, so
    # `_export`'s own headers would silently win over the viewer client's.
    seed_default_project()
    app.dependency_overrides[get_runner] = lambda: TrustedRunner()
    owner = TestClient(app)
    owner.headers.update(AUTH_HEADERS)
    _bootstrap_model(owner)

    viewer = TestClient(app)
    viewer.headers.update(viewer_headers())
    r = viewer.post(
        papi("/tables/export"),
        json={
            "definition": {
                **TABLE_PAYLOAD,
                "transform": {"definition": {"code": WRAP}},
            },
            "format": "json",
        },
        headers=viewer.headers,
    )
    assert r.status_code == 200
    doc = json.loads(r.content)
    assert doc["count"] == 3


# ---------------------------------------------------------------------------
# POST /exports/run (exporter entries)
# ---------------------------------------------------------------------------


def test_inline_entry_transform_applies_json(client):
    _bootstrap_model(client)
    t = _mk_table(client, "alpha")
    art = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "doc",
                "format": "json",
                "transform": {"definition": {"code": WRAP}},
            },
        ],
    )
    r = _run(client, art)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    doc = json.loads(z.read("doc.json"))
    assert doc["count"] == 3


def test_inline_entry_transform_applies_jsonl(client):
    _bootstrap_model(client)
    t = _mk_table(client, "alpha2")
    keep = "def transform(doc):\n    return doc[:2]\n"
    art = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "lines",
                "format": "jsonl",
                "transform": {"definition": {"code": keep}},
            },
        ],
    )
    r = _run(client, art)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    lines = z.read("lines.jsonl").decode().strip().split("\n")
    assert len(lines) == 2


def test_inline_entry_no_transform_def_is_422_naming_it(client):
    _bootstrap_model(client)
    t = _mk_table(client, "beta")
    art = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "bad",
                "format": "json",
                "transform": {"definition": {"code": NO_ENTRY}},
            },
        ],
    )
    r = _run(client, art)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "bad" in detail
    assert "does not define a one-argument top-level transform(doc)" in detail


def test_inline_entry_syntax_error_is_422_with_syntax_wording(client):
    _bootstrap_model(client)
    t = _mk_table(client, "gamma")
    art = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "broken",
                "format": "json",
                "transform": {"definition": {"code": SYNTAX_ERROR}},
            },
        ],
    )
    r = _run(client, art)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "broken" in detail
    assert "does not parse" in detail


def test_inline_entry_transform_on_xlsx_is_422(client):
    _bootstrap_model(client)
    t = _mk_table(client, "delta")
    art = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "bad",
                "format": "xlsx",
                "transform": {"definition": {"code": WRAP}},
            },
        ],
    )
    r = _run(client, art)
    assert r.status_code == 422
    assert "JSON-family" in r.json()["detail"]


def test_empty_entry_transform_on_xlsx_is_not_422(client):
    _bootstrap_model(client)
    t = _mk_table(client, "epsilon")
    art = _mk_export(
        client,
        [
            {"source": {"ref": t}, "name": "ok", "format": "xlsx", "transform": {}},
        ],
    )
    r = _run(client, art)
    assert r.status_code == 200


def test_empty_entry_transform_never_reaches_the_resolver(client, monkeypatch):
    # Unlike the standalone surface above, the exporter's host-open is
    # gated separately at the RUN level (`any(code is not None for code in
    # transform_codes)` in `_execute_export`) — deliberately untouched by
    # this fix — and `_resolve_transform_source` already returns `None` for
    # an empty source even if called, so NO concurrency assertion here can
    # ever discriminate the per-entry `is_empty` gate: a host is never
    # opened for a lone `{}` entry regardless of that gate's state. What the
    # per-entry gate DOES control is whether `_resolve_transform_source` is
    # invoked at all for an unconfigured source — pin that instead.
    _bootstrap_model(client)
    t = _mk_table(client, "zeta")
    art = _mk_export(
        client,
        [
            {"source": {"ref": t}, "name": "ok", "format": "json", "transform": {}},
        ],
    )
    import data_rover.api.routes.exports as exports_module

    real_resolve = exports_module._resolve_transform_source
    calls: list[object] = []

    def _spy(*args, **kwargs):
        calls.append(args)
        return real_resolve(*args, **kwargs)

    monkeypatch.setattr(exports_module, "_resolve_transform_source", _spy)
    r = _run(client, art)
    assert r.status_code == 200
    assert calls == []


def test_viewer_can_run_draft_exporter_with_inline_transform(app):
    seed_default_project()
    app.dependency_overrides[get_runner] = lambda: TrustedRunner()
    owner = TestClient(app)
    owner.headers.update(AUTH_HEADERS)
    _bootstrap_model(owner)
    t = _mk_table(owner, "eta")

    viewer = TestClient(app)
    viewer.headers.update(viewer_headers())
    r = viewer.post(
        papi("/exports/run"),
        json={
            "definition": {
                "entries": [
                    {
                        "source": {"ref": t},
                        "name": "doc",
                        "format": "json",
                        "transform": {"definition": {"code": WRAP}},
                    },
                ]
            },
            "name": "viewer-draft",
        },
        headers=viewer.headers,
    )
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    doc = json.loads(z.read("doc.json"))
    assert doc["count"] == 3


# ---------------------------------------------------------------------------
# manifest marker for an inline transform
# ---------------------------------------------------------------------------


def test_manifest_records_inline_marker_not_none(client):
    _bootstrap_model(client)
    t = _mk_table(client, "manifest-inline")
    art = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "doc",
                "format": "json",
                "transform": {"definition": {"code": WRAP}},
            },
        ],
    )
    r = _run(client, art)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    manifest = json.loads(z.read("manifest.json"))
    marker = manifest["entries"][0]["transform"]
    expected = f"inline:{hashlib.sha256(WRAP.encode()).hexdigest()[:12]}"
    assert marker == expected


def test_manifest_records_none_for_no_transform(client):
    _bootstrap_model(client)
    t = _mk_table(client, "manifest-none")
    art = _mk_export(
        client,
        [{"source": {"ref": t}, "name": "plain", "format": "json"}],
    )
    r = _run(client, art)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    manifest = json.loads(z.read("manifest.json"))
    assert manifest["entries"][0]["transform"] is None


def test_manifest_marker_is_deterministic_across_runs(client):
    _bootstrap_model(client)
    t = _mk_table(client, "manifest-det")
    art = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "doc",
                "format": "json",
                "transform": {"definition": {"code": WRAP}},
            },
        ],
    )
    r1 = _run(client, art)
    r2 = _run(client, art)
    assert r1.status_code == 200 and r2.status_code == 200
    z1 = zipfile.ZipFile(io.BytesIO(r1.content))
    z2 = zipfile.ZipFile(io.BytesIO(r2.content))
    assert z1.read("manifest.json") == z2.read("manifest.json")


def test_manifest_marker_same_code_same_marker_different_code_differs(client):
    _bootstrap_model(client)
    t1 = _mk_table(client, "manifest-a")
    t2 = _mk_table(client, "manifest-b")
    t3 = _mk_table(client, "manifest-c")
    other_code = "def transform(doc):\n    return {'other': True}\n"
    art = _mk_export(
        client,
        [
            {
                "source": {"ref": t1},
                "name": "a",
                "format": "json",
                "transform": {"definition": {"code": WRAP}},
            },
            {
                "source": {"ref": t2},
                "name": "b",
                "format": "json",
                "transform": {"definition": {"code": WRAP}},
            },
            {
                "source": {"ref": t3},
                "name": "c",
                "format": "json",
                "transform": {"definition": {"code": other_code}},
            },
        ],
    )
    r = _run(client, art)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    manifest = json.loads(z.read("manifest.json"))
    markers = {e["name"]: e["transform"] for e in manifest["entries"]}
    assert markers["a"] == markers["b"]
    assert markers["a"] != markers["c"]
