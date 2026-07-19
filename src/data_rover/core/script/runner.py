"""Pure protocol and dataclass layer for script execution.

This module defines the interface and data types that all :class:`ScriptRunner`
implementations must conform to. Implementations (e.g., wasmtime-based runners in
the API layer, in-process runners in tests) supply a :class:`ScriptRunner` instance
and call its :meth:`run` method to execute code against a model.

The runner protocol is intentionally sandbox-agnostic: it imports only
`data_rover.core.*`, never touching transport, IPC, or container layers —
those are isolated in the API/test layers. A runner receives a
:class:`~data_rover.core.model.model.Model`, a :class:`RunRequest` with code
and execution mode, and :class:`RunLimits`, and produces a :class:`RunResult`
carrying stdout, a repr of the return value, recorded ops (if enabled), and
error details (if one occurred).

The three :attr:`RunRequest.entry` modes are:
- ``"script"`` — run the code as a module (returns ``None`` unless explicit)
- ``"value"`` — call the snippet's top-level ``value(elements)`` with the
  bound elements (a list, bound order preserved) and return its result
- ``"step"`` — step-wise simulation; ``step(el)`` receives its single element
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

from ..model.model import Model


@dataclass(frozen=True)
class RunLimits:
    """Execution resource limits and caps enforced by a runner.

    Attributes:
        wall_timeout_s: Absolute deadline wall-clock seconds. Runner aborts if
            execution exceeds this and returns a ``"timeout"`` error.
        memory_bytes: Peak resident memory bytes. Runner aborts if exceeded and
            returns a ``"memory"`` error.
        stdout_bytes: Cumulative stdout size bytes. Output is truncated and
            :attr:`RunResult.truncated` is set if exceeded.
        result_repr_bytes: Size bytes for the result object's repr. Truncated if
            exceeded; :attr:`RunResult.truncated` is set.
        max_ops: Maximum number of recorded ops (mutations). Runner returns
            ``"limit"`` error if exceeded.
        max_op_bytes: Total recorded op JSON size bytes. Runner returns
            ``"limit"`` error if a single op or cumulative batch size exceeds
            this.
        page_limit: Maximum number of model elements per paginated result in
            bridge reads (e.g., ``elements_page``). Runners enforce this on
            their bridge dispatcher.
    """

    wall_timeout_s: float = 10
    memory_bytes: int = 256 * 1024 * 1024
    stdout_bytes: int = 256 * 1024
    result_repr_bytes: int = 64 * 1024
    max_ops: int = 1000
    max_op_bytes: int = 1024 * 1024
    page_limit: int = 500


@dataclass
class RunRequest:
    """A request to execute code against a model.

    Attributes:
        code: Python source code as a string (literal or template-expanded).
        entry: Execution mode: ``"script"`` (module), ``"value"`` (function of
            the bound elements), or ``"step"`` (snippet-defined entry point).
        element_ids: Context element ids for the run, in bound order.
            ``"value"`` receives ALL of them as a list of Element handles;
            ``"step"`` receives the first (its single simulated node);
            ``"script"`` ignores them. Count constraints (``value`` >= 1,
            ``step`` == 1) are enforced at the API route, not here — the
            runner layer stays lenient so tests can exercise edge shapes.
    """

    code: str
    entry: Literal["script", "value", "step"] = "script"
    element_ids: list[str] = field(default_factory=list)


@dataclass
class RunResult:
    """Outcome of a :class:`ScriptRunner.run` call.

    Attributes:
        stdout: Captured standard output as a string; may be truncated if
            :attr:`~RunLimits.stdout_bytes` was exceeded.
        result_repr: String repr of the return value (``None`` for ``"script"``
            mode or if execution returned ``None``); truncated if exceeds
            :attr:`~RunLimits.result_repr_bytes`.
        ops: List of recorded operation dicts (mutations), in call order. Empty
            if ``record_ops=False`` or if no mutations occurred.
        error: :class:`ScriptError` if execution failed, ``None`` otherwise.
        duration_ms: Total execution time in milliseconds.
        truncated: ``True`` if any output was truncated due to size limits
            (:attr:`stdout`, :attr:`result_repr`, or ops).
    """

    stdout: str
    result_repr: str | None
    ops: list[dict]
    error: ScriptError | None
    duration_ms: int
    truncated: bool


@dataclass
class ScriptError:
    """An error that occurred during script execution.

    Attributes:
        kind: Error classification:
            - ``"syntax"`` — code did not parse
            - ``"runtime"`` — unhandled exception during execution
            - ``"timeout"`` — exceeded :attr:`~RunLimits.wall_timeout_s`
            - ``"cancelled"`` — execution cancelled by caller (e.g., shutdown)
            - ``"memory"`` — exceeded :attr:`~RunLimits.memory_bytes`
            - ``"limit"`` — exceeded op count/size limit
        message: Human-readable error message.
        traceback: Python traceback string if available (``None`` for
            syntax/timeout/memory errors or when details are unavailable).
    """

    kind: Literal["syntax", "runtime", "timeout", "cancelled", "memory", "limit"]
    message: str
    traceback: str | None = None


class ScriptRunner(Protocol):
    """Protocol for code execution against a model.

    A :class:`ScriptRunner` receives a :class:`RunRequest`, enforces
    :class:`RunLimits`, and returns a :class:`RunResult`. Implementations
    (wasmtime sandbox, in-process test runner, etc.) must implement :meth:`run`.

    Implementations are not required to be async; the protocol signature is
    synchronous. The runner holds or creates its own sandbox/execution context
    and manages lifecycle (including resource cleanup).
    """

    def run(
        self,
        model: Model,
        req: RunRequest,
        limits: RunLimits,
        *,
        record_ops: bool,
        rev: int,
    ) -> RunResult:
        """Execute code against a model under resource limits.

        The runner executes :attr:`req.code` in the requested :attr:`req.entry`
        mode, enforces :attr:`limits`, and returns a :class:`RunResult`. If
        ``record_ops=True``, any mutations (via the bridge ``record_op``
        protocol) are recorded as dicts in the result; if ``False``, writes are
        rejected at the bridge layer with an error.

        Args:
            model: The live :class:`~data_rover.core.model.model.Model` to
                expose to the code (read-only; writes are recorded, not
                applied). Never modified.
            req: The code and execution mode.
            limits: Resource caps to enforce during execution.
            record_ops: If ``True``, record mutation operations (dicts) in the
                result; if ``False``, reject write attempts at the bridge layer.
            rev: The current :attr:`~data_rover.core.model.model.Model.rev` at
                call time. Recorded in the result's ops (or metadata) so callers
                can detect stale revisions before submitting the batch.

        Returns:
            A :class:`RunResult` with execution output, error details (if any),
            and recorded ops.
        """
        ...
