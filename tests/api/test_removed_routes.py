"""The server no longer reads, evaluates or exports the model: every removed
route answers 404 (no such path) or 405 (path of a surviving route, wrong
method), so a route that survives by accident fails here."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, install, papi

REMOVED = [
    ("GET", "/commits/1/model"),
    ("POST", "/exports/preview-transform"),
    ("POST", "/exports/run"),
    ("GET", "/exports/run-by-name"),
    ("POST", "/metamodel/diff"),
    ("DELETE", "/model"),
    ("GET", "/model"),
    ("POST", "/model"),
    ("POST", "/model/apply-cr"),
    ("GET", "/model/changes"),
    ("GET", "/model/changes/summary"),
    ("POST", "/model/compare"),
    ("GET", "/model/containment/roots"),
    ("GET", "/model/containment/roots/excluded"),
    ("GET", "/model/download"),
    ("GET", "/model/elements"),
    ("POST", "/model/elements"),
    ("POST", "/model/elements/batch"),
    ("POST", "/model/elements/tree-items"),
    ("DELETE", "/model/elements/e1"),
    ("GET", "/model/elements/e1"),
    ("PATCH", "/model/elements/e1"),
    ("GET", "/model/elements/e1/children"),
    ("GET", "/model/elements/e1/neighborhood"),
    ("GET", "/model/elements/e1/relationships"),
    ("GET", "/model/issues"),
    ("POST", "/model/load"),
    ("POST", "/model/ops"),
    ("GET", "/model/relationships"),
    ("POST", "/model/relationships"),
    ("DELETE", "/model/relationships/r1"),
    ("POST", "/model/save"),
    ("POST", "/model/search"),
    ("PUT", "/model/snapshot"),
    ("GET", "/model/status"),
    ("GET", "/model/summary"),
    ("POST", "/model/undo"),
    ("POST", "/model/upload"),
    ("POST", "/model/validate"),
    ("POST", "/navigations/evaluate"),
    ("POST", "/snippets/cancel"),
    ("POST", "/snippets/run"),
    ("POST", "/tables/evaluate"),
    ("POST", "/tables/export"),
    ("POST", "/tables/json-preview"),
    ("POST", "/tables/script-errors"),
]


@pytest.fixture
def client() -> TestClient:
    install()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.mark.parametrize(("method", "path"), REMOVED)
def test_removed_route_is_gone(client: TestClient, method: str, path: str) -> None:
    r = client.request(method, papi(path), json={})
    assert r.status_code in (404, 405), (method, path, r.status_code)
