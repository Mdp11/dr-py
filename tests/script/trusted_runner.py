"""In-process `ScriptRunner` used only by the test suite.

**RCE tripwire — this must never move to `src/`.** `TrustedRunner` `exec`s
`FACADE_SOURCE` followed directly by arbitrary snippet code in the *current*
Python process, with a live `BridgeDispatcher` wired straight into the
guest's `_transport` global. There is no sandbox here: no wasmtime, no
subprocess, no seccomp, no resource ceiling beyond the soft stdout cap this
module implements itself. That is fine for a test harness exercising
`facade_src.FACADE_SOURCE` against a `Model` built in the same test process,
but it is exactly the shape of bug this project is trying to design *out* of
production execution (Tasks 8/9 replace `_transport` with a call across a
WASM guest boundary instead of a bare Python callable). If you are tempted
to promote this file into `src/data_rover/...` as a "quick" runner for the
real API, don't — that would hand every snippet author the full permissions
of the API process. It lives under `tests/` on purpose, and only imports
`data_rover.core.*` (never `data_rover.api.*`), to make that boundary visible.
"""

from __future__ import annotations

import contextlib
import sys
import time
import traceback

from data_rover.core.model.model import Model
from data_rover.core.script.bridge import BridgeDispatcher
from data_rover.core.script.facade_src import FACADE_SOURCE
from data_rover.core.script.runner import (
    CallResult,
    RunLimits,
    RunRequest,
    RunResult,
    ScriptBudget,
    ScriptError,
    SnippetSession,
    decode_call_payload,
)

#: The filename `compile()`/`exec()` see for the concatenated facade+snippet
#: source. Used both as the `exec` "file" and as the marker that lets
#: `_format_guest_traceback` keep only guest frames (never a
#: `trusted_runner.py` frame) when rendering a `ScriptError.traceback`.
_SNIPPET_FILENAME = "<snippet>"


class _CappedStdout:
    """A `sys.stdout` replacement that stops accumulating past `cap` chars.

    A plain `io.StringIO` would happily buffer an unbounded `print` loop
    from untrusted code; this caps the buffer at construction time and just
    drops (rather than raises on) writes past the cap, flagging
    `.truncated` so the caller can surface that to the snippet author.
    """

    def __init__(self, cap: int) -> None:
        self._cap = max(0, cap)
        self._parts: list[str] = []
        self._size = 0
        self.truncated = False

    def write(self, s: str) -> int:
        if self._size >= self._cap:
            if s:
                self.truncated = True
            return len(s)
        remaining = self._cap - self._size
        if len(s) > remaining:
            self._parts.append(s[:remaining] + "...")
            self._size = self._cap
            self.truncated = True
        else:
            self._parts.append(s)
            self._size += len(s)
        return len(s)

    def flush(self) -> None:  # pragma: no cover - no-op, kept for file-like duck typing
        pass

    def getvalue(self) -> str:
        return "".join(self._parts)


def _format_guest_traceback() -> str:
    """Render `sys.exc_info()` keeping only frames from the exec'd
    facade+snippet source (`_SNIPPET_FILENAME`) — never a `trusted_runner.py`
    frame, so the traceback a snippet author sees points at their own code,
    not this harness's internals."""
    exc_type, exc, tb = sys.exc_info()
    assert exc_type is not None and exc is not None
    frames = [f for f in traceback.extract_tb(tb) if f.filename == _SNIPPET_FILENAME]
    lines = ["Traceback (most recent call last):\n"]
    lines.extend(traceback.format_list(frames))
    lines.extend(traceback.format_exception_only(exc_type, exc))
    return "".join(lines)


