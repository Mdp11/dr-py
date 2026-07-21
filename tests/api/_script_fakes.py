"""Shared `ScriptRunner` stand-ins for the API script tests.

`CountingRunner` (extracted from `test_script_cell_cache_api.py` in Task 6)
counts real guest invocations so a test can prove the cell cache — not the
guest — served a repeat call. `ScriptedRunner` scripts each call's outcome by
CALL INDEX (the call's element ids are passed through too), so a sweep's
timeout sequence is deterministic regardless of scope iteration order.
`BlockingRunner` gates every call on a caller-controlled event, so an async
sweep can be paused mid-run while a test cancels/evicts it, then released for a
clean daemon-thread exit. `BarrierRunner` parks every session's FIRST call on a
`threading.Barrier`, which is how a test proves a sharded sweep really opened N
distinct guest sessions instead of asserting a scheduling-dependent count.

THREAD SAFETY (Task 11): a sharded sweep drives these doubles from several
worker threads at once, so every counter below is mutated under a private lock.
The public attributes keep their pre-existing shapes (`CountingRunner.calls` a
plain `int`, `ScriptedRunner.calls`/`BlockingRunner.calls` a mutable `[count]`)
so the single-threaded tests that read them are untouched.

These are purpose-built TEST DOUBLES and belong in `tests/` — they run snippet
code nowhere at all (they never exec anything), and must never be confused with
`tests/script/trusted_runner.py`'s unsandboxed `TrustedRunner`, which likewise
must never move into `src/`.

The runners/sessions carry full type annotations so they structurally satisfy
the `ScriptRunner`/`SnippetSession` protocols (they are passed straight into
`kick_or_join_sweep`, whose `runner` parameter is typed `ScriptRunner`).
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Literal

from data_rover.core.model.model import Model
from data_rover.core.script.runner import (
    CallResult,
    RunLimits,
    RunRequest,
    RunResult,
    ScriptBudget,
    ScriptError,
    SnippetSession,
)


def ok(value: object = None) -> CallResult:
    """A successful scalar `value()` result (deterministic, so cacheable)."""
    return CallResult(
        value={"kind": "scalar", "value": value}, error=None, duration_ms=0
    )


def timeout() -> CallResult:
    """A `timeout` call result — environmental, NEVER cached, and the kind the
    sweep's consecutive-timeout abort guard counts."""
    return CallResult(
        value=None, error=ScriptError(kind="timeout", message="t"), duration_ms=0
    )


class _CountingSession:
    boot_error: ScriptError | None = None

    def __init__(self, runner: CountingRunner) -> None:
        self._runner = runner

    def call(
        self, entry: Literal["value", "step"], element_ids: list[str]
    ) -> CallResult:
        with self._runner.lock:
            self._runner.calls += 1
        return CallResult(
            value={"kind": "scalar", "value": len(element_ids)},
            error=None,
            duration_ms=0,
        )

    def close(self) -> None:
        pass


class CountingRunner:
    """A minimal ScriptRunner stand-in whose `open_session().call()` counts real
    invocations, so a test can assert the cell cache — not the guest — served a
    repeat call. `.calls` is a plain int, incremented under `.lock` so several
    sweep workers can drive one runner."""

    def __init__(self) -> None:
        self.calls = 0
        self.lock = threading.Lock()

    def open_session(
        self, model: Model, code: str, limits: RunLimits, *, budget: ScriptBudget
    ) -> SnippetSession:
        return _CountingSession(self)

    def run(
        self,
        model: Model,
        req: RunRequest,
        limits: RunLimits,
        *,
        record_ops: bool,
        rev: int,
    ) -> RunResult:  # pragma: no cover - unused by these tests
        raise NotImplementedError


class _ScriptedSession:
    boot_error: ScriptError | None = None

    def __init__(self, runner: ScriptedRunner) -> None:
        self._runner = runner

    def call(
        self, entry: Literal["value", "step"], element_ids: list[str]
    ) -> CallResult:
        # Only the index hand-out is serialized; `outcome_fn` runs outside the
        # lock so a scripted callback that blocks cannot serialize the workers.
        with self._runner.lock:
            idx = self._runner.calls[0]
            self._runner.calls[0] += 1
        return self._runner.outcome_fn(idx, element_ids)

    def close(self) -> None:
        pass


