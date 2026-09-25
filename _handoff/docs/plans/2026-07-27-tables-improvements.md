# Tables Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five independent fixes to the table/navigation editing surfaces: a highlighted column header band in table settings, a discard confirmation on the settings dialog, newly-added script editors opening expanded, a text-free computing spinner, and removal of the intended-behaviour "already visited" warning.

**Architecture:** Four frontend-only changes plus one Python-core deletion. Tasks 1–3 and 7 are fully independent. Tasks 4 → 5 → 6 form the only chain (state predicate → reusable dialog component → wiring). Nothing shares state across tasks beyond those explicit interfaces.

**Tech Stack:** Python 3.14 / pytest (core), SvelteKit 5 + Svelte runes + Tailwind 4 + bits-ui 2 / vitest + happy-dom (frontend), pixi for every command.

Spec: `docs/superpowers/specs/2026-07-27-tables-improvements-design.md`

## Global Constraints

- **Every command runs through pixi.** There is no global `python` or `node`.
  - Python tests: `pixi run -e core-dev pytest <path>`
  - Frontend tests: `pixi run -e frontend bash -c 'cd frontend && npx vitest run <path>'` (the `cd frontend` is mandatory — pixi runs from the repo root and a bare `npm test` fails with "Missing script")
  - Lint/format/typecheck: `pixi run dr-tidy`
- **Svelte 5 runes only** — `$state`, `$derived`, `$props`, `$effect`. No Svelte 4 stores, no `export let`.
- **Frontend tests use the repo's mount/flushSync/unmount convention**, not `@testing-library/svelte`. Model new tests on the existing file you are editing.
- **No new CSS custom properties.** Colours come from existing tokens: `--info`, `--success`, `--warning`, `--destructive`, `--muted`, `--border`, `--foreground` (all defined per-theme in `frontend/src/app.css`, so `text-info` etc. are already legible in light and dark).
- **Preserve the dense why-comments.** This codebase documents load-bearing invariants inline. When you delete code that carries such a comment, delete the comment with it; when you add code that works around a framework gotcha, comment the gotcha.
- **Commit after each task**, with the message given in the task's final step.
- `docs/` is gitignored — never `git add` anything under it.

---

### Task 1: Remove the "already visited in the chain" warning

A script navigation step that returns an element already in the chain is dropped by the cycle guard. That is intended behaviour — an identity return (`return [el]`, meaning "keep this element") is a normal idiom — yet it raises a warning badge, training users to ignore the badge. Stop emitting it and delete the code path entirely.

**Files:**
- Modify: `src/data_rover/core/navigation/evaluate.py:430-441`
- Modify: `src/data_rover/core/script/warnings.py:41` (the `ScriptWarningCode` member)
- Modify: `frontend/src/lib/script/warnings.ts:32-38`
- Test: `tests/navigation/test_script_step.py` (two tests)
- Test: `tests/script/test_warnings.py:56` (`test_differing_counts_sum_into_one_entry`)
- Test: `frontend/src/lib/script/__tests__/warnings.test.ts:23-27`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `ScriptWarningCode` afterwards has exactly four members: `NAV_SNIPPET_NOT_FOUND`, `NAV_STEP_FAILED`, `NAV_UNKNOWN_IDS`, `SORT_NEEDS_SCRIPT_NAV`.

- [ ] **Step 1: Rewrite the two navigation tests to expect silence**

In `tests/navigation/test_script_step.py`, replace the whole of `test_script_step_visited_drop_warns` (starts at line 187) with:

```python
def test_script_step_visited_drop_is_silent() -> None:
    # identity return: every id the step returns is already in the chain, so
    # the cycle guard drops them all. That is INTENDED -- "keep this element"
    # is the natural idiom for a step that filters rather than hops -- so it
    # must not warn. It used to raise NAV_ALREADY_VISITED, which trained
    # users to ignore the warnings badge.
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): return [el]"))])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.chains == []
    assert res.warnings == []
```

In the same file, replace the body of `test_script_step_unknown_ids_dropped_with_warning` (starts at line 138) with:

```python
def test_script_step_unknown_ids_dropped_with_warning() -> None:
    mm, model = _fixture()
    ids = sorted(model.elements)
    defn = _path([ScriptStep(
        snippet=_snip(f"def step(el): return ['{ids[0]}', 'no-such-id']")
    )])
    res = evaluate(mm, model, defn, script=_ctx(model))
    # occurrences/total are per START ELEMENT (see above) -- len(ids), not 1.
    # The start element equal to ids[0] also returns its own id and trips the
    # already-visited cycle guard, which is SILENT -- so the unknown-id entry
    # is the only warning, and asserting the whole list pins that.
    assert res.warnings == [
        ScriptWarning(
            code=ScriptWarningCode.NAV_UNKNOWN_IDS,
            occurrences=len(ids),
            total=len(ids),
        )
    ]
    assert all(chain[1] == ids[0] for chain in res.chains)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/navigation/test_script_step.py -v`
Expected: `test_script_step_visited_drop_is_silent` FAILS (`res.warnings` holds a `NAV_ALREADY_VISITED` entry, not `[]`), and `test_script_step_unknown_ids_dropped_with_warning` FAILS (the list has two entries).

- [ ] **Step 3: Delete the emission**

In `src/data_rover/core/navigation/evaluate.py`, replace this block (around line 430):

```python
    else:  # ScriptStep
        nxt = _hop_script(model, current, step, script, budget)
        if script is not None and exclude_visited:
            # The generic cycle guard below drops silently -- correct for
            # relationship hops (revisits are expected navigation semantics)
            # but a silent mystery for script steps, where an identity return
            # ("keep this element") is the natural idiom. Warn with a count.
            dropped = sum(1 for o in nxt if o in chain)
            if dropped:
                script.add_warning(ScriptWarningCode.NAV_ALREADY_VISITED, count=dropped)
```

with:

```python
    else:  # ScriptStep
        nxt = _hop_script(model, current, step, script, budget)
        # No already-visited warning here: the cycle guard below drops
        # revisits SILENTLY for script steps too. An identity return
        # ("keep this element") is the natural idiom for a filtering step,
        # so warning on it fired constantly for intended behaviour.
```

Leave the `from ..script.warnings import ScriptWarning, ScriptWarningCode` import at line 39 alone — three other codes in the file still use it.

- [ ] **Step 4: Remove the enum member**

In `src/data_rover/core/script/warnings.py`, delete the line:

```python
    NAV_ALREADY_VISITED = "nav_already_visited"
```

- [ ] **Step 5: Fix the unrelated test that borrowed the code**

`tests/script/test_warnings.py::test_differing_counts_sum_into_one_entry` uses `NAV_ALREADY_VISITED` merely as a sample code. Swap it for `NAV_UNKNOWN_IDS`:

```python
def test_differing_counts_sum_into_one_entry() -> None:
    # Previously these were THREE near-identical lines saying 1, 2 and 5.
    log = ScriptWarningLog()
    for n in (1, 2, 5):
        log.add(ScriptWarningCode.NAV_UNKNOWN_IDS, count=n)
    (entry,) = log.entries
    assert (entry.occurrences, entry.total) == (3, 8)
```

