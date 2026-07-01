from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from data_rover.api import db, tenancy
from data_rover.api.authz import require_membership, require_owner
from data_rover.api.db_models import Membership, Role


@pytest.fixture
def app() -> FastAPI:
    app = FastAPI()

    @app.get("/projects/{project_id}/read")
    def read(m: Membership = Depends(require_membership)) -> dict[str, str]:
        return {"role": m.role.value}

    @app.post("/projects/{project_id}/write")
    def write(m: Membership = Depends(require_membership)) -> dict[str, str]:
        return {"role": m.role.value}

    @app.post("/projects/{project_id}/model/search")
    def search(m: Membership = Depends(require_membership)) -> dict[str, str]:
        return {"role": m.role.value}

    @app.post("/projects/{project_id}/model/elements/tree-items")
    def tree_items(m: Membership = Depends(require_membership)) -> dict[str, str]:
        return {"role": m.role.value}

    @app.delete("/projects/{project_id}/owned", status_code=204, response_model=None)
    def owned(m: Membership = Depends(require_owner)) -> None:
        return None

    return app


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


def _seed(owner: str = "owner", member: str | None = "viewer", role: Role = Role.viewer) -> str:
    gen = db.get_db()
    s = next(gen)
    try:
        tenancy.upsert_user(s, owner, "")
        p = tenancy.create_project(s, "P", owner)
        if member:
            tenancy.upsert_user(s, member, "")
            tenancy.add_member(s, p.id, member, role)
        return p.id
    finally:
        gen.close()


def _h(uid: str) -> dict[str, str]:
    return {"x-user-id": uid}


def test_unknown_project_404(client: TestClient) -> None:
    r = client.get("/projects/nope/read", headers=_h("owner"))
    assert r.status_code == 404


def test_non_member_403(client: TestClient) -> None:
    pid = _seed(member=None)
    r = client.get(f"/projects/{pid}/read", headers=_h("stranger"))
    assert r.status_code == 403


def test_member_can_read(client: TestClient) -> None:
    pid = _seed()
    r = client.get(f"/projects/{pid}/read", headers=_h("viewer"))
    assert r.status_code == 200
    assert r.json()["role"] == "viewer"


def test_viewer_cannot_write(client: TestClient) -> None:
    pid = _seed()
    r = client.post(f"/projects/{pid}/write", headers=_h("viewer"))
    assert r.status_code == 403


def test_editor_can_write(client: TestClient) -> None:
    pid = _seed(member="ed", role=Role.editor)
    r = client.post(f"/projects/{pid}/write", headers=_h("ed"))
    assert r.status_code == 200


def test_viewer_can_call_readonly_post(client: TestClient) -> None:
    pid = _seed()
    r = client.post(f"/projects/{pid}/model/search", headers=_h("viewer"))
    assert r.status_code == 200


def test_viewer_can_call_readonly_post_tree_items(client: TestClient) -> None:
    pid = _seed()
    r = client.post(f"/projects/{pid}/model/elements/tree-items", headers=_h("viewer"))
    assert r.status_code == 200


def test_require_owner_rejects_editor(client: TestClient) -> None:
    pid = _seed(member="ed", role=Role.editor)
    r = client.delete(f"/projects/{pid}/owned", headers=_h("ed"))
    assert r.status_code == 403


def test_require_owner_allows_owner(client: TestClient) -> None:
    pid = _seed()
    r = client.delete(f"/projects/{pid}/owned", headers=_h("owner"))
    assert r.status_code == 204


def test_missing_identity_401(client: TestClient) -> None:
    pid = _seed()
    r = client.get(f"/projects/{pid}/read")
    assert r.status_code == 401
