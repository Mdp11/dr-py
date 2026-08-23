import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
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
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_initial_bind_on_empty_project_ok(client: TestClient) -> None:
    r = client.post(papi("/metamodel"), content=_MM,
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200


def test_upload_on_nonempty_model_409(client: TestClient) -> None:
    assert client.post(papi("/metamodel"), content=_MM,
                       headers={"content-type": "application/x-yaml"}).status_code == 200
    assert client.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    r_op = client.post(papi("/model/ops"), json={"base_rev": _rev(client), "ops": [
        {"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"}]})
    assert r_op.status_code == 200, r_op.text
    r = client.post(papi("/metamodel"), content=_MM,
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 409
    assert "rebind" in r.json()["detail"]


# ---------------------------------------------------------------------------
# `_peer_mm_conflict` honor rule (routes/metamodel.py): exercises POST
# /metamodel (upload) and DELETE /metamodel (clear), the only two callers
# left of the helper — the commit-flow ``metamodel.rebind`` op uses hard
# lock verification instead (test_commits_metamodel_ops.py), so this file is
# the only remaining coverage for the honor-rule callers.
# ---------------------------------------------------------------------------

_PEER = {"x-user-id": "peer", "x-user-email": "peer@example.com"}


def _add_editor(user_id: str, email: str) -> None:
    from data_rover.api import db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id=user_id, email=email))
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role.editor)
        s.commit()
    finally:
        gen.close()


def _acquire_mm(c: TestClient, headers: dict[str, str]) -> None:
    r = c.post(
        papi("/locks"), headers=headers,
        json={
            "targets": [
                {"resource_id": "mm", "mode": "exclusive", "type": "metamodel"}
            ],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text


def test_upload_409_when_peer_holds_mm_lease(client: TestClient) -> None:
    assert client.post(papi("/metamodel"), content=_MM,
                       headers={"content-type": "application/x-yaml"}).status_code == 200
    assert client.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    _add_editor("peer", "peer@example.com")
    _acquire_mm(client, _PEER)
    r = client.post(
        papi("/metamodel"),
        content=_MM,
        headers={"content-type": "application/x-yaml", **AUTH_HEADERS},
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "metamodel locked"


def test_clear_409_when_peer_holds_mm_lease(client: TestClient) -> None:
    assert client.post(papi("/metamodel"), content=_MM,
                       headers={"content-type": "application/x-yaml"}).status_code == 200
    assert client.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    _add_editor("peer", "peer@example.com")
    _acquire_mm(client, _PEER)
    r = client.delete(papi("/metamodel"), headers=AUTH_HEADERS)
    assert r.status_code == 409
    assert r.json()["detail"] == "metamodel locked"
