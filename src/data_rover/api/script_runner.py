"""wasmtime-backed :class:`~data_rover.core.script.runner.ScriptRunner`.

This module is API-layer, not core, on purpose: it is the ONLY place in this
repository (besides `tests/`) allowed to `import wasmtime` (see
`CLAUDE.md`'s script-execution architecture notes). `data_rover.core.script`
stays sandbox-agnostic; this module supplies the wasmtime sandbox.

Spike provenance -- every mechanic below was proven in `spikes/code_exec/`
before landing here (see `spikes/code_exec/FINDINGS.md` for the measured
numbers this design leans on):

- **Engine/Config, module compile, WASI stdio wiring, store limits, epoch,
  determinism shims** -- ported from `spikes/code_exec/host.py`
  (`make_engine`, `run_python`, `_add_determinism_shims`) and
  `spikes/code_exec/s04_epoch.py` / `s05_memory.py` / `s06_determinism.py`.
  wasmtime-py 46.0.1 API facts baked in there (and re-verified here): there
  is no `StoreLimits` class -- `store.set_limits(memory_size=...)` takes the
  limit kwargs directly; `store.set_epoch_deadline(ticks_after_current)`;
  epoch interruption raises `wasmtime.Trap` with
  `.trap_code == TrapCode.INTERRUPT`; `wasi.preopen_dir(host_path,
  guest_path)`; `ExitTrap` is a sibling of `Trap` and carries a `.code` int.
- **Module serialize/deserialize disk cache** -- ported from
  `spikes/code_exec/s07_pool.py`. Measured there: ~35-46ms deserialize vs
  ~0.7-1.0s cold `Module.from_file` compile, ~25x faster -- this is why the
  pool warms instances off a `.cwasm` cache instead of recompiling per boot.
- **FIFO O_RDWR stdio bridge + boot-to-ready handshake** -- ported from
  `spikes/code_exec/s02_bridge.py` (the RTT probe) and `s07_pool.py`'s
  `one_cycle`. Both FIFOs are opened `O_RDWR` on the host side so the open()
  call never blocks and the pipe never sees a premature EOF while the host
  holds it; wasmtime-46 streams WASI stdio to/from the FIFO live (it does not
  slurp-then-run), so a guest blocked on `sys.stdin` is served as the host
  writes.

**The bridge loop (Task 9).** `run()` now drives the REAL guest<->host
protocol, replacing Task 8's provisional `exec`/`quit` loop:

1. `run()` pops a warm instance (its guest is parked on `sys.stdin` after the
   boot handshake), arms the per-run wall deadline on the instance's `Store`
   (`set_epoch_deadline`) and the per-run memory cap (`set_limits`) -- both
   safe cross-thread because the guest is parked in a WASI read, not executing
   wasm back-edges -- then sends ONE start message carrying `{code, entry,
   element_id, facade_source, stdout_bytes, result_repr_bytes}`.
2. The guest bootstrap (`_GUEST_BOOTSTRAP_SOURCE`) reads that message, `exec`s
   `FACADE_SOURCE + code` compiled as one unit under the filename `<snippet>`
   (so guest tracebacks strip to guest frames, mirroring
   `tests/script/trusted_runner.py`), captures stdout in a size-capped buffer,
   resolves the entry function for `entry != "script"`, computes `result_repr`,
   and streams bridge requests to the host mid-execution whenever the facade's
   `_transport` is called.
3. The host serves each bridge request with a per-run
   `BridgeDispatcher(model, record_ops=..., max_ops=..., ...)`, writing the
   JSON response back. `dispatcher.ops` become `RunResult.ops`.
4. The guest ends by emitting a distinct FINAL message (`{"fin": true, "stdout",
   "result_repr", "truncated", "error"?}`); the host loop ends on that message
   (or on the guest dying, or on the wall deadline).

**Two-sided deadline.** A single shared **epoch cadence ticker** thread (per
runner, started in `__init__`) calls `engine.increment_epoch()` every
`_EPOCH_TICK_INTERVAL_S`, turning the engine's global epoch into a coarse
monotonic clock. Each run arms its instance's store with an ABSOLUTE deadline
(`set_epoch_deadline(ticks)` where `ticks = ceil(wall_timeout_s /
interval)`), so an interruption trips only when THAT store's own deadline is
reached -- concurrent runs on the shared engine do not interfere (this is a
deliberate, isolation-correct refinement of `s04_epoch.py`'s single per-run
ticker, which cannot isolate multiple stores sharing one engine). That epoch
kill handles CPU-bound guests (`while True: pass`). The complementary "host
watchdog" is the wall-deadline-bounded FIFO read: `_readline_bounded` is
called with a budget derived from the remaining wall time, so a guest wedged
in a way epoch cannot reach (e.g. blocked in a WASI call) still unblocks the
host at the deadline; teardown then closes the FIFOs so both sides die and
the instance is discarded (never returned to the pool).

**Error mapping (M0 findings, `FINDINGS.md` rows 4-5):**

| outcome                                             | `ScriptError.kind` |
|-----------------------------------------------------|--------------------|
| guest fin `error.kind == "syntax"` (compile failed) | `"syntax"`         |
| guest fin `error.kind == "runtime"` (user raise)    | `"runtime"`        |
| epoch kill: `Trap.trap_code == INTERRUPT`           | `"timeout"`        |
| nonzero WASI exit + `MemoryError` on guest stderr   | `"memory"`         |
| non-INTERRUPT `Trap` (alloc-trap portability path)  | `"memory"`         |
| wall-deadline read timeout, no trap                 | `"timeout"`        |
| nonzero exit, no `MemoryError`                      | `"runtime"`        |

**Pool / threading model.** One shared `Engine` (`epoch_interruption=True`)
and one cached `Module` are shared by every pool instance. A `queue.Queue`
holds pre-booted `_PooledInstance`s. `run()` pops one, uses it for exactly one
execution, and tears it down -- it never returns an instance to the pool
(fresh interpreter per snippet, no state leakage). A daemon `_refill_loop`
thread keeps the pool topped up off the request path. `.close()` stops the
refill + epoch ticker threads, drains and tears down every pooled instance,
and removes the shared bootstrap-scripts dir. `.close()` is idempotent.
"""

