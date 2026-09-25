# Table Settings Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the table grid the entire tab area by moving the definition-editing settings (`ColumnManager`) out of an always-visible top panel and behind a ⚙ Settings button that opens them in a centered modal.

**Architecture:** Pure frontend presentation relocation. `TableView.svelte` keeps its slim top bar (name · dirty dot · **Settings** · Export · Save · Save as) and gives `TableGrid` all remaining height. The existing `ColumnManager` is rendered unchanged inside a `bits-ui` `Dialog` (`$lib/components/ui/dialog`), opened by the new button, guarded by `canEdit()`. No state/API/ops changes.

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, Tailwind, `bits-ui` Dialog primitives, `@lucide/svelte` icons, Vitest (happy-dom) for component tests, Playwright for e2e.

## Global Constraints

- Runtime/toolchain runs through **pixi** + npm from **inside `frontend/`** — the bare `pixi run -e frontend npm test` fails from the repo root ("Missing script"); always wrap as `pixi run -e frontend bash -c 'cd frontend && …'`.
- Follow the repo's Svelte-5 component-test convention: `mount`/`flushSync`/`unmount` from `svelte` + `vi.spyOn`/`vi.mock` — **not** `@testing-library/svelte` (not a dependency). See `src/lib/components/Table/__tests__/TableGrid.test.ts`.
- Dialogs in this repo use `<Dialog.Root bind:open>` + `<Dialog.Content class="max-w-…">` + `<Dialog.Title>`; `Dialog.Content` already renders its own close (X) button. See `HistoryDrawer.svelte` / `SwapMetamodelDrawer.svelte`.
- `bits-ui` `Dialog.Content` is **portaled to `document.body`** and is **not mounted while closed** — Playwright locators for popup contents must be scoped at `page` level (not inside the tab `tabpanel`), and disambiguated by the dialog's accessible name (`Table settings`).
- Design source of truth: `docs/superpowers/specs/2026-07-13-table-settings-popup-design.md`.
- `docs/` is gitignored — commit steps add **source and test files only**, never the plan/spec.

---

### Task 1: Move table settings behind a ⚙ Settings modal

Relocate `ColumnManager` from an inline top panel into a `Dialog` opened by a new
editor-only Settings button, and give `TableGrid` the full remaining height.

**Files:**
- Modify: `frontend/src/lib/components/Table/TableView.svelte` (full rewrite of markup below; script gains one state field + two imports)
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte:140` (drop the inline top-strip frame classes)
- Test: `frontend/src/lib/components/Table/__tests__/TableView.test.ts` (new)

**Interfaces:**
- Consumes (unchanged, from `$lib/state`): `canEdit(): boolean`, `getTableDraft(tabId): TableDraft | undefined`, `getTableConflict(tabId)`, `ensureTableDraft`, `downloadTable`, `saveTableDraft`, `saveAsTableDraft`, `reloadTableDraft`, `setTableName`.
- Consumes (unchanged): `ColumnManager` with props `{ tabId: string }`; `Dialog` namespace from `$lib/components/ui/dialog` (`Dialog.Root`, `Dialog.Content`, `Dialog.Title`); `Settings` from `@lucide/svelte`.
- Produces (new DOM contract, relied on by Task 2's e2e): a button `data-testid="table-settings-button"` (present only when `canEdit()`), which opens a dialog with accessible name **"Table settings"** containing the existing `data-testid="column-manager"`. `column-manager` is **absent from the DOM until the button is clicked**.

- [ ] **Step 1: Write the failing component test**

Create `frontend/src/lib/components/Table/__tests__/TableView.test.ts`:

```ts
// Behaviour test for the settings-popup refactor (Task 1): the definition
// editor (ColumnManager) no longer sits inline in the tab — it lives behind a
// ⚙ Settings button that opens a Dialog, and the button is editor-only. This
// covers the button's edit-gating and that the manager is not mounted until the
// popup opens; the full open→edit→grid-updates flow is covered by e2e
// (e2e/table.spec.ts). Uses the repo's mount/flushSync/unmount Svelte-5 render
// convention (see TableGrid.test.ts) rather than @testing-library/svelte.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TableView from '../TableView.svelte';

