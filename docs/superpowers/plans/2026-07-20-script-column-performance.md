# Script Column Performance Overhaul (A+B+C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whole-table script-column work never blocks a request: computed cells are cached per session (Phase A), whole-table passes run as a background sweep with pending cells + polling (Phase B), and sweeps shard across parallel guest workers (Phase C).

**Architecture:** A per-`Session` `ScriptCellCache` (keyed `(sha256(code), entry, ids)`, rev-stamped, wiped on `touch_model`/`set_model`) sits between `ScriptEvalContext`'s per-request memo and the guest. Whole-table passes (`build_rows_ex`/`order_rows`) run in `cache_only` mode where misses return a synthetic `pending` error-kind; the route then kicks/joins a per-session background `SweepJob` that fills the cache, and the response carries a `script_status` block the frontend polls on. Spec: `docs/superpowers/specs/2026-07-20-script-column-performance-design.md`.

**Tech Stack:** Python 3.14, FastAPI, pytest (hermetic; `TrustedRunner` for script tests), SvelteKit + vitest/MSW, wasmtime (integration tests only).

## Global Constraints

- Everything runs through pixi: `pixi run -e core-dev pytest …`, `pixi run dr-tidy` (ruff + mypy + pyright must ALL pass), frontend via `pixi run -e frontend bash -c 'cd frontend && …'`.
- API tests need no database and no real runner: use `tests/api/conftest.py`'s `client`/`seed_default_project`/`AUTH_HEADERS`/`papi` helpers; override the runner via `app.dependency_overrides[get_runner]`.
- `TrustedRunner` (`tests/script/trusted_runner.py`) must NEVER move into `src/`.
- Preserve the dense docstring style: docstrings explain *why* invariants exist.
- Core (`src/data_rover/core/**`) imports only `data_rover.core.*` + stdlib — never `api`.
- Reads stay lock-free (benign-race + sampled-rev poisoning guards); `touch_model`/`set_model` remain the single invalidation points.
- Commit after every task; messages `feat(script-cache): …` / `feat(script-sweep): …` style, ending with the Claude Code co-author trailer.

---

## Phase A — durable per-cell result cache

### Task 1: `ScriptCellCache` core class

**Files:**
- Create: `src/data_rover/core/script/cell_cache.py`
- Test: `tests/script/test_cell_cache.py`

**Interfaces:**
- Produces: `CellKey = tuple[str, str, tuple[str, ...]]` (`(code_sha256_hex, entry, element_ids)`); class `ScriptCellCache(cap: int = 50_000)` with `get(key: CellKey, rev: int) -> CallResult | None`, `put(key: CellKey, result: CallResult, rev: int) -> None`, `clear_and_stamp(rev: int) -> None`, property `stamp: int`, property `size: int`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/script/test_cell_cache.py
"""ScriptCellCache: rev stamping, LRU, error-kind filtering (spec §3.1)."""

from data_rover.core.script.cell_cache import ScriptCellCache
from data_rover.core.script.runner import CallResult, ScriptError

KEY = ("a" * 64, "value", ("e1",))


def _ok(v: object = 1) -> CallResult:
    return CallResult(value={"kind": "scalar", "value": v}, error=None, duration_ms=1)


def _err(kind: str) -> CallResult:
    return CallResult(value=None, error=ScriptError(kind=kind, message="x"), duration_ms=1)  # type: ignore[arg-type]


def test_put_get_roundtrip_at_stamped_rev() -> None:
    c = ScriptCellCache()
    c.clear_and_stamp(3)
    c.put(KEY, _ok(), 3)
    assert c.get(KEY, 3) is not None
    assert c.get(KEY, 4) is None  # rev mismatch misses
    assert c.get(KEY, 2) is None


def test_put_at_older_rev_rejected() -> None:
    c = ScriptCellCache()
    c.clear_and_stamp(5)
    c.put(KEY, _ok(), 4)  # stale writer (poisoning guard)
    assert c.get(KEY, 5) is None and c.size == 0


def test_put_at_newer_rev_self_stamps_and_clears() -> None:
    # Covers hydration paths that assign model_rev without touch_model: the
    # first write at a newer rev owns the cache.
    c = ScriptCellCache()
    c.clear_and_stamp(1)
    c.put(KEY, _ok(1), 1)
    c.put(("b" * 64, "value", ("e2",)), _ok(2), 7)
    assert c.stamp == 7
    assert c.get(KEY, 7) is None  # old-rev entry gone
    assert c.get(("b" * 64, "value", ("e2",)), 7) is not None


def test_error_kind_filtering() -> None:
    c = ScriptCellCache()
    c.clear_and_stamp(1)
    for kind in ("runtime", "syntax"):
        c.put((kind * 16, "value", ()), _err(kind), 1)
    for kind in ("timeout", "unavailable", "memory", "cancelled", "pending"):
        c.put((kind, "value", ()), _err(kind), 1)
    assert c.size == 2  # only deterministic kinds cached


def test_lru_eviction() -> None:
    c = ScriptCellCache(cap=2)
    c.clear_and_stamp(1)
    c.put(("k1", "value", ()), _ok(), 1)
    c.put(("k2", "value", ()), _ok(), 1)
    assert c.get(("k1", "value", ()), 1) is not None  # touch k1 -> k2 is LRU
    c.put(("k3", "value", ()), _ok(), 1)
    assert c.get(("k2", "value", ()), 1) is None
    assert c.get(("k1", "value", ()), 1) is not None
    assert c.get(("k3", "value", ()), 1) is not None
```

Note: `_err("pending")` type-ignores the Literal until Task 4 adds the kind; keep the ignore comment.

- [ ] **Step 2: Run tests, verify they fail**

Run: `pixi run -e core-dev pytest tests/script/test_cell_cache.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'data_rover.core.script.cell_cache'`

- [ ] **Step 3: Implement**

```python
# src/data_rover/core/script/cell_cache.py
"""Per-session cache of embedded snippet call results (spec 2026-07-20 §3.1).

Sound because of the WASM runner's determinism guarantee: same code + same
model ⇒ same output, so a result keyed by (code hash, entry, element ids) is
valid for as long as the model doesn't change. "The model didn't change" is
tracked by a REV STAMP rather than rev-in-key: `Session.touch_model`/
`set_model` call `clear_and_stamp(new_rev)`, and `put`/`get` at any other rev
are no-ops/misses — the same sampled-rev poisoning guard the table order
cache uses (a request that computed against a superseded model must never
write into the fresh cache; evaluation runs outside any lock, so a lost race
merely recomputes).

Self-stamping: a `put` at a rev NEWER than the stamp clears and re-stamps.
This covers paths that advance `model_rev` without running the invalidation
hooks (e.g. hydration assigning the DB-authoritative rev) — without it the
cache would silently reject every write until the next commit.

Error results: only DETERMINISTIC kinds (`runtime`, `syntax`) are cached —
they reproduce identically, so recomputing them is pure waste. Environmental
kinds (`timeout`, `unavailable`, `memory`, `cancelled`, and the synthetic
`pending`) must stay retryable and are silently not stored; `put` enforces
this itself so no caller can poison the cache with a transient failure.
"""

from __future__ import annotations

import threading
from collections import OrderedDict

from .runner import CallResult

#: (sha256(code).hexdigest(), entry, element_ids) — code is hashed so keys
#: stay small; ScriptEvalContext computes the hash once per distinct code.
CellKey = tuple[str, str, tuple[str, ...]]

_CACHEABLE_ERROR_KINDS = frozenset({"runtime", "syntax"})


