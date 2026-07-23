"""End-to-end: a navigation with a `ScriptStep` used as a table's ROW SOURCE,
over HTTP (`POST /tables/evaluate`).

This is the exact scenario the 2026-07-23 spec's bug report covered. The table
evaluator used to call `evaluate()` on the row source's navigation WITHOUT the
request's `ScriptEvalContext`, so `_hop_script` took its `script is None`
branch and pruned every chain SILENTLY: zero rows, no warning, and
`script_status: ready` on every poll — indistinguishable from "this navigation
genuinely reaches nothing". Both tests below fail (0 rows / no warning) if that
threading is removed again.

WHY EACH TEST POLLS TWICE — the Phase B (spec 2026-07-20 §4.1-4.3) contract,
which a nav script step rides exactly like a script column:

  poll 1  The route's whole-table `build_rows_ex` pass runs CACHE-ONLY, so the
          step's `call(code, "step", [id])` misses the session cell cache and
          synthesizes a `pending` result. `_hop_script` treats every error kind
          alike and prunes with a warning — here the synthetic
          "script step failed: not computed yet". Rows are empty,
          `pending_misses > 0`, and the route kicks a background `SweepJob`.

  the fill  `script_sweep._run_inner`'s SERIAL PREFIX — `build_rows_ex(...,
          script=ctx)` with a context that is NOT cache-only — is what fills
          the step cells. It is a full live row build, so it necessarily drives
          every `step()` call the row source needs, and `ScriptEvalContext.call`
          writes each `(sha256(code), "step", (element_id,))` result into the
          session's `ScriptCellCache`. (The sweep's own script-COLUMN
          enumeration that follows is irrelevant here — this table has no
          script column at all.) `test_..._row_source_over_http` asserts that
          cache entry directly, so the mechanism is pinned, not just its
          outcome.

  poll 2  The cache-only build now HITS for every step call: real rows,
          `script_status: ready`, no warnings.

`settings_sync_sweep` pins `DATA_ROVER_SNIPPET_SWEEP_SYNC` the way
`test_tables_script_status.py` does, so the sweep runs inline inside poll 1 and
poll 2 is deterministic — with the default threaded sweep the same sequence
works, but only by racing a daemon thread.

Fixture idiom follows `test_script_embedding_routes.py` / `test_tables_script_
status.py`: a separate `app`/`client` pair so `get_runner` stays swappable
through `dependency_overrides`.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner
from data_rover.api.session import get_session
from data_rover.api.settings import Settings, get_settings
from tests.script.trusted_runner import TrustedRunner

from .conftest import AUTH_HEADERS, papi, seed_default_project

THING_MM = """
elements:
  - name: Thing
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""

#: Seeded with explicit ids so a snippet can name one of them literally.
THING_IDS = ["t1", "t2", "t3"]

#: `step()` that hops every Thing except `t1` ONTO `t1`; `t1` itself ends its
#: chain. The row source projects the terminal step, so the reachable row set is
#: exactly `{t1}` — one row, and a row that is NOT simply "the start scope",
#: which a silently-pruned navigation could never be confused with.
STEP_CODE = "def step(el):\n    return [] if el.id == 't1' else ['t1']\n"

#: `step()` that raises per element: every chain prunes, and the failure must
#: reach the page's `warnings` rather than vanishing.
BOOM_CODE = "def step(el):\n    return 1 / 0\n"


@pytest.fixture
def app() -> Iterator[FastAPI]:
    seed_default_project()
    application = create_app()
    application.dependency_overrides[get_runner] = lambda: TrustedRunner()
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.fixture
def seed_things(client: TestClient) -> list[str]:
    """`Thing` metamodel + three `Thing` elements with pinned ids, loaded
    through the HTTP routes so the session the requests hit is the seeded one."""
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
                {"id": tid, "type_name": "Thing", "properties": {"name": tid.upper()}}
                for tid in THING_IDS
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text
    return list(THING_IDS)


@pytest.fixture
def settings_sync_sweep(monkeypatch: pytest.MonkeyPatch) -> Settings:
    """Pin `snippet_sweep_sync=True` (env var + fresh `get_settings()`, exactly
    as `test_tables_script_status.py` does) so `kick_or_join_sweep` runs the
    whole sweep inline inside the request that kicks it — the second poll below
    is then deterministic instead of racing a daemon thread."""
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_SYNC", "true")
    settings = get_settings()
    assert settings.snippet_sweep_sync is True
    return settings


