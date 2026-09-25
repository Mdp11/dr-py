# Per-Pass Navigation Memo for Table Evaluation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop re-running the same navigation once per split row when a table sorts, filters or renders a column that re-navigates from a shared root, without letting any cached result outlive the single evaluation pass that produced it.

**Architecture:** A small, bounded, per-pass `NavMemo` (new module `core/table/nav_memo.py`) caches a navigation's `(chains, truncated)` keyed by `(column identity, roots)`. It is created *inside* each public pass — `build_rows_ex`, `order_rows`, `evaluate_cells` — and threaded explicitly (`memo=`) through the internal helpers exactly the way `script: ScriptEvalContext | None` already is; every `evaluate()` call in `core/table/evaluate.py` goes through one new chokepoint, `_evaluate_navigation`, which bypasses the memo for any navigation containing a `ScriptStep`. No public entry point accepts a memo, so a result can never cross the cache-only build/sort phase into the live window phase, and nothing is ever stored on the session.

**Tech Stack:** Python 3.14, pydantic v2 models (`core/table/schema.py`), pytest via `pixi run -e core-dev pytest`, ruff/mypy/pyright via `pixi run core-lint`.

**Spec:** No standalone spec — the design was settled in conversation and is restated in full under "Design" below. Read that section before any task.

## Global Constraints

- All three of `ruff`, `mypy`, `pyright` must pass: `pixi run core-lint`.
- Comments/docstrings: concise, present tense, only for invariants and non-obvious contracts. No "phase"/"plan" references, no history narration.
- Tests live in `tests/table/`, import as `from data_rover.core...` (`pythonpath=src` is set in `pytest.ini`).
- The memo is NEVER a parameter of `build_rows`, `build_rows_ex`, `order_rows`, `evaluate_cells`, or `iter_export_rows`. Each creates its own.
- The memo is NEVER attached to `Session`, `ScriptEvalContext`, `TableLimits`, or any module global.
- A navigation for which `navigation_has_script(defn)` is `True` is NEVER memoized.
- Stored chains are an immutable `tuple` of chain tuples; callers only iterate.
- Bounded: `NavMemo.max_entries` default `64`, LRU eviction.
- Commit after every task with the trailer lines used in this repo (see Task 1 step 6).

---

## Design

### The redundancy being removed

`build_rows_ex` (`src/data_rover/core/table/evaluate.py:404`) emits split rows for an `expand` navigation column **contiguously per base row** — for base key `(E,)` reaching `A1, A2, …, An` the keys `(E, A1), (E, A2), … (E, An)` are adjacent in build order. Every later per-row consumer that re-navigates from the row's *source* — `resolve_source_elements`'s `step_index` branch (`evaluate.py:213`), `_collapse_has_value`, `_sort_value` for a collapse navigation/property column, `_navigation_cell` for a collapse column — calls `evaluate()` on the same navigation from the same roots `n` times for those `n` rows and gets byte-identical chains each time. Measured cost on 10 000 rows: sort-by-step-ref column 474 ms at fan-out 5, 3.6 s at fan-out 50; the memo makes that O(roots) instead of O(rows).

### Why a per-pass object, threaded explicitly

1. **Cross-phase staleness.** `POST /tables/evaluate` runs `build_rows_ex` + `order_rows` with `script_ctx.cache_only=True` (a `ScriptStep` cache miss prunes its chain and counts a `pending_miss`), then `evaluate_cells` for the window with `cache_only=False`. A chain result memoized under cache-only and reused live would render a pruned chain and under-count `pending_misses`. Guard: (a) each public pass creates and discards its own memo; (b) script-bearing navigations bypass the memo entirely (`NavMemo.scripted`).
2. **Memory.** Key hits only happen for consecutive rows sharing roots; a table of 50 000 distinct roots would get zero hits. Guard: LRU cap `max_entries=64` (build/sort passes need 1 live entry because split rows are contiguous; the window pass is ≤ `MAX_LIMIT=500` rows in sorted order, where a small LRU still catches the repeats).
3. **Aliasing.** `_navigation_reached_ex` / `_navigation_step_elements` only iterate chains. Guard: the memo stores `tuple(result.chains)` and a `bool`, never the `ChainResult`; consumers derive fresh lists.
4. **Column identity.** Key uses `id(col)`. Valid because the memo lives inside one pass whose `defn` (and therefore every `col` in `defn.columns`) is alive for the whole pass — `id()` cannot be recycled while the object exists.
5. **Concurrent commits.** The table routes hold no `write_mutex` (benign-race stance). A memo does not widen that window; it makes rows sharing a root mutually consistent. Not a new hazard.

