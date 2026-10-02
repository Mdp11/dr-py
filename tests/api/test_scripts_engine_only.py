"""`X-Data-Rover-Scripts: engine-only`: the app evaluates scripts in its own
engine, so the routes that would run or schedule script work answer 409
instead. Everything else, and `GET /exports/run-by-name`, is unchanged."""

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner

from ._script_fakes import CountingRunner
from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model
from .test_exports_route import (
    SCRIPT_TABLE_PAYLOAD,
    TABLE_PAYLOAD,
    _mk_export,
    _mk_script_table,
    _mk_table,
)

ENGINE_ONLY = {**AUTH_HEADERS, "X-Data-Rover-Scripts": "engine-only"}
REFUSED = "scripts need the engine"
TRANSFORM = {
    "definition": {
        "schema_version": 1,
        "language": "python",
        "code": "def transform(doc):\n    return doc\n",
    }
}
NAV_STEP = {
    "kind": "path",
    "start": {"kind": "scope", "types": ["Block"]},
    "steps": [
        {
            "kind": "script",
            "snippet": {"definition": {"code": "def step(els): return []"}},
        }
    ],
}
NAV_PLAIN = {
    "kind": "path",
    "start": {"kind": "scope", "types": ["Block"]},
    "steps": [],
}


@pytest.fixture
def runner() -> CountingRunner:
    return CountingRunner()


@pytest.fixture
def app(runner: CountingRunner) -> Iterator[FastAPI]:
    seed_default_project()
    application = create_app()
    application.dependency_overrides[get_runner] = lambda: runner
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    _bootstrap_model(c)
    return c


def _refused(r) -> None:
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == REFUSED


def test_evaluate_table_with_script_column_refuses(client, runner):
    r = client.post(
        papi("/tables/evaluate"),
        json={"definition": SCRIPT_TABLE_PAYLOAD},
        headers=ENGINE_ONLY,
    )
    _refused(r)
    assert runner.calls == 0


def test_evaluate_table_without_scripts_is_unchanged(client):
    r = client.post(
        papi("/tables/evaluate"),
        json={"definition": TABLE_PAYLOAD},
        headers=ENGINE_ONLY,
    )
    assert r.status_code == 200, r.text
    assert r.json()["script_status"] is None


def test_evaluate_table_without_header_is_unchanged(client):
    r = client.post(
        papi("/tables/evaluate"), json={"definition": SCRIPT_TABLE_PAYLOAD}
    )
    assert r.status_code == 200, r.text
    assert r.json()["script_status"] is not None


def test_json_preview_with_script_column_refuses(client, runner):
    r = client.post(
        papi("/tables/json-preview"),
        json={"definition": SCRIPT_TABLE_PAYLOAD},
        headers=ENGINE_ONLY,
    )
    _refused(r)
    assert runner.calls == 0


def test_table_export_with_transform_only_refuses(client, runner):
    r = client.post(
        papi("/tables/export"),
        json={
            "definition": {**TABLE_PAYLOAD, "transform": TRANSFORM},
            "format": "json",
        },
        headers=ENGINE_ONLY,
    )
    _refused(r)
    assert runner.calls == 0


def test_table_export_without_scripts_is_unchanged(client):
    r = client.post(
        papi("/tables/export"),
        json={"definition": TABLE_PAYLOAD, "format": "json"},
        headers=ENGINE_ONLY,
    )
    assert r.status_code == 200, r.text


def test_table_script_errors_refuses(client, runner):
    r = client.post(
        papi("/tables/script-errors"),
        json={"definition": SCRIPT_TABLE_PAYLOAD},
        headers=ENGINE_ONLY,
    )
    _refused(r)
    assert runner.calls == 0


def test_exports_run_refuses_before_any_entry_runs(client, runner):
    plain = _mk_table(client, "plain")
    scripted = _mk_script_table(client, "scripted")
    ex = _mk_export(
        client,
        [
            {"source": {"ref": plain}, "format": "json"},
            {"source": {"ref": scripted}, "format": "json"},
        ],
    )
    r = client.post(
        papi("/exports/run"), json={"artifact_id": ex}, headers=ENGINE_ONLY
    )
    _refused(r)
    assert runner.calls == 0


def test_exports_run_without_scripts_is_unchanged(client):
    plain = _mk_table(client, "plain")
    ex = _mk_export(client, [{"source": {"ref": plain}, "format": "json"}])
    r = client.post(
        papi("/exports/run"), json={"artifact_id": ex}, headers=ENGINE_ONLY
    )
    assert r.status_code == 200, r.text


def test_exports_run_by_name_ignores_header(client):
    scripted = _mk_script_table(client, "scripted")
    _mk_export(
        client, [{"source": {"ref": scripted}, "format": "json"}], name="by-name"
    )
    r = client.get(
        papi("/exports/run-by-name"),
        params={"name": "by-name"},
        headers=ENGINE_ONLY,
    )
    assert r.status_code in (200, 202), r.text


def test_preview_transform_refuses(client, runner):
    t = _mk_table(client, "alpha")
    r = client.post(
        papi("/exports/preview-transform"),
        json={
            "entry": {
                "source": {"ref": t},
                "name": "doc",
                "format": "json",
                "transform": TRANSFORM,
            }
        },
        headers=ENGINE_ONLY,
    )
    _refused(r)
    assert runner.calls == 0


def test_evaluate_navigation_with_script_step_refuses(client, runner):
    r = client.post(
        papi("/navigations/evaluate"),
        json={"definition": NAV_STEP},
        headers=ENGINE_ONLY,
    )
    _refused(r)
    assert runner.calls == 0


def test_evaluate_navigation_without_script_step_is_unchanged(client):
    r = client.post(
        papi("/navigations/evaluate"),
        json={"definition": NAV_PLAIN},
        headers=ENGINE_ONLY,
    )
    assert r.status_code == 200, r.text
