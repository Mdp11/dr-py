# Code Execution — M2+M3 Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the server side of `ScriptColumn` (table columns computed by a snippet's `value(elements)`) and `ScriptStep` (navigation steps computed by `step(el)`), on one shared mechanism: an evaluation **session** on the `ScriptRunner` protocol (one warm guest instance per evaluation, repeated entry-point calls over the bridge).

**Architecture:** Per spec `docs/superpowers/specs/2026-07-19-code-execution-m2-m3-design.md`. `SnippetSession` (open → repeated `call` → close) extends the protocol in `core/script/runner.py`; `ScriptEvalContext` (new `core/script/embed.py`) owns lazy sessions keyed by code, a `(code, entry, element_ids)` memo, warnings, and budget/unavailable degradation. The table/nav core evaluators grow `script=` plumbing; routes wire the runner via the existing `Depends(get_runner)` seam and degrade to `ErrorCell`s / pruned-with-warning steps — never a failed request.

**Tech Stack:** Python 3.14 (toolchain targets 3.14 uniformly — modern typing fine), pixi, FastAPI, Pydantic 2, wasmtime-py (api layer only), CPython-WASI guest.

## Global Constraints

- **pixi only.** Core tests: `pixi run core-test`; single test: `pixi run -e core-dev pytest tests/path::name -v`; format/lint/typecheck all: `pixi run dr-tidy` (ruff + mypy + pyright must all pass). API tests need no DB service.
- **`core/` stays wasmtime-free.** New core modules (`embed.py`, schema/evaluator changes) import only `data_rover.core.*` + stdlib. Only `src/data_rover/api/script_runner.py` and `tests/` may import wasmtime.
- **`TrustedRunner` never ships** — stays in `tests/script/trusted_runner.py`.
- **Sessions are read-only by construction**: every session `BridgeDispatcher` is built with `record_ops=False`; a `dr` write raises `dr.ReadOnlyError` in the snippet and surfaces as that call's error, never a run abort.
- **Degraded, never failed**: runner `None`, no free concurrency slot, dangling snippet ref, per-call error, budget exhaustion — all render as `ErrorCell`s (tables) or pruned-chains-with-warning (navigations). The evaluate/export routes stay 200.
- **Cache-poisoning guard**: `TableOrderCache.put` is skipped when any script call errored (`ctx.errored`) or `session.model_rev` moved during evaluation.
- **Budget**: one `ScriptBudget` per top-level request (`snippet_eval_budget_s`, default 30 s, env `DATA_ROVER_SNIPPET_EVAL_BUDGET_S`); per-call deadline is `min(limits.wall_timeout_s, budget.remaining())`.
- **`entry_points` is advisory, never trusted at evaluation time** — the evaluator resolves the entry function at runtime; a missing `value`/`step` def is a per-call `NameError` → error cell / pruned chain.
- **Wire mapping** (guest serializes via the facade's `_dr_serialize_entry_result`, host validates via `decode_call_payload` — they must agree):
  - `value()` → `{"kind":"scalar","value"}` | `{"kind":"scalars","values"}` | `{"kind":"element","id"}` | `{"kind":"elements","ids"}`; anything else is a call error naming the four legal shapes.
  - `step()` → `{"ids":[...]}` (Elements or id strings accepted).
- Branch: all backend work on `feature/code-execution-m2-m3`, off `main` (which contains the merged multi-element `value(elements)` contract, `3cf94ff`).
- The dense-docstring house style is load-bearing — new invariants (session read-only stance, memo-by-code+ids, cache guard) get explanatory docstrings like their neighbors.

---

## File Structure

New files:

- `src/data_rover/core/script/embed.py` — `ScriptEvalContext` (sessions, memo, warnings, budget/unavailable degradation).
- `src/data_rover/api/snippet_concurrency.py` — `ConcurrencyGuard` (moved from `routes/snippets.py`) + `try_acquire_global`/`release_global` + `concurrency_guard` singleton.
- `src/data_rover/api/script_eval.py` — `open_script_context`/`close_script_context` route helpers.
- `tests/script/test_session.py` — session protocol + facade serializer + `ScriptEvalContext` tests.
- `tests/table/test_script_column.py` — core script-column tests (cells, chaining, rows, sorting).
- `tests/navigation/test_script_step.py` — core script-step tests.
- `tests/api/test_script_embedding_routes.py` — route tests with `TrustedRunner` injected.

Modified files:

- `src/data_rover/core/script/runner.py` — `ScriptBudget`, `CallResult`, `SnippetSession`, `ScriptRunner.open_session`, `decode_call_payload`, `"unavailable"` error kind.
- `src/data_rover/core/script/facade_src.py` — append `_dr_serialize_entry_result` to `FACADE_SOURCE`.
- `src/data_rover/core/script/schema.py` — `SnippetSource`.
- `src/data_rover/core/table/schema.py` — `ScriptColumn`, union + `_source_arity`.
- `src/data_rover/core/table/cells.py` — `ErrorCell`, `_script_cell`, `evaluate_cells(script=)`.
- `src/data_rover/core/table/evaluate.py` — `script=` plumbing (`resolve_source_elements`, `build_rows_ex`, `_collapse_has_value`, `_expand_values`, `_sort_value`, `order_rows`, `iter_export_rows`) + `table_has_script`.
- `src/data_rover/core/table/resolve.py` — rename to `resolve_table_refs`, snippet-ref inlining.
- `src/data_rover/core/navigation/schema.py` — `ScriptStep` + union.
- `src/data_rover/core/navigation/evaluate.py` — `_hop_script`, `ChainResult.warnings`, `script=` plumbing, step_types.
- `src/data_rover/core/navigation/resolve.py` — `snippet_fetch` support + `navigation_has_script`.
- `src/data_rover/api/script_runner.py` — guest bootstrap embedded loop + `_WasmSnippetSession` + `WasmScriptRunner.open_session`.
- `tests/script/trusted_runner.py` — `_TrustedSession` + `TrustedRunner.open_session`.
- `src/data_rover/api/routes/tables.py`, `src/data_rover/api/routes/artifacts.py` — runner wiring, warnings, cache guard, export budget/notice.
- `src/data_rover/api/routes/snippets.py` — import guard from `snippet_concurrency.py`.
- `src/data_rover/api/schemas.py` — `TableCellOut` `"error"` kind + `message`/`traceback`; `TablePageOut.warnings`; `ChainPageOut.warnings`.
- `src/data_rover/api/table_export.py` — `ErrorCell` text + `notice` row.
- `src/data_rover/api/settings.py` — `snippet_eval_budget_s`.
- `src/data_rover/core/script/README.md`, `CLAUDE.md` — docs.
- `tests/api/test_snippets_wasm.py` — integration-marked session tests.

---

## Task 1: Branch + session protocol layer (`core/script/runner.py`)

**Files:**
- Modify: `src/data_rover/core/script/runner.py`
- Test: `tests/script/test_session.py` (new)

**Interfaces — Produces (everything later tasks import from `data_rover.core.script.runner`):**

```python
@dataclass(frozen=True)
class ScriptBudget:
    deadline: float                      # absolute time.monotonic() deadline
    @classmethod
    def start(cls, seconds: float) -> "ScriptBudget": ...
    def remaining(self) -> float: ...    # max(0.0, deadline - now)
    @property
    def exhausted(self) -> bool: ...     # remaining() <= 0.0

@dataclass
class CallResult:
    value: dict | None                   # validated tagged wire payload; None on error
    error: ScriptError | None
    duration_ms: int

class SnippetSession(Protocol):
    boot_error: ScriptError | None       # set at open (module exec failed) OR later
                                         # when the session dies terminally
    def call(self, entry: Literal["value", "step"], element_ids: list[str]) -> CallResult: ...
    def close(self) -> None: ...         # idempotent

class ScriptRunner(Protocol):
    def run(...) -> RunResult: ...       # unchanged
    def open_session(self, model: Model, code: str, limits: RunLimits,
                     *, budget: ScriptBudget) -> SnippetSession: ...

def decode_call_payload(entry: str, payload: object) -> tuple[dict | None, str | None]: ...
```

`ScriptError.kind` Literal gains `"unavailable"` (runner missing / no concurrency slot).

- [ ] **Step 1: Branch**

```bash
git checkout -b feature/code-execution-m2-m3 main
```

- [ ] **Step 2: Write the failing tests**

Create `tests/script/test_session.py`:

```python
"""Session-protocol layer tests: ScriptBudget, decode_call_payload (host-side
validation of the untrusted guest's tagged call payloads)."""

from __future__ import annotations

import pytest

from data_rover.core.script.runner import ScriptBudget, decode_call_payload


def test_budget_remaining_and_exhausted() -> None:
    b = ScriptBudget.start(60)
    assert 0 < b.remaining() <= 60
    assert not b.exhausted
    spent = ScriptBudget(deadline=0.0)  # monotonic 0 is always in the past
    assert spent.remaining() == 0.0
    assert spent.exhausted


@pytest.mark.parametrize(
    "payload",
    [
        {"kind": "scalar", "value": 3},
        {"kind": "scalar", "value": None},
        {"kind": "scalars", "values": ["a", 1, None, True]},
        {"kind": "element", "id": "e1"},
        {"kind": "elements", "ids": ["e1", "e2"]},
    ],
)
def test_decode_value_payloads_accepted(payload: dict) -> None:
    decoded, msg = decode_call_payload("value", payload)
    assert msg is None
    assert decoded == payload


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {"kind": "scalar", "value": object},
        {"kind": "scalars", "values": [{"nested": 1}]},
        {"kind": "element", "id": 7},
        {"kind": "elements", "ids": ["e1", 2]},
        {"kind": "mystery"},
        {"ids": ["e1"]},  # step shape is not a value shape
    ],
)
def test_decode_value_payloads_rejected(payload: object) -> None:
    decoded, msg = decode_call_payload("value", payload)
    assert decoded is None
    assert msg is not None


def test_decode_step_payloads() -> None:
    decoded, msg = decode_call_payload("step", {"ids": ["a", "b"]})
    assert (decoded, msg) == ({"ids": ["a", "b"]}, None)
    for bad in (None, {"ids": "a"}, {"ids": [1]}, {"kind": "scalar", "value": 1}):
        decoded, msg = decode_call_payload("step", bad)
        assert decoded is None and msg is not None
```

Note `{"kind": "scalar", "value": object}` passes the *class* `object` — a
non-scalar Python value — to exercise the type gate.

- [ ] **Step 3: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_session.py -v`
Expected: FAIL — `ImportError: cannot import name 'ScriptBudget'`.

- [ ] **Step 4: Implement in `core/script/runner.py`**

Add `import time` and, after `RunLimits`:

```python
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
```

Extend `ScriptError.kind`'s Literal with `"unavailable"` and document it in the
docstring table: *"the script runner is not available (no runner constructed,
or no concurrency slot free) — embedded evaluation degrades, never 5xxs"*.

Add after `RunResult`:

```python
@dataclass
class CallResult:
    """Outcome of one :meth:`SnippetSession.call`.

    ``value`` is the already-validated tagged wire payload (see
    :func:`decode_call_payload`), never a repr string; ``None`` iff ``error``
    is set.
    """

    value: dict | None
    error: ScriptError | None
    duration_ms: int


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
```

Add `open_session` to the `ScriptRunner` protocol body:

```python
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
```

Add module-level:

```python
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
```

- [ ] **Step 5: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/script/test_session.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/script/runner.py tests/script/test_session.py
git commit -m "feat(snippets): session protocol layer — ScriptBudget, CallResult, SnippetSession, decode_call_payload"
```

---

## Task 2: Facade result serializer (`facade_src.py`)

**Files:**
- Modify: `src/data_rover/core/script/facade_src.py`
- Test: `tests/script/test_session.py` (extend)

**Interfaces:**
- Produces: exec'ing `FACADE_SOURCE` defines a top-level `_dr_serialize_entry_result(entry, value)` in the namespace (alongside `dr`, `Element`) that maps an entry-point return value to the tagged wire payload or raises `ValueError`. Both runners call it via `namespace["_dr_serialize_entry_result"]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/script/test_session.py` (build a tiny model with the existing helpers used in `tests/script/` — check `tests/script/test_trusted_runner.py`'s fixtures for the model-building pattern and reuse it):

```python
from data_rover.core.script.bridge import BridgeDispatcher
from data_rover.core.script.facade_src import FACADE_SOURCE


def _facade_ns(model) -> dict:
    dispatcher = BridgeDispatcher(
        model, record_ops=False, max_ops=10, max_op_bytes=1024, page_limit=500
    )
    ns: dict = {"_transport": dispatcher.dispatch}
    exec(FACADE_SOURCE, ns)
    return ns


def test_serialize_value_shapes(small_model) -> None:
    ns = _facade_ns(small_model)
    ser = ns["_dr_serialize_entry_result"]
    el = ns["dr"].element(next(iter(small_model.elements)))
    assert ser("value", 3) == {"kind": "scalar", "value": 3}
    assert ser("value", None) == {"kind": "scalar", "value": None}
    assert ser("value", ["a", 1, None]) == {"kind": "scalars", "values": ["a", 1, None]}
    assert ser("value", el) == {"kind": "element", "id": el.id}
    assert ser("value", [el, el]) == {"kind": "elements", "ids": [el.id, el.id]}
    with pytest.raises(ValueError):
        ser("value", {"a": 1})
    with pytest.raises(ValueError):
        ser("value", [el, 1])  # mixed Element/scalar list


def test_serialize_step_shapes(small_model) -> None:
    ns = _facade_ns(small_model)
    ser = ns["_dr_serialize_entry_result"]
    el = ns["dr"].element(next(iter(small_model.elements)))
    assert ser("step", [el, "raw-id"]) == {"ids": [el.id, "raw-id"]}
    assert ser("step", None) == {"ids": []}
    with pytest.raises(ValueError):
        ser("step", 42)
    with pytest.raises(ValueError):
        ser("step", [1])
```

