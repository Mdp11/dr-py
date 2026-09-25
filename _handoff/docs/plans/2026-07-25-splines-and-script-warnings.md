# Randomized Splines + Structured Script Warnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shuffle the project-open flavor text so every line gets seen, and replace the dedupe-by-message script-warning channel with structured, correctly-counted warnings rendered by the client.

**Architecture:** Part 1 is a self-contained change to one frontend module: a pure Fisher–Yates helper plus an injectable RNG seam that keeps the module's existing "deterministic under fake timers" promise. Part 2 introduces a leaf core module (`core/script/warnings.py`) that aggregates warnings by `(code, detail)` instead of by rendered text; `ScriptEvalContext` composes it, the navigation/table call sites pass codes and counts, the API serializes objects, and a new pure frontend formatter owns every user-facing sentence.

**Tech Stack:** Python 3.14 (dataclasses, `enum.StrEnum`, PEP 604 unions), FastAPI + Pydantic v2, SvelteKit 5 (runes), Vitest + happy-dom, pytest.

## Global Constraints

- Everything runs through **pixi**. There is no global `python` or `node`.
- Python tests: `pixi run -e core-dev pytest <path>`. API tests need no database service.
- Frontend tests MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npx vitest run <path>'`.
- Lint/format/typecheck: `pixi run dr-tidy` (ruff + mypy + pyright + frontend). All three Python checkers must pass.
- Target Python is **3.14**: use `enum.StrEnum`, PEP 604 `X | Y`, and modern stdlib freely. Ruff's `UP` rules will rewrite anything that lags.
- This repo's code carries **dense docstrings explaining WHY invariants exist**. Preserve and extend that style — every new module, dataclass, and non-obvious branch in this plan gets a comment saying why, not what.
- `MAX_SCRIPT_WARNINGS` is **20** and after this change caps **distinct kinds**, not messages.
- Warning copy lives **client-side only**. No user-facing sentence may be added to Python.
- Spec: `docs/superpowers/specs/2026-07-25-splines-and-script-warnings-design.md`.

---

# Part 1 — Randomized splines

## Task 1: Pure shuffle + cycle helpers

**Files:**
- Modify: `frontend/src/lib/state/open-journey.ts:19-47`
- Test: `frontend/src/lib/state/__tests__/open-journey.test.ts`

