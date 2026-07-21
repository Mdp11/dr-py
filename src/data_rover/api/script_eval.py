"""Route-layer glue for embedded snippet evaluation (M2/M3): build/tear down
the per-request ScriptEvalContext, including the degraded modes (no runner /
no concurrency slot → unavailable-mode context; the request still 200s with
error cells / warnings)."""

from __future__ import annotations

from data_rover.core.model.model import Model
from data_rover.core.script.cell_cache import ScriptCellCache
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
    cell_cache: ScriptCellCache | None = None,
    rev: int = 0,
) -> tuple[ScriptEvalContext | None, bool]:
    """(context, acquired-slot). None context when the definition has no
    script work. A missing runner or full guard yields a context in
    unavailable mode (degraded content), never an HTTP error. ``cell_cache``/
    ``rev`` are threaded through to EVERY branch (including both degraded
    modes) so a busy/unavailable request still reads through the session's
    cell cache instead of recomputing cells the guest already answered."""
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
                cell_cache=cell_cache,
                rev=rev,
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
                cell_cache=cell_cache,
                rev=rev,
            ),
            False,
        )
    return (
        ScriptEvalContext(
            runner, model, limits, budget, cell_cache=cell_cache, rev=rev
        ),
        True,
    )


def close_script_context(ctx: ScriptEvalContext | None, acquired: bool) -> None:
    """Close sessions + release the global slot; safe under partial setup."""
    if ctx is not None:
        ctx.close()
    if acquired:
        concurrency_guard.release_global()