class ScriptCellCache:
    def __init__(self, cap: int = 50_000) -> None:
        self._cap = cap
        self._lock = threading.Lock()
        self._stamp = 0
        self._d: OrderedDict[CellKey, CallResult] = OrderedDict()

    def get(self, key: CellKey, rev: int) -> CallResult | None:
        with self._lock:
            if rev != self._stamp:
                return None
            hit = self._d.get(key)
            if hit is not None:
                self._d.move_to_end(key)
            return hit

    def put(self, key: CellKey, result: CallResult, rev: int) -> None:
        if (
            result.error is not None
            and result.error.kind not in _CACHEABLE_ERROR_KINDS
        ):
            return
        with self._lock:
            if rev < self._stamp:
                return  # stale writer: poisoning guard
            if rev > self._stamp:
                self._d.clear()
                self._stamp = rev
            self._d[key] = result
            self._d.move_to_end(key)
            while len(self._d) > self._cap:
                self._d.popitem(last=False)

    def clear_and_stamp(self, rev: int) -> None:
        with self._lock:
            self._d.clear()
            self._stamp = rev

    @property
    def stamp(self) -> int:
        with self._lock:
            return self._stamp

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._d)
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pixi run -e core-dev pytest tests/script/test_cell_cache.py -v`
Expected: 5 PASS (the `pending` line in the filtering test passes because unknown kinds are simply not in `_CACHEABLE_ERROR_KINDS`).

- [ ] **Step 5: Lint + commit**

```bash
pixi run core-lint
git add src/data_rover/core/script/cell_cache.py tests/script/test_cell_cache.py
git commit -m "feat(script-cache): add rev-stamped per-session ScriptCellCache"
```

### Task 2: Wire the cache into `ScriptEvalContext`

**Files:**
- Modify: `src/data_rover/core/script/embed.py`
- Test: `tests/script/test_embed_cache.py`

**Interfaces:**
- Consumes: `ScriptCellCache`, `CellKey` from Task 1.
- Produces: `ScriptEvalContext.__init__(..., cell_cache: ScriptCellCache | None = None, rev: int = 0)`; `call()` resolution order memo → cell cache → guest with write-through. (The `cache_only` mode comes in Task 4 — do NOT add it here.)

- [ ] **Step 1: Write the failing tests**

Use a minimal fake runner (per-test, no sandbox) that counts guest calls:

```python
# tests/script/test_embed_cache.py
"""ScriptEvalContext × ScriptCellCache: write-through, cross-context reuse,
rev-mismatch miss, non-deterministic errors not written (spec §3.2)."""

from typing import Literal

from data_rover.core.script.cell_cache import ScriptCellCache
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import (
    CallResult,
    RunLimits,
    ScriptBudget,
    ScriptError,
)


class _FakeSession:
    boot_error = None

    def __init__(self, outcome: CallResult, counter: list[int]) -> None:
        self._outcome = outcome
        self._counter = counter

    def call(self, entry: Literal["value", "step"], element_ids: list[str]) -> CallResult:
        self._counter[0] += 1
        return self._outcome

    def close(self) -> None:
        pass


class _FakeRunner:
    def __init__(self, outcome: CallResult) -> None:
        self.calls = [0]
        self._outcome = outcome

    def open_session(self, model, code, limits, *, budget):
        return _FakeSession(self._outcome, self.calls)

    def run(self, *a, **k):  # pragma: no cover - protocol completeness
        raise NotImplementedError


OK = CallResult(value={"kind": "scalar", "value": 5}, error=None, duration_ms=1)
TIMEOUT = CallResult(
    value=None, error=ScriptError(kind="timeout", message="t"), duration_ms=1
)


def _ctx(runner, cache: ScriptCellCache | None, rev: int = 1) -> ScriptEvalContext:
    return ScriptEvalContext(
        runner, object(), RunLimits(), ScriptBudget.start(60), cell_cache=cache, rev=rev
    )


def test_cross_context_reuse() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(OK)
    c1 = _ctx(runner, cache)
    assert c1.call("def value(e): ...", "value", ["e1"]).error is None
    c1.close()
    c2 = _ctx(runner, cache)  # fresh request, same session cache
    assert c2.call("def value(e): ...", "value", ["e1"]).error is None
    c2.close()
    assert runner.calls[0] == 1  # second context never hit the guest


def test_rev_mismatch_misses_and_does_not_poison() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(2)
    runner = _FakeRunner(OK)
    c = _ctx(runner, cache, rev=1)  # request raced a commit: older rev
    c.call("code", "value", ["e1"])
    c.close()
    assert cache.size == 0  # stale write rejected
    assert runner.calls[0] == 1


def test_environmental_error_not_written() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(TIMEOUT)
    c = _ctx(runner, cache)
    assert c.call("code", "value", ["e1"]).error.kind == "timeout"
    c.close()
    assert cache.size == 0
    c2 = _ctx(runner, cache)
    c2.call("code", "value", ["e1"])  # retried, not served from cache
    c2.close()
    assert runner.calls[0] == 2


