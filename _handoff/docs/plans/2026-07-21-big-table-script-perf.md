# Big-Table Script-Column Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make 3k+-row tables with script columns fast: collapse guest↔host bridge round trips (Phase A′) and replace clear-all cell-cache invalidation with per-cell read-set eviction on commit (Phase B).

**Architecture:** Phase A′ adds a session-lifetime read memo inside the guest `dr` facade, inlines far-endpoint element projections on `outgoing`/`incoming` bridge responses, and piggybacks projected root elements on each embedded entry-point call — all transparent to snippet authors. Phase B has the facade record each call's read-set (memo hits included), ships it back on the `call_result` wire frame, stores it beside each cached cell, and evicts only intersecting cells when a commit's op batch is translated into touched read keys.

**Tech Stack:** Python 3.14 (pixi), FastAPI, wasmtime CPython-WASI guest, pytest. Spec: `docs/superpowers/specs/2026-07-21-big-table-script-perf-design.md`.

## Global Constraints

- All commands run through pixi: `pixi run -e core-dev pytest tests/script tests/api -q` for tests, `pixi run dr-tidy` for lint/format/typecheck (ruff + mypy + pyright must all pass).
- `FACADE_SOURCE` (in `src/data_rover/core/script/facade_src.py`) is exec'd source: plain, stdlib-only, Python 3.10-compatible. It must never import anything. The runner binds names (`_transport`, and after this plan `_read_memo_max`) into its exec namespace.
- `_GUEST_BOOTSTRAP_SOURCE` (in `src/data_rover/api/script_runner.py`) is likewise guest-exec'd source text with the same constraints.
- `tests/script/trusted_runner.py` must NEVER move to `src/` (RCE tripwire). `wasmtime` is imported only in `src/data_rover/api/script_runner.py`.
- `data_rover.core.*` must never import `data_rover.api.*`.
- Default test runs are hermetic (`-m "not integration and not perf"` is in addopts). Tests touching the real WASM guest are `@pytest.mark.integration` or `@pytest.mark.perf`.
- Determinism guarantee is load-bearing: identical (code, model, element ids) must produce identical results with every optimization on or off.
- Preserve the dense docstring style: new invariants get docstrings explaining WHY.
- Commit after every task. Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and the session line per repo convention.

## File Map

| File | Change |
|---|---|
| `tests/script/conftest.py` | add `bridge_call_log` counting fixture |
| `tests/script/test_trip_counts.py` | NEW — trip-collapse tests (Tasks 1–4) |
| `tests/script/test_read_sets.py` | NEW — read-set attribution tests (Task 6) |
| `src/data_rover/core/script/facade_src.py` | memo + priming + `_dr_call_entry` + read recording |
| `src/data_rover/core/script/bridge.py` | inline far endpoints; public `project_element` |
| `src/data_rover/core/script/runner.py` | `RunLimits.read_memo_max`; `ReadKey`; `CallResult.reads`; `decode_reads` |
| `src/data_rover/core/script/cell_cache.py` | store reads; `put(reads=)`; `evict_touched` |
| `src/data_rover/core/script/embed.py` | pass `reads` through to the cell cache |
| `src/data_rover/api/script_runner.py` | bootstrap uses `_dr_call_entry`; root piggyback; memo-cap + reads wire |
| `src/data_rover/api/settings.py` | `snippet_read_memo_max`, `snippet_incremental_invalidation` |
| `src/data_rover/api/invalidation.py` | NEW — `touched_keys` builder |
| `src/data_rover/api/session.py` | `Session.evict_touched_caches` |
| `src/data_rover/api/routes/ops.py` | wire eviction into `/model/ops` + `/model/undo` success paths |
| `src/data_rover/api/routes/commits.py` | wire eviction into `/commits` success path |
| `tests/script/trusted_runner.py` | `_TrustedSession` uses `_dr_call_entry` + piggyback + reads |
| `tests/script/test_cell_cache.py` | `evict_touched` tests (Task 7) |
| `tests/api/test_invalidation.py` | NEW — `touched_keys` table-driven tests (Task 8) |
| `tests/api/test_incremental_invalidation.py` | NEW — route-level e2e + property test (Tasks 9–10) |
| `tests/api/test_script_sweep_perf.py` | trips-per-cell perf guard (Task 5) |
| `src/data_rover/core/script/README.md` | document memo + incremental invalidation (Task 10) |

---

### Task 1: Bridge trip-counting fixture

Foundation for every trip assertion in this plan: a fixture that counts every
`BridgeDispatcher.dispatch` call. Dispatch runs host-side for BOTH runners
(TrustedRunner calls it directly; the WASM host pump calls it per guest
request), so the same fixture serves hermetic and integration tests.

**Files:**
- Modify: `tests/script/conftest.py`
- Create: `tests/script/test_trip_counts.py`

**Interfaces:**
- Produces: fixture `bridge_call_log` → `list[str]` of read-op names (writes logged as `"write"`). Later tasks assert on its length/content.

- [ ] **Step 1: Add the counting fixture**

Append to `tests/script/conftest.py`:

```python
@pytest.fixture
def bridge_call_log(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Log of every `BridgeDispatcher.dispatch` call's op name, in order.

    Dispatch is the single host-side choke point of the bridge protocol for
    BOTH runners (TrustedRunner calls it in-process; the WASM host pump calls
    it once per guest request line), so its call count IS the round-trip
    count the trip-collapse work optimizes. Write ops log as `"write"`.
    """
    from data_rover.core.script.bridge import BridgeDispatcher

    calls: list[str] = []
    orig = BridgeDispatcher.dispatch

    def counting(self: BridgeDispatcher, req: dict) -> dict:
        op = req.get("op")
        calls.append(op if isinstance(op, str) else "write")
        return orig(self, req)

    monkeypatch.setattr(BridgeDispatcher, "dispatch", counting)
    return calls
```

(`import pytest` is already present in this conftest.)

- [ ] **Step 2: Write a sanity test that the fixture counts**

Create `tests/script/test_trip_counts.py`:

```python
"""Bridge round-trip counting tests for the trip-collapse work (Phase A').

Every test asserts on `bridge_call_log` — the number of
`BridgeDispatcher.dispatch` calls IS the host round-trip count. Tests use
`TrustedRunner` sessions so they are hermetic; the wire shapes are identical
to the WASM path by construction (same FACADE_SOURCE, same dispatcher).
"""

from __future__ import annotations

from data_rover.core.script.runner import RunLimits, ScriptBudget

from tests.script.conftest import tiny_model
from tests.script.trusted_runner import TrustedRunner


def _open(code: str):
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(
        model, code, RunLimits(), budget=ScriptBudget.start(60)
    )
    assert sess.boot_error is None, sess.boot_error
    return sess


def test_fixture_counts_dispatch_calls(bridge_call_log: list[str]) -> None:
    sess = _open("def value(els):\n    return els[0].name\n")
    res = sess.call("value", ["b1"])
    assert res.error is None
    assert bridge_call_log.count("element") >= 1
```

- [ ] **Step 3: Run the test**

Run: `pixi run -e core-dev pytest tests/script/test_trip_counts.py -v`
Expected: PASS (1 passed).

- [ ] **Step 4: Commit**

```bash
git add tests/script/conftest.py tests/script/test_trip_counts.py
git commit -m "test(script): bridge round-trip counting fixture for trip-collapse work"
```

---

### Task 2: Session-lifetime read memo in the facade (with configurable cap)

The facade memoizes bridge read responses for the life of the exec namespace
(= one embedded session, always within one model rev). Covers `element`,
`outgoing`, `incoming`, `children`, `parent`, `types`, `type_info`. The cap
travels host→guest: `RunLimits.read_memo_max` ← `settings.snippet_read_memo_max`,
bound into the exec namespace as `_read_memo_max`.

**Files:**
- Modify: `src/data_rover/core/script/facade_src.py`
- Modify: `src/data_rover/core/script/runner.py` (RunLimits field)
- Modify: `src/data_rover/api/settings.py`
- Modify: `src/data_rover/api/script_runner.py` (start msgs + `run_limits_from_settings` + bootstrap binding)
- Modify: `tests/script/trusted_runner.py` (namespace binding)
- Test: `tests/script/test_trip_counts.py`

**Interfaces:**
- Consumes: `bridge_call_log` (Task 1).
- Produces: facade internals `_memo` (dict keyed `(op_name, id_or_None)`), `_memo_put(key, value)`, memo-aware `_fetch_element`/`out`/`in_`/`children`/`parent`/`_list_types`/`_type_info`; `RunLimits.read_memo_max: int = 4096`; `Settings.snippet_read_memo_max: int = 4096`. Element-projection memo entries use key `("element", <id>)` — Task 3/4 prime exactly that key.

- [ ] **Step 1: Write failing memo tests**

Append to `tests/script/test_trip_counts.py`:

```python
def test_element_refetch_is_memoized(bridge_call_log: list[str]) -> None:
    sess = _open(
        "def value(els):\n"
        "    a = dr.element('b2')\n"
        "    b = dr.element('b2')\n"
        "    return a.name + b.name\n"
    )
    assert sess.call("value", ["b1"]).error is None
    assert bridge_call_log.count("element") == 2  # b1 root + b2 once


def test_memo_survives_across_calls(bridge_call_log: list[str]) -> None:
    sess = _open("def value(els):\n    return dr.element('b2').name\n")
    assert sess.call("value", ["b1"]).error is None
    assert sess.call("value", ["b3"]).error is None
    # b2 fetched once across BOTH calls (session-lifetime memo)
    assert bridge_call_log.count("element") == 3  # b1, b2, b3


def test_adjacency_reads_are_memoized(bridge_call_log: list[str]) -> None:
    sess = _open(
        "def value(els):\n"
        "    els[0].out(); els[0].out()\n"
        "    els[0].children(); els[0].children()\n"
        "    els[0].parent(); els[0].parent()\n"
        "    dr.types(); dr.types()\n"
        "    return 1\n"
    )
    assert sess.call("value", ["b2"]).error is None
    for op in ("outgoing", "children", "parent", "types"):
        assert bridge_call_log.count(op) == 1, op


def test_memo_cap_evicts_oldest(bridge_call_log: list[str]) -> None:
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(
        model,
        "def value(els):\n"
        "    dr.element('b2'); dr.element('b3')\n"
        "    dr.element('b2')\n"  # b2 was evicted by b3 under cap=1
        "    return 1\n",
        RunLimits(read_memo_max=1),
        budget=ScriptBudget.start(60),
    )
    assert sess.boot_error is None
    assert sess.call("value", ["b1"]).error is None
    assert bridge_call_log.count("element") == 4  # b1, b2, b3, b2-again


def test_memoized_results_do_not_alias_mutations(bridge_call_log: list[str]) -> None:
    """A snippet mutating a returned relationships list must not poison later
    reads of the same memo entry — the facade hands out shallow copies."""
    sess = _open(
        "def value(els):\n"
        "    rels = els[0].out()\n"
        "    rels.append('junk')\n"
        "    return len(els[0].out())\n"
    )
    res = sess.call("value", ["b1"])
    assert res.error is None
    assert res.value == {"kind": "scalar", "value": 1}
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_trip_counts.py -v`
Expected: the four new tests FAIL (`element` counted twice for a refetch, `read_memo_max` unknown kwarg, etc.). `test_fixture_counts_dispatch_calls` still passes.