from __future__ import annotations

import json
import logging
import math
import os
import queue
import selectors
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from wasmtime import (
    Config,
    Engine,
    ExitTrap,
    FuncType,
    Instance,
    Linker,
    Module,
    Store,
    Trap,
    TrapCode,
    ValType,
    WasiConfig,
)

from data_rover.core.model.model import Model
from data_rover.core.script.facade_src import FACADE_SOURCE
from data_rover.core.script.runner import (
    RunLimits,
    RunRequest,
    RunResult,
    ScriptError,
    ScriptRunner,
)

from .settings import Settings

logger = logging.getLogger(__name__)

#: Guest-visible mount point for the CPython-WASI stdlib (`PYTHONHOME`/
#: `PYTHONPATH` both point here), matching `spikes/code_exec/host.py`'s
#: `GUEST_LIB_GUEST` convention.
_GUEST_LIB_GUEST = "/lib"

#: Guest-visible mount point for the (host-written-once) bootstrap script
#: directory, matching `spikes/code_exec/s02_bridge.py`/`s07_pool.py`'s
#: `/spike` preopen convention.
_GUEST_SCRIPTS_GUEST = "/spike"
_BOOTSTRAP_FILENAME = "bootstrap.py"

#: The filename the guest compiles the facade+snippet under. Guest tracebacks
#: are stripped to frames from this file (never a bootstrap frame), matching
#: `tests/script/trusted_runner.py`'s `_SNIPPET_FILENAME`.
_SNIPPET_FILENAME = "<snippet>"

#: Fixed wall-clock epoch in nanoseconds injected by the determinism shim
#: (`1_750_000_000` seconds), matching `spikes/code_exec/host.py`'s
#: `FIXED_NANOS`. The monotonic clock stays real so epoch/timeout still work.
_FIXED_WALL_NANOS = 1_750_000_000_000_000_000

#: Cadence of the shared epoch ticker: every interval the runner calls
#: `engine.increment_epoch()`, advancing the engine's global epoch by one.
#: This is the resolution of the wall-timeout epoch kill (~50ms), well under
#: the console-latency budget and precise enough for second-scale timeouts.
_EPOCH_TICK_INTERVAL_S = 0.05

#: Store epoch deadline (in cadence ticks) baked at boot. Large enough that an
#: idle/booting instance -- parked on stdin, or importing the stdlib during
#: the ~150ms boot -- never trips before `run()` re-arms it with the per-run
#: deadline. At 20Hz this is ~58 days of headroom.
_IDLE_EPOCH_DEADLINE_TICKS = 100_000_000

#: Extra time past the wall deadline the host read waits before giving up, so
#: the epoch trap (which fires ~one cadence tick after the deadline) has time
#: to kill the guest and the worker thread to exit -- `_readline_bounded`
#: returns the instant the thread dies, so this ceiling is rarely reached.
_TIMEOUT_READ_GRACE_S = 1.5

#: Delay before the refill thread retries after a failed boot, so a
#: persistent failure (e.g. a corrupted cache file) doesn't spin the CPU.
_REFILL_RETRY_DELAY_S = 1.0

#: How often the refill thread wakes up to recheck pool depth / shutdown
#: while the pool is already full.
_REFILL_POLL_S = 0.2

#: How long `run()` waits for a warm instance before giving up. Generous
#: relative to the measured ~110-170ms boot-to-ready so a cold pool (e.g.
#: right after construction) still serves the first request.
_POOL_GET_TIMEOUT_S = 10.0

#: How long instance teardown waits for the guest worker thread to notice
#: `quit`/EOF and exit before giving up (the thread is a daemon either way, so
#: a timeout here just bounds `.close()`/per-run teardown latency, not
#: correctness).
_TEARDOWN_JOIN_TIMEOUT_S = 5.0

#: Ceiling on how long `_boot_instance` waits for the guest's `{"ready":
#: true}` handshake line (see `_readline_bounded`'s docstring for why a
#: bare blocking `readline()` here can hang forever). Generous vs. the
#: measured ~110-170ms boot-to-ready (`FINDINGS.md` Criterion 6) -- this is
#: a "genuinely wedged guest" ceiling, not a normal-path budget.
_BOOT_HANDSHAKE_TIMEOUT_S = 30.0

#: How often `_readline_bounded` re-checks worker-thread liveness between
#: `select` polls. Small enough that a fast synchronous boot failure (e.g.
#: `wasmtime` raising on `preopen_dir` for a bad path -- the guest thread
#: dies in milliseconds), OR an epoch kill that kills the worker thread, is
#: detected and reported almost immediately.
_BOOT_POLL_INTERVAL_S = 0.05


