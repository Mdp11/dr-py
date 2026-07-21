"""ScriptEvalContext × ScriptCellCache: write-through, cross-context reuse,
rev-mismatch miss, non-deterministic errors not written (spec §3.2)."""

from typing import Literal

from data_rover.core.script.cell_cache import ScriptCellCache
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import (
    CallResult,
    RunLimits,
    ScriptBudget,
    ScriptError,
)


class _FakeSession:
    boot_error = None

    def __init__(self, outcome: CallResult, counter: list[int]) -> None:
        self._outcome = outcome
        self._counter = counter

    def call(self, entry: Literal["value", "step"], element_ids: list[str]) -> CallResult:
        self._counter[0] += 1
        return self._outcome

    def close(self) -> None:
        pass


class _FakeRunner:
    def __init__(self, outcome: CallResult) -> None:
        self.calls = [0]
        self._outcome = outcome

    def open_session(self, model, code, limits, *, budget):
        return _FakeSession(self._outcome, self.calls)

    def run(self, *a, **k):  # pragma: no cover - protocol completeness
        raise NotImplementedError


OK = CallResult(value={"kind": "scalar", "value": 5}, error=None, duration_ms=1)
TIMEOUT = CallResult(
    value=None, error=ScriptError(kind="timeout", message="t"), duration_ms=1
)
RUNTIME_ERROR = CallResult(
    value=None, error=ScriptError(kind="runtime", message="boom"), duration_ms=1
)


def _ctx(runner, cache: ScriptCellCache | None, rev: int = 1) -> ScriptEvalContext:
    return ScriptEvalContext(
        runner,
        object(),  # type: ignore[arg-type]
        RunLimits(),
        ScriptBudget.start(60),
        cell_cache=cache,
        rev=rev,
    )


def test_cross_context_reuse() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(OK)
    c1 = _ctx(runner, cache)
    assert c1.call("def value(e): ...", "value", ["e1"]).error is None
    c1.close()
    c2 = _ctx(runner, cache)  # fresh request, same session cache
    assert c2.call("def value(e): ...", "value", ["e1"]).error is None
    c2.close()
    assert runner.calls[0] == 1  # second context never hit the guest


def test_rev_mismatch_misses_and_does_not_poison() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(2)
    runner = _FakeRunner(OK)
    c = _ctx(runner, cache, rev=1)  # request raced a commit: older rev
    c.call("code", "value", ["e1"])
    c.close()
    assert cache.size == 0  # stale write rejected
    assert runner.calls[0] == 1


def test_environmental_error_not_written() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(TIMEOUT)
    c = _ctx(runner, cache)
    assert c.call("code", "value", ["e1"]).error.kind == "timeout"  # type: ignore[union-attr]
    c.close()
    assert cache.size == 0
    c2 = _ctx(runner, cache)
    c2.call("code", "value", ["e1"])  # retried, not served from cache
    c2.close()
    assert runner.calls[0] == 2


def test_no_cache_still_works() -> None:
    runner = _FakeRunner(OK)
    c = _ctx(runner, None)
    assert c.call("code", "value", ["e1"]).error is None
    c.close()


def test_cached_runtime_error_poisons_fresh_context() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(RUNTIME_ERROR)
    c1 = _ctx(runner, cache)
    assert c1.call("code", "value", ["e1"]).error.kind == "runtime"  # type: ignore[union-attr]
    c1.close()
    assert cache.size == 1  # "runtime" is a cacheable error kind

    c2 = _ctx(runner, cache)  # fresh context, has never called anything yet
    assert c2.errored is False
    result = c2.call("code", "value", ["e1"])
    c2.close()
    assert runner.calls[0] == 1  # served from the cache, guest never re-invoked
    assert result.error.kind == "runtime"  # type: ignore[union-attr]
    assert c2.errored is True  # a cached error must still poison the request


def test_cache_hit_populates_memo() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(OK)
    primer = _ctx(runner, cache)
    primer.call("code", "value", ["e1"])
    primer.close()
    assert runner.calls[0] == 1  # priming call hit the guest once

    c = _ctx(runner, cache)  # fresh context; its first call is a cache hit
    first = c.call("code", "value", ["e1"])
    assert runner.calls[0] == 1  # served from the cache, not the guest

    cache.clear_and_stamp(999)  # any further cache.get at rev=1 now misses
    second = c.call("code", "value", ["e1"])
    c.close()
    assert second is first
    assert runner.calls[0] == 1  # still not called: this came from the memo


def test_cache_only_miss_is_pending_not_guest() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(OK)
    c = _ctx(runner, cache)
    c.cache_only = True
    res = c.call("code", "value", ["e1"])
    assert res.error is not None and res.error.kind == "pending"
    assert runner.calls[0] == 0
    assert c.pending_misses == 1
    assert not c.errored  # pending is not poison
    # NOT memoized: flipping to live mode computes for real
    c.cache_only = False
    assert c.call("code", "value", ["e1"]).error is None
    assert runner.calls[0] == 1
    c.close()


def test_cache_only_hit_served() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(OK)
    warm = _ctx(runner, cache)
    warm.call("code", "value", ["e1"])
    warm.close()
    c = _ctx(runner, cache)
    c.cache_only = True
    assert c.call("code", "value", ["e1"]).error is None
    assert c.pending_misses == 0
    c.close()


def test_per_call_override_forces_cache_only() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(OK)
    c = _ctx(runner, cache)  # ctx-level mode is live
    res = c.call("code", "value", ["e1"], cache_only=True)
    assert res.error is not None and res.error.kind == "pending"
    assert runner.calls[0] == 0
    c.close()


def test_per_call_override_forces_live() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(OK)
    c = _ctx(runner, cache)  # start with empty cache
    c.cache_only = True  # ctx-level mode is cache-only
    res = c.call("code", "value", ["e1"], cache_only=False)  # override to live
    assert res.error is None
    assert res.value == {"kind": "scalar", "value": 5}
    assert runner.calls[0] == 1  # guest was invoked
    assert c.pending_misses == 0  # no pending recorded
    c.close()