- [ ] **Step 3: Add `RunLimits.read_memo_max` and the setting**

In `src/data_rover/core/script/runner.py`, add to the `RunLimits` dataclass after `page_limit`:

```python
    read_memo_max: int = 4096
```

and extend its docstring's attribute list:

```
        read_memo_max: Capacity of the guest facade's session-lifetime read
            memo (entries). 0 disables memoization. Sound under the runner
            determinism guarantee: a session never outlives one model rev's
            worth of work, so a memoized read can never go stale within it.
```

In `src/data_rover/api/settings.py`, after `snippet_page_limit`:

```python
    #: Capacity (entries) of the guest facade's session-lifetime read memo
    #: (spec 2026-07-21 Phase A'). One entry is one memoized bridge read
    #: response (element projection / adjacency list / type info). 0 disables.
    snippet_read_memo_max: int = 4096
```

In `src/data_rover/api/script_runner.py`, add to `run_limits_from_settings`:

```python
        read_memo_max=settings.snippet_read_memo_max,
```

- [ ] **Step 4: Implement the memo in the facade**

In `src/data_rover/core/script/facade_src.py`, inside `FACADE_SOURCE`, insert after the `_write` function definition:

```python
try:
    _MEMO_CAP = int(_read_memo_max)
except NameError:
    _MEMO_CAP = 4096

# Session-lifetime read memo: (op_name, id_or_None) -> response fragment.
# Sound because a session never outlives one model rev's worth of work (the
# same invariant the host's ScriptCellCache rests on). Insertion-ordered
# dict gives FIFO eviction at _MEMO_CAP entries. Element entries hold the
# PROJECTION dict (not the whole response) so hop/root priming can insert
# projections directly under ("element", id).
_memo = {}


def _memo_put(key, value):
    if _MEMO_CAP <= 0:
        return
    if key not in _memo and len(_memo) >= _MEMO_CAP:
        _memo.pop(next(iter(_memo)))
    _memo[key] = value
```

Replace the bodies of the memoizable reads. `_fetch_element`:

```python
def _fetch_element(element_id):
    """Fetch a single element by id.

    Example:
        el = dr.element("some-id")
        print(el.name)
    """
    key = ("element", element_id)
    proj = _memo.get(key)
    if proj is None:
        proj = _read("element", element_id=element_id)["element"]
        _memo_put(key, proj)
    return Element(proj)
```

