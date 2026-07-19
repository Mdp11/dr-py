"""Route-layer glue for embedded snippet evaluation (M2/M3): build/tear down
the per-request ScriptEvalContext, including the degraded modes (no runner /
no concurrency slot → unavailable-mode context; the request still 200s with
error cells / warnings)."""

from __future__ import annotations

from data_rover.core.model.model import Model
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import ScriptBudget, ScriptRunner

from .script_runner import run_limits_from_settings
from .settings import Settings
from .snippet_concurrency import concurrency_guard


def open_script_context(
    runner: ScriptRunner | None,
    model: Model | None,
    settings: Settings,
    *,
    needs_script: bool,
) -> tuple[ScriptEvalContext | None, bool]:
    """(context, acquired-slot). None context when the definition has no
    script work. A missing runner or full guard yields a context in
    unavailable mode (degraded content), never an HTTP error."""
    if not needs_script:
        return None, False
    limits = run_limits_from_settings(settings)
    budget = ScriptBudget.start(settings.snippet_eval_budget_s)
    if runner is None:
        return (
            ScriptEvalContext(
                None,
                None,
                limits,
                budget,
                unavailable_reason="script runner unavailable",
            ),
            False,
        )
    if not concurrency_guard.try_acquire_global(
        global_limit=settings.snippet_concurrency
    ):
        return (
            ScriptEvalContext(
                None,
                None,
                limits,
                budget,
                unavailable_reason="snippet runner busy",
            ),
            False,
        )
    return ScriptEvalContext(runner, model, limits, budget), True


def close_script_context(ctx: ScriptEvalContext | None, acquired: bool) -> None:
    """Close sessions + release the global slot; safe under partial setup."""
    if ctx is not None:
        ctx.close()
    if acquired:
        concurrency_guard.release_global()