### Threading map (who gets `memo`)

`evaluate.py`: `_evaluate_navigation` (new chokepoint) ← `_navigation_reached_ex`, `_navigation_step_elements`; `_navigation_reached` ← `_navigation_reached_ex`; `resolve_source_elements` (recursive, passes through) ← `_navigation_step_elements`/`_navigation_reached`; `_collapse_has_value`, `_expand_values`, `_sort_value` ← the three above. Creators: `build_rows_ex`, `order_rows`.

`cells.py`: `_element_cell`, `_property_cell`, `_navigation_cell`, `_script_cell` pass `memo` into `resolve_source_elements` / `_navigation_reached`. Creator: `evaluate_cells`.

Untouched: `api/script_sweep.py:453` calls `resolve_source_elements` with no memo (default `None`) — unchanged behavior, out of scope.

---

### Task 1: `NavMemo` module

**Files:**
- Create: `src/data_rover/core/table/nav_memo.py`
- Test: `tests/table/test_nav_memo.py`

**Interfaces:**
- Produces:
  - `MemoKey = tuple[int, tuple[str, ...]]`
  - `@dataclass(frozen=True) class MemoEntry: chains: tuple[tuple[ChainNode, ...], ...]; truncated: bool`
  - `class NavMemo: __init__(self, max_entries: int = 64)`, `get(self, key: MemoKey) -> MemoEntry | None`, `put(self, key: MemoKey, entry: MemoEntry) -> None`, `scripted(self, col: NavigationColumn) -> bool`, `__len__(self) -> int`

- [ ] **Step 1: Write the failing tests**

```python
# tests/table/test_nav_memo.py
"""`NavMemo` is a per-pass, bounded LRU of navigation results. These tests pin
the contract the evaluator leans on: hit/miss by key, LRU eviction at
`max_entries`, immutable stored chains, and the script-bearing bypass."""

from data_rover.core.navigation.evaluate import PropertyValue
from data_rover.core.table.nav_memo import MemoEntry, NavMemo
from data_rover.core.table.schema import TABLE_ADAPTER, NavigationColumn


def _entry(*ids: str) -> MemoEntry:
    return MemoEntry(chains=tuple((i,) for i in ids), truncated=False)


def test_get_miss_then_hit():
    memo = NavMemo()
    key = (1, ("root",))
    assert memo.get(key) is None
    memo.put(key, _entry("a", "b"))
    hit = memo.get(key)
    assert hit is not None
    assert hit.chains == (("a",), ("b",))
    assert hit.truncated is False
    assert len(memo) == 1


def test_lru_evicts_least_recently_used_at_cap():
    memo = NavMemo(max_entries=2)
    memo.put((1, ("a",)), _entry("x"))
    memo.put((1, ("b",)), _entry("y"))
    assert memo.get((1, ("a",))) is not None  # touch a -> b is now LRU
    memo.put((1, ("c",)), _entry("z"))  # over cap: evicts b
    assert len(memo) == 2
    assert memo.get((1, ("b",))) is None
    assert memo.get((1, ("a",))) is not None
    assert memo.get((1, ("c",))) is not None


def test_entry_is_frozen_and_chains_are_tuples():
    import dataclasses

    import pytest

    e = MemoEntry(chains=(("a", PropertyValue("v")),), truncated=True)
    assert isinstance(e.chains, tuple)
    assert all(isinstance(c, tuple) for c in e.chains)
    with pytest.raises(dataclasses.FrozenInstanceError):
        e.truncated = False  # type: ignore[misc]


def _nav_column(steps: list[dict]) -> NavigationColumn:
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{
            "kind": "navigation", "source": {"kind": "row"},
            "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                "steps": steps}},
        }],
    })
    col = defn.columns[0]
    assert isinstance(col, NavigationColumn)
    return col


def test_scripted_true_for_script_step_false_otherwise():
    memo = NavMemo()
    plain = _nav_column([
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
    ])
    scripted = _nav_column([
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
        {"kind": "script", "snippet": {"definition": {
            "code": "def step(el):\n    return el\n"}}},
    ])
    unconfigured = _nav_column([
        {"kind": "script", "snippet": {}},
    ])
    assert memo.scripted(plain) is False
    assert memo.scripted(scripted) is True
    # An EMPTY snippet never invokes a guest, so it is safe to memoize.
    assert memo.scripted(unconfigured) is False
    # Answer is memoized per column identity: same object, same answer.
    assert memo.scripted(scripted) is True
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_nav_memo.py -v`
Expected: FAIL at collection with `ModuleNotFoundError: No module named 'data_rover.core.table.nav_memo'`

