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
  guarantee and documented as such.
- **Degradation, not failure**: runner-unavailable / no-slot / budget-spent
  conditions synthesize error `CallResult`s (kinds `"unavailable"` /
  `"timeout"`), which the table layer renders as error cells and the nav
  layer as pruned-with-warning chains. `errored` records that ANY call failed
  — the route layer uses it to skip the row-order cache (cache-poisoning
  guard).
"""

from __future__ import annotations

from typing import Literal

from ..model.model import Model
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

    def call(
        self, code: str, entry: Literal["value", "step"], element_ids: list[str]
    ) -> CallResult:
        key = (code, entry, tuple(element_ids))
        hit = self._memo.get(key)
        if hit is not None:
            return hit
        res = self._call_uncached(code, entry, element_ids)
        if res.error is not None:
            self.errored = True
        self._memo[key] = res
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
            sess = self._runner.open_session(
                self._model, code, self._limits, budget=self.budget
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