`Element.out` / `Element.in_` (memoize the relationships list; hand out a copy so a snippet mutating it can't poison the memo):

```python
    def out(self):
        """List outgoing relationships as dicts (id, type, source_id, target_id).

        Example:
            for rel in el.out():
                print(rel["type"], rel["target_id"])
        """
        key = ("outgoing", self.id)
        hit = _memo.get(key)
        if hit is None:
            hit = _read("outgoing", element_id=self.id)["relationships"]
            _memo_put(key, hit)
        return list(hit)

    def in_(self):
        """List incoming relationships as dicts (id, type, source_id, target_id)."""
        key = ("incoming", self.id)
        hit = _memo.get(key)
        if hit is None:
            hit = _read("incoming", element_id=self.id)["relationships"]
            _memo_put(key, hit)
        return list(hit)
```

`Element.parent` / `Element.children` (children primes the element memo with the child projections it just shipped):

```python
    def parent(self):
        """Return the containment parent Element, or None at a root."""
        key = ("parent", self.id)
        if key in _memo:
            parent_id = _memo[key]
        else:
            parent_id = _read("parent", element_id=self.id)["parent_id"]
            _memo_put(key, parent_id)
        if parent_id is None:
            return None
        return _fetch_element(parent_id)

    def children(self):
        """List containment child Elements.

        Example:
            for child in el.children():
                print(child.name)
        """
        key = ("children", self.id)
        hit = _memo.get(key)
        if hit is None:
            hit = _read("children", element_id=self.id)["children"]
            for proj in hit:
                _memo_put(("element", proj["id"]), proj)
            _memo_put(key, hit)
        return [Element(d) for d in hit]
```

`_list_types` / `_type_info` (metamodel is immutable for the session):

```python
def _list_types():
    """List the element type names available in this project's metamodel.

    Example:
        print(dr.types())
    """
    key = ("types", None)
    hit = _memo.get(key)
    if hit is None:
        hit = _read("types")["types"]
        _memo_put(key, hit)
    return list(hit)


def _type_info(name):
    """Describe a metamodel type: its properties, and endpoints if a relationship type.

    Example:
        info = dr.type("Building")
    """
    key = ("type_info", name)
    hit = _memo.get(key)
    if hit is None:
        hit = _read("type_info", type=name)
        _memo_put(key, hit)
    return hit
```

Note on `parent`: `None` is a legitimate memo value (root elements), which is why it checks `key in _memo` instead of `.get`. `_iter_elements` is deliberately NOT memoized (paged whole-model scans; Phase B tracks them via `("scan", …)` read keys instead).

- [ ] **Step 5: Bind `_read_memo_max` in both runners**

In `src/data_rover/api/script_runner.py`:

In `_GUEST_BOOTSTRAP_SOURCE`, `_run_once` currently builds `namespace = {"_transport": _transport}` — change to:

```python
    namespace = {"_transport": _transport, "_read_memo_max": start.get("read_memo_max", 4096)}
```

Make the identical change in `_run_embedded`.

In `WasmScriptRunner.run`, add to `start_msg`:

```python
                "read_memo_max": limits.read_memo_max,
```

In `_WasmSnippetSession.__init__`, add the same key to its `start_msg`:

```python
            "read_memo_max": limits.read_memo_max,
```

In `tests/script/trusted_runner.py`, `TrustedRunner.run` currently builds `namespace: dict = {"_transport": dispatcher.dispatch}` — change to:

```python
        namespace: dict = {
            "_transport": dispatcher.dispatch,
            "_read_memo_max": limits.read_memo_max,
        }
```

Make the identical change in `_TrustedSession.__init__`.

- [ ] **Step 6: Run the tests**

Run: `pixi run -e core-dev pytest tests/script -q`
Expected: ALL pass (new memo tests plus the whole existing script suite — facade behavior parity is the point).

- [ ] **Step 7: Run the API suite to catch fallout**

Run: `pixi run -e core-dev pytest tests/api -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/core/script/facade_src.py src/data_rover/core/script/runner.py src/data_rover/api/settings.py src/data_rover/api/script_runner.py tests/script/trusted_runner.py tests/script/test_trip_counts.py
git commit -m "feat(script): session-lifetime read memo in the dr facade (snippet_read_memo_max)"
```

---

### Task 3: Inline far-endpoint projections on `outgoing`/`incoming`

Hop responses carry the far endpoint's element projection under an additive
`"elements"` key; the facade primes its element memo from it. `el.out()` +
N neighbor fetches collapses from 1 + N trips to 1.

**Files:**
- Modify: `src/data_rover/core/script/bridge.py`
- Modify: `src/data_rover/core/script/facade_src.py`
- Test: `tests/script/test_trip_counts.py`, `tests/script/test_bridge.py`

**Interfaces:**
- Consumes: memo key `("element", id)` (Task 2).
- Produces: `outgoing`/`incoming` responses gain `"elements": [<projection>, ...]` (deduped far endpoints, sorted by rel id order); public alias `project_element` in `bridge.py` (Task 4 uses it host-side).

- [ ] **Step 1: Write failing tests**

Append to `tests/script/test_trip_counts.py`:

```python
def test_hop_primes_neighbor_projections(bridge_call_log: list[str]) -> None:
    sess = _open(
        "def value(els):\n"
        "    total = 0\n"
        "    for rel in els[0].out():\n"
        "        total += len(dr.element(rel['target_id']).name)\n"
        "    return total\n"
    )
    assert sess.call("value", ["b1"]).error is None
    # b1 root fetch + one outgoing hop; the b2 neighbor fetch is served from
    # the projections the hop response shipped.
    assert bridge_call_log.count("element") == 1
    assert bridge_call_log.count("outgoing") == 1


def test_incoming_primes_source_projections(bridge_call_log: list[str]) -> None:
    sess = _open(
        "def value(els):\n"
        "    rels = els[0].in_()\n"
        "    return dr.element(rels[0]['source_id']).name\n"
    )
    assert sess.call("value", ["b2"]).error is None
    assert bridge_call_log.count("element") == 1  # b2 root only
```

Append to `tests/script/test_bridge.py` (dispatcher-level wire shape):

```python
def test_outgoing_response_inlines_far_endpoints() -> None:
    from tests.script.conftest import tiny_model

    d = BridgeDispatcher(tiny_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "outgoing", "element_id": "b1"})
    assert [e["id"] for e in resp["elements"]] == ["b2"]
    assert resp["elements"][0]["name"] == "Building Two"


def test_incoming_response_inlines_far_endpoints() -> None:
    from tests.script.conftest import tiny_model

    d = BridgeDispatcher(tiny_model(), record_ops=False)
    resp = d.dispatch({"id": 1, "op": "incoming", "element_id": "b2"})
    assert [e["id"] for e in resp["elements"]] == ["b1"]
```

(Match `test_bridge.py`'s existing import style for `BridgeDispatcher` — it already imports it at module top.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_trip_counts.py tests/script/test_bridge.py -v`
Expected: the four new tests FAIL (`KeyError: 'elements'` / element count 2).

- [ ] **Step 3: Implement in the dispatcher**

In `src/data_rover/core/script/bridge.py`, replace `_op_outgoing` and `_op_incoming`:

```python
    def _op_outgoing(self, req: dict[str, Any]) -> dict[str, Any]:
        element_id = req["element_id"]
        self.model.get_element(element_id)  # raises KeyError if missing
        rel_ids = sorted(self.model.indexes.outgoing_ids(element_id))
        rels = [self.model.get_relationship(rid) for rid in rel_ids]
        return {
            "relationships": [_project_relationship(r) for r in rels],
            "elements": self._far_endpoints(r.target_id for r in rels),
        }

    def _op_incoming(self, req: dict[str, Any]) -> dict[str, Any]:
        element_id = req["element_id"]
        self.model.get_element(element_id)  # raises KeyError if missing
        rel_ids = sorted(self.model.indexes.incoming_ids(element_id))
        rels = [self.model.get_relationship(rid) for rid in rel_ids]
        return {
            "relationships": [_project_relationship(r) for r in rels],
            "elements": self._far_endpoints(r.source_id for r in rels),
        }

    def _far_endpoints(self, ids: Iterable[str]) -> list[dict[str, Any]]:
        """Inline far-endpoint projections shipped with a hop response
        (trip-collapse, spec 2026-07-21 Phase A'): the facade primes its read
        memo with these, collapsing `out()` + N neighbor fetches into one
        trip. Deduped, in first-appearance (sorted-rel-id) order; an endpoint
        missing from the model (dangling reference — the engine stays
        inspectable) is silently skipped, so the guest's own fetch surfaces
        the same NotFoundError it always did."""
        seen: set[str] = set()
        out: list[dict[str, Any]] = []
        for fid in ids:
            if fid in seen:
                continue
            seen.add(fid)
            el = self.model.elements.get(fid)
            if el is not None:
                out.append(_project_element(el))
        return out
```

Add `Iterable` to the existing `collections.abc` import line (`from collections.abc import Callable, Iterable`).

Also add, right after the `_project_relationship` function definition:

```python
#: Public alias: the api layer (embedded-session root piggyback) and the
#: trusted test runner project elements host-side with exactly the wire
#: shape `_op_element` uses; a second projection implementation would drift.
project_element = _project_element
```

- [ ] **Step 4: Prime the memo in the facade**

In `src/data_rover/core/script/facade_src.py`, update the `out` and `in_` miss branches (from Task 2) to prime before storing:

```python
    def out(self):
        """List outgoing relationships as dicts (id, type, source_id, target_id).

        Example:
            for rel in el.out():
                print(rel["type"], rel["target_id"])
        """
        key = ("outgoing", self.id)
        hit = _memo.get(key)
        if hit is None:
            resp = _read("outgoing", element_id=self.id)
            for proj in resp.get("elements") or []:
                _memo_put(("element", proj["id"]), proj)
            hit = resp["relationships"]
            _memo_put(key, hit)
        return list(hit)

    def in_(self):
        """List incoming relationships as dicts (id, type, source_id, target_id)."""
        key = ("incoming", self.id)
        hit = _memo.get(key)
        if hit is None:
            resp = _read("incoming", element_id=self.id)
            for proj in resp.get("elements") or []:
                _memo_put(("element", proj["id"]), proj)
            hit = resp["relationships"]
            _memo_put(key, hit)
        return list(hit)
```

(`resp.get("elements") or []` keeps the facade tolerant of a host that does not ship the additive key.)

- [ ] **Step 5: Run the tests**

Run: `pixi run -e core-dev pytest tests/script -q`
Expected: ALL pass.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/script/bridge.py src/data_rover/core/script/facade_src.py tests/script/test_trip_counts.py tests/script/test_bridge.py
git commit -m "feat(script): inline far-endpoint projections on hop reads; facade primes its memo"
```

---

### Task 4: Root piggyback via a single facade entry-call helper

Embedded calls currently re-fetch every root by id inside the guest. Move the
per-call logic (prime roots → build handles → call fn → serialize) into ONE
facade helper, `_dr_call_entry`, used by both the WASM bootstrap loop and the
trusted session — no drift possible — and have both hosts ship projected
roots with the call. A trivial property-math cell becomes zero bridge reads.

**Files:**
- Modify: `src/data_rover/core/script/facade_src.py`
- Modify: `src/data_rover/api/script_runner.py` (`_run_embedded` + `_WasmSnippetSession.call`)
- Modify: `tests/script/trusted_runner.py` (`_TrustedSession`)
- Test: `tests/script/test_trip_counts.py`

**Interfaces:**
- Consumes: `project_element` (Task 3), memo key `("element", id)` (Task 2).
- Produces: facade `_dr_call_entry(entry, element_ids, elements=None) -> payload` (raises on snippet errors — callers keep their existing exception→error mapping); embedded `call` wire message gains `"elements": [<projection>, ...]` (host-projected roots; ids missing from the model are simply absent so the guest's own fetch raises `NotFoundError` exactly as today); `_TrustedSession` gains `self._model`.

- [ ] **Step 1: Write failing tests**

Append to `tests/script/test_trip_counts.py`:

```python
def test_root_piggyback_zero_trips_for_property_math(bridge_call_log: list[str]) -> None:
    sess = _open("def value(els):\n    return els[0].name\n")
    assert sess.call("value", ["b1"]).error is None
    assert sess.call("value", ["b2"]).error is None
    assert bridge_call_log == []  # roots ship with the call frame


def test_missing_root_still_raises_not_found(bridge_call_log: list[str]) -> None:
    sess = _open("def value(els):\n    return els[0].name\n")
    res = sess.call("value", ["nope"])
    assert res.error is not None
    assert res.error.kind == "runtime"
    assert "NotFoundError" in res.error.message
    assert bridge_call_log.count("element") == 1  # guest fell back to a fetch


def test_step_entry_gets_piggybacked_root(bridge_call_log: list[str]) -> None:
    sess = _open("def step(el):\n    return [el]\n")
    res = sess.call("step", ["b1"])
    assert res.error is None
    assert res.value == {"ids": ["b1"]}
    assert bridge_call_log == []
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_trip_counts.py -v`
Expected: the three new tests FAIL (`bridge_call_log` shows one `element` fetch per root).

- [ ] **Step 3: Add `_dr_call_entry` to the facade**

In `src/data_rover/core/script/facade_src.py`, inside `FACADE_SOURCE`, insert immediately before the `_dr_serialize_entry_result` function:

```python
def _dr_call_entry(entry, element_ids, elements=None):
    # Single per-call driver for embedded sessions (M2/M3): prime the read
    # memo with the host-projected root elements, build the Element handles,
    # invoke the snippet's entry point, and serialize its result. Both hosts
    # (the WASM bootstrap loop and the trusted test session) call THIS —
    # per-call semantics live in exactly one place, so the two runners
    # cannot drift. Roots the host could not project (a benign race with a
    # concurrent delete) are simply absent from `elements`; _fetch_element
    # then goes to the bridge and surfaces the same NotFoundError a direct
    # fetch always produced. Raises on snippet errors — the caller owns the
    # exception -> error-result mapping (traceback formatting differs by
    # host). NOT part of the documented dr API (underscored on purpose).
    for proj in elements or []:
        _memo_put(("element", proj["id"]), proj)
    fn = globals().get(entry)
    if fn is None or not callable(fn):
        raise NameError("entry function " + repr(entry) + " is not defined")
    els = [_fetch_element(i) for i in element_ids]
    value = fn(els if entry == "value" else (els[0] if els else None))
    return _dr_serialize_entry_result(entry, value)
```

(`globals()` inside a facade function IS the exec namespace, where the
snippet's entry function also lives — same lookup the bootstrap's
`namespace.get(entry)` performed.)

- [ ] **Step 4: Use it from the WASM bootstrap**

In `src/data_rover/api/script_runner.py`, in `_GUEST_BOOTSTRAP_SOURCE`'s `_run_embedded`, replace the body of the per-call `try` block (the lines from `fn = namespace.get(entry)` through `payload = namespace["_dr_serialize_entry_result"](entry, value)`) so the loop reads:

```python
        call = msg.get("call")
        if call is None:
            continue
        entry = call["entry"]
        element_ids = call["element_ids"]
        elements = call.get("elements")
        cerr = None
        payload = None
        sys.stdout = stdout
        try:
            payload = namespace["_dr_call_entry"](entry, element_ids, elements)
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

- [ ] **Step 5: Ship projected roots from the WASM session**

In `_WasmSnippetSession.call`, replace the write of the call message with:

```python
        elements = []
        for eid in element_ids:
            try:
                elements.append(
                    project_element(self._dispatcher.model.get_element(eid))
                )
            except KeyError:
                # Benign race (root deleted since binding): omit — the
                # guest's own fetch surfaces NotFoundError, today's shape.
                pass
        self._inst.host_in.write(
            json.dumps(
                {
                    "call": {
                        "entry": entry,
                        "element_ids": element_ids,
                        "elements": elements,
                    }
                }
            )
            + "\n"
        )
```

Add the import at the top of `script_runner.py`'s existing core imports:

```python
from data_rover.core.script.bridge import project_element
```

(Check the module's current import section: `BridgeDispatcher` is imported lazily inside methods for cycle reasons — `project_element` is a plain function on the same module, so import it lazily in `call` alongside the pattern if a top-level import creates a cycle; `data_rover.core.script.bridge` imports only `core` modules, so a top-level import is safe. Prefer top-level.)

- [ ] **Step 6: Use the helper from the trusted session**

In `tests/script/trusted_runner.py`, `_TrustedSession.__init__`: store the model — add `self._model = model` next to `self._limits = limits`. Then replace `_TrustedSession.call`'s try-block body:

```python
    def call(self, entry: str, element_ids: list[str]) -> CallResult:
        start = time.monotonic()
        if self.boot_error is not None:
            return CallResult(value=None, error=self.boot_error, duration_ms=0)
        elements = []
        for eid in element_ids:
            try:
                elements.append(project_element(self._model.get_element(eid)))
            except KeyError:
                pass  # guest-side fetch surfaces NotFoundError, today's shape
        stdout = _CappedStdout(self._limits.stdout_bytes)
        with contextlib.redirect_stdout(stdout):  # type: ignore[type-var]
            try:
                payload = self._namespace["_dr_call_entry"](
                    entry, element_ids, elements
                )
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
```

Add `project_element` to the existing `from data_rover.core.script.bridge import BridgeDispatcher` line.

- [ ] **Step 7: Update the earlier trip-count expectations**

Root piggyback removes the per-root `element` fetch, so the counts pinned in
Tasks 1–3 change. Update `tests/script/test_trip_counts.py`:

- `test_fixture_counts_dispatch_calls`: the root no longer produces an
  `element` trip. Change the snippet to fetch a non-root so the sanity check
  still exercises counting:

```python
def test_fixture_counts_dispatch_calls(bridge_call_log: list[str]) -> None:
    sess = _open("def value(els):\n    return dr.element('b2').name\n")
    res = sess.call("value", ["b1"])
    assert res.error is None
    assert bridge_call_log.count("element") == 1  # b2; the b1 root rode the call frame
```

- `test_element_refetch_is_memoized`: `assert bridge_call_log.count("element") == 1  # b2 once; b1 root piggybacked`
- `test_memo_survives_across_calls`: `assert bridge_call_log.count("element") == 1  # b2 once; b1/b3 roots piggybacked`
- `test_memo_cap_evicts_oldest`: `assert bridge_call_log.count("element") == 3  # b2, b3, b2-again; b1 root piggybacked (primed, then evicted under cap=1)`
- `test_hop_primes_neighbor_projections`: `assert bridge_call_log.count("element") == 0  # root piggybacked, neighbor rode the hop`
- `test_incoming_primes_source_projections`: `assert bridge_call_log.count("element") == 0`

- [ ] **Step 8: Run the full hermetic suite**

Run: `pixi run -e core-dev pytest tests/script tests/api -q`
Expected: ALL pass. Pay attention to `tests/script/test_embed_cache.py` and `tests/api/_script_fakes.py`-based suites — behavior parity is required, only trip counts change.

- [ ] **Step 9: Lint**

Run: `pixi run dr-tidy`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/data_rover/core/script/facade_src.py src/data_rover/api/script_runner.py tests/script/trusted_runner.py tests/script/test_trip_counts.py
git commit -m "feat(script): piggyback projected roots on embedded calls via facade _dr_call_entry"
```

---

### Task 5: WASM integration leg + trips-per-cell perf guard

Prove the collapsed protocol against the real sandbox and pin it with a perf
guard so a regression that reintroduces per-read trips fails loudly.

**Files:**
- Modify: `tests/api/test_snippets_wasm.py` (integration-marked)
- Modify: `tests/api/test_script_sweep_perf.py` (perf-marked)

**Interfaces:**
- Consumes: `bridge_call_log`-style counting via `monkeypatch` on `BridgeDispatcher.dispatch` (host-side, so it counts WASM bridge trips too).

- [ ] **Step 1: Add the integration test**

Append to `tests/api/test_snippets_wasm.py` (reuse its existing wasm-runner fixture/skip pattern — read the file's fixtures first and match them; it already skips when the guest binary is absent):

```python
def test_embedded_session_trip_collapse_wasm(
    wasm_runner, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Real-sandbox leg of tests/script/test_trip_counts.py: a property-math
    cell makes ZERO bridge reads (roots piggybacked), and a hop + neighbor
    fetch makes ONE (far endpoints inlined)."""
    from data_rover.core.script.bridge import BridgeDispatcher
    from data_rover.core.script.runner import RunLimits, ScriptBudget
    from tests.script.conftest import tiny_model

    calls: list[str] = []
    orig = BridgeDispatcher.dispatch

    def counting(self, req):
        op = req.get("op")
        calls.append(op if isinstance(op, str) else "write")
        return orig(self, req)

    monkeypatch.setattr(BridgeDispatcher, "dispatch", counting)

    model = tiny_model()
    sess = wasm_runner.open_session(
        model,
        "def value(els):\n"
        "    n = els[0].name\n"
        "    for rel in els[0].out():\n"
        "        n += dr.element(rel['target_id']).name\n"
        "    return n\n",
        RunLimits(),
        budget=ScriptBudget.start(60),
    )
    try:
        assert sess.boot_error is None, sess.boot_error
        res = sess.call("value", ["b1"])
        assert res.error is None, res.error
        assert res.value == {"kind": "scalar", "value": "Building OneBuilding Two"}
        assert calls == ["outgoing"]
    finally:
        sess.close()
```

Adapt the fixture name to whatever `tests/api/test_snippets_wasm.py` actually provides (it has an existing module-scoped runner fixture; if its name differs from `wasm_runner`, use that name).

- [ ] **Step 2: Add the trips-per-cell perf guard**

Append to `tests/api/test_script_sweep_perf.py`:

```python
#: Traversal snippet for the trips-per-cell guard: one hop plus a far-element
#: read per row. Post trip-collapse this costs exactly ONE dispatch per cell
#: (the hop); the far endpoints ride the hop response and the root rides the
#: call frame. Budget 3 leaves headroom, not room for a per-read regression
#: (which would cost 2+ extra trips per cell).
TRAVERSAL_CODE = (
    "def value(els):\n"
    "    n = els[0]['name']\n"
    "    for rel in els[0].out():\n"
    "        n = n + dr.element(rel['target_id'])['name']\n"
    "    return n\n"
)
MAX_TRIPS_PER_CELL = 3.0


def test_trips_per_cell_budget(
    wasm_runner: WasmScriptRunner,
    big_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from data_rover.core.script.bridge import BridgeDispatcher

    count = [0]
    orig = BridgeDispatcher.dispatch

    def counting(self, req):  # type: ignore[no-untyped-def]
        count[0] += 1
        return orig(self, req)

    monkeypatch.setattr(BridgeDispatcher, "dispatch", counting)
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_SYNC", "true")
    monkeypatch.setenv("DATA_ROVER_SNIPPET_SWEEP_WORKERS", "1")
    settings: Settings = get_settings()
    reset_global_slots()
    big_session.table_order_cache.clear()
    big_session.script_cell_cache.clear_and_stamp(big_session.model_rev)
    big_session.script_sweeps.cancel_all()
    _wait_for_pool(wasm_runner, 2)

    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": ["Thing"]},
            "columns": [
                {"kind": "element"},
                {"kind": "script", "snippet": {"definition": {"code": TRAVERSAL_CODE}}},
            ],
        }
    )
    assert big_session.metamodel is not None and big_session.model is not None
    job = kick_or_join_sweep(
        big_session,
        big_session.metamodel,
        big_session.model,
        defn,
        wasm_runner,
        settings,
        big_session.model_rev,
    )
    assert job.state == "done", (job.state, job.message)
    per_cell = count[0] / SWEEP_ROWS
    print(f"\nbridge trips per cell: {per_cell:.2f} ({count[0]} trips / {SWEEP_ROWS} cells)")
    assert per_cell < MAX_TRIPS_PER_CELL
```

- [ ] **Step 3: Run (only if the guest binary is fetched; otherwise verify skip)**

Run: `pixi run -e core-dev pytest tests/api/test_snippets_wasm.py tests/api/test_script_sweep_perf.py -m "integration or perf" -v`
Expected: PASS if `spikes/code_exec/vendor/python.wasm` exists; SKIP otherwise. If skipped, note in the commit message that the integration leg was skip-verified only.

Also run the hermetic default to prove no accidental deselection breakage:
`pixi run -e core-dev pytest tests/api -q` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/api/test_snippets_wasm.py tests/api/test_script_sweep_perf.py
git commit -m "test(script): wasm integration leg + trips-per-cell perf guard for trip collapse"
```

---

### Task 6: Read-set capture in the facade and on the wire

Phase B begins. The facade records every read it *uses* (memo hits included)
as a structured key; `_dr_call_entry` returns `{"payload", "reads"}` where
`reads` is the boot-time reads ∪ this call's reads (or `None` on overflow);
both runners plumb it into `CallResult.reads`. The host validates the
untrusted wire shape via `decode_reads`.

Read-key vocabulary (spec Phase B):
`("el", id)`, `("out", id)`, `("in", id)`, `("children", id)`,
`("parent", id)`, `("scan", type_name_or_None)`.

**Files:**
- Modify: `src/data_rover/core/script/facade_src.py`
- Modify: `src/data_rover/core/script/runner.py` (`ReadKey`, `CallResult.reads`, `decode_reads`)
- Modify: `src/data_rover/api/script_runner.py` (bootstrap ships reads; session decodes)
- Modify: `tests/script/trusted_runner.py`
- Create: `tests/script/test_read_sets.py`

**Interfaces:**
- Produces: `ReadKey = tuple[str, str | None]`; `CallResult.reads: frozenset[ReadKey] | None = None` (`None` = "depends on everything"); `decode_reads(obj: object) -> frozenset[ReadKey] | None`; facade `_dr_call_entry` now returns `{"payload": <tagged>, "reads": <sorted list of 2-lists> | None}`; wire `call_result` gains `"reads"`. Facade constant `_READS_CAP = 2000`.
- Error results carry `reads=None` (always-evict) — the exception path never collects reads; this is deliberate over-invalidation.

- [ ] **Step 1: Write failing tests**

Create `tests/script/test_read_sets.py`:

```python
"""Read-set attribution tests (Phase B): every read a call USES — including
memo hits and piggyback-primed projections — lands in `CallResult.reads`."""

from __future__ import annotations

from data_rover.core.script.runner import (
    RunLimits,
    ScriptBudget,
    decode_reads,
)

from tests.script.conftest import tiny_model
from tests.script.trusted_runner import TrustedRunner


def _call(code: str, ids: list[str], *, calls: int = 1):
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(model, code, RunLimits(), budget=ScriptBudget.start(60))
    assert sess.boot_error is None, sess.boot_error
    res = None
    for _ in range(calls):
        res = sess.call("value", ids)
    assert res is not None and res.error is None, res and res.error
    return res


def test_root_read_recorded_despite_piggyback() -> None:
    res = _call("def value(els):\n    return els[0].name\n", ["b1"])
    assert res.reads == frozenset({("el", "b1")})


def test_traversal_reads_recorded() -> None:
    res = _call(
        "def value(els):\n"
        "    n = els[0].name\n"
        "    for rel in els[0].out():\n"
        "        n += dr.element(rel['target_id']).name\n"
        "    els[0].children()\n"
        "    els[0].parent()\n"
        "    return n\n",
        ["b1"],
    )
    assert res.reads == frozenset(
        {
            ("el", "b1"),
            ("out", "b1"),
            ("children", "b1"),
            ("parent", "b1"),
            ("el", "b2"),
        }
    )


def test_memo_hit_charged_to_reusing_call() -> None:
    # Second call reuses the memoized b2 fetch; its read-set must still
    # contain ("el", "b2") even though no bridge trip happened.
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(
        model,
        "def value(els):\n    return dr.element('b2').name\n",
        RunLimits(),
        budget=ScriptBudget.start(60),
    )
    assert sess.boot_error is None
    first = sess.call("value", ["b1"])
    second = sess.call("value", ["b3"])
    assert first.reads == frozenset({("el", "b1"), ("el", "b2")})
    assert second.reads == frozenset({("el", "b3"), ("el", "b2")})


def test_scan_read_recorded() -> None:
    res = _call(
        "def value(els):\n"
        "    return sum(1 for _ in dr.elements(type='Building'))\n",
        ["b1"],
    )
    assert res.reads == frozenset({("el", "b1"), ("scan", "Building")})


def test_untyped_scan_records_none_key() -> None:
    res = _call(
        "def value(els):\n    return sum(1 for _ in dr.elements())\n", ["b1"]
    )
    assert res.reads == frozenset({("el", "b1"), ("scan", None)})


def test_boot_reads_charged_to_every_call() -> None:
    res = _call(
        "_index = {e.id: e.name for e in dr.elements(type='Building')}\n"
        "def value(els):\n"
        "    return _index[els[0].id]\n",
        ["b2"],
    )
    assert res.reads is not None
    assert ("scan", "Building") in res.reads  # boot-time scan
    assert ("el", "b2") in res.reads


def test_error_call_has_no_reads() -> None:
    model = tiny_model()
    runner = TrustedRunner()
    sess = runner.open_session(
        model,
        "def value(els):\n    raise RuntimeError('boom')\n",
        RunLimits(),
        budget=ScriptBudget.start(60),
    )
    res = sess.call("value", ["b1"])
    assert res.error is not None
    assert res.reads is None


def test_decode_reads_accepts_and_rejects() -> None:
    ok = decode_reads([["el", "b1"], ["scan", None]])
    assert ok == frozenset({("el", "b1"), ("scan", None)})
    assert decode_reads(None) is None
    assert decode_reads("nope") is None
    assert decode_reads([["el"]]) is None  # wrong arity
    assert decode_reads([["el", 7]]) is None  # non-str id
    assert decode_reads([[7, "x"]]) is None  # non-str tag
    assert decode_reads([["x" * 33, "b1"]]) is None  # tag too long
    assert decode_reads([["el", "x" * 513]]) is None  # id too long
    assert decode_reads([["el", str(i)] for i in range(2001)]) is None  # cap
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_read_sets.py -v`
Expected: FAIL — `ImportError: cannot import name 'decode_reads'`.

- [ ] **Step 3: Add `ReadKey`, `CallResult.reads`, `decode_reads`**

In `src/data_rover/core/script/runner.py`:

After the module imports, add:

```python
#: One structured read dependency recorded by the guest facade (Phase B,
#: spec 2026-07-21): ("el", id) | ("out", id) | ("in", id) |
#: ("children", id) | ("parent", id) | ("scan", type_name_or_None).
ReadKey = tuple[str, str | None]
```

Extend `CallResult`:

```python
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
    """

    value: dict | None
    error: ScriptError | None
    duration_ms: int
    reads: frozenset[ReadKey] | None = None
```

After `decode_call_payload`, add:

```python
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
```

- [ ] **Step 4: Record reads in the facade**

In `src/data_rover/core/script/facade_src.py`, insert after the `_memo_put` definition:

```python
_READS_CAP = 2000

# Read-set recording (Phase B): _boot_reads accumulates reads made during
# module exec (an import-time index feeds every later call, so its reads
# belong to every call's set); _call_reads[0] holds the active per-call set
# while _dr_call_entry is driving, else None (console 'script' runs record
# into _boot_reads and never ship it — harmless). Overflow past _READS_CAP
# flips the matching flag and the call reports reads=None ("depends on
# everything") — the conservative direction.
_boot_reads = set()
_boot_overflow = [False]
_call_reads = [None]
_call_overflow = [False]


def _note_read(tag, ident):
    target = _call_reads[0]
    if target is None:
        if len(_boot_reads) >= _READS_CAP:
            _boot_overflow[0] = True
        else:
            _boot_reads.add((tag, ident))
        return
    if len(target) >= _READS_CAP:
        _call_overflow[0] = True
    else:
        target.add((tag, ident))
```

Add one `_note_read` line to each wrapper, placed BEFORE the memo probe so
memo hits are charged to the reusing call:

- `_fetch_element`: first line `_note_read("el", element_id)`
- `Element.out`: first line `_note_read("out", self.id)`
- `Element.in_`: first line `_note_read("in", self.id)`
- `Element.children`: first line `_note_read("children", self.id)`
- `Element.parent`: first line `_note_read("parent", self.id)`
- `_iter_elements`: first line of the function (before the loop) `_note_read("scan", type)`

(`types`/`type_info` record nothing: the metamodel cannot change under a
model commit; metamodel swap clears the whole cache.)

Replace `_dr_call_entry` (from Task 4) with the reads-returning version:

```python
def _dr_call_entry(entry, element_ids, elements=None):
    # Single per-call driver for embedded sessions (M2/M3): prime the read
    # memo with the host-projected roots, build handles, invoke the entry
    # point, serialize, and report the call's read-set (boot reads union
    # per-call reads; None on overflow). Both hosts call THIS — per-call
    # semantics live in one place, so the runners cannot drift. Roots the
    # host could not project are absent from `elements`; _fetch_element then
    # surfaces NotFoundError exactly as a direct fetch would. Raises on
    # snippet errors — the caller owns exception -> error-result mapping
    # (and an errored call ships no reads: reads=None, always-evict). NOT
    # part of the documented dr API (underscored on purpose).
    _call_reads[0] = set()
    _call_overflow[0] = False
    try:
        for proj in elements or []:
            _memo_put(("element", proj["id"]), proj)
        fn = globals().get(entry)
        if fn is None or not callable(fn):
            raise NameError("entry function " + repr(entry) + " is not defined")
        els = [_fetch_element(i) for i in element_ids]
        value = fn(els if entry == "value" else (els[0] if els else None))
        payload = _dr_serialize_entry_result(entry, value)
        if _boot_overflow[0] or _call_overflow[0]:
            reads = None
        else:
            merged = _boot_reads | _call_reads[0]
            if len(merged) > _READS_CAP:
                reads = None
            else:
                reads = sorted(list(k) for k in merged)
        return {"payload": payload, "reads": reads}
    finally:
        _call_reads[0] = None
```

Note: piggybacked roots get their `("el", id)` key via `_fetch_element`'s
`_note_read`, which runs whether the fetch is a memo hit or a bridge trip —
that is the "charged to the using call" property the tests pin.

- [ ] **Step 5: Ship reads over the WASM wire**

In `src/data_rover/api/script_runner.py`, `_GUEST_BOOTSTRAP_SOURCE`'s `_run_embedded` per-call block (from Task 4) becomes:

```python
        cerr = None
        payload = None
        reads = None
        sys.stdout = stdout
        try:
            res = namespace["_dr_call_entry"](entry, element_ids, elements)
            payload = res["payload"]
            reads = res["reads"]
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
        _emit({"call_result": {"payload": payload, "error": cerr, "reads": reads}})
```

In `_WasmSnippetSession.call`, thread reads into the success return. The final block becomes:

```python
        decoded, dmsg = decode_call_payload(entry, cr.get("payload"))
        if decoded is None:
            return CallResult(
                value=None,
                error=ScriptError(kind="runtime", message=dmsg or "malformed payload"),
                duration_ms=duration_ms,
            )
        return CallResult(
            value=decoded,
            error=None,
            duration_ms=duration_ms,
            reads=decode_reads(cr.get("reads")),
        )
```

Add `decode_reads` to the module's existing `from data_rover.core.script.runner import ...` line.

- [ ] **Step 6: Thread reads through the trusted session**

In `tests/script/trusted_runner.py`, `_TrustedSession.call` (from Task 4): the helper now returns a dict —

```python
                res = self._namespace["_dr_call_entry"](
                    entry, element_ids, elements
                )
```

then after decoding:

```python
        decoded, msg = decode_call_payload(entry, res["payload"])
        duration_ms = int((time.monotonic() - start) * 1000)
        if decoded is None:
            return CallResult(
                value=None,
                error=ScriptError(kind="runtime", message=msg or "malformed payload"),
                duration_ms=duration_ms,
            )
        return CallResult(
            value=decoded,
            error=None,
            duration_ms=duration_ms,
            reads=decode_reads(res["reads"]),
        )
```

Add `decode_reads` to the module's `from data_rover.core.script.runner import ...` block.

- [ ] **Step 7: Run the tests**

Run: `pixi run -e core-dev pytest tests/script -q`
Expected: ALL pass (new read-set suite + trip-count suite + everything prior).

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/core/script/facade_src.py src/data_rover/core/script/runner.py src/data_rover/api/script_runner.py tests/script/trusted_runner.py tests/script/test_read_sets.py
git commit -m "feat(script): per-call read-set capture in the facade, shipped on the call_result wire"
```

---

### Task 7: Cell cache stores read-sets and evicts selectively

`ScriptCellCache` entries become `(CallResult, reads)`; `put` takes `reads`;
new `evict_touched(touched, rev)` drops intersecting (or `reads=None`)
entries and re-stamps survivors. `ScriptEvalContext` passes `res.reads`
through.

**Files:**
- Modify: `src/data_rover/core/script/cell_cache.py`
- Modify: `src/data_rover/core/script/embed.py`
- Test: `tests/script/test_cell_cache.py`, `tests/script/test_embed_cache.py`

**Interfaces:**
- Consumes: `ReadKey`, `CallResult.reads` (Task 6).
- Produces: `ScriptCellCache.put(key, result, rev, reads=None)`; `ScriptCellCache.evict_touched(touched: frozenset[ReadKey], rev: int) -> None` with the contract: called with the JUST-BUMPED rev; if `rev != stamp + 1` it clears everything (unknown intermediate history); otherwise survivors carry to the new stamp. `get` signature and return type unchanged.

- [ ] **Step 1: Write failing tests**

Append to `tests/script/test_cell_cache.py` (match its existing helpers for building `CallResult`s; it already imports `ScriptCellCache` and `CallResult`):

```python
def _res(v: int) -> CallResult:
    return CallResult(value={"kind": "scalar", "value": v}, error=None, duration_ms=1)


def test_evict_touched_drops_intersecting_and_keeps_rest() -> None:
    c = ScriptCellCache(cap=10)
    c.clear_and_stamp(5)
    c.put(("sa", "value", ("t1",)), _res(1), 5, reads=frozenset({("el", "t1")}))
    c.put(("sb", "value", ("t2",)), _res(2), 5, reads=frozenset({("el", "t2")}))
    c.evict_touched(frozenset({("el", "t1")}), 6)
    assert c.stamp == 6
    assert c.get(("sa", "value", ("t1",)), 6) is None
    hit = c.get(("sb", "value", ("t2",)), 6)
    assert hit is not None and hit.value == {"kind": "scalar", "value": 2}


def test_evict_touched_none_reads_always_evicted() -> None:
    c = ScriptCellCache(cap=10)
    c.clear_and_stamp(5)
    c.put(("sa", "value", ("t1",)), _res(1), 5, reads=None)
    c.evict_touched(frozenset(), 6)
    assert c.get(("sa", "value", ("t1",)), 6) is None


def test_evict_touched_non_adjacent_rev_clears_all() -> None:
    c = ScriptCellCache(cap=10)
    c.clear_and_stamp(5)
    c.put(("sa", "value", ("t1",)), _res(1), 5, reads=frozenset({("el", "zz")}))
    c.evict_touched(frozenset(), 9)  # unknown history between 5 and 9
    assert c.stamp == 9
    assert c.size == 0


def test_survivor_hits_at_new_rev_only() -> None:
    c = ScriptCellCache(cap=10)
    c.clear_and_stamp(5)
    c.put(("sb", "value", ("t2",)), _res(2), 5, reads=frozenset({("el", "t2")}))
    c.evict_touched(frozenset({("el", "other")}), 6)
    assert c.get(("sb", "value", ("t2",)), 5) is None  # old rev misses
    assert c.get(("sb", "value", ("t2",)), 6) is not None
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_cell_cache.py -v`
Expected: new tests FAIL (`put` has no `reads` kwarg / no `evict_touched`).

- [ ] **Step 3: Implement**

In `src/data_rover/core/script/cell_cache.py`:

Change the import to include `ReadKey`:

```python
from .runner import CallResult, ReadKey
```

Change the store type and `put`/`get`, and add `evict_touched`:

```python
        self._d: OrderedDict[CellKey, tuple[CallResult, frozenset[ReadKey] | None]] = (
            OrderedDict()
        )

    def get(self, key: CellKey, rev: int) -> CallResult | None:
        with self._lock:
            if rev != self._stamp:
                return None
            hit = self._d.get(key)
            if hit is None:
                return None
            self._d.move_to_end(key)
            return hit[0]

    def put(
        self,
        key: CellKey,
        result: CallResult,
        rev: int,
        reads: frozenset[ReadKey] | None = None,
    ) -> None:
        if result.error is not None and result.error.kind not in _CACHEABLE_ERROR_KINDS:
            return
        with self._lock:
            if rev < self._stamp:
                return  # stale writer: poisoning guard
            if rev > self._stamp:
                self._d.clear()
                self._stamp = rev
            self._d[key] = (result, reads)
            self._d.move_to_end(key)
            while len(self._d) > self._cap:
                self._d.popitem(last=False)

    def evict_touched(self, touched: frozenset[ReadKey], rev: int) -> None:
        """Selective post-commit invalidation (spec 2026-07-21 Phase B).

        Called with the JUST-BUMPED ``model_rev`` while its commit's touched
        read-keys are in hand. Drops every entry whose read-set intersects
        ``touched`` — or whose read-set is ``None``, meaning "depends on
        everything" (pre-read-set result, overflow, errored call) — and
        re-stamps the survivors to ``rev`` in place: they were computed
        against state this commit provably did not touch.

        ``rev != stamp + 1`` degrades to clear-all: some path moved the rev
        without coming through here (or a stale stamp survived a lazy
        period), so the intermediate history is unknown and keeping anything
        would be a guess. Over-invalidation is always the safe direction.
        """
        with self._lock:
            if rev != self._stamp + 1:
                self._d.clear()
                self._stamp = rev
                return
            self._stamp = rev
            doomed = [
                k
                for k, (_res, reads) in self._d.items()
                if reads is None or not touched.isdisjoint(reads)
            ]
            for k in doomed:
                del self._d[k]
```

Update the module docstring's "Error results" paragraph to append: cached
deterministic errors carry whatever ``reads`` their call reported (usually
``None`` — errored calls ship no read-set — so they are evicted by every
commit; conservative and cheap).

- [ ] **Step 4: Pass reads through the eval context**

In `src/data_rover/core/script/embed.py`, `ScriptEvalContext.call`, change the write-through line:

```python
        if self._cell_cache is not None and ckey is not None:
            # put() filters non-deterministic error kinds itself
            self._cell_cache.put(ckey, res, self._rev, reads=res.reads)
```

- [ ] **Step 5: Add a write-through attribution test**

Append to `tests/script/test_embed_cache.py` (match its existing fixtures — it builds `ScriptEvalContext`s over `TrustedRunner` and a cell cache; reuse its helpers):

```python
def test_write_through_carries_reads() -> None:
    from data_rover.core.script.cell_cache import ScriptCellCache
    from data_rover.core.script.embed import ScriptEvalContext
    from data_rover.core.script.runner import RunLimits, ScriptBudget
    from tests.script.conftest import tiny_model
    from tests.script.trusted_runner import TrustedRunner

    cache = ScriptCellCache(cap=10)
    cache.clear_and_stamp(3)
    ctx = ScriptEvalContext(
        TrustedRunner(),
        tiny_model(),
        RunLimits(),
        ScriptBudget.start(60),
        cell_cache=cache,
        rev=3,
    )
    try:
        res = ctx.call("def value(els):\n    return els[0].name\n", "value", ["b1"])
        assert res.error is None
    finally:
        ctx.close()
    # the stored entry survives a commit that does NOT touch b1...
    cache.evict_touched(frozenset({("el", "b2")}), 4)
    assert cache.size == 1
    # ...and is evicted by one that does
    cache.evict_touched(frozenset({("el", "b1")}), 5)
    assert cache.size == 0
```

- [ ] **Step 6: Run the tests**

Run: `pixi run -e core-dev pytest tests/script -q`
Expected: ALL pass.

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/core/script/cell_cache.py src/data_rover/core/script/embed.py tests/script/test_cell_cache.py tests/script/test_embed_cache.py
git commit -m "feat(script): cell cache stores read-sets and evicts selectively (evict_touched)"
```

---

### Task 8: Touched-key builder from an applied op batch

Translate one applied batch (`_BatchResult`) into the read-keys it touches.
Deleted-entity metadata (types, endpoints) comes from the batch's inverse
units — the only place it survives the apply. Returns `None` ("unknown —
clear everything") if expected metadata is missing; over-invalidation is the
only safe failure mode.

**Files:**
- Create: `src/data_rover/api/invalidation.py`
- Create: `tests/api/test_invalidation.py`

**Interfaces:**
- Consumes: `ReadKey` (Task 6); `_BatchResult` duck-typed (`changed_element_ids`, `deleted_element_ids`, `changed_relationship_ids`, `deleted_relationship_ids`, `inverse_units` — all from `routes/ops.py`); `Metamodel.element_ancestors` / `is_containment`; `Model.container_of` / `.elements` / `.relationships`.
- Produces: `touched_keys(model: Model, metamodel: Metamodel, res) -> frozenset[ReadKey] | None`.

Key rules (from the spec):
- changed (created/updated) element E of type T: `("el", E)`; `("children", container_of(E))` if it has a parent (its projection appears in the parent's `children()` payload); `("scan", None)` + `("scan", A)` for every A in `{T} ∪ ancestors(T)` (its projection appears in those scans).
- deleted element E: `("el", E)` + the same scan keys for its (inverse-unit-recorded) type. Its parent's `children` key comes from the containment-relationship rule — the cascade delete removed that relationship too.
- changed/deleted relationship R (type RT, source S, target G): `("out", S)`, `("in", G)`; containment RT additionally `("children", S)`, `("parent", G)`.

- [ ] **Step 1: Write failing tests**

Create `tests/api/test_invalidation.py`:

```python
"""Table-driven tests for `touched_keys` (Phase B): each op kind maps to an
exact set of read-keys. Batches are applied through the REAL `_apply_batch`
so the `_BatchResult` shapes match production."""

from __future__ import annotations

from data_rover.api.invalidation import touched_keys
from data_rover.api.routes.ops import _apply_batch
from data_rover.api.schemas import OPS_ADAPTER
from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Base",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(name="Derived", extends="Base"),
        ],
        relationships=[
            RelationshipType(
                name="Owns", containment=True, source="Base", target="Base"
            ),
            RelationshipType(name="Uses", source="Base", target="Base"),
        ],
    )


def _model() -> Model:
    m = Model(_mm())
    a = m.restore_element("a", "Base")
    b = m.restore_element("b", "Derived")
    m.restore_element("c", "Base")
    m.set_property(a, "name", "A")
    m.set_property(b, "name", "B")
    m.connect("Owns", "a", "b")
    return m


def _apply(model: Model, ops: list[dict]):
    return _apply_batch(model, OPS_ADAPTER.validate_python(ops), restore=False)


def test_update_element_keys() -> None:
    model = _model()
    res = _apply(
        model,
        [{"kind": "update_element", "id": "b", "properties_patch": {"name": "B2"}}],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys == frozenset(
        {
            ("el", "b"),
            ("children", "a"),  # b's projection rides a.children()
            ("scan", None),
            ("scan", "Derived"),
            ("scan", "Base"),  # ancestor scans see Derived elements
        }
    )


def test_update_root_element_has_no_children_key() -> None:
    model = _model()
    res = _apply(
        model,
        [{"kind": "update_element", "id": "a", "properties_patch": {"name": "A2"}}],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys == frozenset({("el", "a"), ("scan", None), ("scan", "Base")})


def test_create_relationship_keys() -> None:
    model = _model()
    res = _apply(
        model,
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r1",
                "type_name": "Uses",
                "source_id": "a",
                "target_id": "c",
                "properties": {},
            }
        ],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys == frozenset({("out", "a"), ("in", "c")})


def test_containment_relationship_adds_children_and_parent() -> None:
    model = _model()
    res = _apply(
        model,
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r2",
                "type_name": "Owns",
                "source_id": "a",
                "target_id": "c",
                "properties": {},
            }
        ],
    )
    keys = touched_keys(model, model.metamodel, res)
    assert keys == frozenset(
        {("out", "a"), ("in", "c"), ("children", "a"), ("parent", "c")}
    )


def test_delete_element_cascade_keys() -> None:
    model = _model()
    res = _apply(model, [{"kind": "delete_element", "id": "b"}])
    keys = touched_keys(model, model.metamodel, res)
    # b deleted (type Derived, from the inverse unit); the a->b Owns
    # relationship cascaded away with it.
    assert keys == frozenset(
        {
            ("el", "b"),
            ("scan", None),
            ("scan", "Derived"),
            ("scan", "Base"),
            ("out", "a"),
            ("in", "b"),
            ("children", "a"),
            ("parent", "b"),
        }
    )


def test_create_element_keys() -> None:
    model = _model()
    res = _apply(
        model,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Derived",
                "properties": {"name": "X"},
            }
        ],
    )
    keys = touched_keys(model, model.metamodel, res)
    new_id = res.id_map["tmp_x"]
    assert keys == frozenset(
        {("el", new_id), ("scan", None), ("scan", "Derived"), ("scan", "Base")}
    )
