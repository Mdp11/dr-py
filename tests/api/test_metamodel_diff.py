import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member
from data_rover.api.db_models import Role
from .conftest import AUTH_HEADERS, papi, seed_default_project

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
    assert c.post(papi("/metamodel"), content=_MM,
                  headers={"content-type": "application/x-yaml"}).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    # one Node with no label
    ops_r = c.post(papi("/model/ops"), json={"base_rev": _rev(c), "ops": [
        {"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"}]})
    assert ops_r.status_code == 200, ops_r.text
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_diff_identical_metamodel_is_empty(client: TestClient) -> None:
    before = _rev(client)
    r = client.post(papi("/metamodel/diff"), content=_MM,
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["now_failing"] == []
    assert body["now_passing"] == []
    assert _rev(client) == before, "diff must not advance model_rev"


def test_diff_new_required_property_now_failing(client: TestClient) -> None:
    r = client.post(papi("/metamodel/diff"), content=_MM_REQUIRED,
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["candidate_error_count"] >= 1
    assert any("label" in i["message"] for i in body["now_failing"])


def test_diff_invalid_candidate_422(client: TestClient) -> None:
    r = client.post(papi("/metamodel/diff"), content="elements: [ {",
                    headers={"content-type": "application/x-yaml"})
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
