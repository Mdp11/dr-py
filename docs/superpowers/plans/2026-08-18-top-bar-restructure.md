# Top Bar Restructure (P-10) + Issues Filter (U-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Detail/Graph fixed tabs, make Issues a closable top-bar-opened tab with a per-validator filter, promote every three-dots menu item to a first-class top-bar control, delete the command palette, and move the per-artifact bundle-export button into each editor's toolbar.

**Architecture:** The workspace tab strip becomes dynamic-tabs-only (`_activeTab: string | null`, placeholder pane at zero tabs); Issues joins the `DynamicTab` kind union as a singleton mirroring the metamodel tab. The backend `Issue` dataclass gains a `check` field stamped centrally by the validation pipeline from a per-validator `check_name` attribute, threaded through `IssueOut` to a chip filter in `IssuesPanel`.

**Tech Stack:** Svelte 5 runes + bits-ui + vitest (happy-dom/MSW) on the frontend; Python 3.14 + FastAPI + pytest on the backend. All commands through `pixi run`.

**Spec:** `docs/superpowers/specs/2026-08-18-top-bar-restructure-design.md`

## Global Constraints

- One feature branch; all tasks land on it sequentially (backlog P-10: "one wave of work … should land together").
- Never commit `docs/superpowers/` files — gitignored by repo convention.
- Frontend single-file tests: `pixi run frontend-test -- <path relative to frontend/>` (args forward to vitest). Full suite: `pixi run frontend-test`. Backend: `pixi run -e core-dev pytest <path> -v`. Never bare `python`/`node`.
- Right side of the TopBar (validation chip, Undo, Validate, Commit, Strict badge, changes counter) is untouched — same controls, same order.
- Cmd+S and Cmd+E keyboard shortcuts must keep working; Cmd+K and Cmd+1/2/3 are deleted.
- Follow the repo's dense-docstring convention when touching commented invariants (`workspace.svelte.ts`, `ui.svelte.ts`, `pipeline.py`).
- Final gate: `pixi run dr-tidy` clean and `pixi run dr-test` green (task 8).

---

### Task 1: Workspace state — Issues tab kind, nullable active tab, neighbor-focus close