```

Note: if `OPS_ADAPTER` lives under a different name in `data_rover/api/schemas.py`, use the module's actual exported adapter (CLAUDE.md names it `schemas.OPS_ADAPTER`). If `ElementType`/`RelationshipType` constructor fields differ, mirror `tests/validation/test_endpoint_typing.py`'s metamodel construction.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_invalidation.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.api.invalidation`.

- [ ] **Step 3: Implement the builder**

Create `src/data_rover/api/invalidation.py`:

```python
"""Translate one applied op batch into the read-keys it touches (Phase B,
spec 2026-07-21).

`touched_keys` is the commit-side half of incremental cell-cache
invalidation: the guest facade records what each cell READ (`ReadKey`
tuples on `CallResult.reads`), this module computes what a commit WROTE in
the same vocabulary, and `ScriptCellCache.evict_touched` drops the
intersection. Everything here is conservative by construction:

- A changed element also touches its ancestors' `("scan", ...)` keys and its
  parent's `("children", ...)` key because scan pages and `children()`
  responses inline full element projections — a property change is visible
  through them, not just through `("el", id)`.
- Deleted-entity metadata (types, endpoints) is recovered from the batch's
  inverse units — the only place it survives the apply. If any expected
  metadata is missing, the function returns ``None`` ("unknown — clear
  everything"): over-invalidation is the only safe failure mode.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.script.runner import ReadKey

from .schemas import CreateElementOp, CreateRelationshipOp

if TYPE_CHECKING:
    from .routes.ops import _BatchResult


def touched_keys(
    model: Model, metamodel: Metamodel, res: _BatchResult
) -> frozenset[ReadKey] | None:
    """Read-keys touched by ``res`` (an applied batch), or ``None`` for
    "unknown — caller must clear everything". ``model`` is the POST-apply
    model (changed entities are still present; deleted ones are gone)."""
    touched: set[ReadKey] = set()
    scan_seen: set[str | None] = set()

    def scan_keys(type_name: str) -> None:
        if None not in scan_seen:
            scan_seen.add(None)
            touched.add(("scan", None))
        for t in {type_name, *metamodel.element_ancestors(type_name)}:
            if t not in scan_seen:
                scan_seen.add(t)
                touched.add(("scan", t))

    def rel_keys(type_name: str, source_id: str, target_id: str) -> None:
        touched.add(("out", source_id))
        touched.add(("in", target_id))
        if metamodel.is_containment(type_name):
            touched.add(("children", source_id))
            touched.add(("parent", target_id))

    # Deleted-entity metadata from the inverse units (delete inverses are
    # the creates that would restore them, carrying type/endpoints).
    deleted_el_types: dict[str, str] = {}
    deleted_rels: dict[str, tuple[str, str, str]] = {}
    for unit in res.inverse_units:
        for op in unit:
            if isinstance(op, CreateElementOp):
                deleted_el_types[op.temp_id] = op.type_name
            elif isinstance(op, CreateRelationshipOp):
                deleted_rels[op.temp_id] = (op.type_name, op.source_id, op.target_id)

    for eid in res.changed_element_ids:
        el = model.elements.get(eid)
        if el is None:
            return None  # changed entity missing post-apply: unknown state
        touched.add(("el", eid))
        parent = model.container_of(eid)
        if parent is not None:
            touched.add(("children", parent))
        scan_keys(el.type_name)

    for eid in res.deleted_element_ids:
        touched.add(("el", eid))
        type_name = deleted_el_types.get(eid)
        if type_name is None:
            return None  # unreachable by construction; stay conservative
        scan_keys(type_name)

    for rid in res.changed_relationship_ids:
        rel = model.relationships.get(rid)
        if rel is None:
            return None
        rel_keys(rel.type_name, rel.source_id, rel.target_id)

    for rid in res.deleted_relationship_ids:
        meta = deleted_rels.get(rid)
        if meta is None:
            return None
        rel_keys(*meta)

    return frozenset(touched)
```

