from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.main import create_app


@pytest.fixture
def dev_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DATA_ROVER_DEV_SEED", "true")
    db.init_engine("sqlite://")  # self-contained: ensure an engine exists
    db.drop_all()  # start clean; create_app will create_all + seed
    return TestClient(create_app())


def test_dev_seed_creates_default_project(dev_client: TestClient) -> None:
    detail = dev_client.get(
        "/api/v1/projects/default", headers={"x-user-id": "default-user"}
    )
    assert detail.status_code == 200, detail.text
    assert detail.json()["id"] == "default"
