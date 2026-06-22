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


def test_rebind_db_failure_rolls_back_in_memory(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = _rev(client)

    def boom(*a: object, **k: object) -> None:
        raise RuntimeError("simulated DB failure")

    # The route uses `from .. import content` and calls content.append_commit(...)
    # so we patch the symbol on the module, not on the route's local namespace.
    monkeypatch.setattr("data_rover.api.content.append_commit", boom)
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={before}",
        content=_MM_RENAMED,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 500, r.text
    # in-memory state fully restored
    from data_rover.api.session import get_session

    sess = get_session()
    assert sess.metamodel is not None
    assert sess.model_rev == before
    assert sess.metamodel.element_type("Node") is not None   # old type still live
    assert sess.metamodel.element_type("Widget") is None     # new type NOT applied
    # the live metamodel served to clients is still the old one
    mm = client.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    assert any(e["name"] == "Node" for e in mm["elements"])
    assert not any(e["name"] == "Widget" for e in mm["elements"])
    # model_rev via the summary endpoint is unchanged
    assert _rev(client) == before


def test_rebind_survives_eviction(client: TestClient) -> None:
    # The fixture creates a Node element under _MM.  _MM_RENAMED defines Widget
    # (no Node).  We rebind WITHOUT clearing the model so a Node instance is
    # present in the snapshot.  Before this fix, snapshot hydration would 422
    # on the unknown "Node" type; now strict=False lets it through so the
    # element survives and is reported as a CONFORMANCE issue instead.

    # Capture the Node element id before rebind so we can assert it survived.
    elements_before = client.get(
        papi("/model/elements"), params={"limit": 1}, headers=AUTH_HEADERS
    ).json()["items"]
    assert elements_before, "fixture must have created a Node element"
    node_id = elements_before[0]["id"]

    before = _rev(client)
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={before}",
        content=_MM_RENAMED,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text

    from data_rover.api.session import get_registry

    get_registry().evict(DEFAULT_PROJECT_ID)
    assert DEFAULT_PROJECT_ID not in get_registry().project_ids()

    # (a) the rebound metamodel is live after re-hydration
    mm_resp = client.get(papi("/metamodel"), headers=AUTH_HEADERS)
    assert mm_resp.status_code == 200, f"expected 200, got {mm_resp.status_code}: {mm_resp.text}"
    mm = mm_resp.json()
    assert any(e["name"] == "Widget" for e in mm["elements"])
    assert not any(e["name"] == "Node" for e in mm["elements"])

    # (b) the pre-existing Node element survived re-hydration
    items_after = client.get(
        papi("/model/elements"), params={"limit": 100}, headers=AUTH_HEADERS
    ).json()["items"]
    ids_after = {item["id"] for item in items_after}
    assert node_id in ids_after, (
        f"Node element {node_id!r} was lost after eviction+rehydration; "
        f"elements present: {ids_after}"
    )
