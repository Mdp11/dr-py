"""End-to-end sweep coverage against the REAL wasmtime guest (Phase A-C).

Opt-in (``pytestmark = pytest.mark.integration``, deselected by the default
``-m "not integration and not perf"`` addopts) because it needs the fetched
CPython-WASI guest binary (`spikes/code_exec/fetch_python_wasi.sh`), which is
too large to commit and isn't available in every dev/CI environment.

Everything else in the sweep suite (`test_script_sweep.py`,
`test_tables_script_status.py`) drives purpose-built counting/scripted runner
fakes, which is what makes those tests fast and deterministic — but it also
means nothing there proves the pieces fit together against a real guest. This
module closes that gap on a table big enough to be interesting (~1,000 rows):

* a SORTED evaluate degrades to build order + ``computing`` on the first
  response, and settles to ``ready`` + the real sorted order on the follow-up;
* the same table swept with ``snippet_sweep_workers=1`` and ``=4`` produces
  byte-identical cell payloads (the determinism guarantee sharding relies on).
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner
from data_rover.api.script_sweep import reset_global_slots
from data_rover.api.session import Session, get_session
from data_rover.api.settings import get_settings

from .conftest import AUTH_HEADERS, papi, seed_default_project

if TYPE_CHECKING:
    from data_rover.api.script_runner import WasmScriptRunner

pytestmark = pytest.mark.integration  # needs the fetched guest binary

GUEST = "spikes/code_exec/vendor/python.wasm"
LIB = "spikes/code_exec/vendor/lib/python3.14"

#: Rows in the exercised table. Big enough that the whole-table pass is
#: unambiguously the thing Phase B moved off the request thread, small enough
#: that a synchronous sweep of it stays a few seconds.
ROWS = 1000

#: Pool must cover `snippet_sweep_workers` (4) concurrent worker contexts plus
#: the sweep's own serial context — an exhausted pool degrades to `unavailable`
#: results, which the sweep's unavailable pathology guard would (correctly)
#: abort on, failing this test for a reason unrelated to what it tests.
POOL = 6

THING_MM = """
elements:
  - name: Thing
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""

#: `value(els)` over a collapse script column is called with the row's single
#: bound element; returning its `name` gives every row a DISTINCT script value.
VALUE_CODE = "def value(els):\n    return els[0]['name']"


def _eid(i: int) -> str:
    return f"t{i:04d}"


def _name(i: int) -> str:
    """Names run DESCENDING against the build order (`t0000` -> `N0999`), so an
    ascending sort on the script column is the exact REVERSE of build order and
    the two can never be confused for one another."""
    return f"N{ROWS - 1 - i:04d}"


@pytest.fixture(scope="module")
def wasm_runner() -> Iterator[WasmScriptRunner]:
    if not os.path.exists(GUEST):
        pytest.skip("guest binary not fetched (bash spikes/code_exec/fetch_python_wasi.sh)")
    from data_rover.api.script_runner import WasmScriptRunner

    r = WasmScriptRunner(GUEST, LIB, pool_size=POOL)
    yield r
    r.close()


@pytest.fixture
def app() -> Iterator[FastAPI]:
    seed_default_project()
    application = create_app()
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def client(app: FastAPI, wasm_runner: WasmScriptRunner) -> TestClient:
    app.dependency_overrides[get_runner] = lambda: wasm_runner
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.fixture
def big_session(client: TestClient) -> Session:
    """`Thing` metamodel + `ROWS` elements, loaded through the HTTP routes so
    the table has real rows in a deterministic build order."""
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
                {
                    "id": _eid(i),
                    "type_name": "Thing",
                    "properties": {"name": _name(i)},
                }
                for i in range(ROWS)
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text
    return get_session()


@pytest.fixture
def sweep_sync(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin `snippet_sweep_sync=True` so `kick_or_join_sweep` runs the whole
    sweep inline inside the request that kicks it — the follow-up request then
    observes a FINISHED sweep with no sleeping. `get_settings` is an uncached
    `Settings()` factory, so the route's own `Depends(get_settings)` picks the
    env var up too."""
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_SYNC", "true")
    assert get_settings().snippet_sweep_sync is True


def _table() -> dict[str, Any]:
    return {
        "row_source": {"kind": "scope", "types": ["Thing"]},
        "columns": [
            {"kind": "element"},
            {"kind": "script", "snippet": {"definition": {"code": VALUE_CODE}}},
        ],
    }


def _evaluate(client: TestClient, *, limit: int = 25) -> dict[str, Any]:
    r = client.post(
        papi("/tables/evaluate"),
        json={
            "definition": _table(),
            "limit": limit,
            "sort": {"column": 1, "direction": "asc"},
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    page: dict[str, Any] = r.json()
    return page


def _keys(page: dict[str, Any]) -> list[object]:
    return [row["key"][0] for row in page["rows"]]


def _values(page: dict[str, Any]) -> list[object]:
    return [row["cells"][1].get("value") for row in page["rows"]]


def _reset_script_state(session: Session) -> None:
    """Drop everything the previous sweep left behind (mirrors what
    `Session.touch_model` clears) so the next run starts stone cold WITHOUT
    reloading the 1,000-element model."""
    session.table_order_cache.clear()
    session.script_cell_cache.clear_and_stamp(session.model_rev)
    session.script_sweeps.cancel_all()


def _settle(
    client: TestClient,
    session: Session,
    workers: int,
    monkeypatch: pytest.MonkeyPatch,
) -> dict[str, Any]:
    """Run the first-response/settled-response cycle at `workers` sweep workers
    and return the settled page."""
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_WORKERS", str(workers))
    assert get_settings().snippet_sweep_workers == workers
    # The process-wide sweep semaphore is sized lazily from settings on first
    # use; drop it so this run's worker count actually takes effect.
    reset_global_slots()
    _reset_script_state(session)

    first = _evaluate(client)
    # Nothing is cached, so the whole-table (cache-only) sort pass went all
    # pending: the route degrades to BUILD order and reports `computing` even
    # though the sync sweep already finished inside this very request.
    assert first["script_status"]["state"] == "computing", first["script_status"]
    assert _keys(first) == [_eid(i) for i in range(25)]

    settled = _evaluate(client)
    assert settled["script_status"]["state"] == "ready", settled["script_status"]
    return settled


def test_sorted_script_table_settles_end_to_end(
    client: TestClient,
    big_session: Session,
    sweep_sync: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 1,000-row table with a script column, sorted on that column: the first
    response is degraded + `computing`, the follow-up is `ready` and really is
    sorted by the guest-computed value — and swapping the sweep from 1 worker to
    4 changes nothing about the payload."""
    serial = _settle(client, big_session, workers=1, monkeypatch=monkeypatch)
    # Ascending on `name` == the reverse of build order (see `_name`).
    assert _keys(serial) == [_eid(ROWS - 1 - i) for i in range(25)]
    assert _values(serial) == [_name(ROWS - 1 - i) for i in range(25)]

    sharded = _settle(client, big_session, workers=4, monkeypatch=monkeypatch)

    # Determinism under sharding: identical bytes, not merely equal values.
    assert json.dumps(sharded["rows"], sort_keys=True) == json.dumps(
        serial["rows"], sort_keys=True
    )
    assert sharded["total"] == serial["total"] == ROWS