- [ ] **Step 3: Write the module**

```python
# src/data_rover/core/table/nav_memo.py
"""Per-PASS memo of navigation results for the table evaluator.

`build_rows_ex` emits an expand column's split rows contiguously per base
row, so every later per-row consumer that re-navigates from the row's source
(`resolve_source_elements`'s step-index branch, `_sort_value`, the collapse
navigation cell) evaluates the SAME navigation from the SAME roots once per
split row. `NavMemo` collapses that to once per distinct `(column, roots)`.

Scope is the whole guarantee: each public pass (`build_rows_ex`,
`order_rows`, `evaluate_cells`) constructs its own memo and discards it on
return — never a parameter of a public entry point, never stored on a
session or a `ScriptEvalContext`. That is what keeps a result computed under
`ScriptEvalContext.cache_only` (build/sort) from ever being served to the
live window pass. Belt and braces, a navigation containing a `ScriptStep`
bypasses the memo altogether (`scripted`): its `evaluate()` calls carry
per-call side effects (`pending_misses`, warning deltas) a cache would skip.

Bounded LRU: split rows are contiguous, so a build/sort pass needs one live
entry; a sorted window of at most a few hundred rows still repeats roots.
Entries hold an immutable tuple of chain tuples, never the `ChainResult`.

Keys use `id(col)`: the memo lives inside one pass whose `TableDefinition`
stays alive throughout, so a column's id cannot be recycled mid-pass."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass

from data_rover.core.navigation.evaluate import ChainNode
from data_rover.core.navigation.resolve import navigation_has_script

from .schema import NavigationColumn

MemoKey = tuple[int, tuple[str, ...]]

DEFAULT_MAX_ENTRIES = 64


@dataclass(frozen=True)
class MemoEntry:
    chains: tuple[tuple[ChainNode, ...], ...]
    truncated: bool


class NavMemo:
    def __init__(self, max_entries: int = DEFAULT_MAX_ENTRIES) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be >= 1")
        self.max_entries = max_entries
        self._entries: OrderedDict[MemoKey, MemoEntry] = OrderedDict()
        self._scripted: dict[int, bool] = {}

    def get(self, key: MemoKey) -> MemoEntry | None:
        hit = self._entries.get(key)
        if hit is not None:
            self._entries.move_to_end(key)
        return hit

    def put(self, key: MemoKey, entry: MemoEntry) -> None:
        self._entries[key] = entry
        self._entries.move_to_end(key)
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)

    def scripted(self, col: NavigationColumn) -> bool:
        """True when `col`'s navigation may invoke a snippet — such a
        navigation is never memoized. Answered once per column object."""
        cached = self._scripted.get(id(col))
        if cached is not None:
            return cached
        defn = col.navigation.definition
        answer = defn is not None and navigation_has_script(defn)
        self._scripted[id(col)] = answer
        return answer

    def __len__(self) -> int:
        return len(self._entries)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/table/test_nav_memo.py -v`
Expected: 4 passed

- [ ] **Step 5: Lint**

Run: `pixi run core-lint`
Expected: ruff, mypy, pyright all report no issues.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/table/nav_memo.py tests/table/test_nav_memo.py
git commit -F - <<'EOF'
feat(table): bounded per-pass NavMemo for navigation results

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01797dVGF2VhEz5Ty6NhPUah
EOF
```

---

### Task 2: Thread the memo through `evaluate.py` (build + sort passes)

**Files:**
- Modify: `src/data_rover/core/table/evaluate.py` — `resolve_source_elements` (~163), `_navigation_reached_ex` (~275), `_navigation_reached` (~317), `_navigation_step_elements` (~328), `build_rows_ex` (~404), `_collapse_has_value` (~489), `_expand_values` (~543), `_sort_value` (~817), `order_rows` (~934)
- Test: `tests/table/test_nav_memo.py` (append)

**Interfaces:**
- Consumes: `NavMemo`, `MemoEntry`, `MemoKey` from Task 1.
- Produces: every function above gains a trailing keyword-only-by-convention parameter `memo: NavMemo | None = None` (positioned after `script`). New private helper:
  `_evaluate_navigation(mm: Metamodel, model: Model, col: NavigationColumn, roots: list[str], limits: TableLimits, script: ScriptEvalContext | None, memo: NavMemo | None) -> tuple[Sequence[tuple[ChainNode, ...]], bool]`

- [ ] **Step 1: Write the failing tests (append to `tests/table/test_nav_memo.py`)**

```python
# --- pass-level behavior: the evaluator calls `evaluate()` once per root ---
import data_rover.core.table.evaluate as ev
from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef, RelationshipType
from data_rover.core.model.model import Model
from data_rover.core.table.evaluate import SortSpec, build_rows_ex, order_rows