Note: `CreateElementOp`/`CreateRelationshipOp` import from `data_rover.api.schemas` — same classes `routes/ops.py` uses. If pydantic model class names differ, mirror the imports at the top of `routes/ops.py` exactly.

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_invalidation.py -v`
Expected: PASS. If `element_ancestors` turns out to include/exclude the type itself differently than assumed, the `{type_name, *...}` union already absorbs both conventions — failures here mean a real key-rule bug, not a convention mismatch.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/invalidation.py tests/api/test_invalidation.py
git commit -m "feat(api): touched_keys builder — op batch to touched read-keys"
```

---

### Task 9: Wire incremental eviction into the commit paths

`Session.evict_touched_caches(touched)` replaces clear-all on the three
op-delta paths — `/commits` (which today calls `invalidate_derived_caches`
on success) and `/model/ops` + `/model/undo` (which today rely on lazy
stamp-mismatch) — gated by `settings.snippet_incremental_invalidation`.
Rollback/no-delta paths keep clear-all untouched.

**Files:**
- Modify: `src/data_rover/api/settings.py`
- Modify: `src/data_rover/api/session.py`
- Modify: `src/data_rover/api/routes/ops.py`
- Modify: `src/data_rover/api/routes/commits.py`
- Create: `tests/api/test_incremental_invalidation.py`

