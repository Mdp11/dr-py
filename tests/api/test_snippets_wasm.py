"""Integration test for the wasmtime-backed :class:`WasmScriptRunner`.

Opt-in (``pytestmark = pytest.mark.integration``, deselected by the default
``-m "not integration and not perf"`` addopts) because it needs the fetched
CPython-WASI guest binary (`spikes/code_exec/fetch_python_wasi.sh`), which is
too large to commit and isn't available in every dev/CI environment.

Task 8 scope (see `.superpowers/sdd/task-8-brief.md` and the task-8 report):
`WasmScriptRunner.run()` is PROVISIONAL here — it boots a pool instance, runs
raw Python source through a minimal guest bootstrap loop, and captures
stdout. There is no `dr` facade, no bridge dispatch, no deadline/memory
enforcement yet; that lands in Task 9, which will also restore the brief's
original `test_wasm_standalone_read` (asserting `dr.elements()` reads work
through the real bridge).
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from data_rover.api.script_runner import WasmScriptRunner

pytestmark = pytest.mark.integration  # needs the fetched guest binary

GUEST = "spikes/code_exec/vendor/python.wasm"
LIB = "spikes/code_exec/vendor/lib/python3.14"


@pytest.fixture(scope="module")
def wasm_runner() -> Iterator[WasmScriptRunner]:
    if not os.path.exists(GUEST):
        pytest.skip("guest binary not fetched (bash spikes/code_exec/fetch_python_wasi.sh)")
    from data_rover.api.script_runner import WasmScriptRunner

    r = WasmScriptRunner(GUEST, LIB, pool_size=2)
    yield r
    r.close()


def test_wasm_standalone_print(wasm_runner: WasmScriptRunner) -> None:
    """Provisional Task-8 gate: a trivial `print` script's stdout round-trips
    through a warm pool instance. Task 9 replaces this with the brief's
    `test_wasm_standalone_read`, which exercises `dr.elements()` through the
    real facade/bridge."""
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    res = wasm_runner.run(
        tiny_model(),
        RunRequest(code='print("hello-from-wasm")'),
        RunLimits(),
        record_ops=False,
        rev=0,
    )
    assert res.error is None
    assert res.stdout.strip() == "hello-from-wasm"


def test_wasm_pool_refill_and_sequential_runs(wasm_runner: WasmScriptRunner) -> None:
    """Two sequential runs both succeed: the first consumes a warm instance,
    the background refill thread replaces it, and the second run gets a
    working instance too (pool_size=2, so the fixture's first test already
    consumed one — this proves refill keeps the pool usable across calls)."""
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    for i in range(2):
        res = wasm_runner.run(
            tiny_model(),
            RunRequest(code=f'print("run-{i}")'),
            RunLimits(),
            record_ops=False,
            rev=0,
        )
        assert res.error is None
        assert res.stdout.strip() == f"run-{i}"


def test_wasm_runner_close_is_idempotent() -> None:
    """`.close()` drains the pool, joins the refill thread, and can be called
    more than once (lifespan shutdown may call it defensively)."""
    if not os.path.exists(GUEST):
        pytest.skip("guest binary not fetched (bash spikes/code_exec/fetch_python_wasi.sh)")
    from data_rover.api.script_runner import WasmScriptRunner
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    r = WasmScriptRunner(GUEST, LIB, pool_size=1)
    res = r.run(tiny_model(), RunRequest(code='print("ok")'), RunLimits(), record_ops=False, rev=0)
    assert res.error is None
    assert res.stdout.strip() == "ok"
    r.close()
    r.close()  # idempotent - must not raise