# Guest bootstrap: runs INSIDE CPython-WASI. It sends a ready handshake, reads
# ONE start message describing the run, execs FACADE_SOURCE + user code with
# `_transport` bound so the facade's bridge calls stream to the host over the
# real stdout (while user `print`s go to a size-capped buffer), then emits a
# distinct FINAL message. Modeled on `tests/script/trusted_runner.py`'s run
# semantics (entry handling, stdout cap, traceback stripping, result_repr
# truncation) so the WASM path produces RunResults equivalent to the in-process
# reference for equivalent inputs. Embedded as a string (not a shipped .py)
# because it never runs host-side -- the guest interpreter compiles it itself,
# the same reasoning `facade_src.FACADE_SOURCE`'s docstring gives.
_GUEST_BOOTSTRAP_SOURCE = r'''
import json
import sys
import traceback

# The real, FIFO-backed stdout. Captured before any redirect so bridge
# requests + the final message always reach the host even while user code has
# sys.stdout swapped out for the capture buffer.
_real_stdout = sys.stdout

_SNIPPET_FILENAME = "<snippet>"


def _emit(obj):
    _real_stdout.write(json.dumps(obj) + "\n")
    _real_stdout.flush()


def _transport(req):
    # Facade -> host bridge call: write the request, block for the response
    # line. Uses _real_stdout (not the possibly-redirected sys.stdout).
    _emit(req)
    return json.loads(sys.stdin.readline())


class _CappedStdout:
    # Mirrors tests/script/trusted_runner.py::_CappedStdout: stops accumulating
    # past `cap` chars, appending an ellipsis on the truncating write and
    # flagging `.truncated`.
    def __init__(self, cap):
        self._cap = cap if cap > 0 else 0
        self._parts = []
        self._size = 0
        self.truncated = False

    def write(self, s):
        if self._size >= self._cap:
            if s:
                self.truncated = True
            return len(s)
        remaining = self._cap - self._size
        if len(s) > remaining:
            self._parts.append(s[:remaining] + "...")
            self._size = self._cap
            self.truncated = True
        else:
            self._parts.append(s)
            self._size += len(s)
        return len(s)

    def flush(self):
        pass

    def getvalue(self):
        return "".join(self._parts)


def _format_guest_traceback():
    # Keep only frames from the exec'd facade+snippet source, never a bootstrap
    # frame -- mirrors trusted_runner.py::_format_guest_traceback.
    exc_type, exc, tb = sys.exc_info()
    frames = [f for f in traceback.extract_tb(tb) if f.filename == _SNIPPET_FILENAME]
    lines = ["Traceback (most recent call last):\n"]
    lines.extend(traceback.format_list(frames))
    lines.extend(traceback.format_exception_only(exc_type, exc))
    return "".join(lines)


def _main():
    _emit({"ready": True})

    start = json.loads(sys.stdin.readline())
    code = start["code"]
    entry = start["entry"]
    element_id = start["element_id"]
    facade_source = start["facade_source"]
    stdout_cap = start["stdout_bytes"]
    result_repr_cap = start["result_repr_bytes"]

    stdout = _CappedStdout(stdout_cap)
    namespace = {"_transport": _transport}
    error = None
    value = None
    have_value = False

    source = facade_source + "\n" + code
    try:
        compiled = compile(source, _SNIPPET_FILENAME, "exec")
    except SyntaxError as exc:
        error = {"kind": "syntax", "message": str(exc), "traceback": None}
        compiled = None

    if compiled is not None:
        sys.stdout = stdout
        try:
            exec(compiled, namespace)
            if entry == "script":
                if "result" in namespace:
                    value = namespace["result"]
                    have_value = True
            else:
                fn = namespace.get(entry)
                if fn is None or not callable(fn):
                    raise NameError("entry function " + repr(entry) + " is not defined")
                el = namespace["dr"].element(element_id) if element_id is not None else None
                value = fn(el)
                have_value = True
        except MemoryError:
            # Propagate to the CPython top level: a store memory-limiter breach
            # surfaces as a nonzero WASI exit + a MemoryError traceback on
            # stderr, which the host maps to ScriptError(kind="memory").
            # Catching it as an ordinary Exception would mislabel a resource
            # breach as a runtime error (see FINDINGS.md row 5).
            sys.stdout = _real_stdout
            raise
        except Exception:
            error = {
                "kind": "runtime",
                "message": type(sys.exc_info()[1]).__name__ + ": " + str(sys.exc_info()[1]),
                "traceback": _format_guest_traceback(),
            }
        finally:
            sys.stdout = _real_stdout

    result_repr = None
    truncated = stdout.truncated
    if error is None and have_value:
        result_repr = repr(value)
        if len(result_repr) > result_repr_cap:
            result_repr = result_repr[:result_repr_cap] + "..."
            truncated = True

    fin = {"fin": True, "stdout": stdout.getvalue(), "result_repr": result_repr, "truncated": truncated}
    if error is not None:
        fin["error"] = error
    _emit(fin)


_main()
'''


def _module_cache_path(guest_wasm_path: str) -> Path:
    """Where the compiled-module disk cache for `guest_wasm_path` lives.

    The cache file sits NEXT TO the guest binary (`s07_pool.py`'s placement),
    with a staleness key embedded in the filename (`python-<size>-<mtime_ns>
    .cwasm`): a re-fetched/rebuilt binary changes size and/or mtime, so it
    misses under the old name and falls through to a fresh `Module.from_file`
    + `serialize()`. Cheap (no hashing a multi-MB binary), and correct for the
    actual failure mode (a re-fetch always changes size/mtime).
    """
    src = Path(guest_wasm_path)
    st = src.stat()
    return src.with_name(f"{src.stem}-{st.st_size}-{st.st_mtime_ns}.cwasm")


def _load_module(engine: Engine, guest_wasm_path: str) -> Module:
    """`Module.deserialize` from the on-disk cache if present and fresh, else
    `Module.from_file` + `serialize()` to populate the cache for next time.
    Ported from `spikes/code_exec/s07_pool.py`'s cache probe."""
    cache_path = _module_cache_path(guest_wasm_path)
    if cache_path.exists():
        try:
            return Module.deserialize(engine, cache_path.read_bytes())
        except Exception:
            logger.warning(
                "wasm module cache at %s failed to deserialize; recompiling", cache_path,
                exc_info=True,
            )
    module = Module.from_file(engine, guest_wasm_path)
    try:
        cache_path.write_bytes(module.serialize())
    except OSError:
        logger.warning("could not write wasm module cache to %s", cache_path, exc_info=True)
    return module


