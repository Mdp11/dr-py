# Untyped Navigation Scope (K-24) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `core/navigation/evaluate.py::_scope_ids` — the row source of every `ScopeRows` table and the start set of every `Scope`-started navigation, paid once per table per commit through `TableOrderCache` — cost ~24 ms instead of ~465 ms for an untyped, criteria-less scope at scale 320 (320,640 elements), and ~283 ms instead of ~762 ms with one criterion, with a byte-identical result.

**Architecture:** Four small legs inside one function and its two matcher helpers, nothing outside `core/navigation/evaluate.py`. (1) The untyped branch walks `model.elements.values()` in dict (insertion) order instead of building a `set` of ids and re-looking each one up — and because production ids are time-ordered UUIDv7 and the importer's are sequential, the `sorted()` that stays sees a presorted run and finishes in O(n) comparisons. (2) An empty `scope.criteria` short-circuits to `sorted(<candidates>)` in both branches instead of calling the matcher per element to compute `all(())`. (3) `_matches_criteria`/`_matches_filter` become plain loops over the criteria list read once. (4) The typed branch keeps its per-type union (the dedup for overlapping `types`) and gains only leg 2. A differential test pins the new function against today's derivation on a model whose insertion order is deliberately not id order; a measurement task at scale 320 confirms the numbers against the spec's spike table.

**Tech Stack:** Python 3.14 (core only; no API, DB, setting, migration or frontend change); pytest via pixi (`pixi run -e core-dev pytest`).

**Spec:** `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Program" item 6, § "K-24 design" — its spike table is the "Today" column Task 3 compares against; its Non-goals record the decision to KEEP sorted-id order). The BACKLOG entry `K-24` (`BACKLOG.md:1079`) carries the owner's item.

## Global Constraints

- Every command goes through **pixi**: single test file `pixi run -e core-dev pytest tests/path/test_x.py -v`; whole backend suite `pixi run core-test`; frontend unit tests `pixi run frontend-test`; lint/format/typecheck `pixi run dr-tidy` (ruff + mypy + pyright + prettier/eslint — all must pass; pyright covers `tests/` too, so no `# type: ignore` shortcuts). Check-only forms `pixi run dr-tidy true` / `pixi run core-tidy true` modify nothing — use those while an implementer is mid-edit. The `[feature.api.activation]` hook prints `[ensure_guest]` lines before every command — ignore them. **Ruff does NOT enforce import ordering** in this repo (`ruff.toml` selects `UP` on top of the E4/E7/E9/F defaults; no isort rules) — do not "fix" import order and do not claim ruff wants it.
- Work on a branch `perf/untyped-navigation-scope` off `main` (create it via `superpowers:using-git-worktrees` at execution time; `EnterWorktree` names the branch `worktree-<name>` — `git branch -m perf/untyped-navigation-scope` right after entering). In a fresh worktree run `pixi run frontend-install` before `dr-tidy` (it dies at `frontend-format` otherwise). The repo integrates feature branches into `main` with a merge commit, then pushes (`BACKLOG.md`, Process/infra: pushing `main` is standing policy). **`main` can move under you** (a concurrent session commits to it directly): re-check `git log origin/main` immediately before merging and pushing. Leave `.claude/worktrees/feat-metamodel-diagram-editor` alone — it belongs to another session.
- **Worktree harness guard:** inside a worktree the harness refuses compound Bash (loops, `&&`-chains, heredocs, `$(...)` groups, parenthesised groups, even `${PIPESTATUS[0]}`). Use plain single commands, the Write/Edit tools, or put the logic in a script under the session scratchpad and run `bash <script>` / `pixi run -e core-dev python <script>`. To merge, `ExitWorktree keep` first, then merge from the main checkout and `git worktree remove` the path.
- Comments/docstrings: concise, present tense, only invariants and non-obvious contracts. No spec/plan references, no history narration ("was", "used to", "K-24").
- Python 3.14 idioms (`X | Y` unions, `collections.abc` imports).
- `docs/` is gitignored — the spec and this plan are never committed; every other step commits.
- **The K-24 decision (the spec's):** the result of `_scope_ids` stays the ASCENDING-ID list of matching elements — table row order, navigation chain order and the stateless offset/limit paging that relies on "depth-first over SORTED element ids" (the evaluator's module docstring) are byte-identical before and after. Do NOT return insertion order, do NOT add a maintained sorted-id index, do NOT add a per-rev cache — all three are recorded Non-goals.
- **Nothing O(model) moves to the mutation boundary**; no `IndexSet` structure is added or changed. `core/search/criteria.py` (`match_element` and friends) is untouched — `/model/search` must stay byte-identical.
- **K-23 / K-22 / K-21 / K-20 / K-6 contracts are untouched** by this plan (it never touches `indexes.py`, `model.py`, the snapshot codec or the journal): `_trigrams_of` entry ⇔ indexed; `element_order` maintained by the two element hooks only; bytes-sniffing snapshot reader; no search index on transient models; `entity_states` NULL = reconstruct.
- Model choices that worked for SDD on K-6/K-21/K-22/K-23: **haiku** for transcription tasks carrying the literal code (Tasks 1, 2 and 4), **sonnet** for Task 3 and 5 and for per-task reviews, the most capable model for the final whole-branch review only. Run the verification suites in the background while a review is pending — never alongside a timing measurement.

