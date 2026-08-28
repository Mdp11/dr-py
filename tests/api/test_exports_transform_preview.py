"""POST /exports/preview-transform: the exporter entry's Test button. A
bounded, cache-only render of the entry's table, one transform(doc) call,
both documents + stdout back; snippet failures are data, entry problems
are 422s with /exports/run's wording."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner

from tests.script.trusted_runner import TrustedRunner

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model
from .test_exports_route import _mk_table
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


WRAP = (
    "def transform(doc):\n"
    "    print('rows:', len(doc))\n"
    "    return {'rows': doc, 'count': len(doc)}\n"
)


def _inline(code):
    return {"definition": {"schema_version": 1, "language": "python", "code": code}}


def _preview(client, entry, headers=None):
    return client.post(
        papi("/exports/preview-transform"),
        json={"entry": entry},
        headers=headers or AUTH_HEADERS,
    )


def test_inline_transform_returns_both_documents_and_stdout(client):
    _bootstrap_model(client)
    t = _mk_table(client, "alpha")
    r = _preview(
        client,
        {"source": {"ref": t}, "name": "doc", "format": "json", "transform": _inline(WRAP)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["error"] is None
    assert body["stdout"] == "rows: 3\n"
    assert body["truncated"] is False and body["split_file"] is None
    import json

    assert isinstance(json.loads(body["input"]), list)
    assert len(json.loads(body["input"])) == 3
    assert json.loads(body["output"])["count"] == 3
    assert body["input"].startswith("[\n  {")  # pretty-printed text


def test_ref_transform_resolves_the_saved_snippet(client):
    _bootstrap_model(client)
    t = _mk_table(client, "beta")
    snip = _mk_snippet(client, "wrap", WRAP)
    r = _preview(
        client, {"source": {"ref": t}, "format": "json", "transform": {"ref": snip}}
    )
    assert r.status_code == 200, r.text
    assert r.json()["error"] is None


def test_snippet_raise_is_data_not_a_422(client):
    _bootstrap_model(client)
    t = _mk_table(client, "gamma")
    code = "def transform(doc):\n    print('before')\n    raise ValueError('boom')\n"
    r = _preview(
        client, {"source": {"ref": t}, "format": "json", "transform": _inline(code)}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["output"] is None
    assert body["error"]["kind"] == "runtime" and "boom" in body["error"]["message"]
    assert "<snippet>" in body["error"]["traceback"]
    assert body["stdout"] == "before\n"
    assert body["input"]  # the pre-transform document is still shown


def test_module_level_failure_is_reported_as_the_error(client):
    _bootstrap_model(client)
    t = _mk_table(client, "delta")
    code = "raise RuntimeError('at import')\ndef transform(doc):\n    return doc\n"
    r = _preview(
        client, {"source": {"ref": t}, "format": "json", "transform": _inline(code)}
    )
    assert r.status_code == 200, r.text
    assert "at import" in r.json()["error"]["message"]


def test_jsonl_non_list_return_is_reported_as_the_error(client):
    _bootstrap_model(client)
    t = _mk_table(client, "eps")
    code = "def transform(doc):\n    return {'not': 'a list'}\n"
    r = _preview(
        client, {"source": {"ref": t}, "format": "jsonl", "transform": _inline(code)}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["output"] is None and "list" in body["error"]["message"]


def test_non_json_format_is_422_naming_the_entry(client):
    _bootstrap_model(client)
    t = _mk_table(client, "zeta")
    r = _preview(
        client,
        {"source": {"ref": t}, "name": "bad", "format": "csv", "transform": _inline(WRAP)},
    )
    assert r.status_code == 422
    assert "bad" in r.json()["detail"]


@pytest.mark.parametrize("transform", [None, {}])
def test_unconfigured_transform_is_422(client, transform):
    _bootstrap_model(client)
    t = _mk_table(client, "eta")
    r = _preview(client, {"source": {"ref": t}, "format": "json", "transform": transform})
    assert r.status_code == 422
    assert "no transform configured" in r.json()["detail"]


def test_code_without_transform_entry_is_422(client):
    _bootstrap_model(client)
    t = _mk_table(client, "theta")
    r = _preview(
        client,
        {"source": {"ref": t}, "format": "json",
         "transform": _inline("def value(els):\n    return 1\n")},
    )
    assert r.status_code == 422
    assert "transform(doc)" in r.json()["detail"]


def test_missing_table_is_422_naming_the_entry(client):
    _bootstrap_model(client)
    r = _preview(
        client,
        {"source": {"ref": "nope"}, "name": "orphan", "format": "json",
         "transform": _inline(WRAP)},
    )
    assert r.status_code == 422
    assert "orphan" in r.json()["detail"]


def test_split_entry_previews_the_first_partition(client):
    _bootstrap_model(client)
    t = _mk_table(client, "iota")
    r = _preview(
        client,
        {"source": {"ref": t}, "format": "json",
         "json_split": {"enabled": True, "filename_template": "${name}"},
         "transform": _inline(WRAP)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["split_file"] is not None and body["split_file"].endswith(".json")
    assert body["truncated"] is True  # three partitions exist; one is shown
    import json

    assert len(json.loads(body["input"])) == 1


def test_object_shape_feeds_the_keyed_object(client):
    _bootstrap_model(client)
    t = _mk_table(client, "kappa")
    code = "def transform(doc):\n    return sorted(doc)\n"
    r = _preview(
        client,
        {"source": {"ref": t}, "format": "json",
         "json_doc": {"shape": "object", "key_column": 0},
         "transform": _inline(code)},
    )
    assert r.status_code == 200, r.text
    import json

    assert isinstance(json.loads(r.json()["input"]), dict)
    assert len(json.loads(r.json()["output"])) == 3


def test_no_runner_is_503(app, client):
    app.dependency_overrides[get_runner] = lambda: None
    _bootstrap_model(client)
    t = _mk_table(client, "lam")
    r = _preview(
        client, {"source": {"ref": t}, "format": "json", "transform": _inline(WRAP)}
    )
    assert r.status_code == 503


def test_viewer_can_preview(client):
    from data_rover.api import tenancy
    from data_rover.api.db import db_session
    from data_rover.api.db_models import Role

    _bootstrap_model(client)
    t = _mk_table(client, "mu")
    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(s, project_id="default", user_id="viewer-1", role=Role.viewer)
    r = _preview(
        client,
        {"source": {"ref": t}, "format": "json", "transform": _inline(WRAP)},
        headers={"x-user-id": "viewer-1", "x-user-email": "v@example.com"},
    )
    assert r.status_code == 200, r.text