def _make_engine() -> Engine:
    """One shared `Engine`, `epoch_interruption=True`, Config set BEFORE
    engine construction (wasmtime requires Config changes to happen before
    `Engine(cfg)` -- see `spikes/code_exec/host.py`'s `make_engine`)."""
    cfg = Config()
    cfg.epoch_interruption = True
    return Engine(cfg)


def _add_determinism_shims(linker: Linker) -> None:
    """Shadow `wasi_snapshot_preview1.clock_time_get`/`random_get` with fixed
    values so identical guest code produces byte-identical stdout across runs.

    Ported verbatim from `spikes/code_exec/host.py::_add_determinism_shims`
    (proven in `s06_determinism.py`). The realtime clock (`clock_id == 0`) is
    pinned to `_FIXED_WALL_NANOS`; the monotonic clock stays REAL so the
    interpreter can boot and the epoch/timeout machinery still works. `random_
    get` always fills the guest buffer with `0x42`, seeding CPython's PRNG
    identically. The caller must set `linker.allow_shadowing = True` BEFORE
    `define_wasi()` and call this AFTER `define_wasi()` -- shadow-after-define
    is the order that takes effect on wasmtime-py 46.0.1 (see FINDINGS.md
    Criterion 5). `PYTHONHASHSEED=0` in the guest env completes the recipe.
    """
    i32, i64 = ValType.i32(), ValType.i64()

    def clock_time_get(caller: Any, clock_id: int, precision: int, out_ptr: int) -> int:
        mem = caller.get("memory")
        nanos = _FIXED_WALL_NANOS if clock_id == 0 else int(time.perf_counter_ns())
        mem.write(caller, nanos.to_bytes(8, "little"), out_ptr)
        return 0

    def random_get(caller: Any, buf: int, buf_len: int) -> int:
        mem = caller.get("memory")
        mem.write(caller, bytes([0x42]) * buf_len, buf)
        return 0

    linker.define_func(
        "wasi_snapshot_preview1",
        "clock_time_get",
        FuncType([i32, i64, i32], [i32]),
        clock_time_get,
        access_caller=True,
    )
    linker.define_func(
        "wasi_snapshot_preview1",
        "random_get",
        FuncType([i32, i32], [i32]),
        random_get,
        access_caller=True,
    )


