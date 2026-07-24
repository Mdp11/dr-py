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


def test_export_includes_full_navigation_cell_beyond_cell_cap(client):
    # Regression: export used min(cell_cap, max_cell_elements), so a
    # navigation column's per-column display cap silently truncated exported
    # cells. The workbook must carry the COMPLETE reached set.
    _bootstrap_model(client)
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
                {
                    "kind": "navigation",
                    "source": {"kind": "row"},
                    "mode": "collapse",
                    "cell_cap": 1,
                    "header": "Parts",
                    "navigation": {"definition": {
                        "kind": "path",
                        "start": {"kind": "row"},
                        "steps": [{"kind": "relationship",
                                   "relationship_type": "BlockHasPart",
                                   "direction": "out"}],
                    }},
                },
            ],
        }
    }
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    assert ws is not None
    root_cell = str(
        next(row[1].value for row in ws.iter_rows(min_row=2) if row[0].value == "root")
    )
    assert "p1" in root_cell and "p2" in root_cell  # both parts, despite cell_cap=1


def test_export_skips_hidden_columns(client):
    # The middle column (navigation, hidden) is still EVALUATED — the third
    # column references it by index and reads a property off the elements it
    # reaches — but it must be omitted from the exported header/body.
    _bootstrap_model(client)
    body = {
        "definition": {
            "row_source": {
                "kind": "scope",
                "types": ["Block"],
                "criteria": [
                    {"type": "name_id", "field": "name", "op": "equals", "value": "root"}
                ],
            },
            "columns": [
                {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
                {
                    "kind": "navigation",
                    "source": {"kind": "row"},
                    "mode": "expand",
                    "hidden": True,
                    "header": "Navigation",
                    "navigation": {"definition": {
                        "kind": "path",
                        "start": {"kind": "row"},
                        "steps": [{"kind": "relationship",
                                   "relationship_type": "BlockHasPart",
                                   "direction": "out"}],
                    }},
                },
                {
                    "kind": "property",
                    "source": {"kind": "column", "index": 1},
                    "name": "mass",
                    "header": "Mass",
                },
            ],
        }
    }
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    assert ws is not None
    header = [c.value for c in ws[1]]
    assert len(header) == 2  # hidden column absent
    assert "Navigation" not in header
    assert header == ["Block", "Mass"]
    # the hidden navigation column still evaluated: two rows (p1, p2), and the
    # dependent visible property column correctly read mass off the reached
    # elements rather than blowing up or reading the wrong binding.
    body_rows = [[c.value for c in row] for row in ws.iter_rows(min_row=2)]
    assert len(body_rows) == 2
    assert all(row == ["root", 1.0] for row in body_rows)


def test_export_styling_autofit_filters_borders(client):
    # Item 11: the workbook ships with header-filter dropdowns, borders, bold
    # header, frozen header row, and autofitted column widths.
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
                    # a definition width must NOT drive the export any more
                    "width_px": 700,
                },
            ],
        }
    }
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    assert ws is not None
    # header filters span the data range (header row through the last data row)
    assert ws.auto_filter.ref is not None
    assert ws.auto_filter.ref.startswith("A1:B")
    # frozen header row survives the library swap
    assert ws.freeze_panes == "A2"
    # bold header with a heavier bottom edge; thin borders on data cells
    hdr = ws["A1"]
    assert hdr.font.b
    assert hdr.border.bottom.style == "medium"
    data = ws["A2"]
    assert data.border.left.style == "thin"
    assert data.border.bottom.style == "thin"
    # autofit set a real width, and the 700px definition width did not win
    # (700px under the old px/7 heuristic would exceed 90 char-units)
    w = ws.column_dimensions["B"].width
    assert w is not None and 0 < w < 90


def test_export_row_numbers_column(client):
    # Item 10: `show_row_numbers` prepends a 1-based "#" column, numbered in
    # export row order (which follows the current sort).
    _bootstrap_model(client)
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "show_row_numbers": True,
            "columns": [
                {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            ],
        }
    }
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    assert ws is not None
    header = [c.value for c in ws[1]]
    assert header[0] == "#"
    assert header[1] == "Block"
    numbers = [row[0].value for row in ws.iter_rows(min_row=2) if row[0].value is not None]
    assert numbers == list(range(1, len(numbers) + 1))
    # the autofilter spans the "#" column too
    assert ws.auto_filter.ref.startswith("A1:B")


def test_export_row_numbers_off_by_default(client):
    _bootstrap_model(client)
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            ],
        }
    }
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    assert ws is not None
    assert [c.value for c in ws[1]] == ["Block"]