**Interfaces:**
- Consumes: `SPLINES` (existing `readonly string[]`, 19 entries).
- Produces:
  - `cycleAt(list: readonly string[], index: number): string`
  - `shuffled(items: readonly string[], rand: () => number): string[]`
  - `splineAt(index: number): string` (unchanged behavior, now `cycleAt(SPLINES, index)`)

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/lib/state/__tests__/open-journey.test.ts`. Extend the existing import block at the top of the file to include `cycleAt` and `shuffled`:

```ts
import {
	SPLINES,
	splineAt,
	cycleAt,
	shuffled,
	easeToward,
	clampMonotonic,
	phaseSlice,
	statusToProgress
} from '../open-journey';
```

Then add these tests inside the existing `describe('open-journey pure helpers', ...)` block:

```ts
	it('cycleAt wraps over any list, tolerating negatives', () => {
		const list = ['a', 'b', 'c'];
		expect(cycleAt(list, 0)).toBe('a');
		expect(cycleAt(list, 3)).toBe('a');
		expect(cycleAt(list, 4)).toBe('b');
		expect(cycleAt(list, -1)).toBe('c');
	});

	// THE property the whole RNG seam rests on: the forward Fisher-Yates
	// variant degenerates to identity at rand()===0, which is what lets the
	// journey tests below keep their verbatim SPLINES[0]/SPLINES[1]
	// expectations. The conventional backward variant does NOT have this
	// property (it swaps out[i] with out[0]), so this test is load-bearing.
	it('shuffled with a zero rand is the identity permutation', () => {
		expect(shuffled(SPLINES, () => 0)).toEqual([...SPLINES]);
	});

	it('shuffled returns a permutation and never mutates the input', () => {
		const before = [...SPLINES];
		let n = 0;
		const out = shuffled(SPLINES, () => ((n = (n * 9301 + 49297) % 233280), n / 233280));
		expect(out).toHaveLength(SPLINES.length);
		expect([...out].sort()).toEqual([...SPLINES].sort());
		expect(SPLINES).toEqual(before);
	});

	// Math.random never returns exactly 1, but setSplineRandom is a public
	// seam, so a stub that does must not produce an out-of-range index.
	it('shuffled clamps a rand that returns 1', () => {
		const out = shuffled(SPLINES, () => 1);
		expect(out).toHaveLength(SPLINES.length);
		expect(out.every((s) => typeof s === 'string')).toBe(true);
		expect([...out].sort()).toEqual([...SPLINES].sort());
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/open-journey.test.ts'`

Expected: FAIL — `cycleAt` and `shuffled` are not exported from `../open-journey`.

- [ ] **Step 3: Implement the helpers**

In `frontend/src/lib/state/open-journey.ts`, replace the existing `splineAt` (lines 43-47):

```ts
/** Cycle the splines, wrapping (and tolerating negative indices). */
export function splineAt(index: number): string {
	const n = SPLINES.length;
	return SPLINES[((index % n) + n) % n];
}
```

with:

```ts
/** Wrap `index` over `list`, tolerating negative indices. */
export function cycleAt(list: readonly string[], index: number): string {
	const n = list.length;
	return list[((index % n) + n) % n];
}

/** Cycle the AUTHORED spline order, wrapping. The journey itself walks a
 * shuffled order (see `_order`); this stays for callers that want the
 * canonical sequence. */
export function splineAt(index: number): string {
	return cycleAt(SPLINES, index);
}

/** Fisher-Yates, FORWARD variant: `j` is drawn from `[i, n)` rather than
 * `[0, i]`.
 *
 * The direction is load-bearing, not stylistic. With `rand = () => 0` every
 * `j` equals `i`, so this returns the identity permutation — which is what
 * makes the RNG seam testable: a test installs a zero rand and the journey's
 * label sequence is exactly `SPLINES` again. The conventional backward
 * variant swaps `out[i]` with `out[0]` at every step and does NOT degenerate
 * to identity, so it could not carry that guarantee.
 *
 * The `Math.min` clamp guards a stub `rand` that returns exactly 1 —
 * `Math.random` never does, but `setSplineRandom` is public. */
export function shuffled(items: readonly string[], rand: () => number): string[] {
	const out = [...items];
	for (let i = 0; i < out.length - 1; i++) {
		const j = Math.min(out.length - 1, i + Math.floor(rand() * (out.length - i)));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/open-journey.test.ts'`

Expected: PASS — all pure-helper tests, including the pre-existing `splineAt` wrap test which must still pass untouched.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/open-journey.ts frontend/src/lib/state/__tests__/open-journey.test.ts
git commit -m "feat(frontend/journey): cycleAt + identity-at-zero shuffled helpers"
```

---

## Task 2: Shuffle the journey's spline order

**Files:**
- Modify: `frontend/src/lib/state/open-journey.ts` (module header comment, module state, `_onSplineTick`, `beginJourney`, `_stop`)
- Test: `frontend/src/lib/state/__tests__/open-journey.test.ts`

**Interfaces:**
- Consumes: `shuffled`, `cycleAt` from Task 1.
- Produces: `setSplineRandom(fn: () => number): void` — test seam installing the RNG. Deliberately NOT reset by `resetJourney()`.

- [ ] **Step 1: Write the failing tests**

Add `setSplineRandom` to the test file's import block from `../open-journey`.

The existing journey tests assert `SPLINES[0]` and `SPLINES[1]` (around lines 92-96 and 167-173). Find the `describe` block containing them and add a `beforeEach` that installs the identity rand, so those assertions keep standing verbatim:

```ts
	beforeEach(() => {
		// Identity permutation — see `shuffled`'s docstring. Keeps every
		// SPLINES[n] expectation in this block literally true.
		setSplineRandom(() => 0);
	});
```

Make sure `beforeEach` is in the `vitest` import at the top of the file.

Then add these new tests to the same journey `describe` block (they use the same fake-timer setup the neighbouring tests use — copy the surrounding `beginJourney(...)` idiom from the existing `rotates the spline label on the spline ticker` test):

```ts
	it('walks all 19 distinct lines before repeating any', () => {
		// A rotating rand: each draw picks the LAST candidate in the remaining
		// window, so the order is a real permutation, not the identity.
		setSplineRandom(() => 0.999);
		beginJourney('open');
		const seen = [getActiveProgress()?.label];
		for (let i = 1; i < SPLINES.length; i++) {
			vi.advanceTimersByTime(4200);
			seen.push(getActiveProgress()?.label);
		}
		expect(new Set(seen).size).toBe(SPLINES.length);
		expect([...seen].sort()).toEqual([...SPLINES].sort());
	});

	it('re-shuffles on wrap instead of replaying the same permutation', () => {
		// A rand that changes between the two shuffles, so a replay of the
		// first permutation is distinguishable from a fresh one.
		let call = 0;
		setSplineRandom(() => (call++ % 2 === 0 ? 0 : 0.999));
		beginJourney('open');
		const first: (string | undefined)[] = [getActiveProgress()?.label];
		for (let i = 1; i < SPLINES.length; i++) {
			vi.advanceTimersByTime(4200);
			first.push(getActiveProgress()?.label);
		}
		// Tick 19 wraps: a fresh shuffle must be in effect.
		vi.advanceTimersByTime(4200);
		const afterWrap = getActiveProgress()?.label;
		const second: (string | undefined)[] = [afterWrap];
		for (let i = 1; i < SPLINES.length; i++) {
			vi.advanceTimersByTime(4200);
			second.push(getActiveProgress()?.label);
		}
		expect(second).not.toEqual(first);
		expect([...second].sort()).toEqual([...SPLINES].sort());
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/open-journey.test.ts'`

Expected: FAIL — `setSplineRandom` is not exported; the two new tests fail because the journey still walks the authored order.

- [ ] **Step 3: Implement the shuffle wiring**

3a. Update the module header (lines 4-7) so the determinism promise stays honest — the controller still calls no `Math.random()` of its own, it reads an injectable source:

```ts
 * fraction. The controller (added below) contains no Date.now() and no direct
 * Math.random() call: elapsed time is accumulated from the ticker interval,
 * and randomness comes from the injectable `_rand` seam (default
 * `Math.random`, overridable via `setSplineRandom`) — so the store stays
 * deterministic under fake timers. This file is the whole journey unit.
```

3b. Update the `SPLINES` doc comment (lines 19-20) — the "Fixed order" claim is about to become false:

```ts
/** Reticulating splines — pure flavor text; the bar tells the real story.
 * SHUFFLED once per journey (see `_order`) so every line gets a turn and no
 * two opens read the same; a typical open only shows the first few, which is
 * why a fixed order meant lines past the fourth were never seen. Verbatim per
 * product copy. */
```

3c. Add the RNG seam next to the other module state (after the `let _splineIndex = 0;` declaration around line 126):

```ts
// Randomness seam. Production uses Math.random; tests install a scripted
// source. Deliberately NOT reset by `_stop()`/`resetJourney()`: a test
// installs it once in `beforeEach` and it must survive the teardown that
// runs in `afterEach`.
let _rand: () => number = Math.random;
/** Test seam: install the RNG backing the per-journey spline shuffle. */
export function setSplineRandom(fn: () => number): void {
	_rand = fn;
}
// The shuffled spline order for the CURRENT journey. Defaults to the authored
// order so a label read before beginJourney is still a real line.
let _order: readonly string[] = SPLINES;
```

3d. In `_stop()` (after `_splineIndex = 0;` around line 203) add:

```ts
	_order = SPLINES;
```

3e. In `_onSplineTick()` (lines 226-230) replace the body:

```ts
function _onSplineTick(): void {
	if (!_active || _token === null) return;
	_splineIndex += 1;
	// A full pass through the shuffle: draw a fresh permutation rather than
	// replaying the same one. 19 lines x 4.2s is ~80s, so only a very slow
	// open ever gets here — but when it does, a repeat would be the exact
	// monotony this shuffle exists to remove.
	if (_splineIndex % _order.length === 0) _order = shuffled(SPLINES, _rand);
	setProgressLabel(_token, cycleAt(_order, _splineIndex));
}
```

3f. In `beginJourney()` replace `_splineIndex = 0;` (line 245) with:

```ts
	_splineIndex = 0;
	_order = shuffled(SPLINES, _rand);
```

and replace `_token = startProgress(splineAt(0));` (line 251) with:

```ts
	_token = startProgress(cycleAt(_order, 0));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/open-journey.test.ts'`

Expected: PASS — new shuffle tests plus every pre-existing journey test.

- [ ] **Step 5: Typecheck and commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/state/open-journey.ts frontend/src/lib/state/__tests__/open-journey.test.ts
git commit -m "feat(frontend/journey): shuffle splines per journey so every line gets seen"
```

---

# Part 2 — Structured script warnings

## Task 3: The `ScriptWarningLog` leaf module

Nothing else is touched in this task, so the whole suite stays green.

**Files:**
- Create: `src/data_rover/core/script/warnings.py`
- Test: `tests/script/test_warnings.py`

**Interfaces:**
- Produces:
  - `ScriptWarningCode(StrEnum)` with members `NAV_SNIPPET_NOT_FOUND = "nav_snippet_not_found"`, `NAV_STEP_FAILED = "nav_step_failed"`, `NAV_UNKNOWN_IDS = "nav_unknown_ids"`, `NAV_ALREADY_VISITED = "nav_already_visited"`, `SORT_NEEDS_SCRIPT_NAV = "sort_needs_script_nav"`
  - `ScriptWarning` dataclass: `code: ScriptWarningCode`, `occurrences: int = 0`, `total: int = 0`, `detail: str | None = None`
  - `WarningKey = tuple[ScriptWarningCode, str | None]`
  - `MAX_SCRIPT_WARNINGS: int = 20`
  - `ScriptWarningLog` with `add(code, *, detail=None, count=0) -> None`, `entries` property `-> list[ScriptWarning]`, `snapshot() -> dict[WarningKey, tuple[int, int]]`, `since(snap) -> list[ScriptWarning]`

- [ ] **Step 1: Write the failing test**

Create `tests/script/test_warnings.py`:

```python
"""The warnings channel aggregates by KIND, not by rendered text.

The bug these tests pin: the old channel deduped on the exact message string
while three of the four navigation warnings baked their count INTO that
string, so ten chains each dropping one id collapsed to a single line reading
"1". Every count assertion below is that bug, stated as an expectation.
"""

from data_rover.core.script.warnings import (
    MAX_SCRIPT_WARNINGS,
    ScriptWarning,
    ScriptWarningCode,
    ScriptWarningLog,
)


def test_repeated_kind_aggregates_occurrences_and_total() -> None:
    log = ScriptWarningLog()
    for _ in range(10):
        log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=1)
    assert log.entries == [
        ScriptWarning(code=ScriptWarningCode.NAV_UNKNOWN_IDS, occurrences=10, total=10)
    ]


def test_differing_counts_sum_into_one_entry() -> None:
    # Previously these were THREE near-identical lines saying 1, 2 and 5.
    log = ScriptWarningLog()
    for n in (1, 2, 5):
        log.add(ScriptWarningCode.NAV_ALREADY_VISITED, count=n)
    (entry,) = log.entries
    assert (entry.occurrences, entry.total) == (3, 8)


def test_distinct_details_stay_distinct_entries() -> None:
    log = ScriptWarningLog()
    log.add(ScriptWarningCode.NAV_STEP_FAILED, detail="boom")
    log.add(ScriptWarningCode.NAV_STEP_FAILED, detail="boom")
    log.add(ScriptWarningCode.NAV_STEP_FAILED, detail="kaboom")
    assert [(e.detail, e.occurrences) for e in log.entries] == [("boom", 2), ("kaboom", 1)]


def test_entries_are_in_first_seen_order() -> None:
    log = ScriptWarningLog()
    log.add(ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV)
    log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=3)
    log.add(ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV)
    assert [e.code for e in log.entries] == [
        ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV,
        ScriptWarningCode.NAV_UNKNOWN_IDS,
    ]


def test_cap_drops_new_kinds_but_keeps_counting_known_ones() -> None:
    # The old cap stopped recording entirely, which understated the very
    # numbers this channel exists to report.
    log = ScriptWarningLog()
    for i in range(MAX_SCRIPT_WARNINGS):
        log.add(ScriptWarningCode.NAV_STEP_FAILED, detail=f"err-{i}")
    log.add(ScriptWarningCode.NAV_STEP_FAILED, detail="overflow")
    log.add(ScriptWarningCode.NAV_STEP_FAILED, detail="err-0")
    assert len(log.entries) == MAX_SCRIPT_WARNINGS
    assert all(e.detail != "overflow" for e in log.entries)
    assert log.entries[0].occurrences == 2


def test_since_returns_deltas_not_absolutes() -> None:
    log = ScriptWarningLog()
    log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=4)
    snap = log.snapshot()
    log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=3)
    log.add(ScriptWarningCode.NAV_ALREADY_VISITED, count=1)
    assert log.since(snap) == [
        ScriptWarning(code=ScriptWarningCode.NAV_UNKNOWN_IDS, occurrences=1, total=3),
        ScriptWarning(code=ScriptWarningCode.NAV_ALREADY_VISITED, occurrences=1, total=1),
    ]