// Hoisted so the vi.mock factory (hoisted above imports) can reference it, and
// so each test can flip `editable` before mounting.
const h = vi.hoisted(() => ({
	editable: true,
	draft: {
		tabId: 'tbl:draft:1',
		name: 'My Table',
		dirty: false,
		artifactId: 'a1',
		definition: { row_source: { kind: 'scope', scope: {} }, columns: [] }
	} as unknown
}));

// TableView (and, when opened, ColumnManager) import from the $lib/state barrel.
// Only TableView's own functions are exercised here — the dialog stays closed,
// so ColumnManager is never mounted and its state functions are never called.
vi.mock('$lib/state', () => ({
	canEdit: () => h.editable,
	ensureTableDraft: vi.fn(async () => {}),
	getTableDraft: () => h.draft,
	getTableConflict: () => undefined,
	downloadTable: vi.fn(async () => {}),
	saveTableDraft: vi.fn(async () => {}),
	saveAsTableDraft: vi.fn(async () => {}),
	reloadTableDraft: vi.fn(),
	setTableName: vi.fn()
}));

function render(tabId: string) {
	const c = mount(TableView, { target: document.body, props: { tabId } });
	flushSync();
	return c;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
	h.editable = true;
});

describe('TableView settings popup', () => {
	it('shows a Settings button and does not mount the column manager inline', () => {
		h.editable = true;
		const c = render('tbl:draft:1');
		try {
			expect(
				document.querySelector('[data-testid="table-settings-button"]')
			).not.toBeNull();
			// The definition editor is behind the popup — absent until opened.
			expect(document.querySelector('[data-testid="column-manager"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('hides the Settings button for read-only users', () => {
		h.editable = false;
		const c = render('tbl:draft:1');
		try {
			expect(
				document.querySelector('[data-testid="table-settings-button"]')
			).toBeNull();
		} finally {
			unmount(c);
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/TableView.test.ts'`
Expected: FAIL — the current `TableView` renders `<ColumnManager>` inline (so `column-manager` IS present) and has no `table-settings-button`.

- [ ] **Step 3: Rewrite `TableView.svelte`**

Replace the entire contents of `frontend/src/lib/components/Table/TableView.svelte` with:

```svelte
<script lang="ts">
	// The table tab root: a slim chrome bar (name input, dirty dot, Settings,
	// Export, Save/Save as…, conflict banner) above a full-height `TableGrid`.
	// Definition editing (row source + columns) lives in a modal opened by the
	// ⚙ Settings button so the grid gets the whole area — see
	// docs/superpowers/specs/2026-07-13-table-settings-popup-design.md.
	import {
		canEdit,
		downloadTable,
		ensureTableDraft,
		getTableConflict,
		getTableDraft,
		reloadTableDraft,
		saveAsTableDraft,
		saveTableDraft,
		setTableName
	} from '$lib/state';
	import { Settings } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import ColumnManager from './ColumnManager.svelte';
	import TableGrid from './TableGrid.svelte';

	let { tabId }: { tabId: string } = $props();
	$effect(() => {
		void ensureTableDraft(tabId);
	});
	const draft = $derived(getTableDraft(tabId));
	const conflict = $derived(getTableConflict(tabId));
	const editable = $derived(canEdit());
	let saveError = $state<string | null>(null);
	let settingsOpen = $state(false);

	async function save(): Promise<void> {
		saveError = null;
		try {
			await saveTableDraft(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}

	async function saveAs(): Promise<void> {
		if (!draft) return;
		const name = window.prompt('Save as', draft.name);
		if (!name) return; // cancelled, or an empty name
		saveError = null;
		try {
			await saveAsTableDraft(tabId, name);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}

	async function exportTable(): Promise<void> {
		saveError = null;
		try {
			await downloadTable(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Export failed';
		}
	}
</script>

{#if !draft}
	<p class="p-4 text-xs text-muted-foreground/70">Loading…</p>
{:else}
	<div class="flex h-full flex-col">
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<input
				data-testid="table-name"
				class="w-56 rounded border border-input bg-card px-2 py-1 text-xs"
				value={draft.name}
				disabled={!editable}
				oninput={(e) => setTableName(tabId, e.currentTarget.value)}
			/>
			{#if draft.dirty}
				<span title="Unsaved changes" class="text-warning">●</span>
			{/if}
			<span class="flex-1"></span>
			<div class="flex items-center gap-2">
				{#if editable}
					<button
						type="button"
						data-testid="table-settings-button"
						class="flex items-center gap-1 rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
						onclick={() => (settingsOpen = true)}
					>
						<Settings class="h-3.5 w-3.5" /> Settings
					</button>
				{/if}
				<button
					type="button"
					class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
					onclick={() => void exportTable()}
				>
					Export
				</button>
				{#if editable}
					<button
						type="button"
						class="rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
						disabled={!draft.dirty && draft.artifactId !== null}
						onclick={() => void save()}
					>
						Save{draft.dirty ? ' *' : ''}
					</button>
					<button
						type="button"
						class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
						onclick={() => void saveAs()}
					>
						Save as…
					</button>
				{/if}
			</div>
		</div>
		{#if conflict !== undefined}
			<div class="flex items-center gap-2 bg-warning/15 px-3 py-1.5 text-xs text-warning">
				Someone else modified this table.
				<button type="button" class="underline" onclick={() => void reloadTableDraft(tabId)}>
					Reload their version
				</button>
			</div>
		{/if}
		{#if saveError}
			<p class="px-3 py-1 text-xs text-destructive">{saveError}</p>
		{/if}
		<div class="min-h-0 flex-1">
			<TableGrid {tabId} />
		</div>
	</div>

	{#if editable}
		<Dialog.Root bind:open={settingsOpen}>
			<Dialog.Content class="max-h-[85vh] max-w-3xl overflow-y-auto">
				<Dialog.Title class="font-display text-lg font-light tracking-wide">
					Table settings
				</Dialog.Title>
				<ColumnManager {tabId} />
			</Dialog.Content>
		</Dialog.Root>
	{/if}
{/if}
```

- [ ] **Step 4: Drop the inline top-strip frame from `ColumnManager.svelte`**

The manager kept a `border-b`/`p-3` frame for sitting as a top strip; inside the
dialog (`Dialog.Content` already applies `p-6` + gap) those are wrong. Change the
wrapper on `frontend/src/lib/components/Table/ColumnManager.svelte:140`:

From:
```svelte
	<div data-testid="column-manager" class="space-y-3 border-b border-border p-3 text-xs">
```
To:
```svelte
	<div data-testid="column-manager" class="space-y-3 text-xs">
```

- [ ] **Step 5: Run the component test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/TableView.test.ts'`
Expected: PASS (both tests).

- [ ] **Step 6: Run the rest of the Table unit tests + typecheck (no regressions)**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table src/lib/table && npm run check'`
Expected: PASS — `TableGrid.test.ts`, `ColumnManager`'s tests, `navigationAsTable.test.ts` still green (their logic is untouched; `column-manager` testid unchanged), and `svelte-check` reports 0 errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/Table/TableView.svelte \
        frontend/src/lib/components/Table/ColumnManager.svelte \
        frontend/src/lib/components/Table/__tests__/TableView.test.ts
git commit -m "feat(frontend): move table settings into a popup, give grid full height

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Route the table e2e flow through the settings popup

The two e2e tests in `e2e/table.spec.ts` interact with `ColumnManager` controls
directly (`add-property-column`, `add-navigation-column`, `Property name`,
`inline-nav-editor`, `Row source kind`, `rowsource-mode-inline`). After Task 1
those live in a portaled dialog, so each must first open the popup and be scoped
to the dialog by its accessible name.

**Files:**
- Modify: `frontend/e2e/table.spec.ts` (two tests: line ~70 and line ~215)

**Interfaces:**
- Consumes (from Task 1): `page.getByTestId('table-settings-button')` opens the popup; the popup is `page.getByRole('dialog', { name: 'Table settings' })`; it contains `add-property-column`, `add-navigation-column`, `nav-mode-inline`, `inline-nav-editor`, the `Property name` field, `Row source kind` select, `rowsource-mode-inline`, and `inline-rowsource-editor`.
- Produces: no code interface; updated e2e coverage of the open→edit path.

- [ ] **Step 1: Update test 1 ("open navigation as table, add a column, edit a cell, commit, save, and reopen")**

In `frontend/e2e/table.spec.ts`, the current block (around lines 125–137):

```ts
	// --- 2. Add a property column via the ColumnManager (add-then-edit:
	// the column is created empty and the property is picked/typed in the
	// per-column editor — editable at any time, not just at creation) -------
	const columnCountBefore = await header.locator('> div').count();
	await tabpanel.getByTestId('add-property-column').click();
	await expect(header.locator('> div')).toHaveCount(columnCountBefore + 1, { timeout: 10_000 });
	await tabpanel.getByLabel('Property name').fill('name');
	// The grid re-evaluates with the edited definition; the new column now
	// carries values (any non-empty cell text will do — seeded elements all
	// have a `name`).
	await expect(tabpanel.getByTestId('table-row').first()).toContainText(/\w/, {
		timeout: 10_000
	});
```

Replace it with (open the popup; scope column edits to the dialog; the grid rows
stay in `tabpanel` and still render live behind the overlay; close the popup
before the value-cell edit in section 3 so the overlay no longer intercepts
clicks):

```ts
	// --- 2. Add a property column via the ColumnManager, now behind the
	// ⚙ Settings popup (add-then-edit: the column is created empty and the
	// property is picked/typed in the per-column editor). The popup is portaled
	// to the body, so its controls are scoped to the dialog, not the tabpanel;
	// the grid keeps rendering live underneath. -----------------------------
	await tabpanel.getByTestId('table-settings-button').click();
	const settings = page.getByRole('dialog', { name: 'Table settings' });
	await expect(settings).toBeVisible();
	const columnCountBefore = await header.locator('> div').count();
	await settings.getByTestId('add-property-column').click();
	await expect(header.locator('> div')).toHaveCount(columnCountBefore + 1, { timeout: 10_000 });
	await settings.getByLabel('Property name').fill('name');
	// The grid re-evaluates with the edited definition; the new column now
	// carries values (any non-empty cell text will do — seeded elements all
	// have a `name`).
	await expect(tabpanel.getByTestId('table-row').first()).toContainText(/\w/, {
		timeout: 10_000
	});
	// Close the popup so its overlay stops intercepting clicks on the grid for
	// the value-cell edit in section 3.
	await page.keyboard.press('Escape');
	await expect(settings).toBeHidden();
```

- [ ] **Step 2: Update test 2 ("inline navigation column and inline row source")**

The current block (around lines 251–286) starts with `add-navigation-column` and
runs through the inline row-source edit. Change the opening so the popup is
opened and everything ColumnManager-related is scoped to `settings`. Replace:

```ts
	const columnCountBefore = await header.locator('> div').count();
	await tabpanel.getByTestId('add-navigation-column').click();
	await tabpanel.getByTestId('nav-mode-inline').click();

	// The embedded builder appears with a row-rooted path ("each row's
	// element"); add a relationship step exactly like the standalone builder
	// (same locator sequence as section 1 above, scoped to the inline editor).
	const inlineEditor = tabpanel.getByTestId('inline-nav-editor');
```

with:

```ts
	// The ColumnManager now lives behind the ⚙ Settings popup (portaled to the
	// body); open it and scope column edits to the dialog. Grid/header
	// assertions below still read from the tabpanel — it renders live behind
	// the overlay — and there are no grid *clicks* in this test, so the popup
	// can stay open through to the end.
	await tabpanel.getByTestId('table-settings-button').click();
	const settings = page.getByRole('dialog', { name: 'Table settings' });
	await expect(settings).toBeVisible();
	const columnCountBefore = await header.locator('> div').count();
	await settings.getByTestId('add-navigation-column').click();
	await settings.getByTestId('nav-mode-inline').click();

	// The embedded builder appears with a row-rooted path ("each row's
	// element"); add a relationship step exactly like the standalone builder
	// (same locator sequence as section 1 above, scoped to the inline editor).
	const inlineEditor = settings.getByTestId('inline-nav-editor');
```

Then, further down in the same test, re-scope the remaining ColumnManager
locators from `tabpanel` to `settings`. Change:

```ts
	await expect(header.locator('> div')).toHaveCount(columnCountBefore + 1, { timeout: 10_000 });
	await inlineEditor.getByRole('button', { name: '+ Follow a relationship', exact: true }).click();
```
— leave this as-is (`header` is the grid header in the tabpanel; `inlineEditor`
is already the `settings`-scoped locator from the change above).

And in the "Inline row source" section, change:

```ts
	await tabpanel.getByLabel('Row source kind').selectOption('chains');
	await tabpanel.getByTestId('rowsource-mode-inline').click();
	await expect(tabpanel.getByTestId('inline-rowsource-editor')).toBeVisible();
	await expect(tabpanel.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });
```
to:
```ts
	await settings.getByLabel('Row source kind').selectOption('chains');
	await settings.getByTestId('rowsource-mode-inline').click();
	await expect(settings.getByTestId('inline-rowsource-editor')).toBeVisible();
	await expect(tabpanel.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });
```

(The `status-chip` assertion at `inlineEditor.getByTestId('status-chip')` and the
relationship-picker steps using `page.getByPlaceholder(...)` / `page.getByRole('button', …)` are unchanged — `inlineEditor` is now `settings`-scoped, and the picker popovers are their own page-level portals.)

- [ ] **Step 3: Run the table e2e spec**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e -- table.spec.ts'`
Expected: PASS — both tests. (Playwright boots the backend + dev server itself.)

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/table.spec.ts
git commit -m "test(frontend/e2e): open table settings popup before column edits

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- "Grid fills the area; settings behind a button" → Task 1 (Dialog + full-height `TableGrid`). ✓
- "Centered modal via existing `Dialog`, `max-w-3xl max-h-[85vh]` scrollable" → Task 1 Step 3 `Dialog.Content`. ✓
- "Save/Export/Save-as stay in the slim bar" → Task 1 Step 3 keeps them; only Settings is new. ✓
- "⚙ button and settings surface editor-only (`canEdit()`)" → Task 1 button + `{#if editable}` guard on the Dialog; test asserts read-only absence. ✓
- "`ColumnManager` relocated wholesale, drop outer `border-b`" → Task 1 Steps 3–4. ✓
- "No state/API/ops changes" → only `TableView`/`ColumnManager` markup + a local `$state`. ✓
- "Component test for button gating + not-mounted-until-open; e2e updated to open popup first" → Task 1 test + Task 2. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; all steps carry full code or exact commands. ✓

**Type consistency:** `settingsOpen` is a `boolean` `$state`; `Dialog.Root bind:open` matches the repo's usage; `data-testid="table-settings-button"` and dialog name `"Table settings"` are identical across Task 1 (produced) and Task 2 (consumed). `ColumnManager` prop `{ tabId }` unchanged. ✓