N_ROOTS, FAN = 3, 4


def _mm() -> Metamodel:
    return Metamodel(
        elements=[ElementType(name="Block", properties=[
            PropertyDef(name="name", datatype="string"),
            PropertyDef(name="mass", datatype="integer", multiplicity="0..1"),
        ])],
        relationships=[RelationshipType(name="BlockHasPart", source="Block", target="Block")],
    )


def _split_model(mm: Metamodel) -> tuple[Model, list[str], dict[str, str]]:
    """N_ROOTS roots, each owning FAN parts, each part owning one leaf.
    Part names are chosen so that sorting by part name INTERLEAVES roots.
    Returns `(model, root ids, leaf id -> its part id)`."""
    model = Model(mm)
    roots: list[str] = []
    parent_of: dict[str, str] = {}
    for r in range(N_ROOTS):
        root = model.create_element("Block")
        model.set_property(root, "name", f"Root{r}")
        roots.append(root.id)
        for p in range(FAN):
            part = model.create_element("Block")
            model.set_property(part, "name", f"P{p}-{r}")
            model.set_property(part, "mass", p * 10 + r)
            leaf = model.create_element("Block")
            model.set_property(leaf, "name", f"L{p}-{r}")
            model.connect("BlockHasPart", root.id, part.id)
            model.connect("BlockHasPart", part.id, leaf.id)
            parent_of[leaf.id] = part.id
    return model, roots, parent_of


def _step_ref_table(second_step: dict | None = None):
    steps = [
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
        second_step or {"kind": "relationship", "relationship_type": "BlockHasPart",
                        "direction": "out"},
    ]
    return TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "keep_empty": False,
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": steps}}},
            {"kind": "property", "source": {"kind": "column", "index": 0, "step_index": 1},
             "name": "name"},
        ],
    })


def _count_evaluate(monkeypatch) -> list[int]:
    calls: list[int] = []
    real = ev.evaluate

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(ev, "evaluate", counting)
    return calls


def test_sort_by_step_ref_navigates_once_per_root(monkeypatch):
    mm = _mm()
    model, _, parent_of = _split_model(mm)
    defn = _step_ref_table()
    calls = _count_evaluate(monkeypatch)
    built = build_rows_ex(mm, model, defn)
    # Rows: every Block is in scope; only the N_ROOTS roots reach 2 hops
    # (keep_empty=False drops the rest). One evaluate per scope element.
    assert len(built.keys) == N_ROOTS * FAN
    calls.clear()
    ordered = order_rows(mm, model, defn, built.keys, SortSpec(column=1, direction="asc"))
    assert len(calls) == N_ROOTS  # was N_ROOTS * FAN before the memo
    # Correctness: rows come out sorted by the step-1 part name, interleaving roots.
    names = []
    for key in ordered:
        leaf = key[1]
        assert isinstance(leaf, str)
        names.append(model.elements[parent_of[leaf]].properties["name"])
    assert names == sorted(names)
    assert names[:N_ROOTS] == [f"P0-{r}" for r in range(N_ROOTS)]


def test_sort_by_step_ref_over_value_terminal_navigates_once_per_root(monkeypatch):
    mm = _mm()
    model, _, _ = _split_model(mm)
    defn = _step_ref_table({"kind": "property", "property_name": "mass"})
    built = build_rows_ex(mm, model, defn)
    calls = _count_evaluate(monkeypatch)
    order_rows(mm, model, defn, built.keys, SortSpec(column=1, direction="desc"))
    assert len(calls) == N_ROOTS


def test_script_navigation_bypasses_memo(monkeypatch):
    # A ScriptStep navigation is NEVER memoized: with `script=None` the step
    # prunes silently, but the bypass must still route every row through
    # `evaluate()` so per-call side effects are never skipped.
    mm = _mm()
    model, _, _ = _split_model(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "collapse",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [
                     {"kind": "relationship", "relationship_type": "BlockHasPart",
                      "direction": "out"},
                     {"kind": "script", "snippet": {"definition": {
                         "code": "def step(el):\n    return el\n"}}},
                 ]}}},
        ],
    })
    built = build_rows_ex(mm, model, defn)
    calls = _count_evaluate(monkeypatch)
    order_rows(mm, model, defn, built.keys, SortSpec(column=0, direction="asc"))
    assert len(calls) == len(built.keys)


