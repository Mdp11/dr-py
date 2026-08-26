"""`SnippetSource` inline transforms on both surfaces (`POST /tables/export`,
`POST /exports/run`): resolver behavior, the two 422 wordings, and the two
`is_empty` gate fixes. Ref-mode coverage stays in `test_table_export_transform.py`
/ `test_exports_transform.py` — this file is additive."""

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


def test_empty_transform_on_json_takes_no_concurrency_slot(client):
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
    seed_default_project()
    app.dependency_overrides[get_runner] = lambda: TrustedRunner()
    owner = TestClient(app)
    owner.headers.update(AUTH_HEADERS)
    _bootstrap_model(owner)

    viewer = TestClient(app)
    viewer.headers.update(viewer_headers())
    r = _export(viewer, {**TABLE_PAYLOAD, "transform": {"definition": {"code": WRAP}}})
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


def test_empty_entry_transform_on_json_takes_no_concurrency_slot(client):
    _bootstrap_model(client)
    t = _mk_table(client, "zeta")
    art = _mk_export(
        client,
        [
            {"source": {"ref": t}, "name": "ok", "format": "json", "transform": {}},
        ],
    )
    from data_rover.api.snippet_concurrency import concurrency_guard

    assert concurrency_guard.try_acquire_global(global_limit=1)
    try:
        r = _run(client, art)
    finally:
        concurrency_guard.release_global()
    assert r.status_code == 200


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
