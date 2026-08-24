"""What the strict-mode conformance gate is scoped to once user rules widen
the dirty set.

The rules' reach expansion (and a rules-artifact edit's applies_to
population) pulls elements the batch never touched into the validated scope.
Their RULE verdicts are the batch's doing; their built-in verdicts are not.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

# `code` is MANDATORY: a Building without it carries a built-in multiplicity
# issue that no commit elsewhere in the model can have caused.
_MM = """
elements:
  - name: Building
    properties:
      - {name: code, datatype: string, multiplicity: "1"}
  - name: Zone
    properties:
      - {name: label, datatype: string, multiplicity: "0..1"}
relationships:
  - name: Owns
    containment: true
    source: Building
    target: Zone
"""

# Satisfied by any Building that owns a Zone. Its reverse path is what drags
# the Building into a Zone-only batch's scope.
OWNS_YAML = (
    "rules:\n"
    "  - name: owns-a-zone\n"
    "    applies_to: Building\n"
    "    then:\n"
    "      relationship:\n"
    "        type: Owns\n"
    "        direction: outgoing\n"
    "        to: Zone\n"
    "        exists: true\n"
)

# Same reverse path, but the verdict depends on the FAR element's property —
# so editing the Zone really does flip the Building's rule.
LABELED_YAML = (
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


def _lock(c: TestClient, eid: str) -> str:
    r = c.post(
        papi("/locks"),
        json={"targets": [{"resource_id": eid, "mode": "exclusive"}], "intent": "edit"},
    )
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


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


def _rules_op(yaml_text: str) -> dict[str, Any]:
    return {
        "kind": "create_artifact",
        "temp_id": "tmp_rules",
        "artifact_kind": "validation_rules",
        "name": "house-rules",
        "payload": {"schema_version": 1, "yaml": yaml_text},
    }


def _seed(c: TestClient, yaml_text: str, *, label: str | None) -> dict[str, Any]:
    """A Building missing its MANDATORY `code`, owning a Zone. The rule set is
    satisfied; the only conformance issue in the model is the built-in
    multiplicity one on the Building."""
    zone: dict[str, Any] = {
        "kind": "create_element",
        "temp_id": "tmp_z",
        "type_name": "Zone",
    }
    if label is not None:
        zone["properties"] = {"label": label}
    r = _commit(
        c,
        [
            _rules_op(yaml_text),
            {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Building"},
            zone,
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
    checks = {i["check"] for i in body["issues_added"]}
    assert checks == {"multiplicity"}, checks
    assert c.patch(papi("/settings"), json={"strict_mode": True}).status_code == 200
    return {
        "building": body["id_map"]["tmp_b"],
        "zone": body["id_map"]["tmp_z"],
        "rules": body["changed_artifacts"][0]["id"],
        "rev": body["model_rev"],
    }


def _edit_zone(
    c: TestClient, ids: dict[str, Any], label: str | None
) -> tuple[Response, str]:
    tok = _lock(c, ids["zone"])
    r = _commit(
        c,
        [
            {
                "kind": "update_element",
                "id": ids["zone"],
                "properties_patch": {"label": label},
            }
        ],
        base_rev=ids["rev"],
        lock_tokens=[tok],
    )
    return r, tok


def test_strict_gate_ignores_builtin_issues_on_widened_elements(
    client: TestClient,
) -> None:
    """A Zone-only edit does not inherit the Building's pre-existing
    multiplicity issue just because the rules' reverse path reaches it."""
    ids = _seed(client, OWNS_YAML, label=None)
    r, _ = _edit_zone(client, ids, "x")
    assert r.status_code == 200, r.text
    assert _rev(client) == ids["rev"] + 1
    # still reported, just not fatal
    assert r.json()["validation_error_count"] >= 1


def test_strict_gate_still_blocks_a_rule_flipped_from_a_far_edit(
    client: TestClient,
) -> None:
    """The companion: a RULE verdict on a widened element is the batch's
    doing, so it must still hard-reject."""
    ids = _seed(client, LABELED_YAML, label="set")
    r, _ = _edit_zone(client, ids, None)
    assert r.status_code == 422, r.text
    detail = r.json()
    assert detail["detail"] == "strict-mode conformance blocker"
    blockers = detail["conformance_blockers"]
    assert {i["check"] for i in blockers} == {"rule:owns-labeled-zone"}
    assert [i["target_ids"] for i in blockers] == [[ids["building"]]]
    assert _rev(client) == ids["rev"]


def test_preview_would_block_matches_the_commit_gate(client: TestClient) -> None:
    """Preview and commit answer the same question: a preview promising a
    landing followed by a 422 is worse than either answer alone."""
    ids = _seed(client, OWNS_YAML, label=None)
    ops = [
        {
            "kind": "update_element",
            "id": ids["zone"],
            "properties_patch": {"label": "x"},
        }
    ]
    r = client.post(
        papi("/commits/preview"), json={"base_rev": ids["rev"], "ops": ops}
    )
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["would_block"] is False
    # the report stays the unfiltered truth — only the gate narrows
    assert got["conformance_error_count"] >= 1

    assert _edit_zone(client, ids, "x")[0].status_code == 200


def test_preview_would_block_on_a_rule_flipped_from_a_far_edit(
    client: TestClient,
) -> None:
    ids = _seed(client, LABELED_YAML, label="set")
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": ids["rev"],
            "ops": [
                {
                    "kind": "update_element",
                    "id": ids["zone"],
                    "properties_patch": {"label": None},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["would_block"] is True
    assert _edit_zone(client, ids, None)[0].status_code == 422


def test_strict_gate_ignores_builtin_issues_across_a_rules_artifact_edit(
    client: TestClient,
) -> None:
    """Saving a rule set widens to the whole applies_to population. That must
    not make the save hostage to every built-in issue in it."""
    ids = _seed(client, OWNS_YAML, label=None)
    art_id = ids["rules"]
    r = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": art_id, "mode": "exclusive", "type": "artifact"}
            ],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    r2 = _commit(
        client,
        [
            {
                "kind": "update_artifact",
                "id": art_id,
                "payload": {"schema_version": 1, "yaml": LABELED_YAML},
            }
        ],
        base_rev=ids["rev"],
        lock_tokens=[r.json()["token"]],
    )
    # the Zone HAS no label, so the new rule flips: that rule verdict blocks,
    # and it is the ONLY thing that does.
    assert r2.status_code == 422, r2.text
    assert {i["check"] for i in r2.json()["conformance_blockers"]} == {
        "rule:owns-labeled-zone"
    }
