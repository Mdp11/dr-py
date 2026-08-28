"""TransformHost: session reuse per code, the LRU eviction cap, size caps,
the failure-is-failure ValueError mapping, and slot acquisition/release."""

from typing import Literal

import pytest

from data_rover.api.settings import Settings
from data_rover.api.snippet_concurrency import concurrency_guard
from data_rover.api.table_export_engine import (
    _TRANSFORM_SESSION_CACHE_MAX,
    TransformUnavailableError,
    open_transform_host,
)
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
from tests.script.conftest import tiny_model
from tests.script.trusted_runner import TrustedRunner

# Build the smallest Model the api test-package already uses for direct
# (non-HTTP) engine tests — see tests/api/_script_fakes.py / the model
# builders in tests/script; the host never reads the model in these tests.


@pytest.fixture
def model():
    return tiny_model()


class _TrackingSession:
    """A session whose `transform` result echoes the CODE it was opened for
    (not just the input doc), so a test can prove a given entry's output
    really came from ITS OWN session rather than a stale/wrong one."""

    boot_error: ScriptError | None = None

    def __init__(self, code: str, runner: "TrackingRunner") -> None:
        self._code = code
        self._runner = runner

    def call(
        self,
        entry: Literal["value", "step", "transform"],
        element_ids: list[str],
        *,
        doc: object | None = None,
        inputs: object | None = None,
    ) -> CallResult:
        self._runner.calls.append(self._code)
        return CallResult(
            value={"kind": "scalar", "value": {"code": self._code, "doc": doc}},
            error=None,
            duration_ms=0,
        )

    def close(self) -> None:
        self._runner.closed.append(self._code)
        if self._runner.raise_on_close:
            raise RuntimeError("close failed")


class TrackingRunner:
    """ScriptRunner stand-in for `TransformHost`'s LRU-cache tests: records
    every `open_session`/`close()` call by CODE (not by session identity),
    so a test can assert cache hits/misses/evictions precisely. Optionally
    makes every session's `close()` raise, to exercise the eviction path's
    error handling."""

    def __init__(self, *, raise_on_close: bool = False) -> None:
        self.opens: list[str] = []
        self.closed: list[str] = []
        self.calls: list[str] = []
        self.raise_on_close = raise_on_close

    def open_session(
        self, model: Model, code: str, limits: RunLimits, *, budget: ScriptBudget
    ) -> SnippetSession:
        self.opens.append(code)
        return _TrackingSession(code, self)

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


def _settings(**kw):
    return Settings(dev_seed=True, **kw)


def test_no_runner_raises_unavailable_not_busy(model):
    with pytest.raises(TransformUnavailableError) as e:
        open_transform_host(None, model, _settings())
    assert e.value.busy is False


def test_no_slot_raises_busy(model):
    settings = _settings(snippet_concurrency=1)
    assert concurrency_guard.try_acquire_global(global_limit=1)
    try:
        with pytest.raises(TransformUnavailableError) as e:
            open_transform_host(TrustedRunner(), model, settings)
        assert e.value.busy is True
    finally:
        concurrency_guard.release_global()


def test_apply_transforms_and_reuses_one_session_per_code(model):
    host = open_transform_host(TrustedRunner(), model, _settings())
    try:
        code = "def transform(doc):\n    return {'wrapped': doc}\n"
        out1 = host.apply(code, [1], "e1")
        out2 = host.apply(code, [2], "e2")
        assert out1 == {"wrapped": [1]} and out2 == {"wrapped": [2]}
        assert len(host._sessions) == 1  # one warm session per distinct code
    finally:
        host.close()


def test_apply_failures_are_value_errors_naming_the_entry(model):
    host = open_transform_host(TrustedRunner(), model, _settings())
    try:
        with pytest.raises(ValueError, match="entryX"):
            host.apply("def transform(doc):\n    raise RuntimeError('boom')\n", {}, "entryX")
        with pytest.raises(ValueError, match="entryY"):
            host.apply("syntax error here(", {}, "entryY")  # boot error
    finally:
        host.close()


def test_doc_and_result_size_caps(model):
    host = open_transform_host(
        TrustedRunner(), model, _settings(snippet_transform_max_bytes=64)
    )
    try:
        with pytest.raises(ValueError, match="document exceeds"):
            host.apply("def transform(doc):\n    return doc\n", "x" * 100, "big-in")
        with pytest.raises(ValueError, match="result exceeds"):
            host.apply("def transform(doc):\n    return 'y' * 100\n", "x", "big-out")
    finally:
        host.close()


def test_close_releases_the_slot(model):
    settings = _settings(snippet_concurrency=1)
    host = open_transform_host(TrustedRunner(), model, settings)
    host.close()
    host.close()  # idempotent
    assert concurrency_guard.try_acquire_global(global_limit=1)
    concurrency_guard.release_global()


def _code(i: int) -> str:
    # Each snippet's own source text IS its cache key, so distinct bodies
    # (not just distinct names/comments) are needed to force distinct entries.
    return f"def transform(doc):\n    return {{'n': {i}}}\n"


def test_eviction_caps_live_sessions_and_preserves_correctness(model):
    runner = TrackingRunner()
    host = open_transform_host(runner, model, _settings())
    try:
        n = _TRANSFORM_SESSION_CACHE_MAX + 4
        for i in range(n):
            out = host.apply(_code(i), {"i": i}, f"entry{i}")
            # Correctness half: entry i's output must come from entry i's OWN
            # session, never a neighbor's, even while eviction is churning.
            assert out == {"code": _code(i), "doc": {"i": i}}
            assert len(host._sessions) <= _TRANSFORM_SESSION_CACHE_MAX

        # Re-apply the very first code: its session was evicted long ago, so
        # this is a fresh open, and it must still produce ITS OWN result.
        out = host.apply(_code(0), {"i": 0}, "entry0-again")
        assert out == {"code": _code(0), "doc": {"i": 0}}
        assert runner.opens.count(_code(0)) == 2  # evicted once, reopened once
    finally:
        host.close()


