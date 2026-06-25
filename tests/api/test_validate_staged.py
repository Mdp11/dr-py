from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.routes.validation import classify_issue_origins
from data_rover.api.session import get_session
from data_rover.core.validation.issue import Issue, Severity

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"
EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "example.metamodel.yaml"


def _issue(msg: str, owner: str, sev: Severity = Severity.ERROR) -> Issue:
    return Issue(severity=sev, message=msg, target_ids=[owner])


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _seed(client: TestClient) -> dict:
    """Example metamodel + a Block, a valid Requirement (priority 3), Satisfies."""
    client.post(
        f"{API}/metamodel",
        content=EXAMPLE.read_text(encoding="utf-8"),
        headers={"content-type": "application/x-yaml"},
    )
    client.post(f"{API}/model", json={"elements": [], "relationships": []})
    client.post(
        f"{API}/model/elements",
        json={"type": "Block", "properties": {"name": "Wing", "mass": 12.5}},
    )
    req = client.post(
        f"{API}/model/elements",
        json={"type": "Requirement",
              "properties": {"name": "REQ-1", "status": "Draft", "priority": 3}},
    ).json()
    return {"req_id": req["id"], "rev": get_session().model_rev}


def test_staged_validate_flags_new_violation_as_uncommitted(client: TestClient) -> None:
    seeded = _seed(client)
    # baseline committed model is clean
    assert client.post(f"{API}/model/validate").json() == []

    res = client.post(
        f"{API}/model/validate",
        json={
            "base_rev": seeded["rev"],
            "ops": [{"kind": "update_element", "id": seeded["req_id"],
                     "properties_patch": {"priority": 99}}],
        },
    )
    assert res.status_code == 200, res.text
    issues = res.json()
    bad = [i for i in issues if "priority" in i["message"]]
    assert bad and all(i["origin"] == "uncommitted" for i in bad), issues

    # the live model is untouched: a plain re-validate is still clean and rev held
    assert client.post(f"{API}/model/validate").json() == []
    assert get_session().model_rev == seeded["rev"]


def test_staged_validate_stale_base_rev_returns_409(client: TestClient) -> None:
    seeded = _seed(client)
    res = client.post(
        f"{API}/model/validate",
        json={
            "base_rev": seeded["rev"] - 1,
            "ops": [{"kind": "update_element", "id": seeded["req_id"],
                     "properties_patch": {"priority": 99}}],
        },
    )
    assert res.status_code == 409, res.text
    assert res.json()["model_rev"] == seeded["rev"]


def test_staged_validate_resolved_and_on_server(client: TestClient) -> None:
    seeded = _seed(client)
    # Commit a violation onto the server so it becomes pre-existing.
    client.post(
        f"{API}/model/ops",
        json={"base_rev": seeded["rev"],
              "ops": [{"kind": "update_element", "id": seeded["req_id"],
                       "properties_patch": {"priority": 99}}]},
    )
    rev = get_session().model_rev
    # Stage an op that fixes it.
    res = client.post(
        f"{API}/model/validate",
        json={"base_rev": rev,
              "ops": [{"kind": "update_element", "id": seeded["req_id"],
                       "properties_patch": {"priority": 2}}]},
    )
    assert res.status_code == 200, res.text
    resolved = [i for i in res.json() if "priority" in i["message"]]
    assert resolved and all(i["origin"] == "resolved" for i in resolved), res.json()


def test_classify_tags_on_server_uncommitted_and_resolved() -> None:
    pre_existing = _issue("dangling ref", "z1")
    fixed = _issue("name not unique", "r2")
    committed = [pre_existing, fixed]

    introduced = _issue("priority above max", "req1")
    working = [pre_existing, introduced]  # `fixed` is gone, `introduced` is new

    out = classify_issue_origins(committed, working)
    by_msg = {o.message: o.origin for o in out}

    assert by_msg["dangling ref"] == "on_server"
    assert by_msg["priority above max"] == "uncommitted"
    assert by_msg["name not unique"] == "resolved"
    # resolved issues are returned in addition to the working set
    assert len(out) == 3


def test_classify_duplicate_issues_use_multiset_matching() -> None:
    committed = [_issue("dup", "a")]
    working = [_issue("dup", "a"), _issue("dup", "a")]  # one pre-existing, one new

    origins = sorted(o.origin for o in classify_issue_origins(committed, working))
    assert origins == ["on_server", "uncommitted"]