def test_since_an_empty_snapshot_is_everything() -> None:
    log = ScriptWarningLog()
    snap = log.snapshot()
    log.add(ScriptWarningCode.NAV_SNIPPET_NOT_FOUND, detail="missing")
    assert log.since(snap) == log.entries


def test_since_omits_untouched_kinds() -> None:
    log = ScriptWarningLog()
    log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=2)
    snap = log.snapshot()
    assert log.since(snap) == []


def test_code_is_a_plain_string_on_the_wire() -> None:
    # Serialized straight into JSON by the API layer.
    assert ScriptWarningCode.NAV_UNKNOWN_IDS == "nav_unknown_ids"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/script/test_warnings.py -v`

Expected: FAIL — `ModuleNotFoundError: No module named 'data_rover.core.script.warnings'`.

- [ ] **Step 3: Implement the module**

Create `src/data_rover/core/script/warnings.py`:

```python
"""The embedded-evaluation warnings channel: structured, aggregated by KIND.

Table and navigation evaluation degrade rather than fail — a snippet that
raises prunes its chains, an unknown returned id is dropped — and this channel
is how the user is told. It is deliberately DATA, not prose: every entry is a
code plus counts, and the user-facing sentence is built client-side.

That split is the fix for the channel's original defect. It deduped on the
rendered message text while the navigation messages baked their counts INTO
that text, so ten chains each dropping one id emitted ten identical strings,
collapsed to a single line reading "1" — the user was told 1 when the truth
was 10 — and chains dropping 1, 2 and 5 fragmented into three near-identical
lines that also ate the cap. Aggregating by `(code, detail)` and carrying the
numbers separately makes both cases come out right, and leaves the copy in one
place (the client) instead of scattered across f-strings.

This module is deliberately a LEAF: it imports nothing from the rest of the
core, so `navigation` and `table` can import the codes at runtime with no risk
of an import cycle through `embed`.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

#: Cap on DISTINCT KINDS held at once (see `ScriptWarningLog.add`).
MAX_SCRIPT_WARNINGS = 20


class ScriptWarningCode(StrEnum):
    """The closed set of degradations this channel reports.

    Values are the wire form. Adding a member is a client-compatible change:
    the frontend formatter falls back to the raw detail/code for a code it
    does not recognize, so an older client renders something readable rather
    than a blank strip.
    """

    NAV_SNIPPET_NOT_FOUND = "nav_snippet_not_found"
    NAV_STEP_FAILED = "nav_step_failed"
    NAV_UNKNOWN_IDS = "nav_unknown_ids"
    NAV_ALREADY_VISITED = "nav_already_visited"
    SORT_NEEDS_SCRIPT_NAV = "sort_needs_script_nav"


#: Aggregation key. `detail` participates so two genuinely different failures
#: (two distinct exception messages) stay two distinct entries.
type WarningKey = tuple[ScriptWarningCode, str | None]


@dataclass
class ScriptWarning:
    """One aggregated warning kind.

    `occurrences` counts how many times the kind fired; `total` sums the
    subject quantity it carries (ids returned unknown, elements dropped) and
    stays 0 for kinds that have no such quantity. Both are needed: "42 ids
    across 17 calls" and "42 ids in 1 call" are different stories.
    """

    code: ScriptWarningCode
    occurrences: int = 0
    total: int = 0
    detail: str | None = None

    @property
    def key(self) -> WarningKey:
        return (self.code, self.detail)


class ScriptWarningLog:
    """Insertion-ordered aggregate of `ScriptWarning`s, keyed by kind."""

    def __init__(self) -> None:
        self._by_key: dict[WarningKey, ScriptWarning] = {}

    @property
    def entries(self) -> list[ScriptWarning]:
        """The aggregate, in first-seen order. A fresh list per call — callers
        must not rely on mutating it."""
        return list(self._by_key.values())

    def add(
        self,
        code: ScriptWarningCode,
        *,
        detail: str | None = None,
        count: int = 0,
    ) -> None:
        """Record ONE occurrence of `code` (optionally carrying `count`
        subjects).

        `MAX_SCRIPT_WARNINGS` caps distinct KINDS. Once full, a new kind is
        dropped but kinds already present keep counting — a cap that stopped
        counting would understate exactly the numbers this channel exists to
        report. Overflow is far less likely than under the old text dedup:
        keys are now bounded by 5 codes times distinct details, and only
        `NAV_STEP_FAILED` / `NAV_SNIPPET_NOT_FOUND` carry unbounded details.
        """
        key = (code, detail)
        entry = self._by_key.get(key)
        if entry is None:
            if len(self._by_key) >= MAX_SCRIPT_WARNINGS:
                return
            entry = ScriptWarning(code=code, detail=detail)
            self._by_key[key] = entry
        entry.occurrences += 1
        entry.total += count

    def snapshot(self) -> dict[WarningKey, tuple[int, int]]:
        """Freeze the current counts, for a later `since()`.

        Needed because entries mutate IN PLACE: `navigation.evaluate` used to
        slice `warnings[w0:]` to return only its own call's warnings, and an
        index slice cannot see growth in an entry that already existed.
        """
        return {k: (w.occurrences, w.total) for k, w in self._by_key.items()}

    def since(self, snap: dict[WarningKey, tuple[int, int]]) -> list[ScriptWarning]:
        """What was added since `snap`, as DELTA counts, in first-seen order."""
        out: list[ScriptWarning] = []
        for key, w in self._by_key.items():
            occ0, tot0 = snap.get(key, (0, 0))
            if w.occurrences > occ0:
                out.append(
                    ScriptWarning(
                        code=w.code,
                        occurrences=w.occurrences - occ0,
                        total=w.total - tot0,
                        detail=w.detail,
                    )
                )
        return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/script/test_warnings.py -v`

Expected: PASS — all 9 tests.

- [ ] **Step 5: Lint and commit**

```bash
pixi run core-lint
git add src/data_rover/core/script/warnings.py tests/script/test_warnings.py
git commit -m "feat(core/script): ScriptWarningLog aggregating warnings by kind"
```

---

## Task 4: Adopt the log in `ScriptEvalContext` and migrate every call site

The `add_warning` signature changes, so the context and all four call sites move
together — a split here would leave the suite red between commits.

**Files:**
- Modify: `src/data_rover/core/script/embed.py:65` (drop the local `MAX_SCRIPT_WARNINGS`), `:91-92` (state), `:202-206` (`add_warning`)
- Modify: `src/data_rover/core/navigation/evaluate.py:53` (import), `:78-89` (`ChainResult`), `:126`, `:141`, `:175` (snapshot/since), `:355`, `:363`, `:371`, `:435` (call sites)
- Modify: `src/data_rover/core/table/evaluate.py:602-606` (delete `SORT_SCRIPT_NAV_WARNING`), `:688` (comment), `:741` (call site)
- Modify: `src/data_rover/api/routes/tables.py:32` (import), `:292` (call site)
- Modify: `src/data_rover/core/script/README.md:419-422`, `:667`
- Test: `tests/navigation/test_script_step.py`, `tests/table/test_script_column.py`

**Interfaces:**
- Consumes: `ScriptWarningCode`, `ScriptWarning`, `ScriptWarningLog`, `MAX_SCRIPT_WARNINGS` from Task 3.
- Produces:
  - `ScriptEvalContext.add_warning(code: ScriptWarningCode, *, detail: str | None = None, count: int = 0) -> None`
  - `ScriptEvalContext.warnings -> list[ScriptWarning]` (property)
  - `ScriptEvalContext.warning_snapshot() -> dict[WarningKey, tuple[int, int]]`
  - `ScriptEvalContext.warnings_since(snap) -> list[ScriptWarning]`
  - `ChainResult.warnings: list[ScriptWarning]`

- [ ] **Step 1: Write the failing tests**

Rewrite the warning assertions in `tests/navigation/test_script_step.py`. Add the import at the top of the file:

```python
from data_rover.core.script.warnings import ScriptWarning, ScriptWarningCode
```

Replace the four existing assertions (lines 125, 135, 146, 169) with code-based ones:

```python
# was: assert any("boom" in w for w in res.warnings)
assert res.warnings == [
    ScriptWarning(
        code=ScriptWarningCode.NAV_STEP_FAILED,
        occurrences=1,
        detail=res.warnings[0].detail,
    )
]
assert "boom" in (res.warnings[0].detail or "")
```

```python
# was: assert any("unknown element id" in w for w in res.warnings)
assert res.warnings == [
    ScriptWarning(code=ScriptWarningCode.NAV_UNKNOWN_IDS, occurrences=1, total=1)
]
```

```python
# was: assert res.chains == [] and any("not found" in w for w in res.warnings)
assert res.chains == []
assert res.warnings == [
    ScriptWarning(
        code=ScriptWarningCode.NAV_SNIPPET_NOT_FOUND, occurrences=1, detail="missing"
    )
]
```

```python
# was: assert any("already visited" in w for w in res.warnings)
assert res.warnings == [
    ScriptWarning(
        code=ScriptWarningCode.NAV_ALREADY_VISITED,
        occurrences=res.warnings[0].occurrences,
        total=res.warnings[0].total,
    )
]
assert res.warnings[0].total >= 1
```

Then add the regression test this whole part exists for, at the end of the file:

```python
def test_unknown_ids_across_many_chains_sum_instead_of_collapsing() -> None:
    """THE BUG: each start element's step drops one unknown id, and the old
    dedup-by-message channel reported that as a single line reading "1"
    regardless of how many chains hit it. One entry is right; a total of 1 is
    not."""
    mm, model = _fixture()
    ids = sorted(model.elements)
    defn = _path([ScriptStep(
        snippet=_snip(f"def step(el): return ['{ids[0]}', 'no-such-id']")
    )])
    res = evaluate(mm, model, defn, script=_ctx(model))
    (entry,) = [w for w in res.warnings if w.code == ScriptWarningCode.NAV_UNKNOWN_IDS]
    assert entry.occurrences == len(ids)
    assert entry.total == len(ids)


def test_two_distinct_step_failures_stay_two_entries() -> None:
    mm, model = _fixture()
    ctx = _ctx(model)
    evaluate(mm, model, _path([ScriptStep(
        snippet=_snip("def step(el): raise RuntimeError('boom')")
    )]), script=ctx)
    evaluate(mm, model, _path([ScriptStep(
        snippet=_snip("def step(el): raise RuntimeError('kaboom')")
    )]), script=ctx)
    failures = [w for w in ctx.warnings if w.code == ScriptWarningCode.NAV_STEP_FAILED]
    assert len(failures) == 2


def test_chain_result_warnings_are_this_call_only() -> None:
    """`ChainResult.warnings` carries deltas: a second evaluate over a context
    that already logged the same kind must not re-report the first call's
    counts (the invariant `warnings[w0:]` slicing used to provide)."""
    mm, model = _fixture()
    ctx = _ctx(model)
    defn = _path([ScriptStep(snippet=_snip("def step(el): return [el]"))])
    first = evaluate(mm, model, defn, script=ctx)
    second = evaluate(mm, model, defn, script=ctx)
    assert first.warnings and second.warnings
    assert second.warnings[0].occurrences == first.warnings[0].occurrences
```

In `tests/table/test_script_column.py`, add the import and replace two assertions:

```python
from data_rover.core.script.warnings import ScriptWarningCode
```

```python
# line 495, was: assert any("script step failed" in w for w in ctx.warnings)
assert any(w.code == ScriptWarningCode.NAV_STEP_FAILED for w in ctx.warnings)
```

```python
# line 691, was: assert any("build order" in w for w in ctx.warnings)
assert any(w.code == ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV for w in ctx.warnings)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/navigation/test_script_step.py tests/table/test_script_column.py -v`

Expected: FAIL — `add_warning()` still takes a message string, so `res.warnings` holds `str`, not `ScriptWarning`.

- [ ] **Step 3: Implement**

3a. `src/data_rover/core/script/embed.py` — replace the `MAX_SCRIPT_WARNINGS = 20` line (`:65`) with a re-export so existing importers keep working:

```python
from .warnings import (
    MAX_SCRIPT_WARNINGS,
    ScriptWarning,
    ScriptWarningCode,
    ScriptWarningLog,
    WarningKey,
)

__all__ = [
    "MAX_SCRIPT_WARNINGS",
    "ScriptEvalContext",
    "ScriptWarning",
    "ScriptWarningCode",
    "ScriptWarningLog",
]
```

(place the import with the other relative imports at the top; delete the bare
`MAX_SCRIPT_WARNINGS = 20` constant.)

3b. In `__init__`, replace lines 91-92:

```python
        self.warnings: list[str] = []
        self._warning_set: set[str] = set()
```

with:

```python
        self._warning_log = ScriptWarningLog()
```

3c. Replace `add_warning` (`:202-206`) with the delegating trio:

```python
    @property
    def warnings(self) -> list[ScriptWarning]:
        """Aggregated warnings, first-seen order. See `ScriptWarningLog`."""
        return self._warning_log.entries

    def add_warning(
        self,
        code: ScriptWarningCode,
        *,
        detail: str | None = None,
        count: int = 0,
    ) -> None:
        """Record one occurrence of a degradation. Structured on purpose: the
        rendered sentence is built client-side, so counts aggregate instead of
        being frozen into a deduped string."""
        self._warning_log.add(code, detail=detail, count=count)

    def warning_snapshot(self) -> dict[WarningKey, tuple[int, int]]:
        return self._warning_log.snapshot()

    def warnings_since(self, snap: dict[WarningKey, tuple[int, int]]) -> list[ScriptWarning]:
        return self._warning_log.since(snap)
```

3d. `src/data_rover/core/navigation/evaluate.py` — the existing
`from ..script.embed import ScriptEvalContext` at `:53` is under
`TYPE_CHECKING`; leave it and add a RUNTIME import alongside the module's other
runtime imports (the codes are needed at call time, and `core.script.warnings`
is a leaf so there is no cycle):

```python
from ..script.warnings import ScriptWarning, ScriptWarningCode
```

Change `ChainResult.warnings` (`:89`) to:

```python
    warnings: list[ScriptWarning] = field(default_factory=list)
```

and update its docstring (`:82-84`) to say the warnings are aggregated
`ScriptWarning`s carrying THIS call's delta counts.

Replace `:126`:

```python
    w0 = script.warning_snapshot() if script is not None else {}
```

and both `:141` and `:175`:

```python
        warnings=script.warnings_since(w0) if script is not None else [],
```

Update `evaluate`'s docstring (`:122-124`) — "its shared warnings channel is
snapshotted at entry" stays true, but say the snapshot is a counts snapshot
diffed on exit, because entries mutate in place.

Replace the four call sites:

```python
# :355
            script.add_warning(
                ScriptWarningCode.NAV_SNIPPET_NOT_FOUND, detail=step.snippet.ref
            )
```

```python
# :363
        script.add_warning(
            ScriptWarningCode.NAV_STEP_FAILED, detail=res.error.message
        )
```

```python
# :371
        script.add_warning(
            ScriptWarningCode.NAV_UNKNOWN_IDS, count=len(raw) - len(known)
        )
```

```python
# :435
                script.add_warning(
                    ScriptWarningCode.NAV_ALREADY_VISITED, count=dropped
                )
```

Keep the surrounding explanatory comments (notably the "identity return is the
natural idiom" comment above `:435`) — they explain WHY the warning exists and
are still true.

3e. `src/data_rover/core/table/evaluate.py` — delete the
`SORT_SCRIPT_NAV_WARNING` constant (`:602-606`) and MOVE its rationale comment
(the block at `:596-601` explaining why the wording says "sorting by this
column needs" rather than "this column's navigation") into the frontend
formatter in Task 6 — that is where the wording now lives. Add the import:

```python
from ..script.warnings import ScriptWarningCode
```

Replace `:741`:

```python
    script.add_warning(ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV)
```

Update the docstring at `:688` — `(and emit SORT_SCRIPT_NAV_WARNING)` becomes
`(and emit ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV)`.

3f. `src/data_rover/api/routes/tables.py` — drop `SORT_SCRIPT_NAV_WARNING` from
the import at `:32`, add `from ...core.script.warnings import ScriptWarningCode`
with the other core imports, and replace `:292`:

```python
                    script_ctx.add_warning(ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV)
```

3g. `src/data_rover/core/script/README.md` — replace the `.warnings` /
`.add_warning` bullet at `:419-422`:

```markdown
- **`.warnings` / `.add_warning(code, *, detail=None, count=0)`** — the
  structured degradation channel (`core/script/warnings.py`). Entries are
  aggregated by `(code, detail)`, NOT by rendered text: `occurrences` counts
  firings and `total` sums the subject quantity, so ten chains each dropping
  one id report 10, not the "1" that dedup-by-message used to report. Capped
  at `MAX_SCRIPT_WARNINGS` (20) DISTINCT KINDS; a new kind past the cap is
  dropped, but kinds already present keep counting. User-facing copy lives
  client-side, keyed off `code`. `.warning_snapshot()` / `.warnings_since()`
  give a caller (navigation's `evaluate`) the delta produced by its own call.
```

and at `:667` replace `with SORT_SCRIPT_NAV_WARNING on the response` with
`with ScriptWarningCode.SORT_NEEDS_SCRIPT_NAV on the response`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pixi run -e core-dev pytest tests/script tests/navigation tests/table -v
```

Expected: PASS. If `tests/api` is red at this point that is expected — those are Task 5.

- [ ] **Step 5: Lint and commit**

```bash
pixi run core-lint
git add src/data_rover/core src/data_rover/api/routes/tables.py tests/navigation tests/table
git commit -m "refactor(core/script): structured warning codes replace deduped message strings"
```

---

## Task 5: Serialize `ScriptWarningOut` on both routes

**Files:**
- Modify: `src/data_rover/api/schemas.py:864` (`NavigationPreviewOut.warnings`), `:1010` (`TablePageOut.warnings`), plus a new `ScriptWarningOut` model
- Modify: `src/data_rover/api/routes/tables.py:464`
- Modify: `src/data_rover/api/routes/artifacts.py:319`
- Test: `tests/api/test_tables_nav_script.py`, `tests/api/test_script_embedding_routes.py`

**Interfaces:**
- Consumes: `ScriptWarning` from Task 3.
- Produces: `ScriptWarningOut` with `code: str`, `occurrences: int`, `total: int`, `detail: str | None`, and classmethod `from_core(w: ScriptWarning) -> ScriptWarningOut`.

- [ ] **Step 1: Write the failing tests**

In `tests/api/test_tables_nav_script.py`, replace the string assertions:

```python
# :190, was: assert first["warnings"] == ["script step failed: not computed yet"]
assert first["warnings"] == [
    {
        "code": "nav_step_failed",
        "occurrences": 1,
        "total": 0,
        "detail": "not computed yet",
    }
]
```

```python
# :226, was: assert "script step failed: not computed yet" in first["warnings"]
assert any(
    w["code"] == "nav_step_failed" and w["detail"] == "not computed yet"
    for w in first["warnings"]
)
```

```python
# :234, was: assert second["warnings"] == ["script step failed: ZeroDivisionError: ..."]
assert second["warnings"] == [
    {
        "code": "nav_step_failed",
        "occurrences": 1,
        "total": 0,
        "detail": "ZeroDivisionError: division by zero",
    }
]
```

```python
# :323, :343, was: assert any("build order" in w for w in ...["warnings"])
assert any(w["code"] == "sort_needs_script_nav" for w in first["warnings"])
```

```python
# :394, was: assert not any("build order" in w for w in first["warnings"])
assert not any(w["code"] == "sort_needs_script_nav" for w in first["warnings"])
```

In `tests/api/test_script_embedding_routes.py`:

```python
# :267, was: assert any("pool exhausted" in w for w in body["warnings"])
assert any("pool exhausted" in (w["detail"] or "") for w in body["warnings"])
```

```python
# :448, was: assert any("boom" in w for w in body["warnings"])
assert any("boom" in (w["detail"] or "") for w in body["warnings"])
```

Then add a new test at the end of `tests/api/test_tables_nav_script.py`:

```python
def test_page_warning_shape_is_stable(
    client: TestClient, seed_things: list[str], settings_sync_sweep: Settings
) -> None:
    """Every warning on the wire carries the four fields the client formatter
    reads. A missing `total` would render as NaN in the strip."""
    body = _evaluate(client, BOOM_CODE)
    for w in body["warnings"]:
        assert set(w) == {"code", "occurrences", "total", "detail"}
        assert isinstance(w["code"], str)
        assert isinstance(w["occurrences"], int) and w["occurrences"] >= 1
        assert isinstance(w["total"], int)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_tables_nav_script.py tests/api/test_script_embedding_routes.py -v`

Expected: FAIL — the routes still hand Pydantic a `list[ScriptWarning]` for a `list[str]` field.

- [ ] **Step 3: Implement**

3a. In `src/data_rover/api/schemas.py`, add near the other small output models (above `NavigationPreviewOut`):

```python
class ScriptWarningOut(BaseModel):
    """A structured embedded-evaluation degradation.

    `code` is typed `str`, NOT the enum, so a client that does not know a
    newly added code still parses the payload — the frontend formatter falls
    back to `detail` for an unrecognized code. Copy lives client-side, which
    is why nothing here is a sentence.
    """

    code: str
    #: How many times this kind fired.
    occurrences: int
    #: Summed subject quantity (unknown ids, dropped elements); 0 when the
    #: kind carries no such number.
    total: int = 0
    #: The variable part — an artifact ref, an exception message.
    detail: str | None = None

    @classmethod
    def from_core(cls, w: ScriptWarning) -> ScriptWarningOut:
        return cls(
            code=str(w.code), occurrences=w.occurrences, total=w.total, detail=w.detail
        )
```

with `from ..core.script.warnings import ScriptWarning` added to the imports.

3b. Change both fields:

```python
# NavigationPreviewOut, :864
    warnings: list[ScriptWarningOut] = Field(
        default_factory=list,
        description="Script-step degradations produced by this evaluation.",
    )
```

```python
# TablePageOut, :1010
    #: script-step degradations from navigations this evaluation triggered
    #: (pruned-frontier warnings etc.) + nothing else today. Structured, with
    #: aggregated counts; the client renders the copy.
    warnings: list[ScriptWarningOut] = Field(default_factory=list)
```

3c. `src/data_rover/api/routes/tables.py:464`:

```python
            warnings = (
                [ScriptWarningOut.from_core(w) for w in script_ctx.warnings]
                if script_ctx is not None
                else []
            )
```

with `ScriptWarningOut` added to the `schemas` import.

3d. `src/data_rover/api/routes/artifacts.py:319`:

```python
        warnings=[ScriptWarningOut.from_core(w) for w in result.warnings],
```

with `ScriptWarningOut` added to that file's `schemas` import.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pixi run -e core-dev pytest tests/api tests/script tests/navigation tests/table -v
```

Expected: PASS across the whole Python suite.

- [ ] **Step 5: Lint and commit**

```bash
pixi run dr-tidy
pixi run core-test
git add src/data_rover/api tests/api
git commit -m "feat(api): serialize structured script warnings on table + nav responses"
```

---

## Task 6: Frontend types + the copy formatter

**Files:**
- Create: `frontend/src/lib/script/warnings.ts`
- Create: `frontend/src/lib/script/__tests__/warnings.test.ts`
- Modify: `frontend/src/lib/api/types.ts:502`, `:840`
- Modify: `frontend/src/lib/state/table-editor.svelte.ts:119-120`, `frontend/src/lib/state/navigation-editor.svelte.ts:99-103`
- Modify: `frontend/src/lib/state/__tests__/navigation-editor.test.ts:519-528`

**Interfaces:**
- Produces:
  - `ScriptWarningSchema` (zod) and `type ScriptWarning = { code: string; occurrences: number; total: number; detail: string | null }`
  - `formatScriptWarning(w: ScriptWarning): string`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/script/__tests__/warnings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatScriptWarning } from '../warnings';
import type { ScriptWarning } from '$lib/api/types';

function w(over: Partial<ScriptWarning>): ScriptWarning {
	return { code: 'nav_unknown_ids', occurrences: 1, total: 0, detail: null, ...over };
}

describe('formatScriptWarning', () => {
	it('reports unknown ids with both numbers', () => {
		expect(formatScriptWarning(w({ code: 'nav_unknown_ids', occurrences: 17, total: 42 }))).toBe(
			'Navigation script returned 42 unknown element ids across 17 calls — dropped.'
		);
	});

	it('uses singular forms at one', () => {
		expect(formatScriptWarning(w({ code: 'nav_unknown_ids', occurrences: 1, total: 1 }))).toBe(
			'Navigation script returned 1 unknown element id across 1 call — dropped.'
		);
	});

	it('reports already-visited drops', () => {
		expect(
			formatScriptWarning(w({ code: 'nav_already_visited', occurrences: 3, total: 8 }))
		).toBe('8 elements already visited in the chain, dropped across 3 steps.');
	});

	it('reports a step failure with its message and firing count', () => {
		expect(
			formatScriptWarning(
				w({ code: 'nav_step_failed', occurrences: 4, detail: 'ZeroDivisionError' })
			)
		).toBe('Navigation script step failed (4×): ZeroDivisionError');
	});

	it('drops the count for a single step failure', () => {
		expect(
			formatScriptWarning(w({ code: 'nav_step_failed', occurrences: 1, detail: 'boom' }))
		).toBe('Navigation script step failed: boom');
	});

	it('reports a dangling snippet ref', () => {
		expect(
			formatScriptWarning(w({ code: 'nav_snippet_not_found', detail: 'snip-7' }))
		).toBe('Navigation script step references a snippet that no longer exists (snip-7).');
	});

	it('reports the sort fallback', () => {
		expect(formatScriptWarning(w({ code: 'sort_needs_script_nav' }))).toBe(
			"Sorting by this column needs script values that aren't computed for every row, so rows stay in build order."
		);
	});

	// A server ahead of the client must degrade to something readable rather
	// than to a blank strip.
	it('falls back to the detail, then the code, for an unknown code', () => {
		expect(formatScriptWarning(w({ code: 'brand_new', detail: 'something happened' }))).toBe(
			'something happened'
		);
		expect(formatScriptWarning(w({ code: 'brand_new', detail: null }))).toBe('brand_new');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/script/__tests__/warnings.test.ts'`

Expected: FAIL — cannot resolve `../warnings`.

- [ ] **Step 3: Implement**

3a. In `frontend/src/lib/api/types.ts`, add above `ChainPageSchema`:

```ts
export const ScriptWarningSchema = z.object({
	// Deliberately z.string(), not an enum: a server that ships a new code
	// must not fail validation on an older client. The formatter degrades.
	code: z.string(),
	occurrences: z.number().int().default(1),
	total: z.number().int().default(0),
	detail: z.string().nullish().transform((v) => v ?? null)
});
export type ScriptWarning = z.infer<typeof ScriptWarningSchema>;
```

Replace `warnings: z.array(z.string()).default([])` at `:502` (`ChainPageSchema`)
and `:840` (`TablePageSchema`) with:

```ts
	warnings: z.array(ScriptWarningSchema).default([]),
```

(keep the trailing comma exactly as each object requires — `ChainPageSchema`'s
`warnings` is the last field and takes no comma.)

3b. `frontend/src/lib/state/table-editor.svelte.ts:119-120`:

```ts
	/** ScriptColumn raising on some rows) — see TablePageSchema.warnings.
	 * Structured and aggregated; render via `formatScriptWarning`. */
	warnings: ScriptWarning[];
```

with `ScriptWarning` added to the `$lib/api/types` import.

3c. `frontend/src/lib/state/navigation-editor.svelte.ts:103`:

```ts
	warnings: ScriptWarning[];
```

with the same import added.

3d. Create `frontend/src/lib/script/warnings.ts`:

```ts
/**
 * User-facing copy for the backend's structured script-warning codes.
 *
 * The copy lives HERE and not in Python on purpose: the backend aggregates
 * counts (`occurrences` = how many times a kind fired, `total` = the summed
 * subject quantity) and ships numbers, so the sentence can pluralize against
 * the real figures. The previous design baked counts into backend strings and
 * deduped on the rendered text, which reported "1" for ten occurrences.
 *
 * Pure and dependency-free so both the table strip and the navigation dock
 * render identical wording.
 */
import type { ScriptWarning } from '$lib/api/types';

function plural(n: number, one: string, many: string): string {
	return n === 1 ? one : many;
}

/** One readable sentence for a warning.
 *
 * An unrecognized `code` falls back to `detail`, then to the raw code: a
 * server ahead of this client must degrade to something readable rather than
 * to a blank strip. */
export function formatScriptWarning(w: ScriptWarning): string {
	switch (w.code) {
		case 'nav_unknown_ids':
			return (
				`Navigation script returned ${w.total} unknown ` +
				`${plural(w.total, 'element id', 'element ids')} across ` +
				`${w.occurrences} ${plural(w.occurrences, 'call', 'calls')} — dropped.`
			);
		case 'nav_already_visited':
			return (
				`${w.total} ${plural(w.total, 'element', 'elements')} already visited in ` +
				`the chain, dropped across ${w.occurrences} ` +
				`${plural(w.occurrences, 'step', 'steps')}.`
			);
		case 'nav_step_failed':
			return w.occurrences === 1
				? `Navigation script step failed: ${w.detail}`
				: `Navigation script step failed (${w.occurrences}×): ${w.detail}`;
		case 'nav_snippet_not_found':
			return `Navigation script step references a snippet that no longer exists (${w.detail}).`;
		// Says "SORTING BY this column needs", not "this column's navigation":
		// the sort column is often a property/element column merely SOURCED
		// from the navigation column, and has no navigation of its own.
		case 'sort_needs_script_nav':
			return (
				"Sorting by this column needs script values that aren't computed for " +
				'every row, so rows stay in build order.'
			);
		default:
			return w.detail ?? w.code;
	}
}
```

3e. `frontend/src/lib/state/__tests__/navigation-editor.test.ts` — update the two
fixtures at `:519` and `:528` and the assertion at `:522` to the structured
shape:

```ts
			warnings: [{ code: 'nav_step_failed', occurrences: 1, total: 0, detail: 'divide by zero' }]
```

```ts
		expect(getPreview('nav:draft:1')?.warnings).toEqual([
			{ code: 'nav_step_failed', occurrences: 1, total: 0, detail: 'divide by zero' }
		]);
```

```ts
			.mockResolvedValueOnce({
				...PAGE_1,
				warnings: [
					{ code: 'nav_unknown_ids', occurrences: 1, total: 1, detail: null }
				]
			})
```

Also update the `warnings: []` fixtures in `unsaved.test.ts:33`,
`table-editor-script-status.test.ts:44` and `navigation-editor.test.ts:45,55,62`
only if the typecheck flags them — an empty array is valid for both shapes.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/script src/lib/state/__tests__/navigation-editor.test.ts'
pixi run -e frontend bash -c 'cd frontend && npm run check'
```

Expected: PASS, and `svelte-check` clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/script frontend/src/lib/api/types.ts frontend/src/lib/state
git commit -m "feat(frontend): structured script warnings + client-side copy formatter"
```

---

## Task 7: The table warnings summary + panel

**Files:**
- Create: `frontend/src/lib/components/Table/ScriptWarningsPanel.svelte`
- Create: `frontend/src/lib/components/Table/__tests__/ScriptWarningsPanel.test.ts`
- Modify: `frontend/src/lib/components/Table/TableView.svelte:54` (derived), `:411-415` (the strip), plus a `$state`/handler block near the script-errors ones
- Test: `frontend/src/lib/components/Table/__tests__/TableView.test.ts`

**Interfaces:**
- Consumes: `formatScriptWarning` (Task 6), `getTableWarnings(tabId): ScriptWarning[]` (existing, now returning structured entries).
- Produces: `ScriptWarningsPanel` props `{ id: string; warnings: ScriptWarning[] }`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/Table/__tests__/ScriptWarningsPanel.test.ts`:

```ts
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ScriptWarningsPanel from '../ScriptWarningsPanel.svelte';

const WARNINGS = [
	{ code: 'nav_unknown_ids', occurrences: 17, total: 42, detail: null },
	{ code: 'sort_needs_script_nav', occurrences: 1, total: 0, detail: null }
];

describe('ScriptWarningsPanel', () => {
	it('renders one formatted line per warning', () => {
		render(ScriptWarningsPanel, { props: { id: 'p', warnings: WARNINGS } });
		const items = screen.getAllByTestId('script-warning-entry');
		expect(items).toHaveLength(2);
		expect(items[0].textContent).toContain('42 unknown element ids across 17 calls');
		expect(items[1].textContent).toContain('rows stay in build order');
	});

	it('names itself for assistive tech', () => {
		render(ScriptWarningsPanel, { props: { id: 'p', warnings: WARNINGS } });
		expect(screen.getByRole('dialog', { name: /script warnings/i })).toBeTruthy();
	});
});
```

Add to `frontend/src/lib/components/Table/__tests__/TableView.test.ts` — follow
that file's existing mocking idiom for `$lib/state` (read the top of the file
and extend the mock so `getTableWarnings` returns `WARNINGS` above):

```ts
	it('summarises script warnings and opens the panel on demand', async () => {
		// The old strip joined raw backend prose with ' · '. The summary line
		// is a COUNT plus a disclosure; the prose lives in the panel.
		renderTableView();
		const badge = await screen.findByTestId('table-warnings-badge');
		expect(badge.textContent).toContain('2 script warnings');
		expect(screen.queryByTestId('script-warnings-panel')).toBeNull();
		await fireEvent.click(badge);
		expect(screen.getByTestId('script-warnings-panel')).toBeTruthy();
	});

	it('singularises a lone warning', async () => {
		// one warning in the mock for this case
		renderTableView();
		expect((await screen.findByTestId('table-warnings-badge')).textContent).toContain(
			'1 script warning'
		);
	});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Table/__tests__/ScriptWarningsPanel.test.ts src/lib/components/Table/__tests__/TableView.test.ts'
```

Expected: FAIL — the panel component does not exist and `table-warnings-badge` is not rendered.

- [ ] **Step 3: Implement**

3a. Create `frontend/src/lib/components/Table/ScriptWarningsPanel.svelte`:

```svelte
<script lang="ts">
	// The script-warnings recap: every non-fatal degradation the last table
	// evaluation reported, one readable line each.
	//
	// It exists because these are WHOLE-EVALUATION facts with no cell to
	// attach to — a pruned chain, a sort that fell back to build order — so
	// unlike ScriptErrorsPanel there is nothing to fetch, no loading phase,
	// and no jump target. A dumb presenter: it owns no state, so TableView's
	// badge keeps the open/closed decision.
	import type { ScriptWarning } from '$lib/api/types';
	import { formatScriptWarning } from '$lib/script/warnings';

	let {
		id,
		warnings
	}: {
		/** DOM id, so the badge that opens this can point `aria-controls` at it. */
		id: string;
		warnings: ScriptWarning[];
	} = $props();
</script>

<!-- NON-MODAL: it names itself and Escape dismisses it (handled by the wrapper
     in TableView, where the badge's keydown lands too), but it does not trap
     focus — the grid behind it stays usable. -->
<div
	{id}
	data-testid="script-warnings-panel"
	role="dialog"
	aria-label="Script warnings in this table"
	class="absolute top-full left-0 z-20 mt-1 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded border border-warning/40 bg-card shadow-lg"
>
	<ul class="max-h-64 overflow-y-auto">
		{#each warnings as warning, i (i)}
			<li
				data-testid="script-warning-entry"
				class="border-b border-border/40 px-2 py-1.5 text-xs text-foreground last:border-b-0"
			>
				{formatScriptWarning(warning)}
			</li>
		{/each}
	</ul>
</div>
```

3b. In `frontend/src/lib/components/Table/TableView.svelte`, add the import
next to the `ScriptErrorsPanel` import:

```ts
	import ScriptWarningsPanel from './ScriptWarningsPanel.svelte';
```

Add state and handlers next to the script-errors ones (after
`onScriptErrorsKeydown`, around `:122`):

```ts
	let warningsOpen = $state(false);
	// The panel must not outlive what it describes: a reload that clears the
	// warnings closes it, exactly as the errors panel closes when its badge
	// goes away.
	$effect(() => {
		if (warnings.length === 0) warningsOpen = false;
	});
	function onWarningsKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') warningsOpen = false;
	}
```

Replace the strip at `:411-415`:

```svelte
		{#if warnings.length > 0}
			<!-- A SUMMARY plus a disclosure, not the prose itself: several kinds
			     can fire at once, and the old `join(' · ')` put every one of them
			     on a single line with no indication of how many rows each
			     affected. Stays in the tab's FIXED chrome for the same reason as
			     the status line below. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="relative flex items-center px-3 py-1" onkeydown={onWarningsKeydown}>
				<button
					type="button"
					data-testid="table-warnings-badge"
					aria-expanded={warningsOpen}
					aria-controls="script-warnings-panel-{tabId}"
					aria-haspopup="dialog"
					title="Show what the script evaluation degraded on"
					class="flex items-center gap-1.5 rounded border border-warning/40 bg-warning/15 px-2 py-0.5 text-xs text-warning transition-colors hover:bg-warning/25"
					onclick={() => (warningsOpen = !warningsOpen)}
				>
					<AlertTriangle class="h-3 w-3 shrink-0" />
					{warnings.length} script warning{warnings.length === 1 ? '' : 's'}
				</button>
				{#if warningsOpen}
					<ScriptWarningsPanel id="script-warnings-panel-{tabId}" {warnings} />
				{/if}
			</div>
		{/if}
```

(`AlertTriangle` is already imported at `:34`.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Table'
pixi run -e frontend bash -c 'cd frontend && npm run check'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Table
git commit -m "feat(frontend/table): script-warnings summary badge with a details panel"
```

---

## Task 8: Navigation dock tooltip + docs

**Files:**
- Modify: `frontend/src/lib/components/Navigation/ResultsDock.svelte:159-163`
- Modify: `frontend/README.md` (script/table state section)
- Modify: `CLAUDE.md` (the embedded-evaluation bullet in "Code execution (snippets)")
- Test: `frontend/src/lib/components/Navigation/__tests__/` (add or extend a ResultsDock test)

**Interfaces:**
- Consumes: `formatScriptWarning` (Task 6).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/Navigation/__tests__/ResultsDock.warnings.test.ts` (follow the mocking idiom of the neighbouring `path-card.test.ts`):

```ts
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ResultsDock from '../ResultsDock.svelte';

describe('ResultsDock script warnings', () => {
	it('counts distinct kinds and formats the tooltip', async () => {
		// The count used to be the number of distinct backend STRINGS, which
		// inflated whenever the same kind fired with different numbers.
		renderDockWithWarnings([
			{ code: 'nav_unknown_ids', occurrences: 17, total: 42, detail: null },
			{ code: 'nav_step_failed', occurrences: 2, total: 0, detail: 'boom' }
		]);
		const badge = await screen.findByTestId('nav-warnings');
		expect(badge.textContent).toContain('2 script warnings');
		expect(badge.getAttribute('title')).toBe(
			'Navigation script returned 42 unknown element ids across 17 calls — dropped.\n' +
				'Navigation script step failed (2×): boom'
		);
	});

	it('singularises one warning', async () => {
		renderDockWithWarnings([
			{ code: 'sort_needs_script_nav', occurrences: 1, total: 0, detail: null }
		]);
		expect((await screen.findByTestId('nav-warnings')).textContent).toContain(
			'1 script warning'
		);
	});
});
```

Write `renderDockWithWarnings` against whatever `ResultsDock` needs for props
and store state — read `path-card.test.ts` for the established pattern in this
directory and mirror it.

- [ ] **Step 2: Run test to verify it fails**

```bash
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Navigation/__tests__/ResultsDock.warnings.test.ts'
```

Expected: FAIL — the tooltip is `preview.warnings.join('\n')` over objects, so it renders `[object Object]`.

- [ ] **Step 3: Implement**

Add the import to `ResultsDock.svelte`:

```ts
	import { formatScriptWarning } from '$lib/script/warnings';
```

Replace `:159-163`:

```svelte
			{#if preview.warnings.length}
				<!-- The count is DISTINCT KINDS, which is now meaningful: the
				     backend aggregates, so the same kind firing 17 times is one
				     entry rather than 17 near-identical strings. -->
				<span
					class="text-warning"
					data-testid="nav-warnings"
					title={preview.warnings.map(formatScriptWarning).join('\n')}
					>⚠ {preview.warnings.length} script warning{preview.warnings.length === 1
						? ''
						: 's'}</span
				>
			{/if}
```

(note this also fixes the pre-existing `> 1` pluralization, which said
"warning" for 1 and, correctly, "warnings" for 2+ — keep the behavior but state
it as `=== 1` for consistency with the table badge.)

Update `frontend/README.md`'s table/navigation state section with a short
paragraph: warnings arrive structured (`{code, occurrences, total, detail}`),
copy lives in `$lib/script/warnings.ts`, the table renders a summary badge plus
`ScriptWarningsPanel` and the nav dock renders a badge with a formatted
tooltip.

Update the `CLAUDE.md` embedded-evaluation bullet to mention that degradations
are reported through the structured warning channel
(`core/script/warnings.py`, aggregated by `(code, detail)`, copy client-side).

- [ ] **Step 4: Run the full suites**

```bash
pixi run -e frontend bash -c 'cd frontend && npx vitest run'
pixi run -e frontend bash -c 'cd frontend && npm run check'
pixi run core-test
pixi run dr-tidy
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Navigation frontend/README.md CLAUDE.md
git commit -m "feat(frontend/nav): format script-warning tooltips from the shared formatter"
```

---

## Self-Review Notes

**Spec coverage:** Part 1 §Design → Tasks 1-2. Part 2 core → Tasks 3-4. Wire → Task 5. Frontend formatter/types → Task 6. Panel + strip → Task 7. Nav dock + docs → Task 8. Spec's "out of scope" items (no nav panel, no truncation indicator, no script-errors change) are respected — no task touches them.

**Known follow-through for the implementer:**
- Task 4 leaves `tests/api` red until Task 5 lands; this is called out in Task 4 Step 4 and is the reason those two tasks are adjacent.
- The exact test-file mocking idioms for `TableView.test.ts` and the Navigation dock tests are not reproduced here — read the neighbouring test in each directory and mirror it rather than inventing a new harness.