def _nav_table(code: str) -> dict:
    """A table whose ROW SOURCE is a one-script-step navigation over every
    `Thing`. No script COLUMN anywhere: the only snippet work this definition
    can produce comes from the navigation's `ScriptStep`, so an empty page can
    only mean the step never ran."""
    return {
        "row_source": {
            "kind": "navigation",
            "navigation": {
                "definition": {
                    "kind": "path",
                    "start": {"kind": "scope", "types": ["Thing"]},
                    "steps": [
                        {"kind": "script", "snippet": {"definition": {"code": code}}}
                    ],
                }
            },
        },
        "columns": [{"kind": "element"}],
    }


def _evaluate(client: TestClient, code: str) -> dict:
    r = client.post(papi("/tables/evaluate"), json={"definition": _nav_table(code)})
    assert r.status_code == 200, r.text
    return r.json()


def _step_cell_key(code: str, element_id: str) -> tuple[str, str, tuple[str, ...]]:
    """The `ScriptCellCache` key a `step()` call on one element writes under —
    `ScriptEvalContext._cell_key`'s shape, with the "step" entry point."""
    return (hashlib.sha256(code.encode()).hexdigest(), "step", (element_id,))


def test_nav_script_step_row_source_over_http(
    client: TestClient, seed_things: list[str], settings_sync_sweep: Settings
) -> None:
    """THE happy path: a navigation script step really does produce table rows
    over HTTP — on the second poll, per the Phase B contract in the module
    docstring.

    Reverting the row-source threading (`_navigation_row_keys` calling
    `evaluate()` without `script=`) makes BOTH polls return 0 rows with no
    warning and `ready` forever — the original bug — so every assertion here is
    discriminating."""
    session = get_session()
    rev = session.model_rev

    # Poll 1: the cache-only whole-table build cannot run the step yet.
    first = _evaluate(client, STEP_CODE)
    assert first["rows"] == []
    assert first["total"] == 0
    assert first["script_status"]["state"] == "computing"
    assert first["warnings"] == ["script step failed: not computed yet"]

    # THE MECHANISM: the sweep's serial row build ran the step LIVE and wrote
    # its result into the session cell cache under the "step" entry point.
    # `t2` is a real hop (`t1` ends its own chain), so its entry can only exist
    # because a navigation step call was computed and cached.
    cached = session.script_cell_cache.get(_step_cell_key(STEP_CODE, "t2"), rev)
    assert cached is not None and cached.error is None

    # Poll 2: every step call hits that cache, so the row set is the real one.
    second = _evaluate(client, STEP_CODE)
    assert second["script_status"]["state"] == "ready"
    assert second["warnings"] == []
    assert second["total"] == 1
    # `t1` is what every other Thing hops onto — NOT the start scope, so this
    # cannot be satisfied by a navigation that pruned back to its own roots.
    assert [row["key"][0] for row in second["rows"]] == ["t1"]
    assert second["rows"][0]["cells"][0]["item"]["id"] == "t1"


def test_nav_script_step_error_surfaces_in_page_warnings(
    client: TestClient, seed_things: list[str], settings_sync_sweep: Settings
) -> None:
    """A step that raises prunes its chains (degraded, never a 5xx) and the
    REAL failure reaches `warnings`.

    The assertion deliberately matches the snippet's own exception rather than
    the bare "script step failed" prefix: poll 1 carries the synthetic
    "script step failed: not computed yet" too, so a prefix-only check would
    pass on the cache-only placeholder and prove nothing about the snippet ever
    having run. With the threading reverted `warnings` is empty on every poll.
    """
    first = _evaluate(client, BOOM_CODE)
    assert first["rows"] == []
    # Poll 1 sees the cache-only placeholder AND — via the route's terminal-job
    # re-probe, which re-reads the now sweep-filled cache — the real error.
    assert "script step failed: not computed yet" in first["warnings"]

    second = _evaluate(client, BOOM_CODE)
    assert second["total"] == 0
    assert second["rows"] == []
    # The error is deterministic, so the sweep cached it: settled state is the
    # real message alone, and the page stops asking the client to poll.
    assert second["script_status"]["state"] == "ready"
    assert second["warnings"] == [
        "script step failed: ZeroDivisionError: division by zero"
    ]
