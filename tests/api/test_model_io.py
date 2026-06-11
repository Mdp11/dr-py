"""Tests for the Phase C3 streaming load/save endpoints.

POST /model/load, POST /model/upload, POST /model/save, GET /model/download
(routes/model.py) — file-path loads, raw-body uploads, chunked save/download,
guard parity with the snapshot routes, validation seeding, and save-file
byte-shape compatibility with the frontend writer.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import reset_session

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"
EXAMPLE_MM = EXAMPLES / "example.metamodel.yaml"
SMART_CITY_MM = EXAMPLES / "smart-city.metamodel.yaml"
SMART_CITY_MODEL = EXAMPLES / "smart-city.model.json"


@pytest.fixture
def client() -> TestClient:
    reset_session()
    app = create_app()
    return TestClient(app)


def _upload_metamodel(client: TestClient, path: Path = SMART_CITY_MM) -> None:
    res = client.post(
        "/api/v1/metamodel",
        content=path.read_text(encoding="utf-8"),
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text


def _load(client: TestClient, path: Path) -> dict:
    res = client.post("/api/v1/model/load", json={"path": str(path)})
    assert res.status_code == 200, res.text
    return res.json()


# ---------------------------------------------------------------------------
# POST /model/load
# ---------------------------------------------------------------------------


def test_load_happy_path(client: TestClient, tmp_path: Path) -> None:
    _upload_metamodel(client)
    model_file = tmp_path / "city.model.json"
    model_file.write_text(SMART_CITY_MODEL.read_text(encoding="utf-8"), encoding="utf-8")
    source = json.loads(SMART_CITY_MODEL.read_text(encoding="utf-8"))

    summary = _load(client, model_file)

    # summary shape == GET /model/summary
    assert summary["element_count"] == len(source["elements"])
    assert summary["relationship_count"] == len(source["relationships"])
    assert sum(summary["elements_by_type"].values()) == summary["element_count"]
    assert summary["model_rev"] >= 1
    # set_model cleared the op log
    assert summary["undo_depth"] == 0
    # ONE full validation seeded the session issue store at load time
    assert summary["issue_counts"] is not None

    # the load response IS the current summary
    res = client.get("/api/v1/model/summary")
    assert res.status_code == 200
    assert res.json() == summary

    # spot-check entities landed in the session model
    first = source["elements"][0]
    res = client.get(f"/api/v1/model/elements/{first['id']}")
    assert res.status_code == 200
    got = res.json()
    assert got["type_name"] == first["type_name"]
    assert got["properties"] == first["properties"]


def test_load_missing_file_yields_422(client: TestClient, tmp_path: Path) -> None:
    _upload_metamodel(client)
    res = client.post(
        "/api/v1/model/load", json={"path": str(tmp_path / "nope.json")}
    )
    assert res.status_code == 422, res.text
    # a directory is not a file either
    res = client.post("/api/v1/model/load", json={"path": str(tmp_path)})
    assert res.status_code == 422, res.text


def test_load_non_json_yields_422(client: TestClient, tmp_path: Path) -> None:
    _upload_metamodel(client)
    bad = tmp_path / "bad.model.json"
    bad.write_text("this is not json {", encoding="utf-8")
    res = client.post("/api/v1/model/load", json={"path": str(bad)})
    assert res.status_code == 422, res.text
    assert "Invalid JSON" in res.json()["detail"]


def test_load_without_metamodel_yields_404(
    client: TestClient, tmp_path: Path
) -> None:
    f = tmp_path / "m.json"
    f.write_text('{"elements": [], "relationships": []}', encoding="utf-8")
    res = client.post("/api/v1/model/load", json={"path": str(f)})
    assert res.status_code == 404


def _load_payload_expecting_422(
    client: TestClient, tmp_path: Path, payload: dict
) -> str:
    """Write *payload*, load it, assert 422, return the error detail."""
    f = tmp_path / "guard.model.json"
    f.write_text(json.dumps(payload), encoding="utf-8")
    res = client.post("/api/v1/model/load", json={"path": str(f)})
    assert res.status_code == 422, res.text
    return res.json()["detail"]


def test_load_guard_duplicate_element_id(
    client: TestClient, tmp_path: Path
) -> None:
    _upload_metamodel(client, EXAMPLE_MM)
    e = {"id": "e1", "type_name": "Block", "properties": {"name": "A"}, "rev": 0}
    detail = _load_payload_expecting_422(
        client, tmp_path, {"elements": [e, e], "relationships": []}
    )
    assert "Duplicate element id" in detail


def test_load_guard_dangling_endpoint(client: TestClient, tmp_path: Path) -> None:
    _upload_metamodel(client, EXAMPLE_MM)
    payload = {
        "elements": [
            {"id": "b1", "type_name": "Block", "properties": {"name": "A"}, "rev": 0}
        ],
        "relationships": [
            {
                "id": "r1",
                "type_name": "BlockHasPart",
                "source_id": "b1",
                "target_id": "ghost",
                "properties": {},
                "rev": 0,
            }
        ],
    }
    detail = _load_payload_expecting_422(client, tmp_path, payload)
    assert "unknown target 'ghost'" in detail


def test_load_guard_abstract_type(client: TestClient, tmp_path: Path) -> None:
    _upload_metamodel(client, EXAMPLE_MM)
    payload = {
        "elements": [
            {"id": "e1", "type_name": "NamedElement", "properties": {}, "rev": 0}
        ],
        "relationships": [],
    }
    detail = _load_payload_expecting_422(client, tmp_path, payload)
    assert "abstract" in detail


def test_load_guard_unknown_type(client: TestClient, tmp_path: Path) -> None:
    _upload_metamodel(client, EXAMPLE_MM)
    payload = {
        "elements": [{"id": "e1", "type_name": "Nope", "properties": {}, "rev": 0}],
        "relationships": [],
    }
    detail = _load_payload_expecting_422(client, tmp_path, payload)
    assert "Unknown element type" in detail


def test_load_guard_reserved_tmp_id(client: TestClient, tmp_path: Path) -> None:
    _upload_metamodel(client, EXAMPLE_MM)
    payload = {
        "elements": [
            {"id": "tmp_1", "type_name": "Block", "properties": {"name": "A"}}
        ],
        "relationships": [],
    }
    detail = _load_payload_expecting_422(client, tmp_path, payload)
    assert "reserved" in detail


def test_load_tolerates_extra_top_level_keys(
    client: TestClient, tmp_path: Path
) -> None:
    """Benchmark fixtures carry a top-level ``rev``; loaders must accept it
    (and any other unknown top-level key)."""
    _upload_metamodel(client, EXAMPLE_MM)
    payload = {
        "rev": 7,
        "made_by": "some-other-tool",
        "elements": [
            {"id": "b1", "type_name": "Block", "properties": {"name": "A"}, "rev": 0}
        ],
        "relationships": [],
    }
    f = tmp_path / "extra.model.json"
    f.write_text(json.dumps(payload), encoding="utf-8")
    summary = _load(client, f)
    assert summary["element_count"] == 1


def test_load_defaults_missing_properties_and_rev(
    client: TestClient, tmp_path: Path
) -> None:
    """Entities without ``properties``/``rev`` get the same defaults the
    pydantic snapshot layer applies ({} and 0)."""
    _upload_metamodel(client, EXAMPLE_MM)
    f = tmp_path / "minimal.model.json"
    f.write_text(
        json.dumps(
            {"elements": [{"id": "b1", "type_name": "Block"}], "relationships": []}
        ),
        encoding="utf-8",
    )
    _load(client, f)
    res = client.get("/api/v1/model/elements/b1")
    assert res.status_code == 200
    assert res.json() == {
        "id": "b1",
        "type_name": "Block",
        "properties": {},
        "rev": 0,
    }


def test_load_resets_undo_history(client: TestClient, tmp_path: Path) -> None:
    _upload_metamodel(client, EXAMPLE_MM)
    f = tmp_path / "m.model.json"
    f.write_text(
        json.dumps(
            {
                "elements": [
                    {
                        "id": "b1",
                        "type_name": "Block",
                        "properties": {"name": "A"},
                        "rev": 0,
                    }
                ],
                "relationships": [],
            }
        ),
        encoding="utf-8",
    )
    summary = _load(client, f)

    # build some undo history through the ops protocol
    res = client.post(
        "/api/v1/model/ops",
        json={
            "base_rev": summary["model_rev"],
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_1",
                    "type_name": "Block",
                    "properties": {"name": "B"},
                }
            ],
        },
    )
    assert res.status_code == 200, res.text
    assert client.get("/api/v1/model/summary").json()["undo_depth"] == 1

    reloaded = _load(client, f)
    assert reloaded["undo_depth"] == 0
    assert reloaded["model_rev"] > summary["model_rev"]
    assert reloaded["element_count"] == 1


# ---------------------------------------------------------------------------
# POST /model/upload
# ---------------------------------------------------------------------------


def test_upload_happy_path_octet_stream(client: TestClient) -> None:
    """Raw-body upload with the content type browsers use for streamed Files."""
    _upload_metamodel(client)
    body = SMART_CITY_MODEL.read_bytes()
    res = client.post(
        "/api/v1/model/upload",
        content=body,
        headers={"content-type": "application/octet-stream"},
    )
    assert res.status_code == 200, res.text
    source = json.loads(body)
    summary = res.json()
    assert summary["element_count"] == len(source["elements"])
    assert summary["relationship_count"] == len(source["relationships"])
    assert summary["issue_counts"] is not None
    assert summary["undo_depth"] == 0
    assert client.get("/api/v1/model/summary").json() == summary


def test_upload_invalid_json_yields_422(client: TestClient) -> None:
    _upload_metamodel(client, EXAMPLE_MM)
    res = client.post(
        "/api/v1/model/upload",
        content=b"\x00\x01 not json",
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 422, res.text


# ---------------------------------------------------------------------------
# POST /model/save + GET /model/download
# ---------------------------------------------------------------------------


def test_save_round_trips_and_matches_frontend_shape(
    client: TestClient, tmp_path: Path
) -> None:
    _upload_metamodel(client)
    src_file = tmp_path / "in.model.json"
    src_file.write_text(SMART_CITY_MODEL.read_text(encoding="utf-8"), encoding="utf-8")
    _load(client, src_file)

    out_file = tmp_path / "out.model.json"
    res = client.post("/api/v1/model/save", json={"path": str(out_file)})
    assert res.status_code == 200, res.text
    body = res.json()
    source = json.loads(src_file.read_text(encoding="utf-8"))
    assert body["path"] == str(out_file)
    assert body["element_count"] == len(source["elements"])
    assert body["relationship_count"] == len(source["relationships"])
    assert body["bytes_written"] == out_file.stat().st_size

    saved_text = out_file.read_text(encoding="utf-8")
    saved = json.loads(saved_text)
    # top-level keys exactly as the frontend writes, in order
    assert list(saved.keys()) == ["elements", "relationships"]
    # entity-wise round trip: load(save(load(x))) == x
    assert saved["elements"] == source["elements"]
    assert saved["relationships"] == source["relationships"]
    # byte shape == JSON.stringify(value, null, 2) (which json.dumps(indent=2)
    # reproduces for this data) — the old frontend reader/writer contract
    assert saved_text == json.dumps(saved, indent=2, ensure_ascii=False)

    # and the saved file loads back to an identical model
    reloaded = _load(client, out_file)
    assert reloaded["element_count"] == body["element_count"]
    assert reloaded["relationship_count"] == body["relationship_count"]


def test_save_without_path_yields_422(client: TestClient, tmp_path: Path) -> None:
    _upload_metamodel(client, EXAMPLE_MM)
    f = tmp_path / "m.model.json"
    f.write_text('{"elements": [], "relationships": []}', encoding="utf-8")
    _load(client, f)
    res = client.post("/api/v1/model/save", json={})
    assert res.status_code == 422, res.text
    assert "path" in res.json()["detail"]


def test_save_unwritable_path_yields_422(
    client: TestClient, tmp_path: Path
) -> None:
    _upload_metamodel(client, EXAMPLE_MM)
    f = tmp_path / "m.model.json"
    f.write_text('{"elements": [], "relationships": []}', encoding="utf-8")
    _load(client, f)
    res = client.post(
        "/api/v1/model/save",
        json={"path": str(tmp_path / "no" / "such" / "dir" / "x.json")},
    )
    assert res.status_code == 422, res.text


def test_save_without_model_yields_404(client: TestClient, tmp_path: Path) -> None:
    _upload_metamodel(client, EXAMPLE_MM)
    res = client.post(
        "/api/v1/model/save", json={"path": str(tmp_path / "x.json")}
    )
    assert res.status_code == 404


def test_download_equals_save_bytes(client: TestClient, tmp_path: Path) -> None:
    _upload_metamodel(client)
    src_file = tmp_path / "in.model.json"
    src_file.write_text(SMART_CITY_MODEL.read_text(encoding="utf-8"), encoding="utf-8")
    _load(client, src_file)

    out_file = tmp_path / "out.model.json"
    res = client.post("/api/v1/model/save", json={"path": str(out_file)})
    assert res.status_code == 200, res.text

    res = client.get("/api/v1/model/download")
    assert res.status_code == 200
    assert res.headers["content-disposition"] == 'attachment; filename="model.json"'
    assert res.content == out_file.read_bytes()


def test_download_without_model_yields_404(client: TestClient) -> None:
    _upload_metamodel(client, EXAMPLE_MM)
    res = client.get("/api/v1/model/download")
    assert res.status_code == 404