- [ ] **Step 6: Run the Python tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/navigation/ tests/script/ -v`
Expected: PASS. Also confirm nothing else references the removed member:
Run: `grep -rn "NAV_ALREADY_VISITED" src/ tests/`
Expected: no output.

- [ ] **Step 7: Update the frontend formatter test**

In `frontend/src/lib/script/__tests__/warnings.test.ts`, delete this test:

```ts
	it('reports already-visited drops', () => {
		expect(formatScriptWarning(w({ code: 'nav_already_visited', occurrences: 3, total: 8 }))).toBe(
			'8 elements already visited in the chain, dropped across 3 steps.'
		);
	});
```

and add, next to the other fallback tests in the same `describe`:

```ts
	it('falls back for a code this client does not know', () => {
		// `nav_already_visited` was removed server-side; an older server that
		// still sends it must degrade to something readable, never a blank.
		expect(
			formatScriptWarning(w({ code: 'nav_already_visited', occurrences: 3, total: 8 }))
		).toBe('nav_already_visited');
	});
```

- [ ] **Step 8: Run the frontend test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/script/__tests__/warnings.test.ts'`
Expected: the new fallback test FAILS — it still gets the sentence, because the `nav_already_visited` case is still in the switch.

- [ ] **Step 9: Remove the frontend case**

In `frontend/src/lib/script/warnings.ts`, delete this arm of the switch:

```ts
		case 'nav_already_visited':
			return (
				`${w.total} ${plural(w.total, 'element', 'elements')} already visited in ` +
				`the chain, dropped across ${w.occurrences} ` +
				`${plural(w.occurrences, 'step', 'steps')}.`
			);
```

- [ ] **Step 10: Run the frontend test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/script/__tests__/warnings.test.ts'`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/data_rover/core/navigation/evaluate.py \
        src/data_rover/core/script/warnings.py \
        tests/navigation/test_script_step.py \
        tests/script/test_warnings.py \
        frontend/src/lib/script/warnings.ts \
        frontend/src/lib/script/__tests__/warnings.test.ts
