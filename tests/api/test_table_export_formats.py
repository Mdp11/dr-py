"""POST /tables/export with format=csv / format=jsonl (Exporter v2 Phase 2).

The standalone route gets the new formats but NOT `json_doc` — document
shaping stays exporter-entry-only (spec §6)."""

import csv
import io
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


COLUMNS = [
    {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
    {"kind": "property", "source": {"kind": "row"}, "name": "mass", "header": "Mass"},
]


def _body(fmt, **defn_over):
    defn = {"row_source": {"kind": "scope", "types": ["Block"]}, "columns": COLUMNS}
    defn.update(defn_over)
    return {"definition": defn, "format": fmt}


def test_csv_export_ships_text_csv_with_header_row(client):
    _bootstrap_model(client)
    r = client.post(papi("/tables/export"), json=_body("csv"), headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert r.headers["content-disposition"].endswith('.csv"')
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8"))))
    assert rows[0] == ["Block", "Mass"]
    assert len(rows) == 4  # header + root, p1, p2
    assert not r.content.startswith(b"\xef\xbb\xbf")


def test_csv_honors_row_numbers_and_export_layout(client):
    _bootstrap_model(client)
    r = client.post(
        papi("/tables/export"),
        json=_body("csv", show_row_numbers=True, export_order=[-1, 0, 1]),
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8"))))
    assert rows[1][0] == "1"  # row-number pseudo-column at slot 0


def test_jsonl_export_is_one_object_per_line(client):
    _bootstrap_model(client)
    r = client.post(papi("/tables/export"), json=_body("jsonl"), headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ndjson")
    assert r.headers["content-disposition"].endswith('.jsonl"')
    lines = r.content.decode("utf-8").splitlines()
    docs = [json.loads(ln) for ln in lines]
    assert len(docs) == 3
    assert set(docs[0]) == {"Block", "Mass"}
    assert b"\n  " not in r.content  # compact, never indented


def test_jsonl_split_zips_one_jsonl_per_base_element(client):
    import zipfile

    _bootstrap_model(client)
    body = _body(
        "jsonl",
        json_split={"enabled": True, "filename_template": "${name}"},
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = zf.namelist()
    assert len(names) == 3
    assert all(n.endswith(".jsonl") for n in names)
    # Each partition file holds ONLY its own base element's row(s), not the
    # whole unsplit export — a member's stem is that element's display name
    # (the `${name}` template), so its one line's own "Block" field must
    # echo it back.
    for member in names:
        lines = zf.read(member).decode("utf-8").splitlines()
        assert len(lines) == 1
        doc = json.loads(lines[0])
        assert doc["Block"] == member.removesuffix(".jsonl")


def test_csv_ignores_json_split_with_tolerance(client):
    _bootstrap_model(client)
    body = _body(
        "csv",
        json_split={"enabled": True, "filename_template": "${name}"},
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")  # single file, no zip
    # `json_split` must be fully ignored, not partially honored: the body is
    # still the WHOLE unsplit export (header + all 3 rows), not one
    # partition's worth under a misleadingly plain `text/csv` header.
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8"))))
    assert len(rows) == 4  # header + root, p1, p2


def test_unknown_format_is_rejected(client):
    _bootstrap_model(client)
    r = client.post(papi("/tables/export"), json=_body("yaml"), headers=AUTH_HEADERS)
    assert r.status_code == 422
