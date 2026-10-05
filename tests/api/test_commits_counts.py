"""Commits store the validation count and issues the client reports; a revert
has no client preview and stores NULL."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from data_rover.api import db
from data_rover.api.db_models import Commit
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from tests.api.conftest import (
    AUTH_HEADERS,
    EMPTY_MODEL,
    commit_ops,
    head,
    install,
    papi,
    seed_default_project,
)

_MM = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
"""

_ISSUE = {
    "severity": "error",
    "message": "label: reported by the client",
    "target_ids": ["tmp_n"],
    "check": "facets",
    "origin": "uncommitted",
}

_CREATE = {
    "kind": "create_element",
    "temp_id": "tmp_n",
    "type_name": "Node",
    "properties": {"label": "A"},
}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    return c


def _commit_row(rev: int) -> Commit:
    gen = db.get_db()
    s = next(gen)
    try:
        row = s.scalars(select(Commit).where(Commit.rev == rev)).one()
        s.expunge(row)
        return row
    finally:
        gen.close()


def test_commit_stores_reported_count(client: TestClient) -> None:
    base = head().rev
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [_CREATE],
            "validation_error_count": 3,
            "issues": [_ISSUE],
        },
    )
    assert r.status_code == 200, r.text
    # The batch is valid, so the server would count 0.
    assert r.json()["validation_error_count"] == 3
    row = _commit_row(base + 1)
    assert row.validation_error_count == 3
    assert [i["message"] for i in row.issues] == [_ISSUE["message"]]
    assert row.issues[0]["target_ids"] == ["tmp_n"]


def test_commit_without_reported_count_stores_zero(client: TestClient) -> None:
    body = commit_ops(client, [_CREATE])
    assert body["validation_error_count"] == 0
    row = _commit_row(body["model_rev"])
    assert row.validation_error_count == 0
    assert row.issues == []


def test_revert_stores_null_count(client: TestClient) -> None:
    target = head().rev
    commit_ops(client, [_CREATE])
    r = client.post(
        papi("/commits/revert"),
        json={"target_rev": target, "base_rev": head().rev},
    )
    assert r.status_code == 200, r.text
    assert r.json()["validation_error_count"] is None
    row = _commit_row(r.json()["model_rev"])
    assert row.validation_error_count is None
    assert row.issues == []
    listed = client.get(papi("/commits")).json()["commits"]
    assert listed[0]["rev"] == row.rev
    assert listed[0]["validation_error_count"] is None
