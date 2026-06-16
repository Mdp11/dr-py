from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import reset_session

SIMPLE_MM = """
elements:
  - name: Block
"""


@pytest.fixture
def client() -> TestClient:
    reset_session()
    return TestClient(create_app())


def test_metamodel_loaded_in_one_project_is_invisible_to_another(
    client: TestClient,
) -> None:
    # Load a metamodel into project "alpha".
    res = client.post(
        "/api/v1/metamodel",
        content=SIMPLE_MM,
        headers={"content-type": "application/x-yaml", "x-project-id": "alpha"},
    )
    assert res.status_code == 200, res.text

    # Project "alpha" sees it.
    res_alpha = client.get("/api/v1/metamodel", headers={"x-project-id": "alpha"})
    assert res_alpha.status_code == 200, res_alpha.text

    # Project "beta" has nothing loaded.
    res_beta = client.get("/api/v1/metamodel", headers={"x-project-id": "beta"})
    assert res_beta.status_code == 404, res_beta.text

    # The header-less default project is also independent of "alpha".
    res_default = client.get("/api/v1/metamodel")
    assert res_default.status_code == 404, res_default.text


def test_models_in_two_projects_do_not_share_state(client: TestClient) -> None:
    for pid in ("alpha", "beta"):
        res = client.post(
            "/api/v1/metamodel",
            content=SIMPLE_MM,
            headers={"content-type": "application/x-yaml", "x-project-id": pid},
        )
        assert res.status_code == 200, res.text

    # Put one Block element into "alpha" only; load an empty model into "beta".
    res = client.post(
        "/api/v1/model",
        json={
            "elements": [{"id": "b1", "type_name": "Block", "properties": {}}],
            "relationships": [],
        },
        headers={"x-project-id": "alpha"},
    )
    assert res.status_code == 200, res.text

    res = client.post(
        "/api/v1/model",
        json={"elements": [], "relationships": []},
        headers={"x-project-id": "beta"},
    )
    assert res.status_code == 200, res.text

    # "alpha" has the element; "beta" has an empty model — isolation holds.
    summary_alpha = client.get(
        "/api/v1/model/summary", headers={"x-project-id": "alpha"}
    ).json()
    summary_beta = client.get(
        "/api/v1/model/summary", headers={"x-project-id": "beta"}
    ).json()
    assert summary_alpha["element_count"] == 1, summary_alpha
    assert summary_beta["element_count"] == 0, summary_beta