**Cross-task test preconditions** (the pre-flight conflict scan; re-check it before executing):

| Task | Its tests assume | Installed by |
|---|---|---|
| 1 | `_scope_ids(metamodel, model, scope) -> list[str]` importable from `data_rover.core.navigation.evaluate`; `_match_nav_criterion` importable from the same module (the differential test's reference derivation calls it directly); `Model.restore_element(id, type)` accepts any unused id; `PropertyCriterion` needs `type="property"` | Task 1 itself (all pre-existing) |
| 2 | `_matches_criteria(model, element, scope)` / `_matches_filter(model, element, step)` keep their names and signatures; `FilterStep(criteria=[...])` constructs; Task 1's `tests/navigation/test_scope_ids.py` exists (Task 2 appends to it) | Task 1 (the file), nothing else |
| 3 | Tasks 1–2 merged into the tree; the scale-320 fixture; `data_rover.api.routes._snapshot.build_model_from_dicts`; `examples/smart-city.metamodel.yaml` | Tasks 1–2 |

---

### Task 1: `_scope_ids` walks `model.elements` and short-circuits an empty criteria list

**Files:**
- Modify: `src/data_rover/core/navigation/evaluate.py:237-245` (`_scope_ids`)
- Test: `tests/navigation/test_scope_ids.py` (new)

**Interfaces:**
- Consumes: `Model.elements: dict[str, Element]` (insertion-ordered), `IndexSet.elements_by_type: dict[str, set[str]]`, `Metamodel.element_descendants(name) -> frozenset[str]`, `_matches_criteria(model, element, scope) -> bool` (unchanged in this task).
- Produces: `_scope_ids(metamodel: Metamodel, model: Model, scope: Scope) -> list[str]` — same name, signature and result (ascending-id list of matching elements) as today; Task 2 and `core/table/evaluate.py::_scope_row_keys` keep calling it unchanged.

- [ ] **Step 1: Write the failing tests**

Create `tests/navigation/test_scope_ids.py`:

```python
"""`_scope_ids` returns the ASCENDING-ID list of the elements a scope selects —
the paging-determinism contract — while walking the model in insertion order
(no id set, no per-id lookup) and skipping the matcher when there are no
criteria. The differential test pins it against the set-based derivation on a
model whose insertion order is deliberately NOT id order."""

import random

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
)
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import (
    _match_nav_criterion,
    _scope_ids,
    evaluate,
)
from data_rover.core.navigation.schema import PathNavigation, Scope
from data_rover.core.search.criteria import Criterion, PropertyCriterion


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Node",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(name="Building", extends="Node"),
            ElementType(name="Sensor", extends="Node"),
        ],
        relationships=[],
    )


def _contains(value: str) -> PropertyCriterion:
    return PropertyCriterion(type="property", name="name", op="contains", value=value)


def _exists() -> PropertyCriterion:
    return PropertyCriterion(type="property", name="name", op="exists")


def _unsorted_model() -> Model:
    """Insertion order z, m, a — id order a, m, z. `m` carries no name."""
    model = Model(_mm())
    z = model.restore_element("z", "Building")
    model.set_property(z, "name", "zeta")
    model.restore_element("m", "Sensor")
    a = model.restore_element("a", "Sensor")
    model.set_property(a, "name", "alpha")
    assert list(model.elements) == ["z", "m", "a"]
    return model


def _reference(mm: Metamodel, model: Model, scope: Scope) -> list[str]:
    """The set-based derivation: union of per-type sets (or every id), filter,
    sort. The oracle the new implementation must match exactly."""
    if scope.types:
        ids: set[str] = set()
        for type_name in scope.types:
            for concrete in mm.element_descendants(type_name):
                ids |= model.indexes.elements_by_type.get(concrete, set())
    else:
        ids = set(model.elements.keys())
    return sorted(
        i
        for i in ids
        if all(
            _match_nav_criterion(model, model.elements[i], c) for c in scope.criteria
        )
    )


def test_untyped_scope_is_sorted_by_id_not_insertion_order() -> None:
    model = _unsorted_model()
    assert _scope_ids(model.metamodel, model, Scope()) == ["a", "m", "z"]


def test_untyped_scope_with_criteria_filters_then_sorts() -> None:
    model = _unsorted_model()
    assert _scope_ids(model.metamodel, model, Scope(criteria=[_exists()])) == ["a", "z"]
    assert _scope_ids(model.metamodel, model, Scope(criteria=[_contains("et")])) == ["z"]
    assert _scope_ids(
        model.metamodel, model, Scope(criteria=[_exists(), _contains("q")])
    ) == []


def test_typed_scope_dedupes_overlapping_types_and_sorts() -> None:
    model = _unsorted_model()
    mm = model.metamodel
    # Node ⊇ Sensor: naming both must not duplicate the sensors.
    assert _scope_ids(mm, model, Scope(types=["Sensor", "Node"])) == ["a", "m", "z"]
    assert _scope_ids(mm, model, Scope(types=["Sensor"])) == ["a", "m"]
    assert _scope_ids(mm, model, Scope(types=["Sensor"], criteria=[_exists()])) == ["a"]
    assert _scope_ids(mm, model, Scope(types=["Nope"])) == []


def test_empty_model() -> None:
    model = Model(_mm())
    assert _scope_ids(model.metamodel, model, Scope()) == []
    assert _scope_ids(model.metamodel, model, Scope(criteria=[_exists()])) == []
    assert _scope_ids(model.metamodel, model, Scope(types=["Node"])) == []


def test_evaluate_untyped_start_yields_chains_in_id_order() -> None:
    model = _unsorted_model()
    defn = PathNavigation(kind="path", start=Scope(), steps=[])
    result = evaluate(model.metamodel, model, defn)
    assert result.chains == [("a",), ("m",), ("z",)]


def test_differential_against_set_based_derivation() -> None:
    rnd = random.Random(24)
    model = Model(_mm())
    mm = model.metamodel
    ids = [f"{rnd.getrandbits(32):08x}" for _ in range(300)]
    rnd.shuffle(ids)  # insertion order uncorrelated with id order
    for eid in ids:
        el = model.restore_element(eid, rnd.choice(["Building", "Sensor"]))
        if rnd.random() < 0.8:
            model.set_property(
                el, "name", "".join(rnd.choice("abcde ") for _ in range(6))
            )
    assert list(model.elements) != sorted(model.elements)
    type_choices: list[list[str]] = [
        [], ["Node"], ["Building"], ["Sensor"], ["Building", "Node"], ["Sensor", "Building"],
    ]
    criteria_choices: list[list[Criterion]] = [
        [], [_exists()], [_contains("a")], [_contains("a"), _contains("e")], [_contains("zz")],
    ]
    for types in type_choices:
        for criteria in criteria_choices:
            scope = Scope(types=types, criteria=criteria)
            assert _scope_ids(mm, model, scope) == _reference(mm, model, scope), (
                types,
                criteria,
            )
```

- [ ] **Step 2: Run the tests to verify the state of the tree**

Run: `pixi run -e core-dev pytest tests/navigation/test_scope_ids.py -v`
Expected: all six PASS already — the current implementation is correct; these tests pin the contract so Step 3 cannot change it. (If any fails, stop: the test, not the code, is wrong.)

- [ ] **Step 3: Rewrite `_scope_ids`**

Replace `src/data_rover/core/navigation/evaluate.py:237-245` (the whole `_scope_ids` function) with:

```python
def _scope_ids(metamodel: Metamodel, model: Model, scope: Scope) -> list[str]:
    """Ascending-id list of the elements a scope selects.

    The untyped branch walks `model.elements` in insertion order instead of
    through an id set: ids minted in order (UUIDv7, sequential import ids)
    hand `sorted` a presorted run, so the sort is O(n) comparisons on such a
    model and never worse than a set's hash order on any other. An empty
    criteria list skips the matcher entirely.
    """
    if scope.types:
        by_type = model.indexes.elements_by_type
        typed: set[str] = set()
        for type_name in scope.types:
            for concrete in metamodel.element_descendants(type_name):
                typed |= by_type.get(concrete, set())
        if not scope.criteria:
            return sorted(typed)
        elements = model.elements
        return sorted(i for i in typed if _matches_criteria(model, elements[i], scope))
    if not scope.criteria:
        return sorted(model.elements)
    return sorted(
        e.id for e in model.elements.values() if _matches_criteria(model, e, scope)
    )
```

- [ ] **Step 4: Run the tests to verify they still pass**

Run: `pixi run -e core-dev pytest tests/navigation/test_scope_ids.py tests/navigation tests/table -q`
Expected: PASS, no change in counts.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/navigation/evaluate.py tests/navigation/test_scope_ids.py
git commit -m "perf(navigation): untyped scope walks model.elements in insertion order; empty criteria skip the matcher"
```

---

### Task 2: `_matches_criteria` / `_matches_filter` as plain loops

**Files:**
- Modify: `src/data_rover/core/navigation/evaluate.py:270-275` (`_matches_criteria`, `_matches_filter`)
- Test: `tests/navigation/test_scope_ids.py` (append)

**Interfaces:**
- Consumes: `_match_nav_criterion(model, element, criterion) -> bool` (unchanged).
- Produces: `_matches_criteria(model: Model, element: Element, scope: Scope) -> bool` and `_matches_filter(model: Model, element: Element, step: FilterStep) -> bool` — same names, signatures and truth table (`True` for an empty list; `False` at the first failing criterion).

- [ ] **Step 1: Append the failing-shape tests**

Append to `tests/navigation/test_scope_ids.py`:

```python
def test_matchers_truth_table() -> None:
    from data_rover.core.navigation.evaluate import _matches_criteria, _matches_filter
    from data_rover.core.navigation.schema import FilterStep

    model = _unsorted_model()
    named = model.elements["z"]
    unnamed = model.elements["m"]
    assert _matches_criteria(model, unnamed, Scope()) is True
    assert _matches_criteria(model, named, Scope(criteria=[_exists()])) is True
    assert _matches_criteria(model, unnamed, Scope(criteria=[_exists()])) is False
    assert _matches_criteria(model, named, Scope(criteria=[_exists(), _contains("q")])) is False
    assert _matches_criteria(model, named, Scope(criteria=[_contains("q"), _exists()])) is False
    assert _matches_criteria(model, named, Scope(criteria=[_exists(), _contains("z")])) is True
    assert _matches_filter(model, unnamed, FilterStep(criteria=[])) is True
    assert _matches_filter(model, named, FilterStep(criteria=[_contains("z")])) is True
    assert _matches_filter(model, named, FilterStep(criteria=[_contains("q"), _exists()])) is False


def test_matchers_stop_at_the_first_failing_criterion(monkeypatch: pytest.MonkeyPatch) -> None:
    import data_rover.core.navigation.evaluate as ev
    from data_rover.core.navigation.schema import FilterStep

    model = _unsorted_model()
    named = model.elements["z"]
    calls: list[str] = []
    real = ev._match_nav_criterion

    def counting(model, element, criterion):  # noqa: ANN001
        calls.append(getattr(criterion, "op", "?"))
        return real(model, element, criterion)

    monkeypatch.setattr(ev, "_match_nav_criterion", counting)
    scope = Scope(criteria=[_contains("q"), _exists(), _contains("z")])
    assert ev._matches_criteria(model, named, scope) is False
    assert calls == ["contains"]  # the two later criteria are never evaluated
    calls.clear()
    step = FilterStep(criteria=[_exists(), _contains("q"), _exists()])
    assert ev._matches_filter(model, named, step) is False
    assert calls == ["exists", "contains"]
```

(Add `import pytest` at the top of the file, after `import random`.)

- [ ] **Step 2: Run to verify they pass on the current implementation**

Run: `pixi run -e core-dev pytest tests/navigation/test_scope_ids.py -v`
Expected: PASS (these pin the truth table before the rewrite).

- [ ] **Step 3: Rewrite the two helpers**

Replace `src/data_rover/core/navigation/evaluate.py:270-275` (both functions) with:

```python
def _matches_criteria(model: Model, element: Element, scope: Scope) -> bool:
    for c in scope.criteria:
        if not _match_nav_criterion(model, element, c):
            return False
    return True


def _matches_filter(model: Model, element: Element, step: FilterStep) -> bool:
    for c in step.criteria:
        if not _match_nav_criterion(model, element, c):
            return False
    return True
```

- [ ] **Step 4: Run the navigation and table suites**

Run: `pixi run -e core-dev pytest tests/navigation tests/table -q`
Expected: PASS, no change in counts.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/navigation/evaluate.py tests/navigation/test_scope_ids.py
git commit -m "perf(navigation): scope and filter matchers are plain loops over the criteria list"
```

---

### Task 3: Measure at scale 320

**Files:** none in the repo (the script and its output live in the session scratchpad). Output: numbers for Task 4's BACKLOG entry and Task 5's merge commit.

**Interfaces:**
- Consumes: Tasks 1–2 through the real core (`build_model_from_dicts`, `_scope_ids`, `_match_nav_criterion`).
- Produces: `$SCRATCH/k24-numbers.md` with: untyped no-criteria (ms); untyped + one `exists` criterion (ms); typed `Person` no-criteria (ms); typed `Person` + one criterion (ms); the shuffled-insertion-order untyped no-criteria line (ms); the correctness line. Compared against the spec's § "K-24 design" table ("Today" column: 465 / 762 / 45 ms).

- [ ] **Step 1: Locate or generate the production-scale fixture (~1 min; skip if it exists)**

The fixture may still be at `/tmp/claude-1000/-home-mdp-workspace-data-rover-py/4cabd46f-abde-4fbc-becd-17dee88a1256/scratchpad/prod.model.json` (320,640 el / 238,720 rel); if it is gone:

```bash
export SCRATCH=<the session scratchpad directory from the system prompt>
pixi run -e core-dev python examples/generate_large_model.py --scale 320 --out "$SCRATCH/prod.model.json"
```

- [ ] **Step 2: Time the paths and check against the set-based derivation**

Write `$SCRATCH/measure_k24.py` (single file; run with a plain `pixi run -e core-dev python "$SCRATCH/measure_k24.py" <fixture path>` from the repo root; ~1 minute):

```python
"""K-24 measurement at scale 320: scope id resolution, ordered and shuffled insertion order."""

from __future__ import annotations

import json
import random
import sys
import time

sys.path.insert(0, "src")

from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_str  # noqa: E402
from data_rover.core.navigation.evaluate import _match_nav_criterion, _scope_ids  # noqa: E402
from data_rover.core.navigation.schema import Scope  # noqa: E402
from data_rover.core.search.criteria import PropertyCriterion  # noqa: E402

FIXTURE = sys.argv[1]
mm = load_metamodel_str(open("examples/smart-city.metamodel.yaml").read())
doc = json.loads(open(FIXTURE).read())
t0 = time.perf_counter()
model = build_model_from_dicts(mm, doc)
print(f"load+build {time.perf_counter() - t0:.1f}s  {len(model.elements)} el / {len(model.relationships)} rel")
assert list(model.elements) == sorted(model.elements), "fixture ids are sequential: insertion order == id order"


def best_ms(fn, n=3):
    ts = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        ts.append(time.perf_counter() - t0)
    return min(ts) * 1e3


def reference(mm, model, scope):
    if scope.types:
        ids: set[str] = set()
        for t in scope.types:
            for c in mm.element_descendants(t):
                ids |= model.indexes.elements_by_type.get(c, set())
    else:
        ids = set(model.elements.keys())
    return sorted(
        i for i in ids
        if all(_match_nav_criterion(model, model.elements[i], c) for c in scope.criteria)
    )


exists = PropertyCriterion(type="property", name="name", op="exists")
contains = PropertyCriterion(type="property", name="description", op="contains", value="a")
untyped = Scope()
untyped1 = Scope(criteria=[exists])
person = Scope(types=["Person"])
person1 = Scope(types=["Person"], criteria=[exists])

u0 = best_ms(lambda: _scope_ids(mm, model, untyped))
u1 = best_ms(lambda: _scope_ids(mm, model, untyped1))
p0 = best_ms(lambda: _scope_ids(mm, model, person))
p1 = best_ms(lambda: _scope_ids(mm, model, person1))

# a model whose insertion order is uncorrelated with id order (the degraded case)
rnd = random.Random(24)
shuffled = dict(doc)
els = list(doc["elements"])
rnd.shuffle(els)
shuffled["elements"] = els
model_s = build_model_from_dicts(mm, shuffled)
assert list(model_s.elements) != sorted(model_s.elements)
s0 = best_ms(lambda: _scope_ids(mm, model_s, untyped))

# correctness: every scope shape on both models against the set-based derivation
diffs = 0
checked = 0
for m in (model, model_s):
    for types in ([], ["Person"], ["Microservice", "Person"], ["DataEntity"], ["Nope"]):
        for criteria in ([], [exists], [contains], [exists, contains]):
            scope = Scope(types=types, criteria=criteria)
            checked += 1
            if _scope_ids(mm, m, scope) != reference(mm, m, scope):
                diffs += 1
                print("DIFF", types, [c.op for c in criteria])

print()
print(f"untyped, no criteria: {u0:.1f} ms")
print(f"untyped + one exists criterion: {u1:.1f} ms")
print(f"typed Person ({len(model.indexes.elements_by_type['Person'])} el), no criteria: {p0:.1f} ms")
print(f"typed Person + one exists criterion: {p1:.1f} ms")
print(f"untyped, no criteria, SHUFFLED insertion order: {s0:.1f} ms")
print(f"correctness: {diffs} of {checked} scopes differ from the set-based derivation")
```

- [ ] **Step 3: Record and compare**

Write the printed lines into `$SCRATCH/k24-numbers.md` next to the spec's spike table. Stop conditions (any miss → do NOT proceed to Task 4; report the numbers and investigate):
- untyped, no criteria **≤ 40 ms** (spec prototype 24 ms; today 465 ms);
- untyped + one criterion **≤ 330 ms** (spec prototype 283 ms; today 762 ms);
- typed `Person`, no criteria **≤ 25 ms** (spec ~14 ms; today 45 ms);
- shuffled insertion order, untyped, no criteria **≤ 200 ms** (spec: a shuffled sort is ~131 ms and today's set-ordered one 165 ms — the degraded case must never be worse than today);
- correctness **0 of 40** differ.

---

### Task 4: Docs and backlog

**Files:**
- Modify: `CLAUDE.md:194` (insert a new bullet AFTER the `Per-pass navigation memo` bullet)
- Modify: `BACKLOG.md:1079-1082` (`### K-24`) and the header paragraph at `BACKLOG.md:64-65`

**Interfaces:** none — prose only. Fill every `<…>` placeholder from `$SCRATCH/k24-numbers.md` (Task 3).

- [ ] **Step 1: CLAUDE.md**

After the bullet that begins `- **Per-pass navigation memo (\`core/table/nav_memo.py\`)**` (line 194, one paragraph), insert this bullet:

```markdown
- **Scope row sources (`core/navigation/evaluate.py::_scope_ids`)** — the ids a `Scope` selects (every `ScopeRows` table's rows, every `Scope`-started navigation's starts; paid once per table per commit through `TableOrderCache`) come back SORTED by id — the evaluator's "depth-first over SORTED element ids" paging-determinism contract, deliberately not insertion order. The untyped branch walks `model.elements` in insertion order and never builds an id set: production ids are time-ordered UUIDv7 and the importer's are sequential, so `sorted` sees a presorted run and finishes in O(n) comparisons (~24 ms at 320k elements), and an empty criteria list skips the matcher entirely. Never route it back through a `set` — the hash order is what makes the sort O(n log n).
```

- [ ] **Step 2: BACKLOG.md**

In the header paragraph, after the line pair ending `... closes K-23 (the per-property search-index\ndiff and cold-element ownership; see its entry for the numbers).`, append:

```markdown
The 2026-08-27 pass on `perf/untyped-navigation-scope` closes K-24 (the untyped scope walks
`model.elements` in insertion order; see its entry for the numbers).
```

Replace the `### K-24` heading and paragraph with:

```markdown
### K-24 · Untyped navigation scope sorts every element id · `done` (2026-08-27, perf/untyped-navigation-scope) · perf · *2026-08-26*
`core/navigation/evaluate.py::_scope_ids` built `set(model.elements.keys())`, re-looked every id
up for a criteria filter that ran `all(())` even with no criteria, and `sorted()` the hash-ordered
survivors — once per table per commit (`TableOrderCache` is rev-keyed). The spike put the set at
pure loss: 48 ms to build, a per-id lookup, and a real O(n log n) sort (172 ms) where the dict's
own insertion order is a presorted run (production ids are UUIDv7, the importer's sequential).
Now the untyped branch walks `model.elements.values()`, an empty criteria list short-circuits
to `sorted(...)` in both branches, and the two matchers are plain loops; the result stays the
ascending-id list (row order and paging byte-identical — returning insertion order was decided
against, see the spec's non-goals). Measured at scale 320 (320,640 elements): untyped no-criteria
**465 → <u0> ms**, untyped + one criterion **762 → <u1> ms**, typed `Person` (51,200 el)
45 → <p0> ms; a shuffled insertion order (the degraded case) <s0> ms; 0 of 40 scope shapes
differ from the set-based derivation on both the ordered and the shuffled model.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md BACKLOG.md
git commit -m "docs: untyped navigation scope — CLAUDE.md scope-source note, backlog (K-24 done)"
```

---

### Task 5: Full verification and integration

**Files:** none new.

- [ ] **Step 1: Lint/format/typecheck**

Run: `pixi run dr-tidy`
Expected: ruff, mypy, pyright, prettier and eslint all pass. Likely fixes: ruff reformatting a long `assert` line in the new tests (e.g. the `Scope(types=["Sensor"], criteria=[_exists()])` line) or the `type_choices` literal. Amend into the relevant commit or add a `chore:` commit.

- [ ] **Step 2: Whole suites**

Run: `pixi run core-test`
Expected: PASS, count = the `main` baseline recorded at branch creation (2280 passed / 31 deselected as of the K-23 merge) + 8 new tests (Task 1: 6, Task 2: 2), zero new skips.

Run: `pixi run frontend-test`
Expected: PASS (no frontend files changed; this proves it).

- [ ] **Step 3: Re-run the Task 3 measurement on the final tree**

Run: `pixi run -e core-dev python "$SCRATCH/measure_k24.py" "$FIXTURE"`
Expected: numbers within noise of Task 3's; the correctness line unchanged.

- [ ] **Step 4: Integrate**

Use `superpowers:finishing-a-development-branch`: `ExitWorktree keep`, re-check `git log --oneline origin/main -3` (a concurrent session may have moved `main`), merge `perf/untyped-navigation-scope` into `main` with a merge commit whose body carries the Task 3 numbers, run `pixi run core-test` on the merged result, push `main`, remove the worktree and delete the branch. The finishing skill's menu is answered by the standing policy (merge commit + push) when the user is absent. Leave `.claude/worktrees/feat-metamodel-diagram-editor` alone — it belongs to someone else.

---

### Task 6: Hand off to the next plan (K-25 — `GET /model/relationships` is unpaged)

**Files:** none in the repo (the handoff lives in `~/.claude/handoffs/`).

- [ ] **Step 1: Reconstruct state**

Run: `git status --short`, `git branch --show-current`, `git log --oneline -5`, `pixi run core-test -q | tail -3` (as separate plain commands if the harness refuses the chain).

- [ ] **Step 2: Invoke the handoff skill**

Invoke `handoff` (the `Skill` tool, name `handoff`). Fill its sections with these facts (pointers, not payload):

- **Mission:** the large-model performance program from `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Program"); K-20, K-6, K-21, K-22, K-23 and K-24 are merged; the next session writes and executes the plan for **K-25**, the LAST item (`routes/relationships.py:19`: `GET /model/relationships` materializes all ~400k relationships into pydantic models with no `limit`/`offset`; `source_id`/`target_id` filters are already served by `IndexSet.outgoing_ids`/`incoming_ids`; no app caller — `frontend/src/lib/api/relationships.ts` is test-only — page it or delete it), then closes the program. "Done" = a § "K-25 design" section in the spec (Problem / Design / Non-goals; the page-vs-delete decision is the design's), a plan written, executed on a worktree branch, merged into `main` with a merge commit, pushed, and a closing handoff (or a program-complete note) delivered.
- **Orient First:** the spec above (§ "Program" item 7; § "K-24 design" as the freshest design-section shape); `BACKLOG.md` K-25; `src/data_rover/api/routes/relationships.py` (the route) and `routes/elements.py` (the PAGED element list it should mirror — its `limit`/`offset` contract and `ElementPageOut`); `src/data_rover/api/authz.py` (read-only GETs need no allowlist entry); `frontend/src/lib/api/relationships.ts` and its tests (the only caller — decide whether it goes with the route); `tests/api/test_relationships*.py`; this plan (`docs/superpowers/plans/2026-08-27-untyped-navigation-scope.md`) as the SHAPE to match; `CLAUDE.md`.
- **Standing Constraints:** K-24 (new): `_scope_ids` returns the ascending-id list — never insertion order — and the untyped branch must never go back through a `set`; the matchers are plain loops; `core/search/criteria.py` untouched. K-23 (`_trigrams_of` entry ⇔ indexed, `()` included; hooks never index a builder-owned element while `search_ready` is False; the per-value diff is exact only for plain strings with no list-valued `name` key); K-22 (`element_order` maintained by the two element hooks only; order-only semantics); K-21 (bytes-sniffing snapshot reader; `iter_model_json` stays the save contract); K-20 (no search index on transient models; `keep_search=True` only at the four rebind sites); K-6 (`entity_states` NULL = reconstruct); `Metamodel` immutable with lazily-built `_Caches`; per-entity validator hooks O(entity); `docs/` gitignored; pixi for everything; merge-commit integration + push; `pixi run frontend-install` before `dr-tidy` in a fresh worktree; worktree harness guard; ruff does NOT enforce import order; `main` can move — re-check before merge/push. SDD model choices: haiku for transcription tasks carrying literal code, sonnet for logic/measurement tasks and per-task reviews, the most capable model for the final review.
- **Known Issues, Not Yet Fixed:** the scope matcher's own cost (~0.8 µs per criterion per element in `_match_nav_criterion` → `match_element`; shared with `/model/search`, recorded in the K-24 non-goals); the ~11 µs per-write floor and the applier's ~15 µs per op; `_rekey`'s `_frozen(properties)` for keyless types (~8 µs); `on_element_deleted`'s redundant `_trigrams_of` write-then-pop (cosmetic); `ENTITY_STATES_MAX` is an entity-count cap (`api/commit_states.py:36`); snapshot blob GC (`content.py`); four tests call `schedule_periodic_snapshot` without `write_mutex`; `snapshot_job` can record a row ahead of `models.model_rev` after a legacy `touch_model()`; `scripts/bench.py:208` pyright note; the sweep's remaining ~33 ms per element chunk; `element_order` ~16 MiB resident per hydrated session.
- **Deferred — Do Not Do:** returning insertion order from `_scope_ids` (decided against, not deferred); a maintained sorted-id index; a per-rev cache of the untyped id list; a criterion-shaped fast path in the shared matcher; everything K-23/K-22/K-21/K-20/K-6 already deferred (a bulk `restore_element(..., properties=...)`, diffing refs/rekey/roots per property, the `zip` trigram idiom, per-field trigram storage, bypassing hooks under `search_ready=False`, folding the sequence number into `uniq_groups`, a sequence field on `Element`, the per-sweep position-map hoist, zstd, an `encoding` column, posting-set shrinking, `entity_states` backfill, journal-based `GET /commits/{rev}/model`).
- **Plan:** 1. Read the spec's § "Program" item 7 and `BACKLOG.md` K-25, then `routes/relationships.py`, `routes/elements.py`'s paging contract, `frontend/src/lib/api/relationships.ts` and its tests — establish that no production caller exists (grep the frontend and `scripts/`), and measure the route's cost at scale 320 through the test client. 2. Decide page-vs-delete in § "K-25 design" (Problem with the measurement / Design / Non-goals). 3. Write `docs/superpowers/plans/<date>-relationships-paging.md` with `superpowers:writing-plans` in this plan's shape. 4. Execute with `superpowers:subagent-driven-development` on `perf/relationships-paging`; pre-flight conflict scan as a table. 5. Verify + merge commit + push; then a closing handoff that records the program as complete (all seven items) with pointers to every design section and BACKLOG entry.
- **Open Questions:** none blocking. Record for the design: whether a paged route keeps the `source_id`/`target_id` filters (served by the adjacency index, so cheap) or the route is deleted together with its test-only client — the frontend never lists relationships globally.

- [ ] **Step 3: Deliver**

Reply exactly as the handoff skill prescribes: the file path, the one-line paste command, and the full handoff in one fenced block.
