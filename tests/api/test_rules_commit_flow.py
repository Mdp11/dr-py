"""User rules across the check-out/commit flow: live issues on commit,
preview, and the rules-artifact edits that change a whole population."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

# A Building owns Zones; both properties are optional, so every issue the
# tests below see comes from the rules, never from built-in multiplicity.
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

# The rule's assertion lives one hop away from the element it is reported on:
# a Zone's `label` decides the Building's verdict. That hop is what the
# commit path's dirty-scope widening has to cross.
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

NAMED_YAML = (
    "rules:\n"
    "  - name: has-name\n"
    "    applies_to: Building\n"
    "    then: {property: name, exists: true}\n"
)

# applies to a type the tests never instantiate: compiles clean, reports
# nothing, so a commit that REPLACES it is the only source of new issues.
INERT_YAML = (
    "rules:\n"
    "  - name: zone-has-label\n"
    "    applies_to: Zone\n"
    "    then: {property: label, exists: true}\n"
)


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    rev: int = c.get(papi("/model/summary")).json()["model_rev"]
    return rev


def _lock(c: TestClient, targets: list[dict[str, str]], intent: str = "edit") -> str:
    r = c.post(papi("/locks"), json={"targets": targets, "intent": intent})
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def _element_targets(*ids: str) -> list[dict[str, str]]:
    return [{"resource_id": i, "mode": "exclusive"} for i in ids]


def _artifact_targets(*ids: str) -> list[dict[str, str]]:
    return [{"resource_id": i, "mode": "exclusive", "type": "artifact"} for i in ids]


def _commit(
    c: TestClient,
    ops: list[dict[str, Any]],
    *,
    base_rev: int | None = None,
    lock_tokens: list[str] | None = None,
) -> Response:
    return c.post(
        papi("/commits"),
        json={
            "base_rev": _rev(c) if base_rev is None else base_rev,
            "ops": ops,
            "lock_tokens": lock_tokens or [],
        },
    )


def _rules_op(yaml_text: str, name: str = "house-rules") -> dict[str, Any]:
    return {
        "kind": "create_artifact",
        "temp_id": "tmp_rules",
        "artifact_kind": "validation_rules",
        "name": name,
        "payload": {"schema_version": 1, "yaml": yaml_text},
    }


def _rule_issues(issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [i for i in issues if i["check"].startswith("rule:")]


def _stored_rule_checks(c: TestClient) -> set[str]:
    r = c.get(papi("/model/issues"))
    assert r.status_code == 200, r.text
    return {i["check"] for i in r.json()["issues"] if i["check"].startswith("rule:")}


def test_commit_far_edit_refreshes_rule_issue(client: TestClient) -> None:
    """Editing the FAR element flips the verdict of the element that owns the
    rule, in the same commit response."""
    r = _commit(
        client,
        [
            _rules_op(REACH_YAML),
            {"kind": "create_element", "temp_id": "tmp_p", "type_name": "Building"},
            {
                "kind": "create_element",
                "temp_id": "tmp_c",
                "type_name": "Zone",
                "properties": {"label": "set"},
            },
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Owns",
                "source_id": "tmp_p",
                "target_id": "tmp_c",
            },
        ],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    parent_id = body["id_map"]["tmp_p"]
    child_id = body["id_map"]["tmp_c"]
    assert not _rule_issues(body["issues_added"])  # the rule is satisfied

    tok = _lock(client, _element_targets(child_id))
    r2 = _commit(
        client,
        [
            {
                "kind": "update_element",
                "id": child_id,
                "properties_patch": {"label": None},
            }
        ],
        base_rev=body["model_rev"],
        lock_tokens=[tok],
    )
    assert r2.status_code == 200, r2.text
    added = _rule_issues(r2.json()["issues_added"])
    assert len(added) == 1
    assert added[0]["target_ids"] == [parent_id]  # expand_dirty crossed the hop
    assert added[0]["check"] == "rule:owns-labeled-zone"

    tok = _lock(client, _element_targets(child_id))
    r3 = _commit(
        client,
        [
            {
                "kind": "update_element",
                "id": child_id,
                "properties_patch": {"label": "back"},
            }
        ],
        base_rev=r2.json()["model_rev"],
        lock_tokens=[tok],
    )
    assert r3.status_code == 200, r3.text
    assert parent_id in r3.json()["issues_removed_owner_ids"]
    assert not _rule_issues(r3.json()["issues_added"])
    assert _stored_rule_checks(client) == set()


def test_commit_rule_artifact_edit_revalidates_population(client: TestClient) -> None:
    """Changing the rule set itself revalidates every element the OLD and NEW
    rules apply to, even though the batch carries no model ops."""
    r = _commit(
        client,
        [
            _rules_op(INERT_YAML),
            {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Building"},
        ],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    art_id = body["changed_artifacts"][0]["id"]
    building_id = body["id_map"]["tmp_b"]
    assert not _rule_issues(body["issues_added"])

    tok = _lock(client, _artifact_targets(art_id))
    r2 = _commit(
        client,
        [
            {
                "kind": "update_artifact",
                "id": art_id,
                "payload": {"schema_version": 1, "yaml": NAMED_YAML},
            }
        ],
        base_rev=body["model_rev"],
        lock_tokens=[tok],
    )
    assert r2.status_code == 200, r2.text
    added = _rule_issues(r2.json()["issues_added"])
    assert [i["target_ids"] for i in added] == [[building_id]]
    assert added[0]["check"] == "rule:has-name"
    assert _stored_rule_checks(client) == {"rule:has-name"}


def test_commit_rule_artifact_delete_drops_issues(client: TestClient) -> None:
    """Deleting the rule set drops the issues it minted."""
    r = _commit(
        client,
        [
            _rules_op(NAMED_YAML),
            {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Building"},
        ],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    art_id = body["changed_artifacts"][0]["id"]
    building_id = body["id_map"]["tmp_b"]
    assert [i["target_ids"] for i in _rule_issues(body["issues_added"])] == [
        [building_id]
    ]

    tok = _lock(client, _artifact_targets(art_id), intent="delete")
    r2 = _commit(
        client,
        [{"kind": "delete_artifact", "id": art_id}],
        base_rev=body["model_rev"],
        lock_tokens=[tok],
    )
    assert r2.status_code == 200, r2.text
    assert building_id in r2.json()["issues_removed_owner_ids"]
    assert not _rule_issues(r2.json()["issues_added"])
    assert _stored_rule_checks(client) == set()


def test_rule_issue_never_blocks_commit(client: TestClient) -> None:
    """A severity-error rule is CONFORMANCE: it is counted and reported but
    never a structural blocker. Strict mode is the separate, opt-in gate that
    rejects conformance issues — rule issues are counted by it like any
    other."""
    r = _commit(client, [_rules_op(NAMED_YAML)])
    assert r.status_code == 200, r.text
    base = r.json()["model_rev"]

    r2 = _commit(
        client,
        [{"kind": "create_element", "temp_id": "tmp_b", "type_name": "Building"}],
        base_rev=base,
    )
    assert r2.status_code == 200, r2.text  # conformance never blocks
    body = r2.json()
    assert body["validation_error_count"] == 1
    assert [i["check"] for i in _rule_issues(body["issues_added"])] == ["rule:has-name"]

    r3 = client.patch(papi("/settings"), json={"strict_mode": True})
    assert r3.status_code == 200, r3.text
    r4 = _commit(
        client,
        [{"kind": "create_element", "temp_id": "tmp_b2", "type_name": "Building"}],
        base_rev=body["model_rev"],
    )
    assert r4.status_code == 422, r4.text
    detail = r4.json()
    assert detail["detail"] == "strict-mode conformance blocker"
    assert "rule:has-name" in {i["check"] for i in detail["conformance_blockers"]}
    assert _rev(client) == body["model_rev"]  # the batch rolled back


def test_preview_reports_rule_issues_without_side_effects(client: TestClient) -> None:
    r = _commit(client, [_rules_op(NAMED_YAML)])
    assert r.status_code == 200, r.text
    before = r.json()["model_rev"]

    payload = {
        "base_rev": before,
        "ops": [
            {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Building"}
        ],
    }
    first = client.post(papi("/commits/preview"), json=payload)
    assert first.status_code == 200, first.text
    got = first.json()
    assert [i["check"] for i in _rule_issues(got["issues"])] == ["rule:has-name"]
    assert got["conformance_error_count"] == 1
    assert got["structural_blockers"] == []
    assert _rev(client) == before

    # Idempotent: no compiled-rules side effect. Ids differ (each preview
    # mints and rolls back its own element), the verdict does not.
    second = client.post(papi("/commits/preview"), json=payload)
    assert second.status_code == 200, second.text
    again = second.json()
    assert [i["check"] for i in again["issues"]] == [i["check"] for i in got["issues"]]
    assert again["conformance_error_count"] == got["conformance_error_count"]
    assert again["structural_blockers"] == []
    assert _rev(client) == before
    assert _stored_rule_checks(client) == set()
