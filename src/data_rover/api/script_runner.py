"""wasmtime-backed :class:`~data_rover.core.script.runner.ScriptRunner`.

This module is API-layer, not core, on purpose: it is the ONLY place in this
repository (besides `tests/`) allowed to `import wasmtime` (see
`CLAUDE.md`'s script-execution architecture notes). `data_rover.core.script`
stays sandbox-agnostic; this module supplies the wasmtime sandbox.

Spike provenance -- every mechanic below was proven in `spikes/code_exec/`
before landing here (see `spikes/code_exec/FINDINGS.md` for the measured
numbers this design leans on):

- **Engine/Config, module compile, WASI stdio wiring, store limits, epoch**
  -- ported from `spikes/code_exec/host.py` (`make_engine`, `run_python`).
  wasmtime-py 46.0.1 API facts baked in there (and re-verified here): there
  is no `StoreLimits` class -- `store.set_limits(memory_size=...)` takes the
  limit kwargs directly; `store.set_epoch_deadline(ticks_after_current)`;
  `wasi.preopen_dir(host_path, guest_path)`; `ExitTrap` is a sibling of
  `Trap` (`ExitTrap(WasmtimeError)`, unrelated in the MRO) and carries a
  `.code` int.
- **Module serialize/deserialize disk cache** -- ported from
  `spikes/code_exec/s07_pool.py`. Measured there: ~35-46ms deserialize vs
  ~0.7-1.0s cold `Module.from_file` compile, ~25x faster -- this is why the
  pool warms instances off a `.cwasm` cache instead of recompiling per boot.
- **FIFO O_RDWR stdio bridge + boot-to-ready handshake** -- ported from
  `spikes/code_exec/s02_bridge.py` (the RTT probe) and `s07_pool.py`'s
  `one_cycle` (the "warm pool moment": instance ready and idle, mid-cycle).
  Both FIFOs are opened `O_RDWR` on the host side so the open() call never
  blocks and the pipe never sees a premature EOF while the host holds it;
  wasmtime-46 streams WASI stdio to/from the FIFO live (it does not
  slurp-then-run), so a guest blocked on `sys.stdin` is served as the host
  writes.
- **Guest bootstrap loop** -- a minimal newline-JSON `ready`/`exec`/`quit`
  loop modeled on `spikes/code_exec/guest_harness.py`'s `ready`/`ping`/
  `echo`/`batch`/`quit` loop, trimmed to what Task 8's PROVISIONAL `run()`
  needs (see the "Task 8 vs Task 9" note below). It is embedded here as a
  string constant (`_GUEST_BOOTSTRAP_SOURCE`), mirroring how
  `data_rover.core.script.facade_src.FACADE_SOURCE` travels as source text
  rather than an importable module -- the guest interpreter has no access to
  anything host-side, so the only way to hand it code is text it compiles
  for itself.

**Task 8 vs Task 9 scope (binding, see `.superpowers/sdd/task-8-brief.md`).**
This task implements the engine, the module cache, and the warm pool +
background refill thread + `.close()`. `run()` is intentionally
PROVISIONAL: it takes a warm instance, sends it one `{"op": "exec", "code":
...}` request, captures stdout, and tears the instance down (a fresh
interpreter per run -- no state reuse across snippets). There is no `dr`
facade, no `BridgeDispatcher` wiring, no per-run epoch deadline, and no
memory-limit enforcement; those all land in Task 9, which replaces
`_GUEST_BOOTSTRAP_SOURCE` with a real bridge loop that `exec`s
`FACADE_SOURCE` + the user's code against a `_transport` callable backed by
FIFO request/response pairs dispatched to `BridgeDispatcher`.

**Pool / threading model.** One shared `Engine` (`epoch_interruption=True`,
built once in `__init__`) and one cached `Module` are shared by every pool
instance -- both are safe to share across instances/threads (wasmtime-py
compiles once, instantiates per `Store`). A `queue.Queue` holds pre-booted
`_PooledInstance`s: FIFOs created, `Store`/`Linker`/`Instance` constructed,
and the guest's `_start` launched on its own worker thread up to the point
it blocks on `sys.stdin` after sending its `{"ready": true}` handshake.
`run()` pops one instance, uses it for exactly one execution, and tears it
down (sends `quit`, joins the guest thread, closes FIFOs, removes the
instance's scratch dir) -- it never returns an instance to the pool. A
daemon `_refill_loop` thread notices the pool is under `pool_size` and boots
replacements off the request path (per `FINDINGS.md`, boot-to-ready is
~110-170ms p50/max -- fine at "hundreds of ms" off-path, expensive if it
were on the request path). A boot failure in the refill thread is logged and
retried after a short backoff rather than silently killing refill forever
(see `_REFILL_RETRY_DELAY_S`).

`.close()` sets a `threading.Event`, which both stops the refill loop
(checked every `_REFILL_POLL_S`) and stops it from `put()`-ing a
just-booted instance into a pool that's shutting down (a race window the
event closes: refill checks the event again right before `put`). It then
drains and tears down every instance left in the queue, and joins the
refill thread with a timeout (it is a daemon thread either way, so a stuck
join can't hang process exit). `.close()` is idempotent via `_closed`.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import selectors
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from wasmtime import Config, Engine, ExitTrap, Instance, Linker, Module, Store, WasiConfig

from data_rover.core.model.model import Model
from data_rover.core.script.runner import RunLimits, RunRequest, RunResult, ScriptError

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

#: A large-but-finite epoch deadline. `epoch_interruption=True` on the shared
#: `Config` requires SOME deadline be set before `_start` runs, or the guest
#: traps immediately on its first epoch checkpoint (confirmed empirically
#: against wasmtime-py 46.0.1: booting with `epoch_interruption=True` and no
#: `store.set_epoch_deadline()` call raises `wasmtime.Trap` with
#: `trap_code=INTERRUPT` before any guest code runs). Task 8 does not
#: implement per-run deadline enforcement (that's Task 9's job, wired via
#: `engine.increment_epoch()` off a ticker thread per `s04_epoch.py`), so
#: this constant is a placeholder large enough that no Task 8 pool boot or
#: provisional run ever trips it.
_PLACEHOLDER_EPOCH_DEADLINE = 1_000_000_000

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
#: `quit` and exit before giving up (the thread is a daemon either way, so a
#: timeout here just bounds `.close()`/per-run teardown latency, not
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
#: dies in milliseconds) is detected and reported almost immediately,
#: rather than waiting out the full `_BOOT_HANDSHAKE_TIMEOUT_S` ceiling for
#: no reason.
_BOOT_POLL_INTERVAL_S = 0.05

#: Ceiling on how long `run()`'s provisional bridge-free path waits for the
#: guest's `exec` response line. This is a COARSE SAFETY NET only, not real
#: deadline enforcement -- Task 9 replaces this whole request/response call
#: site with epoch-based cancellation keyed off `RunLimits.wall_timeout_s`.
#: Deliberately generous (a hung user snippet under the current provisional
#: path has no way to be killed early; this just stops the host process
#: itself from blocking forever on a `readline()` that will genuinely never
#: return).
_RUN_RESPONSE_TIMEOUT_S = 60.0


# Minimal newline-JSON guest bootstrap: ready handshake, then a request loop
# with two ops -- `exec` (compile+exec the given source with stdout
# captured, respond with the captured text) and `quit`. Modeled on
# `spikes/code_exec/guest_harness.py`'s dispatch loop, trimmed to what
# Task 8's provisional `run()` needs; Task 9 replaces this whole constant
# with a bridge loop that execs FACADE_SOURCE + user code against a
# `_transport` wired to FIFO request/response pairs.
#
# This is embedded as a string (not shipped as a standalone .py file)
# because it never runs host-side -- the guest CPython-WASI interpreter
# compiles it directly, so it only ever needs to be valid on the wire, the
# same reasoning `facade_src.FACADE_SOURCE`'s docstring gives for exec'ing
# source text rather than importing a module.
_GUEST_BOOTSTRAP_SOURCE = '''
import io
import json
import sys

sys.stdout.write(json.dumps({"id": 0, "ready": True}) + "\\n")
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    op = req.get("op")
    req_id = req.get("id")
    if op == "quit":
        break
    if op == "exec":
        buf = io.StringIO()
        real_stdout = sys.stdout
        sys.stdout = buf
        try:
            code_obj = compile(req.get("code", ""), "<snippet>", "exec")
            exec(code_obj, {"__name__": "__main__"})
        except Exception as exc:
            sys.stdout = real_stdout
            resp = {
                "id": req_id,
                "stdout": buf.getvalue(),
                "error": type(exc).__name__ + ": " + str(exc),
            }
        else:
            sys.stdout = real_stdout
            resp = {"id": req_id, "stdout": buf.getvalue()}
    else:
        resp = {"id": req_id, "error": "unknown op " + repr(op)}
    sys.stdout.write(json.dumps(resp) + "\\n")
    sys.stdout.flush()
'''


def _module_cache_path(guest_wasm_path: str) -> Path:
    """Where the compiled-module disk cache for `guest_wasm_path` lives.

    Choice (Task 8 scope decision): the cache file sits NEXT TO the guest
    binary (`spikes/code_exec/s07_pool.py`'s placement -- `ROOT /
    "python.cwasm"`, here generalized to whatever directory the caller's
    `guest_wasm_path` is in), not a separate cache dir. Simpler to reason
    about (one directory to look at, one thing to gitignore) and the guest
    binary's own directory is already where deployment places
    binary-adjacent state (see `spikes/code_exec/vendor/` in `.gitignore`).

    Staleness key: the cache filename embeds the guest binary's `st_size`
    and `st_mtime_ns` (`python-<size>-<mtime_ns>.cwasm`), so a re-fetched or
    rebuilt binary (different size and/or mtime) misses the cache under its
    old name and falls through to a fresh `Module.from_file` + `serialize()`
    rather than deserializing a stale compiled module. This is a
    content-independent proxy for "did the binary change" (not a content
    hash) -- cheaper than hashing a multi-MB binary on every construction,
    and correct for the actual failure mode this needs to guard (a
    re-fetched/rebuilt binary always changes at least one of size/mtime).
    """
    src = Path(guest_wasm_path)
    st = src.stat()
    return src.with_name(f"{src.stem}-{st.st_size}-{st.st_mtime_ns}.cwasm")


def _load_module(engine: Engine, guest_wasm_path: str) -> Module:
    """`Module.deserialize` from the on-disk cache if present and fresh
    (see `_module_cache_path`'s staleness-key docstring), else
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


def _readline_bounded(
    f: TextIO, thread: threading.Thread, timeout: float, poll_interval: float = _BOOT_POLL_INTERVAL_S
) -> str:
    """Read one line from `f` with a bounded wait, never blocking forever.

    **Why a bare `f.readline()` cannot be trusted here (post-review fix).**
    Both FIFOs backing a pool instance are opened `O_RDWR` on the host side
    (see the module docstring) so the `open()` call never blocks and the
    pipe never sees a premature EOF while the host holds it. That safety
    property has a sharp edge: because the *host* itself is always a live
    writer reference on `f`'s underlying fd, the pipe can never reach a
    true EOF from the host's read side, no matter what the guest does --
    not even if the guest process/thread has already crashed. A bare
    `f.readline()` therefore blocks INDEFINITELY if the guest never writes
    another line, and the classic "empty string means EOF" signal a caller
    might reach for to detect that never fires. This was reproduced
    empirically: a bad `guest_lib_path` makes `wasi.preopen_dir` raise
    inside the guest worker thread almost immediately, the exception is
    caught and logged, the thread exits -- and the boot caller's
    `host_out.readline()` still hangs forever, because nothing about the
    thread exiting changes the fd's readability from the host's OWN O_RDWR
    handle's point of view.

    The fix: poll `select` for readability in `poll_interval` slices,
    bounded by `timeout` overall, ALSO checking `thread.is_alive()` between
    slices. A dead worker thread will never write another line, so bailing
    out (returning `""`, the same sentinel a real EOF would produce) the
    moment the thread is gone turns a fast synchronous failure (dead in
    milliseconds) into a fast, bounded caller-side failure too, instead of
    waiting out the full `timeout` ceiling for no reason. A guest that is
    genuinely alive but wedged (or just slow) still gets the full
    `timeout` before this gives up.

    Returns `""` on timeout or thread death -- callers treat that exactly
    like a real EOF (see `_boot_instance`'s "not ready_line" branch).
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
    `run()` (Task 8's provisional path) uses one and tears it down; it is
    never returned to the pool."""

    scratch_dir: Path
    host_in: TextIO
    host_out: TextIO
    thread: threading.Thread


class WasmScriptRunner:
    """`ScriptRunner` backed by a warm pool of CPython-WASI (wasmtime)
    guest interpreters.

    See the module docstring for the full pool/threading model and the
    Task 8 vs Task 9 scope split. `run()` here is PROVISIONAL (Task 8): it
    consumes one warm instance per call, feeds it raw source via the
    `_GUEST_BOOTSTRAP_SOURCE` `exec` op, captures stdout, and tears the
    instance down. No facade, no bridge, no deadline/memory enforcement.
    """

    def __init__(self, guest_wasm_path: str, guest_lib_path: str, *, pool_size: int = 2) -> None:
        self._guest_wasm_path = guest_wasm_path
        self._guest_lib_path = guest_lib_path
        self._pool_size = pool_size

        self._engine = _make_engine()
        self._module = _load_module(self._engine, guest_wasm_path)

        # Bootstrap script directory: written once, preopened read-only by
        # every pool instance at `_GUEST_SCRIPTS_GUEST`. Not per-instance
        # (unlike the FIFO scratch dirs below) because its content never
        # changes across instances/runs.
        self._scripts_dir = Path(tempfile.mkdtemp(prefix="dr_wasm_scripts_"))
        (self._scripts_dir / _BOOTSTRAP_FILENAME).write_text(_GUEST_BOOTSTRAP_SOURCE)

        self._pool: queue.Queue[_PooledInstance] = queue.Queue()
        self._shutdown = threading.Event()
        self._closed = False
        self._close_lock = threading.Lock()

        self._refill_thread = threading.Thread(
            target=self._refill_loop, name="wasm-pool-refill", daemon=True
        )
        self._refill_thread.start()

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
        host_in: TextIO = os.fdopen(os.open(in_fifo, os.O_RDWR), "w", buffering=1)
        host_out: TextIO = os.fdopen(os.open(out_fifo, os.O_RDWR), "r", buffering=1)

        boot_error: list[BaseException] = []

        def _run_guest() -> None:
            try:
                self._run_guest_to_completion(str(in_fifo), str(out_fifo))
            except BaseException as exc:  # noqa: BLE001 - surfaced via boot_error/log, thread must not crash silently
                boot_error.append(exc)
                logger.exception("wasm guest worker thread failed")

        thread = threading.Thread(target=_run_guest, daemon=True)
        thread.start()

        # Any failure past this point (bounded-wait timeout, malformed JSON,
        # missing/false "ready") must still release the FIFOs/thread/scratch
        # dir -- a boot failure that leaks these would slowly exhaust
        # fds/tmp dirs across refill retries. The read itself is bounded via
        # `_readline_bounded` (see its docstring): a bare `readline()` on
        # this O_RDWR-on-both-ends FIFO can never observe EOF, so it cannot
        # be trusted to return on a dead/wedged guest.
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

        return _PooledInstance(scratch_dir, host_in, host_out, thread)

    def _run_guest_to_completion(self, stdin_fifo: str, stdout_fifo: str) -> None:
        """Runs on the instance's worker thread: instantiate + run `_start`
        to completion (blocks on `sys.stdin` inside the guest between
        requests). Ported from `spikes/code_exec/host.py`'s `run_python`,
        specialized to this runner's shared engine/module and fixed
        preopens."""
        linker = Linker(self._engine)
        linker.define_wasi()
        store = Store(self._engine)
        store.set_epoch_deadline(_PLACEHOLDER_EPOCH_DEADLINE)

        wasi = WasiConfig()
        wasi.argv = ["python", f"{_GUEST_SCRIPTS_GUEST}/{_BOOTSTRAP_FILENAME}"]
        wasi.env = [("PYTHONHOME", _GUEST_LIB_GUEST), ("PYTHONPATH", _GUEST_LIB_GUEST)]
        wasi.preopen_dir(self._guest_lib_path, _GUEST_LIB_GUEST)
        wasi.preopen_dir(str(self._scripts_dir), _GUEST_SCRIPTS_GUEST)
        wasi.stdin_file = stdin_fifo
        wasi.stdout_file = stdout_fifo
        wasi.stderr_file = str(self._scripts_dir / "guest_stderr.log")
        store.set_wasi(wasi)

        instance: Instance = linker.instantiate(store, self._module)
        start = instance.exports(store)["_start"]
        try:
            start(store)  # type: ignore[operator]  # wasmtime Func.__call__ is dynamically typed
        except ExitTrap:
            pass  # normal `quit`-triggered guest exit (sys.exit / SystemExit under WASI)

    def _teardown_instance(self, inst: _PooledInstance) -> None:
        """Sends `quit`, joins the guest worker thread, closes the FIFOs,
        and removes the instance's scratch dir. Best-effort: a guest that
        is already gone (broken pipe) or slow to notice `quit` must not
        prevent cleanup of everything else."""
        try:
            inst.host_in.write(json.dumps({"id": 0, "op": "quit"}) + "\n")
            inst.host_in.flush()
        except OSError:
            logger.debug("wasm instance teardown: stdin already closed", exc_info=True)
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
        """Background daemon thread: keeps the pool topped up to
        `pool_size`, off the request path. A failed boot is logged and
        retried after `_REFILL_RETRY_DELAY_S` rather than exiting the loop
        (a silently-dead refill thread would starve `run()` forever with no
        diagnostic)."""
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
            # event while this boot was in flight, and a just-booted
            # instance must not survive into a pool that's shutting down.
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
        """PROVISIONAL (Task 8): runs `req.code` as a bare script via the
        guest bootstrap's `exec` op and returns captured stdout. `model`,
        `limits`, and `record_ops` are accepted (protocol conformance) but
        UNUSED -- there is no bridge/facade wiring yet, so the snippet has
        no `dr` object and cannot read/write the model. Task 9 replaces
        this body with the real bridge loop.

        The response read is bounded via `_readline_bounded` (see its
        docstring) as a COARSE safety net only -- `_RUN_RESPONSE_TIMEOUT_S`
        is generous and this does not cancel a hung guest early the way
        Task 9's epoch-based deadline will; it only stops the host process
        itself from blocking forever on a `readline()` that can never
        observe EOF on this O_RDWR-on-both-ends FIFO."""
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
        try:
            inst.host_in.write(json.dumps({"id": 1, "op": "exec", "code": req.code}) + "\n")
            inst.host_in.flush()
            resp_line = _readline_bounded(inst.host_out, inst.thread, _RUN_RESPONSE_TIMEOUT_S)
            if not resp_line:
                return RunResult(
                    stdout="",
                    result_repr=None,
                    ops=[],
                    error=ScriptError(
                        kind="runtime",
                        message="wasm guest did not respond (exited or timed out)",
                    ),
                    duration_ms=int((time.perf_counter() - t0) * 1000),
                    truncated=False,
                )
            resp = json.loads(resp_line)
        finally:
            self._teardown_instance(inst)

        duration_ms = int((time.perf_counter() - t0) * 1000)
        guest_error = resp.get("error")
        error = (
            ScriptError(kind="runtime", message=str(guest_error)) if guest_error else None
        )
        return RunResult(
            stdout=resp.get("stdout", ""),
            result_repr=None,
            ops=[],
            error=error,
            duration_ms=duration_ms,
            truncated=False,
        )

    # -- lifecycle --------------------------------------------------------

    def close(self) -> None:
        """Idempotent shutdown: stops the refill thread, drains and tears
        down every pooled instance, and removes the shared bootstrap
        scripts dir."""
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            self._shutdown.set()
        self._refill_thread.join(timeout=_TEARDOWN_JOIN_TIMEOUT_S)
        while True:
            try:
                inst = self._pool.get_nowait()
            except queue.Empty:
                break
            self._teardown_instance(inst)
        shutil.rmtree(self._scripts_dir, ignore_errors=True)
