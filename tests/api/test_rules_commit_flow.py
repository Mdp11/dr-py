"""User rules across the commit flow: the server stores a rules artifact like
any other and never evaluates it. Rule verdicts are the engine's."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, EMPTY_MODEL, head, install, papi, seed_default_project

_MM = """
elements:
  - name: Building
    properties:
      - {name: name, datatype: string, multiplicity: "0..1"}
"""

NAMED_YAML = (
    "rules:\n"
    "  - name: has-name\n"
    "    applies_to: Building\n"
    "    then: {property: name, exists: true}\n"
)


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    return c


def _commit(c: TestClient, ops: list[dict[str, Any]], **extra: Any) -> Response:
    return c.post(
        papi("/commits"), json={"base_rev": head().rev, "ops": ops, **extra}
    )


def test_rule_violation_lands_and_the_reported_count_is_stored(
    client: TestClient,
) -> None:
    rules = {
        "kind": "create_artifact",
        "temp_id": "tmp_rules",
        "artifact_kind": "validation_rules",
        "name": "house-rules",
        "payload": {"schema_version": 1, "yaml": NAMED_YAML},
    }
    assert _commit(client, [rules]).status_code == 200

    # strict mode is client-enforced, so the server lands the violation too
    assert client.patch(papi("/settings"), json={"strict_mode": True}).status_code == 200
    r = _commit(
        client,
        [{"kind": "create_element", "temp_id": "tmp_b", "type_name": "Building"}],
        validation_error_count=1,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["validation_error_count"] == 1
    assert body["issues_added"] == []
    assert len(head().elements) == 1