class TrustedRunner:
    """In-process `ScriptRunner`. See the module docstring: test-only, no
    sandboxing. Implements the `ScriptRunner` protocol from `runner.py`."""

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
        dispatcher = BridgeDispatcher(
            model,
            record_ops=record_ops,
            max_ops=limits.max_ops,
            max_op_bytes=limits.max_op_bytes,
            page_limit=limits.page_limit,
        )
        namespace: dict = {"_transport": dispatcher.dispatch}
        stdout = _CappedStdout(limits.stdout_bytes)
        error: ScriptError | None = None
        value = None
        have_value = False

        source = FACADE_SOURCE + "\n" + req.code
        try:
            compiled = compile(source, _SNIPPET_FILENAME, "exec")
        except SyntaxError as exc:
            error = ScriptError(kind="syntax", message=str(exc), traceback=None)
            compiled = None

        if compiled is not None:
            with contextlib.redirect_stdout(stdout):  # type: ignore[type-var]
                try:
                    exec(compiled, namespace)
                    if req.entry == "script":
                        if "result" in namespace:
                            value = namespace["result"]
                            have_value = True
                    else:
                        fn = namespace.get(req.entry)
                        if fn is None or not callable(fn):
                            raise NameError(f"entry function {req.entry!r} is not defined")
                        els = [namespace["dr"].element(i) for i in req.element_ids]
                        value = fn(els if req.entry == "value" else (els[0] if els else None))
                        have_value = True
                except Exception:
                    error = ScriptError(
                        kind="runtime",
                        message=f"{sys.exc_info()[0].__name__}: {sys.exc_info()[1]}",  # type: ignore[union-attr]
                        traceback=_format_guest_traceback(),
                    )

        duration_ms = int((time.monotonic() - start) * 1000)

        result_repr = None
        truncated = stdout.truncated
        if error is None and have_value:
            result_repr = repr(value)
            if len(result_repr) > limits.result_repr_bytes:
                result_repr = result_repr[: limits.result_repr_bytes] + "..."
                truncated = True

        return RunResult(
            stdout=stdout.getvalue(),
            result_repr=result_repr,
            ops=list(dispatcher.ops),
            error=error,
            duration_ms=duration_ms,
            truncated=truncated,
        )

    def open_session(
        self,
        model: Model,
        code: str,
        limits: RunLimits,
        *,
        budget: ScriptBudget,
    ) -> SnippetSession:
        """Open an embedded-evaluation session: exec the facade + module once,
        then serve repeated entry-point calls."""
        del budget  # protocol parity only — see _TrustedSession docstring
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
        self._limits = limits
        self._namespace: dict = {"_transport": dispatcher.dispatch}
        self.boot_error: ScriptError | None = None
        source = FACADE_SOURCE + "\n" + code
        try:
            compiled = compile(source, _SNIPPET_FILENAME, "exec")
        except SyntaxError as exc:
            self.boot_error = ScriptError(kind="syntax", message=str(exc), traceback=None)
            return
        stdout = _CappedStdout(limits.stdout_bytes)
        with contextlib.redirect_stdout(stdout):  # type: ignore[type-var]
            try:
                exec(compiled, self._namespace)
            except Exception:
                self.boot_error = ScriptError(
                    kind="runtime",
                    message=f"{sys.exc_info()[0].__name__}: {sys.exc_info()[1]}",  # type: ignore[union-attr]
                    traceback=_format_guest_traceback(),
                )

    def call(self, entry: str, element_ids: list[str]) -> CallResult:
        start = time.monotonic()
        if self.boot_error is not None:
            return CallResult(value=None, error=self.boot_error, duration_ms=0)
        stdout = _CappedStdout(self._limits.stdout_bytes)
        with contextlib.redirect_stdout(stdout):  # type: ignore[type-var]
            try:
                fn = self._namespace.get(entry)
                if fn is None or not callable(fn):
                    raise NameError(f"entry function {entry!r} is not defined")
                els = [self._namespace["dr"].element(i) for i in element_ids]
                value = fn(els if entry == "value" else (els[0] if els else None))
                payload = self._namespace["_dr_serialize_entry_result"](entry, value)
            except Exception:
                return CallResult(
                    value=None,
                    error=ScriptError(
                        kind="runtime",
                        message=f"{sys.exc_info()[0].__name__}: {sys.exc_info()[1]}",  # type: ignore[union-attr]
                        traceback=_format_guest_traceback(),
                    ),
                    duration_ms=int((time.monotonic() - start) * 1000),
                )
        decoded, msg = decode_call_payload(entry, payload)
        duration_ms = int((time.monotonic() - start) * 1000)
        if decoded is None:
            return CallResult(
                value=None,
                error=ScriptError(kind="runtime", message=msg or "malformed payload"),
                duration_ms=duration_ms,
            )
        return CallResult(value=decoded, error=None, duration_ms=duration_ms)

    def close(self) -> None:
        pass  # nothing to release in-process
