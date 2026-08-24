"""The validation_rules artifact kind: save-time validation, drift tolerance."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Building
    properties:
      - name: name
        datatype: string
"""

# the comment is the point: the payload stores verbatim TEXT, not parsed JSON,
# so a round trip that dropped it would be a real regression
GOOD_YAML = (
    "# house rules\n"
    "rules:\n"
    "  - name: has-name\n"
    "    applies_to: Building\n"
    "    then: {property: name, exists: true}\n"
)


def _payload(yaml_text: str) -> dict:
    return {"schema_version": 1, "yaml": yaml_text}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"})
    assert res.status_code == 200, res.text
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _rev(client: TestClient) -> int:
    return client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_create_and_roundtrip(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts"),
        json={
            "kind": "validation_rules",
            "name": "house-rules",
            "payload": _payload(GOOD_YAML),
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201, r.text
    aid = r.json()["id"]
    got = client.get(papi(f"/artifacts/{aid}"), headers=AUTH_HEADERS).json()
    assert got["payload"]["yaml"] == GOOD_YAML  # verbatim text, comments-safe


def test_unparseable_yaml_422_at_save(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts"),
        json={"kind": "validation_rules", "name": "bad", "payload": _payload("rules: [")},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_schema_violation_422_at_save(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts"),
        json={
            "kind": "validation_rules",
            "name": "bad2",
            # missing `then`
            "payload": _payload("rules:\n  - name: r\n    applies_to: B\n"),
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_metamodel_drift_saves_fine(client: TestClient) -> None:
    drifted = GOOD_YAML.replace("Building", "NoSuchStereotype")
    r = client.post(
        papi("/artifacts"),
        json={
            "kind": "validation_rules",
            "name": "drifted",
            "payload": _payload(drifted),
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201  # drift is degradation, not invalidity


def test_commit_op_create_accepts_kind(client: TestClient) -> None:
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "message": "add rules",
            "lock_tokens": [],
            "ops": [
                {
                    "kind": "create_artifact",
                    "temp_id": "tmp_1",
                    "artifact_kind": "validation_rules",
                    "name": "via-commit",
                    "payload": _payload(GOOD_YAML),
                },
            ],
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
