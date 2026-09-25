# Table & Panel Polish Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five small table/panel improvements: Cancel/Save on the table settings dialog, a clone-column button, collapsible snippet editors in column/step editing, an optional row-number column (grid + export), and an xlsxwriter-based Excel export with autofit, borders, and header filters.

**Architecture:** Frontend items build on the existing copy-on-write column mutators (`frontend/src/lib/table/columns.ts`), the staged-edits suspension machinery (`frontend/src/lib/state/table-editor.svelte.ts`), and the PathCard store-backed disclosure pattern. The backend item rewrites `src/data_rover/api/table_export.py` from openpyxl write-only streaming to xlsxwriter in-memory mode (autofit requires the whole sheet in memory — accepted trade-off per spec). Spec: `docs/superpowers/specs/2026-07-24-table-panel-polish-pack-design.md`.

**Tech Stack:** Svelte 5 (runes) + vitest (mount/flushSync/unmount convention, NO @testing-library/svelte), FastAPI + pydantic, xlsxwriter (new dep, write) + openpyxl (kept, tests read workbooks back).

## Global Constraints

- Everything runs through pixi. Backend tests: `pixi run -e core-dev pytest tests/api/test_table_export.py -v`. Frontend tests MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test -- <file>'` (the bare `pixi run -e frontend npm test` fails — pixi runs from the repo root).
- Lint gates: `pixi run core-lint` and `pixi run backend-lint` run ruff + mypy + pyright — all three must pass. Frontend: `pixi run -e frontend bash -c 'cd frontend && npm run check'`.
- Column mutators are COPY-ON-WRITE at column granularity: untouched columns keep object identity (see `columns.ts` module doc). Never use `structuredClone` on definition objects (a leaked `$state` proxy bricks it) — deep copies go through JSON round-trips.
- Every frontend component test follows the repo's `mount`/`flushSync`/`unmount` Svelte-5 convention (see `TableGrid.test.ts` line 1-7).
- Commit after each task with the message given in the task's final step.
- Python: 3.14, modern idioms; dense docstrings explaining *why* — preserve that style when touching documented invariants.

---

### Task 1: Store-level snapshot & revert for staged settings edits (item 7, state layer)

**Files:**
- Modify: `frontend/src/lib/state/table-editor.svelte.ts` (around lines 296-364: `_suspended`/`suspendTableEvaluation`/`resumeTableEvaluation`/`abandonTableEvaluationSuspension`; and `rekeyTab` around line 698)
- Modify: `frontend/src/lib/state/index.ts` (barrel export)
- Test: `frontend/src/lib/state/__tests__/table-editor-staged-edits.test.ts`

