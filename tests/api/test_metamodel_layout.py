"""GET/PUT /metamodel/layout — shared canvas positions (spec 2026-08-13 §5).

Presentation-only: last-write-wins, no lease, no commit journal entry. The
authz matrix is the standard method-based one: any member reads, editors+
write, viewers 403 on PUT, non-members 403, unknown project 404.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Membership, Role, User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID

from .conftest import AUTH_HEADERS, papi, seed_default_project

VIEWER_HEADERS = {"x-user-id": "viewer-user", "x-user-email": "viewer@example.com"}
STRANGER_HEADERS = {"x-user-id": "stranger", "x-user-email": "stranger@example.com"}

PAYLOAD = {"positions": {"el:Zone": {"x": 12.5, "y": -40.0}, "enum:Status": {"x": 0, "y": 0}}}


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _seed_viewer() -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, "viewer-user") is None:
            s.add(User(id="viewer-user", email="viewer@example.com"))
            s.add(
                Membership(
                    user_id="viewer-user", project_id=DEFAULT_PROJECT_ID, role=Role.viewer
                )
            )
            s.commit()
    finally:
        gen.close()


def test_get_layout_empty_before_any_save(client):
    seed_default_project()
    r = client.get(papi("/metamodel/layout"), headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.json() == {"positions": {}}


def test_put_then_get_round_trips(client):
    seed_default_project()
    r = client.put(papi("/metamodel/layout"), json=PAYLOAD, headers=AUTH_HEADERS)
    assert r.status_code == 204
    r = client.get(papi("/metamodel/layout"), headers=AUTH_HEADERS)
    assert r.json()["positions"]["el:Zone"] == {"x": 12.5, "y": -40.0}


def test_put_overwrites_last_write_wins(client):
    seed_default_project()
    client.put(papi("/metamodel/layout"), json=PAYLOAD, headers=AUTH_HEADERS)
    second = {"positions": {"el:Zone": {"x": 1.0, "y": 2.0}}}
    client.put(papi("/metamodel/layout"), json=second, headers=AUTH_HEADERS)
    r = client.get(papi("/metamodel/layout"), headers=AUTH_HEADERS)
    assert r.json() == second


def test_viewer_reads_but_cannot_write(client):
    seed_default_project()
    _seed_viewer()
    assert client.get(papi("/metamodel/layout"), headers=VIEWER_HEADERS).status_code == 200
    r = client.put(papi("/metamodel/layout"), json=PAYLOAD, headers=VIEWER_HEADERS)
    assert r.status_code == 403


def test_non_member_403_unknown_project_404(client):
    seed_default_project()
    assert (
        client.get(papi("/metamodel/layout"), headers=STRANGER_HEADERS).status_code == 403
    )
    r = client.get(
        "/api/v1/projects/nope/metamodel/layout", headers=AUTH_HEADERS
    )
    assert r.status_code == 404


def test_invalid_payload_422(client):
    seed_default_project()
    r = client.put(
        papi("/metamodel/layout"),
        json={"positions": {"el:Zone": {"x": "NaN-ish"}}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422
