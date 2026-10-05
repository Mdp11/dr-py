"""Revert refuses ranges containing artifact ops."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, EMPTY_MODEL, head, install, papi, seed_default_project

_MM = """
elements:
  - name: Node
"""

SNIP: dict[str, Any] = {
    "schema_version": 1,
    "language": "python",
    "code": "def value(el):\n    return 1\n",
}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()  # each TestClient creates its own event loop; clear the cached one
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    return c


def _rev(c: TestClient) -> int:
    rev: int = head().rev
    return rev


def _commit_create_snippet(c: TestClient, name: str = "s1") -> str:
    r = c.post(
        papi("/commits"),
        json={
            "base_rev": _rev(c),
            "ops": [
                {
                    "kind": "create_artifact",
                    "temp_id": "tmp_a",
                    "artifact_kind": "code_snippet",
                    "name": name,
                    "payload": SNIP,
                }
            ],
            "lock_tokens": [],
        },
    )
    assert r.status_code == 200, r.text
    aid: str = r.json()["id_map"]["tmp_a"]
    return aid


def test_revert_across_artifact_commit_409(client: TestClient) -> None:
    base = _rev(client)
    _commit_create_snippet(client, "s-revert")
    artifact_rev = _rev(client)
    r = client.post(
        papi("/commits/revert"),
        json={"target_rev": base, "base_rev": artifact_rev},
    )
    assert r.status_code == 409
    assert "artifact" in r.json()["detail"]
    assert r.json()["artifact_commit_rev"] == artifact_rev
    assert _rev(client) == artifact_rev  # nothing moved