def test_no_cache_still_works() -> None:
    runner = _FakeRunner(OK)
    c = _ctx(runner, None)
    assert c.call("code", "value", ["e1"]).error is None
    c.close()
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pixi run -e core-dev pytest tests/script/test_embed_cache.py -v`
Expected: FAIL — `TypeError: ScriptEvalContext.__init__() got an unexpected keyword argument 'cell_cache'`

- [ ] **Step 3: Implement**

In `src/data_rover/core/script/embed.py`: add `import hashlib` and `from .cell_cache import CellKey, ScriptCellCache`; extend `__init__` and `call`:

```python
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
    ) -> None:
        # ... existing body unchanged, plus:
        self._cell_cache = cell_cache
        self._rev = rev
        self._code_sha: dict[str, str] = {}

    def _cell_key(self, code: str, entry: str, ids: tuple[str, ...]) -> CellKey:
        sha = self._code_sha.get(code)
        if sha is None:
            sha = hashlib.sha256(code.encode()).hexdigest()
            self._code_sha[code] = sha
        return (sha, entry, ids)

    def call(
        self, code: str, entry: Literal["value", "step"], element_ids: list[str]
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
        res = self._call_uncached(code, entry, element_ids)
        if res.error is not None:
            self.errored = True
        self._memo[key] = res
        if self._cell_cache is not None and ckey is not None:
            # put() filters non-deterministic error kinds itself
            self._cell_cache.put(ckey, res, self._rev)
        return res
```

Update the module docstring's memo bullet: calls are memoized per-request AND write through to the session-level `ScriptCellCache` (spec §3), which makes results durable across requests within one model rev.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pixi run -e core-dev pytest tests/script/ -v`
Expected: new file 4 PASS; all existing `tests/script/` tests still PASS.

- [ ] **Step 5: Lint + commit**

```bash
pixi run core-lint
git add -A && git commit -m "feat(script-cache): ScriptEvalContext reads/writes the session cell cache"
```

### Task 3: Session + route wiring (Phase A complete)

**Files:**
- Modify: `src/data_rover/api/session.py` (field + `touch_model` + `set_model`)
- Modify: `src/data_rover/api/script_eval.py` (`open_script_context` signature)
- Modify: `src/data_rover/api/routes/tables.py:182,285` and `src/data_rover/api/routes/artifacts.py:282` (pass cache + rev)
- Test: `tests/api/test_script_cell_cache_api.py`

**Interfaces:**
- Produces: `Session.script_cell_cache: ScriptCellCache`; `open_script_context(runner, model, settings, *, needs_script, cell_cache=None, rev=0)` — later tasks rely on these exact names.

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_script_cell_cache_api.py
"""Phase A end-to-end: two evaluates of the same script table hit the guest
once; a commit (touch_model) wipes the cache."""

from typing import Literal

from data_rover.api.script_runner import get_runner
from data_rover.api.session import get_session
from data_rover.core.script.runner import CallResult, RunLimits, ScriptBudget

from .conftest import AUTH_HEADERS, papi  # match existing helper imports


class _CountingRunner:
    def __init__(self) -> None:
        self.calls = 0

    def open_session(self, model, code, limits, *, budget):
        runner = self

        class _S:
            boot_error = None

            def call(self, entry: Literal["value", "step"], element_ids: list[str]):
                runner.calls += 1
                return CallResult(
                    value={"kind": "scalar", "value": len(element_ids)},
                    error=None,
                    duration_ms=0,
                )

            def close(self) -> None:
                pass

        return _S()

    def run(self, *a, **k):  # pragma: no cover
        raise NotImplementedError


TABLE = {
    "definition": {
        "schema_version": 1,
        "row_source": {"kind": "scope", "types": []},
        "columns": [
            {"kind": "element", "source": {"kind": "row", "chain_index": 0}},
            {
                "kind": "script",
                "source": {"kind": "row", "chain_index": 0},
                "snippet": {
                    "definition": {
                        "schema_version": 1,
                        "language": "python",
                        "code": "def value(elements):\n    return len(elements)",
                    }
                },
                "mode": "collapse",
                "keep_empty": True,
            },
        ],
    },
    "offset": 0,
    "limit": 100,
}


def test_second_evaluate_serves_from_cell_cache(client, seed_default_project) -> None:
    counting = _CountingRunner()
    client.app.dependency_overrides[get_runner] = lambda: counting
    try:
        r1 = client.post(papi("/tables/evaluate"), json=TABLE, headers=AUTH_HEADERS)
        assert r1.status_code == 200
        first = counting.calls
        assert first > 0
        r2 = client.post(papi("/tables/evaluate"), json=TABLE, headers=AUTH_HEADERS)
        assert r2.status_code == 200
        assert counting.calls == first  # all cell-cache hits
        get_session().touch_model()  # out-of-protocol mutation wipes the cache
        r3 = client.post(papi("/tables/evaluate"), json=TABLE, headers=AUTH_HEADERS)
        assert r3.status_code == 200
        assert counting.calls > first
    finally:
        client.app.dependency_overrides.pop(get_runner, None)
```

Adapt imports/fixture names to `tests/api/conftest.py`'s actual exports (read it first; `papi` prefixes the default project path). The seeded default project must have a loaded model — reuse whatever fixture existing `tests/api` table tests (`grep -l tables/evaluate tests/api`) use to get a model in place, and copy their seeding lines exactly.

- [ ] **Step 2: Run test, verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_script_cell_cache_api.py -v`
Expected: FAIL — second evaluate re-calls the guest (`counting.calls == first` assertion).

- [ ] **Step 3: Implement wiring**

`session.py` — new field next to `table_order_cache` (import `ScriptCellCache` from `data_rover.core.script.cell_cache`):

```python
    #: per-session cache of embedded snippet call results (spec 2026-07-20
    #: §3). Rev-stamped; cleared by the same two invalidation points as
    #: table_order_cache. Sound because of the runner determinism guarantee.
    script_cell_cache: ScriptCellCache = field(
        default_factory=ScriptCellCache, repr=False
    )
```

Append to BOTH `set_model` (after `self.model_rev += 1`) and `touch_model` (after `self.model_rev += 1`):

```python
        self.script_cell_cache.clear_and_stamp(self.model_rev)
```

`script_eval.py` — thread the two new params through all three constructor calls (including both degraded modes, so a "busy" request at least reads the cache):

```python
def open_script_context(
    runner: ScriptRunner | None,
    model: Model | None,
    settings: Settings,
    *,
    needs_script: bool,
    cell_cache: ScriptCellCache | None = None,
    rev: int = 0,
) -> tuple[ScriptEvalContext | None, bool]:
```

Each `ScriptEvalContext(...)` call gains `cell_cache=cell_cache, rev=rev`.

`routes/tables.py` (both call sites — note `rev = session.model_rev` already exists just above the evaluate-route call site; the export route must add `rev = session.model_rev` before its call) and `routes/artifacts.py:282`:

```python
        script_ctx, acquired = open_script_context(
            runner, model, settings, needs_script=...,
            cell_cache=session.script_cell_cache, rev=rev,
        )
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_script_cell_cache_api.py tests/api -x -q`
Expected: new test PASS, full `tests/api` suite PASS.

- [ ] **Step 5: Full check + commit**

```bash
pixi run core-test && pixi run dr-tidy
git add -A && git commit -m "feat(script-cache): session-level cell cache wired through evaluate routes"
```

**Phase A is shippable here** — the infinite re-grind loop is gone (requests converge across retries).

---

## Phase B — background sweep + pending cells + polling

### Task 4: `pending` error kind + `cache_only` mode

**Files:**
- Modify: `src/data_rover/core/script/runner.py` (extend `ScriptError.kind` Literal)
- Modify: `src/data_rover/core/script/embed.py`
- Test: `tests/script/test_embed_cache.py` (extend)

**Interfaces:**
- Produces: `ScriptError.kind` gains `"pending"`; `ScriptEvalContext(..., cache_only: bool = False)` attribute (mutable, route flips it between phases); `ScriptEvalContext.call(..., *, cache_only: bool | None = None)` per-call override; counter `ScriptEvalContext.pending_misses: int`. Pending results are NEVER memoized, NEVER cached, NEVER set `errored`.

- [ ] **Step 1: Write the failing tests** (append to `tests/script/test_embed_cache.py`)

```python
def test_cache_only_miss_is_pending_not_guest() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(OK)
    c = _ctx(runner, cache)
    c.cache_only = True
    res = c.call("code", "value", ["e1"])
    assert res.error is not None and res.error.kind == "pending"
    assert runner.calls[0] == 0
    assert c.pending_misses == 1
    assert not c.errored  # pending is not poison
    # NOT memoized: flipping to live mode computes for real
    c.cache_only = False
    assert c.call("code", "value", ["e1"]).error is None
    assert runner.calls[0] == 1
    c.close()


def test_cache_only_hit_served() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(OK)
    warm = _ctx(runner, cache)
    warm.call("code", "value", ["e1"])
    warm.close()
    c = _ctx(runner, cache)
    c.cache_only = True
    assert c.call("code", "value", ["e1"]).error is None
    assert c.pending_misses == 0
    c.close()


def test_per_call_override_forces_cache_only() -> None:
    cache = ScriptCellCache()
    cache.clear_and_stamp(1)
    runner = _FakeRunner(OK)
    c = _ctx(runner, cache)  # ctx-level mode is live
    res = c.call("code", "value", ["e1"], cache_only=True)
    assert res.error is not None and res.error.kind == "pending"
    assert runner.calls[0] == 0
    c.close()
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pixi run -e core-dev pytest tests/script/test_embed_cache.py -v`
Expected: new tests FAIL (`cache_only` unknown attribute / kwarg).

- [ ] **Step 3: Implement**

`runner.py`: extend the Literal (both the docstring table and the annotation):

```python
    kind: Literal[
        "syntax", "runtime", "timeout", "cancelled", "memory", "limit",
        "unavailable", "pending",
    ]
```

Docstring addition: `"pending"` — synthetic, produced only by `ScriptEvalContext` in cache-only mode (spec §4.1): the value is not computed yet; a background sweep is (or will be) filling it in. Never produced by a runner, never cached.

`embed.py`: `__init__` gains `cache_only: bool = False` → `self.cache_only = cache_only`; `self.pending_misses = 0`. In `call()`, after the memo and cell-cache probes and BEFORE `_call_uncached`:

```python
        if cache_only if cache_only is not None else self.cache_only:
            self.pending_misses += 1
            return CallResult(
                value=None,
                error=ScriptError(kind="pending", message="not computed yet"),
                duration_ms=0,
            )
```

(signature: `def call(self, code, entry, element_ids, *, cache_only: bool | None = None)`.) Update the module docstring: pending is a first-class degradation the table layer renders as a placeholder, not an error; it is deliberately not memoized so the same context can serve live window calls after the whole-table cache-only pass.

- [ ] **Step 4: Run + commit**

Run: `pixi run -e core-dev pytest tests/script -q` → all PASS. `pixi run core-lint`.

```bash
git add -A && git commit -m "feat(script-sweep): cache_only mode with synthetic pending results"
```

### Task 5: `PendingCell` through the table core + API schema

**Files:**
- Modify: `src/data_rover/core/table/cells.py`
- Modify: `src/data_rover/api/routes/tables.py` (`_cell_out`)
- Modify: `src/data_rover/api/schemas.py` (`TableCellOut.kind`)
- Modify: `src/data_rover/api/table_export.py` (pending → `#ERROR`; check the workbook builder's cell dispatch and add the case)
- Test: `tests/table/test_script_column.py` (extend)

**Interfaces:**
- Produces: `@dataclass class PendingCell` (no fields) added to the `Cell` union in `cells.py`; `TableCellOut.kind` Literal gains `"pending"`.

- [ ] **Step 1: Write the failing tests** (append to `tests/table/test_script_column.py`, reusing that file's existing fixtures/model builders — read it first and mirror its helper style)

```python
def test_pending_cell_from_cache_only_context(...existing fixtures...) -> None:
    # Build the file's standard script-column table; construct a
    # ScriptEvalContext with a runner but cache_only=True and an empty cache.
    ctx = ScriptEvalContext(runner, model, RunLimits(), ScriptBudget.start(60),
                            cell_cache=ScriptCellCache(), rev=0, cache_only=True)
    cells = evaluate_cells(mm, model, defn, keys, script=ctx)
    assert isinstance(cells[0][1], PendingCell)
    assert not ctx.errored and ctx.pending_misses > 0


def test_expand_rederive_is_cache_only(...) -> None:
    # An expand script column whose build promoted None (pending) must NOT
    # trigger a live guest call at cell-render time: assert the fake runner's
    # call count stays 0 when evaluate_cells runs with a LIVE (cache_only=
    # False) context but the expand binding is None and the cache is empty.
    assert isinstance(cell, PendingCell)
    assert fake_runner.calls[0] == 0
```

Write these as full tests against the file's real fixtures — the shapes above fix the assertions; the arrange sections must reuse the module's existing `tiny`-model builders verbatim.

- [ ] **Step 2: Run tests, verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_script_column.py -v`
Expected: FAIL — `PendingCell` not defined.

- [ ] **Step 3: Implement**

`cells.py` — new dataclass + union member:

```python
@dataclass
class PendingCell:
    """A script cell whose value is not computed yet (cache-only miss, spec
    §4.2): a background sweep is filling it. Renders as a placeholder, never
    as an error; sorts with empties; exports as #ERROR only in the
    failed-sweep path (a completed sweep leaves no pending cells)."""


Cell = ElementCell | ValueCell | ValuesCell | ElementsCell | ErrorCell | PendingCell
```

`_script_cell` changes (two spots):

1. Collapse branch — after `res = script.call(...)` (line ~309), BEFORE the generic error branch:

```python
    if res.error is not None and res.error.kind == "pending":
        return PendingCell()
```

2. Expand re-derive branch (line ~289) — force cache-only (the row shape is unknown, so a live call here could not change the single-row rendering anyway; recomputing it live would also bypass sweep accounting):

```python
                res = script.call(
                    col.snippet.definition.code, "value", roots, cache_only=True
                )
                if res.error is not None:
                    if res.error.kind == "pending":
                        return PendingCell()
                    return ErrorCell(
                        message=res.error.message, traceback=res.error.traceback
                    )
```

`schemas.py`: `kind: Literal["element", "value", "values", "elements", "error", "pending"]`.

`routes/tables.py` `_cell_out` — add before the final `assert`:

```python
    if isinstance(cell, PendingCell):
        return TableCellOut(kind="pending")
```

`table_export.py`: find where `ErrorCell` maps to `#ERROR` in the workbook builder and give `PendingCell` the same rendering (only reachable when exporting a failed sweep, Task 8).

Also confirm no change needed in `evaluate.py`: `_collapse_has_value` treats any error (incl. pending) as has-value → pending rows are KEPT, `_expand_values` promotes `[None]` → one pending row, `_sort_value` sorts pending with empties. Add one line to each of those three docstrings naming `pending` explicitly.

- [ ] **Step 4: Run + commit**

Run: `pixi run -e core-dev pytest tests/table tests/api -q` → PASS. `pixi run dr-tidy`.

```bash
git add -A && git commit -m "feat(script-sweep): PendingCell through cells/schema/export"
```

### Task 6: sweep module, registry, settings, session invalidation

**Files:**
- Create: `src/data_rover/api/script_sweep.py`
- Modify: `src/data_rover/api/settings.py` (5 new fields)
- Modify: `src/data_rover/api/session.py` (registry field, invalidation, evict cancel)
- Test: `tests/api/test_script_sweep.py`

**Interfaces:**
- Consumes: `ScriptEvalContext` (Task 4), `Session.script_cell_cache` (Task 3).
- Produces:
  - `SweepJob` dataclass: `fingerprint: str`, `rev: int`, `state: Literal["running","done","failed"]`, `done: int`, `total: int | None`, `message: str | None`, `cancel: threading.Event`.
  - `ScriptSweepRegistry`: `get(fingerprint, rev) -> SweepJob | None`, `kick(fingerprint, rev, start) -> SweepJob` (get-or-create; an existing job at the same `(fingerprint, rev)` — running, done or **failed** — is returned as-is: failed-job memory), `cancel_all() -> None`.
  - `kick_or_join_sweep(session, metamodel, model, defn, runner, settings, rev) -> SweepJob` — computes the sort-less fingerprint internally via `table_fingerprint(TABLE_ADAPTER.dump_json(defn).decode(), None)`.
  - Settings: `snippet_cell_cache_max: int = 50_000` (pass to `ScriptCellCache` where `Session` constructs it — switch the field to a `default_factory` lambda reading `get_settings()`, or simplest: leave the dataclass default and have `SessionRegistry` construct sessions with the setting; pick the one matching how `Session` gets built in `session.py` and document it), `snippet_sweep_workers: int = 4`, `snippet_sweep_ceiling_s: float = 600.0`, `snippet_sweep_timeout_abort: int = 3`, `snippet_sweep_sync: bool = False`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_script_sweep.py
"""SweepJob lifecycle against TrustedRunner-style fakes, sync mode (spec §4.3).

Uses the counting fake runner from test_script_cell_cache_api (extract it to a
small shared helper in tests/api/_script_fakes.py in this task) plus a
DelayableRunner variant whose call() outcome is scripted per element id, so
timeout sequences are deterministic."""


def test_sweep_fills_cache_and_completes(session_with_model, settings_sync_sweep):
    # kick_or_join_sweep with snippet_sweep_sync=True runs inline
    job = kick_or_join_sweep(session, mm, model, defn, runner, settings, rev)
    assert job.state == "done"
    assert job.done == job.total == n_rows
    # every cell now served cache-only
    ctx = ScriptEvalContext(runner, model, RunLimits(), ScriptBudget.start(60),
                            cell_cache=session.script_cell_cache, rev=rev,
                            cache_only=True)
    built = build_rows_ex(mm, model, defn, script=ctx)
    order_rows(mm, model, defn, built.keys, SortSpec(column=1, direction="asc"), script=ctx)
    assert ctx.pending_misses == 0


def test_kick_is_idempotent_and_failed_jobs_are_remembered(...):
    job1 = kick_or_join_sweep(...)   # runner scripted to time out on every call
    assert job1.state == "failed"
    assert "consecutive timeouts" in (job1.message or "")
    calls_after_fail = runner.calls[0]
    job2 = kick_or_join_sweep(...)   # same (fingerprint, rev)
    assert job2 is job1              # no re-kick, no new guest calls
    assert runner.calls[0] == calls_after_fail


def test_consecutive_timeout_abort_resets_on_success(...):
    # outcomes: T T OK T T OK ... never 3 consecutive -> completes (state done)


def test_ceiling_abort(...):
    # settings.snippet_sweep_ceiling_s = 0 -> immediate failed with ceiling message


def test_touch_model_cancels_and_new_rev_rekicks(...):
    # async mode with a slow runner: kick, then session.touch_model();
    # job.cancel is set; registry.get(fp, old_rev) is None at the new rev


def test_evict_cancels_sweeps(...):
    # SessionRegistry.evict on a session with a running job sets cancel and
    # DOES evict (sweeps never block eviction)
```

Flesh each `...` out against the real fixtures; the assertions above are the contract. Sync mode comes from settings the same way `validation_sweep_sync` is pinned — find how `tests/api/conftest.py` pins that setting and mirror it in a local fixture (`settings_sync_sweep`) that pins `DATA_ROVER_SNIPPET_SWEEP_SYNC=true`.

- [ ] **Step 2: Run tests, verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_script_sweep.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.api.script_sweep`.

- [ ] **Step 3: Implement**

```python
# src/data_rover/api/script_sweep.py
"""Background whole-table script evaluation (spec 2026-07-20 §4.3).

A SweepJob computes every script-column cell of ONE resolved table definition
at ONE model rev, writing results into the session's ScriptCellCache. The job
key deliberately EXCLUDES the sort: `_sort_value` calls the same
(code, "value", ids) keys as cell rendering, so one sweep serves every sort
order, the keep_empty filter, cell rendering, and export.

Failed-job memory: a job aborted by a pathology guard stays registered for
its (fingerprint, rev) and is returned as-is by kick() — WITHOUT it the next
poll would restart the grind, because timeouts are deliberately not cached.
touch_model/set_model cancel-and-clear the registry, so the next commit
retries naturally.

Reads run lock-free (benign-race stance): the job aborts when
session.model_rev moves, and cache writes are rev-stamped, so a raced commit
merely wastes the job's remaining work, never poisons anything.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import ScriptBudget, ScriptRunner
from data_rover.core.table.evaluate import (
    TableLimits,
    build_rows_ex,
    resolve_source_elements,
)
from data_rover.core.table.schema import TABLE_ADAPTER, ScriptColumn, TableDefinition

from .script_runner import run_limits_from_settings
from .settings import Settings
from .table_cache import table_fingerprint

if TYPE_CHECKING:
    from .session import Session

logger = logging.getLogger(__name__)


@dataclass
class SweepJob:
    fingerprint: str
    rev: int
    state: Literal["running", "done", "failed"] = "running"
    done: int = 0
    total: int | None = None
    message: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)


class ScriptSweepRegistry:
    """Per-session job table + a run lock serializing job threads (one active
    sweep per session; queued jobs block their own daemon thread on the lock,
    a natural FIFO for the handful of tables a user flips between)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._run_lock = threading.Lock()
        self._jobs: dict[str, SweepJob] = {}

    def get(self, fingerprint: str, rev: int) -> SweepJob | None:
        with self._lock:
            job = self._jobs.get(fingerprint)
            return job if job is not None and job.rev == rev else None

    def kick(self, fingerprint: str, rev: int, start) -> SweepJob:
        created = False
        with self._lock:
            job = self._jobs.get(fingerprint)
            if job is None or job.rev != rev:
                job = SweepJob(fingerprint=fingerprint, rev=rev)
                self._jobs[fingerprint] = job
                created = True
        if created:
            start(job)
        return job

    def cancel_all(self) -> None:
        with self._lock:
            jobs = list(self._jobs.values())
            self._jobs.clear()
        for j in jobs:
            j.cancel.set()


def kick_or_join_sweep(
    session: Session,
    metamodel: Metamodel,
    model: Model,
    defn: TableDefinition,
    runner: ScriptRunner,
    settings: Settings,
    rev: int,
) -> SweepJob:
    fp = table_fingerprint(TABLE_ADAPTER.dump_json(defn).decode(), None)

    def _start(job: SweepJob) -> None:
        if settings.snippet_sweep_sync:
            _run(session, metamodel, model, defn, runner, settings, job)
        else:
            threading.Thread(
                target=_run,
                args=(session, metamodel, model, defn, runner, settings, job),
                name="script-sweep",
                daemon=True,
            ).start()

    return session.script_sweeps.kick(fp, rev, _start)


def reset_global_slots() -> None:
    """Test seam: drop the lazily-sized process-wide semaphore so a test that
    pins different sweep settings gets a freshly sized one (mirrors the other
    `reset_*` seams, e.g. `script_runner.reset_runner`). Call from the api
    conftest's per-test cleanup."""
    global _global_slots
    with _global_slots_lock:
        _global_slots = None


def _aborted(session: Session, job: SweepJob) -> bool:
    return job.cancel.is_set() or session.model_rev != job.rev


def _fail(job: SweepJob, message: str) -> None:
    job.state = "failed"
    job.message = message


#: Process-wide bound on concurrently RUNNING sweep jobs (spec §4.3: sweeps
#: get their own pool, bounded across ALL sessions — N open projects must not
#: mean N×workers guest instances). Lazily sized from settings on first use.
_global_slots: threading.BoundedSemaphore | None = None
_global_slots_lock = threading.Lock()


def _acquire_global_slot(settings: Settings) -> threading.BoundedSemaphore:
    global _global_slots
    with _global_slots_lock:
        if _global_slots is None:
            _global_slots = threading.BoundedSemaphore(
                max(1, settings.snippet_sweep_workers)
            )
        return _global_slots


def _run(
    session: Session,
    metamodel: Metamodel,
    model: Model,
    defn: TableDefinition,
    runner: ScriptRunner,
    settings: Settings,
    job: SweepJob,
) -> None:
    try:
        slot = _acquire_global_slot(settings)
        with slot, session.script_sweeps._run_lock:
            if _aborted(session, job):
                return
            _run_inner(session, metamodel, model, defn, runner, settings, job)
    except Exception:
        logger.exception("script sweep failed for table %s", job.fingerprint[:12])
        _fail(job, "internal sweep error")


def _run_inner(
    session: Session,
    metamodel: Metamodel,
    model: Model,
    defn: TableDefinition,
    runner: ScriptRunner,
    settings: Settings,
    job: SweepJob,
) -> None:
    limits = run_limits_from_settings(settings)
    budget = ScriptBudget.start(settings.snippet_sweep_ceiling_s)
    ctx = ScriptEvalContext(
        runner, model, limits, budget,
        cell_cache=session.script_cell_cache, rev=job.rev,
    )
    try:
        # Serial prefix: computes (and caches) every expand/keep_empty/
        # script-as-source item in dependency order.
        built = build_rows_ex(metamodel, model, defn, TableLimits(), script=ctx)
        if _aborted(session, job):
            return
        script_cols = [
            c for c in defn.columns
            if isinstance(c, ScriptColumn)
            and c.mode != "expand"           # expand items were built above
            and c.snippet.definition is not None
        ]
        expand_count = sum(
            1 for c in defn.columns if getattr(c, "mode", "collapse") == "expand"
        )
        base_slots = (len(built.keys[0]) - expand_count) if built.keys else 1
        job.total = len(built.keys) * len(script_cols)
        consecutive_timeouts = 0
        for key in built.keys:
            for col in script_cols:
                if _aborted(session, job):
                    return
                if budget.exhausted:
                    _fail(
                        job,
                        f"sweep ceiling ({settings.snippet_sweep_ceiling_s:g}s) exceeded",
                    )
                    return
                roots = resolve_source_elements(
                    metamodel, model, defn, key, col.source, base_slots,
                    TableLimits(), script=ctx,
                )
                if roots:
                    res = ctx.call(col.snippet.definition.code, "value", roots)
                    if res.error is not None and res.error.kind == "timeout":
                        consecutive_timeouts += 1
                        if consecutive_timeouts >= settings.snippet_sweep_timeout_abort:
                            _fail(
                                job,
                                f"aborted after {consecutive_timeouts} "
                                "consecutive snippet timeouts",
                            )
                            return
                    else:
                        consecutive_timeouts = 0
                job.done += 1
        job.state = "done"
    finally:
        ctx.close()
```

`settings.py` — add after `snippet_eval_budget_s` (with the repo's docstring style, one per field):

```python
    snippet_cell_cache_max: int = 50_000
    snippet_sweep_workers: int = 4
    snippet_sweep_ceiling_s: float = 600.0
    snippet_sweep_timeout_abort: int = 3
    snippet_sweep_sync: bool = False
```

`session.py`:
- field `script_sweeps: ScriptSweepRegistry = field(default_factory=ScriptSweepRegistry, repr=False)` (import from `.script_sweep` — verify no import cycle: `script_sweep` imports `Session` only under `TYPE_CHECKING`).
- `touch_model` and `set_model`: add `self.script_sweeps.cancel_all()` next to the cache clear.
- `SessionRegistry.evict`: inside the `write_mutex` block, BEFORE the guard `if` (sweeps must never block eviction), add `session.script_sweeps.cancel_all()`. Do NOT add sweeps to the guard condition.
- Where `Session` gets `snippet_cell_cache_max`: if `Session()` is constructed with defaults only, keep the dataclass default (50k) and have the setting consumed at construction site in `SessionRegistry` (`ScriptCellCache(cap=get_settings().snippet_cell_cache_max)`); match whichever construction pattern `session.py` actually uses and note it in the field docstring.

- [ ] **Step 4: Run + commit**

Run: `pixi run -e core-dev pytest tests/api/test_script_sweep.py tests/api -q` → PASS. `pixi run dr-tidy`.

```bash
git add -A && git commit -m "feat(script-sweep): background sweep jobs with failed-job memory and pathology guards"
```

### Task 7: `/tables/evaluate` — cache-only pass, degrade, kick, `script_status`

**Files:**
- Modify: `src/data_rover/api/schemas.py` (`ScriptStatusOut`, `TablePageOut.script_status`)
- Modify: `src/data_rover/api/routes/tables.py` (`evaluate_table`)
- Test: `tests/api/test_tables_script_status.py`

**Interfaces:**
- Produces: `class ScriptStatusOut(BaseModel): state: Literal["ready","computing","failed"]; done: int = 0; total: int | None = None; message: str | None = None`; `TablePageOut.script_status: ScriptStatusOut | None = None`. Frontend (Task 9) relies on these exact field names.

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_tables_script_status.py
"""Evaluate-route Phase B behavior (spec §4.1-4.2): whole-table passes are
cache-only; pending kicks a sweep; degraded shape while computing; ready
shape after; failed surfaces; order cache skipped while pending.

Runner fakes from tests/api/_script_fakes.py; sweep pinned SYNC for the
"after" tests and ASYNC-with-blocked-runner for the "while computing" tests.
"""

# Key cases (write in full):

def test_sorted_script_table_while_computing(...):
    # async sweep, runner blocked on an Event: response 200 within ~1s,
    # script_status.state == "computing", rows in BUILD order,
    # window script cells kind == "pending"... EXCEPT the visible window's
    # collapse cells, which are computed live (guest-enabled window phase)
    # once the concurrency slot allows. With the blocked runner they render
    # "pending"? No: live calls run and BLOCK. So: window cells use a FAST
    # runner; blockage is simulated by pinning sweep async and asserting
    # status computing + unsorted order on the FIRST response.

def test_sorted_script_table_after_sweep(...):
    # sweep sync: first evaluate returns computing (sweep ran inline AFTER the
    # cache-only pass — assert status computing with done==total) and the
    # SECOND evaluate returns state ready, rows sorted by the script value,
    # order cache populated (third call with a poisoned runner still 200s
    # sorted — no guest calls).

def test_failed_sweep_reported_not_rekicked(...):
    # timeout-scripted runner + sync sweep: second evaluate gets state
    # "failed" with the message, and does not re-kick (guest call count flat).

def test_unsorted_default_table_stays_inline(...):
    # collapse + keep_empty + no sort: script_status.state == "ready" on the
    # FIRST response, no sweep registered, window cells have real values.
```

Decide the exact expected first-response status in `test_sorted_script_table_after_sweep` while writing it: with `snippet_sweep_sync=True`, `kick_or_join_sweep` runs the whole sweep INSIDE the first request, so its response already carries `done == total` with state `"computing"` (state is computed from the job AFTER kick returns — a sync job that completed reports `done`/`state=="done"` → map to `"ready"`... see Step 3's `_status_from_job`: job state `done` maps to `ready`, so the FIRST sync response is already `ready` but its rows were built BEFORE the sweep ran and are therefore still degraded). Assert exactly that: first response `state == "ready"` + build-order rows; second response sorted. Add this asymmetry as a comment — clients treat anything non-`ready` OR a `ready` response that followed a `computing` one as "poll once more"; simpler: the route re-checks `job.state` and if the job finished DURING the request it still reports `computing` so the client polls once more and gets the clean sorted page. Implement that: sample the job state ONCE right after kick; if the cache-only pass saw pending, never report `ready` in the same response.

- [ ] **Step 2: Run tests, verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_tables_script_status.py -v`
Expected: FAIL — `script_status` not in response.

- [ ] **Step 3: Implement**

`schemas.py`:

```python
class ScriptStatusOut(BaseModel):
    """Progress of script-column computation for this table (spec §4.2).
    `ready`: every needed script value was available (or none needed).
    `computing`: a background sweep is filling the cell cache — poll again.
    `failed`: the sweep hit a pathology guard; `message` says which. Cleared
    by the next commit."""

    state: Literal["ready", "computing", "failed"]
    done: int = 0
    total: int | None = None
    message: str | None = None
```

`TablePageOut`: add `script_status: ScriptStatusOut | None = None`.

`routes/tables.py` — inside `evaluate_table`'s `try`, replace the build/order block:

```python
        script_status: ScriptStatusOut | None = None
        cached = session.table_order_cache.get(fp, sort_key, rev)
        if cached is not None:
            cached_rows, truncated, base_total = cached
            ordered = list(cached_rows)
            if script_ctx is not None:
                script_status = ScriptStatusOut(state="ready")
        else:
            # Whole-table passes are CACHE-ONLY (spec §4.1): the guest is
            # never invoked for O(rows) work inside a request. Misses record
            # pending; the visible window below still computes live.
            if script_ctx is not None:
                script_ctx.cache_only = True
            built = build_rows_ex(metamodel, model, defn, limits, script=script_ctx)
            truncated, base_total = built.truncated, built.base_total
            ordered = order_rows(
                metamodel, model, defn, built.keys, sort, limits, script=script_ctx
            )
            if script_ctx is not None:
                script_ctx.cache_only = False
                if script_ctx.pending_misses > 0:
                    # Sort/filter incomplete: degrade to build order (a sort
                    # over half-pending values would visibly reshuffle every
                    # poll) and kick/join the sweep that fills the cache.
                    ordered = list(built.keys)
                    if runner is None:
                        script_status = ScriptStatusOut(
                            state="failed", message="script runner unavailable"
                        )
                    else:
                        job = kick_or_join_sweep(
                            session, metamodel, model, defn, runner, settings, rev
                        )
                        script_status = _status_from_job(job, pending_seen=True)
                else:
                    script_status = ScriptStatusOut(state="ready")
        window = ordered[payload.offset : payload.offset + payload.limit]
        cells = evaluate_cells(
            metamodel, model, defn, window, limits, script=script_ctx
        )
        if (
            cached is None
            and (
                script_ctx is None
                or (
                    not script_ctx.errored
                    and script_ctx.pending_misses == 0
                    and session.model_rev == rev
                )
            )
        ):
            session.table_order_cache.put(
                fp, sort_key, rev, tuple(ordered), truncated, base_total
            )
```

plus module-level:

```python
def _status_from_job(job: SweepJob, *, pending_seen: bool) -> ScriptStatusOut:
    """A response whose cache-only pass saw pending NEVER reports ready, even
    if a sync/racing sweep finished during the request — its own rows were
    built before the values existed, so the client must poll once more for
    the clean shape."""
    if job.state == "failed":
        return ScriptStatusOut(state="failed", done=job.done, total=job.total,
                               message=job.message)
    return ScriptStatusOut(state="computing", done=job.done, total=job.total)
```

and `script_status=script_status` in the `TablePageOut(...)` construction. Update the route docstring (cache-only whole-table stance, degrade shape, sweep kick).

- [ ] **Step 4: Run + commit**

Run: `pixi run -e core-dev pytest tests/api -q` → PASS (existing table tests must stay green: tables WITHOUT script columns have `script_ctx is None` → `script_status is None`, untouched behavior). `pixi run dr-tidy`.

```bash
git add -A && git commit -m "feat(script-sweep): evaluate route degrades + kicks sweep, reports script_status"
```

### Task 8: `/tables/export` — 202 while computing

**Files:**
- Modify: `src/data_rover/api/routes/tables.py` (`export_table`)
- Test: `tests/api/test_tables_script_status.py` (extend)

**Interfaces:**
- Consumes: `kick_or_join_sweep`, `ScriptStatusOut`, cache-only mode.
- Produces: 202 JSON body = `ScriptStatusOut.model_dump()`, header `Retry-After: 1`. Frontend Task 9 depends on exactly this.

- [ ] **Step 1: Write the failing tests** (extend `tests/api/test_tables_script_status.py`)

```python
def test_export_202_while_computing_then_200(...):
    # async sweep: first export → 202, JSON state "computing", Retry-After: 1;
    # run sweep to completion (sync re-kick or direct _run); second export →
    # 200 xlsx with real values and NO fresh guest calls (cache hits only).

def test_export_failed_sweep_ships_error_cells(...):
    # failed job: export → 200, X-Table-Script-Errors: true, #ERROR cells
    # (pending → #ERROR in the failed path only).
```

- [ ] **Step 2: Run, verify fail** — `pixi run -e core-dev pytest tests/api/test_tables_script_status.py -k export -v` → FAIL (export blocks/computes inline today).

- [ ] **Step 3: Implement**

In `export_table`, after `open_script_context(...)` (which now receives `cell_cache=session.script_cell_cache, rev=rev` from Task 3 — add `rev = session.model_rev` above it if Task 3 didn't), insert a cache-only completeness probe BEFORE building anything:

```python
        if script_ctx is not None:
            # Probe completeness cache-only: an export must never run O(rows)
            # guest work inline (spec §4.4).
            script_ctx.cache_only = True
            probe_keys, _ = build_rows(metamodel, model, defn, limits, script=script_ctx)
            order_rows(metamodel, model, defn, probe_keys, sort, limits, script=script_ctx)
            if script_ctx.pending_misses > 0:
                if runner is not None:
                    job = kick_or_join_sweep(
                        session, metamodel, model, defn, runner, settings, rev
                    )
                    if job.state != "failed":
                        status = _status_from_job(job, pending_seen=True)
                        return JSONResponse(
                            status_code=202,
                            content=status.model_dump(),
                            headers={"Retry-After": "1"},
                        )
                # failed sweep (or no runner): fall through and export with
                # pending rendered as #ERROR — the honest terminal state.
            # keep cache_only=True for the export itself: EVERY script value
            # must come from the cache; stray misses render #ERROR/#pending
            # rather than launching guest work mid-download.
```

Then the existing `build_rows`/`order_rows`/`iter_export_rows` flow runs with the same (still cache-only) context. Reuse the probe's `probe_keys` for `keys` (don't build twice — assign `keys, truncated = probe_keys, ...`; restructure minimally so the probe IS the build when a script context exists). Import `JSONResponse` from `fastapi.responses`.

- [ ] **Step 4: Run + commit**

`pixi run -e core-dev pytest tests/api -q` → PASS. `pixi run dr-tidy`.

```bash
git add -A && git commit -m "feat(script-sweep): export returns 202 while the sweep is computing"
```

### Task 9: frontend types + API client

**Files:**
- Modify: `frontend/src/lib/api/types.ts`
- Modify: `frontend/src/lib/api/tables.ts`
- Test: `frontend/src/lib/api/__tests__/` (mirror wherever `TablePageSchema` parsing is currently tested; if untested, add `frontend/src/lib/api/__tests__/tables-schema.test.ts`)

**Interfaces:**
- Produces: `TableCellSchema` variant `{ kind: 'pending' }`; `ScriptStatusSchema` + `TablePage['script_status']`; `exportTable` returns `ExportResult = { kind: 'ready'; blob: Blob; filename: string } | { kind: 'preparing'; done: number; total: number | null }`.

- [ ] **Step 1: Write failing tests** — zod parse of a page with a pending cell + script_status; exportTable 202 handling via MSW returning 202 JSON.

```ts
// frontend/src/lib/api/__tests__/tables-schema.test.ts
import { describe, expect, it } from 'vitest';
import { TablePageSchema } from '../types';

describe('TablePageSchema (script status)', () => {
	it('parses pending cells and script_status', () => {
		const page = TablePageSchema.parse({
			columns: [{ kind: 'script', header: '', width_px: null }],
			rows: [{ key: [null], cells: [{ kind: 'pending' }] }],
			total: 1, base_total: 1, truncated: false, offset: 0, model_rev: 3,
			warnings: [],
			script_status: { state: 'computing', done: 10, total: 3000, message: null }
		});
		expect(page.script_status?.state).toBe('computing');
		expect(page.rows[0].cells[0].kind).toBe('pending');
	});
	it('tolerates absent script_status (older responses)', () => {
		const page = TablePageSchema.parse({
			columns: [], rows: [], total: 0, base_total: 0, truncated: false,
			offset: 0, model_rev: 1, warnings: []
		});
		expect(page.script_status ?? null).toBeNull();
	});
});
```

- [ ] **Step 2: Run, verify fail** — `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/tables-schema.test.ts'` → FAIL (unknown discriminator `pending`).

- [ ] **Step 3: Implement**

`types.ts`: add to the `TableCellSchema` union: `z.object({ kind: z.literal('pending') })`; add

```ts
export const ScriptStatusSchema = z.object({
	state: z.enum(['ready', 'computing', 'failed']),
	done: z.number().int().default(0),
	total: z.number().int().nullish(),
	message: z.string().nullish()
});
export type ScriptStatus = z.infer<typeof ScriptStatusSchema>;
```

and `script_status: ScriptStatusSchema.nullish()` to `TablePageSchema`.

`tables.ts`:

```ts
export type ExportResult =
	| { kind: 'ready'; blob: Blob; filename: string }
	| { kind: 'preparing'; done: number; total: number | null };

export async function exportTable(
	args: { definition?: TableDefinition; artifactId?: string; sort?: TableSort },
	cfg?: ClientConfig
): Promise<ExportResult> {
	const res = await apiFetchRaw(
		'/tables/export',
		{
			method: 'POST',
			body: { definition: args.definition, artifact_id: args.artifactId, sort: args.sort }
		},
		cfg
	);
	if (res.status === 202) {
		const body = (await res.json()) as { done?: number; total?: number | null };
		return { kind: 'preparing', done: body.done ?? 0, total: body.total ?? null };
	}
	const disp = res.headers.get('content-disposition') ?? '';
	const m = /filename="([^"]+)"/.exec(disp);
	return { kind: 'ready', blob: await res.blob(), filename: m?.[1] ?? 'table.xlsx' };
}
```

Update `exportTable`'s call sites (`TableView.svelte`'s `exportTable()` — full retry loop lands in Task 10; here just make it compile by handling `kind === 'ready'` and treating `preparing` as a no-op with a TODO-free early return showing `saveError = null`... no: set a plain interim behavior — `if (result.kind === 'preparing') { saveError = 'Export is being prepared — try again shortly.'; return; }` — Task 10 replaces it with the real loop).

- [ ] **Step 4: Run + commit**

`pixi run -e frontend bash -c 'cd frontend && npm test'` and `npm run check` → PASS.

```bash
git add -A && git commit -m "feat(script-sweep): frontend schema + export 202 plumbing"
```

### Task 10: frontend polling, pending cells, progress UI, export retry

**Files:**
- Modify: `frontend/src/lib/state/table-editor.svelte.ts`
- Create: `frontend/src/lib/components/Table/Cell/PendingCell.svelte`
- Modify: the cell dispatcher (find the `switch`/`{#if}` over `cell.kind` — `grep -rn "kind === 'error'" frontend/src/lib/components/Table/`) + `frontend/src/lib/components/Table/TableGrid.svelte` (header progress) + `TableView.svelte` (export retry loop)
- Test: `frontend/src/lib/state/__tests__/table-editor-script-status.test.ts`

**Interfaces:**
- Consumes: `ScriptStatus`, `ExportResult` from Task 9.
- Produces: `getTableScriptStatus(tabId: string): ScriptStatus | null` export from table-editor store.

- [ ] **Step 1: Write failing store tests** (mirror the setup style of the existing `frontend/src/lib/state/__tests__` table-editor tests + MSW handlers)

```ts
// state/__tests__/table-editor-script-status.test.ts — contract:
// 1. a loadTablePage response with script_status computing schedules ONE
//    re-poll (~1s, use vi.useFakeTimers) of the visible window;
// 2. the re-poll response with state ready stops the loop and
//    getTableScriptStatus(tabId) reflects ready;
// 3. closing the tab (or a definition edit bumping the generation) cancels
//    the pending timer — no fetch after close (assert on MSW handler count);
// 4. state failed stops polling and surfaces the message.
```

- [ ] **Step 2: Run, verify fail** — `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/table-editor-script-status.test.ts'` → FAIL (`getTableScriptStatus` not exported).

- [ ] **Step 3: Implement**

`table-editor.svelte.ts` — alongside the existing per-tab maps (mirror the exact reactive-map pattern `_loading` uses):

```ts
const POLL_MS = 1000;
const _scriptStatus = new Map<string, ScriptStatus>(); // same wrapper as _loading
const _pollTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function getTableScriptStatus(tabId: string): ScriptStatus | null {
	return _scriptStatus.get(tabId) ?? null;
}

function _handleScriptStatus(tabId: string, page: TablePage): void {
	const status = page.script_status ?? null;
	if (status) _scriptStatus.set(tabId, status);
	else _scriptStatus.delete(tabId);
	const timer = _pollTimers.get(tabId);
	if (timer) {
		clearTimeout(timer);
		_pollTimers.delete(tabId);
	}
	if (status?.state !== 'computing') return;
	const gen = _generations.get(tabId) ?? 0;
	_pollTimers.set(
		tabId,
		setTimeout(() => {
			_pollTimers.delete(tabId);
			if (!isCurrent(tabId, gen)) return; // edited/closed since scheduled
			const view = _viewRanges.get(tabId);
			const start = view ? Math.floor(view.start / PAGE) * PAGE : 0;
			const limit = view
				? Math.min(MAX_LIMIT, Math.max(PAGE, Math.ceil((view.end - start) / PAGE) * PAGE))
				: PAGE;
			void loadTablePage(tabId, start, limit);
		}, POLL_MS)
	);
}
```

Call `_handleScriptStatus(tabId, page)` from BOTH `installPage` and `mergePage` paths (right where the page lands), and clear `_scriptStatus`/`_pollTimers` entries wherever the store already cleans up per-tab state on close/reset (find the existing close/reset function that deletes from `_pages`).

`PendingCell.svelte` — a shimmer placeholder consistent with the grid's unfetched-row placeholder styling (reuse its CSS class if one exists):

```svelte
<span class="cell-pending" aria-label="computing" title="Value is being computed">…</span>

<style>
	.cell-pending {
		opacity: 0.45;
		animation: pending-pulse 1.2s ease-in-out infinite;
	}
	@keyframes pending-pulse {
		50% { opacity: 0.15; }
	}
</style>
```

Cell dispatcher: add the `pending` case next to `error`. `TableGrid.svelte` header (near where warnings/errors render): when `getTableScriptStatus(tabId)?.state === 'computing'` show `computing {done}/{total ?? '…'}`; `failed` → the existing error-strip styling with `message`.

`TableView.svelte` export retry loop:

```ts
async function exportTable(): Promise<void> {
	saveError = null;
	exporting = true; // new local $state<boolean>; disables the button
	try {
		for (;;) {
			const result = await apiExportTable({ ...exportArgs() });
			if (result.kind === 'ready') {
				triggerDownload(result.blob, result.filename); // existing helper
				return;
			}
			exportProgress = result; // new local $state, rendered on the button
			await new Promise((r) => setTimeout(r, 1000));
		}
	} catch (e) {
		saveError = e instanceof Error ? e.message : 'Export failed';
	} finally {
		exporting = false;
		exportProgress = null;
	}
}
```

(Adapt names to the component's existing export function/download helper; keep its error handling shape.)

- [ ] **Step 4: Run + commit**

`pixi run -e frontend bash -c 'cd frontend && npm test'` and `npm run check` → PASS.

```bash
git add -A && git commit -m "feat(script-sweep): frontend polling, pending cells, export retry"
```

**Phase B is shippable here.**

---

## Phase C — parallel sweep workers

### Task 11: shard sweep items across worker sessions

**Files:**
- Modify: `src/data_rover/api/script_sweep.py` (`_run_inner` fan-out)
- Modify: `src/data_rover/api/settings.py` (`snippet_pool_size: int = 2` → `6`, with a docstring note: workers + console headroom)
- Test: `tests/api/test_script_sweep.py` (extend)

**Interfaces:**
- Consumes: everything from Task 6; `settings.snippet_sweep_workers`.
- Produces: same `SweepJob` contract — results and final state must be identical to serial execution.

- [ ] **Step 1: Write the failing tests** (extend `tests/api/test_script_sweep.py`)

```python
def test_parallel_sweep_matches_serial_results(...):
    # Two sessions/caches, same model+defn: run one sweep with
    # snippet_sweep_workers=1 and one with =4 (sync mode drives the fan-out
    # inline: workers still spawn threads; join happens inside _run_inner).
    # Assert both jobs end state "done" with equal done/total, and the two
    # cell caches contain the same keys with equal CallResult.value payloads.

def test_parallel_sweep_uses_multiple_sessions(...):
    # Counting fake runner records open_session() count: with workers=4 and
    # >=4 items, open_session called >= 2 times (exact count is scheduling-
    # dependent; assert > 1 and <= 1 + 4: serial prefix ctx + up to 4 workers).

def test_parallel_consecutive_timeout_abort_is_global(...):
    # runner scripted: every call times out; workers=4 -> job fails with the
    # consecutive-timeouts message and total guest calls stay bounded
    # (<= timeout_abort + workers slack), not O(rows).
```

- [ ] **Step 2: Run, verify fail** — `pixi run -e core-dev pytest tests/api/test_script_sweep.py -k parallel -v` → FAIL (`open_session` called once; no fan-out).

- [ ] **Step 3: Implement**

Restructure `_run_inner`: keep the serial prefix (build + `job.total`), then enumerate-dedupe-dispatch:

```python
        # Enumerate the cell work list through the SERIAL context (resolving
        # a script-as-source column may itself call the guest). Dedupe: rows
        # sharing a binding produce identical (code, roots) items; computing
        # them once matches ScriptEvalContext's own memo semantics.
        items: list[tuple[str, tuple[str, ...]]] = []
        seen: set[tuple[str, tuple[str, ...]]] = set()
        dup_or_empty = 0
        for key in built.keys:
            for col in script_cols:
                roots = resolve_source_elements(
                    metamodel, model, defn, key, col.source, base_slots,
                    TableLimits(), script=ctx,
                )
                item = (col.snippet.definition.code, tuple(roots))
                if not roots or item in seen:
                    dup_or_empty += 1
                    continue
                seen.add(item)
                items.append(item)
        job.done += dup_or_empty  # empties + dupes are complete by definition

        workers = max(1, settings.snippet_sweep_workers)
        if workers == 1 or len(items) <= 1:
            _consume(session, settings, job, budget, ctx, items, _SharedGuards())
        else:
            q: queue.SimpleQueue[tuple[str, tuple[str, ...]]] = queue.SimpleQueue()
            for it in items:
                q.put(it)
            guards = _SharedGuards()

            def _worker() -> None:
                wctx = ScriptEvalContext(
                    runner, model, limits, budget,
                    cell_cache=session.script_cell_cache, rev=job.rev,
                )
                try:
                    _drain(session, settings, job, budget, wctx, q, guards)
                finally:
                    wctx.close()

            threads = [
                threading.Thread(target=_worker, name=f"script-sweep-w{i}", daemon=True)
                for i in range(min(workers, len(items)))
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        if job.state == "running":
            job.state = "done"
```

with the shared-guard helpers (module level):

```python
@dataclass
class _SharedGuards:
    """Job-global pathology counters (spec §6): consecutive timeouts must be
    counted ACROSS workers — 4 workers each seeing 2 timeouts is 8 in a row,
    not 'under the limit 4 times'. `lock` also serializes job.done updates."""

    lock: threading.Lock = field(default_factory=threading.Lock)
    consecutive_timeouts: int = 0


def _drain(session, settings, job, budget, wctx, q, guards) -> None:
    while True:
        try:
            code, roots = q.get_nowait()
        except queue.Empty:
            return
        with guards.lock:
            if job.state == "failed":
                return
        if _aborted(session, job):
            return
        if budget.exhausted:
            with guards.lock:
                if job.state != "failed":
                    _fail(job, f"sweep ceiling ({settings.snippet_sweep_ceiling_s:g}s) exceeded")
            return
        res = wctx.call(code, "value", list(roots))
        with guards.lock:
            if res.error is not None and res.error.kind == "timeout":
                guards.consecutive_timeouts += 1
                if guards.consecutive_timeouts >= settings.snippet_sweep_timeout_abort:
                    _fail(job, f"aborted after {guards.consecutive_timeouts} consecutive snippet timeouts")
                    return
            else:
                guards.consecutive_timeouts = 0
            job.done += 1


def _consume(session, settings, job, budget, ctx, items, guards) -> None:
    q: queue.SimpleQueue[tuple[str, tuple[str, ...]]] = queue.SimpleQueue()
    for it in items:
        q.put(it)
    _drain(session, settings, job, budget, ctx, q, guards)
```

(The old inline per-row loop from Task 6 is REPLACED by this enumerate+drain structure; `job.total` stays `len(built.keys) * len(script_cols)` and dupes/empties are pre-counted into `done`.) Note in the module docstring: sharding splits module-global snippet state across instances — already outside the determinism guarantee, now an explicit "don't" (docs task 12).

`settings.py`: `snippet_pool_size: int = 6` with docstring update. Update the settings table in `src/data_rover/core/script/README.md` (pool default) in the same commit.

- [ ] **Step 4: Run + commit**

`pixi run -e core-dev pytest tests/api/test_script_sweep.py tests/api tests/script -q` → PASS. `pixi run dr-tidy`.

```bash
git add -A && git commit -m "feat(script-sweep): shard sweep cell work across parallel guest sessions"
```

### Task 12: integration + perf tests, docs

**Files:**
- Create: `tests/api/test_script_sweep_wasm.py` (`pytestmark = pytest.mark.integration`)
- Create: `tests/api/test_script_sweep_perf.py` (`pytestmark = pytest.mark.perf`)
- Modify: `src/data_rover/core/script/README.md`, `CLAUDE.md`, `frontend/README.md`

- [ ] **Step 1: Integration test** (mirror `tests/api/test_snippets_wasm.py`'s guest-binary skip guard and module-scoped `WasmScriptRunner` fixture):

```python
def test_sorted_script_table_settles_end_to_end(wasm_runner, big_session) -> None:
    """1,000-row model, script column `value -> el.name`, sorted evaluate:
    first response computing + build order; drive the sweep synchronously
    (snippet_sweep_sync pinned); follow-up response ready + rows sorted by
    the script value; assert byte-identical cell payloads between a
    workers=1 and workers=4 run (determinism under sharding)."""
```

Run: `pixi run -e core-dev pytest tests/api/test_script_sweep_wasm.py -m integration -v` (needs `bash spikes/code_exec/fetch_python_wasi.sh` first) → PASS.

- [ ] **Step 2: Perf regression test** (adapted from the investigation's scratchpad benchmarks):

```python
def test_percall_roundtrip_budget(wasm_runner, small_model) -> None:
    """200 warm `value()` calls must average < 5 ms (measured ~0.5 ms on the
    reference machine; 10x headroom absorbs CI noise). Guards against a
    bridge-protocol regression re-introducing per-call boots."""

def test_parallel_sweep_speedup(wasm_runner, big_session) -> None:
    """workers=4 sweep of a 400-row heavy-ish snippet must finish in < 0.7x
    the workers=1 wall time (real speedup is ~4x; 0.7 is a loose floor)."""
```

Run: `pixi run -e core-dev pytest tests/api/test_script_sweep_perf.py -m perf -v` → PASS.

- [ ] **Step 3: Docs**

- `src/data_rover/core/script/README.md`: new subsection under "Evaluation sessions (M2/M3)" — cell cache (key/stamping/what's cached), cache-only + pending, sweep lifecycle + guards + failed-job memory, parallel sharding; promote the module-global-state caveat to an explicit "don't"; update the settings table (new `snippet_sweep_*`/`snippet_cell_cache_max` rows, `snippet_pool_size` 6).
- `CLAUDE.md` "Embedded evaluation (M2/M3…)" bullet: rewrite to describe the new stance in ~4 sentences (cache → sweep → poll; whole-table work never inline; `script_status`; export 202).
- `frontend/README.md`: table-editor section gains the poll loop + pending cells + export retry description.

- [ ] **Step 4: Full verification + commit**

```bash
pixi run core-test && pixi run dr-tidy
pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'
git add -A && git commit -m "test(script-sweep): integration + perf regression coverage; docs"
```

---

## Self-review notes (already applied)

- Spec §4.2 "unfiltered while pending" is implemented as "pending rows are KEPT by the keep_empty filter" (cached rows do filter progressively) — noted in Task 7's degrade comment.
- Spec §4.3 failed-job memory: `ScriptSweepRegistry.kick` returns failed jobs as-is (Task 6) and the evaluate route never re-kicks (Task 7 test).
- The sync-sweep-inside-first-request status asymmetry is pinned down in Task 7 (`_status_from_job(pending_seen=True)` never reports ready).
- `TrustedRunner` is not needed by the fakes (Tasks 3/6 use purpose-built counting fakes), avoiding the tests-import-from-src tangle entirely.
