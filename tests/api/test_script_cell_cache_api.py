"""Phase A end-to-end (Task 3): two evaluates of the same script table hit the
guest once; ``touch_model`` (an out-of-protocol mutation, e.g. a legacy
elements/relationships write) wipes the cache so a subsequent evaluate
recomputes. Mirrors `test_script_embedding_routes.py`'s
app/client/seed_thing_model fixture shape for a table with a real script
column, so the seeded default project actually has rows to evaluate."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Literal

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner
from data_rover.api.session import get_session
from data_rover.core.script.runner import CallResult

from .conftest import AUTH_HEADERS, papi, seed_default_project

THING_MM = """
elements:
  - name: Thing
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""


class _CountingRunner:
    """Fake `ScriptRunner`: every `.call()` on the session it hands back
    increments `calls`, so the test can assert cache hits never reach it."""

    def __init__(self) -> None:
        self.calls = 0

    def open_session(self, model, code, limits, *, budget):
        runner = self

        class _S:
            boot_error = None

            def call(self, entry: Literal["value", "step"], element_ids: list[str]):
                runner.calls += 1
                return CallResult(
                    value={"kind": "scalar", "value": len(element_ids)},
                    error=None,
                    duration_ms=0,
                )

            def close(self) -> None:
                pass

        return _S()

    def run(self, *a, **k):  # pragma: no cover - unused by ScriptEvalContext
        raise NotImplementedError


@pytest.fixture
def app() -> Iterator[FastAPI]:
    """Separate `app`/`client` fixtures (rather than building the app inside
    `client`) so the test can reach `app.dependency_overrides` to swap in the
    counting runner — mirrors `test_script_embedding_routes.py::app`."""
    seed_default_project()
    application = create_app()
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.fixture
def seed_thing_model(client: TestClient) -> None:
    """`Thing` metamodel + two `Thing` elements loaded into the default
    session via the HTTP routes so the table below has real rows —
    otherwise the guest-call-count assertions would pass vacuously on an
    empty table."""
    r = client.post(
        papi("/metamodel"),
        content=THING_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = client.post(
        papi("/model"),
        json={
            "elements": [
                {"id": "t1", "type_name": "Thing", "properties": {"name": "Alpha"}},
                {"id": "t2", "type_name": "Thing", "properties": {"name": "Beta"}},
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text


def _script_table() -> dict:
    return {
        "row_source": {"kind": "scope", "types": ["Thing"]},
        "columns": [
            {
                "kind": "script",
                "snippet": {
                    "definition": {"code": "def value(els): return len(els)"}
                },
            },
        ],
    }


def test_second_evaluate_serves_from_cell_cache(
    client: TestClient, app: FastAPI, seed_thing_model: None
) -> None:
    counting = _CountingRunner()
    app.dependency_overrides[get_runner] = lambda: counting

    r1 = client.post(
        papi("/tables/evaluate"),
        json={"definition": _script_table()},
        headers=AUTH_HEADERS,
    )
    assert r1.status_code == 200, r1.text
    first = counting.calls
    assert first > 0  # guest was actually exercised, not a vacuous 0 == 0

    r2 = client.post(
        papi("/tables/evaluate"),
        json={"definition": _script_table()},
        headers=AUTH_HEADERS,
    )
    assert r2.status_code == 200, r2.text
    assert counting.calls == first  # second evaluate: all cell-cache hits

    get_session().touch_model()  # out-of-protocol mutation wipes the cache
    r3 = client.post(
        papi("/tables/evaluate"),
        json={"definition": _script_table()},
        headers=AUTH_HEADERS,
    )
    assert r3.status_code == 200, r3.text
    assert counting.calls > first  # cache was cleared: guest ran again