If `tests/script/` has no reusable `small_model` fixture, add one to
`tests/script/conftest.py` following the model-construction pattern already
used by `tests/script/test_bridge.py` (metamodel + `Model` with 2–3 elements).

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_session.py -k serialize -v`
Expected: FAIL — `KeyError: '_dr_serialize_entry_result'`.

- [ ] **Step 3: Implement**

Append to `FACADE_SOURCE` in `facade_src.py` (inside the string, after `dr = _Dr()`):

```python
_WIRE_SCALARS = (str, int, float, bool)


def _dr_serialize_entry_result(entry, value):
    # Session wire serializer for embedded entry-point calls (M2/M3): maps a
    # value()/step() return value to the tagged payload the host validates
    # with runner.decode_call_payload. Unsupported shapes raise ValueError;
    # the session loop reports that as the call's error. NOT part of the
    # documented dr API (underscored on purpose).
    if entry == "step":
        if value is None:
            return {"ids": []}
        try:
            items = list(value)
        except TypeError:
            raise ValueError(
                "step() must return an iterable of Elements or element ids"
            )
        ids = []
        for item in items:
            if isinstance(item, Element):
                ids.append(item.id)
            elif isinstance(item, str):
                ids.append(item)
            else:
                raise ValueError(
                    "step() must return an iterable of Elements or element ids"
                )
        return {"ids": ids}
    if isinstance(value, Element):
        return {"kind": "element", "id": value.id}
    if value is None or isinstance(value, _WIRE_SCALARS):
        return {"kind": "scalar", "value": value}
    if isinstance(value, (list, tuple)):
        items = list(value)
        if items and all(isinstance(v, Element) for v in items):
            return {"kind": "elements", "ids": [v.id for v in items]}
        if all(v is None or isinstance(v, _WIRE_SCALARS) for v in items):
            return {"kind": "scalars", "values": items}
    raise ValueError(
        "value() must return a scalar, a list of scalars, an Element, "
        "or a list of Elements"
    )
```

(Note the empty list falls through to `scalars` — `{"kind":"scalars","values":[]}`
— an empty cell, which is the right reading of "no values".)

- [ ] **Step 4: Run tests, then commit**

Run: `pixi run -e core-dev pytest tests/script/test_session.py -v` → PASS.

```bash
git add src/data_rover/core/script/facade_src.py tests/script/test_session.py tests/script/conftest.py
git commit -m "feat(snippets): facade-side session wire serializer"
```

---

## Task 3: `TrustedRunner.open_session`

**Files:**
- Modify: `tests/script/trusted_runner.py`
- Test: `tests/script/test_session.py` (extend)

**Interfaces:**
- Produces: `TrustedRunner.open_session(model, code, limits, *, budget) -> SnippetSession` — in-process sessions with the exact semantics later tasks rely on: `boot_error` on syntax/module-exec failure; per-call `NameError` when the entry fn is missing; `dr` writes → per-call runtime error (`record_ops=False`); results decoded through `decode_call_payload` (parity with the WASM path).

- [ ] **Step 1: Write the failing tests**

Append to `tests/script/test_session.py`:

```python
from data_rover.core.script.runner import RunLimits
from tests.script.trusted_runner import TrustedRunner


def _open(model, code: str):
    return TrustedRunner().open_session(
        model, code, RunLimits(), budget=ScriptBudget.start(30)
    )


def test_session_repeated_calls_share_module_state(small_model) -> None:
    ids = sorted(small_model.elements)
    sess = _open(small_model, "calls = []\ndef value(els):\n    calls.append(1)\n    return len(calls)")
    assert sess.boot_error is None
    r1 = sess.call("value", [ids[0]])
    r2 = sess.call("value", [ids[0]])
    assert r1.value == {"kind": "scalar", "value": 1}
    assert r2.value == {"kind": "scalar", "value": 2}  # module globals persist
    sess.close()


def test_session_boot_error_on_syntax_and_module_exec(small_model) -> None:
    assert _open(small_model, "def broken(:").boot_error.kind == "syntax"
    assert _open(small_model, "raise RuntimeError('boom')").boot_error.kind == "runtime"


def test_session_per_call_errors(small_model) -> None:
    ids = sorted(small_model.elements)
    sess = _open(small_model, "def value(els):\n    return {'not': 'legal'}")
    res = sess.call("value", [ids[0]])
    assert res.error is not None and "value() must return" in res.error.message
    missing = _open(small_model, "x = 1")
    res = missing.call("value", [ids[0]])
    assert res.error is not None and "not defined" in res.error.message


def test_session_is_read_only(small_model) -> None:
    ids = sorted(small_model.elements)
    sess = _open(small_model, "def value(els):\n    return dr.create('T', {})")
    res = sess.call("value", [ids[0]])
    assert res.error is not None and "ReadOnlyError" in res.error.message


def test_session_step_entry(small_model) -> None:
    ids = sorted(small_model.elements)
    sess = _open(small_model, f"def step(el):\n    return ['{ids[0]}']")
    res = sess.call("step", [ids[0]])
    assert res.value == {"ids": [ids[0]]}
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_session.py -k session -v`
Expected: FAIL — `AttributeError: 'TrustedRunner' object has no attribute 'open_session'`.

- [ ] **Step 3: Implement**

Add to `tests/script/trusted_runner.py` (imports: extend the existing
`from data_rover.core.script.runner import ...` with `CallResult, ScriptBudget,
decode_call_payload`):

```python
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
```

And on `TrustedRunner`:

```python
    def open_session(
        self,
        model: Model,
        code: str,
        limits: RunLimits,
        *,
        budget: ScriptBudget,
    ) -> _TrustedSession:
        del budget  # protocol parity only — see _TrustedSession docstring
        return _TrustedSession(model, code, limits)
```

- [ ] **Step 4: Run tests, then commit**

Run: `pixi run -e core-dev pytest tests/script/ -v` → PASS (all, including M1's).

```bash
git add tests/script/trusted_runner.py tests/script/test_session.py
git commit -m "feat(snippets): TrustedRunner evaluation sessions"
```

---

## Task 4: `ScriptEvalContext` (`core/script/embed.py`)

**Files:**
- Create: `src/data_rover/core/script/embed.py`
- Test: `tests/script/test_session.py` (extend)

**Interfaces:**
- Produces:

```python
class ScriptEvalContext:
    warnings: list[str]          # deduped, capped at MAX_SCRIPT_WARNINGS (20)
    errored: bool                # any call error / budget exhaustion / unavailability
    budget: ScriptBudget
    def __init__(self, runner: ScriptRunner | None, model: Model | None,
                 limits: RunLimits, budget: ScriptBudget,
                 *, unavailable_reason: str | None = None) -> None: ...
    def call(self, code: str, entry: Literal["value", "step"],
             element_ids: list[str]) -> CallResult: ...   # memoized
    def add_warning(self, message: str) -> None: ...
    def close(self) -> None: ...
```

- Consumes: Task 1's protocol types; sessions from any `ScriptRunner`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/script/test_session.py`:

```python
from data_rover.core.script.embed import ScriptEvalContext


def _ctx(model, **kw) -> ScriptEvalContext:
    return ScriptEvalContext(
        TrustedRunner(), model, RunLimits(), ScriptBudget.start(30), **kw
    )


def test_ctx_memoizes_by_code_entry_ids(small_model) -> None:
    ids = sorted(small_model.elements)
    ctx = _ctx(small_model)
    code = "calls = []\ndef value(els):\n    calls.append(1)\n    return len(calls)"
    r1 = ctx.call(code, "value", [ids[0]])
    r2 = ctx.call(code, "value", [ids[0]])       # memo hit — NOT a second call
    r3 = ctx.call(code, "value", [ids[1]])       # different ids — a real call
    assert r1.value == {"kind": "scalar", "value": 1}
    assert r2.value == {"kind": "scalar", "value": 1}
    assert r3.value == {"kind": "scalar", "value": 2}
    ctx.close()


def test_ctx_unavailable_and_budget(small_model) -> None:
    ids = sorted(small_model.elements)
    ctx = ScriptEvalContext(
        None, None, RunLimits(), ScriptBudget.start(30),
        unavailable_reason="script runner unavailable",
    )
    res = ctx.call("def value(els): return 1", "value", [ids[0]])
    assert res.error is not None and res.error.kind == "unavailable"
    assert ctx.errored

    spent = ScriptEvalContext(
        TrustedRunner(), small_model, RunLimits(), ScriptBudget(deadline=0.0)
    )
    res = spent.call("def value(els): return 1", "value", [ids[0]])
    assert res.error is not None and res.error.kind == "timeout"
    assert "budget" in res.error.message


def test_ctx_boot_error_and_warnings(small_model) -> None:
    ids = sorted(small_model.elements)
    ctx = _ctx(small_model)
    res = ctx.call("raise RuntimeError('boom')", "value", [ids[0]])
    assert res.error is not None and ctx.errored
    ctx.add_warning("w")
    ctx.add_warning("w")  # deduped
    for i in range(30):
        ctx.add_warning(f"w{i}")
    assert ctx.warnings[0] == "w"
    assert len(ctx.warnings) == 20  # capped
    ctx.close()
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_session.py -k ctx -v`
Expected: FAIL — no module `data_rover.core.script.embed`.

- [ ] **Step 3: Implement `src/data_rover/core/script/embed.py`**

```python
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
```

- [ ] **Step 4: Run tests, tidy, commit**

Run: `pixi run -e core-dev pytest tests/script/ -v` → PASS. Run `pixi run dr-tidy` → clean.

```bash
git add src/data_rover/core/script/embed.py tests/script/test_session.py
git commit -m "feat(snippets): ScriptEvalContext — sessions, memo, warnings, budget degradation"
```

---

## Task 5: Schemas — `SnippetSource`, `ScriptColumn`, `ScriptStep`, `ErrorCell`

**Files:**
- Modify: `src/data_rover/core/script/schema.py`, `src/data_rover/core/table/schema.py`, `src/data_rover/core/navigation/schema.py`, `src/data_rover/core/table/cells.py`
- Test: `tests/table/test_script_column.py` (new), `tests/navigation/test_script_step.py` (new)

**Interfaces — Produces:**

```python
# core/script/schema.py
class SnippetSource(BaseModel):
    ref: str | None = None
    definition: SnippetDefinition | None = None
    # at-most-one validator; {} legal-unconfigured; .is_empty property

# core/table/schema.py
class ScriptColumn(BaseModel):
    kind: Literal["script"] = "script"
    source: ColumnSource = Field(default_factory=RowSlot)
    snippet: SnippetSource = Field(default_factory=SnippetSource)
    mode: Literal["collapse", "expand"] = "collapse"
    keep_empty: bool = True
    header: str = ""
    width_px: int | None = None
    hidden: bool = False
# Column union gains ScriptColumn; _source_arity: script → (True, mode == "expand")

# core/navigation/schema.py
class ScriptStep(BaseModel):
    kind: Literal["script"] = "script"
    snippet: SnippetSource = Field(default_factory=SnippetSource)
    comment: str | None = None
# StepItem union gains ScriptStep

# core/table/cells.py
@dataclass
class ErrorCell:
    message: str
    traceback: str | None = None
# Cell union gains ErrorCell
```

- [ ] **Step 1: Write the failing tests**

Create `tests/table/test_script_column.py`:

```python
"""ScriptColumn schema + evaluation tests. Model/metamodel fixtures follow
tests/table/test_evaluate.py's construction pattern — reuse its helpers."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from data_rover.core.script.schema import SnippetDefinition, SnippetSource
from data_rover.core.table.schema import (
    TABLE_ADAPTER,
    ColumnRef,
    ScriptColumn,
    ScopeRows,
    TableDefinition,
)


def _snip(code: str) -> SnippetSource:
    return SnippetSource(definition=SnippetDefinition(code=code))


def test_script_column_parses_ref_inline_and_empty() -> None:
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": []},
            "columns": [
                {"kind": "script", "snippet": {}},                       # unconfigured
                {"kind": "script", "snippet": {"ref": "a1"}},            # ref
                {"kind": "script", "snippet": {"definition": {"code": "x=1"}}},
            ],
        }
    )
    assert [c.kind for c in defn.columns] == ["script"] * 3
    assert defn.columns[0].snippet.is_empty
    with pytest.raises(ValidationError):
        SnippetSource(ref="a1", definition=SnippetDefinition(code="x=1"))


def test_script_column_is_chainable_but_not_step_indexable() -> None:
    # a ColumnRef against a script column is legal (element-capable at runtime)
    TableDefinition(
        row_source=ScopeRows(types=[]),
        columns=[
            ScriptColumn(snippet=_snip("def value(els): return els")),
            ScriptColumn(source=ColumnRef(index=0), snippet=_snip("def value(els): return 1")),
        ],
    )
    # step_index refs still require a NAVIGATION column
    with pytest.raises(ValidationError, match="navigation column"):
        TableDefinition(
            row_source=ScopeRows(types=[]),
            columns=[
                ScriptColumn(snippet=_snip("def value(els): return els")),
                ScriptColumn(
                    source=ColumnRef(index=0, step_index=1),
                    snippet=_snip("def value(els): return 1"),
                ),
            ],
        )
```

