"""The seeding and inspection helpers every API test builds on."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import (
    AUTH_HEADERS,
    SMART_CITY_MODEL,
    commit_ops,
    head,
    install,
    seed_default_project,
)


_NODE_MM = "elements:\n  - name: Node\n"


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def test_install_then_head_round_trips_smart_city() -> None:
    install()
    source = json.loads(SMART_CITY_MODEL)
    state = head()
    assert state.rev == 0
    assert len(state.elements) == len(source["elements"])
    assert len(state.relationships) == len(source["relationships"])


def test_commit_ops_advances_head(client: TestClient) -> None:
    install(metamodel=_NODE_MM, model='{"elements": [], "relationships": []}')
    assert head().rev == 0
    body = commit_ops(
        client,
        [{"kind": "create_element", "temp_id": "tmp_t", "type_name": "Node", "properties": {}}],
    )
    state = head()
    assert state.rev == 1
    assert body["id_map"]["tmp_t"] in state.elements
