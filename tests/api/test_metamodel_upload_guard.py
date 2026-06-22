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
    client.post(papi("/model/ops"), json={"base_rev": _rev(client), "ops": [
        {"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"}]})
    r = client.post(papi("/metamodel"), content=_MM,
                    headers={"content-type": "application/x-yaml"})
    assert r.status_code == 409
    assert "rebind" in r.json()["detail"]
