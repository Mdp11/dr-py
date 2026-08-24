"""User rules on the validation call sites outside POST /commits: the legacy
ops/undo protocol, POST /model/validate, POST /model/apply-cr and the
metamodel-diff sandbox."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from data_rover.api.session import get_session
from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

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


def test_legacy_ops_path_keeps_rule_issues_live(client: TestClient) -> None:
    """POST /model/ops runs the session's rules and widens its dirty set: an
    edit to the FAR element flips the verdict of the element that owns the
    rule, in the ops response itself."""
    building_id, zone_id, rev = _reach_setup(client)

    r = client.post(
        papi("/model/ops"),
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": zone_id,
                    "properties_patch": {"label": None},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    added = _rule_issues(r.json()["issues_added"])
    assert [i["check"] for i in added] == ["rule:owns-labeled-zone"]
    assert added[0]["target_ids"] == [building_id]  # the hop was crossed
    assert _stored_rule_checks(client) == {"rule:owns-labeled-zone"}


def test_undo_of_rules_artifact_commit_restores_rules(client: TestClient) -> None:
    """Undoing the commit that created a rules artifact recompiles the rule
    sets and drops the issues the artifact minted."""
    first = _commit(
        client, [{"kind": "create_element", "temp_id": "tmp_b", "type_name": "Building"}]
    )
    assert first.status_code == 200, first.text
    building_id = first.json()["id_map"]["tmp_b"]

    second = _commit(client, [_rules_op(NAMED_YAML)], base_rev=first.json()["model_rev"])
    assert second.status_code == 200, second.text
    assert [i["target_ids"] for i in _rule_issues(second.json()["issues_added"])] == [
        [building_id]
    ]
    assert _stored_rule_checks(client) == {"rule:has-name"}

    undone = client.post(papi("/model/undo"))
    assert undone.status_code == 200, undone.text
    assert building_id in undone.json()["issues_removed_owner_ids"]
    assert not _rule_issues(undone.json()["issues_added"])
    assert _stored_rule_checks(client) == set()
    assert get_session().compiled_rules.total == 0


def test_validate_full_includes_rules(client: TestClient) -> None:
    """POST /model/validate with no ops re-runs the whole pipeline WITH the
    session's rules, and the store it reseeds keeps them."""
    r = _commit(
        client,
        [
            _rules_op(NAMED_YAML),
            {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Building"},
        ],
    )
    assert r.status_code == 200, r.text
    building_id = r.json()["id_map"]["tmp_b"]

    got = client.post(papi("/model/validate"), json={})
    assert got.status_code == 200, got.text
    issues = _rule_issues(got.json())
    assert [i["check"] for i in issues] == ["rule:has-name"]
    assert issues[0]["target_ids"] == [building_id]
    assert _stored_rule_checks(client) == {"rule:has-name"}


def test_validate_staged_includes_rules(client: TestClient) -> None:
    """The staged branch applies the client's uncommitted ops, then reports the
    rule verdicts they flip — including on elements the ops never touched."""
    building_id, zone_id, rev = _reach_setup(client)

    got = client.post(
        papi("/model/validate"),
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": zone_id,
                    "properties_patch": {"label": None},
                }
            ],
        },
    )
    assert got.status_code == 200, got.text
    staged = _rule_issues(got.json())
    assert [i["check"] for i in staged] == ["rule:owns-labeled-zone"]
    assert staged[0]["target_ids"] == [building_id]
    assert staged[0]["origin"] == "uncommitted"
    assert _rev(client) == rev  # the staged batch rolled back


def test_metamodel_diff_shows_rule_flips(client: TestClient) -> None:
    """The candidate side compiles the session's rule SOURCES against the
    candidate schema, so a rule that still holds stays unchanged and one that
    drifts (skipped whole at compile) reports as now_passing."""
    r = _commit(
        client,
        [
            _rules_op(NAMED_YAML),
            {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Building"},
        ],
    )
    assert r.status_code == 200, r.text
    building_id = r.json()["id_map"]["tmp_b"]

    def diff(blob: str) -> dict[str, Any]:
        got = client.post(
            papi("/metamodel/diff"),
            content=blob,
            headers={"content-type": "application/x-yaml"},
        )
        assert got.status_code == 200, got.text
        body: dict[str, Any] = got.json()
        return body

    # the rule compiles clean under this candidate and still fails: no flip
    same = diff(_MM_EXTRA_TYPE)
    assert not _rule_issues(same["now_passing"])
    assert not _rule_issues(same["now_failing"])

    # renaming `name` drifts the rule; a drifted rule is skipped whole, so it
    # reports nothing under the candidate and its issue lands in now_passing
    drifted = diff(_MM_RENAMED_PROP)
    passing = _rule_issues(drifted["now_passing"])
    assert [i["check"] for i in passing] == ["rule:has-name"]
    assert passing[0]["target_ids"] == [building_id]
    assert not _rule_issues(drifted["now_failing"])


def test_apply_cr_session_rule_liveness(client: TestClient) -> None:
    """Session-mode apply-cr validates through the session's rules and widens
    the CR's dirty set along the rules' reach."""
    building_id, zone_id, _ = _reach_setup(client)

    zone = {"id": zone_id, "type_name": "Zone", "properties": {}, "rev": 0}
    payload = {
        "cr": {
            "format": "datarover.cr/v1",
            "createdAt": "2024-01-01T00:00:00Z",
            "ops": {
                "elements": {
                    "modified": [
                        {
                            "id": zone_id,
                            "before": {**zone, "properties": {"label": "set"}},
                            "after": zone,
                        }
                    ]
                }
            },
        }
    }
    r = client.post(papi("/model/apply-cr"), json=payload)
    assert r.status_code == 200, r.text
    added = _rule_issues(r.json()["issues_added"])
    assert [i["check"] for i in added] == ["rule:owns-labeled-zone"]
    assert added[0]["target_ids"] == [building_id]
    assert _stored_rule_checks(client) == {"rule:owns-labeled-zone"}