class ScriptedRunner:
    """ScriptRunner stand-in whose per-call outcome is scripted by
    `outcome_fn(call_index, element_ids)`. Call-INDEX scripting makes a sweep's
    timeout sequence deterministic no matter what order rows are evaluated in;
    `element_ids` is passed through for tests that want to key per element.
    `.calls` is a mutable `[count]` so a scripted lambda can read it.

    NOTE for sharded sweeps: the call INDEX is handed out in arrival order, so
    with more than one worker the index a given cell sees is scheduling-
    dependent. Index-scripted sequences are only deterministic when the sweep
    runs serially (`snippet_sweep_workers=1`, which the `settings_sync_sweep`
    fixtures pin)."""

    def __init__(self, outcome_fn: Callable[[int, list[str]], CallResult]) -> None:
        self.outcome_fn = outcome_fn
        self.calls = [0]
        self.lock = threading.Lock()

    def open_session(
        self, model: Model, code: str, limits: RunLimits, *, budget: ScriptBudget
    ) -> SnippetSession:
        return _ScriptedSession(self)

    def run(
        self,
        model: Model,
        req: RunRequest,
        limits: RunLimits,
        *,
        record_ops: bool,
        rev: int,
    ) -> RunResult:  # pragma: no cover - unused by these tests
        raise NotImplementedError


class _BlockingSession:
    boot_error: ScriptError | None = None

    def __init__(self, runner: BlockingRunner) -> None:
        self._runner = runner

    def call(
        self, entry: Literal["value", "step"], element_ids: list[str]
    ) -> CallResult:
        with self._runner.lock:
            self._runner.calls[0] += 1
        self._runner.entered.set()
        # Bounded wait so a forgotten release can never hang the suite forever.
        self._runner.proceed.wait(timeout=10.0)
        return ok(len(element_ids))

    def close(self) -> None:
        self.closed = True


class BlockingRunner:
    """ScriptRunner stand-in whose every `call()` blocks on `proceed` until the
    test releases it (and sets `entered` on entry). Lets an async sweep be
    parked mid-run so a test can observe cancel/evict deterministically — no
    `time.sleep` races — then released for a clean daemon-thread exit."""

    def __init__(self) -> None:
        self.calls = [0]
        self.lock = threading.Lock()
        self.entered = threading.Event()
        self.proceed = threading.Event()

    def open_session(
        self, model: Model, code: str, limits: RunLimits, *, budget: ScriptBudget
    ) -> SnippetSession:
        return _BlockingSession(self)

    def run(
        self,
        model: Model,
        req: RunRequest,
        limits: RunLimits,
        *,
        record_ops: bool,
        rev: int,
    ) -> RunResult:  # pragma: no cover - unused by these tests
        raise NotImplementedError


class UnavailableRunner:
    """ScriptRunner stand-in whose `open_session` always raises, exactly the
    way `WasmScriptRunner` does when its warm pool is exhausted (or the runner
    is closed). `ScriptEvalContext._call_uncached` turns that into an
    `unavailable` CallResult, which the cell cache refuses to store — the
    condition the sweep's consecutive-unavailable abort guard exists for."""

    def __init__(self) -> None:
        self.opens = 0
        self.lock = threading.Lock()

    def open_session(
        self, model: Model, code: str, limits: RunLimits, *, budget: ScriptBudget
    ) -> SnippetSession:
        with self.lock:
            self.opens += 1
        raise RuntimeError("wasm pool exhausted")

    def run(
        self,
        model: Model,
        req: RunRequest,
        limits: RunLimits,
        *,
        record_ops: bool,
        rev: int,
    ) -> RunResult:  # pragma: no cover - unused by these tests
        raise NotImplementedError


class _BarrierSession:
    boot_error: ScriptError | None = None

    def __init__(self, runner: BarrierRunner) -> None:
        self._runner = runner
        self._waited = False

    def call(
        self, entry: Literal["value", "step"], element_ids: list[str]
    ) -> CallResult:
        if not self._waited:
            # Only the FIRST call of each session waits: the barrier has one
            # cycle, and a second wait() would park on the next cycle forever.
            self._waited = True
            self._runner.barrier.wait(timeout=10.0)
        return ok(len(element_ids))

    def close(self) -> None:
        pass


class BarrierRunner:
    """ScriptRunner stand-in that parks every session's FIRST call on a shared
    `threading.Barrier` of `parties` participants.

    This is how a test asserts a sharded sweep really opened N distinct guest
    sessions: counting `open_session` calls after the fact is scheduling-
    dependent (a fast worker can drain the queue before a slow one starts), but
    a barrier FORCES `parties` concurrent in-flight calls, so `opens` is exact.
    A missing participant raises `BrokenBarrierError` after the bounded timeout
    rather than hanging the suite, which surfaces as an honest test failure."""

    def __init__(self, parties: int) -> None:
        self.barrier = threading.Barrier(parties)
        self.opens = 0
        self.lock = threading.Lock()

    def open_session(
        self, model: Model, code: str, limits: RunLimits, *, budget: ScriptBudget
    ) -> SnippetSession:
        with self.lock:
            self.opens += 1
        return _BarrierSession(self)

    def run(
        self,
        model: Model,
        req: RunRequest,
        limits: RunLimits,
        *,
        record_ops: bool,
        rev: int,
    ) -> RunResult:  # pragma: no cover - unused by these tests
        raise NotImplementedError
