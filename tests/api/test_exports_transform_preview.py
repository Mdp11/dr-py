"""POST /exports/preview-transform: the exporter entry's Test button. A
bounded render of the entry's table, one transform(doc) call per file the
export would produce (one file unsplit; every partition when the entry
splits), both documents + stdout back per file; snippet failures are data,
entry problems are 422s with /exports/run's wording."""

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
    assert body["split"] is False and body["truncated"] is False
    assert len(body["files"]) == 1
    f = body["files"][0]
    assert f["filename"] == "doc.json"
    assert f["error"] is None
    assert f["stdout"] == "rows: 3\n"
    import json

    assert isinstance(json.loads(f["input"]), list)
    assert len(json.loads(f["input"])) == 3
    assert json.loads(f["output"])["count"] == 3
    assert f["input"].startswith("[\n  {")  # pretty-printed text


def test_ref_transform_resolves_the_saved_snippet(client):
    _bootstrap_model(client)
    t = _mk_table(client, "beta")
    snip = _mk_snippet(client, "wrap", WRAP)
    r = _preview(
        client, {"source": {"ref": t}, "format": "json", "transform": {"ref": snip}}
    )
    assert r.status_code == 200, r.text
    assert r.json()["files"][0]["error"] is None


def test_snippet_raise_is_data_not_a_422(client):
    _bootstrap_model(client)
    t = _mk_table(client, "gamma")
    code = "def transform(doc):\n    print('before')\n    raise ValueError('boom')\n"
    r = _preview(
        client, {"source": {"ref": t}, "format": "json", "transform": _inline(code)}
    )
    assert r.status_code == 200, r.text
    (f,) = r.json()["files"]
    assert f["output"] is None
    assert f["error"]["kind"] == "runtime" and "boom" in f["error"]["message"]
    assert "<snippet>" in f["error"]["traceback"]
    assert f["stdout"] == "before\n"
    assert f["input"]  # the pre-transform document is still shown


def test_module_level_failure_is_reported_as_the_error(client):
    _bootstrap_model(client)
    t = _mk_table(client, "delta")
    code = "raise RuntimeError('at import')\ndef transform(doc):\n    return doc\n"
    r = _preview(
        client, {"source": {"ref": t}, "format": "json", "transform": _inline(code)}
    )
    assert r.status_code == 200, r.text
    assert "at import" in r.json()["files"][0]["error"]["message"]


def test_jsonl_non_list_return_is_reported_as_the_error(client):
    _bootstrap_model(client)
    t = _mk_table(client, "eps")
    code = "def transform(doc):\n    return {'not': 'a list'}\n"
    r = _preview(
        client, {"source": {"ref": t}, "format": "jsonl", "transform": _inline(code)}
    )
    assert r.status_code == 200, r.text
    (f,) = r.json()["files"]
    assert f["output"] is None and "list" in f["error"]["message"]


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


SPLIT = {"enabled": True, "filename_template": "${name}"}