Create `tests/navigation/test_script_step.py`:

```python
"""ScriptStep schema + evaluation tests. Fixtures follow
tests/navigation/test_evaluate.py's construction pattern."""

from __future__ import annotations

from data_rover.core.navigation.schema import (
    NAVIGATION_ADAPTER,
    PathNavigation,
    ScriptStep,
)
from data_rover.core.script.schema import SnippetDefinition, SnippetSource


def test_script_step_parses() -> None:
    defn = NAVIGATION_ADAPTER.validate_python(
        {
            "kind": "path",
            "start": {"kind": "scope", "types": []},
            "steps": [
                {"kind": "script", "snippet": {"definition": {"code": "def step(el): return []"}}},
                {"kind": "script", "snippet": {}, "comment": "note"},
            ],
        }
    )
    assert isinstance(defn, PathNavigation)
    assert all(isinstance(s, ScriptStep) for s in defn.steps)
    assert defn.steps[1].snippet.is_empty
```

And a cells-union case in `tests/table/test_script_column.py`:

```python
from data_rover.core.table.cells import ErrorCell


def test_error_cell_shape() -> None:
    c = ErrorCell(message="boom")
    assert c.traceback is None
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_script_column.py tests/navigation/test_script_step.py -v`
Expected: FAIL — `ImportError` (`SnippetSource`, `ScriptColumn`, `ScriptStep`, `ErrorCell`).

- [ ] **Step 3: Implement**

1. `core/script/schema.py` — add (imports: `model_validator`):

```python
class SnippetSource(BaseModel):
    """At most one of `ref` (saved snippet artifact id) / `definition`
    (inline). NEITHER set (`{}`) is a legal, UNCONFIGURED source — the column/
    step editors create the item before the user picks its snippet, and
    evaluation treats it as producing nothing. Same tolerant stance (and same
    shape) as `core.table.schema.NavigationSource`. BOTH set is rejected:
    ambiguous, not incomplete."""

    ref: str | None = None
    definition: SnippetDefinition | None = None

    @model_validator(mode="after")
    def _at_most_one(self) -> SnippetSource:
        if self.ref is not None and self.definition is not None:
            raise ValueError("provide at most one of `ref` / `definition`")
        return self

    @property
    def is_empty(self) -> bool:
        """True for the unconfigured (`{}`) source."""
        return self.ref is None and self.definition is None
```

2. `core/table/schema.py` — import `SnippetSource` from
`data_rover.core.script.schema`; add `ScriptColumn` (fields as in Interfaces,
with the same `hidden` docstring comment its siblings carry); extend the union:

```python
Column = Annotated[
    ElementColumn | PropertyColumn | NavigationColumn | ScriptColumn,
    Field(discriminator="kind"),
]
```

In `_source_arity`, before the final `return False, ...` property-column line:

```python
        if ref.kind == "script":
            # Element-capable at RUNTIME: value() may return Element(s); a
            # scalar result simply binds nothing downstream (tolerant — the
            # return type is not statically knowable). Like a navigation
            # column, collapse is multi-binding, expand promotes one binding
            # per row.
            return True, ref.mode == "expand"
```

(No change needed to `_validate_sources` beyond what the union brings: the
`step_index`-requires-navigation check already rejects script columns, and a
script column is never `kind == "element"`/`"property"` for those arms.)

3. `core/navigation/schema.py` — import `SnippetSource` from
`data_rover.core.script.schema`; add `ScriptStep`:

```python
class ScriptStep(BaseModel):
    """A hop computed by a snippet's `step(el)` entry point: consumes the
    frontier one element at a time, produces the next frontier from the ids
    the snippet returns (unknown ids dropped with a warning; `exclude_visited`
    applies). Adds ONE chain column, like RelationshipStep — its `step_types`
    entry is `comment or "script"`. Per-element failures PRUNE that chain with
    a warning (never abort), mirroring PropertyStep's graceful stance."""

    kind: Literal["script"] = "script"
    snippet: SnippetSource = Field(default_factory=SnippetSource)
    #: free-form user note; doubles as the chain-column label.
    comment: str | None = None
```

Extend the union and rebuild list:

```python
StepItem = Annotated[
    RelationshipStep | FilterStep | PropertyStep | ScriptStep,
    Field(discriminator="kind"),
]
```

(add `ScriptStep.model_rebuild()` next to the existing rebuild calls).

4. `core/table/cells.py` — add after `ElementsCell`:

```python
@dataclass
class ErrorCell:
    """A script cell that failed (snippet raised, timed out, budget spent,
    runner unavailable, dangling ref). `message` is short; `traceback` (guest
    frames only) rides along for hover detail. Sorts with empties (last)."""

    message: str
    traceback: str | None = None


Cell = ElementCell | ValueCell | ValuesCell | ElementsCell | ErrorCell
```

- [ ] **Step 4: Run tests, tidy, commit**

Run: `pixi run -e core-dev pytest tests/table/ tests/navigation/ tests/script/ -v` → PASS
(existing suites confirm no regression from the union changes).
Run `pixi run dr-tidy` → clean (pyright will flag any `Cell` consumer that
doesn't handle `ErrorCell` yet only if match-exhaustiveness is asserted —
`_cell_out`/`_cell_text` use isinstance-chains ending in `assert`, which Task 11/12 update; if pyright complains now, update those two functions' final
`assert isinstance(...)` to include `ErrorCell` handling as specified in Tasks 11/12 early).

```bash
git add src/data_rover/core/script/schema.py src/data_rover/core/table/schema.py src/data_rover/core/navigation/schema.py src/data_rover/core/table/cells.py tests/table/test_script_column.py tests/navigation/test_script_step.py
git commit -m "feat(snippets): SnippetSource + ScriptColumn + ScriptStep + ErrorCell schemas"
```

---

## Task 6: Ref resolution — snippet inlining for tables and navigations

**Files:**
- Modify: `src/data_rover/core/navigation/resolve.py`, `src/data_rover/core/table/resolve.py`
- Test: `tests/table/test_script_column.py`, `tests/navigation/test_script_step.py` (extend)

**Interfaces:**
- Produces:
  - `core/navigation/resolve.py`: `SnippetFetch = Callable[[str], SnippetDefinition]`; `resolve_refs(defn, fetch, _seen=frozenset(), *, snippet_fetch: SnippetFetch | None = None)` — inlines `ScriptStep.snippet.ref`s; a `LookupError` from `snippet_fetch` leaves the ref in place (**dangling marker** — evaluation prunes with a warning, it does NOT 422); `navigation_has_script(defn) -> bool`.
  - `core/table/resolve.py`: `_resolve_table_navigation_refs` renamed **`resolve_table_refs(defn, fetch, snippet_fetch=None)`** — additionally inlines every `ScriptColumn.snippet.ref` (dangling ref stays in place → error cells) and passes `snippet_fetch` through navigation resolution; `table_has_script(defn) -> bool` (true when any `ScriptColumn` has a non-empty snippet, or any embedded/resolved navigation `navigation_has_script`).
- Consumes: Task 5 schemas.

- [ ] **Step 1: Write the failing tests**

Append to `tests/navigation/test_script_step.py`:

```python
from data_rover.core.navigation.resolve import navigation_has_script, resolve_refs
from data_rover.core.navigation.schema import Scope


def _path(steps) -> PathNavigation:
    return PathNavigation(kind="path", start=Scope(types=[]), steps=steps)


def test_resolve_inlines_script_step_refs_and_keeps_dangling() -> None:
    defn = _path([ScriptStep(snippet=SnippetSource(ref="s1")),
                  ScriptStep(snippet=SnippetSource(ref="missing"))])

    def snippet_fetch(aid: str) -> SnippetDefinition:
        if aid == "s1":
            return SnippetDefinition(code="def step(el): return []")
        raise LookupError(aid)

    def nav_fetch(aid: str):
        raise LookupError(aid)

    out = resolve_refs(defn, nav_fetch, snippet_fetch=snippet_fetch)
    assert out.steps[0].snippet.definition is not None      # inlined
    assert out.steps[0].snippet.ref is None
    assert out.steps[1].snippet.ref == "missing"            # dangling marker kept
    assert defn.steps[0].snippet.ref == "s1"                # input not mutated


def test_navigation_has_script() -> None:
    assert not navigation_has_script(_path([]))
    assert navigation_has_script(
        _path([ScriptStep(snippet=SnippetSource(ref="s1"))])
    )
```

Append to `tests/table/test_script_column.py`:

```python
from data_rover.core.table.resolve import resolve_table_refs, table_has_script


def test_resolve_table_inlines_script_column_refs() -> None:
    defn = TableDefinition(
        row_source=ScopeRows(types=[]),
        columns=[ScriptColumn(snippet=SnippetSource(ref="s1")),
                 ScriptColumn(snippet=SnippetSource(ref="missing"))],
    )

    def snippet_fetch(aid: str) -> SnippetDefinition:
        if aid == "s1":
            return SnippetDefinition(code="def value(els): return 1")
        raise LookupError(aid)

    def nav_fetch(aid: str):
        raise LookupError(aid)

    out = resolve_table_refs(defn, nav_fetch, snippet_fetch=snippet_fetch)
    assert out.columns[0].snippet.definition is not None
    assert out.columns[1].snippet.ref == "missing"
    assert table_has_script(out)
    assert not table_has_script(
        TableDefinition(row_source=ScopeRows(types=[]),
                        columns=[ScriptColumn(snippet=SnippetSource())])
    )
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_script_column.py tests/navigation/test_script_step.py -v`
Expected: FAIL — `ImportError` (`resolve_table_refs`, `navigation_has_script`).

- [ ] **Step 3: Implement `core/navigation/resolve.py`**

Add imports (`ScriptStep`, `SnippetDefinition`, `SnippetSource`,
`StepItem` as needed) and:

```python
SnippetFetch = Callable[[str], "SnippetDefinition"]


def _resolve_script_step(step: StepItem, snippet_fetch: SnippetFetch | None) -> StepItem:
    """Inline a ScriptStep's snippet ref. A LookupError leaves the ref in
    place as a DANGLING MARKER — evaluation prunes that step with a warning
    instead of the request 422ing (degraded-content stance; unlike navigation
    refs, whose absence makes the whole definition unevaluable)."""
    if not isinstance(step, ScriptStep) or step.snippet.ref is None or snippet_fetch is None:
        return step
    try:
        sd = snippet_fetch(step.snippet.ref)
    except LookupError:
        return step
    return step.model_copy(update={"snippet": SnippetSource(definition=sd)})
```

Change `resolve_refs` to accept and thread `snippet_fetch`:

```python
def resolve_refs(
    defn: NavigationDefinition,
    fetch: Fetch,
    _seen: frozenset[str] = frozenset(),
    *,
    snippet_fetch: SnippetFetch | None = None,
) -> NavigationDefinition:
    if isinstance(defn, PathNavigation):
        steps = [_resolve_script_step(s, snippet_fetch) for s in defn.steps]
        if isinstance(defn.start, (Scope, RowStart)):
            return defn.model_copy(update={"steps": steps})
        return defn.model_copy(
            update={
                "start": _resolve_expr(defn.start, fetch, _seen, snippet_fetch),
                "steps": steps,
            }
        )
    return _resolve_expr(defn, fetch, _seen, snippet_fetch)
```

`_resolve_expr` gains the fourth parameter and passes it into both of its
`resolve_refs` recursions (signature: `_resolve_expr(expr, fetch, seen, snippet_fetch)`).

Add:

```python
def navigation_has_script(defn: NavigationDefinition) -> bool:
    """True when evaluating `defn` may invoke a snippet (a ScriptStep with a
    non-empty snippet anywhere in the tree) — the route layer's cue to open a
    ScriptEvalContext and take a concurrency slot."""
    if isinstance(defn, PathNavigation):
        if any(
            isinstance(s, ScriptStep) and not s.snippet.is_empty for s in defn.steps
        ):
            return True
        if isinstance(defn.start, SetExpression):
            return _set_has_script(defn.start)
        return False
    return _set_has_script(defn)


def _set_has_script(expr: SetExpression) -> bool:
    return any(
        op.definition is not None and navigation_has_script(op.definition)
        for op in expr.operands
    )
```

- [ ] **Step 4: Implement `core/table/resolve.py`**

Rename `_resolve_table_navigation_refs` → `resolve_table_refs`, add the
`snippet_fetch` parameter, pass it into `_resolve_source` →
`resolve_refs(base_def, fetch, snippet_fetch=snippet_fetch)`, and extend the
column comprehension:

```python
def _resolve_snippet_source(
    ss: SnippetSource, snippet_fetch: SnippetFetch | None
) -> SnippetSource:
    """Inline a ScriptColumn's snippet ref; a LookupError leaves the ref in
    place (dangling marker → error cells, not a 422)."""
    if ss.ref is None or snippet_fetch is None:
        return ss
    try:
        sd = snippet_fetch(ss.ref)
    except LookupError:
        return ss
    return SnippetSource(definition=sd)


def resolve_table_refs(
    defn: TableDefinition, fetch: Fetch, snippet_fetch: SnippetFetch | None = None
) -> TableDefinition:
    ...  # existing body; columns comprehension becomes:
    columns = [
        col.model_copy(
            update={"navigation": _resolve_source(col.navigation, fetch, snippet_fetch)}
        )
        if isinstance(col, NavigationColumn)
        else col.model_copy(
            update={"snippet": _resolve_snippet_source(col.snippet, snippet_fetch)}
        )
        if isinstance(col, ScriptColumn)
        else col
        for col in defn.columns
    ]
```

