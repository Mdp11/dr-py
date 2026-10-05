"""``POST /metamodel/structural-diff``: the diff route's structural half alone."""

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_session
from data_rover.api.tenancy import add_member

from .conftest import (
    AUTH_HEADERS,
    papi,
    seed_default_project,
    head,
    install,
    EMPTY_MODEL,
    commit_ops,
)

_YAML = {"content-type": "application/x-yaml"}

_MM = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""
# Node renamed to Widget (remove+add).
_MM_STRUCT_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Link
    source: Widget
    target: Widget
"""
# Only tightens Link's source multiplicity (one FieldChange).
_MM_STRUCT_MULT = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
    source_multiplicity: "1..1"
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    commit_ops(c, [{"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"}])
    return c


def _member(user_id: str, role: Role) -> dict[str, str]:
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id=user_id, email=f"{user_id}@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, user_id, role)
        s.commit()
    finally:
        gen.close()
    return {**_YAML, "x-user-id": user_id, "x-user-email": f"{user_id}@example.com"}


@pytest.mark.parametrize(
    "candidate",
    [_MM_STRUCT_RENAMED, _MM_STRUCT_MULT, _MM],
    ids=["renamed", "field-change", "identical"],
)
def test_equals_the_diff_routes_structural(client: TestClient, candidate: str) -> None:
    full = client.post(papi("/metamodel/diff"), content=candidate, headers=_YAML)
    assert full.status_code == 200, full.text
    r = client.post(
        papi("/metamodel/structural-diff"), content=candidate, headers=_YAML
    )
    assert r.status_code == 200, r.text
    assert r.json() == full.json()["structural"]


def test_a_field_change_keeps_the_from_key(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel/structural-diff"), content=_MM_STRUCT_MULT, headers=_YAML
    )
    assert r.status_code == 200, r.text
    (chg,) = r.json()["relationship_types"]["changed"]
    assert chg["attributes"] == [
        {"field": "source_multiplicity", "from": "0..*", "to": "1..1"}
    ]


def test_a_json_body_reads_as_the_diff_route_reads_it(client: TestClient) -> None:
    doc = {"elements": [{"name": "Widget"}]}
    full = client.post(papi("/metamodel/diff"), json=doc)
    assert full.status_code == 200, full.text
    r = client.post(papi("/metamodel/structural-diff"), json=doc)
    assert r.status_code == 200, r.text
    assert r.json() == full.json()["structural"]


@pytest.mark.parametrize(
    ("content", "content_type"),
    [
        ("elements: [ {", "application/x-yaml"),
        ("elements:\n  - name: Node\n    extends: Missing\n", "application/x-yaml"),
        (b"\xff\xfe elements:", "application/x-yaml"),
        ("{not valid json", "application/json"),
        ("elements:\n  - name: 2001-13-45\n", "application/x-yaml"),
    ],
    ids=["yaml-syntax", "schema", "bad-utf8", "bad-json", "bad-scalar"],
)
def test_a_bad_candidate_is_422(
    client: TestClient, content: str | bytes, content_type: str
) -> None:
    r = client.post(
        papi("/metamodel/structural-diff"),
        content=content,
        headers={"content-type": content_type},
    )
    assert r.status_code == 422, r.text


def test_a_viewer_is_refused_and_an_editor_is_not(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel/structural-diff"),
        content=_MM_STRUCT_RENAMED,
        headers=_member("vw", Role.viewer),
    )
    assert r.status_code == 403, r.text
    r = client.post(
        papi("/metamodel/structural-diff"),
        content=_MM_STRUCT_RENAMED,
        headers=_member("ed", Role.editor),
    )
    assert r.status_code == 200, r.text


def test_the_model_and_the_issue_store_are_untouched(client: TestClient) -> None:
    before = head().rev
    issues = client.get(papi("/model/issues")).json()
    session = get_session()
    model, store = session.model, session.validation
    assert store is not None
    r = client.post(
        papi("/metamodel/structural-diff"), content=_MM_STRUCT_RENAMED, headers=_YAML
    )
    assert r.status_code == 200, r.text
    assert head().rev == before
    assert client.get(papi("/model/issues")).json() == issues
    assert session.model is model and session.validation is store