def test_public_passes_take_no_memo_parameter():
    # The memo is created INSIDE each pass; letting a caller hand one in is
    # exactly how a cache-only result could reach the live window pass.
    import inspect

    from data_rover.core.table.cells import evaluate_cells
    from data_rover.core.table.evaluate import build_rows, iter_export_rows

    for fn in (build_rows, build_rows_ex, order_rows, evaluate_cells, iter_export_rows):
        assert "memo" not in inspect.signature(fn).parameters, fn.__name__
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_nav_memo.py -v`
Expected: `test_sort_by_step_ref_navigates_once_per_root` and `..._over_value_terminal_...` FAIL with `assert 12 == 3`; `test_script_navigation_bypasses_memo` and `test_public_passes_take_no_memo_parameter` PASS already (they pin behavior that must survive).

- [ ] **Step 3: Add the chokepoint and imports**

At the top of `src/data_rover/core/table/evaluate.py`, extend the imports:

```python
from collections.abc import Iterator, Sequence  # add Sequence to the existing collections.abc import if one exists; else add this line

from data_rover.core.navigation.evaluate import (
    ChainNode,
    EvalLimits,
    PropertyValue,
    evaluate,
)
```

and add a runtime import beside the `.schema` import (needed to construct the memo; `nav_memo` imports only `.schema` and navigation modules, so there is no cycle):

```python
from .nav_memo import MemoEntry, NavMemo
```

Insert this helper immediately BEFORE `_navigation_reached_ex`:

```python
def _evaluate_navigation(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn,
    roots: list[str],
    limits: TableLimits,
    script: ScriptEvalContext | None,
    memo: NavMemo | None,
) -> tuple[Sequence[tuple[ChainNode, ...]], bool]:
    """`(chains, truncated)` of `col`'s navigation from `roots` — the ONE
    place this module calls `evaluate()` for a navigation column. With a
    `memo` in play (and only for a navigation with no `ScriptStep`, whose
    `evaluate()` carries per-call side effects a cache would skip) the
    result is served from the memo for a repeated `(col, roots)`; the memo
    holds an immutable tuple copy, so callers must only iterate."""
    defn = col.navigation.definition
    assert defn is not None  # callers gate on the unconfigured case
    if memo is None or memo.scripted(col):
        result = evaluate(
            mm, model, defn, limits.nav_limits, row_elements=roots, script=script
        )
        return result.chains, result.truncated
    key = (id(col), tuple(roots))
    hit = memo.get(key)
    if hit is not None:
        return hit.chains, hit.truncated
    result = evaluate(
        mm, model, defn, limits.nav_limits, row_elements=roots, script=script
    )
    entry = MemoEntry(chains=tuple(result.chains), truncated=result.truncated)
    memo.put(key, entry)
    return entry.chains, entry.truncated
```

- [ ] **Step 4: Route the two evaluators through it**

In `_navigation_reached_ex`, add the parameter and replace the `evaluate(...)` call:

```python
def _navigation_reached_ex(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn,
    roots: list[str],
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
    memo: NavMemo | None = None,
) -> tuple[list[str | PropertyValue], bool]:
    ...
    if not roots:
        return [], False
    chains, truncated = _evaluate_navigation(mm, model, col, roots, limits, script, memo)
    idx = col.step_index if col.step_index is not None else -1
    ...
    for chain in chains:            # was: for chain in result.chains
        ...
    return reached, truncated       # was: result.truncated
```

In `_navigation_reached`:

```python
def _navigation_reached(
    mm: Metamodel,
    model: Model,
    col: NavigationColumn,
    roots: list[str],
    limits: TableLimits,
    script: ScriptEvalContext | None = None,
    memo: NavMemo | None = None,
) -> list[str | PropertyValue]:
    return _navigation_reached_ex(
        mm, model, col, roots, limits, script=script, memo=memo
    )[0]
```

In `_navigation_step_elements`, add `memo: NavMemo | None = None` after `script` in the signature and replace:

```python
    if defn is None or not roots:
        return []
    chains, _ = _evaluate_navigation(mm, model, col, roots, limits, script, memo)
    proj = col.step_index if col.step_index is not None else -1
    seen: dict[str, None] = {}
    for chain in chains:            # was: for chain in result.chains