def test_evicted_sessions_are_closed(model):
    runner = TrackingRunner()
    host = open_transform_host(runner, model, _settings())
    try:
        codes = [_code(i) for i in range(_TRANSFORM_SESSION_CACHE_MAX + 1)]
        for i, code in enumerate(codes):
            host.apply(code, None, f"entry{i}")
        # Exactly one eviction: the (cap+1)-th distinct code pushed out the
        # least-recently-used one, which is the FIRST code inserted.
        assert runner.closed == [codes[0]]
        assert codes[0] not in host._sessions
        assert len(host._sessions) == _TRANSFORM_SESSION_CACHE_MAX
    finally:
        host.close()


def test_identical_code_shares_one_session(model):
    runner = TrackingRunner()
    host = open_transform_host(runner, model, _settings())
    try:
        code = _code(0)
        host.apply(code, {"a": 1}, "e1")
        host.apply(code, {"a": 2}, "e2")
        assert runner.opens == [code]  # opened once, reused on the second call
        assert len(host._sessions) == 1
    finally:
        host.close()


def test_lru_order_reuse_survives_eviction(model):
    runner = TrackingRunner()
    host = open_transform_host(runner, model, _settings())
    try:
        codes = [_code(i) for i in range(_TRANSFORM_SESSION_CACHE_MAX)]
        for i, code in enumerate(codes):
            host.apply(code, None, f"entry{i}")
        # Touch the first (otherwise least-recently-used) code again, making
        # it most-recently-used.
        host.apply(codes[0], None, "entry0-again")
        # One more distinct code should now evict codes[1] (the new LRU),
        # NOT codes[0].
        host.apply(_code(len(codes)), None, "entry-extra")
        assert codes[0] in host._sessions
        assert codes[1] not in host._sessions
        assert runner.closed == [codes[1]]
        assert runner.opens.count(codes[0]) == 1  # never reopened
    finally:
        host.close()


def test_close_releases_slot_once_including_after_evictions(model):
    settings = _settings(snippet_concurrency=1)
    runner = TrackingRunner()
    host = open_transform_host(runner, model, settings)
    for i in range(_TRANSFORM_SESSION_CACHE_MAX + 3):
        host.apply(_code(i), None, f"entry{i}")
    host.close()
    host.close()  # idempotent even with evictions already in play
    assert concurrency_guard.try_acquire_global(global_limit=1)
    concurrency_guard.release_global()


def test_evicted_session_close_raising_does_not_break_apply(model):
    """A raising close() on an EVICTED session is unrelated to the entry
    `apply()` is currently serving — it must not surface as that entry's
    ValueError. The final `close()`'s own loop over still-live sessions is
    untouched pre-existing behavior (it propagates a raise, same as always),
    but its try/finally must still release the slot either way."""
    settings = _settings(snippet_concurrency=1)
    runner = TrackingRunner(raise_on_close=True)
    host = open_transform_host(runner, model, settings)
    for i in range(_TRANSFORM_SESSION_CACHE_MAX + 1):
        out = host.apply(_code(i), {"i": i}, f"entry{i}")
        assert out == {"code": _code(i), "doc": {"i": i}}
    assert runner.closed == [_code(0)]  # the single eviction: swallowed, not raised

    with pytest.raises(RuntimeError):
        host.close()
    assert concurrency_guard.try_acquire_global(global_limit=1)
    concurrency_guard.release_global()


def test_apply_ex_returns_value_and_stdout_without_raising(model):
    host = open_transform_host(TrustedRunner(), model, _settings())
    try:
        out = host.apply_ex(
            "def transform(doc):\n    print('hi', doc)\n    return {'n': doc}\n",
            1,
            "e",
        )
        assert out.error is None
        assert out.value == {"n": 1}
        assert out.stdout == "hi 1\n"
    finally:
        host.close()


def test_apply_ex_reports_a_raise_as_a_typed_error_with_stdout(model):
    host = open_transform_host(TrustedRunner(), model, _settings())
    try:
        out = host.apply_ex(
            "def transform(doc):\n    print('x')\n    raise ValueError('boom')\n",
            {},
            "e",
        )
        assert out.error is not None
        assert out.error.kind == "runtime" and "boom" in out.error.message
        assert out.error.traceback and "<snippet>" in out.error.traceback
        assert out.stdout == "x\n"
        assert out.value is None
    finally:
        host.close()


def test_apply_ex_reports_a_boot_error(model):
    host = open_transform_host(TrustedRunner(), model, _settings())
    try:
        out = host.apply_ex("def transform(doc:\n", {}, "e")
        assert out.error is not None and out.error.kind == "syntax"
    finally:
        host.close()


def test_apply_ex_result_over_cap_is_a_value_error(model):
    # Size caps are the HOST's limits, not the snippet's failure: still raised.
    host = open_transform_host(
        TrustedRunner(), model, _settings(snippet_transform_max_bytes=16)
    )
    try:
        with pytest.raises(ValueError, match="e: transform result exceeds"):
            host.apply_ex("def transform(doc):\n    return 'x' * 100\n", 1, "e")
    finally:
        host.close()
