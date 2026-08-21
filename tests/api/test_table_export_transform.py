"""TableDefinition.transform on POST /tables/export (spec §8: the standalone
surface). Runner injected via dependency_overrides -> TrustedRunner."""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner

from tests.script.trusted_runner import TrustedRunner

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model
from .test_exports_route import TABLE_PAYLOAD


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


def _mk_snippet(client, name, code):
    r = client.post(
        papi("/artifacts"),
        json={"kind": "code_snippet", "name": name, "payload": {"code": code}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    return r.json()["id"]


WRAP = "def transform(doc):\n    return {'rows': doc, 'count': len(doc)}\n"


def _export(client, definition, format="json"):
    return client.post(
        papi("/tables/export"),
        json={"definition": definition, "format": format},
        headers=AUTH_HEADERS,
    )


def test_transform_applies_to_standalone_json_export(client):
    _bootstrap_model(client)
    snip = _mk_snippet(client, "wrap", WRAP)
    r = _export(client, {**TABLE_PAYLOAD, "transform": {"ref": snip}})
    assert r.status_code == 200
    doc = json.loads(r.content)
    assert doc["count"] == 3 and len(doc["rows"]) == 3


def test_transform_on_xlsx_is_422(client):
    _bootstrap_model(client)
    snip = _mk_snippet(client, "wrap2", WRAP)
    r = _export(client, {**TABLE_PAYLOAD, "transform": {"ref": snip}}, format="xlsx")
    assert r.status_code == 422
    assert "JSON-family" in r.json()["detail"]


def test_unknown_or_wrong_kind_ref_is_422(client):
    _bootstrap_model(client)
    r = _export(client, {**TABLE_PAYLOAD, "transform": {"ref": "nope"}})
    assert r.status_code == 422
    assert "transform" in r.json()["detail"]


def test_snippet_without_transform_entry_is_422(client):
    _bootstrap_model(client)
    snip = _mk_snippet(client, "noentry", "def value(elements):\n    return 1\n")
    r = _export(client, {**TABLE_PAYLOAD, "transform": {"ref": snip}})
    assert r.status_code == 422
    assert "transform" in r.json()["detail"]


def test_no_runner_is_503(app):
    # NO get_runner override on this app: the default runner is None in tests.
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    _bootstrap_model(c)
    snip = _mk_snippet(c, "wrap3", WRAP)
    r = _export(c, {**TABLE_PAYLOAD, "transform": {"ref": snip}})
    assert r.status_code == 503


def test_transform_raise_is_422_not_200(client):
    _bootstrap_model(client)
    snip = _mk_snippet(client, "boom", "def transform(doc):\n    raise RuntimeError('nope')\n")
    r = _export(client, {**TABLE_PAYLOAD, "transform": {"ref": snip}})
    assert r.status_code == 422
    assert "nope" in r.json()["detail"]


def test_no_bleed_table_transform_never_leaks_into_exporter_entry(client):
    # §15: the table's own transform must NOT apply when an exporter entry
    # (with transform: None) exports that same table.
    _bootstrap_model(client)
    snip = _mk_snippet(client, "wrap4", WRAP)
    t = client.post(
        papi("/artifacts"),
        json={"kind": "table", "name": "tt",
              "payload": {**TABLE_PAYLOAD, "transform": {"ref": snip}}},
        headers=AUTH_HEADERS,
    ).json()["id"]
    r = client.post(
        papi("/exports/run"),
        json={"definition": {"entries": [
            {"source": {"ref": t}, "name": "plain", "format": "json"}]},
            "name": "d"},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200  # zip; the entry rendered UNtransformed
    import io, zipfile
    z = zipfile.ZipFile(io.BytesIO(r.content))
    doc = json.loads(z.read("plain.json"))
    assert isinstance(doc, list)  # a plain row array, not {'rows':..., 'count':...}
