import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member
from data_rover.api.db_models import Role
from data_rover.api.metamodel_candidate import issue_key, model_half
from data_rover.api.schemas import IssueOut
from data_rover.core.validation.issue import Issue, Severity
from .conftest import (
    AUTH_HEADERS,
    papi,
    seed_default_project,
    head,
    install,
    EMPTY_MODEL,
    commit_ops,
)

_MM = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""
# Candidate adds a required property -> existing Nodes now fail.
_MM_REQUIRED = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
        multiplicity: "1"
relationships:
  - name: Link
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    # one Node with no label
    commit_ops(c, [{"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"}])
    return c


def _rev(c: TestClient) -> int:
    return head().rev


def test_diff_identical_metamodel_is_empty(client: TestClient) -> None:
    before = _rev(client)
    r = client.post(
        papi("/metamodel/diff"),
        content=_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["now_failing"] == []
    assert body["now_passing"] == []
    assert _rev(client) == before, "diff must not advance model_rev"


def test_diff_new_required_property_now_failing(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel/diff"),
        content=_MM_REQUIRED,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["candidate_error_count"] >= 1
    assert any("label" in i["message"] for i in body["now_failing"])


def test_diff_invalid_candidate_422(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel/diff"),
        content="elements: [ {",
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 422


def test_viewer_can_call_diff(client: TestClient) -> None:
    """Viewers must receive 200 from /metamodel/diff — it is read-only."""
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    finally:
        gen.close()

    r = client.post(
        papi("/metamodel/diff"),
        content=_MM,
        headers={
            "content-type": "application/x-yaml",
            "x-user-id": "vw",
            "x-user-email": "vw@example.com",
        },
    )
    assert r.status_code == 200, r.text


# Candidate for the STRUCTURAL diff: Node renamed to Widget (remove+add).
_MM_STRUCT_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Link
    source: Widget
    target: Widget
"""
# Candidate that only tightens Link's source multiplicity (one FieldChange).
_MM_STRUCT_MULT = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
    source_multiplicity: "1..1"
"""


def test_diff_returns_structural_section(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel/diff"),
        content=_MM_STRUCT_RENAMED,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    structural = r.json()["structural"]
    assert [t["name"] for t in structural["element_types"]["added"]] == ["Widget"]
    assert [t["name"] for t in structural["element_types"]["removed"]] == ["Node"]
    # Link's endpoints changed => mappings diff only, no attribute noise
    (chg,) = structural["relationship_types"]["changed"]
    assert chg["name"] == "Link"
    assert chg["attributes"] == []
    assert [(m["source"], m["target"]) for m in chg["mappings"]["added"]] == [
        ("Widget", "Widget")
    ]
    # unchanged sections are present-and-empty, not missing
    assert structural["enums"] == {"added": [], "removed": [], "changed": []}


def test_diff_structural_field_change_uses_from_alias(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel/diff"),
        content=_MM_STRUCT_MULT,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    (chg,) = r.json()["structural"]["relationship_types"]["changed"]
    (fc,) = chg["attributes"]
    assert fc == {"field": "source_multiplicity", "from": "0..*", "to": "1..1"}


def _issue(
    message: str, targets: list[str], severity: Severity = Severity.ERROR
) -> Issue:
    return Issue(severity=severity, message=message, target_ids=targets, check="facets")


def _out(issue: Issue) -> dict:
    return IssueOut.from_core(issue).model_dump(mode="json")


def test_model_half_keys_as_dicts_do() -> None:
    """A key keeps its first position and its last value (target ids are
    keyed sorted, so ``[b, a]`` and ``[a, b]`` are one key rendered two ways);
    ``unchanged_count`` counts distinct shared keys; both error counts are the
    raw lengths, duplicates and warnings included."""
    p_first, p_last = _issue("p", ["b", "a"]), _issue("p", ["a", "b"])
    q = _issue("q", ["q"])
    s_cur, s_cand = _issue("s", ["s2", "s1"]), _issue("s", ["s1", "s2"])
    w = _issue("w", ["w"], Severity.WARNING)
    f_first, f_last = _issue("f", ["d", "c"]), _issue("f", ["c", "d"])
    n = _issue("n", ["n"])
    current = [p_first, s_cur, q, p_last, w, w]
    candidate = [f_first, s_cand, n, f_last, w]
    assert issue_key(p_first) == issue_key(p_last)
    half = model_half(current, candidate)
    assert half == {
        "now_failing": [_out(f_last), _out(n)],
        "now_passing": [_out(p_last), _out(q)],
        "unchanged_count": 2,
        "current_error_count": 6,
        "candidate_error_count": 5,
    }
