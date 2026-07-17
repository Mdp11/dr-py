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

import glob
import os
import tempfile
import threading
import time
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


def test_wasm_boot_failure_does_not_wedge_pool() -> None:
    """Reviewer-found Critical fix regression test.

    A bad `guest_lib_path` makes `wasi.preopen_dir` raise inside the guest
    worker thread almost immediately (before it ever writes the `ready`
    handshake line). Because both pool-instance FIFOs are opened O_RDWR on
    the host side (so `open()` never blocks and the FIFO never sees a
    premature EOF while the host holds it — the correct choice for the
    happy path), a bare `readline()` waiting for that handshake can never
    observe EOF either, even once the guest thread has already died: the
    host itself is always a live writer reference on the fd. Pre-fix, this
    made `_boot_instance` hang forever, which wedged the background refill
    thread permanently (its `except Exception` retry-with-backoff never got
    a chance to fire) and leaked that boot attempt's FIFOs/scratch dir for
    the life of the process.

    This test constructs a runner against a bad `guest_lib_path` on a
    background thread and asserts that BOTH construction and `.close()`
    complete within a generous bound (proving the refill loop actually
    recovers via retry rather than wedging) AND that no scratch dir from
    the failed boot attempt(s) is left behind (proving the bounded-read
    fix's failure path still runs full cleanup). Pre-fix, this test fails
    two ways: the background thread is still alive when we time out the
    join (assertion failure, not a real pytest hang — we bound the wait
    ourselves rather than relying on external test-runner timeout
    machinery), and the leak-detection `dr_wasm_inst_*` scratch dir set
    printed in the failure message is nonempty had we forced a wait long
    enough to observe the first hang.
    """
    if not os.path.exists(GUEST):
        pytest.skip("guest binary not fetched (bash spikes/code_exec/fetch_python_wasi.sh)")
    from data_rover.api.script_runner import WasmScriptRunner

    leak_glob = os.path.join(tempfile.gettempdir(), "dr_wasm_inst_*")
    before = set(glob.glob(leak_glob))

    result: dict[str, bool] = {}

    def _construct_and_close() -> None:
        r = WasmScriptRunner(GUEST, "/nonexistent/bad/guest/lib/path", pool_size=1)
        # Give the refill loop time to attempt (and fail) a boot at least
        # once, and ideally retry, before we tear it down.
        time.sleep(1.5)
        r.close()
        result["done"] = True

    watchdog = threading.Thread(target=_construct_and_close, daemon=True)
    t0 = time.perf_counter()
    watchdog.start()
    # Generous bound: normal path is ~1.5s (the sleep) + close()'s bounded
    # joins; pre-fix this hangs indefinitely on the first boot's readline(),
    # so 20s comfortably distinguishes "recovered" from "wedged" without
    # being flaky on a loaded CI box.
    watchdog.join(timeout=20)
    elapsed = time.perf_counter() - t0

    assert not watchdog.is_alive(), (
        f"construction+close did not complete within {elapsed:.1f}s — "
        "the boot-handshake read is likely blocked forever on a wedged guest "
        "(the O_RDWR-on-both-ends FIFO can never deliver a real EOF)"
    )
    assert result.get("done") is True

    leaked = set(glob.glob(leak_glob)) - before
    assert not leaked, f"leaked wasm instance scratch dir(s) after close(): {leaked}"