**Interfaces:**
- Consumes: `touched_keys` (Task 8), `evict_touched` (Task 7).
- Produces: `Settings.snippet_incremental_invalidation: bool = True`; `Session.evict_touched_caches(touched: frozenset[ReadKey] | None) -> None` (clear-all fallback on `None`).

- [ ] **Step 1: Write failing route-level tests**

Create `tests/api/test_incremental_invalidation.py`:

```python
"""Route-level tests: a commit evicts exactly the cells whose read-sets it
touches; the legacy flag and the no-delta paths still clear everything."""

from __future__ import annotations

from fastapi.testclient import TestClient

from data_rover.api.session import get_session
from data_rover.core.script.runner import CallResult

from .conftest import AUTH_HEADERS, papi

THING_MM = """
elements:
  - name: Thing
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""


def _seed(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel"),
        content=THING_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = client.post(
        papi("/model"),
        json={
            "elements": [
                {"id": "t1", "type_name": "Thing", "properties": {"name": "One"}},
                {"id": "t2", "type_name": "Thing", "properties": {"name": "Two"}},
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text


def _res(v: str) -> CallResult:
    return CallResult(value={"kind": "scalar", "value": v}, error=None, duration_ms=1)


KEY_T1 = ("a" * 64, "value", ("t1",))
KEY_T2 = ("a" * 64, "value", ("t2",))


def _prime_cells(session) -> int:
    rev = session.model_rev
    session.script_cell_cache.clear_and_stamp(rev)
    session.script_cell_cache.put(KEY_T1, _res("One"), rev, reads=frozenset({("el", "t1")}))
    session.script_cell_cache.put(KEY_T2, _res("Two"), rev, reads=frozenset({("el", "t2")}))
    return rev


def _update_t1(client: TestClient, rev: int) -> int:
    r = client.post(
        papi("/model/ops"),
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": "t1",
                    "properties_patch": {"name": "One!"},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["model_rev"]


def test_ops_commit_evicts_only_touched_cells(client: TestClient) -> None:
    _seed(client)
    session = get_session()
    rev = _prime_cells(session)
    new_rev = _update_t1(client, rev)
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None
    hit = session.script_cell_cache.get(KEY_T2, new_rev)
    assert hit is not None and hit.value == {"kind": "scalar", "value": "Two"}


def test_undo_also_evicts_selectively(client: TestClient) -> None:
    _seed(client)
    session = get_session()
    rev = _update_t1(client, session.model_rev)  # something to undo
    _ = rev
    rev = _prime_cells(session)
    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    new_rev = r.json()["model_rev"]
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None  # undo touched t1
    assert session.script_cell_cache.get(KEY_T2, new_rev) is not None


def test_flag_off_restores_clear_all(
    client: TestClient, monkeypatch
) -> None:
    monkeypatch.setenv("DATA_ROVER_SNIPPET_INCREMENTAL_INVALIDATION", "false")
    _seed(client)
    session = get_session()
    rev = _prime_cells(session)
    new_rev = _update_t1(client, rev)
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None
    assert session.script_cell_cache.get(KEY_T2, new_rev) is None


def test_legacy_touch_model_still_clears_all(client: TestClient) -> None:
    _seed(client)
    session = get_session()
    _prime_cells(session)
    session.touch_model()
    assert session.script_cell_cache.size == 0
```

