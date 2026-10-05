"""User rules on the validation call sites outside POST /commits: the legacy
ops/undo protocol, POST /model/validate and the metamodel-diff sandbox."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from data_rover.api.main import create_app

from .conftest import (
    AUTH_HEADERS,
    papi,
    seed_default_project,
    EMPTY_MODEL,
    install,
    head,
    commit_ops,
)

# Both properties are optional, so every issue below comes from the rules.
_MM = """
elements:
  - name: Building
    properties:
      - {name: name, datatype: string, multiplicity: "0..1"}
  - name: Zone
    properties:
      - {name: label, datatype: string, multiplicity: "0..1"}
relationships:
  - name: Owns
    containment: true
    source: Building
    target: Zone
"""

# candidate schema that leaves the rule compiling clean (an added element type)
_MM_EXTRA_TYPE = """
elements:
  - name: Building
    properties:
      - {name: name, datatype: string, multiplicity: "0..1"}
  - name: Zone
    properties:
      - {name: label, datatype: string, multiplicity: "0..1"}
  - name: Wing
relationships:
  - name: Owns
    containment: true
    source: Building
    target: Zone
"""

# candidate schema that renames the property the rule reads: the rule drifts
_MM_RENAMED_PROP = _MM.replace("{name: name, datatype", "{name: title, datatype")

NAMED_YAML = (
    "rules:\n"
    "  - name: has-name\n"
    "    applies_to: Building\n"
    "    then: {property: name, exists: true}\n"
)

# the assertion lives one hop from the element it is reported on: a Zone's
# `label` decides the Building's verdict, so touching the Zone alone only
# flips the Building's issue if the dirty scope is widened along that hop.
REACH_YAML = (
    "rules:\n"
    "  - name: owns-labeled-zone\n"
    "    applies_to: Building\n"
    "    then:\n"
    "      relationship:\n"
    "        type: Owns\n"
    "        direction: outgoing\n"
    "        exists: true\n"
    "        where: {property: label, exists: true}\n"
)


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    return c


def _rev(c: TestClient) -> int:
    rev: int = head().rev
    return rev


def _commit(
    c: TestClient, ops: list[dict[str, Any]], *, base_rev: int | None = None
) -> Response:
    return c.post(
        papi("/commits"),
        json={
            "base_rev": _rev(c) if base_rev is None else base_rev,
            "ops": ops,
            "lock_tokens": [],
        },
    )


def _rules_op(yaml_text: str) -> dict[str, Any]:
    return {
        "kind": "create_artifact",
        "temp_id": "tmp_rules",
        "artifact_kind": "validation_rules",
        "name": "house-rules",
        "payload": {"schema_version": 1, "yaml": yaml_text},
    }


def _rule_issues(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [i for i in issues if i["check"].startswith("rule:")]


def _stored_rule_checks(c: TestClient) -> set[str]:
    r = c.get(papi("/model/issues"))
    assert r.status_code == 200, r.text
    return {i["check"] for i in r.json()["issues"] if i["check"].startswith("rule:")}


def _reach_setup(c: TestClient) -> tuple[str, str, int]:
    """Commit the reach rule plus a Building owning a labelled Zone (clean)."""
    r = _commit(
        c,
        [
            _rules_op(REACH_YAML),
            {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Building"},
            {
                "kind": "create_element",
                "temp_id": "tmp_z",
                "type_name": "Zone",
                "properties": {"label": "set"},
            },
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Owns",
                "source_id": "tmp_b",
                "target_id": "tmp_z",
            },
        ],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert not _rule_issues(body["issues_added"])  # the rule is satisfied
    return body["id_map"]["tmp_b"], body["id_map"]["tmp_z"], body["model_rev"]