```

- [ ] **Step 5: Thread `memo` through `resolve_source_elements` and the per-row helpers**

`resolve_source_elements`: add `memo: NavMemo | None = None` after `script` in the signature and append `, memo=memo` to EVERY call inside its body — the three recursive `resolve_source_elements(...)` calls, the `_navigation_step_elements(...)` call (add `memo=memo,` after `script=script,`), and the `_navigation_reached(...)` call. Add one sentence to its docstring after the `script` paragraph:

```
    `memo` is the current pass's `NavMemo` (see `nav_memo.py`) — `None` for
    callers outside a pass; threaded, like `script`, into every navigation
    evaluation this function reaches.
```

`_collapse_has_value` and `_expand_values`: add `memo: NavMemo | None = None` after `script`; in each, the `_navigation_reached_ex(...)` call gets `memo=memo` after `script=script`.

`_sort_value`: add `memo: NavMemo | None = None` after `script`; append `memo=memo` to its `resolve_source_elements(...)` calls (three of them: property, script and navigation branches) and to the `_navigation_reached(...)` call.

Verify with: `grep -n "script=script)" src/data_rover/core/table/evaluate.py` — every remaining hit must be a call whose enclosing function has no `memo` (only `_sort_script`/`sort_falls_back_to_build_order`-area code, if any). Every call inside a function that HAS `memo` must pass it.

- [ ] **Step 6: Create the memo inside the two passes**

`build_rows_ex`: right after `base_slots = _row_source_base_slots(defn, keys)` add

```python
    memo = NavMemo()
```

and pass `memo=memo` to every `resolve_source_elements(...)`, `_collapse_has_value(...)` and `_expand_values(...)` call in the function body. Append to the docstring:

```
    A fresh `NavMemo` is created here and dies with the call: nothing this
    pass evaluates under `script.cache_only` can be served to a later pass.
```

`order_rows`: right after `script = _sort_script(defn, col, script)` add

```python
    memo = NavMemo()
```

and pass `memo=memo` into the `_sort_value(...)` call. Append the same docstring sentence.

- [ ] **Step 7: Run the tests**

Run: `pixi run -e core-dev pytest tests/table tests/navigation -q`
Expected: all pass, including the four new tests in `test_nav_memo.py`.

- [ ] **Step 8: Lint**

Run: `pixi run core-lint`
Expected: clean. (pyright: `Sequence` must be imported from `collections.abc`; mypy: the `assert defn is not None` narrows `NavigationDefinition | None`.)

- [ ] **Step 9: Commit**

```bash
git add src/data_rover/core/table/evaluate.py tests/table/test_nav_memo.py
git commit -F - <<'EOF'
perf(table): memoize navigation per (column, roots) within build/sort passes

Split rows share a root, and every per-row re-navigation (step-index
references, collapse sorts, keep_empty filters) re-ran the same navigation
once per row. Each pass now creates a bounded NavMemo; script-bearing
navigations bypass it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01797dVGF2VhEz5Ty6NhPUah
EOF
```

---

### Task 3: Thread the memo through `cells.py` (window pass)

**Files:**
- Modify: `src/data_rover/core/table/cells.py` — `_element_cell` (~152), `_property_cell` (~168), `_navigation_cell` (~219), `_script_cell` (~275), `evaluate_cells` (~367)
- Test: `tests/table/test_nav_memo.py` (append)

**Interfaces:**
- Consumes: `NavMemo` (Task 1); the `memo=` parameters on `resolve_source_elements` / `_navigation_reached` (Task 2).
- Produces: the four `_*_cell` helpers gain `memo: NavMemo | None = None` after `script`; `evaluate_cells`'s public signature is UNCHANGED.

- [ ] **Step 1: Write the failing tests (append)**

```python
def test_cells_window_navigates_once_per_root(monkeypatch):
    from data_rover.core.table.cells import ValueCell, evaluate_cells

    mm = _mm()
    model, _, parent_of = _split_model(mm)
    defn = _step_ref_table()
    built = build_rows_ex(mm, model, defn)
    calls = _count_evaluate(monkeypatch)
    cells = evaluate_cells(mm, model, defn, built.keys)  # build order: roots contiguous
    assert len(calls) == N_ROOTS
    # Values are still row-correct: each split row reads ITS part's name.
    for key, row in zip(built.keys, cells, strict=True):
        leaf = key[1]
        assert isinstance(leaf, str)
        cell = row[1]
        assert isinstance(cell, ValueCell)
        assert cell.present
        assert cell.value == model.elements[parent_of[leaf]].properties["name"]
        assert cell.element_id == parent_of[leaf]