Match this file's fixture usage to `tests/api/conftest.py`'s conventions: the `client` fixture (which seeds the default project and installs `AUTH_HEADERS`) and `papi` (project-scoped path helper). If the conftest's client does NOT auto-seed, call `seed_default_project()` first exactly as neighboring route tests do — copy the pattern from an existing test that POSTs to `papi("/model/ops")`.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_incremental_invalidation.py -v`
Expected: `test_ops_commit_evicts_only_touched_cells` and `test_undo_also_evicts_selectively` FAIL (KEY_T2 misses at the new rev — nothing re-stamps survivors today). The flag-off and touch_model tests may already pass; that is fine.

- [ ] **Step 3: Add the setting and the session method**

In `src/data_rover/api/settings.py`, after `snippet_read_memo_max`:

```python
    #: Incremental cell-cache invalidation on the op-delta commit paths
    #: (spec 2026-07-21 Phase B). True: a commit evicts only the cells whose
    #: recorded read-sets intersect its touched keys, and survivors stay
    #: warm at the new rev. False: legacy behavior (clear-all semantics via
    #: rev-stamp mismatch). Escape hatch, default on.
    snippet_incremental_invalidation: bool = True
```

In `src/data_rover/api/session.py`, add to `Session` after `invalidate_derived_caches`:

```python
    def evict_touched_caches(self, touched: frozenset[ReadKey] | None) -> None:
        """Selective sibling of ``invalidate_derived_caches`` for the
        op-delta commit paths (``/model/ops``, ``/model/undo``,
        ``/commits`` — the ONLY places an exact touched-key set exists).
        Must be called AFTER ``model_rev`` is bumped, under the write mutex.

        The order cache still clears (row membership/order can change on any
        commit) and in-flight sweeps still cancel (they compute against the
        pre-commit rev), but cells whose read-sets this commit provably did
        not touch survive re-stamped — that is the whole point (a 3k-row
        table no longer recomputes wholesale because one element changed).
        ``touched=None`` means "unknown" and degrades to clear-all.
        """
        self.table_order_cache.clear()
        if touched is None:
            self.script_cell_cache.clear_and_stamp(self.model_rev)
        else:
            self.script_cell_cache.evict_touched(touched, self.model_rev)
        self.script_sweeps.cancel_all()
```

Add `ReadKey` to session.py's imports: `from data_rover.core.script.runner import ReadKey` (place with the other core imports).

- [ ] **Step 4: Wire the three routes**

In `src/data_rover/api/routes/ops.py`:

Add imports (top of file, with the other relative imports):

```python
from ..invalidation import touched_keys
from ..settings import get_settings
```

(If `get_settings` is already imported, keep the existing import.)

In `apply_ops`, immediately after `session.model_rev += 1` (currently line ~571), insert:

```python
        if get_settings().snippet_incremental_invalidation:
            session.evict_touched_caches(touched_keys(model, model.metamodel, res))
```

In `undo`, immediately after its `session.model_rev += 1` (currently line ~624), insert the same two lines (its `res` is the applied inverse batch — exactly the mutations the undo performed).

No change to either route's persist-failure rollback blocks: they already call `invalidate_derived_caches()` after moving the rev back, which clears whatever the eviction left and re-stamps downward — the documented only-writer-that-moves-a-stamp-DOWN.

In `src/data_rover/api/routes/commits.py`, replace the success-path line (currently ~292):

```python
        session.model_rev += 1
        session.invalidate_derived_caches()  # mirrors touch_model
```

with:

```python
        session.model_rev += 1
        if get_settings().snippet_incremental_invalidation:
            # Selective eviction: cells this commit provably did not touch
            # stay warm at the new rev (spec 2026-07-21 Phase B).
            session.evict_touched_caches(touched_keys(model, model.metamodel, res))
        else:
            session.invalidate_derived_caches()  # legacy clear-all
```

