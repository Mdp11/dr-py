import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.main import create_app
from data_rover.api.db_models import Commit, Role
from data_rover.api.tenancy import add_member
from data_rover.api.session import DEFAULT_PROJECT_ID
from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""
_MM_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Link
    source: Widget
    target: Widget
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.post(papi("/metamodel"), content=_MM,
                  headers={"content-type": "application/x-yaml"}).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    c.post(papi("/model/ops"), json={"base_rev": _rev(c), "ops": [
        {"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"}]})
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_rebind_succeeds_and_journals(client: TestClient) -> None:
    before = _rev(client)
    r = client.post(papi("/metamodel/rebind") + f"?base_rev={before}&message=swap",
                    content=_MM_RENAMED, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_rev"] == before + 1
    # the existing Node is now an instance of an unknown type -> conformance issue
    assert body["validation_error_count"] >= 1
    # a commit row carries the from/to metamodel ids
    gen = db.get_db()
    s = next(gen)
    try:
        row = s.get(Commit, (DEFAULT_PROJECT_ID, before + 1))
        assert row is not None
        assert row.to_metamodel_id and row.from_metamodel_id
        mr = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert mr is not None
        assert mr.metamodel_id == row.to_metamodel_id
    finally:
        gen.close()
    # new metamodel is live
    mm = client.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    assert any(e["name"] == "Widget" for e in mm["elements"])


def test_rebind_stale_base_rev_409(client: TestClient) -> None:
    r = client.post(papi("/metamodel/rebind") + "?base_rev=999",
                    content=_MM_RENAMED, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 409


def test_rebind_invalid_candidate_422(client: TestClient) -> None:
    r = client.post(papi("/metamodel/rebind") + f"?base_rev={_rev(client)}",
                    content="elements: [ {", headers={"content-type": "application/x-yaml"})
    assert r.status_code == 422


def test_rebind_requires_owner_403(client: TestClient) -> None:
    # add an editor and authenticate as them
    gen = db.get_db()
    s = next(gen)
    try:
        from data_rover.api.db_models import User
        s.add(User(id="ed", email="ed@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "ed", Role.editor)
        s.commit()
    finally:
        gen.close()
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={_rev(client)}",
        content=_MM_RENAMED,
        headers={"content-type": "application/x-yaml",
                 "x-user-id": "ed", "x-user-email": "ed@example.com"},
    )
    assert r.status_code == 403


def test_rebind_refuses_when_lock_active(client: TestClient) -> None:
    # acquire an exclusive lease on the Node, then attempt a rebind
    node_id = client.get(
        papi("/model/elements"), params={"limit": 1}, headers=AUTH_HEADERS
    ).json()["items"][0]["id"]
    lk = client.post(
        papi("/locks"), headers=AUTH_HEADERS,
        json={"targets": [{"resource_id": node_id, "mode": "exclusive"}], "intent": "edit"},
    )
    assert lk.status_code == 200, lk.text
    r = client.post(papi("/metamodel/rebind") + f"?base_rev={_rev(client)}",
                    content=_MM_RENAMED, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 409
