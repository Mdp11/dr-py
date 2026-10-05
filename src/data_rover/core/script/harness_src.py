"""Source of the snippet harness, the one copy every runner executes.

Like :data:`~data_rover.core.script.facade_src.FACADE_SOURCE`, this module is
**never imported** for its behaviour: it only ever exists as the string
constant :data:`HARNESS_SOURCE`, which a runner ``exec`` s in a namespace of
its own. Three hosts run that one text: the server's WASM guest bootstrap
(``api/script_runner.py``), the in-process test runner
(``tests/script/trusted_runner.py``) and the engine's Pyodide guest
(``engine/src/script/harness.generated.ts``, a frozen copy). What a snippet run or an
embedded call does therefore lives in one place.

The text must be plain, stdlib-only Python that never imports ``data_rover``.

**The namespace contract.** The runner binds two names in the namespace before
the harness executes: ``_transport`` and ``_read_memo_max``, exactly the two
the facade needs. The harness copies them into every fresh snippet namespace
it builds, then defines three functions:

``_dr_run(spec) -> dict``
    One console run. ``spec`` holds ``code``, ``facade``, ``entry``
    (``"script"``, ``"value"`` or ``"step"``), ``element_ids``, ``inputs`` and
    ``limits`` (``stdout_bytes``, ``result_repr_bytes``). Answers ``{"stdout",
    "result_repr", "truncated"}`` plus ``"error"`` when the run failed.

``_dr_open(facade, code, limits) -> dict``
    Execs the facade, then the module, into a fresh namespace. Answers
    ``{"namespace", "carry", "error"}``: ``carry`` is what the module printed
    at top level, ``error`` the boot error or ``None``. ``limits`` holds
    ``stdout_bytes``.

``_dr_call(session, call, limits) -> dict``
    One embedded call through the facade's ``_dr_call_entry``. ``session`` is
    the dict ``_dr_open`` answered; ``call`` holds ``entry``, ``element_ids``
    and optionally ``elements``, ``doc`` and ``inputs``. Answers ``{"payload",
    "error", "reads", "stdout"}``. The session's ``carry`` is handed to the
    first call only.

An error is ``{"kind", "message", "traceback"}``: ``"syntax"`` (no traceback)
when the code does not compile, ``"runtime"`` for anything the code raised.
``MemoryError`` is never caught: it propagates out of the harness so the host
can report a resource breach as one. Every other ``BaseException`` (a
``KeyboardInterrupt``, a ``SystemExit``, a custom subclass) ends only the run
or call that raised it and answers as a ``"runtime"`` error.

The harness captures ``print`` output by assigning ``sys.stdout`` for the
length of a run, boot or call and restores the stream it found.
"""