Add:

```python
def table_has_script(defn: TableDefinition) -> bool:
    """True when evaluating `defn` may invoke a snippet: a ScriptColumn with a
    non-empty snippet, or any embedded navigation containing a ScriptStep."""
    for col in defn.columns:
        if isinstance(col, ScriptColumn) and not col.snippet.is_empty:
            return True
    navs: list[NavigationDefinition] = []
    rs = defn.row_source
    if isinstance(rs, (NavigationRows, ChainRows)) and rs.navigation.definition is not None:
        navs.append(rs.navigation.definition)
    navs.extend(
        col.navigation.definition
        for col in defn.columns
        if isinstance(col, NavigationColumn) and col.navigation.definition is not None
    )
    return any(navigation_has_script(nd) for nd in navs)
```

Update the two call sites of the old name (`routes/tables.py:79`
`_resolve_table` — keep behavior identical for now; snippet_fetch is wired in
Task 11) and any test imports.

- [ ] **Step 5: Run tests, tidy, commit**

Run: `pixi run core-test` → PASS. `pixi run dr-tidy` → clean.

```bash
git add src/data_rover/core/navigation/resolve.py src/data_rover/core/table/resolve.py src/data_rover/api/routes/tables.py tests/
git commit -m "feat(snippets): snippet-ref inlining + has-script detection in resolve passes"
```

---

## Task 7: Table evaluation — script cells, chaining, row building

**Files:**
- Modify: `src/data_rover/core/table/evaluate.py`, `src/data_rover/core/table/cells.py`
- Test: `tests/table/test_script_column.py` (extend)

**Interfaces:**
- Produces (all with a new trailing keyword `script: ScriptEvalContext | None = None`, `TYPE_CHECKING`-imported from `data_rover.core.script.embed`):
  - `resolve_source_elements(..., script=None)` — new `ref_col.kind == "script"` collapse branch (call → element ids; scalars bind nothing). The existing generic expand-slot read already covers script expand columns.
  - `evaluate_cells(mm, model, defn, keys, limits=TableLimits(), script=None)` — dispatches `ScriptColumn` → `_script_cell`.
  - `build_rows_ex(..., script=None)` / `build_rows(..., script=None)` — script branches in `_collapse_has_value` and `_expand_values`.
  - `iter_export_rows(..., script=None)` — passthrough.
- Semantics locked here:
  - Collapse cell mapping: dangling ref → `ErrorCell("snippet artifact '<id>' not found")`; unconfigured/empty binding → `ValueCell(present=False, ...)`; call error → `ErrorCell(message, traceback)`; `scalar` None → empty `ValueCell`; `scalar` → `ValueCell(present=True, editable=False)`; `scalars` → `ValuesCell` capped at `limits.max_cell_elements`; `element`/`elements` → `ElementCell`/`ElementsCell` (unknown ids dropped; elements capped at `max_cell_elements`).
  - Expand promotion: element ids promote as `str`; scalars promote wrapped in `PropertyValue` (so a scalar string can never be mistaken for an element id — the existing `Binding` invariant); `None` scalars are skipped; a call **error promotes the single binding `None`** so exactly one row survives regardless of `keep_empty`, and the cell layer re-derives the error from the memoized call.
  - `keep_empty=False` collapse filtering: an ERRORED cell counts as having a value (the row must stay visible to show the error); a dangling ref likewise.

- [ ] **Step 1: Write the failing tests**

Append to `tests/table/test_script_column.py`. Use the same
metamodel/model fixture style as `tests/table/test_evaluate.py` (a small scope
of typed elements). The tests below assume a fixture `tmm, tmodel` with ≥3
elements of type `"Thing"` each carrying a `name` property; adapt names to the
existing fixture:

```python
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import RunLimits, ScriptBudget
from data_rover.core.table.cells import ErrorCell, evaluate_cells
from data_rover.core.table.evaluate import TableLimits, build_rows_ex
from tests.script.trusted_runner import TrustedRunner


def _script_ctx(model) -> ScriptEvalContext:
    return ScriptEvalContext(TrustedRunner(), model, RunLimits(), ScriptBudget.start(30))


def _one_col_table(code: str, **col_kw) -> TableDefinition:
    return TableDefinition(
        row_source=ScopeRows(types=["Thing"]),
        columns=[ScriptColumn(snippet=_snip(code), **col_kw)],
    )


def test_script_cell_scalar_and_error(tmm, tmodel) -> None:
    defn = _one_col_table("def value(els):\n    if els[0].name == 'B': raise RuntimeError('boom')\n    return els[0].name")
    ctx = _script_ctx(tmodel)
    build = build_rows_ex(tmm, tmodel, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(tmm, tmodel, defn, build.keys, TableLimits(), script=ctx)
    kinds = {type(row[0]).__name__ for row in cells}
    assert "ValueCell" in kinds and "ErrorCell" in kinds
    err = next(r[0] for r in cells if isinstance(r[0], ErrorCell))
    assert "boom" in err.message
    assert ctx.errored
    ctx.close()


def test_script_cell_elements_and_chaining(tmm, tmodel) -> None:
    # column 0 returns the row element; column 1 chains off it via ColumnRef
    defn = TableDefinition(
        row_source=ScopeRows(types=["Thing"]),
        columns=[
            ScriptColumn(snippet=_snip("def value(els): return els")),
            ScriptColumn(
                source=ColumnRef(index=0),
                snippet=_snip("def value(els): return els[0].name"),
            ),
        ],
    )
    ctx = _script_ctx(tmodel)
    build = build_rows_ex(tmm, tmodel, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(tmm, tmodel, defn, build.keys, TableLimits(), script=ctx)
    for key, row in zip(build.keys, cells):
        assert row[0].element_ids == [key[0]]          # ElementsCell
        assert row[1].value == tmodel.elements[key[0]].properties.get("name")
    ctx.close()


def test_script_expand_scalars_wrap_property_value(tmm, tmodel) -> None:
    defn = _one_col_table("def value(els): return ['x', 'y']", mode="expand")
    ctx = _script_ctx(tmodel)
    build = build_rows_ex(tmm, tmodel, defn, TableLimits(), script=ctx)
    n_things = len(tmodel.indexes.elements_by_type.get("Thing", set()))
    assert len(build.keys) == 2 * n_things
    cells = evaluate_cells(tmm, tmodel, defn, build.keys, TableLimits(), script=ctx)
    assert {row[0].value for row in cells} == {"x", "y"}  # ValueCells, not ElementCells
    ctx.close()


def test_script_expand_error_keeps_one_error_row(tmm, tmodel) -> None:
    defn = _one_col_table("def value(els): raise RuntimeError('boom')",
                          mode="expand", keep_empty=False)
    ctx = _script_ctx(tmodel)
    build = build_rows_ex(tmm, tmodel, defn, TableLimits(), script=ctx)
    n_things = len(tmodel.indexes.elements_by_type.get("Thing", set()))
    assert len(build.keys) == n_things                 # one row each, not dropped
    cells = evaluate_cells(tmm, tmodel, defn, build.keys, TableLimits(), script=ctx)
    assert all(isinstance(r[0], ErrorCell) for r in cells)
    ctx.close()


def test_script_dangling_ref_and_unconfigured(tmm, tmodel) -> None:
    defn = TableDefinition(
        row_source=ScopeRows(types=["Thing"]),
        columns=[ScriptColumn(snippet=SnippetSource(ref="missing")),
                 ScriptColumn(snippet=SnippetSource())],
    )
    ctx = _script_ctx(tmodel)
    build = build_rows_ex(tmm, tmodel, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(tmm, tmodel, defn, build.keys, TableLimits(), script=ctx)
    assert all(isinstance(r[0], ErrorCell) and "not found" in r[0].message for r in cells)
    assert all(isinstance(r[1], ValueCell) and not r[1].present for r in cells)
    ctx.close()


def test_script_memo_one_call_per_binding(tmm, tmodel) -> None:
    # module-level counter proves value() ran once per distinct binding even
    # though cells are evaluated after row building touched the same rows
    code = "n = [0]\ndef value(els):\n    n[0] += 1\n    return n[0]"
    defn = _one_col_table(code, keep_empty=False)      # forces build-time calls too
    ctx = _script_ctx(tmodel)
    build = build_rows_ex(tmm, tmodel, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(tmm, tmodel, defn, build.keys, TableLimits(), script=ctx)
    values = sorted(row[0].value for row in cells)
    assert values == list(range(1, len(build.keys) + 1))  # each binding exactly once
    ctx.close()
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_script_column.py -v`
Expected: FAIL — `TypeError: build_rows_ex() got an unexpected keyword argument 'script'`.

- [ ] **Step 3: Implement `evaluate.py` plumbing**

Add `if TYPE_CHECKING: from data_rover.core.script.embed import ScriptEvalContext`
and `ScriptColumn` to the schema imports.

1. `resolve_source_elements(..., script: ScriptEvalContext | None = None)`:
   every internal recursion passes `script=script`. After the
   `ref_col.kind == "navigation"` collapse branch, before the final property
   return:

```python
    if ref_col.kind == "script":
        # Collapse script column as a source: evaluate (memoized) and bind the
        # returned ELEMENT ids; scalar results bind nothing (runtime-tolerant
        # arity — see schema._source_arity). Expand script columns never reach
        # here: the generic expand-slot read above already returned.
        if ref_col.snippet.definition is None or script is None:
            return []
        roots = resolve_source_elements(
            mm, model, defn, key, ref_col.source, base_slots, limits, script=script
        )
        if not roots:
            return []
        res = script.call(ref_col.snippet.definition.code, "value", roots)
        if res.error is not None or res.value is None:
            return []
        p = res.value
        if p["kind"] == "element":
            return [p["id"]] if p["id"] in model.elements else []
        if p["kind"] == "elements":
            return [i for i in dict.fromkeys(p["ids"]) if i in model.elements]
        return []
```

2. `_collapse_has_value(..., script=None)` — add a first branch:

```python
    if isinstance(col, ScriptColumn):
        # keep_empty=False filter for a collapse script column. ERRORS COUNT
        # AS VALUES: dropping an errored row would hide the failure.
        if col.snippet.ref is not None:
            return True, False                      # dangling ref → error cell stays
        if col.snippet.definition is None or script is None or not roots:
            return False, False
        res = script.call(col.snippet.definition.code, "value", roots)
        if res.error is not None or res.value is None:
            return True, False
        p = res.value
        if p["kind"] == "scalar":
            return p["value"] is not None, False
        if p["kind"] == "scalars":
            return any(v is not None for v in p["values"]), False
        if p["kind"] == "element":
            return p["id"] in model.elements, False
        return any(i in model.elements for i in p["ids"]), False
```

3. `_expand_values(..., script=None)` — add a first branch:

```python
    if isinstance(col, ScriptColumn):
        # Expand promotion: element ids promote raw (str); SCALARS promote
        # wrapped in PropertyValue so a scalar string can never be mistaken
        # for an element id (the Binding invariant); None scalars are skipped.
        # A call ERROR promotes the single binding None — exactly one row
        # survives regardless of keep_empty, and the cell layer re-derives the
        # error from the memoized call.
        if col.snippet.ref is not None:
            return [None], False                    # dangling ref → one error row
        if col.snippet.definition is None or script is None or not roots:
            return [], False
        res = script.call(col.snippet.definition.code, "value", roots)
        if res.error is not None or res.value is None:
            return [None], False
        p = res.value
        if p["kind"] == "element":
            return ([p["id"]] if p["id"] in model.elements else []), False
        if p["kind"] == "elements":
            return [i for i in dict.fromkeys(p["ids"]) if i in model.elements], False
        if p["kind"] == "scalar":
            return ([PropertyValue(p["value"])] if p["value"] is not None else []), False
        return [PropertyValue(v) for v in p["values"] if v is not None], False
```

4. `build_rows_ex`/`build_rows` gain `script=None` and pass it to
   `resolve_source_elements`, `_collapse_has_value`, `_expand_values`.
   `iter_export_rows` gains `script=None` and passes it to `evaluate_cells`.

- [ ] **Step 4: Implement `_script_cell` in `cells.py`**

Import `ErrorCell` is local; add `ScriptColumn` to schema imports and the
`TYPE_CHECKING` `ScriptEvalContext` import. New function (place after
`_navigation_cell`):