**Files:**
- Modify: `frontend/src/lib/state/workspace.svelte.ts`
- Modify: `frontend/src/lib/state/validate-action.ts:2,24`
- Modify: `frontend/src/lib/state/index.ts` (export `openIssuesTab`)
- Test: `frontend/src/lib/state/__tests__/workspace.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `openIssuesTab(): string` (singleton, id `'issues:panel'`); `getActiveTab(): string | null`; `setActiveTab(t: string): void` (unchanged signature); `DynamicTab['kind']` now includes `'issues'`; `BUILTIN_TABS` deleted. Task 2 renders on these; Task 3's Issues button calls `openIssuesTab()`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/lib/state/__tests__/workspace.test.ts` (adapt imports to the file's existing style; it already imports from `../workspace.svelte`):

```ts
describe('issues tab', () => {
	it('openIssuesTab creates a singleton and focuses it', () => {
		const id = openIssuesTab();
		expect(id).toBe('issues:panel');
		expect(getActiveTab()).toBe('issues:panel');
		const again = openIssuesTab();
		expect(again).toBe('issues:panel');
		expect(getDynamicTabs().filter((t) => t.kind === 'issues')).toHaveLength(1);
	});
});

describe('nullable active tab', () => {
	it('starts with no active tab', () => {
		expect(getActiveTab()).toBeNull();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('closing the active tab focuses the previous tab in strip order', () => {
		const a = openArtifactTab('table', { artifactId: 'A', title: 'A' });
		const b = openArtifactTab('table', { artifactId: 'B', title: 'B' });
		const c = openArtifactTab('table', { artifactId: 'C', title: 'C' });
		setActiveTab(b);
		closeTab(b);
		expect(getActiveTab()).toBe(a);
		closeTab(a);
		expect(getActiveTab()).toBe(c); // index-1 clamped to 0 of what remains
	});

	it('closing the last tab yields null', () => {
		const a = openArtifactTab('table', { artifactId: 'A', title: 'A' });
		closeTab(a);
		expect(getActiveTab()).toBeNull();
	});

	it('closing an inactive tab leaves the active tab alone', () => {
		const a = openArtifactTab('table', { artifactId: 'A', title: 'A' });
		const b = openArtifactTab('table', { artifactId: 'B', title: 'B' });
		expect(getActiveTab()).toBe(b);
		closeTab(a);
		expect(getActiveTab()).toBe(b);
	});

	it('restore of a legacy builtin active id falls back to null', () => {
		localStorage.setItem(
			'ui.workspace.tabs.p1',
			JSON.stringify({ active: 'detail', tabs: [] })
		);
		initWorkspaceTabs('p1');
		expect(getActiveTab()).toBeNull();
	});

	it('the issues tab persists and restores', () => {
		initWorkspaceTabs('p2');
		openIssuesTab();
		resetWorkspaceTabs();
		initWorkspaceTabs('p2');
		expect(getDynamicTabs().some((t) => t.kind === 'issues')).toBe(true);
	});
});
```

Keep/adjust existing tests: any asserting `getActiveTab() === 'detail'` after reset/close/restore must now expect `null`. Delete tests that exercise `BUILTIN_TABS`.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pixi run frontend-test -- src/lib/state/__tests__/workspace.test.ts`
Expected: FAIL — `openIssuesTab is not a function`, `expected 'detail' to be null`.

- [ ] **Step 3: Implement in `workspace.svelte.ts`**

- Delete `export const BUILTIN_TABS = …`.
- Module docstring: rewrite the first paragraph — the strip is now dynamic-tabs-only; `null` active means "nothing open" and the Workspace renders a placeholder.
- `DynamicTab['kind']` union gains `'issues'`; `PREFIX` gains `issues: 'issues'`.
- `let _activeTab: string | null = $state(null);` and `getActiveTab(): string | null`.
- Add, next to `openMetamodelTab`:

```ts
const ISSUES_TAB_ID = 'issues:panel';

/** Open (or focus) the singleton Issues tab. Not artifact-backed; dedupe is
 * by KIND, mirroring openMetamodelTab. */
export function openIssuesTab(): string {
	const existing = _tabs.find((t) => t.kind === 'issues');
	if (existing) {
		_activeTab = existing.id;
		persist();
		return existing.id;
	}
	_tabs = [..._tabs, { id: ISSUES_TAB_ID, kind: 'issues', artifactId: null, title: 'Issues' }];
	_activeTab = ISSUES_TAB_ID;
	persist();
	return ISSUES_TAB_ID;
}
```

- `closeTab`:

```ts
export function closeTab(id: string): void {
	const idx = _tabs.findIndex((t) => t.id === id);
	_tabs = _tabs.filter((t) => t.id !== id);
	if (_activeTab === id) {
		_activeTab = _tabs.length > 0 ? _tabs[Math.max(0, idx - 1)].id : null;
	}
	persist();
}
```

- `persistable`: `if (t.kind === 'metamodel' || t.kind === 'issues') return true;`
- `initWorkspaceTabs`: every `'detail'` fallback becomes `null`; the restore check drops `BUILTIN_TABS`:

```ts
const active = parsed.active ?? null;
_activeTab = active !== null && _tabs.some((t) => t.id === active) ? active : null;
```

- `resetWorkspaceTabs`: `_activeTab = null;`
- `validate-action.ts`: replace the `setActiveTab` import with `openIssuesTab` and line 24 with `openIssuesTab();` (update the docstring sentence about "switch the workspace tab").
- `state/index.ts`: export `openIssuesTab` next to `openMetamodelTab`.
- Do NOT touch `keyboard.ts` yet (Task 4 owns it) — its `WorkspaceTab` import still typechecks (`string`).

- [ ] **Step 4: Run the state tests, then the full frontend suite**

Run: `pixi run frontend-test -- src/lib/state/__tests__/workspace.test.ts`
Expected: PASS.
Run: `pixi run frontend-test`
Expected: failures ONLY in files Tasks 2–4 own (`Workspace*`, `TopBar*`, `CommandPalette`, keyboard, validate-staged if it asserts the tab switch). Fix `validate-staged.test.ts` here if it asserts `getActiveTab() === 'issues'` — the assertion becomes "the issues tab is open": `getDynamicTabs().some((t) => t.kind === 'issues')`. Leave the rest for their owning tasks.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/ frontend/src/lib/state/__tests__/workspace.test.ts
git commit -m "feat(frontend): issues joins the dynamic tab kinds; active tab is nullable (P-10.1/2 state)"
```

---

### Task 2: Workspace.svelte — delete Detail/Graph, render Issues dynamically, placeholder pane

**Files:**
- Delete: `frontend/src/lib/components/Workspace/DetailView.svelte`
- Delete: `frontend/src/lib/components/Workspace/GraphView.svelte`
- Delete: `frontend/src/lib/components/Workspace/graph-data.ts`
- Delete: `frontend/src/lib/components/Workspace/graph-data.test.ts`
- Modify: `frontend/src/lib/components/Workspace.svelte`
- Test: `frontend/src/lib/components/__tests__/Workspace.tabs.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `openIssuesTab`, `getActiveTab(): string | null`.
- Produces: the placeholder pane (`data-testid="workspace-empty"`); an `issues`-kind `Tabs.Content` arm rendering `IssuesPanel`. Task 5 removes the strip export button (leave it in place here).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/__tests__/Workspace.tabs.test.ts` (copy render bootstrapping — `@testing-library/svelte` setup, state resets in `beforeEach` — from `Workspace.export-button.test.ts`, which renders the same component):

```ts
import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import Workspace from '../Workspace.svelte';
import { openIssuesTab, resetWorkspaceTabs } from '$lib/state';

describe('Workspace tab strip', () => {
	beforeEach(() => {
		resetWorkspaceTabs();
	});

	it('renders the empty placeholder when no tab is open', () => {
		render(Workspace);
		expect(screen.getByTestId('workspace-empty')).toBeInTheDocument();
		expect(screen.queryByText('Detail')).toBeNull();
		expect(screen.queryByText('Graph')).toBeNull();
	});

	it('opens Issues as a closable tab rendering the panel', async () => {
		render(Workspace);
		openIssuesTab();
		expect(await screen.findByRole('tab', { name: /Issues/ })).toBeInTheDocument();
		expect(screen.getByLabelText('Close Issues')).toBeInTheDocument();
		expect(screen.queryByTestId('workspace-empty')).toBeNull();
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run frontend-test -- src/lib/components/__tests__/Workspace.tabs.test.ts`
Expected: FAIL — fixed `Detail` trigger present, no `workspace-empty` testid.

- [ ] **Step 3: Implement**

In `Workspace.svelte`:

- Remove the `DetailView`/`GraphView`/`IssuesPanel`-as-fixed imports and the three fixed `Tabs.Trigger`s (lines 40–42) and their `Tabs.Content` panes (lines 94–102). Keep the `IssuesPanel` import — it moves into the dynamic `{#each}`.
- Add `const hasActivePane = $derived(activeTab !== null && dynamicTabs.some((t) => t.id === activeTab));`
- `Tabs.Root value={activeTab ?? ''}` (bits-ui wants a string; `''` matches nothing).
- In the close-dispatch, before `closeTab(tab.id)`, add an arm comment-consistent with the others: `'issues'` needs no editor teardown (no draft, no lease) — extend the existing per-kind comment to say so rather than adding an empty arm.
- In the dynamic `Tabs.Content` `{#if}` chain add: `{:else if tab.kind === 'issues'}<IssuesPanel />`.
- After the `{#each}` content blocks, render the placeholder:

```svelte
{#if !hasActivePane}
	<div
		data-testid="workspace-empty"
		class="flex flex-1 items-center justify-center text-xs text-muted-foreground/70"
	>
		Open an artifact from the sidebar, or Issues from the top bar.
	</div>
{/if}
```

- Delete the four Detail/Graph files. Then sweep for dangling references: `grep -rn "DetailView\|GraphView\|graph-data" frontend/src` must return nothing.

- [ ] **Step 4: Run the tests**

Run: `pixi run frontend-test -- src/lib/components/__tests__/Workspace.tabs.test.ts`
Expected: PASS.
Run: `pixi run frontend-test -- src/lib/components/__tests__/`
Expected: remaining failures only in `CommandPalette.test.ts` / `TopBar*` (Tasks 3–4). Fix any `WorkspacePage.*.test.ts` failure caused by the deleted tabs here (they render the page; update selectors that clicked Detail/Graph/fixed-Issues).

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): dynamic-only workspace tab strip with empty placeholder (P-10.1/P-10.2)"
```

---

### Task 3: TopBar — eight flat controls, three-dots menu and ⌘K hint deleted

**Files:**
- Modify: `frontend/src/lib/components/TopBar.svelte`
- Test: `frontend/src/lib/components/__tests__/TopBar.test.ts` (extend), `TopBar.strict.test.ts` (fix if broken)

**Interfaces:**
- Consumes: Task 1's `openIssuesTab`.
- Produces: left-nav buttons with `aria-label`s / visible text: `Issues`, `Compare`, `Apply CR`, `Edit Metamodel`, `Export`, `History`, `Settings` (after `Artifacts`). No `More actions` trigger, no `⌘K` kbd.

- [ ] **Step 1: Write the failing tests**

Extend `TopBar.test.ts` (reuse its existing render/mocking setup):

```ts
it('renders the promoted controls and no overflow menu', () => {
	render(TopBar);
	for (const label of ['Issues', 'Compare', 'Apply CR', 'Edit Metamodel', 'Export', 'History', 'Settings']) {
		expect(screen.getByText(label)).toBeInTheDocument();
	}
	expect(screen.queryByLabelText('More actions')).toBeNull();
	expect(screen.queryByTitle('Command palette')).toBeNull();
});

