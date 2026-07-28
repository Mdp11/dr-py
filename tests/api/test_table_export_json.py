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


def test_preview_returns_rendered_sample(client):
    _bootstrap_model(client)
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}, "header": "Block"}
            ],
        }
    }
    r = client.post(papi("/tables/json-preview"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    payload = r.json()
    assert payload["truncated"] is False
    docs = json.loads(payload["sample"])
    assert isinstance(docs, list)
    assert set(docs[0]) == {"Block"}


def _blocks_column_body():
    return {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}, "header": "Block"}
            ],
        }
    }


def _full_row_count(client) -> int:
    """How many objects the UNBOUNDED json export produces for this fixture —
    the preview assertions are stated relative to it, so they hold whatever
    `_bootstrap_model` happens to seed."""
    body = _blocks_column_body() | {"format": "json"}
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    return len(json.loads(r.content))


def test_preview_drops_the_last_possibly_partial_object(client, monkeypatch):
    """With the window smaller than the table, the final object may be cut
    mid-group, so it is dropped — every earlier one is complete."""
    from data_rover.api.routes import tables as tables_route

    _bootstrap_model(client)
    total = _full_row_count(client)
    assert total >= 3, "fixture too small: seed more Block elements first"
    monkeypatch.setattr(tables_route, "PREVIEW_MAX_ROWS", total - 1)
    r = client.post(
        papi("/tables/json-preview"), json=_blocks_column_body(), headers=AUTH_HEADERS
    )
    payload = r.json()
    assert payload["truncated"] is True
    # window = total - 1 objects (no grouping: one row per object), minus the
    # dropped last one.
    assert len(json.loads(payload["sample"])) == total - 2


def test_preview_keeps_a_lone_object_rather_than_showing_nothing(client, monkeypatch):
    """Dropping the only object would blank the pane, so it is kept and
    `truncated` carries the caveat instead."""
    from data_rover.api.routes import tables as tables_route

    _bootstrap_model(client)
    assert _full_row_count(client) >= 2, (
        "fixture too small: seed more Block elements first"
    )
    monkeypatch.setattr(tables_route, "PREVIEW_MAX_ROWS", 1)
    r = client.post(
        papi("/tables/json-preview"), json=_blocks_column_body(), headers=AUTH_HEADERS
    )
    payload = r.json()
    assert payload["truncated"] is True
    assert len(json.loads(payload["sample"])) == 1


def test_preview_is_read_only_and_reachable_by_a_viewer(client):
    """`/tables/json-preview` must be in authz._READ_ONLY_POST_SUFFIXES."""
    from data_rover.api.authz import _READ_ONLY_POST_SUFFIXES

    assert "/tables/json-preview" in _READ_ONLY_POST_SUFFIXES


def _json_body(**defn_over):
    defn = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
            },
        ],
    }
    defn.update(defn_over)
    return {"definition": defn, "format": "json"}


def test_export_json_honors_export_order(client):
    _bootstrap_model(client)
    body = _json_body(export_order=[1, 0])
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    docs = r.json()
    assert list(docs[0].keys()) == ["Mass", "Block"]


def test_export_json_excludes_an_opted_out_column(client):
    _bootstrap_model(client)
    body = _json_body()
    body["definition"]["columns"][1]["export"] = {"include": False}
    docs = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS).json()
    assert "Mass" not in docs[0]


def test_export_json_emits_row_numbers_when_the_grid_flag_is_on(client):
    # Deliberate behaviour change (spec, "Behaviour change worth stating"):
    # JSON has never carried row numbers, and now follows show_row_numbers.
    _bootstrap_model(client)
    body = _json_body(show_row_numbers=True)
    docs = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS).json()
    assert list(docs[0].keys())[0] == "row_number"
    assert [d["row_number"] for d in docs] == list(range(1, len(docs) + 1))


def test_export_json_ignores_the_xlsx_header_override(client):
    # The two renames are separate: an xlsx header override must never become
    # a JSON key.
    _bootstrap_model(client)
    body = _json_body()
    body["definition"]["columns"][0]["export"] = {"header": "Assembly"}
    docs = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS).json()
    assert "Block" in docs[0]
    assert "Assembly" not in docs[0]


def test_json_preview_honors_export_settings(client):
    _bootstrap_model(client)
    body = _json_body(export_order=[1, 0])
    r = client.post(papi("/tables/json-preview"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    sample = json.loads(r.json()["sample"])
    assert list(sample[0].keys()) == ["Mass", "Block"]


def test_json_export_accepts_item_key_over_the_wire(client):
    """`item_key` has to survive TABLE_ADAPTER validation and reach the
    renderer without disturbing the array's own name. The NESTED shape it
    produces is pinned in tests/table/test_json_export.py, which can build a
    dependent column against a metamodel it controls — this fixture's
    relationships are `_bootstrap_model`'s business, so asserting a nested
    object here would pin the fixture rather than the feature."""
    _bootstrap_model(client)
    body = _body(
        [
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "mode": "expand",
                "header": "Mass",
                "json_export": {
                    "group": True,
                    "key": "Masses",
                    "item_key": "One Mass",
                },
            },
        ]
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    docs = json.loads(r.content)
    assert set(docs[0]) == {"Block", "Masses"}
    assert isinstance(docs[0]["Masses"], list)