HARNESS_SOURCE = """
import sys
import traceback

_SNIPPET_FILENAME = "<snippet>"
_FACADE_FILENAME = "<facade>"


class _CappedStdout:
    # Stops accumulating past `cap` chars, appending an ellipsis on the
    # truncating write and flagging `.truncated`.
    def __init__(self, cap):
        self._cap = cap if cap > 0 else 0
        self._parts = []
        self._size = 0
        self.truncated = False

    def write(self, s):
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

    def flush(self):
        pass

    def getvalue(self):
        return "".join(self._parts)


def _format_guest_traceback():
    # Keep only frames from the exec'd snippet source, never a harness or
    # <facade> frame: the author sees their own lines.
    exc_type, exc, tb = sys.exc_info()
    frames = [f for f in traceback.extract_tb(tb) if f.filename == _SNIPPET_FILENAME]
    lines = ["Traceback (most recent call last):\\n"]
    lines.extend(traceback.format_list(frames))
    lines.extend(traceback.format_exception_only(exc_type, exc))
    return "".join(lines)


def _runtime_error():
    exc = sys.exc_info()[1]
    return {
        "kind": "runtime",
        "message": type(exc).__name__ + ": " + str(exc),
        "traceback": _format_guest_traceback(),
    }


def _wants_inputs(fn):
    # A console run has no table row, so binding is decided by the entry
    # function's OWN arity rather than by whether the caller sent inputs: a
    # two-argument value() always gets a dict (empty when nothing was bound)
    # instead of a missing-argument TypeError. The embedded path decides the
    # other way round (_dr_call_entry branches on `inputs`), and must: there
    # the column's declared inputs are the contract, and an arity mismatch is
    # a real definition error the cell reports.
    code = getattr(fn, "__code__", None)
    return code is not None and code.co_argcount >= 2


def _bind_inputs(namespace, inputs):
    # Same shape as _dr_call_entry's bind: element inputs become handles,
    # scalar inputs stay values.
    bound = {}
    for name, spec in (inputs or {}).items():
        if spec.get("kind") == "elements":
            bound[name] = [namespace["dr"].element(i) for i in spec["ids"]]
        else:
            bound[name] = list(spec["values"])
    return bound


def _new_namespace():
    return {"_transport": _transport, "_read_memo_max": _read_memo_max}


def _exec_units(namespace, facade, compiled):
    # Two compilation units, NOT `facade + "\\n" + code`: the snippet owns its
    # line numbers.
    exec(compile(facade, _FACADE_FILENAME, "exec"), namespace)
    exec(compiled, namespace)


def _dr_run(spec):
    code = spec["code"]
    entry = spec["entry"]
    limits = spec["limits"]
    result_repr_cap = limits["result_repr_bytes"]

    stdout = _CappedStdout(limits["stdout_bytes"])
    namespace = _new_namespace()
    error = None
    value = None
    have_value = False

    try:
        compiled = compile(code, _SNIPPET_FILENAME, "exec")
    except SyntaxError as exc:
        error = {"kind": "syntax", "message": str(exc), "traceback": None}
        compiled = None

    if compiled is not None:
        prev = sys.stdout
        sys.stdout = stdout
        try:
            _exec_units(namespace, spec["facade"], compiled)
            if entry == "script":
                if "result" in namespace:
                    value = namespace["result"]
                    have_value = True
            else:
                fn = namespace.get(entry)
                if fn is None or not callable(fn):
                    raise NameError("entry function " + repr(entry) + " is not defined")
                els = [namespace["dr"].element(i) for i in spec["element_ids"]]
                if entry == "value" and _wants_inputs(fn):
                    value = fn(els, _bind_inputs(namespace, spec.get("inputs")))
                else:
                    value = fn(els if entry == "value" else (els[0] if els else None))
                have_value = True
        except MemoryError:
            # Propagate to the top level: a store memory-limiter breach
            # surfaces as a nonzero WASI exit, which the host maps to a
            # memory error. Catching it here would mislabel a resource breach
            # as a runtime error.
            raise
        except BaseException:
            error = _runtime_error()
        finally:
            sys.stdout = prev

    result_repr = None
    truncated = stdout.truncated
    if error is None and have_value:
        result_repr = repr(value)
        if len(result_repr) > result_repr_cap:
            result_repr = result_repr[:result_repr_cap] + "..."
            truncated = True

    out = {"stdout": stdout.getvalue(), "result_repr": result_repr, "truncated": truncated}
    if error is not None:
        out["error"] = error
    return out


def _dr_open(facade, code, limits):
    stdout = _CappedStdout(limits["stdout_bytes"])
    namespace = _new_namespace()
    error = None
    try:
        compiled = compile(code, _SNIPPET_FILENAME, "exec")
    except SyntaxError as exc:
        error = {"kind": "syntax", "message": str(exc), "traceback": None}
        compiled = None
    if compiled is not None:
        prev = sys.stdout
        sys.stdout = stdout
        try:
            _exec_units(namespace, facade, compiled)
        except MemoryError:
            raise
        except BaseException:
            error = _runtime_error()
        finally:
            sys.stdout = prev
    # Module-level prints belong to no call; the first call carries them.
    return {"namespace": namespace, "carry": stdout.getvalue(), "error": error}


def _dr_call(session, call, limits):
    stdout = _CappedStdout(limits["stdout_bytes"])
    error = None
    payload = None
    reads = None
    prev = sys.stdout
    sys.stdout = stdout
    try:
        res = session["namespace"]["_dr_call_entry"](
            call["entry"],
            call["element_ids"],
            call.get("elements"),
            call.get("doc"),
            call.get("inputs"),
        )
        payload = res["payload"]
        reads = res["reads"]
    except MemoryError:
        raise
    except BaseException:
        error = _runtime_error()
    finally:
        sys.stdout = prev
    out = session["carry"] + stdout.getvalue()
    session["carry"] = ""
    return {"payload": payload, "error": error, "reads": reads, "stdout": out}
"""