Add the same two imports to commits.py (check whether `get_settings` is already imported there first). Leave every other `invalidate_derived_caches()` call in commits.py (structural-reject rollback, strict-mode rollback, persist-failure rollback, preview) untouched — those are rolled-back or rev-reverted states where clear-all is the correct semantics.

- [ ] **Step 5: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_incremental_invalidation.py tests/api -q`
Expected: ALL pass — the new file and the full API suite (the commit-route and sweep suites must be indifferent: eviction only ever KEEPS more than clear-all kept).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/settings.py src/data_rover/api/session.py src/data_rover/api/routes/ops.py src/data_rover/api/routes/commits.py tests/api/test_incremental_invalidation.py
git commit -m "feat(api): incremental cell-cache invalidation on the op-delta commit paths"
```

---

### Task 10: Soundness property test, docs, full-suite gate

A randomized (fixed-seed, deterministic) end-to-end check: after any op
batch + selective eviction, every SURVIVING cached cell equals a fresh
recompute against the post-commit model. Then document both phases and run
everything.

**Files:**
- Modify: `tests/api/test_incremental_invalidation.py`
- Modify: `src/data_rover/core/script/README.md`
- Modify: `CLAUDE.md` (one sentence)

- [ ] **Step 1: Write the property test**

Append to `tests/api/test_incremental_invalidation.py`:

```python
import random

from data_rover.api.invalidation import touched_keys
from data_rover.api.routes.ops import _apply_batch
from data_rover.api.schemas import OPS_ADAPTER
from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.script.cell_cache import ScriptCellCache
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import RunLimits, ScriptBudget

from tests.script.trusted_runner import TrustedRunner

SNIPPET_NAME = "def value(els):\n    return els[0].get('name', '?')\n"
SNIPPET_HOPS = (
    "def value(els):\n"
    "    return ','.join(sorted(r['target_id'] for r in els[0].out()))\n"
)
SNIPPET_SCAN = (
    "def value(els):\n"
    "    return sum(1 for _ in dr.elements(type='Thing'))\n"
)
SNIPPETS = [SNIPPET_NAME, SNIPPET_HOPS, SNIPPET_SCAN]


def _prop_mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Thing",
                properties=[PropertyDef(name="name", datatype="string")],
            )
        ],
        relationships=[
            RelationshipType(name="Link", source="Thing", target="Thing")
        ],
    )


def _random_batch(rng: random.Random, model: Model) -> list[dict]:
    ids = sorted(model.elements)
    kind = rng.choice(["update", "create", "delete", "connect", "disconnect"])
    if kind == "update" and ids:
        return [
            {
                "kind": "update_element",
                "id": rng.choice(ids),
                "properties_patch": {"name": f"n{rng.randrange(1000)}"},
            }
        ]
    if kind == "create":
        return [
            {
                "kind": "create_element",
                "temp_id": f"tmp_{rng.randrange(10**6)}",
                "type_name": "Thing",
                "properties": {"name": "new"},
            }
        ]
    if kind == "delete" and len(ids) > 2:
        return [{"kind": "delete_element", "id": rng.choice(ids)}]
    if kind == "connect" and len(ids) >= 2:
        s, t = rng.sample(ids, 2)
        return [
            {
                "kind": "create_relationship",
                "temp_id": f"tmp_{rng.randrange(10**6)}",
                "type_name": "Link",
                "source_id": s,
                "target_id": t,
                "properties": {},
            }
        ]
    rel_ids = sorted(model.relationships)
    if kind == "disconnect" and rel_ids:
        return [{"kind": "delete_relationship", "id": rng.choice(rel_ids)}]
    return [
        {
            "kind": "create_element",
            "temp_id": f"tmp_{rng.randrange(10**6)}",
            "type_name": "Thing",
            "properties": {"name": "fallback"},
        }
    ]


def _fill_cache(model: Model, cache: ScriptCellCache, rev: int) -> dict[str, str]:
    """Compute every (snippet x element) cell through the eval context (so
    read-sets flow into the cache) and return sha->code for verification."""
    ctx = ScriptEvalContext(
        TrustedRunner(),
        model,
        RunLimits(),
        ScriptBudget.start(300),
        cell_cache=cache,
        rev=rev,
    )
    try:
        import hashlib

        sha_to_code: dict[str, str] = {}
        for code in SNIPPETS:
            sha_to_code[hashlib.sha256(code.encode()).hexdigest()] = code
            for eid in sorted(model.elements):
                res = ctx.call(code, "value", [eid])
                assert res.error is None, (code, eid, res.error)
    finally:
        ctx.close()
    return sha_to_code


def test_surviving_cells_equal_fresh_recompute() -> None:
    rng = random.Random(20260721)
    model = Model(_prop_mm())
    for i in range(6):
        e = model.restore_element(f"e{i}", "Thing")
        model.set_property(e, "name", f"N{i}")
    model.connect("Link", "e0", "e1")
    model.connect("Link", "e1", "e2")

    cache = ScriptCellCache(cap=1000)
    rev = 1
    cache.clear_and_stamp(rev)
    sha_to_code = _fill_cache(model, cache, rev)

    for _round in range(25):
        batch = _random_batch(rng, model)
        res = _apply_batch(model, OPS_ADAPTER.validate_python(batch), restore=False)
        rev += 1
        touched = touched_keys(model, model.metamodel, res)
        if touched is None:
            cache.clear_and_stamp(rev)
        else:
            cache.evict_touched(touched, rev)

        # Every surviving cell must equal a fresh, cache-less recompute.
        verify = ScriptEvalContext(
            TrustedRunner(), model, RunLimits(), ScriptBudget.start(300)
        )
        try:
            for (sha, entry, ids), (cached, _reads) in list(cache._d.items()):
                fresh = verify.call(sha_to_code[sha], entry, list(ids))
                assert fresh.error is None, fresh.error
                assert fresh.value == cached.value, (
                    f"round {_round}: stale survivor {sha[:8]}/{ids} "
                    f"cached={cached.value} fresh={fresh.value} batch={batch}"
                )
        finally:
            verify.close()

        sha_to_code = _fill_cache(model, cache, rev)  # refill for next round
```

(Reaching into `cache._d` is deliberate and precedented — the perf suite
reaches into `runner._pool` for the same enumerate-internals reason.)

- [ ] **Step 2: Run it**

Run: `pixi run -e core-dev pytest tests/api/test_incremental_invalidation.py -v`
Expected: PASS. If a round fails, the assertion message names the batch and cell — that is a real soundness bug in `touched_keys` or the facade's read recording; fix THERE, never by weakening the test.

- [ ] **Step 3: Document**

In `src/data_rover/core/script/README.md`, in the "Evaluation sessions (M2/M3)" section, add two short subsections (match the file's existing tone):

```markdown
### Trip collapse (Phase A', spec 2026-07-21)

Embedded sessions minimize guest<->host round trips three ways, all invisible
to snippet authors: (1) the facade memoizes bridge reads for the session's
lifetime (`snippet_read_memo_max` entries; sound because a session never
outlives one model rev's worth of work — the same invariant the cell cache
rests on); (2) `outgoing`/`incoming` responses inline the far endpoints'
projections under an additive `elements` key, priming that memo; (3) each
embedded call ships its root elements' projections in the call frame, so a
property-math cell makes zero bridge reads. Do not mutate structures returned
by `dr` reads — the memo hands out shallow copies of containers, but nested
property values are shared (the same sharing the trusted runner always had).

### Incremental invalidation (Phase B, spec 2026-07-21)

Each embedded call records the read-keys it USED — memo hits and piggybacked
roots included — and ships them on `call_result` (`CallResult.reads`; `None`
means "depends on everything" and is always evicted). On the op-delta commit
paths (`/model/ops`, `/model/undo`, `/commits`), `api/invalidation.touched_keys`
translates the applied batch into the same vocabulary and
`ScriptCellCache.evict_touched` drops only intersecting cells, re-stamping
survivors to the new rev — one edit no longer recomputes a 3k-row table.
Paths with no op delta (`touch_model`, uploads, hydration, metamodel swap,
every rollback) keep clear-all. Escape hatch:
`DATA_ROVER_SNIPPET_INCREMENTAL_INVALIDATION=false`.
```

In `CLAUDE.md`, in the embedded-evaluation bullet, after the sentence about
`ScriptCellCache`, add one sentence:

```
Cells carry per-call read-sets and commits evict selectively via
`api/invalidation.touched_keys` + `ScriptCellCache.evict_touched` (clear-all
survives only on the no-op-delta paths); the guest facade memoizes reads for
the session lifetime and hop/call frames inline element projections
(trip collapse) — see `core/script/README.md`.
```

- [ ] **Step 4: Full gate**

Run: `pixi run core-test`
Expected: PASS.
Run: `pixi run dr-tidy`
Expected: clean (ruff + mypy + pyright).
If the wasm guest binary is fetched, also run:
`pixi run -e core-dev pytest -m "integration or perf" tests/api -v`
Expected: PASS (real-sandbox parity + perf guards).

- [ ] **Step 5: Commit**

```bash
git add tests/api/test_incremental_invalidation.py src/data_rover/core/script/README.md CLAUDE.md
git commit -m "test(script): read-set soundness property test; document trip collapse + incremental invalidation"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** Phase A′ items 1–3 → Tasks 2–4; instrumentation-first → Tasks 1 & 5; Phase B capture → Task 6, cache → Task 7, builder → Task 8, wiring/boundaries → Task 9, property test + docs → Task 10. Non-goals (`call_many`, worker scale-up, whole-column mode) correctly have no tasks.
- **Deliberate deviations from the spec's letter:** read keys use short tags (`"el"` not `"element"`) — cosmetic; the spec's `~2000` overflow cap is the facade's `_READS_CAP` and host `_MAX_READS` (kept equal); error results ship `reads=None` (spec silent; conservative); the spec's instrumentation task asked for a 3k-row fixture with a host-dispatch/guest-exec timing split — that split existed to size `call_many` chunks, which was deferred to non-goals, so the plan delivers the round-trip counting (hermetic, Task 1) and a trips-per-cell perf guard over the existing `SWEEP_ROWS` fixture (Task 5) instead.
- **Type consistency:** `ReadKey = tuple[str, str | None]` everywhere; `CallResult.reads: frozenset[ReadKey] | None`; `put(key, result, rev, reads=None)`; `evict_touched(touched, rev)`; `touched_keys(model, metamodel, res) -> frozenset[ReadKey] | None`; `evict_touched_caches(touched)`.
- **Known verify-on-contact points** (implementer: check, don't assume): exact fixture names in `tests/api/test_snippets_wasm.py`; whether `get_settings` is already imported in the two route files; exact op adapter name in `schemas.py` (`OPS_ADAPTER` per CLAUDE.md); `tests/api` conftest's client/seed pattern for the new route tests.
