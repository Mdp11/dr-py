"""Tests for GET /commits/{rev}/model — historical model reconstruction."""

from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from data_rover.api.main import create_app
from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member
from tests.api.conftest import (
    AUTH_HEADERS,
    commit_create,
    model_rev,
    papi,
    seed_default_project,
)

_MM = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.post(papi("/metamodel"), content=_MM,
                  headers={"content-type": "application/x-yaml"}).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def test_model_at_rev_returns_historical_state(client: TestClient) -> None:
    commit_create(client, "A")
    r1 = model_rev(client)
    commit_create(client, "B")
    at_r1 = client.get(papi(f"/commits/{r1}/model"), headers=AUTH_HEADERS)
    assert at_r1.status_code == 200, at_r1.text
    assert len(at_r1.json()["elements"]) == 1
    at_head = client.get(papi(f"/commits/{model_rev(client)}/model"), headers=AUTH_HEADERS)
    assert len(at_head.json()["elements"]) == 2


def test_model_at_rev_out_of_range_422(client: TestClient) -> None:
    commit_create(client, "A")
    r = client.get(papi("/commits/999/model"), headers=AUTH_HEADERS)
    assert r.status_code == 422
    assert r.json()["detail"] == "rev out of range"


def test_model_at_negative_rev_422(client: TestClient) -> None:
    commit_create(client, "A")
    r = client.get(papi("/commits/-1/model"), headers=AUTH_HEADERS)
    assert r.status_code == 422


def test_model_at_rev_readable_by_viewer(client: TestClient) -> None:
    commit_create(client, "A")
    r1 = model_rev(client)
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    finally:
        gen.close()
    r = client.get(papi(f"/commits/{r1}/model"),
                   headers={"x-user-id": "vw", "x-user-email": "vw@example.com"})
    assert r.status_code == 200