**Interfaces:**
- Consumes: existing `_suspended` map, `_drafts` map, `_sorts` map, `TableDraft`, `TableSort` (all already in `table-editor.svelte.ts`).
- Produces: `export function revertSuspendedTableEdits(tabId: string): void` — restores the draft's `definition`, `dirty` flag, and the active sort to their values as of `suspendTableEvaluation`. Task 2 calls this from TableView's Cancel path. Also `export function remapTableSortForInsert(tabId: string, index: number): void` (used by Task 4's clone button; added here because it lives beside its `ForRemove`/`ForMove` siblings).

- [ ] **Step 1: Write the failing tests**

Append to the `describe('staged table definition edits', ...)` block in `frontend/src/lib/state/__tests__/table-editor-staged-edits.test.ts` (the file's existing imports from `'../table-editor.svelte'` gain `revertSuspendedTableEdits`, `getTableSort`, `setTableSort`, `remapTableSortForRemove`):

```ts
	it('revert restores the pre-suspend definition and dirty flag; resume then evaluates nothing', async () => {
		const original = getTableDraft(TAB)!.definition;
		suspendTableEvaluation(TAB);
		updateTableDefinition(TAB, renamed('a'));
		updateTableDefinition(TAB, renamed('b'));
		expect(getTableDraft(TAB)!.dirty).toBe(true);

		revertSuspendedTableEdits(TAB);
		expect(getTableDraft(TAB)!.definition).toBe(original); // reference-identical
		expect(getTableDraft(TAB)!.dirty).toBe(false);

		resumeTableEvaluation(TAB);
		await Promise.resolve();
		expect(spy).not.toHaveBeenCalled(); // definition matches the snapshot → no reload
	});

	it('revert restores a sort remapped during the dialog session', async () => {
		setTableSort(TAB, { column: 0, direction: 'asc' });
		await vi.waitFor(() => expect(spy).toHaveBeenCalled());
		spy.mockClear();

		suspendTableEvaluation(TAB);
		// simulate ColumnManager's remove flow: remap the sort alongside the edit
		remapTableSortForRemove(TAB, 0); // sort on the removed column → cleared
		expect(getTableSort(TAB)).toBeUndefined();

		revertSuspendedTableEdits(TAB);
		expect(getTableSort(TAB)).toEqual({ column: 0, direction: 'asc' });
	});

	it('revert before any edit leaves the draft untouched (no spurious dirty)', () => {
		suspendTableEvaluation(TAB);
		revertSuspendedTableEdits(TAB);
		expect(getTableDraft(TAB)!.dirty).toBe(false);
	});

	it('revert is a no-op for a tab that was never suspended', () => {
		updateTableDefinition(TAB, renamed('kept'));
		revertSuspendedTableEdits(TAB);
		expect(getTableDraft(TAB)!.definition.columns[0].header).toBe('kept');
	});

	it('remapTableSortForInsert shifts a sort at/past the insertion point', async () => {
		setTableSort(TAB, { column: 1, direction: 'desc' });
		await vi.waitFor(() => expect(spy).toHaveBeenCalled());
		remapTableSortForInsert(TAB, 1);
		expect(getTableSort(TAB)).toEqual({ column: 2, direction: 'desc' });
		remapTableSortForInsert(TAB, 3); // past the sort → unchanged
		expect(getTableSort(TAB)).toEqual({ column: 2, direction: 'desc' });
	});
```

Note: `getTableSort` and `setTableSort` exist in the store already; check the file's actual export list and import accordingly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/table-editor-staged-edits.test.ts'`
Expected: FAIL — `revertSuspendedTableEdits is not a function` / `remapTableSortForInsert is not a function`.

- [ ] **Step 3: Implement the snapshot + revert**

In `frontend/src/lib/state/table-editor.svelte.ts`:

(a) Beside `_suspendedStale` (~line 310), add:

```ts
/**
 * The draft (definition + dirty) and active sort as they stood when the
 * settings dialog opened — what `revertSuspendedTableEdits` (the dialog's
 * Cancel) restores. Populated by `suspendTableEvaluation`, dropped by
 * resume/abandon, moved by `rekeyTab`, exactly like `_suspended`. The
 * definition is held BY REFERENCE (the column mutators are copy-on-write, so
 * the pre-open object is immutable from the dialog's point of view — no clone
 * needed). Control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _suspendedSnapshot = new Map<
	string,
	{ definition: TableDefinition; dirty: boolean; sort: TableSort | undefined }
>();
```

(b) In `suspendTableEvaluation`, after `_suspended.set(tabId, definitionFingerprint(tabId));`:

```ts
	const draft = _drafts.get(tabId);
	if (draft) {
		_suspendedSnapshot.set(tabId, {
			definition: draft.definition,
			dirty: draft.dirty,
			sort: _sorts.get(tabId)
		});
	}
```

(c) New export, placed after `resumeTableEvaluation`:

```ts
/**
 * The settings dialog's Cancel: restore the draft's definition, dirty flag
 * and the active sort to their values at suspend time, discarding everything
 * `updateTableDefinition` applied while the dialog was open (including sort
 * remaps from remove/move/clone edits). Call BEFORE `resumeTableEvaluation`:
 * the restored definition matches the suspend-time fingerprint, so the resume
 * skips the reload — cancelling an untouched-in-the-end dialog stays free.
 * No-op when the tab was never suspended (there is nothing to revert to).
 */
export function revertSuspendedTableEdits(tabId: string): void {
	const snap = _suspendedSnapshot.get(tabId);
	if (!snap) return;
	const draft = _drafts.get(tabId);
	if (!draft) return;
	if (draft.definition !== snap.definition || draft.dirty !== snap.dirty) {
		_drafts.set(tabId, { ...draft, definition: snap.definition, dirty: snap.dirty });
	}
	if (snap.sort === undefined) _sorts.delete(tabId);
	else _sorts.set(tabId, snap.sort);
}
```

(d) In `resumeTableEvaluation`, next to `_suspended.delete(tabId);` add `_suspendedSnapshot.delete(tabId);`. Same in `abandonTableEvaluationSuspension`.

(e) In `rekeyTab` (~line 698), beside the existing `_suspended` move:

```ts
	const snapshot = _suspendedSnapshot.get(oldTab);
	_suspendedSnapshot.delete(oldTab);
	if (snapshot !== undefined) _suspendedSnapshot.set(newTab, snapshot);
```

(f) After `remapTableSortForMove` (~line 1010), add:

```ts
/** Same contract as `remapTableSortForRemove`, for a single-column INSERTION
 * at `index` (`cloneColumn` inserts at original+1): a sort at or past the
 * insertion point shifts up one so it keeps naming the same column. */
export function remapTableSortForInsert(tabId: string, index: number): void {
	const sort = _sorts.get(tabId);
	if (sort === undefined) return;
	if (sort.column >= index) _sorts.set(tabId, { ...sort, column: sort.column + 1 });
}
```

(g) In `frontend/src/lib/state/index.ts`, add `revertSuspendedTableEdits` and `remapTableSortForInsert` to the `./table-editor.svelte` export list (alphabetical order, matching the file's style).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/table-editor-staged-edits.test.ts'`
Expected: PASS (all, including the pre-existing cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/table-editor.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/table-editor-staged-edits.test.ts
git commit -m "feat(frontend/state): snapshot staged table-settings edits and support revert (Cancel)"
```

---

### Task 2: Cancel/Save footer on the table settings dialog (item 7, UI layer)

**Files:**
- Modify: `frontend/src/lib/components/Table/TableView.svelte` (dialog markup ~lines 488-523, `addColumnFromHeader` comment ~lines 210-230)
- Test: `frontend/src/lib/components/Table/__tests__/TableView.test.ts`

**Interfaces:**
- Consumes: `revertSuspendedTableEdits(tabId: string): void` from Task 1 (via the `$lib/state` barrel).
- Produces: dialog buttons `data-testid="settings-cancel"` and `data-testid="settings-save"`. Close semantics: X/Escape/overlay/Cancel all revert; only Save keeps edits. Both paths still call `resumeTableEvaluation` exactly once.

- [ ] **Step 1: Write the failing test**

`TableView.test.ts` mocks the whole `$lib/state` barrel (see its `vi.mock('$lib/state', ...)` block ~line 45). Add `revertSuspendedTableEdits: vi.fn()` to the mock object, expose it via the hoisted `h` (follow the existing `requestScriptErrors: h.requestScriptErrors` pattern):

In the `vi.hoisted` block add:

```ts
	revertSuspendedTableEdits: vi.fn(),
```

In the `vi.mock('$lib/state', ...)` object add:

```ts
	revertSuspendedTableEdits: h.revertSuspendedTableEdits,
```

Then append these tests (reuse the file's existing `render`, `waitFor`, and dialog-open helpers — the file already has a test that opens the settings dialog by clicking `[data-testid="table-settings-button"]`; follow its idiom exactly, including the bits-ui close-animation `waitFor`):

```ts
	it('Cancel reverts staged edits, then resumes evaluation', async () => {
		const c = render('tbl:draft:1');
		try {
			(document.querySelector('[data-testid="table-settings-button"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="settings-cancel"]'));
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(h.revertSuspendedTableEdits).toHaveBeenCalledWith('tbl:draft:1');
		} finally {
			unmount(c);
		}
	});

	it('Save keeps staged edits (no revert), then resumes evaluation', async () => {
		const c = render('tbl:draft:1');
		try {
			(document.querySelector('[data-testid="table-settings-button"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="settings-save"]'));
			(document.querySelector('[data-testid="settings-save"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('closing via Escape behaves like Cancel', async () => {
		const c = render('tbl:draft:1');
		try {
			(document.querySelector('[data-testid="table-settings-button"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="table-settings-dialog"]'));
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(h.revertSuspendedTableEdits).toHaveBeenCalledWith('tbl:draft:1');
		} finally {
			unmount(c);
		}
	});
```

Also add `h.revertSuspendedTableEdits.mockClear()` wherever the file's `afterEach`/`beforeEach` clears the other `h.*` mocks (it uses `vi.restoreAllMocks()` in `afterEach` — hoisted `vi.fn()`s are not restored by that, so clear it explicitly in a `beforeEach` or at the top of each new test).

Note: if the Escape event doesn't reach bits-ui's dialog in happy-dom, dispatch it on the dialog element instead (`document.querySelector('[data-testid="table-settings-dialog"]')!.dispatchEvent(...)`); if it still doesn't close, drop the Escape test — the X/overlay/Escape paths all flow through the same `onOpenChange(false)` branch the Cancel test already covers via `settingsSaved === false`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/TableView.test.ts'`
Expected: FAIL — `[data-testid="settings-cancel"]` never appears (waitFor timeout).

- [ ] **Step 3: Implement the footer and close semantics**

In `frontend/src/lib/components/Table/TableView.svelte`:

(a) Add `revertSuspendedTableEdits` to the `$lib/state` import list (line 7-32).

(b) Below `let settingsFocus = ...` (~line 160) add:

```ts
	// Set by the Save button just before it closes the dialog, so onOpenChange
	// can tell "Save" apart from every discard path (Cancel, the X, Escape, an
	// overlay click) — those all land in onOpenChange(false) with the flag
	// still false and revert the staged edits first. Plain variable, not
	// $state: control flow only, never rendered.
	let settingsSaved = false;

	function saveSettings(): void {
		settingsSaved = true;
		settingsOpen = false;
	}
```

(c) Replace the `onOpenChange` handler (~lines 491-497) with:

```svelte
			onOpenChange={(o) => {
				if (o) {
					settingsSaved = false;
					return;
				}
				// Every close path (the X, Escape, an overlay click, both footer
				// buttons) lands here. Only Save keeps the staged edits; everything
				// else restores the definition/dirty/sort snapshot taken at open —
				// after which the resume below sees an unchanged definition and
				// skips the reload entirely.
				if (!settingsSaved) revertSuspendedTableEdits(tabId);
				settingsFocus = null;
				resumeTableEvaluation(tabId);
			}}
```

(d) Add the footer inside `Dialog.Content`, between the scrollable `ColumnManager` div and the resize-handle div (~line 509):

```svelte
				<div class="flex shrink-0 items-center justify-end gap-2 border-t border-border pt-2">
					<button
						type="button"
						data-testid="settings-cancel"
						class="rounded border border-input px-3 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
						onclick={() => (settingsOpen = false)}
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="settings-save"
						class="rounded bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80"
						onclick={saveSettings}
					>
						Save
					</button>
				</div>
```

(e) Update the stale comment in `addColumnFromHeader` (~lines 222-229): replace the sentence `adding a column and then cancelling out of it correctly evaluates once (the column is still there) — abandoning the column is a Remove away.` with `the snapshot taken here is the PRE-append definition, so the dialog's Cancel discards the new column entirely (and Save keeps it).`

(f) Embedded navigation drafts (spec item 7, last bullet): an inline navigation column's edits reach the table definition via `updateTableDefinition`, so the snapshot restore covers them — but the navigation-editor store's EMBEDDED draft for that column may still hold the edited definition after Cancel. Verify the lifecycle: NavigationColumnEditor / RowSourceEditor close their embedded drafts on unmount (the dialog closing unmounts them — look for the `closeDraft` call in `NavigationColumnEditor.svelte`'s teardown), and reopening the dialog re-seeds embedded drafts from the (reverted) column definition. If closing does NOT happen on unmount, call the navigation-editor store's `closeDraft` for the tab's embedded drafts in the Cancel path, and cover it in Task 9's manual smoke: edit an inline navigation column's chain, Cancel, reopen — the chain must show the original steps.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/TableView.test.ts'`
Expected: PASS (new tests plus every pre-existing test in the file — the old "close via X resumes evaluation" style tests still hold because resume still fires on every close).

- [ ] **Step 5: Run the full frontend suite + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS. If `ColumnManager.collapse.test.ts` or reorder tests fail, something in the close path regressed — do not proceed until green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Table/TableView.svelte frontend/src/lib/components/Table/__tests__/TableView.test.ts
git commit -m "feat(frontend/table): Cancel/Save footer on the settings dialog; x discards staged edits"
```

---

### Task 3: `cloneColumn` pure helper (item 8, logic layer)

**Files:**
- Modify: `frontend/src/lib/table/columns.ts`
- Test: `frontend/src/lib/table/__tests__/columns.test.ts`

**Interfaces:**
- Consumes: existing `clone(defn)` shell, `Column`/`TableDefinition` types.
- Produces: `export function cloneColumn(defn: TableDefinition, index: number): TableDefinition` — deep-copies the column at `index`, inserts the copy at `index + 1`, suffixes a non-empty header with ` (copy)`, shifts every `ColumnRef.index > index` up by one. Task 4's UI button calls it.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/table/__tests__/columns.test.ts` (add `cloneColumn` to the import list; the file's `base` definition and column builders are already there):

```ts
	describe('cloneColumn', () => {
		it('inserts a deep copy right after the original with a "(copy)" header', () => {
			const withProp = addColumn(base, { ...newPropertyColumn(), name: 'mass', header: 'Mass' });
			const d = cloneColumn(withProp, 1);
			expect(d.columns).toHaveLength(3);
			expect(d.columns[2]).toMatchObject({ kind: 'property', name: 'mass', header: 'Mass (copy)' });
			expect(withProp.columns).toHaveLength(2); // input untouched
		});

		it('keeps an empty header empty (the grid falls back to the kind label)', () => {
			const d = cloneColumn(base, 0);
			expect(d.columns[1].header).toBe('');
		});

		it('shares no references with the original (inline nav definition fully copied)', () => {
			const nav = {
				...newNavigationColumn(),
				navigation: {
					definition: {
						kind: 'path' as const,
						schema_version: 2,
						start: { kind: 'row' as const },
						steps: [],
						exclude_visited: true
					}
				}
			};
			const withNav = addColumn(base, nav);
			const d = cloneColumn(withNav, 1);
			const src = d.columns[1];
			const copy = d.columns[2];
			expect(copy).not.toBe(src);
			if (src.kind === 'navigation' && copy.kind === 'navigation') {
				expect(copy.navigation).not.toBe(src.navigation);
				expect(copy.navigation.definition).not.toBe(src.navigation.definition);
				expect(copy.navigation.definition).toEqual(src.navigation.definition);
			} else {
				throw new Error('expected navigation columns');
			}
		});

		it('shifts ColumnRefs past the insertion point and leaves refs at/before it alone', () => {
			// cols: [element(0), property(1), property sourced from column 1 (2)]
			let d = addColumn(base, { ...newPropertyColumn(), name: 'a' });
			d = addColumn(d, {
				...newPropertyColumn(),
				name: 'b',
				source: { kind: 'column', index: 1 }
			});
			// clone column 0 → [element(0), CLONE(1), property(2), ref-column(3)]
			const out = cloneColumn(d, 0);
			expect(out.columns).toHaveLength(4);
			// the ref pointed at old index 1, which is now index 2
			const ref = out.columns[3];
			expect(ref.source).toEqual({ kind: 'column', index: 2 });
			// cloning the REFERENCED column keeps the ref on the ORIGINAL
			const out2 = cloneColumn(d, 1);
			const ref2 = out2.columns[3];
			expect(ref2.source).toEqual({ kind: 'column', index: 1 });
		});

		it('the clone of a ref-sourced column keeps its own (backward) ref valid', () => {
			let d = addColumn(base, { ...newPropertyColumn(), name: 'a' });
			d = addColumn(d, {
				...newPropertyColumn(),
				name: 'b',
				source: { kind: 'column', index: 1 }
			});
			const out = cloneColumn(d, 2); // clone the ref-carrying column
			expect(out.columns[3].source).toEqual({ kind: 'column', index: 1 });
		});

		it('round-trips through the zod schema (clone output is a valid definition)', () => {
			const withNav = addColumn(base, newNavigationColumn());
			const d = cloneColumn(withNav, 1);
			expect(() => TableDefinitionSchema.parse(d)).not.toThrow();
		});
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/table/__tests__/columns.test.ts'`
Expected: FAIL — `cloneColumn is not a function` (import error).

- [ ] **Step 3: Implement `cloneColumn`**

Add to `frontend/src/lib/table/columns.ts`, after `removeColumn` (~line 129):

```ts
/**
 * Deep-copy the column at `index` and insert the copy immediately after it.
 * A non-empty header gains a ` (copy)` suffix; an empty one stays empty (the
 * grid already falls back to the kind label).
 *
 * The copy is a plain-JSON round-trip, deliberately NOT `structuredClone`
 * (see module doc, subtlety 2 — a leaked `$state` proxy bricks it) and NOT a
 * reference-preserving shallow copy: the whole point of a clone is that
 * editing it (its inline navigation/snippet definition included) can never
 * bleed into the original, so the two must share no references at all.
 *
 * Ref bookkeeping mirrors `removeColumn`'s shift-down, in reverse: every
 * `ColumnRef.index` pointing PAST `index` shifts up one (its target moved).
 * Refs pointing AT `index` keep pointing at the original, and the clone's own
 * source ref — backward-only by schema invariant, so always `<= index` — is
 * untouched and stays valid. Callers with an active sort must remap it with
 * `remapTableSortForInsert(tabId, index + 1)` in the same breath.
 */
export function cloneColumn(defn: TableDefinition, index: number): TableDefinition {
	const src = defn.columns[index];
	const copy = JSON.parse(JSON.stringify(src)) as Column;
	if (copy.header) copy.header = `${copy.header} (copy)`;
	const next = clone(defn);
	// copy-on-write: only the columns whose ref actually shifts are re-made
	next.columns = next.columns.map((c) =>
		c.source.kind === 'column' && c.source.index > index
			? { ...c, source: { ...c.source, index: c.source.index + 1 } }
			: c
	);
	next.columns.splice(index + 1, 0, copy);
	return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/table/__tests__/columns.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/table/columns.ts frontend/src/lib/table/__tests__/columns.test.ts
git commit -m "feat(frontend/table): cloneColumn pure helper with ref shifting and deep copy"
```

---

### Task 4: Clone button in the settings column list (item 8, UI layer)

**Files:**
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte`
- Test: `frontend/src/lib/components/Table/__tests__/ColumnManager.test.ts`

**Interfaces:**
- Consumes: `cloneColumn` (Task 3), `remapTableSortForInsert` (Task 1), existing `tryApply`/`apply` plumbing in ColumnManager.
- Produces: per-row button `data-testid="clone-column-{i}"` (visible only in the full-list view, `focusIndex === null`, like remove/reorder).

- [ ] **Step 1: Write the failing test**

Open `frontend/src/lib/components/Table/__tests__/ColumnManager.test.ts` and check its setup style first. If it mounts against the REAL stores (like `ColumnManager.collapse.test.ts`), add the test below with this self-contained seed helper (imports mirror the collapse test's: `ensureTableDraft`, `getTableDraft`, `updateTableDefinition`, `resetTableEditors`, etc. from `$lib/state`; `flushSync`, `mount`, `unmount` from `svelte`). If it mocks `$lib/state` instead, add `remapTableSortForInsert: vi.fn()` to the mock and assert on the `updateTableDefinition` mock's argument rather than `getTableDraft`.

```ts
const TAB = 'tbl:draft:clone-test';

async function seedForClone(): Promise<void> {
	await ensureTableDraft(TAB);
	const defn: TableDefinition = {
		schema_version: 1,
		default_cell_mode: 'collapse',
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns: [
			{
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: 'Block',
				width_px: null,
				hidden: false
			},
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'mass',
				mode: 'collapse',
				keep_empty: true,
				header: 'Mass',
				width_px: null,
				hidden: false
			}
		]
	};
	updateTableDefinition(TAB, defn);
	flushSync();
}

it('clone button inserts a "(copy)" duplicate right below the original', async () => {
	await seedForClone();
	const c = mount(ColumnManager, { target: document.body, props: { tabId: TAB } });
	flushSync();
	try {
		const clone = document.querySelector('[data-testid="clone-column-1"]') as HTMLButtonElement;
		expect(clone).toBeTruthy();
		clone.click();
		flushSync();
		const defn = getTableDraft(TAB)!.definition;
		expect(defn.columns).toHaveLength(3);
		expect(defn.columns[2].header).toBe('Mass (copy)');
		expect(defn.columns[2].kind).toBe('property');
	} finally {
		unmount(c);
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/ColumnManager.test.ts'`
Expected: FAIL — `clone-column-1` not found.

- [ ] **Step 3: Implement the button**

In `frontend/src/lib/components/Table/ColumnManager.svelte`:

(a) Import `Copy` alongside `Eye, EyeOff` from `@lucide/svelte`; add `cloneColumn` to the `$lib/table/columns` import and `remapTableSortForInsert` to the `$lib/state` import.

(b) Add the handler beside `onRemove`:

```ts
	// Insert a deep copy right after the original. The sort is remapped in the
	// same breath (a sort at/past the insertion point must follow its column),
	// mirroring how onRemove/onMove pair their mutator with a sort remap.
	function onClone(index: number): void {
		if (!defn) return;
		const current = defn;
		tryApply(() => {
			const next = cloneColumn(current, index);
			remapTableSortForInsert(tabId, index + 1);
			return next;
		});
	}
```

(c) `TableView.test.ts` mocks the whole `$lib/state` barrel and mounts ColumnManager when its dialog-opening tests run — a barrel import ColumnManager gains but the mock lacks fails the mount. Add `remapTableSortForInsert: vi.fn()` to `TableView.test.ts`'s `vi.mock('$lib/state', ...)` object in this task.

(d) Add the button in the per-column controls row, immediately before the remove button (inside the existing `{#if focusIndex === null}` guard that wraps remove, ~line 249):

```svelte
									<button
										type="button"
										data-testid="clone-column-{i}"
										class="rounded border border-input px-1 py-0.5 text-[10px] hover:bg-muted"
										aria-label="Duplicate column"
										title="Duplicate this column (inserted below)"
										onclick={() => onClone(i)}
									>
										<Copy class="size-3" />
									</button>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/ColumnManager.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Table/ColumnManager.svelte frontend/src/lib/components/Table/__tests__/ColumnManager.test.ts
git commit -m "feat(frontend/table): clone-column button in table settings"
```

---

### Task 5: Collapsible snippet editors in column/step editing (item 9)

**Files:**
- Create: `frontend/src/lib/state/snippet-collapse.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts`
- Modify: `frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte`
- Modify: `frontend/src/lib/components/Table/ScriptColumnEditor.svelte` (new `tabId` prop)
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte` (pass `tabId` to ScriptColumnEditor)
- Modify: `frontend/src/lib/components/Navigation/ScriptStepRow.svelte` (new `collapseKey` prop)
- Modify: `frontend/src/lib/components/Navigation/PathCard.svelte` (build + pass `collapseKey`)
- Test: `frontend/src/lib/components/Table/__tests__/ScriptColumnEditor.test.ts`, `frontend/src/lib/components/Navigation/__tests__/script-step-row.test.ts`, plus a durability test in `frontend/src/lib/components/Table/__tests__/ColumnManager.collapse.test.ts`

**Interfaces:**
- Produces: store module with `isSnippetExpanded(key: string): boolean`, `setSnippetExpanded(key: string, expanded: boolean): void`, `resetSnippetCollapse(): void` (all exported from the `$lib/state` barrel). `SnippetSourceEditor` gains optional prop `collapseKey?: string` — when provided the editor renders a chevron disclosure, default collapsed, with toggle `data-testid="snippet-collapse-toggle"` (`aria-expanded`) and summary `data-testid="snippet-collapse-summary"`; when absent it renders exactly as today. `ScriptColumnEditor` gains required prop `tabId: string`. `ScriptStepRow` gains required prop `collapseKey: string`.
- Key formats: table column → `` `${tabId}::col:${columnIndex}` ``; nav step → `` `${tabId}::${pathKey(path)}::step:${index}` ``.

- [ ] **Step 1: Write the failing tests**

(a) In `frontend/src/lib/components/Table/__tests__/ScriptColumnEditor.test.ts`: the component gains a required `tabId` prop — add `tabId: 'tbl:draft:sce'` to every existing `mount(...)` props object, and for existing assertions that reach inside the snippet editor (mode buttons, code editor, test panel), first click the new toggle. If this test file (or `script-step-row.test.ts`) mocks the `$lib/state` barrel, add the three new exports to the mock — preferably re-exporting the real implementations: `...await vi.importActual('$lib/state/snippet-collapse.svelte')` — so toggle clicks actually flip state:

```ts
	function expandSnippet(root: ParentNode = document): void {
		const t = root.querySelector('[data-testid="snippet-collapse-toggle"]') as HTMLButtonElement;
		t.click();
		flushSync();
	}
```

Add new tests to the file's describe block (match its existing mount/props helpers):

```ts
	it('renders the snippet editor collapsed by default with a summary line', () => {
		// mount with an inline-snippet column (code: 'def value(elements):\n    return 1')
		const toggle = document.querySelector('[data-testid="snippet-collapse-toggle"]');
		expect(toggle?.getAttribute('aria-expanded')).toBe('false');
		expect(document.querySelector('[data-testid="snippet-mode-inline"]')).toBeNull();
		const summary = document.querySelector('[data-testid="snippet-collapse-summary"]');
		expect(summary?.textContent).toContain('value()');
		expect(summary?.textContent).toContain('def value(elements):');
	});

	it('expanding reveals the full editor', () => {
		expandSnippet();
		expect(
			document
				.querySelector('[data-testid="snippet-collapse-toggle"]')
				?.getAttribute('aria-expanded')
		).toBe('true');
		expect(document.querySelector('[data-testid="snippet-mode-inline"]')).not.toBeNull();
	});
```

Each test needs `resetSnippetCollapse()` in the shared `beforeEach`/`afterEach` (import from `$lib/state`) so collapse state never leaks between tests.

(b) In `frontend/src/lib/components/Navigation/__tests__/script-step-row.test.ts`: add `collapseKey: 'nav:t::[]::step:0'` to every mount's props; add the same default-collapsed + expand test pair (the toggle/summary testids are identical — they live in the shared SnippetSourceEditor).

(c) In `frontend/src/lib/components/Table/__tests__/ColumnManager.collapse.test.ts`, add a durability case to the existing describe (its `seed`/`click` helpers work as-is; seed a SCRIPT column instead of a nav column):

```ts
	it('an expanded snippet editor stays expanded when a column is added', async () => {
		await seedScript(); // helper below
		const root = document.body;
		const c = mount(ColumnManager, { target: root, props: { tabId: TAB } });
		flushSync();
		try {
			const toggle = root.querySelector(
				'[data-testid="snippet-collapse-toggle"]'
			) as HTMLButtonElement;
			expect(toggle.getAttribute('aria-expanded')).toBe('false'); // default collapsed
			toggle.click();
			flushSync();
			expect(toggle.getAttribute('aria-expanded')).toBe('true');

			click('[data-testid="add-property-column"]');
			await Promise.resolve();
			flushSync();

			const t2 = root.querySelector(
				'[data-testid="snippet-collapse-toggle"]'
			) as HTMLButtonElement;
			expect(t2.getAttribute('aria-expanded')).toBe('true'); // survived the re-render
		} finally {
			unmount(c);
		}
	});
```

with the seeding helper (beside `seed`):

```ts
async function seedScript(): Promise<void> {
	await ensureTableDraft(TAB);
	const defn: TableDefinition = {
		schema_version: 1,
		default_cell_mode: 'collapse',
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns: [
			{
				kind: 'script',
				source: { kind: 'row', chain_index: 0 },
				snippet: {
					definition: {
						schema_version: 1,
						language: 'python',
						code: 'def value(elements):\n    return 1',
						entry_points: []
					}
				},
				mode: 'collapse',
				keep_empty: true,
				header: 'S',
				width_px: null,
				hidden: false
			}
		]
	};
	updateTableDefinition(TAB, defn);
	flushSync();
}
```

and `resetSnippetCollapse()` added to this file's `beforeEach`/`afterEach` blocks (import from `$lib/state`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/ScriptColumnEditor.test.ts src/lib/components/Navigation/__tests__/script-step-row.test.ts src/lib/components/Table/__tests__/ColumnManager.collapse.test.ts'`
Expected: FAIL — no `snippet-collapse-toggle` element; `resetSnippetCollapse` unresolved import.

- [ ] **Step 3: Create the collapse store**

`frontend/src/lib/state/snippet-collapse.svelte.ts`:

```ts
/**
 * Collapse state for EMBEDDED `SnippetSourceEditor`s (a table script column's
 * snippet, a navigation script step's snippet), keyed by a caller-built
 * stable key (`{tabId}::col:{i}` / `{tabId}::{pathKey}::step:{i}`).
 *
 * Store-backed for the same reason PathCard's disclosure is (see
 * `_cardCollapsed` in navigation-editor.svelte.ts): component-local $state
 * silently resets to the default whenever the editor remounts — a dialog
 * reopen, a card re-render. The default is COLLAPSED: a settings dialog full
 * of open code editors is unreadable.
 *
 * Keys embed the column/step index. A reorder or mid-list insert can
 * therefore re-associate a choice with a neighbouring editor; that is a
 * cosmetic, self-healing miss (the next toggle fixes it), accepted instead of
 * replicating navigation-editor's structural remapping for a disclosure flag.
 */
import { SvelteMap } from 'svelte/reactivity';

const _expanded = new SvelteMap<string, boolean>();

export function isSnippetExpanded(key: string): boolean {
	return _expanded.get(key) ?? false;
}

export function setSnippetExpanded(key: string, expanded: boolean): void {
	_expanded.set(key, expanded);
}

/** Test isolation. */
export function resetSnippetCollapse(): void {
	_expanded.clear();
}
```

Export all three from `frontend/src/lib/state/index.ts` (new `export { ... } from './snippet-collapse.svelte';` block, matching the barrel's style).

- [ ] **Step 4: Add the disclosure to SnippetSourceEditor**

In `frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte`:

(a) Extend props (line 18-26):

```ts
	let {
		snippet,
		entry,
		onChange,
		collapseKey
	}: {
		snippet: SnippetSource;
		entry: BoundEntry;
		onChange: (next: SnippetSource) => void;
		/** When set, the editor renders behind a chevron disclosure (default
		 * collapsed) whose expansion state lives in the snippet-collapse store
		 * under this key — survives re-renders and dialog reopens. Absent =
		 * always expanded, no chevron (no current consumer does this, but the
		 * fallback keeps the component droppable anywhere). */
		collapseKey?: string;
	} = $props();
```

(b) Imports: `ChevronDown, ChevronRight` from `@lucide/svelte`; `isSnippetExpanded, setSnippetExpanded, getArtifactHeaders` from `$lib/state` (the file already imports `getArtifactHeaders` — extend that import).

(c) Derived state, after the `refMissing` derivation:

```ts
	const expanded = $derived(collapseKey === undefined || isSnippetExpanded(collapseKey));
	// One line that says what's behind the fold: the entry point + first code
	// line for inline snippets, the referenced artifact's name for refs.
	const summary = $derived.by(() => {
		if (inline) {
			const first =
				(snippet.definition?.code ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
			return `${entry}() · ${first.trim() || 'empty snippet'}`;
		}
		if (!snippet.ref) return 'no snippet selected';
		const ref = refOptions.find((h) => h.id === snippet.ref);
		return ref ? `saved: ${ref.name}` : 'saved snippet (missing)';
	});
```

(d) Markup: at the top of the root `<div data-testid="snippet-source-editor" ...>`, before the mode-toggle row, add:

```svelte
	{#if collapseKey !== undefined}
		<button
			type="button"
			data-testid="snippet-collapse-toggle"
			aria-expanded={expanded}
			aria-label={expanded ? 'Collapse snippet' : 'Expand snippet'}
			class="flex w-full items-center gap-1 text-left text-muted-foreground/80 transition-colors hover:text-foreground"
			onclick={() => setSnippetExpanded(collapseKey, !expanded)}
		>
			{#if expanded}<ChevronDown class="size-3.5 shrink-0" />{:else}<ChevronRight
					class="size-3.5 shrink-0"
				/>{/if}
			<span data-testid="snippet-collapse-summary" class="truncate font-mono text-[10px]"
				>{summary}</span
			>
		</button>
	{/if}
	{#if expanded}
		<!-- existing content: mode toggle, ref select / code editor, warnings, test panel -->
	{/if}
```

i.e. wrap EVERYTHING currently inside the root div (the mode-toggle row, the `{#if !inline}` ref block, the `{:else if snippet.definition}` code block, and `<SnippetTestPanel>`) in the `{#if expanded}` block. The lint `$effect` stays as-is (it is script-level, unaffected by the fold).

(e) Hosts:

- `ScriptColumnEditor.svelte`: add required `tabId: string` to props; pass `collapseKey={`${tabId}::col:${columnIndex}`}` to `<SnippetSourceEditor>`.
- `ColumnManager.svelte`: pass `{tabId}` to `<ScriptColumnEditor ... />` (it already has `tabId` in scope).
- `ScriptStepRow.svelte`: add required `collapseKey: string` to `Props`; pass it through to `<SnippetSourceEditor ... collapseKey={collapseKey} />`.
- `PathCard.svelte`: at the `<ScriptStepRow>` call site (~line 483), add `collapseKey={`${tabId}::${pathKey(path)}::step:${i}`}`. PathCard already has `tabId` and `path` in scope; import `pathKey` from `$lib/navigation/tree` if not already imported (check the file's import block — it likely is, for `previewKey` usage).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/ScriptColumnEditor.test.ts src/lib/components/Navigation/__tests__/script-step-row.test.ts src/lib/components/Table/__tests__/ColumnManager.collapse.test.ts'`
Expected: PASS.

- [ ] **Step 6: Run the full frontend suite + svelte-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS. `npm run check` is the required-prop net: it fails on every `<ScriptColumnEditor>` / `<ScriptStepRow>` call site that wasn't updated.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/state/snippet-collapse.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte frontend/src/lib/components/Table/ScriptColumnEditor.svelte frontend/src/lib/components/Table/ColumnManager.svelte frontend/src/lib/components/Navigation/ScriptStepRow.svelte frontend/src/lib/components/Navigation/PathCard.svelte frontend/src/lib/components/Table/__tests__/ScriptColumnEditor.test.ts frontend/src/lib/components/Navigation/__tests__/script-step-row.test.ts frontend/src/lib/components/Table/__tests__/ColumnManager.collapse.test.ts
git commit -m "feat(frontend): collapsible snippet editors in table-column and nav-step editing"
```

---

### Task 6: Rewrite the Excel export on xlsxwriter — autofit, borders, header filters (item 11)

**Files:**
- Modify: `pixi.toml` (line 34 area, `[feature.api.dependencies]`)
- Modify: `src/data_rover/api/table_export.py` (full rewrite)
- Modify: `src/data_rover/api/routes/tables.py` (call site, lines 713-765)
- Test: `tests/api/test_table_export.py`

**Interfaces:**
- Consumes: `iter_export_rows` output (unchanged), core cell dataclasses (unchanged).
- Produces: `build_workbook(model: Model, headers: list[str], sheet_name: str, row_iter: Iterable[list[Cell]], *, notice_provider: Callable[[], str | None] | None = None) -> bytes` — NOTE: the `widths` parameter is GONE (autofit always wins per spec). Task 7 extends this signature with `row_numbers: bool = False`.

- [ ] **Step 1: Add the dependency**

In `pixi.toml` under `[feature.api.dependencies]`, after `openpyxl = "3.1.*"` / `types-openpyxl = "3.1.*"` (which STAY — the test suite reads workbooks back with openpyxl; xlsxwriter cannot read), add:

```toml
xlsxwriter = "3.2.*"
```

Run: `pixi install -e core-dev` — expected: solves and installs cleanly.
Then verify: `pixi run -e core-dev python -c "import xlsxwriter; print(xlsxwriter.__version__)"` — expected: a 3.2.x version.

- [ ] **Step 2: Write the failing test**

Append to `tests/api/test_table_export.py`:

```python
def test_export_styling_autofit_filters_borders(client):
    # Item 11: the workbook ships with header-filter dropdowns, borders, bold
    # header, frozen header row, and autofitted column widths.
    _bootstrap_model(client)
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "mass",
                    "header": "Mass",
                    # a definition width must NOT drive the export any more
                    "width_px": 700,
                },
            ],
        }
    }
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    assert ws is not None
    # header filters span the data range (header row through the last data row)
    assert ws.auto_filter.ref is not None
    assert ws.auto_filter.ref.startswith("A1:B")
    # frozen header row survives the library swap
    assert ws.freeze_panes == "A2"
    # bold header with a heavier bottom edge; thin borders on data cells
    hdr = ws["A1"]
    assert hdr.font.b
    assert hdr.border.bottom.style == "medium"
    data = ws["A2"]
    assert data.border.left.style == "thin"
    assert data.border.bottom.style == "thin"
    # autofit set a real width, and the 700px definition width did not win
    # (700px under the old px/7 heuristic would exceed 90 char-units)
    w = ws.column_dimensions["B"].width
    assert w is not None and 0 < w < 90
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py::test_export_styling_autofit_filters_borders -v`
Expected: FAIL — `ws.auto_filter.ref` is `None` (current builder sets no autofilter).

- [ ] **Step 4: Rewrite `table_export.py`**

Replace the entire content of `src/data_rover/api/table_export.py` with:

```python
"""xlsx writer for table export. Lives in the API layer (core stays xlsx-free).
Consumes core cell dataclasses and produces workbook bytes.

xlsxwriter in normal (in-memory) mode, NOT the old openpyxl write-only
streaming: `worksheet.autofit()` needs the whole sheet's cell data to measure
(xlsxwriter itself warns and no-ops in `constant_memory` mode, and openpyxl
has no working autofit at all — its `bestFit` flag is ignored by Excel). The
bounded-peak-memory property the old streaming builder had is consciously
traded away for the export path (spec:
docs/superpowers/specs/2026-07-24-table-panel-polish-pack-design.md, item 11);
`iter_export_rows` still feeds this chunk-by-chunk, xlsxwriter accumulates.

openpyxl remains a test-suite dependency (it READS workbooks back; xlsxwriter
is write-only).
"""

from __future__ import annotations

import io
from collections.abc import Callable, Iterable

import xlsxwriter

from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name
from data_rover.core.table.cells import (
    Cell,
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)

#: Autofit cap, in pixels (~43 characters): one huge cell must not blow a
#: column out to an unusable width. Excel's own hard cap is 1790px.
AUTOFIT_MAX_PX = 300

#: xlsx forbids these in a sheet name; the old openpyxl builder let them
#: bubble up as a 422 (`ValueError`), xlsxwriter would raise a non-ValueError
#: and 500 — sanitizing is strictly kinder than either.
_INVALID_SHEET_CHARS = set("[]:*?/\\")


def _sheet_title(name: str) -> str:
    cleaned = "".join("_" if ch in _INVALID_SHEET_CHARS else ch for ch in name)
    return (cleaned.strip("'") or "Table")[:31]


def _display(model: Model, eid: str) -> str:
    # shared case-insensitive `name` lookup — same label the grid displays
    return display_name(model.elements[eid])


def _cell_text(model: Model, cell: Cell) -> object:
    """Map one core cell dataclass to the xlsx value it should render as."""
    if isinstance(cell, ElementCell):
        return _display(model, cell.element_id) if cell.element_id else ""
    if isinstance(cell, ValueCell):
        return "" if not cell.present or cell.value is None else cell.value
    if isinstance(cell, ValuesCell):
        return "; ".join(str(v) for v in cell.values)
    if isinstance(cell, ErrorCell):
        return f"#ERROR: {cell.message}"
    if isinstance(cell, PendingCell):
        # Only reachable when exporting after a FAILED sweep (Task 8): a
        # completed sweep leaves no pending cells, so this path is a
        # last-resort rendering rather than an expected export outcome.
        return "#ERROR: not computed"
    assert isinstance(cell, ElementsCell)
    return "; ".join(_display(model, e) for e in cell.element_ids)


def build_workbook(
    model: Model,
    headers: list[str],
    sheet_name: str,
    row_iter: Iterable[list[Cell]],
    *,
    notice_provider: Callable[[], str | None] | None = None,
) -> bytes:
    """Render `row_iter` into a single-sheet workbook: bold bordered header
    row with filter dropdowns and frozen panes, thin borders on every data
    cell, and column widths autofitted to content (capped at
    `AUTOFIT_MAX_PX`; definition `width_px` values are deliberately ignored —
    on-screen widths are a display preference, the export always autofits).

    `notice_provider`, if given, is called AFTER `row_iter` is fully consumed
    (not before) — callers whose "should there be a notice" flag only settles
    once every lazily-evaluated cell has been visited (e.g. a script column's
    error flag) must defer that decision to this point rather than computing
    it up front. A truthy return appends one trailing single-cell row, OUTSIDE
    the autofilter range (a notice is not a data row to filter on)."""
    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {"in_memory": True})
    ws = wb.add_worksheet(_sheet_title(sheet_name))
    header_fmt = wb.add_format({"bold": True, "border": 1, "bottom": 2})
    cell_fmt = wb.add_format({"border": 1})

    for col, h in enumerate(headers):
        ws.write(0, col, h, header_fmt)
    ws.freeze_panes(1, 0)

    r = 0
    for r, row in enumerate(row_iter, start=1):
        for col, cell in enumerate(row):
            ws.write(r, col, _cell_text(model, cell), cell_fmt)

    if headers:
        ws.autofilter(0, 0, r, len(headers) - 1)

    if notice_provider is not None:
        text = notice_provider()
        if text:
            ws.write(r + 1, 0, text)

    ws.autofit(AUTOFIT_MAX_PX)
    wb.close()
    return buf.getvalue()
```

(`_cell_text` and `_display` are copied unchanged from the current file.)

- [ ] **Step 5: Update the call site**

In `src/data_rover/api/routes/tables.py`:

(a) Delete line 715 (`widths = [defn.columns[i].width_px for i in visible]`) and the word `widths` from the comment above it if it mentions widths (line 711-712 comment says "filter headers/widths AND each row's cells" → change to "filter headers AND each row's cells").

(b) Update the `build_workbook` call (~line 758):

```python
        blob = build_workbook(
            model,
            headers,
            name,
            ([row[i] for i in visible] for row in all_rows),
            notice_provider=_notice,
        )
```

- [ ] **Step 6: Run the export test suite**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py -v`
Expected: ALL PASS — the four pre-existing tests (headers/rows, truncation, cell-cap, hidden columns) read the workbook back with openpyxl and are agnostic to the writing library; plus the new styling test.

If mypy later complains `import-untyped` for xlsxwriter (Step 7), append `# type: ignore[import-untyped]` to the `import xlsxwriter` line — xlsxwriter ≥3.2 ships `py.typed`, so this should not be needed.

- [ ] **Step 7: Run the wider gates**

Run: `pixi run -e core-dev pytest tests/api/ -x -q` then `pixi run backend-lint`
Expected: PASS (ruff, mypy, pyright). `tests/api/test_tables_routes.py` and `test_tables_script_status.py` exercise the export route's 202/degraded paths and must stay green.

- [ ] **Step 8: Commit**

```bash
git add pixi.toml pixi.lock src/data_rover/api/table_export.py src/data_rover/api/routes/tables.py tests/api/test_table_export.py
git commit -m "feat(api/export): xlsxwriter workbook with autofit, borders and header filters"
```

---

### Task 7: `show_row_numbers` — backend flag + export column (item 10, backend)

**Files:**
- Modify: `src/data_rover/core/table/schema.py` (`TableDefinition`, ~line 167)
- Modify: `src/data_rover/api/table_export.py` (`build_workbook` signature)
- Modify: `src/data_rover/api/routes/tables.py` (export call site)
- Test: `tests/api/test_table_export.py`

**Interfaces:**
- Consumes: Task 6's builder.
- Produces: `TableDefinition.show_row_numbers: bool = False` (pydantic, backward compatible — absent on old artifacts). `build_workbook(..., row_numbers: bool = False)` — when true, prepends a `#` header and writes the 1-based row index as the first cell of every data row. Task 8's frontend mirrors the field.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_table_export.py`:

```python
def test_export_row_numbers_column(client):
    # Item 10: `show_row_numbers` prepends a 1-based "#" column, numbered in
    # export row order (which follows the current sort).
    _bootstrap_model(client)
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "show_row_numbers": True,
            "columns": [
                {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            ],
        }
    }
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    assert ws is not None
    header = [c.value for c in ws[1]]
    assert header[0] == "#"
    assert header[1] == "Block"
    numbers = [row[0].value for row in ws.iter_rows(min_row=2) if row[0].value is not None]
    assert numbers == list(range(1, len(numbers) + 1))
    # the autofilter spans the "#" column too
    assert ws.auto_filter.ref.startswith("A1:B")


def test_export_row_numbers_off_by_default(client):
    _bootstrap_model(client)
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            ],
        }
    }
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    assert [c.value for c in ws[1]] == ["Block"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py -k row_numbers -v`
Expected: `test_export_row_numbers_column` FAILS (header is `["Block"]`, no `#`); the off-by-default test passes already (fine — it pins the default).

- [ ] **Step 3: Implement**

(a) `src/data_rover/core/table/schema.py`, in `TableDefinition` after `default_cell_mode` (~line 171):

```python
    #: Presentation flag: render a 1-based "#" first column in the grid and
    #: prepend the same column to the xlsx export. Not a real column — it
    #: never participates in ColumnRef indexing, sorting, or evaluation.
    show_row_numbers: bool = False
```

(b) `src/data_rover/api/table_export.py` — extend `build_workbook`:

Signature gains `row_numbers: bool = False` (after `notice_provider`). Body changes (full replacement of the header/body/autofilter section shown in Task 6 Step 4):

```python
    cols = ["#", *headers] if row_numbers else headers
    for col, h in enumerate(cols):
        ws.write(0, col, h, header_fmt)
    ws.freeze_panes(1, 0)

    offset = 1 if row_numbers else 0
    r = 0
    for r, row in enumerate(row_iter, start=1):
        if row_numbers:
            ws.write_number(r, 0, r, cell_fmt)
        for col, cell in enumerate(row, start=offset):
            ws.write(r, col, _cell_text(model, cell), cell_fmt)

    if cols:
        ws.autofilter(0, 0, r, len(cols) - 1)
```

and the docstring gains one line: `` `row_numbers` prepends a 1-based "#" column (spec item 10) — numbering follows export row order, which follows the requested sort. ``

(c) `src/data_rover/api/routes/tables.py`, export call site:

```python
        blob = build_workbook(
            model,
            headers,
            name,
            ([row[i] for i in visible] for row in all_rows),
            notice_provider=_notice,
            row_numbers=defn.show_row_numbers,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py -v`
Expected: ALL PASS (both new tests and every earlier one).

- [ ] **Step 5: Run wider gates**

Run: `pixi run -e core-dev pytest tests/api/ -x -q && pixi run backend-lint && pixi run core-lint`
Expected: PASS. (`core-lint` covers the `schema.py` change.)

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/table/schema.py src/data_rover/api/table_export.py src/data_rover/api/routes/tables.py tests/api/test_table_export.py
git commit -m "feat(table): show_row_numbers definition flag; '#' column in xlsx export"
```

---

### Task 8: Row-number gutter in the grid + settings toggle (item 10, frontend)

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (`TableDefinitionSchema`, ~line 760)
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte` (toggle)
- Modify: `frontend/src/lib/components/Table/TableGrid.svelte` (gutter)
- Test: `frontend/src/lib/components/Table/__tests__/TableGrid.test.ts`, `frontend/src/lib/components/Table/__tests__/ColumnManager.test.ts`

**Interfaces:**
- Consumes: Task 7's backend field (the zod schema mirrors it; old saved artifacts default to `false` via `.default(false)`).
- Produces: `show_row_numbers` on the frontend `TableDefinition`; grid elements `data-testid="row-number-header"` / `data-testid="row-number-cell"`; settings checkbox `data-testid="toggle-row-numbers"`.

- [ ] **Step 1: Write the failing tests**

(a) Append to `frontend/src/lib/components/Table/__tests__/TableGrid.test.ts` (its `PAGE`/`DRAFT` fixtures and `render` helper are at the top of the file; `DRAFT.definition` gains nothing by default — zod default keeps old fixtures valid):

```ts
	it('renders a row-number gutter when the definition asks for one', () => {
		vi.spyOn(store, 'getTablePage').mockReturnValue(PAGE);
		vi.spyOn(store, 'getTableLoading').mockReturnValue(false);
		vi.spyOn(store, 'getTableDraft').mockReturnValue({
			...DRAFT,
			definition: { ...DRAFT.definition, show_row_numbers: true }
		});
		const c = render('tbl:draft:rn');
		try {
			expect(document.querySelector('[data-testid="row-number-header"]')?.textContent).toBe('#');
			const cells = [...document.querySelectorAll('[data-testid="row-number-cell"]')];
			expect(cells).toHaveLength(1); // one per rendered row
			expect(cells[0].textContent).toBe('1');
		} finally {
			unmount(c);
		}
	});

	it('renders no gutter by default', () => {
		vi.spyOn(store, 'getTablePage').mockReturnValue(PAGE);
		vi.spyOn(store, 'getTableLoading').mockReturnValue(false);
		vi.spyOn(store, 'getTableDraft').mockReturnValue(DRAFT);
		const c = render('tbl:draft:rn2');
		try {
			expect(document.querySelector('[data-testid="row-number-header"]')).toBeNull();
			expect(document.querySelector('[data-testid="row-number-cell"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});
```

Note: `DRAFT` is typed `store.TableDraft` — after the zod change, `show_row_numbers` is a required output property of `TableDefinition`; add `show_row_numbers: false` to the `DRAFT.definition` fixture if TypeScript complains (and to any other test fixture `npm run check` flags — that's the mechanical fallout of a `.default()` zod field, whose OUTPUT type is non-optional; grep test fixtures for `schema_version: 1` under `frontend/src` and add the field where the compiler demands it).

(b) Append to `frontend/src/lib/components/Table/__tests__/ColumnManager.test.ts` (same seeding approach as Task 4's test):

```ts
	it('the row-numbers toggle flips show_row_numbers on the definition', async () => {
		await seedForClone(); // Task 4's seed helper in this same file
		const c = mount(ColumnManager, { target: document.body, props: { tabId: TAB } });
		flushSync();
		try {
			const box = document.querySelector(
				'[data-testid="toggle-row-numbers"]'
			) as HTMLInputElement;
			expect(box).toBeTruthy();
			expect(box.checked).toBe(false);
			box.click();
			flushSync();
			expect(getTableDraft(TAB)!.definition.show_row_numbers).toBe(true);
		} finally {
			unmount(c);
		}
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/TableGrid.test.ts src/lib/components/Table/__tests__/ColumnManager.test.ts'`
Expected: FAIL — no gutter elements, no toggle.

- [ ] **Step 3: Implement**

(a) `frontend/src/lib/api/types.ts` — in `TableDefinitionSchema` (~line 760), after `default_cell_mode`:

```ts
	show_row_numbers: z.boolean().default(false)
```

(b) `frontend/src/lib/components/Table/ColumnManager.svelte` — after the `<RowSourceEditor>` line inside the `{#if focusIndex === null}` block (~line 166):

```svelte
			<label
				class="flex w-fit items-center gap-1.5"
				title="Show a numbered first column (1-based, follows the current sort; also included in Excel exports)"
			>
				<input
					type="checkbox"
					data-testid="toggle-row-numbers"
					checked={defn.show_row_numbers}
					onchange={(e) =>
						apply({ ...defn, show_row_numbers: (e.currentTarget as HTMLInputElement).checked })}
				/>
				Show row numbers
			</label>
```

(c) `frontend/src/lib/components/Table/TableGrid.svelte`:

Script additions (near `visibleCols`, ~line 70):

```ts
	// Item 10: a presentation-only "#" gutter. NOT a definition column — it
	// never enters visibleCols, so ColumnRef indices, sort, resize and reorder
	// are untouched. The number is the row's 1-based absolute index in the
	// CURRENT (post-sort) result set, which the virtualizer already knows as
	// `win.start + i`.
	const showRowNumbers = $derived(
		getTableDraft(tabId)?.definition.show_row_numbers ?? false
	);
```

Header row — first child of the `data-testid="table-header"` div, before the `{#each visibleCols ...}`:

```svelte
		{#if showRowNumbers}
			<div
				role="columnheader"
				data-testid="row-number-header"
				class="flex w-12 shrink-0 items-center justify-end border-r border-border px-2 py-1.5 tabular-nums text-muted-foreground/70"
			>
				#
			</div>
		{/if}
```

Data row — first child of the `data-testid="table-row"` div, before its `{#each visibleCols ...}`:

```svelte
					{#if showRowNumbers}
						<div
							data-testid="row-number-cell"
							class="flex w-12 shrink-0 items-start justify-end border-r border-border/40 px-2 text-xs tabular-nums text-muted-foreground/60"
						>
							<span class="flex h-7 items-center">{win.start + i + 1}</span>
						</div>
					{/if}
```

Placeholder row — same block (the index is known even before the row's data arrives), first child of the `data-testid="table-row-placeholder"` div:

```svelte
					{#if showRowNumbers}
						<div
							data-testid="row-number-cell"
							class="flex w-12 shrink-0 items-center justify-end border-r border-border/40 px-2 text-xs tabular-nums text-muted-foreground/60"
						>
							{win.start + i + 1}
						</div>
					{/if}
```

(d) Fix compile fallout: `npm run check` will point at every fixture/literal building a `TableDefinition` without the new required-output field — add `show_row_numbers: false` where flagged (known candidates: `navigationAsTableDefinition` in `columns.ts` returns a definition literal → add `show_row_numbers: false` there; test fixtures in `TableGrid.test.ts`, `ColumnManager.collapse.test.ts`, `columns.test.ts` `base`, `table-editor` state tests).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/TableGrid.test.ts src/lib/components/Table/__tests__/ColumnManager.test.ts'`
Expected: PASS.

- [ ] **Step 5: Full frontend suite + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS — `check` is what proves every definition literal got the new field.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/table/columns.ts frontend/src/lib/components/Table/ColumnManager.svelte frontend/src/lib/components/Table/TableGrid.svelte frontend/src/lib/components/Table/__tests__/ frontend/src/lib/state/__tests__/
git commit -m "feat(frontend/table): optional row-number gutter with settings toggle"
```

---

### Task 9: Final sweep

**Files:** none new — verification only.

- [ ] **Step 1: Full test matrix**

```bash
pixi run core-test
pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'
pixi run dr-tidy
```

Expected: everything green; `dr-tidy` may reformat — if it does, re-run the two test commands, then commit the formatting delta:

```bash
git add -A
git commit -m "style: dr-tidy pass for the table & panel polish pack"
```

- [ ] **Step 2: Manual smoke (optional but recommended)**

`pixi run backend-start` + `pixi run frontend-start`, open a table: add a column via header "+", press the dialog X → column gone; add + Save → column stays; edit an inline navigation column's chain, Cancel, reopen → original chain (Task 2f); clone a column; expand a script column's snippet; toggle row numbers; export and open the xlsx (filters, borders, widths, `#` column).