def test_cells_pass_never_reuses_an_earlier_pass_result():
    # Mutate the model BETWEEN `order_rows` and `evaluate_cells`: the cells
    # must reflect the new model, proving no memo survives across passes.
    from data_rover.core.table.cells import ValuesCell, evaluate_cells

    mm = _mm()
    model, roots, _ = _split_model(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "collapse",
             "keep_empty": False,
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship", "relationship_type": "BlockHasPart",
                            "direction": "out"}]}}},
            {"kind": "property", "source": {"kind": "column", "index": 0}, "name": "name"},
        ],
    })
    built = build_rows_ex(mm, model, defn)
    ordered = order_rows(mm, model, defn, built.keys, SortSpec(column=1, direction="asc"))
    extra = model.create_element("Block")
    model.set_property(extra, "name", "ZZ-new")
    model.connect("BlockHasPart", roots[0], extra.id)
    cells = evaluate_cells(mm, model, defn, ordered)
    row0 = next(i for i, k in enumerate(ordered) if k[0] == roots[0])
    cell = cells[row0][1]
    assert isinstance(cell, ValuesCell)
    assert "ZZ-new" in cell.values
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_nav_memo.py -v -k cells`
Expected: `test_cells_window_navigates_once_per_root` FAILS with `assert 12 == 3`; `test_cells_pass_never_reuses_an_earlier_pass_result` PASSES (pins the invariant).

- [ ] **Step 3: Thread `memo` in `cells.py`**

Add to the imports from `.evaluate`: nothing new (they already import `resolve_source_elements`, `_expand_slot_of`, `_navigation_reached`); add

```python
from .nav_memo import NavMemo
```

For each of `_element_cell`, `_property_cell`, `_navigation_cell`, `_script_cell`: add `memo: NavMemo | None = None` as the LAST parameter (after `script`), and append `, memo=memo` to every `resolve_source_elements(...)` and `_navigation_reached(...)` call in its body (lines ~163, ~180, ~243, ~245, ~309, ~333 — each currently ends `script=script`).

In `evaluate_cells`, after the `base_slots = ...` line add:

```python
    # One memo per window pass — never shared with the build/sort passes
    # (see `nav_memo.py`): a result computed under `script.cache_only`
    # must not be served to this live pass.
    memo = NavMemo()
```

and pass `memo` as the last positional argument of each `_element_cell(...)`, `_property_cell(...)`, `_script_cell(...)`, `_navigation_cell(...)` call in the loop (each currently ends with `script`).

- [ ] **Step 4: Run the full table + API table suites**

Run: `pixi run -e core-dev pytest tests/table tests/navigation tests/api/test_tables_routes.py tests/api/test_table_export_json.py tests/api/test_tables_script_status.py tests/api/test_table_cache.py -q`
Expected: all pass.

- [ ] **Step 5: Lint**

Run: `pixi run core-lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/table/cells.py tests/table/test_nav_memo.py
git commit -F - <<'EOF'
perf(table): memoize navigation within the cell window pass

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01797dVGF2VhEz5Ty6NhPUah
EOF
```

---

### Task 4: Benchmark verification + docs

**Files:**
- Create (scratch, not committed): `<scratchpad>/bench_memo.py`
- Modify: `CLAUDE.md` — add a NEW bullet directly BEFORE the bullet that begins `- **Export overrides (`core/table/export_layout.py`)**` (under "Code execution (snippets)")

**Interfaces:** none.

- [ ] **Step 1: Write the benchmark**

```python
# <scratchpad>/bench_memo.py — run: PYTHONPATH=src pixi run -e core-dev python bench_memo.py <n_roots> <fan>
import sys
import time

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef, RelationshipType
from data_rover.core.model.model import Model
from data_rover.core.table.cells import evaluate_cells
from data_rover.core.table.evaluate import SortSpec, TableLimits, build_rows_ex, order_rows
from data_rover.core.table.schema import TABLE_ADAPTER

N_E, FAN = int(sys.argv[1]), int(sys.argv[2])
mm = Metamodel(
    elements=[
        ElementType(name="E", properties=[PropertyDef(name="name", datatype="string")]),
        ElementType(name="A", properties=[PropertyDef(name="name", datatype="string"),
                                          PropertyDef(name="code", datatype="string")]),
        ElementType(name="A1", properties=[PropertyDef(name="name", datatype="string")]),
    ],
    relationships=[RelationshipType(name="rel1", source="E", target="A"),
                   RelationshipType(name="rel2", source="A", target="A1")],
)
model = Model(mm)
for i in range(N_E):
    e = model.create_element("E"); model.set_property(e, "name", f"E{i}")
    for j in range(FAN):
        a = model.create_element("A"); model.set_property(a, "name", f"A{i}-{j}")
        model.set_property(a, "code", f"c{i}-{j}")
        a1 = model.create_element("A1"); model.set_property(a1, "name", f"A1-{i}-{j}")
        model.connect("rel1", e.id, a.id); model.connect("rel2", a.id, a1.id)

