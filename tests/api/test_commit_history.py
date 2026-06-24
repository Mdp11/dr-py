"""Tests for GET /commits — durable commit history list."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import (
    AUTH_HEADERS,
    commit_create,
    model_rev,
    papi,
    seed_default_project,
)

_MM = """
elements:
  - name: Node
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
    assert c.post(
        papi("/metamodel"), content=_MM,
        headers={"content-type": "application/x-yaml"},
    ).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def test_history_lists_commits_newest_first(client: TestClient) -> None:
    commit_create(client)
    commit_create(client)
    r = client.get(papi("/commits"), headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    body = r.json()
    revs = [c["rev"] for c in body["commits"]]
    assert revs == sorted(revs, reverse=True)
    assert revs[0] == model_rev(client)
    top = body["commits"][0]
    assert top["op_count"] == 1
    assert top["is_rebind"] is False
    assert "author_id" in top and "ts" in top and "message" in top


def test_history_pagination_has_more(client: TestClient) -> None:
    for _ in range(3):
        commit_create(client)
    page1 = client.get(papi("/commits"), params={"limit": 2}, headers=AUTH_HEADERS).json()
    assert len(page1["commits"]) == 2
    assert page1["has_more"] is True
    cursor = page1["commits"][-1]["rev"]
    page2 = client.get(
        papi("/commits"), params={"limit": 2, "before_rev": cursor}, headers=AUTH_HEADERS
    ).json()
    assert all(c["rev"] < cursor for c in page2["commits"])


_MM_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Contains
    containment: true
    source: Widget
    target: Widget
"""


def test_history_marks_rebind_commit(client: TestClient) -> None:
    commit_create(client)
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={model_rev(client)}&message=swap",
        content=_MM_RENAMED, headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    body = client.get(papi("/commits"), headers=AUTH_HEADERS).json()
    top = body["commits"][0]
    assert top["is_rebind"] is True


def test_history_readable_by_viewer(client: TestClient) -> None:
    from data_rover.api import db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    finally:
        gen.close()
    r = client.get(
        papi("/commits"),
        headers={"x-user-id": "vw", "x-user-email": "vw@example.com"},
    )
    assert r.status_code == 200
