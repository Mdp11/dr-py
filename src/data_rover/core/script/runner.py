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

import time
from dataclasses import dataclass, field
from typing import Literal, Protocol

from ..model.model import Model

#: One structured read dependency recorded by the guest facade (Phase B,
#: spec 2026-07-21): ("el", id) | ("out", id) | ("in", id) |
#: ("children", id) | ("parent", id) | ("scan", type_name_or_None).
ReadKey = tuple[str, str | None]


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
        read_memo_max: Capacity of the guest facade's session-lifetime read
            memo (entries). 0 disables memoization. This staleness guarantee
            holds for embedded/sweep work, whose results are rev-stamped and
            discarded if the model rev moves under it (see
            `api/script_sweep.py`'s `session.model_rev != job.rev` check): a
            memoized read can never be *observed* stale there, even though
            the underlying model is not actually frozen for the session's
            lifetime. A console run is different — it reads without holding
            `session.write_mutex` and its result goes straight back to the
            user with no rev stamp, so it can already observe a torn read
            with or without the memo; the memo does not change that.
    """

    wall_timeout_s: float = 10
    memory_bytes: int = 256 * 1024 * 1024
    stdout_bytes: int = 256 * 1024
    result_repr_bytes: int = 64 * 1024
    max_ops: int = 1000
    max_op_bytes: int = 1024 * 1024
    page_limit: int = 500
    read_memo_max: int = 4096


@dataclass(frozen=True)
class ScriptBudget:
    """Wall-clock budget for ALL snippet work one top-level request triggers.

    One instance per evaluate/export request (built from
    ``settings.snippet_eval_budget_s``), threaded through everything that does
    embedded snippet work — a script step inside a navigation used by a table
    column draws from the SAME budget, never a fresh one. Frozen: the deadline
    is fixed at construction; consumers only ever read `remaining()`.
    """

    deadline: float  # absolute time.monotonic() deadline

    @classmethod
    def start(cls, seconds: float) -> ScriptBudget:
        return cls(deadline=time.monotonic() + seconds)

    def remaining(self) -> float:
        return max(0.0, self.deadline - time.monotonic())

    @property
    def exhausted(self) -> bool:
        return self.remaining() <= 0.0


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
class CallResult:
    """Outcome of one :meth:`SnippetSession.call`.

    ``value`` is the already-validated tagged wire payload (see
    :func:`decode_call_payload`), never a repr string; ``None`` iff ``error``
    is set. ``reads`` is the call's recorded read-set (:data:`ReadKey`
    tuples) — the union of boot-time reads and this call's reads — or
    ``None`` meaning "depends on everything" (recording overflowed, the
    guest predates read recording, or the call errored). ``None`` is the
    conservative direction: the incremental invalidator always evicts it.

    Boot-time attribution has a real gap: a read made during module exec is
    charged to every call, which correctly covers an index built at true
    module top level, but NOT the equally common lazy-init variant (a module
    global built on first use inside ``value``/``step``, e.g. ``if _index is
    None: _index = {...}``). Only the first call that triggers that lazy
    build performs the underlying reads; every later call hits the
    already-built global directly and reports nothing for it, even though
    its result still depends on it — so those later calls' cells can go
    stale across a commit that changes what the index covers. The same
    shape bites a generator created at module level but advanced
    (``next()``'d) inside a call. Fixing it would require unioning each
    call's reads into a set that later calls inherit, which degrades back to
    clear-all invalidation and defeats the purpose — so author discipline is
    required. See the ``# LIMITATION`` comment beside ``facade_src.py``'s
    ``_note_read`` and the author-facing warning in ``core/script/README.md``'s
    "Evaluation sessions (M2/M3)" section.
    """

    value: dict | None
    error: ScriptError | None
    duration_ms: int
    reads: frozenset[ReadKey] | None = None


class SnippetSession(Protocol):
    """One open evaluation session: the snippet module executed once, entry
    points callable repeatedly on the same (warm) instance.

    ``boot_error`` is set at open when the facade+module exec failed
    (syntax/runtime), or LATER if the session dies terminally (per-call
    timeout kill, guest crash) — either way the session is unusable and every
    subsequent ``call`` must return that error. Sessions are read-only by
    construction: their dispatcher is built with ``record_ops=False``.
    """

    boot_error: ScriptError | None

    def call(
        self, entry: Literal["value", "step"], element_ids: list[str]
    ) -> CallResult: ...

    def close(self) -> None:
        """Idempotent; discards the underlying instance (never pooled again)."""
        ...


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
            - ``"unavailable"`` — the script runner is not available (no runner constructed, or no concurrency slot free) — embedded evaluation degrades, never 5xxs
            - ``"pending"`` — synthetic, produced only by :class:`~data_rover.core.script.embed.ScriptEvalContext` in cache-only mode (spec §4.1): the value is not computed yet; a background sweep is (or will be) filling it in. Never produced by a runner, never cached.
        message: Human-readable error message.
        traceback: Python traceback string if available (``None`` for
            syntax/timeout/memory errors or when details are unavailable).
    """

    kind: Literal[
        "syntax",
        "runtime",
        "timeout",
        "cancelled",
        "memory",
        "limit",
        "unavailable",
        "pending",
    ]
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

    def open_session(
        self,
        model: Model,
        code: str,
        limits: RunLimits,
        *,
        budget: ScriptBudget,
    ) -> SnippetSession:
        """Open an embedded-evaluation session: exec the facade + module once,
        then serve repeated entry-point calls. Per-call deadline is
        ``min(limits.wall_timeout_s, budget.remaining())``. Never raises for
        snippet-caused failures — those land in ``boot_error``/`CallResult`.
        """
        ...


_WIRE_SCALARS = (str, int, float, bool)


def decode_call_payload(entry: str, payload: object) -> tuple[dict | None, str | None]:
    """Validate a session call's tagged wire payload from an UNTRUSTED guest.

    Returns ``(validated payload, None)`` or ``(None, error message)``. The
    accepted shapes mirror the facade's ``_dr_serialize_entry_result`` exactly
    — the two must agree by construction (same tags, same scalar set).
    """
    if not isinstance(payload, dict):
        return None, "malformed call result payload"
    if entry == "step":
        ids = payload.get("ids")
        if isinstance(ids, list) and all(isinstance(i, str) for i in ids):
            return {"ids": ids}, None
        return None, "malformed step() result payload"
    kind = payload.get("kind")
    if kind == "scalar":
        v = payload.get("value")
        if v is None or isinstance(v, _WIRE_SCALARS):
            return {"kind": "scalar", "value": v}, None
    elif kind == "scalars":
        vals = payload.get("values")
        if isinstance(vals, list) and all(
            v is None or isinstance(v, _WIRE_SCALARS) for v in vals
        ):
            return {"kind": "scalars", "values": vals}, None
    elif kind == "element":
        eid = payload.get("id")
        if isinstance(eid, str):
            return {"kind": "element", "id": eid}, None
    elif kind == "elements":
        ids = payload.get("ids")
        if isinstance(ids, list) and all(isinstance(i, str) for i in ids):
            return {"kind": "elements", "ids": ids}, None
    return None, "malformed value() result payload"


# Mirrors (and must stay >=) `facade_src.py`'s `_READS_CAP`. The facade
# cannot import this constant (it is exec'd guest source with no imports
# allowed), so the two are kept in sync by convention, not by code sharing.
# If the facade's cap ever exceeded this one, a read-set sized between the
# two would ship un-overflowed from the guest and land here over
# `_MAX_READS`, silently decoding to `None` (see the `len(obj) > _MAX_READS`
# check below) with no signal that the caps had drifted apart.
_MAX_READS = 2000
_MAX_READ_TAG_LEN = 32
_MAX_READ_ID_LEN = 512


def decode_reads(obj: object) -> frozenset[ReadKey] | None:
    """Validate a call's read-set from an UNTRUSTED guest.

    Wire shape: a list of ``[tag, id_or_null]`` 2-lists (the facade sends
    ``sorted(list(k) for k in reads)``), or ``null`` for "depends on
    everything". ANY malformation — wrong container, wrong arity, non-string
    members, oversized strings, more than ``_MAX_READS`` entries — degrades
    to ``None`` rather than raising: a hostile guest must only ever be able
    to make invalidation MORE conservative, never crash the host or shrink
    its own dependency set to dodge eviction... shrinking is inherently
    possible for a hostile guest, but a hostile guest can already return
    arbitrary VALUES; read-sets are a performance contract, not a security
    boundary (the cache is per-session, per-project, behind authz).
    """
    if not isinstance(obj, list) or len(obj) > _MAX_READS:
        return None
    out: set[ReadKey] = set()
    for item in obj:
        if not isinstance(item, list) or len(item) != 2:
            return None
        tag, ident = item
        if not isinstance(tag, str) or len(tag) > _MAX_READ_TAG_LEN:
            return None
        if ident is not None and (
            not isinstance(ident, str) or len(ident) > _MAX_READ_ID_LEN
        ):
            return None
        out.add((tag, ident))
    return frozenset(out)
