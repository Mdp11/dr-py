"""POST /tables/export with format=json, and POST /tables/json-preview."""

import json

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _body(columns, **over):
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": columns,
        },
        "format": "json",
    }
    body.update(over)
    return body


def test_json_export_returns_an_array_of_objects(client):
    _bootstrap_model(client)
    body = _body(
        [
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
            },
        ]
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.headers["content-disposition"].endswith('.json"')
    docs = json.loads(r.content)
    assert isinstance(docs, list)
    assert docs
    assert set(docs[0]) == {"Block", "Mass"}


def test_default_format_is_still_xlsx(client):
    _bootstrap_model(client)
    body = _body([{"kind": "element", "source": {"kind": "row"}}])
    del body["format"]
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )


def test_json_export_honors_key_overrides(client):
    _bootstrap_model(client)
    body = _body(
        [
            {
                "kind": "element",
                "source": {"kind": "row"},
                "header": "Block",
                "json_export": {"key": "block_name"},
            }
        ]
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    docs = json.loads(r.content)
    assert set(docs[0]) == {"block_name"}


def test_json_export_element_object_mode(client):
    _bootstrap_model(client)
    body = _body(
        [
            {
                "kind": "element",
                "source": {"kind": "row"},
                "header": "Block",
                "json_export": {"value": "object"},
            }
        ]
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    docs = json.loads(r.content)
    assert set(docs[0]["Block"]) == {"id", "name", "type"}


def test_json_export_excludes_hidden_columns(client):
    _bootstrap_model(client)
    body = _body(
        [
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
                "hidden": True,
            },
        ]
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    docs = json.loads(r.content)
    assert set(docs[0]) == {"Block"}


def test_json_export_is_pretty_printed_utf8(client):
    _bootstrap_model(client)
    body = _body([{"kind": "element", "source": {"kind": "row"}, "header": "Block"}])
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert b"\n  " in r.content  # indent=2


def test_small_table_sets_no_truncation_header(client):
    """The truncation flag rides the SHARED preamble — this pins that the json
    branch does not drop the header, without needing a 50 000-row fixture."""
    _bootstrap_model(client)
    body = _body([{"kind": "element", "source": {"kind": "row"}, "header": "Block"}])
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert "X-Table-Truncated" not in r.headers


def test_uncomputed_script_cells_become_error_markers(client):
    """No script runner is configured in the test app, so every script cell
    comes back `pending` and must render `{"$error": ...}` — never null, and
    never a 500. Mirrors the script-column definition used by
    `tests/api/test_tables_script_errors.py`."""
    _bootstrap_model(client)
    body = _body(
        [
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "script",
                "snippet": {
                    "definition": {"code": "def value(elements):\n    return 1\n"}
                },
                "header": "Computed",
            },
        ]
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers.get("X-Table-Script-Errors") == "true"
    docs = json.loads(r.content)
    assert set(docs[0]["Computed"]) == {"$error"}


def test_export_stays_a_read_only_post():
    """Viewer access is decided by the allowlist, not by the format: authz
    classifies a POST as read-only purely by URL suffix. `format: "json"`
    must not have quietly turned the export into a write."""
    from data_rover.api.authz import _READ_ONLY_POST_SUFFIXES

    assert "/tables/export" in _READ_ONLY_POST_SUFFIXES
