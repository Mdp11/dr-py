"""Integration test for the wasmtime-backed :class:`WasmScriptRunner`.

Opt-in (``pytestmark = pytest.mark.integration``, deselected by the default
``-m "not integration and not perf"`` addopts) because it needs the fetched
CPython-WASI guest binary (`spikes/code_exec/fetch_python_wasi.sh`), which is
too large to commit and isn't available in every dev/CI environment.

Task 9 scope (see `.superpowers/sdd/task-9-brief.md`): `WasmScriptRunner.run()`
now drives the REAL bridge loop — it injects `FACADE_SOURCE` + user code into
the guest, serves the guest's `dr` facade calls with a per-run
`BridgeDispatcher`, enforces the two-sided wall deadline (shared epoch cadence
ticker + wall-bounded FIFO reads), applies the determinism shims, and maps
outcomes (timeout / memory / runtime / syntax) to `RunResult`/`ScriptError`.
These tests exercise those behaviours end-to-end against the real guest.
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
    """A plain `print` script's stdout round-trips through the real bridge
    loop (stdout is captured guest-side and delivered in the final message)."""
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


def test_wasm_standalone_read(wasm_runner: WasmScriptRunner) -> None:
    """The brief's original read test: `dr.elements()` iterates the model
    through the real facade+bridge, dispatched host-side by a per-run
    `BridgeDispatcher` against `tiny_model()`."""
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    code = "ids = sorted(e.id for e in dr.elements())\nprint(ids)"
    res = wasm_runner.run(
        tiny_model(),
        RunRequest(code=code),
        RunLimits(),
        record_ops=False,
        rev=0,
    )
    assert res.error is None, res.error
    assert res.stdout.strip() == "['b1', 'b2', 'b3']"


def test_wasm_value_entry(wasm_runner: WasmScriptRunner) -> None:
    """`entry="value"` resolves the `value` function and calls it with the
    list of Element handles for `element_ids` in bound order (matching
    TrustedRunner semantics); the return value becomes `result_repr`."""
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    res = wasm_runner.run(
        tiny_model(),
        RunRequest(
            code="def value(elements):\n    return [e['name'] for e in elements]",
            entry="value",
            element_ids=["b2", "b1"],
        ),
        RunLimits(),
        record_ops=False,
        rev=0,
    )
    assert res.error is None, res.error
    assert res.result_repr == "['Building Two', 'Building One']"


def test_wasm_records_op(wasm_runner: WasmScriptRunner) -> None:
    """A write op flows through the facade -> bridge -> per-run dispatcher and
    is RECORDED (never applied): the op appears in `RunResult.ops` and the
    element is still present in the live model."""
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    m = tiny_model()
    res = wasm_runner.run(
        m,
        RunRequest(code="dr.element('b1').delete()"),
        RunLimits(),
        record_ops=True,
        rev=0,
    )
    assert res.error is None, res.error
    assert res.ops == [{"kind": "delete_element", "id": "b1"}]
    assert "b1" in m.elements


def test_wasm_read_only_rejects_write(wasm_runner: WasmScriptRunner) -> None:
    """`record_ops=False` rejects a write at the bridge; the guest facade
    raises `dr.ReadOnlyError`, surfaced as a runtime error whose message
    preserves `ReadOnlyError`."""
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    res = wasm_runner.run(
        tiny_model(),
        RunRequest(code="dr.element('b1').delete()"),
        RunLimits(),
        record_ops=False,
        rev=0,
    )
    assert res.error is not None
    assert res.error.kind == "runtime"
    assert "ReadOnlyError" in res.error.message


def test_wasm_timeout(wasm_runner: WasmScriptRunner) -> None:
    """A CPU-bound `while True: pass` is killed by the epoch deadline within
    ~`wall_timeout_s`, mapped to `kind="timeout"`, and the runner stays usable
    afterwards (the pool refills)."""
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    t0 = time.perf_counter()
    res = wasm_runner.run(
        tiny_model(),
        RunRequest(code="while True: pass"),
        RunLimits(wall_timeout_s=1.0),
        record_ops=False,
        rev=0,
    )
    elapsed = time.perf_counter() - t0
    assert res.error is not None and res.error.kind == "timeout"
    assert elapsed < 5.0, f"timeout took too long to fire: {elapsed:.1f}s"

    # The runner must remain usable after a timeout kill: the killed instance
    # is discarded and the pool refills, so the next run works.
    ok = wasm_runner.run(
        tiny_model(),
        RunRequest(code='print("still-alive")'),
        RunLimits(),
        record_ops=False,
        rev=0,
    )
    assert ok.error is None
    assert ok.stdout.strip() == "still-alive"


def test_wasm_memory_cap(wasm_runner: WasmScriptRunner) -> None:
    """A guest allocation past the store memory cap breaches the limiter and
    is mapped to `kind="memory"` (nonzero WASI exit + a `MemoryError`
    traceback on the per-instance guest stderr, per the M0 findings)."""
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    res = wasm_runner.run(
        tiny_model(),
        RunRequest(code="x = bytearray(512 * 1024 * 1024)"),
        RunLimits(),
        record_ops=False,
        rev=0,
    )
    assert res.error is not None and res.error.kind == "memory"


def test_wasm_determinism(wasm_runner: WasmScriptRunner) -> None:
    """Two runs of a time/random-using snippet produce byte-identical stdout
    (fixed WASI clock/random shims + `PYTHONHASHSEED=0`)."""
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    code = "import time, random\nprint(time.time(), random.random(), hash('spike'))"
    r1 = wasm_runner.run(tiny_model(), RunRequest(code=code), RunLimits(), record_ops=False, rev=0)
    r2 = wasm_runner.run(tiny_model(), RunRequest(code=code), RunLimits(), record_ops=False, rev=0)
    assert r1.error is None, r1.error
    assert r2.error is None, r2.error
    assert r1.stdout == r2.stdout
    assert r1.stdout.strip() != ""


def test_wasm_runtime_error(wasm_runner: WasmScriptRunner) -> None:
    """An unhandled user exception maps to `kind="runtime"` with a traceback
    stripped to the `<snippet>` frames (never a host/bootstrap frame)."""
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    res = wasm_runner.run(
        tiny_model(),
        RunRequest(code="raise ValueError('boom')"),
        RunLimits(),
        record_ops=False,
        rev=0,
    )
    assert res.error is not None
    assert res.error.kind == "runtime"
    assert "ValueError: boom" in res.error.message
    assert res.error.traceback is not None
    assert "script_runner" not in res.error.traceback


def test_wasm_non_dict_bridge_line_does_not_crash_host_pump(wasm_runner: WasmScriptRunner) -> None:
    """Reviewer-found Important fix: a snippet can write straight to the real
    stdout FIFO via `sys.__stdout__` (which -- unlike the captured `sys.
    stdout` -- is not swapped for a buffer during exec), bypassing the
    facade entirely. A bare scalar like `"5\\n"` is valid JSON (`json.loads`
    succeeds, returning `5`, not a dict), so pre-fix the host pump's `msg.
    get("fin")` raised `AttributeError` and crashed the run with an unhandled
    exception (500 at the route). The host pump must treat a non-dict JSON
    line the same as a non-JSON line: log and skip it, then keep reading
    until the guest's real `{"fin": true, ...}` message arrives.
    """
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    code = (
        "import sys\n"
        'sys.__stdout__.write("5\\n")\n'
        "sys.__stdout__.flush()\n"
        'print("still-alive")\n'
    )
    res = wasm_runner.run(
        tiny_model(),
        RunRequest(code=code),
        RunLimits(),
        record_ops=False,
        rev=0,
    )
    assert res.error is None, res.error
    assert res.stdout.strip() == "still-alive"

    # The runner must remain usable for a subsequent run after this one.
    ok = wasm_runner.run(
        tiny_model(),
        RunRequest(code='print("ok")'),
        RunLimits(),
        record_ops=False,
        rev=0,
    )
    assert ok.error is None
    assert ok.stdout.strip() == "ok"


def test_wasm_pool_refill_and_sequential_runs(wasm_runner: WasmScriptRunner) -> None:
    """Two sequential runs both succeed: the first consumes a warm instance,
    the background refill thread replaces it, and the second run gets a
    working instance too."""
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
    """`.close()` drains the pool, joins the refill/epoch threads, and can be
    called more than once (lifespan shutdown may call it defensively)."""
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
    """Reviewer-found Critical fix regression test (Task 8).

    A bad `guest_lib_path` makes `wasi.preopen_dir` raise inside the guest
    worker thread almost immediately (before it ever writes the `ready`
    handshake line). Because both pool-instance FIFOs are opened O_RDWR on
    the host side (so `open()` never blocks and the FIFO never sees a
    premature EOF while the host holds it — the correct choice for the
    happy path), a bare `readline()` waiting for that handshake can never
    observe EOF either, even once the guest thread has already died: the
    host itself is always a live writer reference on the fd. Pre-fix, this
    made `_boot_instance` hang forever, which wedged the background refill
    thread permanently and leaked that boot attempt's FIFOs/scratch dir.

    This test constructs a runner against a bad `guest_lib_path` on a
    background thread and asserts that BOTH construction and `.close()`
    complete within a generous bound AND that no scratch dir from the failed
    boot attempt(s) is left behind.
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