```python
def _script_cell(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: ScriptColumn,
    col_index: int,
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None,
) -> Cell:
    if col.mode == "expand":
        # The binding already sits in this row's key slot (build_rows promoted
        # it): PropertyValue = a returned scalar; str = a returned element id;
        # None = keep_empty row OR the single error row _expand_values left —
        # re-derive from the memoized call to tell the two apart.
        slot = _expand_slot_of(defn, base_slots, col_index)
        b = key[slot]
        if isinstance(b, PropertyValue):
            return ValueCell(present=True, value=b.value, element_id=None, editable=False)
        if isinstance(b, str):
            return ElementCell(element_id=b)
        if col.snippet.ref is not None:
            return ErrorCell(message=f"snippet artifact {col.snippet.ref!r} not found")
        if col.snippet.definition is not None and script is not None:
            roots = resolve_source_elements(
                mm, model, defn, key, col.source, base_slots, limits, script=script
            )
            if roots:
                res = script.call(col.snippet.definition.code, "value", roots)
                if res.error is not None:
                    return ErrorCell(
                        message=res.error.message, traceback=res.error.traceback
                    )
        return ValueCell(present=False, value=None, element_id=None, editable=False)

    if col.snippet.ref is not None:  # post-resolve: dangling ref
        return ErrorCell(message=f"snippet artifact {col.snippet.ref!r} not found")
    if col.snippet.definition is None:  # unconfigured ({}): empty, like an
        return ValueCell(present=False, value=None, element_id=None, editable=False)
    els = resolve_source_elements(
        mm, model, defn, key, col.source, base_slots, limits, script=script
    )
    if not els:
        return ValueCell(present=False, value=None, element_id=None, editable=False)
    if script is None:
        # Defensive: routes always supply a context when table_has_script().
        return ErrorCell(message="script runner unavailable")
    res = script.call(col.snippet.definition.code, "value", els)
    if res.error is not None:
        return ErrorCell(message=res.error.message, traceback=res.error.traceback)
    p = res.value
    assert p is not None  # CallResult invariant: value xor error
    if p["kind"] == "scalar":
        if p["value"] is None:
            return ValueCell(present=False, value=None, element_id=None, editable=False)
        return ValueCell(present=True, value=p["value"], element_id=None, editable=False)
    if p["kind"] == "scalars":
        vals = p["values"]
        cap = limits.max_cell_elements
        return ValuesCell(
            present=True, values=vals[:cap], total=len(vals), truncated=len(vals) > cap
        )
    if p["kind"] == "element":
        eid = p["id"]
        return ElementCell(element_id=eid if eid in model.elements else None)
    ids = [i for i in dict.fromkeys(p["ids"]) if i in model.elements]
    cap = limits.max_cell_elements
    return ElementsCell(element_ids=ids[:cap], total=len(ids), truncated=len(ids) > cap)
```

`evaluate_cells` gains `script: ScriptEvalContext | None = None`, its dispatch
gains:

```python
            elif isinstance(col, ScriptColumn):
                row.append(
                    _script_cell(
                        mm, model, defn, key, col, i, base_slots, limits, script
                    )
                )
```

(keep the existing `else` → navigation branch last), and the two existing
`resolve_source_elements` callers in this file (`_element_cell`,
`_property_cell`, `_navigation_cell`) pass `script=script` — thread the
parameter through their signatures.

- [ ] **Step 5: Run tests, tidy, commit**

Run: `pixi run -e core-dev pytest tests/table/ -v` → PASS (new + existing).
`pixi run dr-tidy` → clean.

```bash
git add src/data_rover/core/table/evaluate.py src/data_rover/core/table/cells.py tests/table/test_script_column.py
git commit -m "feat(snippets): ScriptColumn evaluation — cells, chaining, expand, keep_empty"
```

---

## Task 8: Table sorting by script columns

**Files:**
- Modify: `src/data_rover/core/table/evaluate.py`
- Test: `tests/table/test_script_column.py` (extend)

**Interfaces:**
- Produces: `order_rows(..., script=None)`; `_sort_value` script branch. Sort atoms are uniform `tuple[int, float, str]` triples via `_script_sort_atom` so mixed result kinds across rows never raise `TypeError` in `list.sort`: numbers `(0, float(v), "")`, strings `(1, 0.0, v.casefold())`, elements `(2, 0.0, label.casefold() + "\x00" + id)`. Errors and empties sort last (empty partition).

- [ ] **Step 1: Write the failing test**

```python
from data_rover.core.table.evaluate import SortSpec, order_rows


def test_sort_by_script_column_mixed_kinds_and_errors(tmm, tmodel) -> None:
    # names: rows return int for 'A', string for 'B', error for 'C' — the sort
    # must not raise, numbers sort before strings, errors sort last.
    code = (
        "def value(els):\n"
        "    n = els[0].name\n"
        "    if n == 'A': return 2\n"
        "    if n == 'B': return 'b'\n"
        "    raise RuntimeError('boom')"
    )
    defn = _one_col_table(code)
    ctx = _script_ctx(tmodel)
    build = build_rows_ex(tmm, tmodel, defn, TableLimits(), script=ctx)
    ordered = order_rows(
        tmm, tmodel, defn, build.keys, SortSpec(column=0, direction="asc"),
        TableLimits(), script=ctx,
    )
    names = [tmodel.elements[k[0]].properties.get("name") for k in ordered]
    assert names.index("A") < names.index("B")       # number before string
    assert names[-1] == "C"                          # error last
    ctx.close()
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_script_column.py -k sort -v`
Expected: FAIL — `order_rows() got an unexpected keyword argument 'script'`.

- [ ] **Step 3: Implement**

`order_rows` gains `script: ScriptEvalContext | None = None` and passes it to
`_sort_value` (which gains the same). Add helper + branch in `_sort_value`:

```python
def _script_sort_atom(model: Model, item: object) -> tuple[int, float, str]:
    """One uniformly-comparable sort atom for a script result item. Rank
    numbers (incl. bools) first, then strings, then elements — uniform
    `(rank, number, string)` triples so a column whose rows return DIFFERENT
    result kinds still sorts without a cross-type TypeError."""
    if isinstance(item, bool) or isinstance(item, (int, float)):
        return (0, float(item), "")
    if isinstance(item, str) and item in model.elements:
        return (2, 0.0, _display_name(model, item).casefold() + "\x00" + item)
    return (1, 0.0, str(item).casefold())
```

In `_sort_value`, after the `PropertyColumn` branch (before the
NavigationColumn comment):

```python
    if isinstance(col, ScriptColumn):
        if col.mode == "expand":
            b = key[_expand_slot_of(defn, base_slots, col_index)]
            if isinstance(b, PropertyValue):
                return (0, (_script_sort_atom(model, b.value),))
            if isinstance(b, str):
                return (0, (_script_sort_atom(model, b),))
            return (1, ())                       # keep_empty row or error row
        if col.snippet.definition is None or script is None:
            return (1, ())
        els = resolve_source_elements(
            mm, model, defn, key, col.source, base_slots, limits, script=script
        )
        if not els:
            return (1, ())
        res = script.call(col.snippet.definition.code, "value", els)
        if res.error is not None or res.value is None:
            return (1, ())                       # errors sort with empties
        p = res.value
        if p["kind"] == "scalar":
            if p["value"] is None:
                return (1, ())
            return (0, (_script_sort_atom(model, p["value"]),))
        if p["kind"] == "scalars":
            vals = [v for v in p["values"] if v is not None]
            if not vals:
                return (1, ())
            return (0, tuple(_script_sort_atom(model, v) for v in vals))
        if p["kind"] == "element":
            eid = p["id"]
            if eid not in model.elements:
                return (1, ())
            return (0, (_script_sort_atom(model, eid),))
        atoms = sorted(
            _script_sort_atom(model, i) for i in p["ids"] if i in model.elements
        )
        return (0, tuple(atoms)) if atoms else (1, ())
```

Note the `_script_sort_atom` element branch checks `item in model.elements`
BEFORE treating a string as an element — inside a script column all id
strings come from validated element payloads, so this is safe; a scalar
string that happens to collide with an element id sorts as that element's
label, an accepted edge (document in the helper docstring).

- [ ] **Step 4: Run tests, tidy, commit**

Run: `pixi run -e core-dev pytest tests/table/ -v` → PASS. `pixi run dr-tidy` → clean.

```bash
git add src/data_rover/core/table/evaluate.py tests/table/test_script_column.py
git commit -m "feat(snippets): sorting by script columns with uniform sort atoms"
```

---

## Task 9: Navigation evaluation — `ScriptStep` + warnings channel

**Files:**
- Modify: `src/data_rover/core/navigation/evaluate.py`
- Test: `tests/navigation/test_script_step.py` (extend)

**Interfaces:**
- Produces:
  - `ChainResult` gains `warnings: list[str] = field(default_factory=list)` — only the warnings generated during THIS `evaluate()` call (len-snapshot of the shared context).
  - `evaluate(metamodel, model, defn, limits=EvalLimits(), *, row_elements=None, script: ScriptEvalContext | None = None)`.
  - `ScriptStep` in `_walk`: `step(el)` per frontier element via `script.call(code, "step", [current_id])`; returned ids deduped order-preserving, unknown ids dropped with a warning, `exclude_visited` applies, budget charged `len(ids)`; per-element error → prune + warning; dangling ref → prune + warning; unconfigured/`script is None` → silent prune.
  - `step_types` entry for a ScriptStep: `s.comment or "script"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/navigation/test_script_step.py` (reuse the metamodel/model
fixture style of `tests/navigation/test_evaluate.py`; assume elements of type
`"Thing"` with ids available):

```python
from data_rover.core.navigation.evaluate import evaluate
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import RunLimits, ScriptBudget
from tests.script.trusted_runner import TrustedRunner


def _ctx(model) -> ScriptEvalContext:
    return ScriptEvalContext(TrustedRunner(), model, RunLimits(), ScriptBudget.start(30))


def test_script_step_advances_frontier(nmm, nmodel) -> None:
    ids = sorted(nmodel.elements)
    target = ids[0]
    defn = _path([ScriptStep(
        snippet=_snip(f"def step(el):\n    return ['{target}'] if el.id != '{target}' else []"),
        comment="to-target",
    )])
    res = evaluate(nmm, nmodel, defn, script=_ctx(nmodel))
    assert res.step_types == ["to-target"]
    assert all(chain[1] == target for chain in res.chains)
    assert all(chain[0] != target for chain in res.chains)  # exclude_visited
    assert res.warnings == []


def test_script_step_error_prunes_with_warning(nmm, nmodel) -> None:
    defn = _path([ScriptStep(snippet=_snip("def step(el): raise RuntimeError('boom')"))])
    res = evaluate(nmm, nmodel, defn, script=_ctx(nmodel))
    assert res.chains == []
    assert any("boom" in w for w in res.warnings)


def test_script_step_unknown_ids_dropped_with_warning(nmm, nmodel) -> None:
    ids = sorted(nmodel.elements)
    defn = _path([ScriptStep(
        snippet=_snip(f"def step(el): return ['{ids[0]}', 'no-such-id']")
    )])
    res = evaluate(nmm, nmodel, defn, script=_ctx(nmodel))
    assert any("unknown element id" in w for w in res.warnings)
    assert all(chain[1] == ids[0] for chain in res.chains)


def test_script_step_dangling_and_unconfigured(nmm, nmodel) -> None:
    res = evaluate(
        nmm, nmodel,
        _path([ScriptStep(snippet=SnippetSource(ref="missing"))]),
        script=_ctx(nmodel),
    )
    assert res.chains == [] and any("not found" in w for w in res.warnings)
    res = evaluate(nmm, nmodel, _path([ScriptStep()]), script=_ctx(nmodel))
    assert res.chains == [] and res.warnings == []      # unconfigured: silent


def test_script_step_without_context_prunes_silently(nmm, nmodel) -> None:
    defn = _path([ScriptStep(snippet=_snip("def step(el): return []"))])
    res = evaluate(nmm, nmodel, defn)                    # script=None
    assert res.chains == [] and res.warnings == []
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/navigation/test_script_step.py -v`
Expected: FAIL — `evaluate() got an unexpected keyword argument 'script'`.

- [ ] **Step 3: Implement**