it('Issues opens the issues tab', async () => {
	render(TopBar);
	await fireEvent.click(screen.getByText('Issues'));
	expect(getDynamicTabs().some((t) => t.kind === 'issues')).toBe(true);
});

it('Edit Metamodel and Export are disabled without a metamodel/model', () => {
	// use the test file's existing state-reset path so metamodel/summary are null
	render(TopBar);
	expect(screen.getByText('Edit Metamodel').closest('button')).toBeDisabled();
	expect(screen.getByText('Export').closest('button')).toBeDisabled();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run frontend-test -- src/lib/components/__tests__/TopBar.test.ts`
Expected: FAIL — controls not found.

- [ ] **Step 3: Implement**

In `TopBar.svelte`:

- Replace the `Ellipsis` import with `{ GitCompareArrows, Download, FileInput, History, ListChecks, Settings, Shapes }` (keep `AlertCircle, AlertTriangle, Info, RefreshCw, Undo2`). Remove the `DropdownMenu` import (only the ellipsis used it here).
- Import `openIssuesTab` from `$lib/state`.
- Extract the shared trigger style once:

```ts
const barBtn =
	'flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50';
```

- Replace the left `nav` contents (keep `<ArtifactsMenu />` first):

```svelte
<nav aria-label="Toolbar" class="flex items-center gap-1">
	<ArtifactsMenu />
	<button type="button" class={barBtn} onclick={() => openIssuesTab()}>
		<ListChecks class="h-3.5 w-3.5" /> Issues
	</button>
	<a class={barBtn} href={resolve(`/p/${getActiveProjectId()}/compare`)}>
		<GitCompareArrows class="h-3.5 w-3.5" /> Compare
	</a>
	<button type="button" class={barBtn} onclick={() => (applyCrOpen = true)}>
		<FileInput class="h-3.5 w-3.5" /> Apply CR
	</button>
	<button type="button" class={barBtn} disabled={metamodel === null} onclick={() => openMetamodelTab()}>
		<Shapes class="h-3.5 w-3.5" /> Edit Metamodel
	</button>
	<button type="button" class={barBtn} disabled={summary === null} onclick={() => void onExport()}>
		<Download class="h-3.5 w-3.5" /> Export
	</button>
	<button type="button" class={barBtn} onclick={() => setHistoryDrawerOpen(true)}>
		<History class="h-3.5 w-3.5" /> History
	</button>
	<button type="button" class={barBtn} onclick={() => (settingsOpen = true)}>
		<Settings class="h-3.5 w-3.5" /> Settings
	</button>
</nav>
```

- Delete the whole `DropdownMenu.Root` ellipsis block (old lines 277–302) and the `⌘K` `<kbd>` (old lines 273–276). `ApplyCrDialog`/`SettingsDialog` mounts and their `$state` flags stay.

- [ ] **Step 4: Run the tests**

Run: `pixi run frontend-test -- src/lib/components/__tests__/TopBar.test.ts src/lib/components/__tests__/TopBar.strict.test.ts`
Expected: PASS (fix `TopBar.strict.test.ts` selectors if they referenced the menu).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/TopBar.svelte frontend/src/lib/components/__tests__/
git commit -m "feat(frontend): promote the overflow-menu actions to first-class top bar controls (P-10.3)"
```

---

### Task 4: Delete the command palette, its state, the hosted flag, and the dead shortcuts

**Files:**
- Delete: `frontend/src/lib/components/CommandPalette.svelte`
- Delete: `frontend/src/lib/components/__tests__/CommandPalette.test.ts`
- Modify: `frontend/src/routes/+layout.svelte:6,42`
- Modify: `frontend/src/lib/state/ui.svelte.ts` (drop `commandPaletteOpen` + `artifactDialogsHosted` accessors; rewrite the export/import-dialog comment that references the palette)
- Modify: `frontend/src/lib/state/index.ts` (drop the four removed exports)
- Modify: `frontend/src/lib/components/ArtifactsMenu.svelte` (drop `setArtifactDialogsHosted` calls; keep the open-flag clears)
- Modify: `frontend/src/lib/keyboard.ts`, `frontend/src/lib/keyboard.svelte.ts`
- Test: `frontend/src/lib/__tests__/keyboard.test.ts` (trim), `frontend/src/lib/state/__tests__/ui-artifact-dialogs.test.ts` (trim hosted-flag cases)

**Interfaces:**
- Consumes: Task 3 (edit-metamodel now has a top-bar trigger — the palette's last unique action).
- Produces: `ShortcutAction = { kind: 'save' } | { kind: 'validate' }`; `matchShortcut` matches only Cmd+S / Cmd+E; `shortcutWorksInInputs` true only for `save`.

- [ ] **Step 1: Trim the keyboard tests first (failing state)**

In `keyboard.test.ts`: delete every case asserting `palette`/`tab` actions; add:

```ts
it('does not match the removed shortcuts', () => {
	for (const key of ['k', '1', '2', '3']) {
		expect(matchShortcut(new KeyboardEvent('keydown', { key, metaKey: true }))).toBeNull();
	}
});
```

Run: `pixi run frontend-test -- src/lib/__tests__/keyboard.test.ts`
Expected: FAIL — `'k'` still matches `palette`.

- [ ] **Step 2: Implement the keyboard trim**

`keyboard.ts`: `ShortcutAction` becomes the two-member union; `matchShortcut` drops the `k`/`1`/`2`/`3` branches; `shortcutWorksInInputs` returns `action.kind === 'save'`; drop the now-unused `WorkspaceTab` import; update the module docstring's shortcut table. `keyboard.svelte.ts`: remove the `palette`/`tab` switch arms and the `setActiveTab`/`setCommandPaletteOpen` imports; update its docstring.

Run: `pixi run frontend-test -- src/lib/__tests__/keyboard.test.ts`
Expected: PASS.

- [ ] **Step 3: Delete the palette and its state**

- `git rm` the component and its test file.
- `+layout.svelte`: remove the import (line 6) and `<CommandPalette />` (line 42).
- `ui.svelte.ts`: delete `_commandPaletteOpen`/`getCommandPaletteOpen`/`setCommandPaletteOpen` and `_artifactDialogsHosted`/`getArtifactDialogsHosted`/`setArtifactDialogsHosted`; rewrite the big comment above the export/import flags — the two remaining open surfaces are the TopBar Artifacts menu and the per-editor export button; the lifecycle guard (ArtifactsMenu clearing flags on mount/unmount) is unchanged and still load-bearing.
- `ArtifactsMenu.svelte`: remove the `setArtifactDialogsHosted` import and both calls; the `$effect` keeps its unmount-time `setExportArtifactsOpen(false)`/`setImportArtifactsOpen(false)` clears; update the comment that mentions "the hosted signal is what the command palette gates on".
- `state/index.ts`: remove the four exports.
- `ui-artifact-dialogs.test.ts`: delete hosted-flag cases; keep open/seed-flag cases.
- Sweep: `grep -rn "CommandPalette\|commandPalette\|ArtifactDialogsHosted" frontend/src` must return nothing.

- [ ] **Step 4: Run the suite**

Run: `pixi run frontend-test`
Expected: PASS everywhere except files Task 5 owns (`Workspace.export-button.test.ts` should still pass at this point — the strip button is untouched). Fix any straggler referencing removed exports.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): delete the command palette and its shortcut/hosted-flag machinery (P-10.4)"
```

---

### Task 5: ArtifactExportButton in each editor toolbar; strip button removed

**Files:**
- Create: `frontend/src/lib/components/ArtifactExportButton.svelte`
- Modify: `frontend/src/lib/components/Workspace.svelte` (remove the `tab-export` block and the `activeArtifact` `@const`s, and the now-unused `FileUp`/`openExportArtifacts`/`isTempId` imports)
- Modify: `frontend/src/lib/components/Table/TableView.svelte` (toolbar right-group, after the xlsx export dropdown)
- Modify: `frontend/src/lib/components/Snippet/SnippetTab.svelte` (toolbar row at ~`:179`, at its end)
- Modify: `frontend/src/lib/components/Navigation/NavigationBuilder.svelte` (toolbar row at ~`:100`, in the right-side group at ~`:121`)
- Modify: `frontend/src/lib/components/Export/CustomExportTab.svelte` (toolbar row at ~`:189`, at its end)
- Test: rename `frontend/src/lib/components/__tests__/Workspace.export-button.test.ts` → `ArtifactExportButton.test.ts`

**Interfaces:**
- Consumes: `getDynamicTabs`, `openExportArtifacts` from `$lib/state`; `isTempId` from `$lib/state/ops`.
- Produces: `<ArtifactExportButton tabId={string} />` — renders `data-testid="tab-export"` only for a committed artifact; each editor already receives `tabId` as a prop (metamodel tab excluded — not artifact-backed).

- [ ] **Step 1: Write the component test (failing)**

Rewrite the renamed test file around the component (reuse its existing state-seeding helpers for opening tabs):

```ts
import { render, screen } from '@testing-library/svelte';
import ArtifactExportButton from '../ArtifactExportButton.svelte';
import { openArtifactTab, resetWorkspaceTabs } from '$lib/state';

it('renders for a committed artifact and seeds the export dialog', async () => {
	const tabId = openArtifactTab('table', { artifactId: 'art-1', title: 'T' });
	render(ArtifactExportButton, { tabId });
	await fireEvent.click(screen.getByTestId('tab-export'));
	expect(getExportArtifactsOpen()).toBe(true);
	expect(getExportArtifactsSeed()).toEqual(['art-1']);
});

it('renders nothing for a draft tab', () => {
	const tabId = openArtifactTab('table', { artifactId: null, title: 'draft' });
	render(ArtifactExportButton, { tabId });
	expect(screen.queryByTestId('tab-export')).toBeNull();
});
```

Run: `pixi run frontend-test -- src/lib/components/__tests__/ArtifactExportButton.test.ts`
Expected: FAIL — component doesn't exist.

- [ ] **Step 2: Implement the component**

```svelte
<!-- ArtifactExportButton.svelte — the per-artifact bundle-export trigger,
     rendered inside each artifact editor's own toolbar (P-10.5). Hidden while
     the tab's artifact is a draft/temp id: the export dialog intersects with
     COMMITTED headers, so a staged-only artifact has nothing to export. -->
<script lang="ts">
	import { FileUp } from '@lucide/svelte';
	import { getDynamicTabs, openExportArtifacts } from '$lib/state';
	import { isTempId } from '$lib/state/ops';

	let { tabId }: { tabId: string } = $props();
	const tab = $derived(getDynamicTabs().find((t) => t.id === tabId) ?? null);
	const artifactId = $derived(tab?.artifactId ?? null);
	const exportable = $derived(artifactId !== null && !isTempId(artifactId));
</script>

{#if tab && artifactId !== null && exportable}
	<button
		type="button"
		data-testid="tab-export"
		aria-label={`Export ${tab.title}…`}
		title={`Export ${tab.title}…`}
		class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
		onclick={() => openExportArtifacts([artifactId])}
	>
		<FileUp class="size-3.5" />
	</button>
{/if}
```

- [ ] **Step 3: Place it in the four editors, remove the strip button**

Each editor imports it and drops `<ArtifactExportButton {tabId} />` into the toolbar row named in **Files** (all four already have `tabId` in scope as a prop). In `Workspace.svelte`, delete the `{@const activeArtifact}`/`{@const seedId}` block and the strip button (old lines 77–92) plus the orphaned imports.

- [ ] **Step 4: Run the tests**

Run: `pixi run frontend-test -- src/lib/components/__tests__/ArtifactExportButton.test.ts src/lib/components/__tests__/Workspace.tabs.test.ts`
Expected: PASS. Then `pixi run frontend-test` — fix any editor test that snapshots its toolbar.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): per-artifact export button lives in each editor toolbar (P-10.5)"
```

---

### Task 6: Backend — `check` (validator identity) on Issue, stamped by the pipeline, on the wire

**Files:**
- Modify: `src/data_rover/core/validation/issue.py` (field)
- Modify: `src/data_rover/core/validation/pipeline.py` (protocol attr + stamping)
- Modify: `src/data_rover/core/validation/validators/{type_conformance,multiplicity,facets,endpoint_typing,containment,uniqueness}.py` (one class attr each)
- Modify: `src/data_rover/core/view/validation.py` (six `Issue(...)` sites gain `check="view"`)
- Modify: `src/data_rover/api/schemas.py:117-134` (`IssueOut.check` + `from_core`)
- Test: `tests/validation/test_check_names.py` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks (backend-only; independent).
- Produces: `Issue.check: str = ""`; validator classes each carry `check_name: str` (values: `"type_conformance"`, `"multiplicity"`, `"facets"`, `"endpoint_typing"`, `"containment"`, `"uniqueness"`); view warnings carry `check="view"`; `IssueOut.check: str = ""`. Task 7 filters on these exact strings.

- [ ] **Step 1: Write the failing tests**

`tests/validation/test_check_names.py`:

```python
from data_rover.core.validation.issue import Issue, Severity
from data_rover.core.validation.pipeline import (
    EntityValidator,
    ValidationPipeline,
    default_pipeline,
)


def test_default_pipeline_validators_declare_check_names():
    names = {v.check_name for v in default_pipeline()._validators}
    assert names == {
        "type_conformance",
        "multiplicity",
        "facets",
        "endpoint_typing",
        "containment",
        "uniqueness",
    }


class _Fake(EntityValidator):
    check_name = "fake"

    def validate_global(self, model, scope):
        return [
            Issue(Severity.ERROR, "boom"),
            Issue(Severity.WARNING, "pre", check="preset"),
        ]


class _EmptyModel:
    elements: dict = {}
    relationships: dict = {}


def test_pipeline_stamps_unset_check_with_the_validator_name():
    issues = ValidationPipeline([_Fake()]).validate(_EmptyModel())
    assert [i.check for i in issues] == ["fake", "preset"]
```

Add to the api tests (append to an existing validation-route test file, e.g. `tests/api/test_validation.py`, using its `client`/`papi` helpers): assert that `GET /model/issues` items include a `check` key, and that `IssueOut.model_validate({"severity": "error", "message": "m", "target_ids": []})` still parses (legacy JSON without `check`).

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/validation/test_check_names.py -v`
Expected: FAIL — `Issue.__init__` has no `check`, validators have no `check_name`.

- [ ] **Step 3: Implement**

- `issue.py`: after `category`, add

```python
    #: producing validator's stable name ("multiplicity", "facets", ...);
    #: stamped centrally by the ValidationPipeline from each validator's
    #: `check_name`, so construction sites stay unchanged. "" = not from a
    #: pipeline validator (the UI buckets those as "Other"); view-tree
    #: warnings carry "view" (stamped at their construction sites — they
    #: never pass through the pipeline).
    check: str = ""
```

- `pipeline.py`: add `check_name: str` to the `Validator` protocol body and `check_name: str = ""` to `EntityValidator`. Add a module-level helper and use it at all four `issues.extend(...)` sites in `validate`:

```python
def _stamped(validator: Validator, issues: list[Issue]) -> list[Issue]:
    """Stamp the producing validator's identity onto unset `check` fields.

    Central so the ~20 Issue construction sites stay untouched and a new
    validator gets stamping for free by declaring `check_name`.
    """
    name = getattr(validator, "check_name", "")
    if name:
        for issue in issues:
            if not issue.check:
                issue.check = name
    return issues
```

(each `issues.extend(validator.validate_element(model, el))` becomes `issues.extend(_stamped(validator, validator.validate_element(model, el)))`, etc.)

- Each of the six validator classes gets `check_name = "<its name>"` as the first class-body line.
- `core/view/validation.py`: add `check="view"` (keyword) to all six `Issue(` constructions.
- `schemas.py` `IssueOut`: add `check: str = ""` after `category`, and `check=issue.check` in `from_core`.

- [ ] **Step 4: Run the backend suite**

Run: `pixi run -e core-dev pytest tests/validation/test_check_names.py -v` → PASS.
Run: `pixi run core-test` → PASS (existing tests construct `Issue` positionally/without `check`, which defaults — no churn expected; fix any equality-comparison test that compares full Issue objects across the stamp boundary by including the expected `check`).
Run: `pixi run backend-lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover tests
git commit -m "feat(api): issues carry their producing validator's identity (check) for U-1"
```

---

### Task 7: IssuesPanel — per-validator chip filter + counts (U-1)

**Files:**
- Modify: `frontend/src/lib/api/types.ts:27-33` (`IssueSchema` gains `check`)
- Modify: `frontend/src/lib/components/Workspace/IssuesPanel.svelte`
- Test: `frontend/src/lib/components/__tests__/IssuesPanel.check.test.ts` (create; copy the render/state-seeding bootstrap from `IssuesPanel.origin.test.ts`)

**Interfaces:**
- Consumes: Task 6's `check` values on the wire (`""` buckets as "Other", `"view"` for view warnings).
- Produces: chip row `data-testid="check-chips"`; chips labeled from `CHECK_LABELS` with counts; clicking filters; composes with the existing origin filter.

- [ ] **Step 1: Write the failing test**

```ts
// seed issues via the same store setters IssuesPanel.origin.test.ts uses,
// with checks: two 'multiplicity' errors, one 'facets' warning, one '' error
it('renders one chip per check with counts and an All chip', () => {
	render(IssuesPanel);
	const chips = screen.getByTestId('check-chips');
	expect(within(chips).getByText('All')).toBeInTheDocument();
	expect(within(chips).getByText('Multiplicity (2)')).toBeInTheDocument();
	expect(within(chips).getByText('Facets (1)')).toBeInTheDocument();
	expect(within(chips).getByText('Other (1)')).toBeInTheDocument();
});

it('clicking a chip filters the list to that check', async () => {
	render(IssuesPanel);
	await fireEvent.click(screen.getByText('Facets (1)'));
	expect(screen.queryByText(/multiplicity issue message/)).toBeNull();
	expect(screen.getByText(/facets issue message/)).toBeInTheDocument();
});
```

Run: `pixi run frontend-test -- src/lib/components/__tests__/IssuesPanel.check.test.ts`
Expected: FAIL — no chips testid.

- [ ] **Step 2: Implement**

- `types.ts` `IssueSchema`: add `check: z.string().default('')` after `target_ids` (the frontend schema carries no `category` field today; do not add one — only `check`).
- `IssuesPanel.svelte`:

```ts
const CHECK_LABELS: Record<string, string> = {
	type_conformance: 'Type conformance',
	multiplicity: 'Multiplicity',
	facets: 'Facets',
	endpoint_typing: 'Endpoint typing',
	containment: 'Containment',
	uniqueness: 'Uniqueness',
	view: 'View'
};
function checkLabel(check: string): string {
	return CHECK_LABELS[check] ?? (check === '' ? 'Other' : check);
}

let checkFilter = $state<string | null>(null); // null = All

// counts over the ORIGIN-filtered set (chips and origin filter compose;
// resolved rows are excluded, same rule as the header summary)
const checkCounts = $derived.by(() => {
	const m = new Map<string, number>();
	for (const i of filtered) {
		if (i.origin === 'resolved') continue;
		m.set(i.check, (m.get(i.check) ?? 0) + 1);
	}
	return m;
});
const checkFiltered = $derived(
	checkFilter === null ? filtered : filtered.filter((i) => i.check === checkFilter)
);
```

- `errors`/`warnings`/`resolved` now derive from `checkFiltered` instead of `filtered`.
- Chip row, rendered whenever `issues.length > 0` (NOT gated on `overlayMode`, unlike the origin row), above the origin filter row, using the origin row's exact button styling:

```svelte
<div class="mb-2 flex flex-wrap gap-1" data-testid="check-chips">
	<button type="button" class="..." onclick={() => (checkFilter = null)}>All</button>
	{#each [...checkCounts.entries()] as [check, count] (check)}
		<button type="button" class="..." onclick={() => (checkFilter = check)}>
			{checkLabel(check)} ({count})
		</button>
	{/each}
</div>
```

(`class="..."` = copy the active/inactive conditional classes from the origin filter buttons at old lines 202–211, keyed on `checkFilter === null` / `checkFilter === check`.)
- `rerun()` resets `checkFilter = null` alongside `filter = 'all'`; add the same reset to the `$effect` that clears the origin filter when leaving overlay mode — a check that disappears from the live set must not strand an empty view, so also reset when `checkCounts` no longer contains `checkFilter`:

```ts
$effect(() => {
	if (checkFilter !== null && !checkCounts.has(checkFilter)) checkFilter = null;
});
```

- The view warnings need no client-side stamping — they arrive from the server with `check: "view"` (Task 6).

- [ ] **Step 3: Run the tests**

Run: `pixi run frontend-test -- src/lib/components/__tests__/IssuesPanel.check.test.ts src/lib/components/__tests__/IssuesPanel.origin.test.ts src/lib/components/__tests__/IssuesPanel.live.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): per-validator chip filter in the Issues panel (U-1)"
```

---

### Task 8: Docs, backlog, full gate

**Files:**
- Modify: `frontend/README.md` (workspace tab strip / palette / export-button sections)
- Modify: `CLAUDE.md` (two stale mentions: "both also reachable from the command palette" in the artefacts Phase 3 bullet; "a per-tab export button in the workspace tab strip")
- Modify: `BACKLOG.md`

**Interfaces:** none — documentation only, plus the release gate.

- [ ] **Step 1: Update the docs**

- `frontend/README.md`: grep for `Detail`, `Graph`, `command palette`, `⌘K`, `tab strip` and rewrite each affected passage to the new reality (dynamic-only strip + placeholder; Issues as a singleton closable tab opened from the top bar; eight flat top-bar controls; export button in editor toolbars; shortcuts are Cmd+S/Cmd+E only).
- `CLAUDE.md`: fix the two mentions above; add "Issues is a closable singleton workspace tab opened from the top bar" wherever the fixed tabs are described.
- `BACKLOG.md`: mark `P-10` and `U-1` `done` (with today's date and one line each); delete `T-1` (its two reasons — the test exists / the palette is gone — are both now moot, and done/won't-do items are kept only for context); update the "Last updated" header line. Leave `F-5` (its latent-bug analysis still holds — the seed caller is now the editor button, still dynamic-tab-sourced) and `T-2` untouched.

- [ ] **Step 2: Run the full gate**

Run: `pixi run dr-tidy`
Expected: clean (commit any pure-formatting fixups it makes).
Run: `pixi run dr-test`
Expected: core pytest + frontend vitest fully green. Fix anything red before proceeding — no known-failure carve-outs.

- [ ] **Step 3: Commit**

```bash
git add frontend/README.md CLAUDE.md BACKLOG.md
git commit -m "docs: top bar restructure (P-10) + issues filter (U-1) — README/CLAUDE/BACKLOG"
```

---

## Notes for the executor

- Tasks 1→5 are sequential (each builds on the prior's exports). Task 6 is independent of 1–5; Task 7 needs 6; Task 8 needs everything.
- `WorkspacePage.*.test.ts` and `TopBar.strict.test.ts` are the likeliest collateral-damage suites — fix them inside whichever task broke them, not in Task 8.
- e2e (`frontend-test-e2e`) is NOT in this wave's gate (spec §9 defers it to T-7), but if you run it, `helpers/load.ts`/auth flakes are known (BACKLOG T-4) — rerun before diagnosing.
