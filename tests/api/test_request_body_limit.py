"""``deps.read_capped_body`` — the shared size guard on the routes that buffer
a raw request body whole (POST /model/upload, POST /model/compare).

413 for an over-cap body (never the routes' 422 for a malformed one), via the
``Content-Length`` header when there is one and via the running total when
there is not; ``DATA_ROVER_MAX_REQUEST_BODY_BYTES=0`` disables the cap.
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
"""


def _model_body(name: str = "A") -> bytes:
    return json.dumps(
        {
            "elements": [
                {"id": "a", "type_name": "Item", "properties": {"name": name}}
            ],
            "relationships": [],
        }
    ).encode()


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    res = c.post(f"{API}/model", json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


@pytest.fixture
def small_cap(monkeypatch: pytest.MonkeyPatch) -> int:
    limit = 64
    monkeypatch.setenv("DATA_ROVER_MAX_REQUEST_BODY_BYTES", str(limit))
    return limit


@pytest.mark.parametrize("route", ["model/upload", "model/compare"])
def test_over_cap_body_yields_413(
    client: TestClient, small_cap: int, route: str
) -> None:
    body = _model_body("x" * 200)
    assert len(body) > small_cap
    res = client.post(f"{API}/{route}", content=body)
    assert res.status_code == 413, res.text
    assert "too large" in res.json()["detail"]


@pytest.mark.parametrize("route", ["model/upload", "model/compare"])
def test_under_cap_body_still_accepted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, route: str
) -> None:
    body = _model_body()
    monkeypatch.setenv("DATA_ROVER_MAX_REQUEST_BODY_BYTES", str(len(body) + 1))
    res = client.post(f"{API}/{route}", content=body)
    assert res.status_code == 200, res.text


@pytest.mark.parametrize("route", ["model/upload", "model/compare"])
def test_over_cap_without_content_length_yields_413(
    client: TestClient, small_cap: int, route: str
) -> None:
    """A chunked body has no Content-Length, so the running total is the guard."""
    body = _model_body("x" * 200)

    def chunks() -> Iterator[bytes]:
        yield body[:10]
        yield body[10:]

    res = client.post(f"{API}/{route}", content=chunks())
    assert "content-length" not in {k.lower() for k in res.request.headers}
    assert res.status_code == 413, res.text


@pytest.mark.parametrize("route", ["model/upload", "model/compare"])
def test_zero_disables_the_cap(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, route: str
) -> None:
    monkeypatch.setenv("DATA_ROVER_MAX_REQUEST_BODY_BYTES", "0")
    res = client.post(f"{API}/{route}", content=_model_body("x" * 5000))
    assert res.status_code == 200, res.text


def test_malformed_body_under_the_cap_stays_422(
    client: TestClient, small_cap: int
) -> None:
    res = client.post(f"{API}/model/upload", content=b"not json")
    assert res.status_code == 422, res.text
