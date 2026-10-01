"""In-process `ScriptRunner` used only by the test suite.

**RCE tripwire — this must never move to `src/`.** `TrustedRunner` `exec`s
`HARNESS_SOURCE`, which in turn `exec`s `FACADE_SOURCE` and then arbitrary
snippet code, in the *current*
Python process, with a live `BridgeDispatcher` wired straight into the
guest's `_transport` global. There is no sandbox here: no wasmtime, no
subprocess, no seccomp, no resource ceiling beyond the soft stdout cap the harness
implements itself. That is fine for a test harness exercising
`facade_src.FACADE_SOURCE` against a `Model` built in the same test process,
but it is exactly the shape of bug this project designs against: production
execution must call across a WASM guest boundary rather than a bare Python
callable. If you are tempted to promote this file into `src/data_rover/...`
as a "quick" runner for the real API, don't — that would hand every snippet
author the full permissions of the API process. It lives under `tests/` on
purpose, and only imports `data_rover.core.*` (never `data_rover.api.*`), to
make that boundary visible.
"""

from __future__ import annotations

import datetime
import os
import random
import time

from data_rover.core.model.model import Model
from data_rover.core.script.bridge import BridgeDispatcher, project_roots
from data_rover.core.script.facade_src import FACADE_SOURCE
from data_rover.core.script.harness_src import HARNESS_SOURCE
from data_rover.core.script.runner import (
    CallResult,
    RunLimits,
    RunRequest,
    RunResult,
    ScriptBudget,
    ScriptError,
    WireInputs,
    decode_call_payload,
    decode_reads,
    input_element_ids,
)


_PINNED_S = 1750000000.0
_PINNED_NS = 1_750_000_000_000_000_000


class _PinnedDateTime(datetime.datetime):
    @classmethod
    def now(cls, tz: datetime.tzinfo | None = None) -> _PinnedDateTime:
        return cls.fromtimestamp(_PINNED_S, tz)


def pin_determinism() -> None:
    """Pin the clock and the entropy sources the way the server's guest does.

    Irreversible for the process: only a child that exists to record output
    asks for it. `datetime.datetime.now` is pinned too, since CPython reads
    the system clock for it without going through `time.time`.
    """
    time.time = lambda: _PINNED_S
    time.time_ns = lambda: _PINNED_NS
    os.urandom = lambda n: b"\x42" * n
    # The key CPython's urandom path builds from 624 words of 0x42424242.
    random.seed(int.from_bytes(b"\x42" * 2496, "little"))
    datetime.datetime = _PinnedDateTime  # type: ignore[misc]


def _load_harness(dispatcher: BridgeDispatcher, limits: RunLimits) -> dict:
    """`HARNESS_SOURCE` exec'd in a namespace bound to this dispatcher: the
    same harness text the server's WASM guest runs."""
    harness: dict = {
        "_transport": dispatcher.dispatch,
        "_read_memo_max": limits.read_memo_max,
    }
    exec(compile(HARNESS_SOURCE, "<harness>", "exec"), harness)
    return harness


def _script_error(err: dict | None) -> ScriptError | None:
    if err is None:
        return None
    return ScriptError(
        kind=err["kind"], message=err["message"], traceback=err["traceback"]
    )


def _limits_dict(limits: RunLimits) -> dict[str, int]:
    return {
        "stdout_bytes": limits.stdout_bytes,
        "result_repr_bytes": limits.result_repr_bytes,
    }


