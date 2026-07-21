"""Shared per-request embedded-evaluation state (M2 script columns, M3 script
steps).

One `ScriptEvalContext` is built per top-level evaluate/export request and
threaded through table AND navigation evaluation, so all snippet work a
request transitively triggers shares one budget, one session cache, one memo,
and one warnings channel.

- **Sessions are keyed by code**: two columns/steps carrying identical code
  share one guest instance. Opened lazily on first call; all closed by
  `close()` (route-level `finally`).
- **Calls are memoized by `(code, entry, element_ids)`**: sorting by a script
  column and then rendering the page calls `value()` at most once per
  distinct binding, and identical bindings across rows dedupe for free. Sound
  under the determinism guarantee (same code + same model ⇒ same output);
  entry points that mutate module globals between calls are outside that
  guarantee and documented as such. Calls are memoized per-request AND write
  through to the session-level `ScriptCellCache` (spec §3), which makes
  results durable across requests within one model rev.
- **Degradation, not failure**: runner-unavailable / no-slot / budget-spent
  conditions synthesize error `CallResult`s (kinds `"unavailable"` /
  `"timeout"`), which the table layer renders as error cells and the nav
  layer as pruned-with-warning chains. `errored` records that ANY call failed
  — the route layer uses it to skip the row-order cache (cache-poisoning
  guard).
- **Cache-only mode (`pending`, spec §4.1)**: a whole-table pass can run with
  `cache_only=True` (instance attribute, flippable between phases, or a
  per-call `cache_only=` override) so it never invokes the guest inline — a
  cell-cache miss synthesizes a `CallResult` with error kind `"pending"`
  instead of computing, and a background sweep is expected to fill the cache
  in later. `pending` is a first-class degradation the table layer renders as
  a placeholder, not an error: it does NOT set `errored`. It is also
  deliberately never memoized and never written to the cell cache, so the
  same context can still serve live window calls (e.g. an on-screen window
  evaluated without `cache_only`) after a cache-only whole-table pass already
  produced a pending result for the same cell.
- **Cooperative abort (`should_abort`)**: an optional zero-arg predicate the
  context consults inside `call()` before doing any guest work. A background
  sweep passes its cancel-event's `is_set` so a cancelled job stops grinding
  mid-row-build instead of only between cells (an evicted session's ~80 MB
  model must not stay reachable for the whole sweep ceiling). An aborted call
  returns error kind `"cancelled"` — a kind `ScriptCellCache.put` refuses to
  store, so it can never poison the cache — and, like `pending`, it does NOT
  set `errored` and is NOT memoized (the abort is about the caller, not the
  snippet). Default `None` disables the probe entirely.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from typing import Literal

from ..model.model import Model
from .cell_cache import CellKey, ScriptCellCache
from .runner import (
    CallResult,
    RunLimits,
    ScriptBudget,
    ScriptError,
    ScriptRunner,
    SnippetSession,
)

MAX_SCRIPT_WARNINGS = 20


class ScriptEvalContext:
    def __init__(
        self,
        runner: ScriptRunner | None,
        model: Model | None,
        limits: RunLimits,
        budget: ScriptBudget,
        *,
        unavailable_reason: str | None = None,
        cell_cache: ScriptCellCache | None = None,
        rev: int = 0,
        cache_only: bool = False,
        should_abort: Callable[[], bool] | None = None,
    ) -> None:
        self._runner = runner
        self._model = model
        self._limits = limits
        self.budget = budget
        self._unavailable = unavailable_reason or (
            "script runner unavailable" if runner is None else None
        )
        self._sessions: dict[str, SnippetSession] = {}
        self._memo: dict[tuple[str, str, tuple[str, ...]], CallResult] = {}
        self.warnings: list[str] = []
        self._warning_set: set[str] = set()
        self.errored = False
        self._cell_cache = cell_cache
        self._rev = rev
        self._code_sha: dict[str, str] = {}
        self.cache_only = cache_only
        self._should_abort = should_abort
        self.pending_misses = 0

    def _cell_key(self, code: str, entry: str, ids: tuple[str, ...]) -> CellKey:
        sha = self._code_sha.get(code)
        if sha is None:
            sha = hashlib.sha256(code.encode()).hexdigest()
            self._code_sha[code] = sha
        return (sha, entry, ids)

    def call(
        self,
        code: str,
        entry: Literal["value", "step"],
        element_ids: list[str],
        *,
        cache_only: bool | None = None,
    ) -> CallResult:
        key = (code, entry, tuple(element_ids))
        hit = self._memo.get(key)
        if hit is not None:
            return hit
        ckey: CellKey | None = None
        if self._cell_cache is not None:
            ckey = self._cell_key(code, entry, key[2])
            cached = self._cell_cache.get(ckey, self._rev)
            if cached is not None:
                if cached.error is not None:
                    self.errored = True
                self._memo[key] = cached
                return cached
        # Cooperative abort probe: placed AFTER the memo/cell-cache probes (a
        # value already in hand costs nothing to return) but BEFORE the
        # cache-only pending branch and any guest work. `"cancelled"` is
        # refused by ScriptCellCache.put, so an aborted call can never poison
        # the cache; it is neither memoized nor counted as an error, because
        # the abort says nothing about the snippet.
        if self._should_abort is not None and self._should_abort():
            return CallResult(
                value=None,
                error=ScriptError(kind="cancelled", message="evaluation cancelled"),
                duration_ms=0,
            )
        if cache_only if cache_only is not None else self.cache_only:
            self.pending_misses += 1
            return CallResult(
                value=None,
                error=ScriptError(kind="pending", message="not computed yet"),
                duration_ms=0,
            )
        res = self._call_uncached(code, entry, element_ids)
        if res.error is not None:
            self.errored = True
        self._memo[key] = res
        if self._cell_cache is not None and ckey is not None:
            # put() filters non-deterministic error kinds itself
            self._cell_cache.put(ckey, res, self._rev)
        return res

    def _call_uncached(
        self, code: str, entry: Literal["value", "step"], element_ids: list[str]
    ) -> CallResult:
        if self._unavailable is not None:
            return CallResult(
                value=None,
                error=ScriptError(kind="unavailable", message=self._unavailable),
                duration_ms=0,
            )
        if self.budget.exhausted:
            return CallResult(
                value=None,
                error=ScriptError(
                    kind="timeout", message="evaluation budget exhausted"
                ),
                duration_ms=0,
            )
        assert self._runner is not None and self._model is not None
        sess = self._sessions.get(code)
        if sess is None:
            try:
                sess = self._runner.open_session(
                    self._model, code, self._limits, budget=self.budget
                )
            except Exception as exc:
                # `open_session` is documented as never raising for
                # snippet-caused failures, but a closed runner or an
                # exhausted warm pool (`WasmScriptRunner`) raises
                # `RuntimeError` -- degrade like the runner-unavailable
                # branch above rather than letting it 500 the route.
                return CallResult(
                    value=None,
                    error=ScriptError(kind="unavailable", message=str(exc)),
                    duration_ms=0,
                )
            self._sessions[code] = sess
        if sess.boot_error is not None:
            return CallResult(value=None, error=sess.boot_error, duration_ms=0)
        return sess.call(entry, element_ids)

    def add_warning(self, message: str) -> None:
        if message in self._warning_set or len(self.warnings) >= MAX_SCRIPT_WARNINGS:
            return
        self._warning_set.add(message)
        self.warnings.append(message)

    def close(self) -> None:
        for sess in self._sessions.values():
            sess.close()
        self._sessions.clear()
