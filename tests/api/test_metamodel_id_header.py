"""``GET /metamodel`` names the metamodel its document is, so a client can pair
the document with a snapshot descriptor."""

from __future__ import annotations

import gzip
import json

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.db_models import Commit
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_session
from data_rover.api.settings import DEFAULT_CORS_ORIGINS
from data_rover.core.metamodel.loader import load_metamodel_str

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
    properties:
      - {name: label, datatype: string}
"""

_MM_V2 = (
    _MM
    + """
  - name: Other
"""
)


def _app() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.fixture
def client() -> TestClient:
    c = _app()
    res = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    res = c.post(papi("/model/upload"), content=b'{"elements":[],"relationships":[]}')
    assert res.status_code == 200, res.text
    return c


def _bound_metamodel_id() -> str:
    with db.db_session() as s:
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        return row.metamodel_id


def test_the_header_names_the_bound_metamodel(client: TestClient) -> None:
    res = client.get(papi("/metamodel"))
    assert res.status_code == 200
    assert res.headers["x-metamodel-id"] == _bound_metamodel_id()
    posted = client.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.json() == posted.json()


def test_the_header_pairs_with_the_descriptor_and_the_snapshot(
    client: TestClient,
) -> None:
    header = client.get(papi("/metamodel")).headers["x-metamodel-id"]
    desc = client.get(papi("/replica/snapshot")).json()
    blob = client.get(desc["url"]).content
    blob_header = json.loads(gzip.decompress(blob).partition(b"\n")[0])
    assert header == desc["metamodel_id"] == blob_header["metamodel_id"]


def test_the_header_follows_a_rebind(client: TestClient) -> None:
    before = client.get(papi("/metamodel")).headers["x-metamodel-id"]
    lock = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": "mm", "mode": "exclusive", "type": "metamodel"}
            ],
            "intent": "edit",
        },
    )
    assert lock.status_code == 200, lock.text
    res = client.post(
        papi("/commits"),
        json={
            "base_rev": get_session().model_rev,
            "ops": [{"kind": "metamodel.rebind", "blob": _MM_V2}],
            "message": "rebind",
            "lock_tokens": [lock.json()["token"]],
        },
    )
    assert res.status_code == 200, res.text
    with db.db_session() as s:
        row = s.get(Commit, (DEFAULT_PROJECT_ID, get_session().model_rev))
        assert row is not None and row.to_metamodel_id
        to_id = row.to_metamodel_id
    header = client.get(papi("/metamodel")).headers["x-metamodel-id"]
    assert header == to_id != before
    assert client.get(papi("/replica/snapshot")).json()["metamodel_id"] == to_id


def test_the_header_is_empty_without_a_model_row() -> None:
    c = _app()
    get_session().set_metamodel(load_metamodel_str(_MM))
    res = c.get(papi("/metamodel"))
    assert res.status_code == 200
    assert res.headers["x-metamodel-id"] == ""


def test_cors_exposes_the_header(client: TestClient) -> None:
    res = client.get(papi("/metamodel"), headers={"origin": DEFAULT_CORS_ORIGINS[0]})
    assert res.status_code == 200
    exposed = res.headers["access-control-expose-headers"].lower()
    assert "x-metamodel-id" in exposed