def _readline_bounded(
    f: TextIO, thread: threading.Thread, timeout: float, poll_interval: float = _BOOT_POLL_INTERVAL_S
) -> str:
    """Read one line from `f` with a bounded wait, never blocking forever.

    **Why a bare `f.readline()` cannot be trusted here.** Both FIFOs backing a
    pool instance are opened `O_RDWR` on the host side (see the module
    docstring) so the `open()` call never blocks and the pipe never sees a
    premature EOF while the host holds it. That safety property has a sharp
    edge: because the *host* itself is always a live writer reference on `f`'s
    underlying fd, the pipe can never reach a true EOF from the host's read
    side, no matter what the guest does -- not even if the guest process/thread
    has already crashed or been epoch-killed. A bare `f.readline()` therefore
    blocks INDEFINITELY if the guest never writes another line.

    The fix: poll `select` for readability in `poll_interval` slices, bounded
    by `timeout` overall, ALSO checking `thread.is_alive()` between slices. A
    dead worker thread will never write another line, so bailing out (returning
    `""`, the same sentinel a real EOF would produce) the moment the thread is
    gone turns a fast guest death (boot failure, or an epoch/timeout kill) into
    a fast, bounded caller-side return instead of waiting out the full
    `timeout` ceiling. A guest that is genuinely alive but wedged (or just
    slow) still gets the full `timeout` before this gives up.

    Returns `""` on timeout or thread death -- callers treat that exactly like
    a real EOF (guest died / wall deadline reached).
    """
    sel = selectors.DefaultSelector()
    try:
        sel.register(f, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if sel.select(timeout=poll_interval):
                return f.readline()
            if not thread.is_alive():
                return ""
        return ""
    finally:
        sel.close()


@dataclass
class _PooledInstance:
    """A booted-and-ready (but not yet run) guest instance: FIFOs open,
    `Store`/`Linker`/`Instance` constructed, guest `_start` running on
    `thread` and blocked on `sys.stdin` past the `ready` handshake.

    `store` is exposed so `run()` can arm the per-run epoch deadline / memory
    cap on it (safe cross-thread because the guest is parked on stdin at that
    point). `exit_code`/`trap` are written by the worker thread when the guest
    finishes, so `run()`'s death-mapping can classify a guest that died without
    sending a final message (see the module docstring's error-mapping table).
    """

    scratch_dir: Path
    host_in: TextIO
    host_out: TextIO
    thread: threading.Thread | None = None
    store: Store | None = None
    exit_code: int | None = None
    trap: BaseException | None = None


class WasmScriptRunner:
    """`ScriptRunner` backed by a warm pool of CPython-WASI (wasmtime) guest
    interpreters. See the module docstring for the full bridge loop, deadline
    mechanics, error mapping, and pool/threading model."""

    def __init__(
        self,
        guest_wasm_path: str,
        guest_lib_path: str,
        *,
        pool_size: int = 2,
        memory_bytes: int | None = None,
    ) -> None:
        self._guest_wasm_path = guest_wasm_path
        self._guest_lib_path = guest_lib_path
        self._pool_size = pool_size
        # Memory cap baked at boot (before instantiation, matching s05) so the
        # store's resource limiter is attached from the start. Defaults to the
        # RunLimits default; per-run `limits.memory_bytes` is additionally
        # applied at arm time (best-effort -- see `run()`).
        self._memory_bytes = memory_bytes if memory_bytes is not None else RunLimits().memory_bytes

        self._engine = _make_engine()
        self._module = _load_module(self._engine, guest_wasm_path)

        # Bootstrap script directory: written once, preopened read-only by
        # every pool instance at `_GUEST_SCRIPTS_GUEST`.
        self._scripts_dir = Path(tempfile.mkdtemp(prefix="dr_wasm_scripts_"))
        (self._scripts_dir / _BOOTSTRAP_FILENAME).write_text(_GUEST_BOOTSTRAP_SOURCE)

        self._pool: queue.Queue[_PooledInstance] = queue.Queue()
        self._shutdown = threading.Event()
        self._closed = False
        self._close_lock = threading.Lock()

        # Shared epoch cadence ticker: advances the engine's global epoch at a
        # fixed rate so per-run absolute deadlines trip independently (see the
        # module docstring's two-sided-deadline note).
        self._epoch_thread = threading.Thread(
            target=self._epoch_ticker, name="wasm-epoch-ticker", daemon=True
        )
        self._epoch_thread.start()

        self._refill_thread = threading.Thread(
            target=self._refill_loop, name="wasm-pool-refill", daemon=True
        )
        self._refill_thread.start()

    # -- epoch ticker ---------------------------------------------------------

    def _epoch_ticker(self) -> None:
        """Advance the engine's global epoch once per `_EPOCH_TICK_INTERVAL_S`.
        One shared ticker per runner (not per run): a run arms its store's
        absolute deadline off this monotonic tick, so tripping is isolated to
        the store whose deadline was reached even under concurrent runs."""
        while not self._shutdown.is_set():
            self._engine.increment_epoch()
            self._shutdown.wait(_EPOCH_TICK_INTERVAL_S)

    # -- pool boot / teardown ------------------------------------------------

    def _boot_instance(self) -> _PooledInstance:
        """Boot one guest instance to the ready-and-idle state. Mirrors
        `spikes/code_exec/s07_pool.py`'s `one_cycle` boot phase and
        `spikes/code_exec/host.py`'s `run_python` WASI/store wiring."""
        scratch_dir = Path(tempfile.mkdtemp(prefix="dr_wasm_inst_"))
        in_fifo = scratch_dir / "in.fifo"
        out_fifo = scratch_dir / "out.fifo"
        os.mkfifo(in_fifo)
        os.mkfifo(out_fifo)

        # O_RDWR so the open() never blocks and the FIFO never sees an EOF
        # while the host holds this end open (see module docstring).
        host_in: TextIO = os.fdopen(os.open(str(in_fifo), os.O_RDWR), "w", buffering=1)
        host_out: TextIO = os.fdopen(os.open(str(out_fifo), os.O_RDWR), "r", buffering=1)

        inst = _PooledInstance(scratch_dir=scratch_dir, host_in=host_in, host_out=host_out)
        boot_error: list[BaseException] = []

        def _run_guest() -> None:
            try:
                self._run_guest_to_completion(inst)
            except BaseException as exc:  # noqa: BLE001 - surfaced via boot_error/log, thread must not crash silently
                boot_error.append(exc)
                logger.exception("wasm guest worker thread failed")

        thread = threading.Thread(target=_run_guest, daemon=True)
        inst.thread = thread
        thread.start()

        # Any failure past this point (bounded-wait timeout, malformed JSON,
        # missing/false "ready") must still release the FIFOs/thread/scratch
        # dir. The read is bounded via `_readline_bounded` (see its docstring):
        # a bare `readline()` on this O_RDWR-on-both-ends FIFO can never
        # observe EOF, so it cannot be trusted to return on a dead/wedged guest.
        try:
            ready_line = _readline_bounded(host_out, thread, _BOOT_HANDSHAKE_TIMEOUT_S)
            if not ready_line:
                if boot_error:
                    raise RuntimeError(
                        "wasm guest failed to send ready handshake"
                    ) from boot_error[0]
                raise RuntimeError(
                    "wasm guest failed to send ready handshake within "
                    f"{_BOOT_HANDSHAKE_TIMEOUT_S}s"
                )
            ready = json.loads(ready_line)
            if not ready.get("ready"):
                raise RuntimeError(f"wasm guest sent unexpected first line: {ready!r}")
        except Exception:
            thread.join(timeout=_TEARDOWN_JOIN_TIMEOUT_S)
            host_in.close()
            host_out.close()
            shutil.rmtree(scratch_dir, ignore_errors=True)
            raise

        return inst

    def _run_guest_to_completion(self, inst: _PooledInstance) -> None:
        """Runs on the instance's worker thread: instantiate + run `_start` to
        completion (blocks on `sys.stdin` inside the guest between the ready
        handshake and the start message, and again between bridge requests).
        Ported from `spikes/code_exec/host.py`'s `run_python`, plus the
        determinism recipe and the outcome capture (`exit_code`/`trap`) the
        host's error mapping reads."""
        stdin_fifo = str(inst.scratch_dir / "in.fifo")
        stdout_fifo = str(inst.scratch_dir / "out.fifo")

        linker = Linker(self._engine)
        # Determinism: allow_shadowing BEFORE define_wasi(), shims AFTER.
        linker.allow_shadowing = True
        linker.define_wasi()
        _add_determinism_shims(linker)

        store = Store(self._engine)
        store.set_epoch_deadline(_IDLE_EPOCH_DEADLINE_TICKS)
        store.set_limits(memory_size=self._memory_bytes)

        wasi = WasiConfig()
        wasi.argv = ["python", f"{_GUEST_SCRIPTS_GUEST}/{_BOOTSTRAP_FILENAME}"]
        wasi.env = [
            ("PYTHONHOME", _GUEST_LIB_GUEST),
            ("PYTHONPATH", _GUEST_LIB_GUEST),
            ("PYTHONHASHSEED", "0"),  # determinism (string hashing)
        ]
        wasi.preopen_dir(self._guest_lib_path, _GUEST_LIB_GUEST)
        wasi.preopen_dir(str(self._scripts_dir), _GUEST_SCRIPTS_GUEST)
        wasi.stdin_file = stdin_fifo
        wasi.stdout_file = stdout_fifo
        # Per-instance stderr (in the instance's own scratch dir, not the
        # shared scripts dir) so the memory-cap error mapping can parse THIS
        # guest's stderr without cross-instance interleaving.
        wasi.stderr_file = str(inst.scratch_dir / "guest_stderr.log")
        store.set_wasi(wasi)

        # Publish the store BEFORE the (blocking) start() so `run()` can arm
        # the per-run deadline/memory cap on it once the boot handshake lands.
        inst.store = store

        instance: Instance = linker.instantiate(store, self._module)
        start = instance.exports(store)["_start"]
        try:
            start(store)  # type: ignore[operator]  # wasmtime Func.__call__ is dynamically typed
            inst.exit_code = 0
        except ExitTrap as exc:
            # Normal exit (0) or a nonzero exit (e.g. an uncaught MemoryError
            # or SystemExit propagating to the CPython top level).
            inst.exit_code = exc.code
        except Trap as trap:
            # Epoch kill (INTERRUPT) or another guest trap -- captured for the
            # host's death-mapping rather than re-raised, since an epoch kill
            # is an EXPECTED outcome (a wall-timeout), not a worker-thread bug.
            inst.trap = trap

    def _teardown_instance(self, inst: _PooledInstance) -> None:
        """Sends `quit`, joins the guest worker thread, closes the FIFOs, and
        removes the instance's scratch dir. Best-effort: a guest that is
        already gone (broken pipe, epoch-killed, exited after its final
        message) or slow to notice must not prevent cleanup of everything
        else."""
        try:
            inst.host_in.write(json.dumps({"id": 0, "op": "quit"}) + "\n")
            inst.host_in.flush()
        except OSError:
            logger.debug("wasm instance teardown: stdin already closed", exc_info=True)
        if inst.thread is not None:
            inst.thread.join(timeout=_TEARDOWN_JOIN_TIMEOUT_S)
            if inst.thread.is_alive():
                logger.warning("wasm guest worker thread did not exit within teardown timeout")
        for f in (inst.host_in, inst.host_out):
            try:
                f.close()
            except OSError:
                pass
        shutil.rmtree(inst.scratch_dir, ignore_errors=True)

    # -- refill thread --------------------------------------------------------

    def _refill_loop(self) -> None:
        """Background daemon thread: keeps the pool topped up to `pool_size`,
        off the request path. A failed boot is logged and retried after
        `_REFILL_RETRY_DELAY_S` rather than exiting the loop (a silently-dead
        refill thread would starve `run()` forever with no diagnostic)."""
        while not self._shutdown.is_set():
            if self._pool.qsize() >= self._pool_size:
                self._shutdown.wait(_REFILL_POLL_S)
                continue
            try:
                inst = self._boot_instance()
            except Exception:
                logger.exception("wasm pool refill: instance boot failed, retrying")
                self._shutdown.wait(_REFILL_RETRY_DELAY_S)
                continue
            # Re-check right before publishing: close() may have flipped the
            # event while this boot was in flight, and a just-booted instance
            # must not survive into a pool that's shutting down.
            if self._shutdown.is_set():
                self._teardown_instance(inst)
                break
            self._pool.put(inst)

    # -- ScriptRunner protocol ------------------------------------------------

    def run(
        self,
        model: Model,
        req: RunRequest,
        limits: RunLimits,
        *,
        record_ops: bool,
        rev: int,
    ) -> RunResult:
        """Execute `req.code` against `model` in the WASM sandbox, serving the
        guest's `dr` facade calls with a per-run `BridgeDispatcher` and
        enforcing `limits`. See the module docstring for the full protocol,
        deadline mechanics, and error mapping. `rev` is accepted for protocol
        conformance (the recorded op batch is validated/rebased against it at
        the route layer, not here)."""
        # Imported lazily so `data_rover.core` stays free of any bridge import
        # cycle and so this API-layer dependency is obvious at the call site.
        from data_rover.core.script.bridge import BridgeDispatcher

        if self._closed:
            raise RuntimeError("WasmScriptRunner is closed")

        t0 = time.perf_counter()
        try:
            inst = self._pool.get(timeout=_POOL_GET_TIMEOUT_S)
        except queue.Empty as exc:
            raise RuntimeError(
                "wasm pool exhausted: no warm instance became available within "
                f"{_POOL_GET_TIMEOUT_S}s"
            ) from exc

        # A pooled instance always carries its worker thread and store (both
        # are set during boot, before the ready handshake `run()` waited on).
        assert inst.thread is not None
        thread = inst.thread

        dispatcher = BridgeDispatcher(
            model,
            record_ops=record_ops,
            max_ops=limits.max_ops,
            max_op_bytes=limits.max_op_bytes,
            page_limit=limits.page_limit,
        )
        # Absolute epoch deadline (in cadence ticks) for THIS run. +1 tick of
        # margin so a run armed just before a tick isn't killed a hair early.
        epoch_ticks = max(1, math.ceil(limits.wall_timeout_s / _EPOCH_TICK_INTERVAL_S)) + 1

        fin: dict[str, Any] | None = None
        try:
            # Arm per-run limits while the guest is PARKED on stdin (it has not
            # yet received the start message, so it is blocked in a WASI read,
            # not executing wasm back-edges -- cross-thread store access is
            # safe in this window).
            if inst.store is not None:
                inst.store.set_epoch_deadline(epoch_ticks)
                try:
                    inst.store.set_limits(memory_size=limits.memory_bytes)
                except Exception:
                    # Some wasmtime builds only honor set_limits before
                    # instantiation; the boot-baked default still applies.
                    logger.debug("per-run set_limits ignored; boot default applies", exc_info=True)

            start_msg = {
                "code": req.code,
                "entry": req.entry,
                "element_id": req.element_id,
                "facade_source": FACADE_SOURCE,
                "stdout_bytes": limits.stdout_bytes,
                "result_repr_bytes": limits.result_repr_bytes,
            }
            inst.host_in.write(json.dumps(start_msg) + "\n")
            inst.host_in.flush()

            wall_deadline = time.monotonic() + limits.wall_timeout_s
            while True:
                remaining = wall_deadline - time.monotonic()
                read_budget = max(remaining, 0.0) + _TIMEOUT_READ_GRACE_S
                line = _readline_bounded(inst.host_out, thread, read_budget)
                if not line:
                    break  # guest died (epoch kill / crash) or wall deadline hit
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning("wasm guest sent a non-JSON line; ignoring")
                    continue
                if msg.get("fin"):
                    fin = msg
                    break
                # Bridge request: dispatch host-side and write the response.
                resp = dispatcher.dispatch(msg)
                inst.host_in.write(json.dumps(resp) + "\n")
                inst.host_in.flush()

            duration_ms = int((time.perf_counter() - t0) * 1000)
            return self._build_result(inst, fin, dispatcher.ops, limits, duration_ms, wall_deadline)
        finally:
            # The instance is always discarded after one run (never returned to
            # the pool): teardown closes the FIFOs -- which also kills a guest
            # still wedged at the wall deadline -- and removes the scratch dir.
            self._teardown_instance(inst)

    def _build_result(
        self,
        inst: _PooledInstance,
        fin: dict[str, Any] | None,
        ops: list[dict[str, Any]],
        limits: RunLimits,
        duration_ms: int,
        wall_deadline: float,
    ) -> RunResult:
        """Assemble the `RunResult` from the guest's final message, or -- if
        the guest died without sending one -- from the captured worker outcome
        (see the module docstring's error-mapping table). Reads the guest
        stderr file, so this MUST run before `_teardown_instance` removes the
        scratch dir (it does, in `run()`)."""
        recorded_ops = list(ops)
        if fin is not None:
            err = fin.get("error")
            error = None
            if err is not None:
                error = ScriptError(
                    kind=err.get("kind", "runtime"),
                    message=err.get("message", ""),
                    traceback=err.get("traceback"),
                )
            stdout = fin.get("stdout", "")
            truncated = bool(fin.get("truncated", False))
            # Defensive host-side stdout cap (the guest caps too, but a
            # misbehaving guest must not flood the caller).
            if len(stdout) > limits.stdout_bytes:
                stdout = stdout[: limits.stdout_bytes] + "..."
                truncated = True
            return RunResult(
                stdout=stdout,
                result_repr=fin.get("result_repr"),
                ops=recorded_ops,
                error=error,
                duration_ms=duration_ms,
                truncated=truncated,
            )

        # No final message: the guest died mid-run. Make sure the worker thread
        # has finished so `exit_code`/`trap` are populated, then classify.
        if inst.thread is not None:
            inst.thread.join(timeout=_TEARDOWN_JOIN_TIMEOUT_S)
        error = self._map_guest_death(inst, limits, wall_deadline)
        return RunResult(
            stdout="",
            result_repr=None,
            ops=recorded_ops,
            error=error,
            duration_ms=duration_ms,
            truncated=False,
        )

    def _map_guest_death(
        self, inst: _PooledInstance, limits: RunLimits, wall_deadline: float
    ) -> ScriptError:
        """Classify a guest that died without emitting a final message. See the
        module docstring's error-mapping table."""
        trap = inst.trap
        if trap is not None:
            if getattr(trap, "trap_code", None) is TrapCode.INTERRUPT:
                return ScriptError(
                    kind="timeout",
                    message=f"execution exceeded the wall timeout of {limits.wall_timeout_s}s",
                )
            # Portability branch: on wasmtime builds where a store memory-limit
            # breach traps on allocation (rather than surfacing as an in-guest
            # MemoryError + nonzero exit), it lands here.
            return ScriptError(kind="memory", message=f"guest trapped: {trap}")

        exit_code = inst.exit_code
        if exit_code:  # nonzero WASI exit
            stderr = self._read_stderr(inst)
            if "MemoryError" in stderr:
                return ScriptError(
                    kind="memory",
                    message="guest exceeded its memory budget",
                    traceback=stderr or None,
                )
            return ScriptError(
                kind="runtime",
                message=f"guest exited with code {exit_code}",
                traceback=stderr or None,
            )

        # Exit 0 (or unknown) but no final message: most likely the host read
        # hit the wall deadline before the guest could finish.
        if time.monotonic() >= wall_deadline:
            return ScriptError(
                kind="timeout",
                message=f"execution exceeded the wall timeout of {limits.wall_timeout_s}s",
            )
        return ScriptError(kind="runtime", message="guest exited without producing a result")

    def _read_stderr(self, inst: _PooledInstance) -> str:
        """Best-effort read of the instance's per-instance guest stderr log
        (used only for memory-cap classification / diagnostics)."""
        try:
            return (inst.scratch_dir / "guest_stderr.log").read_text(errors="replace")
        except OSError:
            return ""

    # -- lifecycle --------------------------------------------------------

    def close(self) -> None:
        """Idempotent shutdown: stops the refill + epoch-ticker threads, drains
        and tears down every pooled instance, and removes the shared bootstrap
        scripts dir."""
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            self._shutdown.set()
        self._refill_thread.join(timeout=_TEARDOWN_JOIN_TIMEOUT_S)
        self._epoch_thread.join(timeout=_TEARDOWN_JOIN_TIMEOUT_S)
        while True:
            try:
                inst = self._pool.get_nowait()
            except queue.Empty:
                break
            self._teardown_instance(inst)
        shutil.rmtree(self._scripts_dir, ignore_errors=True)


# -- settings integration + process-wide singleton ---------------------------
#
# Everything below is Task 10 scope: turning `Settings` into a `RunLimits` /
# `ScriptRunner`, the RCE tripwire that keeps `TrustedRunner` out of real
# deployments, and the `get_runner`/`set_runner` seam `main.py`'s lifespan
# wires up and Task 11's routes will depend on (via FastAPI's
# `Depends(get_runner)`, overridable through `app.dependency_overrides`).


def run_limits_from_settings(settings: Settings) -> RunLimits:
    """Map the ``snippet_*`` limit fields on :class:`Settings` to a
    :class:`~data_rover.core.script.runner.RunLimits`. One-to-one field
    mapping; see each ``snippet_*`` field's docstring in ``settings.py`` for
    what it mirrors."""
    return RunLimits(
        wall_timeout_s=settings.snippet_wall_timeout_s,
        memory_bytes=settings.snippet_memory_bytes,
        stdout_bytes=settings.snippet_stdout_bytes,
        result_repr_bytes=settings.snippet_result_repr_bytes,
        max_ops=settings.snippet_max_ops,
        max_op_bytes=settings.snippet_max_op_bytes,
        page_limit=settings.snippet_page_limit,
    )


def build_runner_from_settings(settings: Settings) -> ScriptRunner:
    """Construct the :class:`ScriptRunner` selected by ``settings.
    snippet_runner``.

    ``"wasm"`` builds a real :class:`WasmScriptRunner` (this boots
    ``settings.snippet_pool_size`` guest interpreter instances -- callers
    that want to avoid that cost, e.g. when the guest binary is not fetched,
    must check for it themselves before calling this; see ``main.py``'s
    lifespan wiring).

    ``"trusted"`` is gated by an **RCE tripwire**: ``TrustedRunner`` (`tests/
    script/trusted_runner.py`) `exec`s snippet code in-process with no
    sandbox whatsoever (see that module's docstring). Selecting it while
    ``settings.dev_seed`` is false raises *before* the import is even
    attempted, mirroring ``main._guard_prod_secret``'s refuse-to-boot
    posture: a misconfigured ``DATA_ROVER_SNIPPET_RUNNER=trusted`` in a real
    deployment must fail loud at startup, not hand every snippet author the
    full permissions of the API process. When ``dev_seed`` is true the import
    is lazy and guarded: ``tests/`` is not guaranteed to be on the path of
    every dev checkout, so a missing ``tests.script.trusted_runner`` is
    reported as a clear configuration error rather than a bare
    ``ModuleNotFoundError``.
    """
    if settings.snippet_runner == "trusted":
        if not settings.dev_seed:
            raise RuntimeError(
                "DATA_ROVER_SNIPPET_RUNNER=trusted requires DATA_ROVER_DEV_SEED=true. "
                "TrustedRunner execs snippet code in-process with NO sandbox "
                "(no wasmtime, no subprocess, no resource ceiling) -- refusing "
                "to boot it outside a dev checkout, which would grant every "
                "snippet author the full permissions of the API process."
            )
        try:
            # mypy (run with cwd=src/data_rover/api, see pixi.toml's
            # lint-backend task) has no stubs for the tests/ tree -- this
            # import is dev-checkout-only and guarded at runtime by the
            # except clause below, not something mypy can type-check anyway.
            from tests.script.trusted_runner import TrustedRunner  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(
                "DATA_ROVER_SNIPPET_RUNNER=trusted but tests.script.trusted_runner "
                "could not be imported -- the trusted runner is only available in "
                "dev checkouts that include the tests/ tree on the import path."
            ) from exc
        return TrustedRunner()

    return WasmScriptRunner(
        settings.snippet_guest_wasm_path,
        settings.snippet_guest_lib_path,
        pool_size=settings.snippet_pool_size,
    )


#: Process-wide runner singleton. `None` until `main.py`'s lifespan startup
#: constructs one (or leaves it unset if the wasm guest binary is absent --
#: see the module docstring in `main.py`'s lifespan wiring). Task 11's routes
#: read this through `get_runner` as a FastAPI dependency and must treat
#: `None` as "runner unavailable" (503), not crash.
_runner: ScriptRunner | None = None


def get_runner() -> ScriptRunner | None:
    """Process-wide `ScriptRunner` singleton accessor. A plain zero-arg
    callable on purpose: Task 11 wires it in as a FastAPI dependency
    (`Depends(get_runner)`) and tests override it via
    `app.dependency_overrides[get_runner] = ...`. Returns `None` if no
    runner has been constructed yet (e.g. the wasm guest binary is not
    fetched) -- callers must not assume a non-`None` result."""
    return _runner


def set_runner(runner: ScriptRunner | None) -> None:
    """Install (or clear, with `None`) the process-wide runner singleton.
    Called by `main.py`'s lifespan startup/shutdown and by tests that need a
    stand-in runner via `app.dependency_overrides`/direct monkeypatching."""
    global _runner
    _runner = runner


def reset_runner() -> None:
    """Test seam: clear the singleton without constructing a replacement.
    Equivalent to `set_runner(None)`, named for symmetry with other
    `reset_*` test seams in this codebase (e.g. `session.reset_session`)."""
    set_runner(None)