git commit -m "fix(navigation): stop warning about intended already-visited drops"
```

---

### Task 2: Bare spinner while script columns compute

The strip reads "Computing script columns 7/42 (17%) — values fill in as they finish". The counters are sweep-internal and the sentence explains a mechanism the user did not ask about. Keep the strip element (the comment above it explains at length why it must stay in the tab's fixed chrome: removing or resizing it shifts the virtualizer's row math) and its spinner; drop all visible text.

**Files:**
- Modify: `frontend/src/lib/components/Table/TableView.svelte` (the `computing` branch around line 477, and the `sweepPercent` `$derived`)
- Test: `frontend/src/lib/components/Table/__tests__/TableView.test.ts:258-271`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `data-testid="table-script-status"` is retained on both the computing and failed branches.

- [ ] **Step 1: Rewrite the failing test**

In `frontend/src/lib/components/Table/__tests__/TableView.test.ts`, replace the test `'shows the sweep progress readout while computing'` with:

```ts
	it('shows a bare spinner while computing, with no progress text', () => {
		h.scriptStatus = { state: 'computing', done: 7, total: 42 };
		const c = render('tbl:draft:computing');
		try {
			const strip = document.querySelector('[data-testid="table-script-status"]');
			expect(strip).not.toBeNull();
			// The sweep's internal counters explained a mechanism nobody asked
			// about; only the spinner (and an sr-only label) survive.
			expect(strip?.textContent).not.toContain('Computing script columns 7/42');
			expect(strip?.textContent).not.toContain('values fill in');
			expect(strip?.querySelector('.animate-spin')).not.toBeNull();
			expect(strip?.getAttribute('role')).toBe('status');
			// It is chrome, not grid content: outside the scrolling body.
			expect(strip?.closest('[data-testid="table-header"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Table/__tests__/TableView.test.ts -t "bare spinner"'`
Expected: FAIL — the strip still contains "Computing script columns 7/42" and carries `aria-live="polite"` rather than `role="status"`.

- [ ] **Step 3: Strip the text from the computing branch**

In `frontend/src/lib/components/Table/TableView.svelte`, replace the `computing` branch:

```svelte
		{#if scriptStatus?.state === 'computing'}
			<div
				class="flex items-center gap-2 bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground"
				data-testid="table-script-status"
				aria-live="polite"
			>
				<span
					class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary"
				></span>
				Computing script columns {scriptStatus.done}/{scriptStatus.total ?? '…'}
				{#if sweepPercent !== null}<span class="tabular-nums">({sweepPercent}%)</span>{/if}
				<span class="text-muted-foreground/60">— values fill in as they finish</span>
			</div>
```

with:

```svelte
		{#if scriptStatus?.state === 'computing'}
			<!-- Spinner only. The sweep's done/total counters and the "values fill
			     in as they finish" clause were removed deliberately: they narrated
			     an internal mechanism. The strip ITSELF stays (see the block
			     comment above) — it is load-bearing for the virtualizer's row math,
			     which assumes a stable chrome height while `computing`. -->
			<div
				class="flex items-center gap-2 bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground"
				data-testid="table-script-status"
				role="status"
			>
				<span
					class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary"
				></span>
				<span class="sr-only">Computing script columns</span>
			</div>
```

Leave the `{:else if scriptStatus?.state === 'failed'}` branch below it untouched — that message is an error, not a loading state.

- [ ] **Step 4: Delete the now-unused derived**

Still in `TableView.svelte`, find and delete the `sweepPercent` `$derived` declaration (search for `sweepPercent`). It has no other consumer. If it carries a docstring comment, delete that too.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Table/__tests__/TableView.test.ts'`
Expected: PASS (all tests in the file, including the untouched `failed`-branch test).

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: no new errors. (svelte-check would flag `sweepPercent` if a reference survived.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Table/TableView.svelte \
        frontend/src/lib/components/Table/__tests__/TableView.test.ts
git commit -m "fix(table): show a bare spinner instead of sweep progress narration"
```

---

### Task 3: New script editors open expanded

`SnippetSourceEditor` defaults to collapsed, so adding a script step or column produces a chevron the user must immediately click — the whole point of the click was to write code. Seed only *newly created* editors as expanded; existing ones keep opening collapsed, so a settings dialog with several script columns stays readable.

**Files:**
- Modify: `frontend/src/lib/state/snippet-collapse.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (re-export)
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte` (`addScriptColumn`)
- Modify: `frontend/src/lib/components/Table/TableView.svelte` (`addColumnFromHeader`)
- Modify: `frontend/src/lib/components/Navigation/PathCard.svelte` (`addScriptStep` and the inline `+ script` insert)
- Create: `frontend/src/lib/state/__tests__/snippet-collapse.test.ts`
- Test: `frontend/src/lib/components/Table/__tests__/ColumnManager.collapse.test.ts`
- Test: `frontend/src/lib/components/Navigation/__tests__/path-card.test.ts`

**Interfaces:**
- Consumes: `isSnippetExpanded(key: string): boolean`, `setSnippetExpanded(key: string, expanded: boolean): void`, `resetSnippetCollapse(): void` — all already exported from `snippet-collapse.svelte.ts` and re-exported from `$lib/state`.
- Produces: `seedSnippetExpanded(key: string): void` — exported from `snippet-collapse.svelte.ts` and re-exported from `$lib/state`. Writes `true` only when the key has no value yet.

Key formats, which must match exactly what the editors read:

| Consumer | Key |
|---|---|
| `ScriptColumnEditor` (via `ColumnManager`) | `` `${tabId}::col:${columnIndex}` `` |
| `ScriptStepRow` (via `PathCard`) | `` `${tabId}::${pathKey(path)}::step:${i}` `` |

- [ ] **Step 1: Write the failing store test**

Create `frontend/src/lib/state/__tests__/snippet-collapse.test.ts`:

```ts
// `seedSnippetExpanded` is how the "+ Script step / + Script column" buttons
// open their new editor already expanded without flipping the store's
// default (collapsed), which exists so a settings dialog full of script
// columns is readable.
import { beforeEach, describe, expect, it } from 'vitest';
import {
	isSnippetExpanded,
	resetSnippetCollapse,
	seedSnippetExpanded,
	setSnippetExpanded
} from '../snippet-collapse.svelte';

beforeEach(() => resetSnippetCollapse());

describe('seedSnippetExpanded', () => {
	it('expands a key that has never been seen', () => {
		expect(isSnippetExpanded('t::col:0')).toBe(false);
		seedSnippetExpanded('t::col:0');
		expect(isSnippetExpanded('t::col:0')).toBe(true);
	});

	it('never stomps a value the user already set', () => {
		setSnippetExpanded('t::col:0', false);
		seedSnippetExpanded('t::col:0');
		expect(isSnippetExpanded('t::col:0')).toBe(false);
	});

	it('leaves neighbouring keys alone', () => {
		seedSnippetExpanded('t::col:1');
		expect(isSnippetExpanded('t::col:0')).toBe(false);
		expect(isSnippetExpanded('t::col:2')).toBe(false);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/snippet-collapse.test.ts'`
Expected: FAIL at module load — `seedSnippetExpanded` is not exported.

- [ ] **Step 3: Add the store function**

In `frontend/src/lib/state/snippet-collapse.svelte.ts`, add after `setSnippetExpanded`:

```ts
/**
 * Open a not-yet-seen editor expanded — for the "+ Script step" / "+ Script"
 * column buttons, whose whole point is that the user is about to type code.
 *
 * A no-op when the key already has a value, so a user's own toggle is never
 * stomped. The store's DEFAULT stays collapsed (see the module docstring):
 * only editors created by an explicit add action are seeded.
 *
 * Inherits the module's index-in-key caveat: a mid-list insert shifts the
 * keys of every later step, so seeding index `i` writes into the key that a
 * moment ago belonged to the step now at `i + 1`. Same cosmetic,
 * self-healing miss the docstring above already accepts — the next toggle
 * fixes it — and not worth structural key remapping.
 */
export function seedSnippetExpanded(key: string): void {
	if (_expanded.has(key)) return;
	_expanded.set(key, true);
}
```

- [ ] **Step 4: Re-export from the state barrel**

In `frontend/src/lib/state/index.ts`, add `seedSnippetExpanded` to the export list that already contains `isSnippetExpanded` and `setSnippetExpanded` (around line 380), keeping the existing alphabetical-ish grouping.

- [ ] **Step 5: Run the store test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/snippet-collapse.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit the store change**

```bash
git add frontend/src/lib/state/snippet-collapse.svelte.ts \
        frontend/src/lib/state/index.ts \
        frontend/src/lib/state/__tests__/snippet-collapse.test.ts
git commit -m "feat(state): add seedSnippetExpanded for freshly added script editors"
```

- [ ] **Step 7: Write the failing component test for the table paths**

In `frontend/src/lib/components/Table/__tests__/ColumnManager.collapse.test.ts`, append inside the existing `describe('ColumnManager PathCard collapse (durable across edits)')` block:

```ts
	it('a script column added from the panel opens expanded', async () => {
		await seed([navColumn('A')]); // one non-script column, so index 1 is new
		const root = document.body;
		const c = mount(ColumnManager, { target: root, props: { tabId: TAB } });
		flushSync();
		try {
			expect(root.querySelector('[data-testid="snippet-collapse-toggle"]')).toBeNull();

			click('[data-testid="add-script-column"]');
			await Promise.resolve();
			flushSync();

			const toggle = root.querySelector(
				'[data-testid="snippet-collapse-toggle"]'
			) as HTMLButtonElement;
			expect(toggle.getAttribute('aria-expanded')).toBe('true');
		} finally {
			unmount(c);
		}
	});

	it('a pre-existing script column still opens collapsed', async () => {
		await seedScript();
		const root = document.body;
		const c = mount(ColumnManager, { target: root, props: { tabId: TAB } });
		flushSync();
		try {
			const toggle = root.querySelector(
				'[data-testid="snippet-collapse-toggle"]'
			) as HTMLButtonElement;
			expect(toggle.getAttribute('aria-expanded')).toBe('false');
		} finally {
			unmount(c);
		}
	});
```

- [ ] **Step 8: Run it to verify the first test fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Table/__tests__/ColumnManager.collapse.test.ts'`
Expected: `'a script column added from the panel opens expanded'` FAILS (`aria-expanded` is `"false"`); the second new test already passes.

- [ ] **Step 9: Seed from ColumnManager's add button**

In `frontend/src/lib/components/Table/ColumnManager.svelte`, add `seedSnippetExpanded` to the `$lib/state` import block, then replace `addScriptColumn`:

```ts
	function addScriptColumn(): void {
		if (!defn) return;
		// `addColumn` appends, so the new column's index is the pre-add length.
		// Seed BEFORE applying: the editor reads the store on its first render.
		seedSnippetExpanded(`${tabId}::col:${defn.columns.length}`);
		apply(addColumn(defn, newScriptColumn()));
	}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Table/__tests__/ColumnManager.collapse.test.ts'`
Expected: PASS (all four tests).

- [ ] **Step 11: Seed from the table header's "+ column" menu**

In `frontend/src/lib/components/Table/TableView.svelte`, add `seedSnippetExpanded` to the `$lib/state` import block, then in `addColumnFromHeader` seed just before `updateTableDefinition`:

```ts
		// Suspend BEFORE the append: that append is itself a definition edit, and
		// evaluating a blank, unconfigured column is the most pointless reload of
		// the lot. The snapshot taken here is the PRE-append definition, so the
		// dialog's Cancel discards the new column entirely (and Save keeps it).
		suspendTableEvaluation(tabId);
		// A brand-new script column opens with its code editor already showing —
		// the user clicked "+ Script" precisely to write code. Keyed on the
		// pre-append length, which is the appended column's index.
		if (kind === 'script') seedSnippetExpanded(`${tabId}::col:${d.definition.columns.length}`);
		updateTableDefinition(tabId, addColumn(d.definition, column));
		openSettings(getTableDraft(tabId)!.definition.columns.length - 1);
```

- [ ] **Step 12: Write the failing navigation test**

In `frontend/src/lib/components/Navigation/__tests__/path-card.test.ts`:

1. Add `resetSnippetCollapse` to the existing `$lib/state` import list.
2. Add `resetSnippetCollapse();` to both the `beforeEach` and the `afterEach` bodies, beside `resetNavigationEditors()`.
3. Append this test at the end of the file:

```ts
it('a script step added from the trailing button opens expanded', async () => {
	// The chevron disclosure defaults to COLLAPSED (a settings dialog full of
	// open code editors is unreadable), but a step the user just created is
	// exactly the one they want to type into.
	const tabId = 'nav:draft:pc-script-seed';
	await seed(tabId, pathWith([]));
	const c = render(tabId);
	try {
		expect(document.querySelector('[data-testid="snippet-collapse-toggle"]')).toBeNull();

		(document.querySelector('[data-testid="add-script-step"]') as HTMLButtonElement).click();
		flushSync();

		const toggle = document.querySelector(
			'[data-testid="snippet-collapse-toggle"]'
		) as HTMLButtonElement;
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
	} finally {
		unmount(c);
	}
});
```

- [ ] **Step 13: Run it to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Navigation/__tests__/path-card.test.ts -t "opens expanded"'`
Expected: FAIL — `aria-expanded` is `"false"`.

- [ ] **Step 14: Seed from PathCard's two script-step inserts**

In `frontend/src/lib/components/Navigation/PathCard.svelte`, add `seedSnippetExpanded` to the `$lib/state` import block, then add this helper next to `insertStep` and route both script inserts through it:

```ts
	/** Insert a script step AND open its editor expanded — the user clicked
	 * "+ script" to write code, so a collapsed chevron is one click of pure
	 * friction. The key must match what `ScriptStepRow`'s `collapseKey` prop
	 * is built from below. */
	function insertScriptStep(i: number): void {
		seedSnippetExpanded(`${tabId}::${pathKey(path)}::step:${i}`);
		insertStep(i, { kind: 'script', snippet: {}, comment: null });
	}
	function addScriptStep(): void {
		insertScriptStep(node.steps.length);
	}
```

Then change the inline `+ script` button's handler (around line 456) from:

```svelte
							onclick={() => insertStep(i, { kind: 'script', snippet: {}, comment: null })}
```

to:

```svelte
							onclick={() => insertScriptStep(i)}
```

- [ ] **Step 15: Run the navigation tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Navigation/'`
Expected: PASS.

- [ ] **Step 16: Run the full frontend suite and typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS, no new svelte-check errors.

- [ ] **Step 17: Commit**

```bash
git add frontend/src/lib/components/Table/ColumnManager.svelte \
        frontend/src/lib/components/Table/TableView.svelte \
        frontend/src/lib/components/Navigation/PathCard.svelte \
        frontend/src/lib/components/Table/__tests__/ColumnManager.collapse.test.ts \
        frontend/src/lib/components/Navigation/__tests__/path-card.test.ts
git commit -m "feat(snippets): open freshly added script steps and columns expanded"
```

---

### Task 4: `hasSuspendedTableEdits` predicate

The settings dialog needs to know whether anything actually changed since it opened, so a clean Cancel/Escape closes silently instead of nagging. The suspension machinery already records a JSON fingerprint of the definition at open time — reuse it, so "changed" means exactly what `resumeTableEvaluation` means by it.

**Files:**
- Modify: `frontend/src/lib/state/table-editor.svelte.ts` (near `suspendTableEvaluation`, around line 344)
- Modify: `frontend/src/lib/state/index.ts` (re-export beside the other suspension functions)
- Test: `frontend/src/lib/state/__tests__/table-editor-staged-edits.test.ts`

**Interfaces:**
- Consumes: the module-private `_suspended: Map<string, string>` and `definitionFingerprint(tabId): string`, both already in `table-editor.svelte.ts`.
- Produces: `hasSuspendedTableEdits(tabId: string): boolean` — exported from `table-editor.svelte.ts` and re-exported from `$lib/state`. Returns `false` when the tab is not suspended.

- [ ] **Step 1: Write the failing test**

In `frontend/src/lib/state/__tests__/table-editor-staged-edits.test.ts`, add `hasSuspendedTableEdits` to the existing import list from `'../table-editor.svelte'`, then append this `describe` at the end of the file:

```ts
// The settings dialog's discard-confirmation gate: nag only when there is
// something to lose. Reuses the suspend-time fingerprint, so "changed" means
// exactly what `resumeTableEvaluation`'s reload decision means by it.
describe('hasSuspendedTableEdits', () => {
	it('is false when the tab was never suspended', async () => {
		await ensureTableDraft(TAB);
		expect(hasSuspendedTableEdits(TAB)).toBe(false);
	});

	it('is false right after suspending, with no edit yet', async () => {
		await ensureTableDraft(TAB);
		suspendTableEvaluation(TAB);
		expect(hasSuspendedTableEdits(TAB)).toBe(false);
	});

	it('is true once the definition changes while suspended', async () => {
		await ensureTableDraft(TAB);
		suspendTableEvaluation(TAB);
		updateTableDefinition(TAB, renamed('Edited'));
		expect(hasSuspendedTableEdits(TAB)).toBe(true);
	});

	it('goes back to false when the edit is undone by hand', async () => {
		await ensureTableDraft(TAB);
		const before = getTableDraft(TAB)!.definition;
		suspendTableEvaluation(TAB);
		updateTableDefinition(TAB, renamed('Edited'));
		updateTableDefinition(TAB, before);
		expect(hasSuspendedTableEdits(TAB)).toBe(false);
	});

	it('is false again after the revert, and after the resume drops the suspension', async () => {
		await ensureTableDraft(TAB);
		suspendTableEvaluation(TAB);
		updateTableDefinition(TAB, renamed('Edited'));
		revertSuspendedTableEdits(TAB);
		expect(hasSuspendedTableEdits(TAB)).toBe(false);
		resumeTableEvaluation(TAB);
		expect(hasSuspendedTableEdits(TAB)).toBe(false);
	});

	it('is false for an unknown tab', () => {
		expect(hasSuspendedTableEdits('tbl:draft:nope')).toBe(false);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/table-editor-staged-edits.test.ts'`
Expected: FAIL at module load — `hasSuspendedTableEdits` is not exported.

- [ ] **Step 3: Implement the predicate**

In `frontend/src/lib/state/table-editor.svelte.ts`, add immediately after `suspendTableEvaluation`:

```ts
/**
 * Did the definition actually change since the settings dialog opened?
 *
 * The dialog's discard-confirmation gate: a Cancel/Escape on an untouched
 * dialog closes silently, and only a real edit is worth interrupting for.
 * Compares against the SAME suspend-time fingerprint `resumeTableEvaluation`
 * uses to decide whether to reload, so the two can never disagree about what
 * "changed" means.
 *
 * `false` when the tab is not suspended (no dialog open, nothing staged).
 *
 * Sort remaps are not in the fingerprint, but they only ever happen alongside
 * a definition edit (remove/move/clone), so they cannot produce a false
 * negative. Object key order could in principle differ between two
 * structurally equal definitions — a false POSITIVE (one needless
 * confirmation), never a false negative that loses work.
 *
 * Called from event handlers, never from a template — no reactivity
 * requirement.
 */
export function hasSuspendedTableEdits(tabId: string): boolean {
	const before = _suspended.get(tabId);
	return before !== undefined && definitionFingerprint(tabId) !== before;
}
```

- [ ] **Step 4: Re-export from the state barrel**

In `frontend/src/lib/state/index.ts`, add `hasSuspendedTableEdits` to the export list beside `revertSuspendedTableEdits` / `suspendTableEvaluation` (around lines 328–333).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/table-editor-staged-edits.test.ts'`
Expected: PASS (6 new tests plus the file's existing ones).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/state/table-editor.svelte.ts \
        frontend/src/lib/state/index.ts \
        frontend/src/lib/state/__tests__/table-editor-staged-edits.test.ts
git commit -m "feat(state): add hasSuspendedTableEdits for the settings discard gate"
```

---

### Task 5: Reusable `ConfirmDialog` component

A small confirmation dialog styled in the app's own vocabulary (`font-display` light tracked title over popover tokens, muted description, right-aligned footer with the dismissive action first). Built reusable, but it gets exactly one consumer in this plan — retrofitting the nine existing `window.confirm` call sites is explicitly **not** part of this work.

**Files:**
- Create: `frontend/src/lib/components/ui/confirm-dialog/confirm-dialog.svelte`
- Create: `frontend/src/lib/components/ui/confirm-dialog/index.ts`
- Create: `frontend/src/lib/components/ui/__tests__/confirm-dialog.test.ts`

**Interfaces:**
- Consumes: `$lib/components/ui/dialog` (`Dialog.Root`, `Dialog.Content`, `Dialog.Title`, `Dialog.Description`).
- Produces: a default-exported Svelte component whose props are exactly:

```ts
type Props = {
    open: boolean;                                  // $bindable
    title: string;
    description: string;
    confirmLabel?: string;                          // default 'Confirm'
    cancelLabel?: string;                           // default 'Cancel'
    variant?: 'default' | 'destructive';            // default 'default'
    onConfirm: () => void;
    onCancel?: () => void;
};
```

  Test ids: `confirm-dialog`, `confirm-dialog-confirm`, `confirm-dialog-cancel`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/ui/__tests__/confirm-dialog.test.ts`:

```ts
// A small reusable confirmation dialog. Built for the table settings dialog's
// discard gate; kept generic so future call sites need not re-invent it.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConfirmDialog from '../confirm-dialog/confirm-dialog.svelte';

/** bits-ui defers Content mount/unmount past a requestAnimationFrame, which
 * flushSync() alone does not drive — mirrors TableView.test.ts's helper. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
		flushSync();
	}
}

function render(props: Record<string, unknown>) {
	const c = mount(ConfirmDialog, {
		target: document.body,
		props: {
			open: true,
			title: 'Discard changes?',
			description: 'Your unsaved column changes will be lost.',
			onConfirm: () => {},
			...props
		}
	});
	flushSync();
	return c;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('ConfirmDialog', () => {
	it('renders its title and description when open', async () => {
		const c = render({});
		try {
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			const dlg = document.querySelector('[data-testid="confirm-dialog"]');
			expect(dlg?.textContent).toContain('Discard changes?');
			expect(dlg?.textContent).toContain('Your unsaved column changes will be lost.');
		} finally {
			unmount(c);
		}
	});

	it('renders nothing when closed', () => {
		const c = render({ open: false });
		try {
			expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('fires onConfirm on the confirm button', async () => {
		const onConfirm = vi.fn();
		const c = render({ onConfirm });
		try {
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog-confirm"]'));
			(document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement).click();
			flushSync();
			expect(onConfirm).toHaveBeenCalledTimes(1);
		} finally {
			unmount(c);
		}
	});

	it('fires onCancel on the cancel button, not onConfirm', async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const c = render({ onConfirm, onCancel });
		try {
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog-cancel"]'));
			(document.querySelector('[data-testid="confirm-dialog-cancel"]') as HTMLElement).click();
			flushSync();
			expect(onCancel).toHaveBeenCalledTimes(1);
			expect(onConfirm).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('uses the supplied labels and marks the destructive variant', async () => {
		const c = render({
			confirmLabel: 'Discard changes',
			cancelLabel: 'Keep editing',
			variant: 'destructive'
		});
		try {
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog-confirm"]'));
			const confirm = document.querySelector('[data-testid="confirm-dialog-confirm"]');
			const cancel = document.querySelector('[data-testid="confirm-dialog-cancel"]');
			expect(confirm?.textContent?.trim()).toBe('Discard changes');
			expect(cancel?.textContent?.trim()).toBe('Keep editing');
			expect(confirm?.className).toContain('bg-destructive');
		} finally {
			unmount(c);
		}
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/ui/__tests__/confirm-dialog.test.ts'`
Expected: FAIL — the component file does not exist.

- [ ] **Step 3: Write the component**

Create `frontend/src/lib/components/ui/confirm-dialog/confirm-dialog.svelte`:

```svelte
<script lang="ts">
	// A small, generic confirmation dialog for destructive-or-lossy actions.
	//
	// Deliberately NOT a replacement for the repo's `window.confirm` call
	// sites — those keep working; this exists so surfaces that need a styled,
	// in-app confirmation (starting with the table settings dialog's discard
	// gate) do not each hand-roll one.
	//
	// Fully controlled: `open` is bindable, and the component never decides on
	// its own that the action should proceed — it reports the click and lets
	// the owner close it. Both buttons close it as a convenience, which is the
	// behaviour every caller so far wants.
	import * as Dialog from '$lib/components/ui/dialog';

	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Confirm',
		cancelLabel = 'Cancel',
		variant = 'default',
		onConfirm,
		onCancel
	}: {
		open?: boolean;
		title: string;
		description: string;
		confirmLabel?: string;
		cancelLabel?: string;
		variant?: 'default' | 'destructive';
		onConfirm: () => void;
		onCancel?: () => void;
	} = $props();

	function confirm(): void {
		open = false;
		onConfirm();
	}
	function cancel(): void {
		open = false;
		onCancel?.();
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(o) => {
		// Escape, the overlay and the built-in X all land here. They are
		// DISMISSALS, so they must behave like Cancel — never like Confirm.
		if (!o) onCancel?.();
	}}
>
	<Dialog.Content data-testid="confirm-dialog" class="gap-4" showCloseButton={false}>
		<Dialog.Title class="font-display text-lg font-light tracking-wide">
			{title}
		</Dialog.Title>
		<Dialog.Description class="text-xs leading-relaxed text-muted-foreground">
			{description}
		</Dialog.Description>
		<div class="flex items-center justify-end gap-2">
			<button
				type="button"
				data-testid="confirm-dialog-cancel"
				class="rounded border border-input px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-muted"
				onclick={cancel}
			>
				{cancelLabel}
			</button>
			<button
				type="button"
				data-testid="confirm-dialog-confirm"
				class="rounded px-3 py-1.5 text-xs transition-colors {variant === 'destructive'
					? 'bg-destructive text-white hover:bg-destructive/90'
					: 'bg-primary text-primary-foreground hover:bg-primary/80'}"
				onclick={confirm}
			>
				{confirmLabel}
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
```

Create `frontend/src/lib/components/ui/confirm-dialog/index.ts`:

```ts
import ConfirmDialog from './confirm-dialog.svelte';

export { ConfirmDialog, ConfirmDialog as Root };
export default ConfirmDialog;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/ui/__tests__/confirm-dialog.test.ts'`
Expected: PASS (5 tests).

If the `onOpenChange` handler double-fires `onCancel` when the cancel button runs (because `open = false` also triggers it), note that bits-ui's `onOpenChange` fires only from its own `handleClose()`, not from an external assignment to the bound value — so the button path does **not** reach it. If a test proves otherwise on this version, guard `cancel()` with a `closing` flag and say so in a comment.

- [ ] **Step 5: Typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/ui/confirm-dialog/ \
        frontend/src/lib/components/ui/__tests__/confirm-dialog.test.ts
git commit -m "feat(ui): add a reusable ConfirmDialog component"
```

---

### Task 6: Gate the table settings dialog behind the confirmation

Cancel, the X, Escape and an overlay click all discard every staged definition edit with no warning — a composed script column can vanish on a stray Escape. Gate all four paths when something actually changed. That dialog is also what the grid's header pencil (`header-edit-{i}`) opens, so "in table settings" and "after editing a header" are the same surface.

**Files:**
- Modify: `frontend/src/lib/components/Table/TableView.svelte:569-645` (the `Dialog.Root` block) and its `<script>` section
- Test: `frontend/src/lib/components/Table/__tests__/TableView.test.ts`

**Interfaces:**
- Consumes: `hasSuspendedTableEdits(tabId: string): boolean` from `$lib/state` (Task 4); `ConfirmDialog` from `$lib/components/ui/confirm-dialog` with props `open` (bindable), `title`, `description`, `confirmLabel`, `cancelLabel`, `variant`, `onConfirm`, `onCancel` (Task 5).
- Produces: nothing consumed by later tasks. New test id `settings-close` on the custom X button; `settings-cancel` and `settings-save` keep their meaning.

**Two bits-ui gotchas this task works around** (both already documented in the file — extend, don't replace, those comments):
1. `onOpenChange` fires only from bits-ui's own `handleClose()`, never from an external assignment to the bound `open`. So any path that closes by assigning `settingsOpen = false` must run the revert/resume itself.
2. The built-in X is a `DialogPrimitive.Close`; its click cannot be `preventDefault`ed. It must be replaced with a custom button (`showCloseButton={false}`).

- [ ] **Step 1: Write the failing tests**

In `frontend/src/lib/components/Table/__tests__/TableView.test.ts`:

1. Add a hoisted flag to the `vi.hoisted` block, beside `revertSuspendedTableEdits`:

```ts
	/** Mirrors `hasSuspendedTableEdits`: did the definition change since the
	 * settings dialog opened? Drives the discard-confirmation gate. */
	dirtySinceOpen: false,
```

2. Add to the `vi.mock('$lib/state', ...)` factory, beside `revertSuspendedTableEdits`:

```ts
	hasSuspendedTableEdits: () => h.dirtySinceOpen,
```

3. Add `h.dirtySinceOpen = false;` to the `afterEach` reset block.

4. Append this `describe` after the existing `describe('TableView settings popup')` block:

```ts
// The discard gate: staged definition edits are lost on Cancel/X/Escape/
// overlay, and a composed script column is expensive to lose. Nag only when
// there is something to lose — `hasSuspendedTableEdits` is the whole test.
describe('TableView settings discard confirmation', () => {
	async function openSettings(): Promise<void> {
		(document.querySelector('[data-testid="table-settings-button"]') as HTMLElement).click();
		flushSync();
		await waitFor(() => !!document.querySelector('[data-testid="table-settings-dialog"]'));
	}

	it('Cancel on a clean dialog closes with no confirmation', async () => {
		h.dirtySinceOpen = false;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
			expect(h.revertSuspendedTableEdits).toHaveBeenCalledWith('tbl:draft:1');
			expect(h.resumeTableEvaluation).toHaveBeenCalledTimes(1);
		} finally {
			unmount(c);
		}
	});

	it('Cancel on a dirty dialog asks first and keeps the dialog open', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			expect(document.querySelector('[data-testid="table-settings-dialog"]')).not.toBeNull();
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
			expect(h.resumeTableEvaluation).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('"Keep editing" dismisses only the confirmation', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			(document.querySelector('[data-testid="confirm-dialog-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="confirm-dialog"]'));
			expect(document.querySelector('[data-testid="table-settings-dialog"]')).not.toBeNull();
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('"Discard changes" reverts and closes, resuming exactly once', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			(document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(h.revertSuspendedTableEdits).toHaveBeenCalledWith('tbl:draft:1');
			// The suspend/resume contract: exactly one resume per close, not
			// zero (stuck suspended) and not two (a double reload).
			expect(h.resumeTableEvaluation).toHaveBeenCalledTimes(1);
		} finally {
			unmount(c);
		}
	});

	it('Escape on a dirty dialog is gated too', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			expect(document.querySelector('[data-testid="table-settings-dialog"]')).not.toBeNull();
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('the X is gated too', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-close"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			expect(document.querySelector('[data-testid="table-settings-dialog"]')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('Save is never gated, even when dirty', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-save"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
			expect(h.resumeTableEvaluation).toHaveBeenCalledTimes(1);
		} finally {
			unmount(c);
		}
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Table/__tests__/TableView.test.ts -t "discard confirmation"'`
Expected: the four dirty-path tests FAIL (the dialog closes straight through, no `confirm-dialog` ever appears); `settings-close` is not found at all.

The pre-existing `'Cancel reverts staged edits'`, `'closing via Escape behaves like Cancel'` and `'Cancel still reverts after a prior Save'` tests must stay green throughout — they never edit, so `h.dirtySinceOpen` stays `false` for them and they take the ungated path.

- [ ] **Step 3: Extract `applyClose` and add the gate plumbing**

In `frontend/src/lib/components/Table/TableView.svelte`'s `<script>` section, add `hasSuspendedTableEdits` to the `$lib/state` import block and `import ConfirmDialog from '$lib/components/ui/confirm-dialog/confirm-dialog.svelte';` beside the other component imports. Then add, right after `saveSettings()`:

```ts
	/** Whether the discard confirmation is showing over the settings dialog. */
	let confirmDiscardOpen = $state(false);

	/** Everything a settings-dialog close must do, regardless of which path
	 * got there. Lives in a function rather than inline in `onOpenChange`
	 * because two of the four close paths (the gated Cancel/X, and the
	 * confirmation's "Discard changes") close by assigning `settingsOpen`,
	 * which bits-ui does NOT report through `onOpenChange` — see the note by
	 * `settingsSaved`'s declaration.
	 *
	 * Safe to run twice: `revertSuspendedTableEdits` returns early once the
	 * suspend-time snapshot is gone, and `resumeTableEvaluation` returns early
	 * once the suspension is dropped. */
	function applyClose(): void {
		if (!settingsSaved) revertSuspendedTableEdits(tabId);
		settingsFocus = null;
		resumeTableEvaluation(tabId);
	}

	/** The gate. Every DISCARD path (Cancel, the X, Escape, an overlay click)
	 * funnels through here; Save does not, because it keeps the edits. */
	function requestClose(): void {
		if (hasSuspendedTableEdits(tabId)) {
			confirmDiscardOpen = true;
			return;
		}
		applyClose();
		settingsOpen = false;
	}

	function discardAndClose(): void {
		confirmDiscardOpen = false;
		applyClose();
		settingsOpen = false;
	}
```

Also reset the confirmation in `openSettings`, beside `settingsSaved = false;`:

```ts
		settingsSaved = false;
		confirmDiscardOpen = false;
```

- [ ] **Step 4: Rewire the dialog markup**

In the same file, replace the `Dialog.Root` opening tag and `Dialog.Content` opening tag:

```svelte
		<Dialog.Root
			bind:open={settingsOpen}
			onOpenChange={(o) => {
				if (o) return; // opening is handled by openSettings, not here — see its comment
				// Only Save still reaches here: every discard path is intercepted
				// by `requestClose` (Cancel, the X) or by the preventDefault
				// handlers below (Escape, overlay click), and those close by
				// assigning `settingsOpen`, which bits-ui does not report here.
				applyClose();
			}}
		>
			<Dialog.Content
				data-testid="table-settings-dialog"
				class="flex max-w-none flex-col overflow-hidden sm:max-w-none"
				style="width:{dlgW}px;height:{dlgH}px"
				showCloseButton={false}
				onEscapeKeydown={(e) => {
					// Gate Escape rather than letting the primitive close: a stray
					// Escape used to bin a fully composed script column silently.
					if (hasSuspendedTableEdits(tabId)) {
						e.preventDefault();
						confirmDiscardOpen = true;
					}
				}}
				onInteractOutside={(e) => {
					if (hasSuspendedTableEdits(tabId)) {
						e.preventDefault();
						confirmDiscardOpen = true;
					}
				}}
			>
				<!-- Our own X: the primitive's built-in one is a `Dialog.Close`,
				     whose click cannot be preventDefault-ed, so it could not be
				     gated. `showCloseButton={false}` above turns that one off. -->
				<button
					type="button"
					data-testid="settings-close"
					class="absolute top-4 right-4 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onclick={requestClose}
				>
					<X class="size-4" />
					<span class="sr-only">Close</span>
				</button>
```

Add `X` to the `@lucide/svelte` import at the top of the file (it already imports several icons from there; append `X` to that list).

Then replace the Cancel footer button:

```svelte
					<Dialog.Close
						data-testid="settings-cancel"
						class="rounded border border-input px-3 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
					>
						Cancel
					</Dialog.Close>
```

with a plain button — it must NOT be a `Dialog.Close`, or the primitive closes before the gate can run:

```svelte
					<button
						type="button"
						data-testid="settings-cancel"
						class="rounded border border-input px-3 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
						onclick={requestClose}
					>
						Cancel
					</button>
```

Leave the Save `Dialog.Close` exactly as it is: it sets `settingsSaved` and closes through the primitive, so `onOpenChange` → `applyClose()` runs and keeps the edits.

Finally, add the confirmation just before the closing `</Dialog.Content>`, after the resize handle:

```svelte
				<ConfirmDialog
					bind:open={confirmDiscardOpen}
					title="Discard changes?"
					description="The column changes you made in this dialog will be lost. This cannot be undone."
					confirmLabel="Discard changes"
					cancelLabel="Keep editing"
					variant="destructive"
					onConfirm={discardAndClose}
				/>
```

No `onCancel` is passed: dismissing the confirmation should leave the settings dialog exactly as it was, which is the default.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Table/__tests__/TableView.test.ts'`
Expected: PASS — the seven new tests **and** every pre-existing test in the file.

Two failures are worth naming in advance:

- **Escape still closes the settings dialog.** The nested `ConfirmDialog` is stealing or re-dispatching the key. Check that `confirmDiscardOpen` starts `false` on every open (Step 3's `openSettings` reset) and that `preventDefault()` is actually reached — add a temporary `console.log` in the handler rather than guessing.
- **`resumeTableEvaluation` called twice** (`toHaveBeenCalledTimes(1)` fails with 2). That would mean this bits-ui version DOES fire `onOpenChange` for an external assignment to the bound `open`, contradicting the comment the file has carried since the staged-edits work. If so, do not delete the `onOpenChange` handler — guard `applyClose()` with a module-local `let closing = false` flag set in `requestClose`/`discardAndClose` and cleared in `openSettings`, and replace that stale comment with what you actually observed.

- [ ] **Step 6: Full frontend suite + typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS, no new svelte-check errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/Table/TableView.svelte \
        frontend/src/lib/components/Table/__tests__/TableView.test.ts
git commit -m "feat(table): confirm before discarding staged settings edits"
```

---

### Task 7: Column header band in the table settings dialog

Every column card in `ColumnManager` renders its kind badge, name input and action buttons in the same flat visual register as the editor body below it. With a script or navigation column expanded, the card reads as one undifferentiated block and the column's identity is hard to find. Promote that row to a header band.

**Files:**
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte` (the card `div[data-col-drop]`, its first child row, the per-kind editor block, and the drag ghost)
- Modify: `frontend/src/lib/components/Table/ScriptColumnEditor.svelte` (drop the now-double `mt-1.5`)
- Test: `frontend/src/lib/components/Table/__tests__/ColumnManager.header-band.test.ts` (create)

**Interfaces:**
- Consumes: `columnKindLabel(kind: string): string` from `$lib/table/columns` (already imported by the file). It returns `'Scope' | 'Property' | 'Navigation' | 'Script'`.
- Produces: a new module-local `kindBadgeClass(kind: string): string` helper in `ColumnManager.svelte`, and the test id `column-header-band-{i}` on each card's band.

Kind → accent, all from tokens defined per-theme in `app.css`:

| `col.kind` | badge classes |
|---|---|
| `element` | `bg-foreground/10 text-foreground/70` |
| `property` | `bg-info/15 text-info` |
| `navigation` | `bg-success/15 text-success` |
| `script` | `bg-warning/15 text-warning` |
| anything else | `bg-muted text-muted-foreground` |

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/Table/__tests__/ColumnManager.header-band.test.ts`:

```ts
// The column card's identity row (kind badge + name input + actions) is a
// distinct header BAND, not a flat first line: with a script or navigation
// editor expanded below it, a flat row left the column's identity impossible
// to find. Structural assertions only — the exact tint is not unit-tested.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as tablesApi from '$lib/api/tables';
import * as artifactsApi from '$lib/api/artifacts';
import {
	ensureTableDraft,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	resetSnippetCollapse,
	resetTableEditors,
	setProjectInfo,
	updateTableDefinition
} from '$lib/state';
import type { Column, TableDefinition } from '$lib/api/types';
import ColumnManager from '../ColumnManager.svelte';

const TAB = 'tbl:draft:header-band';

const EMPTY_PAGE = {
	columns: [],
	rows: [],
	total: 0,
	truncated: false,
	offset: 0,
	model_rev: 1,
	warnings: []
};

function propertyColumn(header: string): Column {
	return {
		kind: 'property',
		source: { kind: 'row', chain_index: 0 },
		property_name: 'name',
		mode: 'collapse',
		keep_empty: true,
		sort_mode: 'value',
		cell_cap: 20,
		header,
		width_px: null,
		hidden: false
	} as Column;
}

async function seed(columns: Column[]): Promise<void> {
	await ensureTableDraft(TAB);
	const defn: TableDefinition = {
		schema_version: 1,
		default_cell_mode: 'collapse',
		show_row_numbers: false,
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns
	};
	updateTableDefinition(TAB, defn);
	flushSync();
}

beforeEach(() => {
	resetTableEditors();
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	resetSnippetCollapse();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue({
		step_types: [],
		chains: [],
		total: 0,
		truncated: false,
		warnings: []
	});
});
afterEach(() => {
	resetTableEditors();
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	resetSnippetCollapse();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

it('puts the kind badge and the name input inside a header band', async () => {
	await seed([propertyColumn('Owner')]);
	const c = mount(ColumnManager, { target: document.body, props: { tabId: TAB } });
	flushSync();
	try {
		const band = document.querySelector('[data-testid="column-header-band-0"]');
		expect(band).not.toBeNull();
		expect(band?.textContent).toContain('Property');
		const input = band?.querySelector('input') as HTMLInputElement;
		expect(input.value).toBe('Owner');
		// The band is a visually distinct strip, not a bare flex row.
		expect(band?.className).toContain('border-b');
	} finally {
		unmount(c);
	}
});

it('tints the kind badge per column kind', async () => {
	await seed([propertyColumn('Owner')]);
	const c = mount(ColumnManager, { target: document.body, props: { tabId: TAB } });
	flushSync();
	try {
		const badge = [...document.querySelectorAll('[data-testid="column-header-band-0"] span')].find(
			(s) => s.textContent?.trim() === 'Property'
		);
		expect(badge?.className).toContain('text-info');
	} finally {
		unmount(c);
	}
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Table/__tests__/ColumnManager.header-band.test.ts'`
Expected: FAIL — no element carries `data-testid="column-header-band-0"`.

- [ ] **Step 3: Add the badge-colour helper**

In `frontend/src/lib/components/Table/ColumnManager.svelte`, add near the other module-local functions in the `<script>` block:

```ts
	/** Per-kind accent for the header band's kind badge, so ELEMENT /
	 * PROPERTY / NAVIGATION / SCRIPT are distinguishable at a glance in a long
	 * column list. All four tokens are defined per-theme in app.css, so the
	 * tints are legible in light and dark without a media query. */
	function kindBadgeClass(kind: string): string {
		if (kind === 'element') return 'bg-foreground/10 text-foreground/70';
		if (kind === 'property') return 'bg-info/15 text-info';
		if (kind === 'navigation') return 'bg-success/15 text-success';
		if (kind === 'script') return 'bg-warning/15 text-warning';
		return 'bg-muted text-muted-foreground';
	}
```

- [ ] **Step 4: Turn the identity row into a band**

In the same file's `{#each defn.columns as col, i (i)}` block:

1. On the card `<div data-col-drop={i}>`, change `class="rounded border border-border/70 p-1.5"` to `class="overflow-hidden rounded border border-border/70"` — the padding moves inside, and `overflow-hidden` lets the band's tint reach the rounded corners.

2. Change the identity row's opening tag from:

```svelte
						<div class="flex flex-wrap items-center gap-1.5" class:opacity-60={col.hidden}>
```

to:

```svelte
						<!-- The header band: the column's identity (kind + name) set off
						     from the editor body below it, which is otherwise a wall of
						     controls in the same visual register. -->
						<div
							data-testid="column-header-band-{i}"
							class="flex flex-wrap items-center gap-1.5 border-b border-border/70 bg-muted/50 p-1.5"
							class:opacity-60={col.hidden}
						>
```

3. Change the kind badge span from:

```svelte
							<span
								class="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground uppercase"
							>
								{columnKindLabel(col.kind)}
							</span>
```

to:

```svelte
							<span
								class="rounded px-1 py-0.5 font-mono text-[10px] uppercase {kindBadgeClass(col.kind)}"
							>
								{columnKindLabel(col.kind)}
							</span>
```

4. Change the name input from:

```svelte
							<input
								class="min-w-0 flex-1 rounded border border-input bg-card px-1.5 py-0.5"
```

to — a title that stays obviously editable, its border appearing on hover/focus:

```svelte
							<input
								class="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-0.5 font-medium transition-colors hover:border-input hover:bg-card focus:border-input focus:bg-card"
```

- [ ] **Step 5: Re-pad the editor body**

Still inside the `{#each}`, wrap the three per-kind editors (the `{#if col.kind === 'navigation'} … {:else if col.kind === 'script'} … {/if}` chain that follows the band) in a padded container:

```svelte
						{#if col.kind !== 'element'}
							<div class="p-1.5">
								{#if col.kind === 'navigation'}
									<NavigationColumnEditor
										column={col}
										columnIndex={i}
										columns={defn.columns}
										rowSource={defn.row_source}
										{sampleRowElementId}
										onChange={(next) => onColumnChange(i, next)}
									/>
								{:else if col.kind === 'property'}
									<PropertyColumnEditor
										column={col}
										columnIndex={i}
										columns={defn.columns}
										rowSource={defn.row_source}
										onChange={(next) => onColumnChange(i, next)}
									/>
								{:else if col.kind === 'script'}
									<ScriptColumnEditor
										column={col}
										columnIndex={i}
										columns={defn.columns}
										rowSource={defn.row_source}
										{tabId}
										onChange={(next) => onColumnChange(i, next)}
									/>
								{/if}
							</div>
						{/if}
```

An `element` column has no editor, so it is just the band — the `{#if col.kind !== 'element'}` guard keeps it from rendering an empty padded box under one.

- [ ] **Step 6: Drop the doubled margin in ScriptColumnEditor**

In `frontend/src/lib/components/Table/ScriptColumnEditor.svelte`, change the root div's class from `"mt-1.5 space-y-1.5 rounded border border-border/60 bg-muted/30 p-2 text-[11px]"` to `"space-y-1.5 rounded border border-border/60 bg-muted/30 p-2 text-[11px]"` — the new padded wrapper supplies that gap now.

- [ ] **Step 7: Mirror the band on the drag ghost**

Still in `ColumnManager.svelte`, in the `column-drag-ghost` block, change its kind badge from:

```svelte
				<span
					class="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground uppercase"
				>
					{dragCol ? columnKindLabel(dragCol.kind) : ''}
				</span>
```

to — so grabbing a card does not change how it looks:

```svelte
				<span
					class="rounded px-1 py-0.5 font-mono text-[10px] uppercase {dragCol
						? kindBadgeClass(dragCol.kind)
						: 'bg-muted text-muted-foreground'}"
				>
					{dragCol ? columnKindLabel(dragCol.kind) : ''}
				</span>
```

and add `bg-muted/50` to the ghost's own container class (which currently reads `… rounded border border-primary/40 bg-card p-1.5 …`), replacing `bg-card` with `bg-muted/50`.

- [ ] **Step 8: Run the new test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Table/__tests__/ColumnManager.header-band.test.ts'`
Expected: PASS (2 tests).

- [ ] **Step 9: Run every ColumnManager test**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Table/'`
Expected: PASS. The reorder/collapse/drag tests query by `data-testid` and `data-col-drop`, both preserved — if one fails, the selector it uses moved into or out of the band; fix the markup, not the test.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/components/Table/ColumnManager.svelte \
        frontend/src/lib/components/Table/ScriptColumnEditor.svelte \
        frontend/src/lib/components/Table/__tests__/ColumnManager.header-band.test.ts
git commit -m "feat(table): set the column identity row off as a header band"
```

---

### Task 8: Full verification sweep

Every task ran its own targeted tests; this confirms nothing drifted across them and that lint/format/typecheck are clean.

**Files:** none modified unless a check fails.

**Interfaces:**
- Consumes: the completed state of Tasks 1–7.
- Produces: nothing.

- [ ] **Step 1: Lint, format and typecheck everything**

Run: `pixi run dr-tidy`
Expected: clean. This runs ruff (format + `--fix`), mypy, pyright, and the frontend formatter/linter — **all** must pass. If it rewrites files, review the diff before continuing.

- [ ] **Step 2: Full Python test suite**

Run: `pixi run core-test`
Expected: PASS. (API tests need no database — `tests/api/conftest.py` runs in-memory SQLite.)

- [ ] **Step 3: Full frontend suite and svelte-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS, zero svelte-check errors.

- [ ] **Step 4: Confirm the removed warning is gone everywhere**

Run: `grep -rn "already_visited\|ALREADY_VISITED\|sweepPercent\|Computing script columns" src/ tests/ frontend/src/`
Expected: no output.

- [ ] **Step 5: Commit any formatter fixups**

```bash
git status --short
# only if dr-tidy changed files:
git add -A ':!docs'
git commit -m "chore: formatter fixups"
```

---

## Notes for the implementer

- **Manual smoke test worth doing at the end** (`pixi run backend-start` + `pixi run frontend-start`, then open a table): add a script column from the header "+" menu and confirm its editor opens with code showing; type in it, hit Escape, confirm the discard dialog appears; hit "Keep editing" and confirm your code is still there. The unit tests mock `$lib/state`, so they prove the wiring but not the end-to-end feel.
- **Task 6 is the only one with a framework trap.** If Escape behaves oddly, re-read the two bits-ui gotchas in that task's preamble before changing anything else.
- **`docs/` is gitignored** — the spec and this plan are never staged.