def test_split_entry_transforms_every_file(client):
    """Split = the FULL run, like the export: one transform call per
    partition, each reported under the filename the export would write."""
    _bootstrap_model(client)
    t = _mk_table(client, "iota")
    r = _preview(
        client,
        {"source": {"ref": t}, "format": "json", "json_split": SPLIT,
         "transform": _inline(WRAP)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["split"] is True and body["truncated"] is False
    import json

    names = [f["filename"] for f in body["files"]]
    assert sorted(names) == ["p1.json", "p2.json", "root.json"]
    for f in body["files"]:
        assert f["error"] is None
        assert len(json.loads(f["input"])) == 1
        assert json.loads(f["output"])["count"] == 1
        assert f["stdout"] == "rows: 1\n"
    assert body["duration_ms"] >= max(f["duration_ms"] for f in body["files"])


def test_split_file_failure_does_not_stop_the_others(client):
    _bootstrap_model(client)
    t = _mk_table(client, "iota2")
    code = (
        "def transform(doc):\n"
        "    if doc[0]['Block'] == 'p1':\n"
        "        raise ValueError('boom')\n"
        "    return doc\n"
    )
    r = _preview(
        client,
        {"source": {"ref": t}, "format": "json", "json_split": SPLIT,
         "transform": _inline(code)},
    )
    assert r.status_code == 200, r.text
    by_name = {f["filename"]: f for f in r.json()["files"]}
    assert set(by_name) == {"p1.json", "p2.json", "root.json"}
    assert "boom" in by_name["p1.json"]["error"]["message"]
    assert by_name["p1.json"]["output"] is None
    assert by_name["p2.json"]["error"] is None and by_name["p2.json"]["output"]
    assert by_name["root.json"]["error"] is None


def test_split_file_cap_truncates(client, monkeypatch):
    from data_rover.api.routes import exports as exports_route

    monkeypatch.setattr(exports_route, "PREVIEW_MAX_FILES", 2)
    _bootstrap_model(client)
    t = _mk_table(client, "iota3")
    r = _preview(
        client,
        {"source": {"ref": t}, "format": "json", "json_split": SPLIT,
         "transform": _inline(WRAP)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["files"]) == 2 and body["truncated"] is True


def test_split_filenames_are_deduplicated_like_the_export(client):
    """Three base elements sharing a display name collide on `${name}`; the
    export suffixes `_2`, `_3` in row order, and the preview must name the
    files the same way."""
    _bootstrap_model(client)
    for _ in range(3):
        r = client.post(
            papi("/model/elements"),
            json={"type": "Block", "properties": {"name": "twin", "mass": 1.0}},
        )
        assert r.status_code in (200, 201), r.text
    t = _mk_table(client, "iota4")
    r = _preview(
        client,
        {"source": {"ref": t}, "format": "json", "json_split": SPLIT,
         "transform": _inline(WRAP)},
    )
    assert r.status_code == 200, r.text
    names = [f["filename"] for f in r.json()["files"]]
    assert len(names) == 6 and len(set(names)) == 6
    assert {"twin.json", "twin_2.json", "twin_3.json"} <= set(names)


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

    (f,) = r.json()["files"]
    assert isinstance(json.loads(f["input"]), dict)
    assert len(json.loads(f["output"])) == 3


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


# A script column whose value differs per row, so it can key an object-shaped
# document. Nothing here is cached before the first call: the preview must
# evaluate its bounded sample LIVE (the grid's visible-window stance), not
# cache-only, or a cold cache renders the key as `{"$error": ...}` and the
# Test button 422s on an entry whose export succeeds (the export waits for
# the sweep; the preview never does).
KEYED_SCRIPT_TABLE = {
    "row_source": {"kind": "scope", "types": ["Block"]},
    "columns": [
        {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
        {
            "kind": "script",
            "snippet": {
                "definition": {
                    "code": "def value(elements):\n    return elements[0].name\n"
                }
            },
            "header": "Key",
        },
    ],
}


def test_preview_evaluates_a_script_key_column_live_on_a_cold_cache(client):
    _bootstrap_model(client)
    r = client.post(
        papi("/artifacts"),
        json={"kind": "table", "name": "keyed", "payload": KEYED_SCRIPT_TABLE},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    t = r.json()["id"]
    r = _preview(
        client,
        {
            "source": {"ref": t},
            "name": "doc",
            "format": "json",
            "json_doc": {"shape": "object", "key_column": 1},
            "transform": _inline("def transform(doc):\n    return sorted(doc)\n"),
        },
    )
    assert r.status_code == 200, r.text
    (f,) = r.json()["files"]
    assert f["error"] is None
    import json

    assert set(json.loads(f["input"])) == {"root", "p1", "p2"}
    assert json.loads(f["output"]) == ["p1", "p2", "root"]