class TrustedRunner:
    """In-process `ScriptRunner`. See the module docstring: test-only, no
    sandboxing. Implements the `ScriptRunner` protocol from `runner.py`."""

    def __init__(self, *, deterministic: bool = False) -> None:
        self._deterministic = deterministic

    def run_harness(
        self,
        model: Model,
        req: RunRequest,
        limits: RunLimits,
        *,
        record_ops: bool,
    ) -> tuple[dict, BridgeDispatcher]:
        """One console run: the harness's own answer and the dispatcher that
        served it."""
        if self._deterministic:
            pin_determinism()
        dispatcher = BridgeDispatcher(
            model,
            record_ops=record_ops,
            max_ops=limits.max_ops,
            max_op_bytes=limits.max_op_bytes,
            page_limit=limits.page_limit,
        )
        out = _load_harness(dispatcher, limits)["_dr_run"](
            {
                "code": req.code,
                "facade": FACADE_SOURCE,
                "entry": req.entry,
                "element_ids": req.element_ids,
                "inputs": req.inputs,
                "limits": _limits_dict(limits),
            }
        )
        return out, dispatcher

    def run(
        self,
        model: Model,
        req: RunRequest,
        limits: RunLimits,
        *,
        record_ops: bool,
        rev: int,
    ) -> RunResult:
        start = time.monotonic()
        out, dispatcher = self.run_harness(model, req, limits, record_ops=record_ops)
        duration_ms = int((time.monotonic() - start) * 1000)
        return RunResult(
            stdout=out["stdout"],
            result_repr=out["result_repr"],
            ops=list(dispatcher.ops),
            error=_script_error(out.get("error")),
            duration_ms=duration_ms,
            truncated=out["truncated"],
        )

    def open_session(
        self,
        model: Model,
        code: str,
        limits: RunLimits,
        *,
        budget: ScriptBudget,
    ) -> _TrustedSession:
        """Open an embedded-evaluation session: exec the facade + module once,
        then serve repeated entry-point calls."""
        del budget  # protocol parity only — see _TrustedSession docstring
        if self._deterministic:
            pin_determinism()
        return _TrustedSession(model, code, limits)


class _TrustedSession:
    """In-process `SnippetSession` (test-only; see module docstring — the same
    no-sandbox caveat applies). `budget` is accepted for protocol parity but
    NOT enforced here: trusted sessions run hermetic tests, and budget/timeout
    degradation is exercised at the ScriptEvalContext / WASM layers."""

    def __init__(self, model: Model, code: str, limits: RunLimits) -> None:
        dispatcher = BridgeDispatcher(
            model,
            record_ops=False,  # sessions are read-only by construction
            max_ops=limits.max_ops,
            max_op_bytes=limits.max_op_bytes,
            page_limit=limits.page_limit,
        )
        self._dispatcher = dispatcher
        self._limits = limits
        self._harness = _load_harness(dispatcher, limits)
        self._session = self._harness["_dr_open"](
            FACADE_SOURCE, code, _limits_dict(limits)
        )
        self._namespace: dict = self._session["namespace"]
        self.boot_error: ScriptError | None = _script_error(self._session["error"])

    def call_harness(
        self,
        entry: str,
        element_ids: list[str],
        *,
        doc: object | None = None,
        inputs: WireInputs | None = None,
    ) -> dict:
        """One call's `_dr_call` answer, undecoded."""
        # Skip the projection entirely when the guest can't memoize anyway
        # (read_memo_max <= 0): `_memo_put` no-ops on a non-positive cap, so
        # projecting every root would be pure wasted work for zero payoff.
        # Doesn't change results, only whether we bother -- mirrors the
        # WASM host's identical guard in `api/script_runner.py`. `transform`
        # never has element_ids to project (empty by contract), so skip it
        # the same way regardless of the memo cap. Input elements ride along
        # with the roots so the guest's first touch on either is free.
        project_ids = (
            [] if entry == "transform" else [*element_ids, *input_element_ids(inputs)]
        )
        elements = (
            project_roots(self._dispatcher.model, list(dict.fromkeys(project_ids)))
            if project_ids and self._limits.read_memo_max > 0
            else []
        )
        return self._harness["_dr_call"](
            self._session,
            {
                "entry": entry,
                "element_ids": element_ids,
                "elements": elements,
                "doc": doc,
                "inputs": inputs,
            },
            _limits_dict(self._limits),
        )

    def call(
        self,
        entry: str,
        element_ids: list[str],
        *,
        doc: object | None = None,
        inputs: WireInputs | None = None,
    ) -> CallResult:
        start = time.monotonic()
        if self.boot_error is not None:
            return CallResult(value=None, error=self.boot_error, duration_ms=0)
        res = self.call_harness(entry, element_ids, doc=doc, inputs=inputs)
        if res["error"] is not None:
            return CallResult(
                value=None,
                error=_script_error(res["error"]),
                duration_ms=int((time.monotonic() - start) * 1000),
                stdout=res["stdout"],
            )
        decoded, msg = decode_call_payload(entry, res["payload"])
        duration_ms = int((time.monotonic() - start) * 1000)
        if decoded is None:
            return CallResult(
                value=None,
                error=ScriptError(kind="runtime", message=msg or "malformed payload"),
                duration_ms=duration_ms,
                stdout=res["stdout"],
            )
        return CallResult(
            value=decoded,
            error=None,
            duration_ms=duration_ms,
            reads=decode_reads(res["reads"]),
            stdout=res["stdout"],
        )

    def close(self) -> None:
        pass  # nothing to release in-process