for label, second in [
    ("rel hop", {"kind": "relationship", "relationship_type": "rel2", "direction": "out"}),
    ("property hop", {"kind": "property", "property_name": "name"}),
]:
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["E"]},
        "columns": [
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"}, "steps": [
                 {"kind": "relationship", "relationship_type": "rel1", "direction": "out"},
                 second]}}},
            {"kind": "property", "source": {"kind": "column", "index": 0, "step_index": 1},
             "name": "code"},
        ]})
    limits = TableLimits()
    t = time.perf_counter(); built = build_rows_ex(mm, model, defn, limits); tb = time.perf_counter() - t
    t = time.perf_counter(); evaluate_cells(mm, model, defn, built.keys[:200], limits); tc = time.perf_counter() - t
    t = time.perf_counter(); order_rows(mm, model, defn, built.keys, SortSpec(column=1, direction="asc"), limits); ts = time.perf_counter() - t
    print(f"{label:13s} rows={len(built.keys):6d} build={tb*1000:7.1f}ms "
          f"page200={tc*1000:7.1f}ms sort-by-prop={ts*1000:8.1f}ms")
```

- [ ] **Step 2: Run it at both fan-outs and compare with the pre-memo baseline**

Run: `PYTHONPATH=src pixi run -e core-dev python <scratchpad>/bench_memo.py 2000 5` and `... 200 50`
Baseline (commit `88b7234`, before the memo): fan 5 → sort ≈ 474 ms, page200 ≈ 10 ms; fan 50 → sort ≈ 3.6 s, page200 ≈ 66 ms.
Expected after: sort within ~2× of the "build" time at both fan-outs (≈ 100 ms at fan 5, ≈ 80–150 ms at fan 50), page200 ≤ 10 ms. If the fan-50 sort is not at least 10× faster than baseline, the memo is missing on the sort path — check that `order_rows` passes `memo=memo` into `_sort_value` and that `_sort_value` forwards it to `resolve_source_elements`.

- [ ] **Step 3: Document in `CLAUDE.md`**

Insert this bullet directly before the line starting `- **Export overrides (`core/table/export_layout.py`)**`:

```markdown
- **Per-pass navigation memo (`core/table/nav_memo.py`)** — `build_rows_ex`, `order_rows` and `evaluate_cells` each construct their OWN bounded `NavMemo` (LRU, 64 entries) keyed by `(column identity, roots)` and thread it through `resolve_source_elements`/`_navigation_reached`/`_navigation_step_elements` like `script`, so the split rows of one root (contiguous in build order) re-navigate once instead of fan-out times. The memo is NEVER a public-entry-point parameter, never lives on a `Session`/`ScriptEvalContext`, and a navigation with a `ScriptStep` bypasses it (`NavMemo.scripted`) — the two guards that keep a result computed under `cache_only` (build/sort) from ever being served to the live window pass. Entries are immutable chain tuples; consumers only iterate.
```

- [ ] **Step 4: Full verification**

Run: `pixi run core-lint && pixi run core-test`
Expected: lint clean; pytest all green.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -F - <<'EOF'
docs: per-pass navigation memo in CLAUDE.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01797dVGF2VhEz5Ty6NhPUah
EOF
```

---

## Self-review notes

- Design → tasks: chokepoint (T2 step 3), script bypass (T1 `scripted` + T2 test), per-pass creation in all three passes (T2 step 6, T3 step 3), no-public-parameter guard (T2 test `test_public_passes_take_no_memo_parameter`), cross-pass freshness (T3 test), LRU bound (T1), immutability (T1 `MemoEntry` frozen + tuple copy in T2 step 3), benchmark evidence (T4).
- Type consistency: `memo: NavMemo | None = None` everywhere; `_evaluate_navigation` returns `tuple[Sequence[tuple[ChainNode, ...]], bool]` and both consumers iterate only.
- Out of scope, deliberately: `api/script_sweep.py`'s own per-row `resolve_source_elements` loop (a separate background path with its own cache), and a cross-request cache (rejected in Design).