1. `ChainResult` gains `warnings: list[str] = field(default_factory=list)`
   (import `field`; extend the class docstring: *"`warnings` carries script-
   step degradations (pruned chains, dropped ids) generated during THIS
   evaluate call — missing-property prunes stay silent, unchanged"*).
2. `evaluate` gains `script: ScriptEvalContext | None = None`
   (`TYPE_CHECKING` import from `..script.embed`), snapshots
   `w0 = len(script.warnings) if script is not None else 0` at entry, passes
   `script` into `_walk` / `_evaluate_set` / `_operand_members` /
   `_start_ids` (all gain the parameter and thread it), and builds both
   `ChainResult` returns with
   `warnings=list(script.warnings[w0:]) if script is not None else []`.
3. `step_types` listcomp becomes:

```python
        step_types=[
            s.relationship_type
            if isinstance(s, RelationshipStep)
            else s.property_name
            if isinstance(s, PropertyStep)
            else (s.comment or "script")
            for s in defn.steps
            if not isinstance(s, FilterStep)
        ],
```

4. Add `_hop_script` (after `_hop_property`):

```python
def _hop_script(
    model: Model,
    element_id: str,
    step: ScriptStep,
    script: ScriptEvalContext | None,
    budget: _Budget,
) -> list[ChainNode]:
    """Continuations of a script hop: `step(el)` returns the next frontier's
    ids. DEGRADED, NEVER RAISING: a dangling ref, a per-element error, or an
    unknown returned id prunes/drops with a warning on the shared context; an
    unconfigured snippet or absent context prunes silently (mirroring an
    unconfigured navigation source). Dedup preserves the snippet's own return
    order — deterministic because guest output is deterministic."""
    if step.snippet.ref is not None:
        if script is not None:
            script.add_warning(
                f"script step: snippet artifact {step.snippet.ref!r} not found"
            )
        return []
    if step.snippet.definition is None or script is None:
        return []
    res = script.call(step.snippet.definition.code, "step", [element_id])
    if res.error is not None:
        script.add_warning(f"script step failed: {res.error.message}")
        return []
    assert res.value is not None
    raw = list(dict.fromkeys(res.value["ids"]))
    if not budget.spend(len(raw)):
        return []
    known = [i for i in raw if i in model.elements]
    if len(known) != len(raw):
        script.add_warning(
            f"script step returned {len(raw) - len(known)} unknown element id(s)"
        )
    return list(known)
```

5. `_walk` gains a `script` parameter (threaded through its recursions) and
   its dispatch becomes:

```python
    nxt: list[ChainNode]
    if isinstance(step, RelationshipStep):
        nxt = list(_hop(metamodel, model, current, step, budget))
    elif isinstance(step, PropertyStep):
        nxt = _hop_property(metamodel, model, current, step, budget)
    else:  # ScriptStep
        nxt = _hop_script(model, current, step, script, budget)
```

- [ ] **Step 4: Run tests, tidy, commit**

Run: `pixi run -e core-dev pytest tests/navigation/ tests/table/ -v` → PASS.
`pixi run dr-tidy` → clean.

```bash
git add src/data_rover/core/navigation/evaluate.py tests/navigation/test_script_step.py
git commit -m "feat(snippets): ScriptStep evaluation — frontier hops, prune-with-warning, ChainResult.warnings"
```

---

## Task 10: Concurrency-guard module + budget setting + route helper

**Files:**
- Create: `src/data_rover/api/snippet_concurrency.py`, `src/data_rover/api/script_eval.py`
- Modify: `src/data_rover/api/routes/snippets.py`, `src/data_rover/api/settings.py`
- Test: `tests/api/test_script_embedding_routes.py` (new — helper-level tests), existing `tests/api/test_snippets_routes.py` must stay green

**Interfaces:**
- Produces:
  - `snippet_concurrency.py`: `ConcurrencyGuard` — the class moved verbatim from `routes/snippets.py` (`try_acquire`/`release` unchanged) plus:

```python
    def try_acquire_global(self, *, global_limit: int) -> bool: ...
    def release_global(self) -> None: ...
```

  and the module singleton `concurrency_guard = ConcurrencyGuard()`.
  - `settings.py`: `snippet_eval_budget_s: float = 30.0` (docstring: total wall budget for all embedded snippet work one evaluate/export request triggers; `DATA_ROVER_SNIPPET_EVAL_BUDGET_S`).
  - `script_eval.py`:

```python
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

def close_script_context(ctx: ScriptEvalContext | None, acquired: bool) -> None:
    """Close sessions + release the global slot; safe under partial setup."""
```

- Consumes: `ScriptEvalContext` (Task 4), `run_limits_from_settings` (existing).

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_script_embedding_routes.py`:

```python
"""M2/M3 embedded-evaluation route tests (TrustedRunner injected). Route-level
coverage lands in Tasks 11-13; this file starts with the script_eval helper."""

from __future__ import annotations

from data_rover.api.script_eval import close_script_context, open_script_context
from data_rover.api.settings import Settings
from data_rover.api.snippet_concurrency import ConcurrencyGuard, concurrency_guard
from tests.script.trusted_runner import TrustedRunner


def _settings(**kw) -> Settings:
    return Settings(dev_seed=True, **kw)


def test_guard_global_slot() -> None:
    g = ConcurrencyGuard()
    assert g.try_acquire_global(global_limit=1)
    assert not g.try_acquire_global(global_limit=1)
    g.release_global()
    assert g.try_acquire_global(global_limit=1)
    g.release_global()


def test_open_context_modes(small_model) -> None:
    s = _settings()
    ctx, acquired = open_script_context(None, None, s, needs_script=False)
    assert ctx is None and not acquired

    ctx, acquired = open_script_context(None, None, s, needs_script=True)
    assert ctx is not None and not acquired          # unavailable mode
    res = ctx.call("def value(els): return 1", "value", ["x"])
    assert res.error is not None and res.error.kind == "unavailable"
    close_script_context(ctx, acquired)

    runner = TrustedRunner()
    ctx, acquired = open_script_context(runner, small_model, s, needs_script=True)
    assert ctx is not None and acquired
    close_script_context(ctx, acquired)


def test_open_context_busy(small_model) -> None:
    s = _settings(snippet_concurrency=1)
    runner = TrustedRunner()
    ctx1, a1 = open_script_context(runner, small_model, s, needs_script=True)
    ctx2, a2 = open_script_context(runner, small_model, s, needs_script=True)
    assert a1 and not a2
    res = ctx2.call("def value(els): return 1", "value", ["x"])
    assert res.error is not None and "busy" in res.error.message
    close_script_context(ctx2, a2)
    close_script_context(ctx1, a1)
    # slot actually freed:
    assert concurrency_guard.try_acquire_global(global_limit=1)
    concurrency_guard.release_global()
```

`small_model` here: add a session-scoped fixture to
`tests/api/test_script_embedding_routes.py` (or reuse an existing tiny-model
helper from `tests/api/conftest.py` if one exists) — a `Model` with one
element is enough.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_script_embedding_routes.py -v`
Expected: FAIL — no module `data_rover.api.snippet_concurrency`.

- [ ] **Step 3: Implement**

1. Create `snippet_concurrency.py`: move `_ConcurrencyGuard` from
   `routes/snippets.py` verbatim, rename `ConcurrencyGuard`, keep its
   docstring, add:

```python
    def try_acquire_global(self, *, global_limit: int) -> bool:
        """Global-only slot for EMBEDDED evaluation (script columns/steps):
        one slot per evaluate/export request, no per-user cap (the per-user
        cap protects the interactive console; a table view is not an
        interactive run). Fail-fast like `try_acquire` — the caller degrades
        to error cells / warnings, never blocks."""
        with self._lock:
            if self._global_count >= global_limit:
                return False
            self._global_count += 1
            return True

    def release_global(self) -> None:
        with self._lock:
            if self._global_count > 0:
                self._global_count -= 1
```

   Module tail: `concurrency_guard = ConcurrencyGuard()` (docstring: process-
   wide singleton shared by console runs and embedded evaluation — the global
   cap covers BOTH).
2. `routes/snippets.py`: delete the local class + `_concurrency_guard`
   singleton; `from ..snippet_concurrency import concurrency_guard` and use it
   in `run_snippet` (`concurrency_guard.try_acquire(...)` / `.release(...)`).
3. `settings.py`: add `snippet_eval_budget_s: float = 30.0` next to the other
   `snippet_*` fields, with docstring.
4. Create `script_eval.py`:

```python
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
    if not needs_script:
        return None, False
    limits = run_limits_from_settings(settings)
    budget = ScriptBudget.start(settings.snippet_eval_budget_s)
    if runner is None:
        return (
            ScriptEvalContext(
                None, None, limits, budget,
                unavailable_reason="script runner unavailable",
            ),
            False,
        )
    if not concurrency_guard.try_acquire_global(
        global_limit=settings.snippet_concurrency
    ):
        return (
            ScriptEvalContext(
                None, None, limits, budget,
                unavailable_reason="snippet runner busy",
            ),
            False,
        )
    return ScriptEvalContext(runner, model, limits, budget), True


def close_script_context(ctx: ScriptEvalContext | None, acquired: bool) -> None:
    if ctx is not None:
        ctx.close()
    if acquired:
        concurrency_guard.release_global()
```

- [ ] **Step 4: Run tests, tidy, commit**

Run: `pixi run -e core-dev pytest tests/api/test_script_embedding_routes.py tests/api/test_snippets_routes.py -v` → PASS.
`pixi run dr-tidy` → clean.

```bash
git add src/data_rover/api/snippet_concurrency.py src/data_rover/api/script_eval.py src/data_rover/api/routes/snippets.py src/data_rover/api/settings.py tests/api/test_script_embedding_routes.py
git commit -m "feat(snippets): shared concurrency guard module, eval budget setting, script_eval route glue"
```

---

## Task 11: `POST /tables/evaluate` wiring

**Files:**
- Modify: `src/data_rover/api/routes/tables.py`, `src/data_rover/api/schemas.py`
- Test: `tests/api/test_script_embedding_routes.py` (extend)

**Interfaces:**
- Produces:
  - `TableCellOut.kind` Literal gains `"error"`; new fields `message: str | None = None`, `traceback: str | None = None`.
  - `TablePageOut.warnings: list[str] = Field(default_factory=list)`.
  - `_resolve_table` builds a snippet fetch closure (project-scoped
    `code_snippet` artifacts via `SNIPPET_ADAPTER`) and calls
    `resolve_table_refs(defn, _fetch, snippet_fetch=_fetch_snippet)`.
  - `_cell_out` maps `ErrorCell` → `TableCellOut(kind="error", message=..., traceback=...)`.
  - Cache-poisoning guard: `put` only when `ctx is None or (not ctx.errored and session.model_rev == rev)`.
- Consumes: Tasks 5–10.

- [ ] **Step 1: Write the failing route tests**

Extend `tests/api/test_script_embedding_routes.py`. Follow the existing
`tests/api/` conventions exactly: `client` fixture, `seed_default_project`,
`AUTH_HEADERS`, `papi`, and model seeding via `get_session()` — copy the setup
shape from `tests/api/test_tables_routes.py` (which seeds a metamodel + model
into the default session). Inject the runner with
`client.app.dependency_overrides[get_runner] = lambda: TrustedRunner()`
(import `get_runner` from `data_rover.api.script_runner`), and remember to
clear the override in a `finally`/fixture teardown.

```python
def _script_table(code: str) -> dict:
    return {
        "row_source": {"kind": "scope", "types": ["Thing"]},
        "columns": [{"kind": "script", "snippet": {"definition": {"code": code}}}],
    }


def test_evaluate_script_column_end_to_end(client, seed_thing_model) -> None:
    r = client.post(
        papi("/tables/evaluate"),
        json={"definition": _script_table("def value(els): return els[0].name")},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    kinds = {c["kind"] for row in body["rows"] for c in row["cells"]}
    assert kinds == {"value"}
    assert body["warnings"] == []


def test_evaluate_script_error_cell_and_no_cache_poisoning(client, seed_thing_model) -> None:
    defn = _script_table("def value(els): raise RuntimeError('boom')")
    r = client.post(papi("/tables/evaluate"), json={"definition": defn}, headers=AUTH_HEADERS)
    assert r.status_code == 200
    cell = r.json()["rows"][0]["cells"][0]
    assert cell["kind"] == "error" and "boom" in cell["message"]
    # errored evaluations must NOT be served from the order cache: fix the
    # snippet inside the same rev and re-evaluate — cells recompute (a poisoned
    # order cache would be invisible here, so assert on the cache directly):
    from data_rover.api.session import get_session
    assert len(get_session().table_order_cache._d) == 0


def test_evaluate_runner_unavailable_degrades(client, seed_thing_model) -> None:
    client.app.dependency_overrides[get_runner] = lambda: None
    r = client.post(
        papi("/tables/evaluate"),
        json={"definition": _script_table("def value(els): return 1")},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200
    cell = r.json()["rows"][0]["cells"][0]
    assert cell["kind"] == "error" and "unavailable" in cell["message"]


def test_evaluate_dangling_snippet_ref(client, seed_thing_model) -> None:
    defn = {
        "row_source": {"kind": "scope", "types": ["Thing"]},
        "columns": [{"kind": "script", "snippet": {"ref": "no-such-artifact"}}],
    }
    r = client.post(papi("/tables/evaluate"), json={"definition": defn}, headers=AUTH_HEADERS)
    assert r.status_code == 200
    cell = r.json()["rows"][0]["cells"][0]
    assert cell["kind"] == "error" and "not found" in cell["message"]


def test_evaluate_saved_snippet_ref_and_fingerprint(client, seed_thing_model) -> None:
    # create a snippet artifact, reference it, evaluate; then edit it and
    # confirm the next evaluation reflects the new code (fingerprint moved).
    r = client.post(
        papi("/artifacts"),
        json={"kind": "code_snippet", "name": "col",
              "payload": {"code": "def value(els): return 'v1'"}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201, r.text
    art = r.json()
    defn = {
        "row_source": {"kind": "scope", "types": ["Thing"]},
        "columns": [{"kind": "script", "snippet": {"ref": art["id"]}}],
    }
    r = client.post(papi("/tables/evaluate"), json={"definition": defn}, headers=AUTH_HEADERS)
    assert r.json()["rows"][0]["cells"][0]["value"] == "v1"
    r = client.put(
        papi(f"/artifacts/{art['id']}"),
        json={"artifact_rev": art["artifact_rev"],
              "payload": {"code": "def value(els): return 'v2'"}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    r = client.post(papi("/tables/evaluate"), json={"definition": defn}, headers=AUTH_HEADERS)
    assert r.json()["rows"][0]["cells"][0]["value"] == "v2"
```

(`seed_thing_model`: a small fixture in this file seeding the default session
with a metamodel declaring `Thing` (with a `name` string property) and a few
`Thing` elements — copy the seeding pattern from `tests/api/test_tables_routes.py`.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_script_embedding_routes.py -v`
Expected: new tests FAIL (422 "not supported"/validation or missing `warnings` field).

- [ ] **Step 3: Implement**

1. `schemas.py`:
   - `TableCellOut.kind: Literal["element", "value", "values", "elements", "error"]`;
     add `message: str | None = None` and `traceback: str | None = None` under
     a `# error` comment.
   - `TablePageOut` gains `warnings: list[str] = Field(default_factory=list)`
     (docstring: script-step degradations from navigations this evaluation
     triggered + nothing else today).
2. `routes/tables.py`:
   - Imports: `ErrorCell`, `resolve_table_refs`, `table_has_script`,
     `SNIPPET_ADAPTER` + `SnippetDefinition` (from `core.script.schema`),
     `ScriptRunner`/`get_runner`, `get_settings`/`Settings`,
     `open_script_context`/`close_script_context`.
   - `_resolve_table` gains the snippet fetch and passes it:

```python
    def _fetch_snippet(artifact_id: str) -> SnippetDefinition:
        r = content.get_artifact(db, artifact_id)
        if (
            r is None
            or r.project_id != project_id
            or r.kind is not ArtifactKind.code_snippet
        ):
            raise LookupError(artifact_id)
        return SNIPPET_ADAPTER.validate_python(r.payload)

    return resolve_table_refs(defn, _fetch, snippet_fetch=_fetch_snippet)
```

   - `_cell_out` gains, before the final `assert`:

```python
    if isinstance(cell, ErrorCell):
        return TableCellOut(kind="error", message=cell.message, traceback=cell.traceback)
```

   - `evaluate_table` signature adds
     `runner: ScriptRunner | None = Depends(get_runner)` and
     `settings: Settings = Depends(get_settings)`. Body — after `defn = ...`
     and the sort guard, restructure the evaluation block:

```python
        limits = TableLimits()
        fp = table_fingerprint(TABLE_ADAPTER.dump_json(defn).decode(), sort)
        sort_key = "none" if sort is None else f"{sort.column}:{sort.direction}"
        rev = session.model_rev
        script_ctx, acquired = open_script_context(
            runner, model, settings, needs_script=table_has_script(defn)
        )
        try:
            cached = session.table_order_cache.get(fp, sort_key, rev)
            if cached is not None:
                cached_rows, truncated, base_total = cached
                ordered = list(cached_rows)
            else:
                built = build_rows_ex(metamodel, model, defn, limits, script=script_ctx)
                truncated, base_total = built.truncated, built.base_total
                ordered = order_rows(
                    metamodel, model, defn, built.keys, sort, limits, script=script_ctx
                )
                # Cache-poisoning guard: an errored or stale script evaluation
                # must never populate the order cache — neither key (code
                # hash, model_rev) changes on retry, so a bad order would be
                # served forever.
                if script_ctx is None or (
                    not script_ctx.errored and session.model_rev == rev
                ):
                    session.table_order_cache.put(
                        fp, sort_key, rev, tuple(ordered), truncated, base_total
                    )
            window = ordered[payload.offset : payload.offset + payload.limit]
            cells = evaluate_cells(
                metamodel, model, defn, window, limits, script=script_ctx
            )
            warnings = list(script_ctx.warnings) if script_ctx is not None else []
        finally:
            close_script_context(script_ctx, acquired)
```

     (the `try/except LookupError/...` wrapper stays around the whole block as
     today; `TablePageOut(...)` gains `warnings=warnings`).

- [ ] **Step 4: Run tests, tidy, commit**

Run: `pixi run -e core-dev pytest tests/api/ -v` → PASS (new + all existing API tests).
`pixi run dr-tidy` → clean.

```bash
git add src/data_rover/api/routes/tables.py src/data_rover/api/schemas.py tests/api/test_script_embedding_routes.py
git commit -m "feat(snippets): script columns in POST /tables/evaluate — error cells, warnings, cache guard"
```

---

## Task 12: `POST /tables/export` — budget + error markers + notice row

**Files:**
- Modify: `src/data_rover/api/routes/tables.py`, `src/data_rover/api/table_export.py`
- Test: `tests/api/test_script_embedding_routes.py` (extend)

**Interfaces:**
- Produces:
  - `table_export._cell_text` maps `ErrorCell` → `f"#ERROR: {cell.message}"`.
  - `build_workbook(model, headers, widths, sheet_name, row_iter, notice: str | None = None)` — when `notice` is set, appends one final row containing it.
  - `export_table` opens the same script context (same budget setting), threads `script=` through `build_rows`/`order_rows`/`iter_export_rows`, and sets `notice` when `script_ctx.errored` (text below), plus response header `X-Table-Script-Errors: true`.

- [ ] **Step 1: Write the failing test**

```python
import io
from openpyxl import load_workbook


def test_export_script_column_with_errors_gets_marker_and_notice(client, seed_thing_model) -> None:
    defn = _script_table(
        "def value(els):\n    if els[0].name == 'B': raise RuntimeError('boom')\n    return els[0].name"
    )
    r = client.post(papi("/tables/export"), json={"definition": defn}, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers.get("X-Table-Script-Errors") == "true"
    wb = load_workbook(io.BytesIO(r.content), read_only=True)
    ws = wb.active
    texts = [str(row[0].value) for row in ws.iter_rows() if row and row[0].value is not None]
    assert any(t.startswith("#ERROR:") for t in texts)
    assert "script" in texts[-1].lower()               # trailing notice row
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_script_embedding_routes.py -k export -v`
Expected: FAIL (currently `_cell_text` asserts on `ErrorCell` → 500, or no notice).

- [ ] **Step 3: Implement**

1. `table_export.py`: import `ErrorCell`; in `_cell_text`, before the final
   `assert`:

```python
    if isinstance(cell, ErrorCell):
        return f"#ERROR: {cell.message}"
```

   `build_workbook` gains `notice: str | None = None`; after the row loop:

```python
    if notice:
        ws.append([WriteOnlyCell(ws, value=notice)])
```

2. `routes/tables.py` `export_table`: add the same `runner`/`settings` deps;
   wrap build/order/iterate in the open/close context pattern of Task 11
   (`needs_script=table_has_script(defn)`, `script=script_ctx` through
   `build_rows`, `order_rows`, `iter_export_rows`). Because `build_workbook`
   consumes the row iterator lazily, the context must stay open until the
   workbook bytes are built — close in a `finally` AFTER `build_workbook`
   returns. Then:

```python
    notice = None
    if script_ctx is not None and script_ctx.errored:
        notice = (
            "Some script cells failed or exceeded the evaluation budget; "
            "affected cells are marked #ERROR."
        )
    blob = build_workbook(..., notice=notice)
    ...
    if script_ctx is not None and script_ctx.errored:
        resp_headers["X-Table-Script-Errors"] = "true"
```

   Note the ordering trap: `script_ctx.errored` must be read AFTER the row
   iterator has been fully consumed by `build_workbook` — compute `blob`
   first, then `notice`? `build_workbook`'s `notice` parameter is consumed
   after the loop, but the VALUE was computed before. Restructure: pass a
   zero-arg callable instead — change the parameter to
   `notice: str | Callable[[], str | None] | None = None` is over-clever;
   instead, compute the workbook in two steps:

```python
    rows_iter = ([row[i] for i in visible] for row in all_rows)
    blob = build_workbook(model, headers, widths, name, rows_iter,
                          notice_provider=lambda: notice_text())
```

   Concretely: give `build_workbook` a `notice_provider: Callable[[], str | None] | None = None`
   parameter, called AFTER the row loop:

```python
    if notice_provider is not None:
        text = notice_provider()
        if text:
            ws.append([WriteOnlyCell(ws, value=text)])
```

   and in the route:

```python
    def _notice() -> str | None:
        if script_ctx is not None and script_ctx.errored:
            return (
                "Some script cells failed or exceeded the evaluation budget; "
                "affected cells are marked #ERROR."
            )
        return None

    blob = build_workbook(model, headers, widths, name,
                          ([row[i] for i in visible] for row in all_rows),
                          notice_provider=_notice)
```

   (drop the plain `notice` parameter — `notice_provider` is the only new one).
   The `X-Table-Script-Errors` header check runs after `build_workbook`, so it
   sees the final `errored` state.

- [ ] **Step 4: Run tests, tidy, commit**

Run: `pixi run -e core-dev pytest tests/api/ -v` → PASS. `pixi run dr-tidy` → clean.

```bash
git add src/data_rover/api/routes/tables.py src/data_rover/api/table_export.py tests/api/test_script_embedding_routes.py
git commit -m "feat(snippets): script columns in xlsx export — #ERROR markers + truncation notice"
```

---

## Task 13: `POST /navigations/evaluate` wiring

**Files:**
- Modify: `src/data_rover/api/routes/artifacts.py`, `src/data_rover/api/schemas.py`
- Test: `tests/api/test_script_embedding_routes.py` (extend)

**Interfaces:**
- Produces: `ChainPageOut.warnings: list[str] = Field(default_factory=list)`; `evaluate_navigation` resolves snippet refs (`resolve_refs(..., snippet_fetch=...)`), opens a script context when `navigation_has_script(defn)`, passes `script=` into `evaluate`, returns `warnings=result.warnings`.

- [ ] **Step 1: Write the failing tests**

```python
def test_navigation_script_step_end_to_end(client, seed_thing_model, thing_ids) -> None:
    target = thing_ids[0]
    defn = {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Thing"]},
        "steps": [{"kind": "script", "snippet": {"definition": {
            "code": f"def step(el):\n    return ['{target}'] if el.id != '{target}' else []"
        }}}],
    }
    r = client.post(papi("/navigations/evaluate"), json={"definition": defn}, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["warnings"] == []
    assert all(chain[1]["id"] == target for chain in body["chains"])


def test_navigation_script_step_error_warns(client, seed_thing_model) -> None:
    defn = {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Thing"]},
        "steps": [{"kind": "script", "snippet": {"definition": {
            "code": "def step(el): raise RuntimeError('boom')"
        }}}],
    }
    r = client.post(papi("/navigations/evaluate"), json={"definition": defn}, headers=AUTH_HEADERS)
    assert r.status_code == 200
    body = r.json()
    assert body["chains"] == []
    assert any("boom" in w for w in body["warnings"])
```

(`thing_ids` — expose the seeded element ids from the `seed_thing_model`
fixture.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_script_embedding_routes.py -k navigation -v`
Expected: FAIL — no `warnings` key (and script steps prune silently since `script=None`).

- [ ] **Step 3: Implement**

1. `schemas.py`: `ChainPageOut` gains `warnings: list[str] = Field(default_factory=list)`.
2. `routes/artifacts.py` `evaluate_navigation`: add `runner`/`settings` deps;
   add a `_fetch_snippet` closure identical to Task 11's; pass
   `snippet_fetch=_fetch_snippet` into both `resolve_refs` calls; then:

```python
        script_ctx, acquired = open_script_context(
            runner, model, settings, needs_script=navigation_has_script(defn)
        )
        try:
            result = evaluate(
                metamodel, model, defn, row_elements=row_elements, script=script_ctx
            )
        finally:
            close_script_context(script_ctx, acquired)
```

   and `ChainPageOut(..., warnings=result.warnings)`.

- [ ] **Step 4: Run tests, tidy, commit**

Run: `pixi run -e core-dev pytest tests/api/ -v` → PASS. `pixi run dr-tidy` → clean.

```bash
git add src/data_rover/api/routes/artifacts.py src/data_rover/api/schemas.py tests/api/test_script_embedding_routes.py
git commit -m "feat(snippets): script steps in POST /navigations/evaluate — warnings channel"
```

---

## Task 14: WASM embedded sessions (`script_runner.py` + guest bootstrap)

**Files:**
- Modify: `src/data_rover/api/script_runner.py`
- Test: `tests/api/test_snippets_wasm.py` (extend, `integration`-marked)

**Interfaces:**
- Produces: `WasmScriptRunner.open_session(model, code, limits, *, budget) -> SnippetSession` — real-sandbox sessions. Start message gains `"mode": "embedded"` (`"run"` default keeps the one-shot path byte-identical). Guest serves `{"call": {...}}` frames after a `{"boot": true, "error": ...}` ack; host arms the per-call epoch deadline at `min(limits.wall_timeout_s, budget.remaining())` while the guest is parked on stdin, and re-arms `_IDLE_EPOCH_DEADLINE_TICKS` between calls. A guest death (timeout/crash) promotes the mapped error into `boot_error` so every later call fails fast; `close()` tears the instance down (idempotent).

- [ ] **Step 1: Write the failing integration tests**

Extend `tests/api/test_snippets_wasm.py` (same `integration` mark and
runner-construction pattern as the existing tests there; requires the fetched
guest binary):

```python
@pytest.mark.integration
def test_wasm_session_repeated_calls_and_state(wasm_runner, small_model) -> None:
    ids = sorted(small_model.elements)
    sess = wasm_runner.open_session(
        small_model,
        "n = [0]\ndef value(els):\n    n[0] += 1\n    return n[0]",
        RunLimits(),
        budget=ScriptBudget.start(60),
    )
    assert sess.boot_error is None
    assert sess.call("value", [ids[0]]).value == {"kind": "scalar", "value": 1}
    assert sess.call("value", [ids[0]]).value == {"kind": "scalar", "value": 2}
    sess.close()
    sess.close()  # idempotent


@pytest.mark.integration
def test_wasm_session_boot_error(wasm_runner, small_model) -> None:
    sess = wasm_runner.open_session(
        small_model, "raise RuntimeError('boom')", RunLimits(),
        budget=ScriptBudget.start(60),
    )
    assert sess.boot_error is not None and sess.boot_error.kind == "runtime"
    sess.close()


@pytest.mark.integration
def test_wasm_session_call_timeout_kills_session(wasm_runner, small_model) -> None:
    ids = sorted(small_model.elements)
    sess = wasm_runner.open_session(
        small_model,
        "def value(els):\n    while True:\n        pass",
        RunLimits(wall_timeout_s=2),
        budget=ScriptBudget.start(60),
    )
    res = sess.call("value", [ids[0]])
    assert res.error is not None and res.error.kind == "timeout"
    res2 = sess.call("value", [ids[0]])          # session is dead now
    assert res2.error is not None
    sess.close()


@pytest.mark.integration
def test_wasm_session_read_only(wasm_runner, small_model) -> None:
    ids = sorted(small_model.elements)
    sess = wasm_runner.open_session(
        small_model, "def value(els):\n    return dr.create('T', {})",
        RunLimits(), budget=ScriptBudget.start(60),
    )
    res = sess.call("value", [ids[0]])
    assert res.error is not None and "ReadOnlyError" in res.error.message
    sess.close()
```

- [ ] **Step 2: Run to verify failure (with the binary fetched)**

```bash
bash spikes/code_exec/fetch_python_wasi.sh
pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration -k session -v
```
Expected: FAIL — `AttributeError: open_session`.

- [ ] **Step 3: Guest bootstrap — embedded mode**

In `_GUEST_BOOTSTRAP_SOURCE`, restructure `_main()`: after reading `start`,
branch on `start.get("mode", "run")` — the existing body becomes
`_run_once(start)` unchanged; add:

```python
def _run_embedded(start):
    code = start["code"]
    facade_source = start["facade_source"]
    stdout = _CappedStdout(start["stdout_bytes"])
    namespace = {"_transport": _transport}
    err = None
    source = facade_source + "\n" + code
    try:
        compiled = compile(source, _SNIPPET_FILENAME, "exec")
    except SyntaxError as exc:
        err = {"kind": "syntax", "message": str(exc), "traceback": None}
        compiled = None
    if compiled is not None:
        sys.stdout = stdout
        try:
            exec(compiled, namespace)
        except MemoryError:
            sys.stdout = _real_stdout
            raise
        except Exception:
            err = {
                "kind": "runtime",
                "message": type(sys.exc_info()[1]).__name__ + ": " + str(sys.exc_info()[1]),
                "traceback": _format_guest_traceback(),
            }
        finally:
            sys.stdout = _real_stdout
    _emit({"boot": True, "error": err})
    if err is not None:
        return
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        msg = json.loads(line)
        if msg.get("close"):
            return
        call = msg.get("call")
        if call is None:
            continue
        entry = call["entry"]
        element_ids = call["element_ids"]
        cerr = None
        payload = None
        sys.stdout = stdout
        try:
            fn = namespace.get(entry)
            if fn is None or not callable(fn):
                raise NameError("entry function " + repr(entry) + " is not defined")
            els = [namespace["dr"].element(i) for i in element_ids]
            value = fn(els if entry == "value" else (els[0] if els else None))
            payload = namespace["_dr_serialize_entry_result"](entry, value)
        except MemoryError:
            sys.stdout = _real_stdout
            raise
        except Exception:
            cerr = {
                "kind": "runtime",
                "message": type(sys.exc_info()[1]).__name__ + ": " + str(sys.exc_info()[1]),
                "traceback": _format_guest_traceback(),
            }
        finally:
            sys.stdout = _real_stdout
        _emit({"call_result": {"payload": payload, "error": cerr}})
```

User `print()` output inside sessions is capped and DISCARDED (design: error
cells carry message/traceback only) — the shared `stdout` buffer exists so a
print-happy snippet can't flood guest memory.

- [ ] **Step 4: Host side — pump helper + `_WasmSnippetSession`**

Extract the message pump from `run()` into a private helper both paths share:

```python
    def _serve_until(
        self,
        inst: _PooledInstance,
        thread: threading.Thread,
        dispatcher: BridgeDispatcher,
        final_key: str,
        deadline: float,
    ) -> dict[str, Any] | None:
        """Serve bridge requests until a message carrying `final_key` arrives,
        the wall `deadline` passes, or the guest dies. Returns the final
        message or None. This is `run()`'s loop, factored so embedded sessions
        reuse the exact same pump for the boot ack and each call result."""
        while True:
            remaining = deadline - time.monotonic()
            read_budget = max(remaining, 0.0) + _TIMEOUT_READ_GRACE_S
            line = _readline_bounded(inst.host_out, thread, read_budget)
            if not line:
                return None
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("wasm guest sent a non-JSON line; ignoring")
                continue
            if not isinstance(msg, dict):
                logger.warning("wasm guest sent a non-dict JSON line; ignoring")
                continue
            if msg.get(final_key):
                return msg
            if "op" not in msg and "id" not in msg:
                continue
            resp = dispatcher.dispatch(msg)
            inst.host_in.write(json.dumps(resp) + "\n")
            inst.host_in.flush()
```

`run()` swaps its inline loop for `_serve_until(inst, thread, dispatcher, "fin", wall_deadline)`
(behavior identical — keep the existing surrounding arm/teardown code).

Add `open_session` + session class:

```python
    def open_session(
        self,
        model: Model,
        code: str,
        limits: RunLimits,
        *,
        budget: ScriptBudget,
    ) -> "_WasmSnippetSession":
        from data_rover.core.script.bridge import BridgeDispatcher

        if self._closed:
            raise RuntimeError("WasmScriptRunner is closed")
        inst = self._pool.get(timeout=_POOL_GET_TIMEOUT_S)  # queue.Empty propagates as in run()
        assert inst.thread is not None
        dispatcher = BridgeDispatcher(
            model,
            record_ops=False,  # sessions are read-only by construction
            max_ops=limits.max_ops,
            max_op_bytes=limits.max_op_bytes,
            page_limit=limits.page_limit,
        )
        return _WasmSnippetSession(self, inst, dispatcher, code, limits, budget)


class _WasmSnippetSession:
    """`SnippetSession` over one pooled guest instance (discarded on close).
    Boot (module exec) happens in __init__ under the same pump as calls; a
    guest death at ANY point promotes the mapped error into `boot_error`, so
    every later call fails fast and the evaluator error-cells the remainder."""

    def __init__(self, runner, inst, dispatcher, code, limits, budget) -> None:
        self._runner = runner
        self._inst = inst
        self._dispatcher = dispatcher
        self._limits = limits
        self._budget = budget
        self._closed = False
        self.boot_error: ScriptError | None = None

        deadline_s = min(limits.wall_timeout_s, max(budget.remaining(), 0.0))
        self._arm(deadline_s)
        start_msg = {
            "mode": "embedded",
            "code": code,
            "entry": "value",          # unused in embedded mode; kept for shape
            "element_ids": [],
            "facade_source": FACADE_SOURCE,
            "stdout_bytes": limits.stdout_bytes,
            "result_repr_bytes": limits.result_repr_bytes,
        }
        inst.host_in.write(json.dumps(start_msg) + "\n")
        inst.host_in.flush()
        wall_deadline = time.monotonic() + deadline_s + _TIMEOUT_READ_GRACE_S
        assert inst.thread is not None
        boot = runner._serve_until(inst, inst.thread, dispatcher, "boot", wall_deadline)
        if boot is None:
            self.boot_error = self._death_error(wall_deadline)
            return
        err = boot.get("error")
        if err is not None:
            self.boot_error = ScriptError(
                kind=err.get("kind", "runtime"),
                message=err.get("message", ""),
                traceback=err.get("traceback"),
            )
        else:
            self._idle()

    def _arm(self, deadline_s: float) -> None:
        # Safe cross-thread: only called while the guest is parked on stdin.
        if self._inst.store is not None:
            ticks = max(1, math.ceil(deadline_s / _EPOCH_TICK_INTERVAL_S)) + 1
            self._inst.store.set_epoch_deadline(ticks)

    def _idle(self) -> None:
        if self._inst.store is not None:
            self._inst.store.set_epoch_deadline(_IDLE_EPOCH_DEADLINE_TICKS)

    def _death_error(self, wall_deadline: float) -> ScriptError:
        if self._inst.thread is not None:
            self._inst.thread.join(timeout=_TEARDOWN_JOIN_TIMEOUT_S)
        return self._runner._map_guest_death(self._inst, self._limits, wall_deadline)

    def call(
        self, entry: Literal["value", "step"], element_ids: list[str]
    ) -> CallResult:
        t0 = time.perf_counter()
        if self.boot_error is not None or self._closed:
            return CallResult(
                value=None,
                error=self.boot_error
                or ScriptError(kind="cancelled", message="session closed"),
                duration_ms=0,
            )
        deadline_s = min(self._limits.wall_timeout_s, max(self._budget.remaining(), 0.0))
        self._arm(deadline_s)
        self._inst.host_in.write(
            json.dumps({"call": {"entry": entry, "element_ids": element_ids}}) + "\n"
        )
        self._inst.host_in.flush()
        wall_deadline = time.monotonic() + deadline_s + _TIMEOUT_READ_GRACE_S
        assert self._inst.thread is not None
        msg = self._runner._serve_until(
            self._inst, self._inst.thread, self._dispatcher, "call_result", wall_deadline
        )
        duration_ms = int((time.perf_counter() - t0) * 1000)
        if msg is None:
            # Guest died mid-call (epoch kill / crash): session is terminally
            # dead — promote so later calls fail fast.
            self.boot_error = self._death_error(wall_deadline)
            return CallResult(value=None, error=self.boot_error, duration_ms=duration_ms)
        self._idle()
        cr = msg["call_result"]
        err = cr.get("error")
        if err is not None:
            return CallResult(
                value=None,
                error=ScriptError(
                    kind=err.get("kind", "runtime"),
                    message=err.get("message", ""),
                    traceback=err.get("traceback"),
                ),
                duration_ms=duration_ms,
            )
        decoded, dmsg = decode_call_payload(entry, cr.get("payload"))
        if decoded is None:
            return CallResult(
                value=None,
                error=ScriptError(kind="runtime", message=dmsg or "malformed payload"),
                duration_ms=duration_ms,
            )
        return CallResult(value=decoded, error=None, duration_ms=duration_ms)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._inst.host_in.write(json.dumps({"close": True}) + "\n")
            self._inst.host_in.flush()
        except OSError:
            pass
        self._runner._teardown_instance(self._inst)
```

Imports to extend at the top of `script_runner.py`:
`CallResult, ScriptBudget, decode_call_payload` from `core.script.runner`,
plus `Literal` from `typing`.

- [ ] **Step 5: Run the integration tests, then the hermetic suite**

```bash
pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration -v
pixi run core-test
```
Expected: all PASS (hermetic suite unaffected — WASM changes are behind the
`mode` field defaulting to `"run"`).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/script_runner.py tests/api/test_snippets_wasm.py
git commit -m "feat(snippets): WASM embedded evaluation sessions — guest loop, per-call epoch deadlines"
```

---

## Task 15: Docs + full verification

**Files:**
- Modify: `src/data_rover/core/script/README.md`, `CLAUDE.md`

- [ ] **Step 1: `core/script/README.md`** — add an "Evaluation sessions (M2/M3)" section after the bridge-wire section covering: the `SnippetSession` protocol and `mode: "embedded"` start message; the `{"call"}`/`{"call_result"}`/`{"close"}` frames; the tagged return-value wire shapes and the `_dr_serialize_entry_result` ↔ `decode_call_payload` pairing; the read-only stance (`record_ops=False`) and that `print()` output is capped-and-discarded; `ScriptEvalContext` (sessions keyed by code, memo by `(code, entry, ids)`, warnings, budget); per-call deadline = `min(wall_timeout_s, budget remaining)`; determinism note that entry points mutating module globals fall outside the memo's soundness assumption. Update the `value` signature mentions if any predate the session work.

- [ ] **Step 2: `CLAUDE.md`** — in the "Code execution (snippets)" section, append a short M2/M3 paragraph: `ScriptColumn`/`ScriptStep` embed snippets in tables/navigations via `ScriptRunner.open_session` (one warm instance per evaluation; `ScriptEvalContext` memo/warnings/budget in `core/script/embed.py`); degraded-not-failed stance (error cells / pruned-with-warning, routes stay 200); cache-poisoning guard on `TableOrderCache`; `snippet_eval_budget_s` setting; embedded work takes one global slot from the shared concurrency guard (`api/snippet_concurrency.py`).

- [ ] **Step 3: Full verification**

```bash
pixi run core-test
pixi run dr-tidy
bash spikes/code_exec/fetch_python_wasi.sh && pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration -v
```
Expected: all PASS, tidy clean.

- [ ] **Step 4: Commit**

```bash
git add src/data_rover/core/script/README.md CLAUDE.md
git commit -m "docs(snippets): document M2/M3 evaluation sessions and embedded-eval invariants"
```

---

## Execution notes

- Tasks 1–4 are strictly sequential (each builds on the previous). Task 5 depends on 1; Task 6 on 5; Tasks 7–9 on 4+5+6; Tasks 10–13 on everything before them; Task 14 only on 1–2 (can run in parallel with 5–13 if desired); Task 15 last.
- The frontend half of M2/M3 is a separate plan: `docs/superpowers/plans/2026-07-19-code-execution-m2-m3-frontend.md` — execute it after this plan is green.
