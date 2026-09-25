# Uniqueness Position Index (K-22) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the uniqueness validator from enumerating the whole model (`{eid: i for i, eid in enumerate(model.elements)}` — 79 ms + 17 MiB at 320k, paid in ~120 of the background sweep's ~160 element chunks and in every commit that touches a duplicate group) by maintaining an element insertion-order index in `IndexSet` at the mutation boundary.

**Architecture:** `IndexSet` gains `element_order: dict[str, int]` (element id → monotonic insertion sequence number) with the invariant `sorted(model.elements, key=element_order.__getitem__) == list(model.elements)`, maintained by `on_element_created` (assign + increment a counter) and `on_element_deleted` (pop), re-derived by `rebuild()`, and checked by `verify_consistent` as an ORDER invariant (a maintained index is sparse, a rebuild dense — the numbers themselves are never compared). `UniquenessValidator.validate_global` reads that dict instead of building a local map: the scoped branch picks a group's primary with one `min()`, the full branch keeps its sort — same primary, same report order, byte-identical issues. A measurement task at scale 320 confirms the sweep and mutation numbers against the spec's spike.

**Tech Stack:** Python 3.14 (core only — no API, DB or frontend change); pytest via pixi (`pixi run -e core-dev pytest`).

**Spec:** `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Program" item 4, § "K-22 design" — the spike table there is the "before" column Task 3 compares against). The BACKLOG entry `K-22` (`BACKLOG.md:1044`) carries the owner's proposal.

## Global Constraints

- Every command goes through **pixi**: single test file `pixi run -e core-dev pytest tests/path/test_x.py -v`; whole backend suite `pixi run core-test`; frontend unit tests `pixi run frontend-test`; lint/format/typecheck `pixi run dr-tidy` (ruff + mypy + pyright + prettier/eslint — all must pass; pyright covers `tests/` too, so no `# type: ignore` shortcuts). The `[feature.api.activation]` hook prints `[ensure_guest]` lines before every command — ignore them. **Ruff does NOT enforce import ordering** in this repo (`ruff.toml` selects `UP` on top of the E4/E7/E9/F defaults; no isort rules) — do not "fix" import order and do not claim ruff wants it.
- Work on a branch `perf/uniqueness-position-index` off `main` (create it via `superpowers:using-git-worktrees` at execution time). In a fresh worktree run `pixi run frontend-install` before `dr-tidy` (it dies at `frontend-format` otherwise). The repo integrates feature branches into `main` with a merge commit, then pushes (`BACKLOG.md:1225`: pushing `main` is standing policy). **`main` can move under you** (a concurrent session commits to it directly): re-check `git log origin/main` immediately before merging and pushing.
- **Worktree harness guard:** inside a worktree the harness refuses "complex" compound Bash commands (loops, `&&`-chains, heredocs, parenthesised groups). Use plain single commands, the Write tool, or put the logic in a script under the session scratchpad and run `bash <script>` / `pixi run -e core-dev python <script>`.
- Comments/docstrings: concise, present tense, only invariants and non-obvious contracts. No spec/plan references, no history narration.
- Python 3.14 idioms (`X | Y` unions, `collections.abc` imports).
- `docs/` is gitignored — the spec and this plan are never committed; every other step commits.
- **The K-22 hazard (the spec's):** per-entity validator hooks stay O(entity), and the O(model) cost must not move somewhere else. The index costs one dict insert per element create and one pop per delete, NOTHING on property writes / relationship changes (an element never moves within `model.elements`), and one extra `enumerate` pass inside `rebuild()`. No per-mutation re-enumeration anywhere.
- **`IndexSet` accessor convention:** every structure is a LIVE INTERNAL VIEW — consumers read, never mutate. `element_order` follows it.
- **Behaviour is unchanged:** the uniqueness report — which member is a group's primary, the order of issues on a full run, the issue messages — is byte-identical before and after. Tests pin it; the refactor must keep them green.
- **K-20 / K-21 / K-6 standing constraints** are untouched by this plan (no search-index, snapshot or `entity_states` code is modified). `rebuild(keep_search=True)` must still re-derive `element_order` — the order is metamodel-independent, so it is simply recomputed like every other non-search structure.
- Model choices that worked for SDD on K-6/K-21: haiku for pure transcription tasks (Tasks 1, 2 and 4 carry the literal code), sonnet for Task 3 and for per-task reviews, the most capable model for the final whole-branch review only.

---

### Task 1: `IndexSet.element_order` — the maintained insertion-order index

**Files:**
- Modify: `src/data_rover/core/model/indexes.py` (module docstring `:1-33`; `__init__` after the `_root_key_of` line `:119`; `on_element_created` `:258`; `on_element_deleted` `:266`; `rebuild` `:344-407`; `verify_consistent` `:447-493`)
- Test: `tests/model/test_indexes.py` (append)

**Interfaces:**
- Produces: `IndexSet.element_order: dict[str, int]` — element id → monotonic insertion sequence number; `sorted(model.elements, key=element_order.__getitem__) == list(model.elements)` at all times; keys are exactly `model.elements.keys()`. Private `IndexSet._next_order: int`. `verify_consistent()` raises `AssertionError` whose message contains `element_order` when the invariant is broken. Task 2 reads `element_order`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/model/test_indexes.py` (the file already imports `pytest`, `Element`, `IndexSet`, `Model` and defines `_mm()` with a `Doc` type keyed on `name`):

```python
# ---------------------------------------------------------------------------
# element insertion-order index
# ---------------------------------------------------------------------------


def _assert_order_matches_dict(model: Model) -> None:
    order = model.indexes.element_order
    ids = list(model.elements)
    assert set(order) == set(ids)
    assert sorted(ids, key=order.__getitem__) == ids


def test_element_order_tracks_insertion_through_churn():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    c = model.create_element("Doc")
    order = model.indexes.element_order
    assert order[a.id] < order[b.id] < order[c.id]

    model.delete_element(b.id)
    assert b.id not in model.indexes.element_order
    _assert_order_matches_dict(model)

    # a re-inserted id lands LAST in the dict and gets a fresh, larger number
    restored = model.restore_element(b.id, "Doc")
    assert restored.id == b.id
    assert list(model.elements)[-1] == b.id
    assert model.indexes.element_order[b.id] > model.indexes.element_order[c.id]
    _assert_order_matches_dict(model)
    model.indexes.verify_consistent()


def test_element_order_rebuilt_from_dict_order():
    model = Model(_mm())
    for i in range(5):
        model.elements[f"e{i}"] = Element(id=f"e{i}", type_name="Doc")
    model.indexes.rebuild()
    assert model.indexes.element_order == {f"e{i}": i for i in range(5)}

    # the counter continues past the rebuilt numbers
    d = model.create_element("Doc")
    assert model.indexes.element_order[d.id] == 5
    _assert_order_matches_dict(model)
    model.indexes.verify_consistent()


def test_element_order_rederived_by_keep_search_rebuild():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    model.delete_element(a.id)
    model.restore_element(a.id, "Doc")
    assert model.indexes.element_order[a.id] > model.indexes.element_order[b.id]

    model.indexes.rebuild(keep_search=True)
    # dense numbers in dict order: b was never deleted, a was re-inserted last
    assert model.indexes.element_order == {b.id: 0, a.id: 1}
    _assert_order_matches_dict(model)


def test_element_order_empty_model():
    model = Model(_mm())
    assert model.indexes.element_order == {}
    model.indexes.rebuild()
    assert model.indexes.element_order == {}
    model.indexes.verify_consistent()


def test_verify_consistent_detects_element_order_drift():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    order = model.indexes.element_order
    order[a.id], order[b.id] = order[b.id], order[a.id]  # swapped: wrong order
    with pytest.raises(AssertionError, match="element_order"):
        model.indexes.verify_consistent()


def test_verify_consistent_detects_element_order_missing_key():
    model = Model(_mm())
    a = model.create_element("Doc")
    del model.indexes.element_order[a.id]
    with pytest.raises(AssertionError, match="element_order"):
        model.indexes.verify_consistent()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/model/test_indexes.py -k element_order -v`
Expected: 6 FAIL with `AttributeError: 'IndexSet' object has no attribute 'element_order'`.

- [ ] **Step 3: Implement the index**

In `src/data_rover/core/model/indexes.py`:

(a) Module docstring — after the sentence ending `... so a root's display-name reposition is not missed.` (line `:21`), insert:

```python
The element insertion-order index (``element_order``) is maintained by the
two element hooks alone — an element never moves within ``model.elements``,
so property and relationship changes leave it untouched — and re-derived by
``rebuild()``.
```

(b) `__init__` — right after the `self._root_key_of: dict[str, Pair] = {}` line, add:

```python
        #: element id -> monotonic insertion sequence number. Invariant:
        #: ``sorted(model.elements, key=element_order.__getitem__) ==
        #: list(model.elements)`` — dict iteration order IS insertion order,
        #: a deletion never reorders the survivors, and a re-inserted id
        #: (restore) lands last and gets a fresh, larger number. Lets the
        #: uniqueness validator pick a duplicate group's insertion-first
        #: primary without enumerating the model. Numbers are sparse after
        #: churn; only their ORDER is meaningful.
        self.element_order: dict[str, int] = {}
        self._next_order: int = 0
```

(c) `on_element_created` — make these the first two statements of the method body:

```python
        self.element_order[element.id] = self._next_order
        self._next_order += 1
```

(d) `on_element_deleted` — add as the last statement of the method body:

```python
        self.element_order.pop(element.id, None)
```

(e) `rebuild` — the element loop currently reads

```python
        for element in self._model.elements.values():
            self.elements_by_type.setdefault(element.type_name, set()).add(element.id)
```

Replace it with a single `enumerate` pass that also fills a fresh order dict, and assign the dict + counter after the loop (the whole-dict assignment keeps `rebuild` a wholesale replacement like `roots_order`'s):

```python
        order: dict[str, int] = {}
        for i, element in enumerate(self._model.elements.values()):
            order[element.id] = i
            self.elements_by_type.setdefault(element.type_name, set()).add(element.id)
            self._add_to_group(element)
            self._add_refs(element.id, self._element_refs(element))
            if element.id not in self.containment_parents:
                self._root_key_of[element.id] = (display_name(element), element.id)
        self.element_order = order
        self._next_order = len(order)
        # bulk-construct in one O(n log n) pass instead of n incremental adds
        self.roots_order = SortedPairs(self._root_key_of.values())
```

(the three statements inside the loop and the `roots_order` line are the existing ones — only the `enumerate`, the `order[...] = i` line and the two assignments are new).

(f) `verify_consistent` — the numbers of a maintained index are sparse while a rebuild's are dense, so the dict is deliberately NOT in the `mismatched` name tuple. Instead, right after the `mismatched = [...]` list comprehension and before `if mismatched:`, add the order invariant:

```python
        # element_order carries sparse numbers after churn (a rebuild's are
        # dense), so compare the ORDER it induces, never the numbers
        order = self.element_order
        ids = list(self._model.elements)
        if set(order) != set(ids) or sorted(ids, key=order.__getitem__) != ids:
            mismatched.append("element_order")
```

- [ ] **Step 4: Run the tests to verify they pass, then the whole index test file**

Run: `pixi run -e core-dev pytest tests/model/test_indexes.py -v`
Expected: PASS, every pre-existing test included (they all end in `_assert_matches_rebuild` → `verify_consistent`, which now also checks the invariant through create/delete/restore/apply-cr churn).

Run: `pixi run -e core-dev pytest tests/model tests/validation -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/model/indexes.py tests/model/test_indexes.py
git commit -m "feat(indexes): maintained element insertion-order index"
```

---

### Task 2: `UniquenessValidator` reads the index

**Files:**
- Modify: `src/data_rover/core/validation/validators/uniqueness.py` (class docstring `:10-22`; `validate_global` `:27-61`)
- Test: `tests/validation/test_uniqueness.py` (append)

**Interfaces:**
- Consumes: `IndexSet.element_order` (Task 1).
- Produces: nothing new — same `validate_global(model, scope) -> list[Issue]`, same issues, same order.

- [ ] **Step 1: Write the tests**

Append to `tests/validation/test_uniqueness.py` (the file already imports `Model`, `Scope`, `UniquenessValidator` and defines `_named_mm(named_key=...)` and `_set_name`). `restore_element` is used to pick ids whose LEXICAL order disagrees with insertion order, so a test cannot pass by accident through `sorted(ids)`:

```python
# ---------------------------------------------------------------------------
# primary = insertion-first, on both branches, without enumerating the model
# ---------------------------------------------------------------------------


class _IterCountingDict(dict):
    """model.elements stand-in that counts whole-dict iterations."""

    iterations = 0

    def __iter__(self):
        type(self).iterations += 1
        return super().__iter__()


def _three_foos(model: Model) -> None:
    for eid in ("z-first", "a-second", "m-third"):
        el = model.restore_element(eid, "Requirement")
        _set_name(model, el, "Foo")


def test_primary_is_insertion_first_not_lexically_first():
    model = Model(_named_mm(named_key=["name"]))
    _three_foos(model)

    issues = UniquenessValidator().validate(model, Scope.all())
    assert [i.target_ids for i in issues] == [
        ["a-second", "z-first"],
        ["m-third", "z-first"],
    ]


def test_scoped_run_reports_same_issues_as_full_run():
    model = Model(_named_mm(named_key=["name"]))
    _three_foos(model)

    full = UniquenessValidator().validate(model, Scope.all())
    scoped = UniquenessValidator().validate(
        model, Scope(["m-third", "z-first", "a-second"])
    )
    # scope order decides the scoped report order; the primary never reports
    assert [i.target_ids for i in scoped] == [
        ["m-third", "z-first"],
        ["a-second", "z-first"],
    ]
    assert {i.message for i in scoped} == {i.message for i in full}


def test_full_run_orders_groups_by_their_primary():
    model = Model(_named_mm(named_key=["name"]))
    b1 = model.restore_element("b1", "Requirement")
    a1 = model.restore_element("a1", "Requirement")
    a2 = model.restore_element("a2", "Requirement")
    b2 = model.restore_element("b2", "Requirement")
    for el, name in ((b1, "Bar"), (a1, "Foo"), (a2, "Foo"), (b2, "Bar")):
        _set_name(model, el, name)

    issues = UniquenessValidator().validate(model, Scope.all())
    # the Bar group's primary (b1) was inserted before the Foo group's (a1)
    assert [i.target_ids for i in issues] == [["b2", "b1"], ["a2", "a1"]]


def test_restoring_a_deleted_primary_makes_it_last():
    model = Model(_named_mm(named_key=["name"]))
    _three_foos(model)
    model.delete_element("z-first")
    restored = model.restore_element("z-first", "Requirement")
    _set_name(model, restored, "Foo")

    issues = UniquenessValidator().validate(model, Scope.all())
    assert [i.target_ids for i in issues] == [
        ["m-third", "a-second"],
        ["z-first", "a-second"],
    ]


def test_scoped_run_never_enumerates_the_model():
    model = Model(_named_mm(named_key=["name"]))
    _three_foos(model)
    counting = _IterCountingDict(model.elements)
    model.elements = counting
    _IterCountingDict.iterations = 0

    issues = UniquenessValidator().validate(model, Scope(["a-second"]))
    assert [i.target_ids for i in issues] == [["a-second", "z-first"]]
    assert _IterCountingDict.iterations == 0
```

- [ ] **Step 2: Run the tests — four pin existing behaviour and PASS, one FAILS**

Run: `pixi run -e core-dev pytest tests/validation/test_uniqueness.py -v`
Expected: `test_scoped_run_never_enumerates_the_model` FAILS (`assert 1 == 0` — the current code enumerates `model.elements` to build its map); the other four new tests PASS on the old code — they pin the report the refactor must reproduce.

- [ ] **Step 3: Rewrite `validate_global` over the index**

Replace the class docstring's last sentence (from `All work happens in ...` to `... insertion order.`) with:

```python
    reads ``uniq_groups`` / ``uniq_key_of`` / ``duplicate_keys`` and
    ``element_order``. All work happens in :meth:`validate_global` (it needs
    the scope to avoid double-reporting), keyed on each duplicate group's
    *primary* member — the group member that comes first in
    ``model.elements`` insertion order, read off ``element_order`` so no run
    ever enumerates the model.
```

(keep the sentence that precedes it — `The grouping itself is maintained incrementally ... this validator only` — intact; the replacement continues it.)

Replace the whole `validate_global` method with:

```python
    def validate_global(self, model, scope: Scope) -> list[Issue]:
        indexes = model.indexes
        if not indexes.duplicate_keys:
            return []

        # element insertion order decides the primary of each group and
        # keeps the report deterministic
        order = indexes.element_order
        issues: list[Issue] = []
        if scope.ids is None:
            ordered_keys = sorted(
                indexes.duplicate_keys,
                key=lambda k: min(order[i] for i in indexes.uniq_groups[k]),
            )
            for group_key in ordered_keys:
                ids = sorted(indexes.uniq_groups[group_key], key=order.__getitem__)
                primary = ids[0]
                for dup in ids[1:]:
                    issues.append(self._issue(model, group_key, dup, primary))
        else:
            for entity_id in scope.ids:
                group_key = indexes.uniq_key_of.get(entity_id)
                if group_key is None or group_key not in indexes.duplicate_keys:
                    continue
                primary = min(indexes.uniq_groups[group_key], key=order.__getitem__)
                if entity_id != primary:
                    issues.append(self._issue(model, group_key, entity_id, primary))
        return issues
```

- [ ] **Step 4: Run the tests to verify they all pass**

Run: `pixi run -e core-dev pytest tests/validation/test_uniqueness.py -v`
Expected: PASS (all 19).

Run: `pixi run -e core-dev pytest tests/validation tests/api/test_validation_sweep.py tests/api/test_incremental_invalidation.py -q`
Expected: PASS (the sweep test's `n + (n - 1)` issue count and the dirty-set widening are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/validation/validators/uniqueness.py tests/validation/test_uniqueness.py
git commit -m "perf(validation): uniqueness primary off the insertion-order index"
```

---

### Task 3: Measure at scale 320

**Files:** none in the repo (the script and its output live in the session scratchpad). Output: numbers for Task 4's BACKLOG entry and Task 5's merge commit.

**Interfaces:**
- Consumes: Tasks 1–2 through the real core (`build_model_from_dicts`, `default_pipeline`, `Model.create_element/delete_element`, `IndexSet.rebuild`).
- Produces: `$SCRATCH/k22-numbers.md` with: element-chunk sweep total + median; full-scope uniqueness run; create/delete µs per op; `rebuild()` seconds; resident size of `element_order`. Compared against the spec's § "K-22 design" table ("Today" column: 17.10 s / 126 ms; 185 ms; 42.8 / 16.8 µs; 3.23 s).

- [ ] **Step 1: Generate the production-scale fixture (once, ~1 min; skip if `$SCRATCH/prod.model.json` exists)**

```bash
export SCRATCH=<the session scratchpad directory from the system prompt>
pixi run -e core-dev python examples/generate_large_model.py --scale 320 --out "$SCRATCH/prod.model.json"
```

- [ ] **Step 2: Time the sweep, the full run and the mutation boundary**

Write `$SCRATCH/measure_k22.py` (single file; run with a plain `pixi run -e core-dev python "$SCRATCH/measure_k22.py"` from the repo root — the fixture generator avoids duplicates by construction, so the script injects sporadic ones exactly as the spec's spike did):

```python
"""K-22 measurement at scale 320: sweep per element chunk, full run, mutation cost."""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, "src")

from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_str  # noqa: E402
from data_rover.core.validation.pipeline import default_pipeline  # noqa: E402
from data_rover.core.validation.scope import Scope  # noqa: E402
from data_rover.core.validation.validators.uniqueness import UniquenessValidator  # noqa: E402

SCRATCH = os.path.dirname(os.path.abspath(__file__))
CHUNK = 2000  # validation_sweep.CHUNK_SIZE
EVERY = 1000  # every EVERY-th element becomes a duplicate of a same-type, same-owner predecessor

mm = load_metamodel_str(open("examples/smart-city.metamodel.yaml").read())
t0 = time.perf_counter()
model = build_model_from_dicts(mm, json.loads(open(f"{SCRATCH}/prod.model.json").read()))
print(f"load+build {time.perf_counter() - t0:.1f}s  {len(model.elements)} el / {len(model.relationships)} rel")

idx = model.indexes
prev_by_type: dict[str, str] = {}
made = 0
for n, eid in enumerate(list(model.elements)):
    el = model.elements[eid]
    prev = prev_by_type.get(el.type_name)
    prev_by_type[el.type_name] = eid
    if prev is None or n % EVERY or idx.uniq_key_of[prev][1] != idx.uniq_key_of[eid][1]:
        continue
    spec = mm.effective_element_key_spec(el.type_name)
    pel = model.elements[prev]
    keys = list(pel.properties) if spec is None else list(spec.properties)
    for k in keys:
        if k in pel.properties:
            model.set_property(el, k, pel.properties[k])
        elif k in el.properties:
            model.delete_property(el, k)
    if spec is None:
        for k in [k for k in el.properties if k not in pel.properties]:
            model.delete_property(el, k)
    made += 1
members = {m for k in idx.duplicate_keys for m in idx.uniq_groups[k]}
ids = list(model.elements)
hit = sum(1 for s in range(0, len(ids), CHUNK) if any(e in members for e in ids[s:s + CHUNK]))
print(f"{made} duplicates injected -> {len(idx.duplicate_keys)} groups; {hit}/{-(-len(ids) // CHUNK)} element chunks touch one")

order_bytes = sys.getsizeof(idx.element_order) + 28 * max(0, len(model.elements) - 256)
print(f"element_order: ~{order_bytes / 2**20:.1f} MiB resident (dict + int objects)")

pipeline = default_pipeline()
per: list[float] = []
for s in range(0, len(ids), CHUNK):
    chunk = ids[s:s + CHUNK]
    t0 = time.perf_counter()
    pipeline.validate(model, Scope(chunk))
    per.append(time.perf_counter() - t0)
per.sort()
print(f"element-chunk sweep: {len(per)} chunks, total {sum(per):.2f}s, median {per[len(per) // 2] * 1000:.1f} ms, p90 {per[int(len(per) * 0.9)] * 1000:.1f} ms, max {per[-1] * 1000:.1f} ms")

t0 = time.perf_counter()
issues = UniquenessValidator().validate(model, Scope.all())
print(f"full-scope uniqueness run: {(time.perf_counter() - t0) * 1000:.0f} ms, {len(issues)} issues")

N = 20000
t0 = time.perf_counter()
created = [model.create_element("Person") for _ in range(N)]
t_create = time.perf_counter() - t0
t0 = time.perf_counter()
for el in created:
    model.delete_element(el.id)
t_delete = time.perf_counter() - t0
print(f"create {t_create * 1e6 / N:.1f} us/op   delete {t_delete * 1e6 / N:.1f} us/op")
t0 = time.perf_counter()
model.indexes.rebuild()
print(f"rebuild(): {time.perf_counter() - t0:.2f}s")
order = model.indexes.element_order
assert sorted(model.elements, key=order.__getitem__) == list(model.elements)
model.indexes.verify_consistent()
print("invariant holds after churn + rebuild; verify_consistent passes at 320k")
```

Run: `pixi run -e core-dev python "$SCRATCH/measure_k22.py"`
Expected (from the spec's prototype column): element-chunk sweep total ≈ **5.5 s**, median ≈ 33 ms (was 17.1 s / 126 ms); full-scope run ≈ 100 ms (was 185 ms); create/delete within noise of 43 / 17 µs; `rebuild()` ≈ 3.3–3.6 s; `element_order` ≈ 16 MiB; the invariant line printed. If the sweep total is **> 8 s** or create is **> 60 µs/op**, stop and re-read Task 1's `rebuild`/hook changes — something re-enumerates.

- [ ] **Step 3: Record the numbers**

Write `$SCRATCH/k22-numbers.md` with the six figures (sweep total + median, full run, create, delete, rebuild, resident MiB) next to the spec table's "Today" column. Task 4 copies them into the BACKLOG, Task 5 into the merge commit. No commit in this task.

---

### Task 4: Docs and backlog

**Files:**
- Modify: `CLAUDE.md:55` (the `model/model.py` bullet)
- Modify: `BACKLOG.md:1044-1049` (`### K-22`) and the header paragraph at `BACKLOG.md:60-61`

**Interfaces:** none — prose only. Fill every `<…>` placeholder from `$SCRATCH/k22-numbers.md` (Task 3).

- [ ] **Step 1: CLAUDE.md**

In the `model/model.py` bullet (line 55), after the sentence `Bulk loaders that populate the dicts directly must call \`indexes.rebuild()\`.`, insert:

```markdown
`IndexSet.element_order` (element id → monotonic insertion sequence number; sorting ids by it reproduces `model.elements` order, and ONLY the order is meaningful — the numbers go sparse after churn, a restore re-inserts last) is maintained at that same boundary like `roots_order` and is how the uniqueness validator picks a duplicate group's insertion-first primary without enumerating the model; `verify_consistent` checks it as an order invariant, never by comparing numbers to a fresh rebuild.
```

- [ ] **Step 2: BACKLOG.md**

Replace the `### K-22` heading and paragraph with:

```markdown
### K-22 · Uniqueness validator builds a whole-model position map per scoped run · `done` (2026-08-27, perf/uniqueness-position-index) · perf · *2026-08-26*
`IndexSet.element_order` (element id → monotonic insertion sequence number, maintained by
the two element hooks and re-derived by `rebuild()`; `verify_consistent` checks the order
invariant) replaces the validator's per-run `{eid: i for i, eid in enumerate(model.elements)}`
— 79 ms + 17 MiB per build at 320k, paid in ~120 of the sweep's ~160 element chunks and in
every commit touching a duplicate group. Measured at scale 320 with 231 sporadic duplicate
groups injected (the fixture generator avoids duplicates): element half of the sweep
**17.10 s → <sweep_total> s** (median 126 → <sweep_median> ms per chunk); full-scope
uniqueness run 185 → <full> ms; `create_element` / `delete_element` <create> / <delete> µs per
op (was 42.8 / 16.8 — the index is one dict insert / one pop); `rebuild()` <rebuild> s (was
3.23); +<resident> MiB resident. The per-sweep hoist alternative was declined: a fresh
pipeline per request means every commit would still pay the build, and the core has no
mutation counter to key a cached map on.
```

Then, in the header paragraph, append after `... closes K-21 (gzip'd compact snapshots, bytes-sniffing reader; see its entry for the numbers).`:

```markdown
The 2026-08-27 pass on `perf/uniqueness-position-index` closes K-22 (the maintained
`IndexSet.element_order`; see its entry for the numbers).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md BACKLOG.md
git commit -m "docs: element insertion-order index — CLAUDE.md model notes, backlog (K-22 done)"
```

---

### Task 5: Full verification and integration

**Files:** none new.

- [ ] **Step 1: Lint/format/typecheck**

Run: `pixi run dr-tidy`
Expected: ruff, mypy, pyright, prettier and eslint all pass. Likely fixes: ruff reformatting a long `sorted(...)` line in `uniqueness.py` or a test literal; pyright on `_IterCountingDict.__iter__` (if it complains about the missing return annotation, annotate it `-> Iterator[str]` with `from collections.abc import Iterator`). Amend into the relevant commit or add a `chore:` commit.

- [ ] **Step 2: Whole suites**

Run: `pixi run core-test`
Expected: PASS, count = the `main` baseline recorded at branch creation + 11 new tests (Task 1: 6, Task 2: 5), zero new skips.

Run: `pixi run frontend-test`
Expected: PASS (no frontend files changed; this proves it).

- [ ] **Step 3: Re-run the Task 3 measurement on the final tree**

Run: `pixi run -e core-dev python "$SCRATCH/measure_k22.py"`
Expected: numbers within noise of Task 3's.

- [ ] **Step 4: Integrate**

Use `superpowers:finishing-a-development-branch`: re-check `git log --oneline origin/main -3` first (a concurrent session may have moved `main`), merge `perf/uniqueness-position-index` into `main` with a merge commit whose body carries the Task 3 numbers, run `pixi run core-test` on the merged result, push `main`, remove the worktree. Leave `.claude/worktrees/feat-metamodel-diagram-editor` alone — it belongs to someone else.

---

### Task 6: Hand off to the next plan (K-23 — replay hot path)

**Files:** none in the repo (the handoff lives in `~/.claude/handoffs/`).

- [ ] **Step 1: Reconstruct state**

Run: `git status --short`, `git branch --show-current`, `git log --oneline -5`, `pixi run core-test -q | tail -3` (as separate plain commands if the harness refuses the chain).

- [ ] **Step 2: Invoke the handoff skill**

Invoke `handoff` (the `Skill` tool, name `handoff`). Fill its sections with these facts (pointers, not payload):

- **Mission:** the large-model performance program from `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Program"); K-20, K-6, K-21 and K-22 are merged; the next session writes and executes the plan for **K-23** (`Model.set_property`/`delete_property` copy the effective property list and build a name set per write — `core/model/model.py:82-85`, `:105-108` — and `routes/ops.py::_check_patch_keys` likewise; the hydration replay tail and every commit pay it per op property; `on_properties_changed` re-derives the element's whole trigram set per write; add a cached `frozenset` name accessor on `Metamodel`), then hands off to K-24 — every plan's last task is this same handoff step. "Done" = plan written, executed on a worktree branch, measured at scale 320, merged into `main` with a merge commit, pushed, handoff delivered.
- **Orient First:** the spec above (§ "Program" item 5; § "K-20"/"K-21"/"K-22 design" as the design-section shape — K-23 has none yet, writing one is part of the job); `BACKLOG.md` K-23 → K-25; `src/data_rover/core/model/model.py` (`set_property`/`delete_property`); `src/data_rover/api/routes/ops.py` (`_check_patch_keys`); `src/data_rover/core/metamodel/schema.py` (`_Caches`, the effective-property lookups — the natural home for a cached `frozenset`); `src/data_rover/core/model/indexes.py::on_properties_changed` + `_update_trigrams`; `src/data_rover/api/hydration.py` (the replay tail); `tests/model/test_model.py`, `tests/metamodel/`; this plan (`docs/superpowers/plans/2026-08-27-uniqueness-position-index.md`) and the spec's K-22 spike script pattern as the shape to match; `CLAUDE.md`.
- **Standing Constraints:** K-22 (new): `IndexSet.element_order` is maintained by the two element hooks only and re-derived by `rebuild()`; only its ORDER is meaningful — never compare its numbers to a rebuild's, never assign from anywhere else, never make a property/relationship hook touch it; K-21 (bytes-sniffing snapshot reader, no key branch/migration; `iter_model_json` stays the save-file contract; rebind/evict/baseline snapshots synchronous); K-20 (no search index on transient models; `keep_search=True` only at the four rebind sites); K-6 (`entity_states` NULL = reconstruct, never backfilled); `Metamodel` is immutable with lazily-built `_Caches` — a new cached accessor goes there and resets with `_cache = None`; per-entity validator hooks stay O(entity); `docs/` gitignored; pixi for everything; merge-commit integration; `pixi run frontend-install` before `dr-tidy` in a fresh worktree; worktree harness guard (plain single commands / scratchpad scripts); ruff does NOT enforce import order here; a concurrent session commits directly to `main` — re-check before merge/push. SDD model choices: haiku for transcription tasks carrying literal code, sonnet for integration/measurement tasks and per-task reviews, the most capable model for the final review.
- **Known Issues, Not Yet Fixed:** K-23 → K-25 as listed in the BACKLOG; `ENTITY_STATES_MAX` is an entity-count cap, not a byte cap (`api/commit_states.py:36` — record, do not build); snapshot blob GC (`content.py`, out of scope); four tests call `schedule_periodic_snapshot` without `write_mutex` (harmless, non-blocking); `snapshot_job` can record a row ahead of `models.model_rev` after a legacy `touch_model()` (dead row + orphan blob, documented); `scripts/bench.py:208` pyright note (pre-existing, invisible to `dr-tidy`); the sweep's remaining ~33 ms per element chunk is the other five validators plus the pipeline's per-entity dispatch — not on the program list, record only.
- **Deferred — Do Not Do:** folding the sequence number into `uniq_groups` (`dict[UniqKey, dict[str, int]]` — ~3 MiB, three consumers, declined in the spec's K-22 non-goals); a sequence-number field on `Element`; the per-sweep hoist of the position map; zstd snapshots; serialize-outside-the-mutex; an `encoding` column on `Snapshot`; everything K-20/K-6 already deferred (posting-set shrinking, `entity_states` backfill, journal-based `GET /commits/{rev}/model`).
- **Plan:** 1. Read the spec's § "Program" item 5 and `BACKLOG.md` K-23, then `model.py:82-110`, `routes/ops.py::_check_patch_keys`, `schema.py`'s `_Caches` and `indexes.py::_update_trigrams` — establish which of the four per-write costs actually dominates a replay/commit at scale 320 before designing (spike: time `set_property` × N on the scale-320 model, then with each cost stubbed). 2. Append a § "K-23 design" section (Problem / Design / Non-goals, spike table) to the spec. 3. Write `docs/superpowers/plans/<date>-property-write-hot-path.md` with `superpowers:writing-plans` in this plan's shape (literal code/test bodies per task, a measurement task). 4. Execute with `superpowers:subagent-driven-development` on `perf/property-write-hot-path`; do the pre-flight conflict scan as a table of each task's test preconditions against what earlier tasks install. 5. Verify (`dr-tidy`, both suites) + measure + merge commit + push, then hand off to K-24.
- **Open Questions:** none blocking. Record: whether the K-23 spike shows the trigram re-derivation (`_update_trigrams` per property write) or the property-list copy dominating — if trigrams dominate, the design is an `on_properties_changed` diff of the ONE changed property's text rather than a metamodel cache.

- [ ] **Step 3: Deliver**

Reply exactly as the handoff skill prescribes: the file path, the one-line paste command, and the full handoff in one fenced block.
