"""POST /tables/export: whole-table xlsx export (Task 10)."""

import io

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def test_export_xlsx_has_header_and_rows(client):
    _bootstrap_model(client)
    body = {
        "definition": {
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
    }
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    assert ws is not None
    assert [c.value for c in ws[1]] == ["Block", "Mass"]  # header row
    assert ws.max_row >= 2


def test_export_truncation_header(client):
    _bootstrap_model(client)
    # not asserting the exact flag here unless the fixture exceeds max_rows;
    # assert the header key is absent for a small table
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [{"kind": "element", "source": {"kind": "row"}}],
        }
    }
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert "x-table-truncated" not in {k.lower() for k in r.headers}
