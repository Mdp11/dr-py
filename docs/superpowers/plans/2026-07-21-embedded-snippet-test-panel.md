# Embedded Snippet Test Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give table script columns and navigation script steps a **Test** panel — bind elements, run the snippet, read the result — inside the embedded editor where the code is written.

**Architecture:** Frontend only. `POST /snippets/run` already accepts inline `code` *or* a saved `artifact_id`, plus `entry` + `element_ids`, and already validates the count rules (`value` ≥ 1, `step` == 1); it is a read-only POST so viewers may use it. Two existing components are made reusable (`ElementContextRow` becomes controlled; `SnippetConsole`'s presentation is extracted into `SnippetResultView`), and a new `SnippetTestPanel` composes them with component-local run state — mirroring the component-local debounced lint that `SnippetSourceEditor` already runs.

**Tech Stack:** SvelteKit / Svelte 5 runes (`$state`, `$derived`, `$props`), TypeScript, Vitest + happy-dom + MSW, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-21-embedded-snippet-test-panel-design.md`

## Global Constraints

- **No backend changes.** Not one file under `src/data_rover/`. If a task seems to need one, stop and re-read the spec.
- **Svelte 5 runes only** — `$state` / `$derived` / `$props` / `$effect`. No stores, no `export let`.
- **Test convention:** raw `mount` / `flushSync` / `unmount` from `svelte` (see `frontend/src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts`). `@testing-library/svelte` is **not** a project dependency — do not add it.
- **MSW server** is imported from `../../../api/__tests__/server` (relative depth from `components/Snippet/__tests__/`) and started with `server.listen({ onUnhandledRequest: 'error' })`.
- **Frontend commands must run from inside `frontend/`** — the bare `pixi run -e frontend npm test` fails with "Missing script" because pixi runs it from the repo root. Always: `pixi run -e frontend bash -c 'cd frontend && npm …'`.
- **Preserve the dense why-docstring style** of the components you touch. Each file in this repo opens with a comment explaining the invariant it upholds; extend it, don't strip it.
- Existing `data-testid` values are load-bearing (e2e + unit tests reference them). Never rename one; only add.
- **No Stop button** anywhere in the new panel — M1's cancel is a server-side no-op and `wall_timeout_s` defaults to 10s.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/lib/components/Snippet/ElementContextRow.svelte` | **Modify** — controlled element-binding row (chips + fuzzy search + "Use current selection"). Owns no list state after this change. |
| `frontend/src/lib/components/Snippet/SnippetResultView.svelte` | **Create** — pure presentation of a run outcome (spinner, notice, stale banner, stdout, result repr, footer, error box + traceback, op list + optional footer snippet). |
| `frontend/src/lib/components/Snippet/SnippetConsole.svelte` | **Modify** — thin store-bound wrapper over `SnippetResultView`; keeps ops staging. |
| `frontend/src/lib/components/Snippet/SnippetTestPanel.svelte` | **Create** — collapsible test panel: local run state, run gating, error mapping, composes the two above. |
| `frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte` | **Modify** — renders the panel in both ref and inline modes; wires `Mod-Enter` and traceback→cursor. |
| `frontend/src/lib/components/Snippet/SnippetTab.svelte` | **Modify** — passes store-backed props to the now-controlled `ElementContextRow`. |
| `frontend/src/lib/components/Snippet/__tests__/element-context-row.test.ts` | **Modify** — assert callbacks instead of store writes. |
| `frontend/src/lib/components/Snippet/__tests__/snippet-result-view.test.ts` | **Create** — ops footer presence/absence. |
| `frontend/src/lib/components/Snippet/__tests__/snippet-test-panel.test.ts` | **Create** — request shape, gating, error notices, ops, unmount race. |
| `frontend/src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts` | **Modify** — panel present in both modes. |
| `frontend/e2e/script-embedding.spec.ts` | **Modify** — one end-to-end test leg through the real sandbox. |
| `frontend/README.md` | **Modify** — document the panel in the "Script columns & steps (M2/M3)" section. |

---

### Task 1: Make `ElementContextRow` controlled

Today the row reaches into the tab-keyed store (`getSnippetRun(tabId)`, `addSnippetElement`, …). The test panel has no tab id and no store entry, so the row must take its data as props. Its component-local debounced search and its read of the *global* selection stores stay — those are genuinely global, not tab state.

Note where the `step`-replaces / `value`-appends rule lives after this change: the **"which selected ids to bind"** half stays in the row (it depends on `entry`, which is still a prop); the **"replace vs append/dedupe"** half moves to whoever owns the list — `addSnippetElement` for `SnippetTab` (unchanged), and a local `addElement` in Task 3's panel.

**Files:**
- Modify: `frontend/src/lib/components/Snippet/ElementContextRow.svelte`
- Modify: `frontend/src/lib/components/Snippet/SnippetTab.svelte:174-176`
- Test: `frontend/src/lib/components/Snippet/__tests__/element-context-row.test.ts` (rewrite)

**Interfaces:**
- Consumes: `SnippetBoundElement` (`{ id: string; label: string }`) and `BoundEntry` (`'value' | 'step'`), both already exported — from `$lib/state` and `$lib/snippet/entry-stubs` respectively.
- Produces: `ElementContextRow` props `{ entry: BoundEntry; elements: SnippetBoundElement[]; onAdd: (id: string, label: string) => void; onRemove: (id: string) => void; onClear: () => void }`. Task 3 mounts it with exactly these.

- [ ] **Step 1: Rewrite the failing test**

Replace the entire contents of `frontend/src/lib/components/Snippet/__tests__/element-context-row.test.ts`:

```ts
// "Use current selection" binds elements from the shared multi-selection.
// The row is CONTROLLED (Task 1): it owns no list state, so these tests
// assert the emitted callbacks rather than reading a store. Follows the
// repo's raw mount/flushSync Svelte-5 convention (see
// Table/__tests__/ColumnManager.test.ts).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';

import type { Element } from '$lib/api/types';
import {
	clearSelection,
	getMultiSelectedIds,
	seedElements,
	select,
	type SnippetBoundElement
} from '$lib/state';
import ElementContextRow from '../ElementContextRow.svelte';

function el(id: string, name: string): Element {
	return { id, type_name: 'Block', properties: { name }, rev: 1 };
}

function render(
	entry: 'value' | 'step',
	elements: SnippetBoundElement[],
	onAdd: (id: string, label: string) => void
) {
	const c = mount(ElementContextRow, {
		target: document.body,
		props: { entry, elements, onAdd, onRemove: () => {}, onClear: () => {} }
	});
	flushSync();
	return c;
}

function clickUseSelection(): void {
	const btn = [...document.querySelectorAll('button')].find((b) =>
		b.textContent?.includes('Use current selection')
	);
	if (!btn) throw new Error('Use current selection button not found');
	btn.click();
	flushSync();
}

afterEach(() => {
	getMultiSelectedIds().clear();
	clearSelection();
	document.body.innerHTML = '';
});

it('emits onAdd for every multi-selected element for a value entry', () => {
	seedElements([el('a', 'Alpha'), el('b', 'Beta')]);
	const ms = getMultiSelectedIds();
	ms.add('a');
	ms.add('b');
	select({ kind: 'element', id: 'b' }); // primary; the whole set should win

	const onAdd = vi.fn();
	const c = render('value', [], onAdd);
	try {
		clickUseSelection();
		const ids = onAdd.mock.calls.map((call) => call[0] as string).sort();
		expect(ids).toEqual(['a', 'b']);
	} finally {
		unmount(c);
	}
});

it('emits onAdd only for the primary selection for a step entry', () => {
	seedElements([el('a', 'Alpha'), el('b', 'Beta')]);
	const ms = getMultiSelectedIds();
	ms.add('a');
	ms.add('b');
	select({ kind: 'element', id: 'b' });

	const onAdd = vi.fn();
	const c = render('step', [], onAdd);
	try {
		clickUseSelection();
		expect(onAdd.mock.calls.map((call) => call[0])).toEqual(['b']);
	} finally {
		unmount(c);
	}
});

it('falls back to the single primary selection when nothing is multi-selected', () => {
	seedElements([el('a', 'Alpha')]);
	select({ kind: 'element', id: 'a' });

	const onAdd = vi.fn();
	const c = render('value', [], onAdd);
	try {
		clickUseSelection();
		expect(onAdd.mock.calls.map((call) => call[0])).toEqual(['a']);
	} finally {
		unmount(c);
	}
});

it('renders a chip per bound element and emits onRemove for the clicked one', () => {
	const onRemove = vi.fn();
	const c = mount(ElementContextRow, {
		target: document.body,
		props: {
			entry: 'value' as const,
			elements: [
				{ id: 'a', label: 'Alpha' },
				{ id: 'b', label: 'Beta' }
			],
			onAdd: () => {},
			onRemove,
			onClear: () => {}
		}
	});
	flushSync();
	try {
		const removeBeta = document.querySelector('[aria-label="Remove Beta"]') as HTMLButtonElement;
		expect(removeBeta).toBeTruthy();
		removeBeta.click();
		flushSync();
		expect(onRemove).toHaveBeenCalledWith('b');
	} finally {
		unmount(c);
	}
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- element-context-row'`
Expected: FAIL — the component still requires a `tabId` prop and reads the store, so `onAdd` is never called (`expect(ids).toEqual(['a','b'])` receives `[]`).

- [ ] **Step 3: Make the row controlled**

In `frontend/src/lib/components/Snippet/ElementContextRow.svelte`, replace the header comment, imports, props, and the two handlers:

```svelte
<script lang="ts">
	// Shown only for `value`/`step` entry points. CONTROLLED: the row owns no
	// list state — it renders `elements` and emits add/remove/clear. Two
	// owners exist: SnippetTab (backed by the tab-keyed store in
	// state/snippet-editor.svelte.ts) and SnippetTestPanel (component-local
	// $state, no tab id to key by). The `value` appends / `step` replaces rule
	// therefore lives with the OWNER; what stays here is the half that depends
	// on `entry` — which selected ids "Use current selection" offers up.
	// The micro-search is a component-local debounce (see
	// Navigation/ElementStartPicker.svelte for the same shape), not a store:
	// nothing here outlives the row.
	import { getCachedElements, getMultiSelectedIds, getSelection } from '$lib/state';
	import { listElementsPage } from '$lib/api/model-read';
	import { elementDisplayName } from '$lib/util/element-name';
	import type { BoundEntry } from '$lib/snippet/entry-stubs';
	import type { SnippetBoundElement } from '$lib/state';
	import type { Element } from '$lib/api/types';

	const MAX_RESULTS = 8;
	const DEBOUNCE_MS = 250;

	let {
		entry,
		elements,
		onAdd,
		onRemove,
		onClear
	}: {
		entry: BoundEntry;
		elements: SnippetBoundElement[];
		onAdd: (id: string, label: string) => void;
		onRemove: (id: string) => void;
		onClear: () => void;
	} = $props();

	const selection = $derived(getSelection());
	const multiSelected = getMultiSelectedIds();
	const canUseSelection = $derived(selection?.kind === 'element' || multiSelected.size > 0);
```

Leave `query` / `results` / `searching` / `searchSeq` and the whole `$effect` search block exactly as they are. Then replace `useSelection` and `pick`:

```svelte
	function useSelection(): void {
		// `value` offers every selected element; `step` offers exactly one (the
		// primary/last-touched selection — the owner's onAdd replaces for step).
		const primary = selection?.kind === 'element' ? [selection.id] : [];
		const ids = entry === 'step' ? primary : multiSelected.size > 0 ? [...multiSelected] : primary;
		const cache = getCachedElements();
		for (const id of ids) {
			const el = cache.get(id);
			if (el) onAdd(el.id, elementDisplayName(el));
		}
	}

	function pick(el: Element): void {
		onAdd(el.id, elementDisplayName(el));
		query = '';
		results = [];
	}
</script>
```

In the markup, replace the four `run.` / store references:

- `{run.entry === 'step' ? 'Element:' : 'Elements:'}` → `{entry === 'step' ? 'Element:' : 'Elements:'}`
- `{#if run.elements.length === 0}` → `{#if elements.length === 0}`
- `{#each run.elements as bound (bound.id)}` → `{#each elements as bound (bound.id)}`
- `onclick={() => removeSnippetElement(tabId, bound.id)}` → `onclick={() => onRemove(bound.id)}`
- `{#if run.elements.length >= 2}` → `{#if elements.length >= 2}`
- `onclick={() => clearSnippetElements(tabId)}` → `onclick={() => onClear()}`

- [ ] **Step 4: Update the `SnippetTab` call site**

In `frontend/src/lib/components/Snippet/SnippetTab.svelte`, replace line 175:

```svelte
			{#if run.entry !== 'script'}
				<ElementContextRow
					entry={run.entry}
					elements={run.elements}
					onAdd={(id, label) => addSnippetElement(tabId, id, label)}
					onRemove={(id) => removeSnippetElement(tabId, id)}
					onClear={() => clearSnippetElements(tabId)}
				/>
			{/if}
```

and add the three functions to the existing `$lib/state` import block at the top (alphabetical, matching the block's ordering):

```svelte
	import {
		addSnippetElement,
		canEdit,
		clearSnippetElements,
		ensureSnippetDocs,
		ensureSnippetDraft,
		getMetamodel,
		getSnippetDocs,
		getSnippetDraft,
		getSnippetLint,
		getSnippetRun,
		getSnippetSaveConflict,
		reloadSnippetDraft,
		removeSnippetElement,
		runSnippetTab,
		saveSnippetDraft,
		setSnippetEntry,
		setSnippetName,
		stopSnippetTab,
		updateSnippetCode
	} from '$lib/state';
```

Note `run.entry` is narrowed to `'value' | 'step'` inside the `{#if run.entry !== 'script'}` block, which satisfies the `BoundEntry` prop type.

- [ ] **Step 5: Run the tests and typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- element-context-row'`
Expected: PASS, 4 tests.

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Snippet/ElementContextRow.svelte \
        frontend/src/lib/components/Snippet/SnippetTab.svelte \
        frontend/src/lib/components/Snippet/__tests__/element-context-row.test.ts
git commit -m "refactor(snippet): make ElementContextRow controlled

Props replace the tab-keyed store reads so a second owner (the embedded
test panel) can mount it without a tab id."
```

---

### Task 2: Extract `SnippetResultView` from `SnippetConsole`

`SnippetConsole` is welded to the tab-keyed store. Split its presentation out so the test panel can render the identical result surface — spinner, notice, stale banner, stdout, result repr, footer, error box with clickable traceback frames, op list — without staging.

The Stage button sits *inside* the ops block, so it is passed as a Svelte 5 snippet (`opsFooter`) rather than a `canStage` boolean. Its presence is what decides whether anything renders under the op list; the test panel supplies its read-only warning through the same slot. **Deviation from the spec:** the spec described the test panel's warning as sitting *above* the ops; one footer slot below the list serves both callers with no second snippet prop, and the sentence reads the same either way.

**Files:**
- Create: `frontend/src/lib/components/Snippet/SnippetResultView.svelte`
- Modify: `frontend/src/lib/components/Snippet/SnippetConsole.svelte`
- Test: `frontend/src/lib/components/Snippet/__tests__/snippet-result-view.test.ts`

**Interfaces:**
- Consumes: `SnippetRunOut` (`$lib/api/snippets`), `SnippetRunPhase` (`$lib/state`), and `errorKindLabel` / `tracebackLines` / `opSummary` (`$lib/snippet/console-view`).
- Produces: `SnippetResultView` props `{ phase: SnippetRunPhase; notice: string | null; result: SnippetRunOut | null; stale: boolean; onGoToLine: (line: number) => void; opsFooter?: Snippet }`. Task 3 renders it with exactly these.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/Snippet/__tests__/snippet-result-view.test.ts`:

```ts
// SnippetResultView is pure presentation (Task 2): every branch is a function
// of its props, so these tests need no store and no MSW.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';

import type { SnippetRunOut } from '$lib/api/snippets';
import SnippetResultView from '../SnippetResultView.svelte';

function result(over: Partial<SnippetRunOut> = {}): SnippetRunOut {
	return {
		run_id: 'r1',
		stdout: '',
		result_repr: null,
		ops: [],
		error: null,
		duration_ms: 7,
		model_rev: 0,
		stale: false,
		truncated: false,
		...over
	} as SnippetRunOut;
}

function render(props: Record<string, unknown>) {
	const c = mount(SnippetResultView, {
		target: document.body,
		props: { phase: 'idle', notice: null, result: null, stale: false, onGoToLine: () => {}, ...props }
	});
	flushSync();
	return c;
}

afterEach(() => {
	document.body.innerHTML = '';
});

it('renders stdout, the result repr and the duration footer', () => {
	const c = render({ result: result({ stdout: 'hello', result_repr: "['A']" }) });
	try {
		expect(document.querySelector('[data-testid="snippet-stdout"]')?.textContent).toBe('hello');
		expect(document.querySelector('[data-testid="snippet-result"]')?.textContent).toBe("['A']");
		expect(document.body.textContent).toContain('7 ms');
	} finally {
		unmount(c);
	}
});

it('lists ops and renders nothing under them without an opsFooter', () => {
	const ops = [{ kind: 'delete_element', id: 'e1' }] as SnippetRunOut['ops'];
	const c = render({ result: result({ ops }) });
	try {
		expect(document.querySelector('[data-testid="snippet-ops"]')?.textContent).toContain(
			'delete e1'
		);
		expect(document.querySelector('[data-testid="snippet-stage"]')).toBeNull();
	} finally {
		unmount(c);
	}
});

it('shows the running spinner and the notice line', () => {
	const c = render({ phase: 'running', notice: 'Another run is already in progress.' });
	try {
		expect(document.body.textContent).toContain('Running…');
		expect(document.querySelector('[data-testid="snippet-notice"]')?.textContent).toContain(
			'Another run is already in progress.'
		);
	} finally {
		unmount(c);
	}
});

it('renders the error box with its kind label', () => {
	const c = render({
		result: result({ error: { kind: 'runtime', message: 'boom', traceback: null } })
	});
	try {
		const box = document.querySelector('[data-testid="snippet-error"]');
		expect(box?.textContent).toContain('Runtime error');
		expect(box?.textContent).toContain('boom');
	} finally {
		unmount(c);
	}
});

it('shows the stale banner when told it is stale', () => {
	const c = render({ result: result(), stale: true });
	try {
		expect(document.querySelector('[data-testid="snippet-stale"]')).not.toBeNull();
	} finally {
		unmount(c);
	}
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- snippet-result-view'`
Expected: FAIL — `Failed to resolve import "../SnippetResultView.svelte"`.

- [ ] **Step 3: Create `SnippetResultView.svelte`**

Create `frontend/src/lib/components/Snippet/SnippetResultView.svelte`:

```svelte
<script lang="ts">
	// Pure presentation of one run outcome — extracted from SnippetConsole so
	// two owners can render the identical surface: the tab console (store-backed,
	// stages ops) and the embedded test panel (component-local state, cannot).
	// Everything here is a function of its props: no store reads, no fetches.
	//
	// The Stage button lives INSIDE the ops block, so it arrives as the
	// `opsFooter` snippet rather than a `canStage` flag — its presence is what
	// decides whether anything renders under the list, and the test panel uses
	// the same slot for its "these ops are discarded" warning.
	import type { Snippet } from 'svelte';
	import type { SnippetRunOut } from '$lib/api/snippets';
	import type { SnippetRunPhase } from '$lib/state';
	import { errorKindLabel, opSummary, tracebackLines } from '$lib/snippet/console-view';

	let {
		phase,
		notice,
		result,
		stale,
		onGoToLine,
		opsFooter
	}: {
		phase: SnippetRunPhase;
		notice: string | null;
		result: SnippetRunOut | null;
		stale: boolean;
		onGoToLine: (line: number) => void;
		opsFooter?: Snippet;
	} = $props();

	let tracebackOpen = $state(false);
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 text-xs">
	{#if phase === 'running'}
		<div class="flex items-center gap-2 text-muted-foreground">
			<div class="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary"></div>
			Running…
		</div>
	{:else if phase === 'stopping'}
		<p class="text-warning">Stopping — run ends at wall timeout.</p>
	{/if}

	{#if notice}
		<p data-testid="snippet-notice" class="text-warning">{notice}</p>
	{/if}

	{#if result}
		{#if stale}
			<p data-testid="snippet-stale" class="rounded bg-warning/15 px-2 py-1 text-warning">
				The model changed during/after this run — results may be out of date. Re-run before
				staging.
			</p>
		{/if}

		{#if result.stdout}
			<pre
				data-testid="snippet-stdout"
				class="whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">{result.stdout}</pre>
		{/if}

		{#if result.result_repr !== null}
			<pre
				data-testid="snippet-result"
				class="whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">{result.result_repr}</pre>
		{/if}

		<div class="flex items-center gap-2 text-muted-foreground/70">
			{#if result.truncated}
				<span class="rounded bg-muted px-1 text-[10px]">output truncated at server limit</span>
			{/if}
			<span>{result.duration_ms} ms</span>
		</div>

		{#if result.error}
			{@const error = result.error}
			<div
				data-testid="snippet-error"
				class="rounded border border-destructive/30 bg-destructive/10 p-2"
			>
				<div class="flex items-center gap-2">
					<span class="rounded bg-destructive/20 px-1 text-[10px] text-destructive">
						{errorKindLabel(error.kind)}
					</span>
					<span class="text-destructive">{error.message}</span>
				</div>
				{#if error.traceback}
					<button
						type="button"
						class="mt-1 text-[11px] underline"
						onclick={() => (tracebackOpen = !tracebackOpen)}
					>
						{tracebackOpen ? 'Hide' : 'Show'} traceback
					</button>
					{#if tracebackOpen}
						<div class="mt-1 flex flex-col font-mono text-[11px]">
							{#each tracebackLines(error.traceback) as tl, i (i)}
								{#if tl.line !== null}
									<button
										type="button"
										class="whitespace-pre text-left text-info/90 underline decoration-dotted hover:text-info"
										onclick={() => onGoToLine(tl.line as number)}
									>
										{tl.text}
									</button>
								{:else}
									<span class="whitespace-pre">{tl.text}</span>
								{/if}
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		{/if}

		{#if result.ops.length > 0}
			<div class="flex flex-col gap-1">
				<ul data-testid="snippet-ops" class="flex flex-col gap-0.5 font-mono text-[11px]">
					{#each result.ops as op, i (i)}
						<li>{opSummary(op)}</li>
					{/each}
				</ul>
				{@render opsFooter?.()}
			</div>
		{/if}
	{/if}
</div>
```

- [ ] **Step 4: Reduce `SnippetConsole.svelte` to the store-bound wrapper**

Replace the entire contents of `frontend/src/lib/components/Snippet/SnippetConsole.svelte`:

```svelte
<script lang="ts">
	// Store-bound wrapper over SnippetResultView: reads the run state for
	// `tabId`, derives staleness against the live model rev, and owns the ONE
	// thing the pure view cannot — staging the run's recorded ops into the op
	// buffer. Everything else is presentation and lives in SnippetResultView
	// (shared with the embedded test panel, which stages nothing).
	import { canEdit, getModelRev, getSnippetRun, markRunStaged, stageSnippetOps } from '$lib/state';
	import { isResultStale } from '$lib/snippet/console-view';
	import SnippetResultView from './SnippetResultView.svelte';

	let { tabId, onGoToLine }: { tabId: string; onGoToLine: (line: number) => void } = $props();

	const run = $derived(getSnippetRun(tabId));
	const stale = $derived(run.result ? isResultStale(run.result, getModelRev()) : false);
	const editable = $derived(canEdit());

	let stageError = $state<string | null>(null);

	async function stage(): Promise<void> {
		stageError = null;
		const result = getSnippetRun(tabId).result;
		if (!result) return;
		const outcome = await stageSnippetOps(result);
		if (outcome.ok) {
			markRunStaged(tabId);
		} else if (outcome.reason === 'missing') {
			stageError = 'One or more referenced elements no longer exist — re-run the snippet.';
		} else if (outcome.reason === 'empty') {
			stageError = 'Nothing to stage.';
		}
		// 'stale' -> `stale` above already re-derives from the same rev check
		// stageSnippetOps just performed, so the banner appears and the Stage
		// button disables on its own. 'locks' -> the shared lock-notice banner
		// (StatusBar / getLockNotice) already surfaces the refusal.
	}
</script>

{#snippet stageFooter()}
	{#if editable && run.result}
		{@const result = run.result}
		<button
			type="button"
			data-testid="snippet-stage"
			class="self-start rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
			disabled={stale || run.stagedRunId === result.run_id}
			onclick={() => void stage()}
		>
			{run.stagedRunId === result.run_id ? 'Staged' : `Stage ops (${result.ops.length})`}
		</button>
	{/if}
	{#if stageError}
		<p class="text-destructive">{stageError}</p>
	{/if}
{/snippet}

<div class="flex h-full flex-col overflow-hidden border-t border-border">
	<SnippetResultView
		phase={run.phase}
		notice={run.notice}
		result={run.result}
		{stale}
		{onGoToLine}
		opsFooter={stageFooter}
	/>
</div>
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- snippet-result-view'`
Expected: PASS, 5 tests.

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'`
Expected: PASS — the whole suite, confirming no existing console/tab test regressed on the extraction.

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Snippet/SnippetResultView.svelte \
        frontend/src/lib/components/Snippet/SnippetConsole.svelte \
        frontend/src/lib/components/Snippet/__tests__/snippet-result-view.test.ts
git commit -m "refactor(snippet): extract SnippetResultView from SnippetConsole

The console keeps the store reads and ops staging; the result surface
becomes a pure component the embedded test panel can reuse."
```

---

### Task 3: `SnippetTestPanel`

The new component: a collapsed **Test** disclosure that expands to the element row, a Run button, and the result view. Run state is component-local — `$state` plus a `runSeq` generation guard bumped in `onDestroy`, mirroring the debounced-lint discipline already in `SnippetSourceEditor`. Several script columns / script steps can be open at once, and a nav step has no stable key (its index shifts on reorder), which is exactly why there is no store here.

**Files:**
- Create: `frontend/src/lib/components/Snippet/SnippetTestPanel.svelte`
- Test: `frontend/src/lib/components/Snippet/__tests__/snippet-test-panel.test.ts`

**Interfaces:**
- Consumes: `ElementContextRow` props from Task 1; `SnippetResultView` props from Task 2; `runSnippet(body: SnippetRunBody)` and `SnippetRunOut` from `$lib/api/snippets`; `ApiError` from `$lib/api/errors`; `entryAvailable` / `BoundEntry` from `$lib/snippet/entry-stubs`; `getModelRev` + `SnippetBoundElement` + `SnippetRunPhase` from `$lib/state`; `isResultStale` from `$lib/snippet/console-view`; `SnippetSource` from `$lib/api/types`.
- Produces: props `{ snippet: SnippetSource; entry: BoundEntry; entryPoints: string[]; onGoToLine?: (line: number) => void }` and one exported method `requestRun(): Promise<void>` reachable via `bind:this`. Task 4 uses exactly these. **No test-only exports** — the tests bind elements by driving the real search picker.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/Snippet/__tests__/snippet-test-panel.test.ts`:

```ts
// The embedded Test panel (Task 3): component-local run state, run gating
// mirroring the server's SnippetRunIn validators, and a read-only ops
// surface. Follows the repo's mount/flushSync convention and drives
// POST /snippets/run through MSW (see snippet-source-editor.test.ts).
import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import { server } from '../../../api/__tests__/server';
import * as modelRead from '$lib/api/model-read';
import type { SnippetSource } from '$lib/api/types';
import SnippetTestPanel from '../SnippetTestPanel.svelte';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => vi.useFakeTimers()); // the element picker debounces 250 ms
afterEach(() => {
	server.resetHandlers();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
	vi.useRealTimers();
});
afterAll(() => server.close());

const OK_RESULT = {
	run_id: 'r1',
	stdout: '',
	result_repr: "['Alpha']",
	ops: [],
	error: null,
	duration_ms: 3,
	model_rev: 0,
	stale: false,
	truncated: false
};

/** Capture the body of the next POST /snippets/run and answer `response`. */
function captureRun(response: Record<string, unknown> = OK_RESULT): {
	body: () => Record<string, unknown> | null;
} {
	let seen: Record<string, unknown> | null = null;
	server.use(
		http.post('*/snippets/run', async ({ request }) => {
			seen = (await request.json()) as Record<string, unknown>;
			return HttpResponse.json(response);
		})
	);
	return { body: () => seen };
}

function inline(code: string): SnippetSource {
	return { definition: { schema_version: 1, language: 'python', code, entry_points: [] } };
}

function render(props: {
	snippet: SnippetSource;
	entry: 'value' | 'step';
	entryPoints: string[];
}) {
	const c = mount(SnippetTestPanel, {
		target: document.body,
		props: { onGoToLine: () => {}, ...props }
	});
	flushSync();
	return c;
}

function testid(id: string): HTMLElement | null {
	return document.querySelector(`[data-testid="${id}"]`);
}

function click(el: Element | null): void {
	if (!el) throw new Error('element not found');
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

function expand(): void {
	click(testid('snippet-test-toggle'));
}

/** Bind one element by driving the REAL picker inside ElementContextRow:
 * stub the search endpoint, type, let the 250 ms debounce fire, click the
 * result. The panel deliberately exposes no test-only bind method. */
async function bindElement(id: string, label: string): Promise<void> {
	vi.spyOn(modelRead, 'listElementsPage').mockResolvedValue({
		items: [{ id, type_name: 'Block', properties: { name: label }, rev: 1 }],
		total: 1
	});
	const search = testid('snippet-element-search') as HTMLInputElement;
	if (!search) throw new Error('element search not rendered — is the panel expanded?');
	search.value = label;
	search.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	await vi.advanceTimersByTimeAsync(300);
	flushSync();
	const option = [...document.querySelectorAll('button')].find((b) =>
		b.textContent?.includes(label)
	);
	if (!option) throw new Error(`no search result button for ${label}`);
	click(option);
}

it('is collapsed until the toggle is clicked', () => {
	const c = render({ snippet: inline('def value(els): return 1\n'), entry: 'value', entryPoints: ['value'] });
	try {
		expect(testid('snippet-test-run')).toBeNull();
		expand();
		expect(testid('snippet-test-run')).not.toBeNull();
	} finally {
		unmount(c);
	}
});

it('disables Run until the element count fits the entry', async () => {
	const snippet = inline('def value(els): return 1\n');
	const c = render({ snippet, entry: 'value', entryPoints: ['value'] });
	try {
		expand();
		const run = testid('snippet-test-run') as HTMLButtonElement;
		expect(run.disabled).toBe(true); // value needs >= 1 element
	} finally {
		unmount(c);
	}
});

it('disables Run when the entry point is missing', () => {
	const c = render({
		snippet: inline('def other(x): return 1\n'),
		entry: 'value',
		entryPoints: ['script']
	});
	try {
		expand();
		expect((testid('snippet-test-run') as HTMLButtonElement).disabled).toBe(true);
	} finally {
		unmount(c);
	}
});

it('disables Run for an unconfigured source', () => {
	const c = render({ snippet: {}, entry: 'value', entryPoints: ['value'] });
	try {
		expand();
		expect((testid('snippet-test-run') as HTMLButtonElement).disabled).toBe(true);
	} finally {
		unmount(c);
	}
});

it('posts inline code with the bound elements and renders the result', async () => {
	const captured = captureRun();
	const c = render({
		snippet: inline('def value(els): return 1\n'),
		entry: 'value',
		entryPoints: ['value']
	});
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(testid('snippet-result')).not.toBeNull());
		const body = captured.body()!;
		expect(body['code']).toContain('def value(els)');
		expect(body['artifact_id']).toBeUndefined();
		expect(body['entry']).toBe('value');
		expect(body['element_ids']).toEqual(['a']);
		expect(typeof body['run_id']).toBe('string');
		expect(testid('snippet-result')?.textContent).toBe("['Alpha']");
	} finally {
		unmount(c);
	}
});

it('posts artifact_id in saved mode', async () => {
	const captured = captureRun();
	const c = render({ snippet: { ref: 'snip-1' }, entry: 'step', entryPoints: ['step'] });
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(captured.body()).not.toBeNull());
		const body = captured.body()!;
		expect(body['artifact_id']).toBe('snip-1');
		expect(body['code']).toBeUndefined();
		expect(body['entry']).toBe('step');
	} finally {
		unmount(c);
	}
});

it('binds exactly one element for a step entry (a second pick replaces)', async () => {
	const captured = captureRun();
	const c = render({ snippet: { ref: 'snip-1' }, entry: 'step', entryPoints: ['step'] });
	try {
		expand();
		await bindElement('a', 'Alpha');
		await bindElement('b', 'Beta');
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(captured.body()).not.toBeNull());
		expect(captured.body()!['element_ids']).toEqual(['b']);
	} finally {
		unmount(c);
	}
});

it('surfaces the 429 and 503 notices', async () => {
	server.use(
		http.post('*/snippets/run', () => new HttpResponse(null, { status: 429 }))
	);
	const c = render({
		snippet: inline('def value(els): return 1\n'),
		entry: 'value',
		entryPoints: ['value']
	});
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() =>
			expect(testid('snippet-notice')?.textContent).toContain('Another run is already in progress')
		);
	} finally {
		unmount(c);
	}

	server.use(http.post('*/snippets/run', () => new HttpResponse(null, { status: 503 })));
	const c2 = render({
		snippet: inline('def value(els): return 1\n'),
		entry: 'value',
		entryPoints: ['value']
	});
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() =>
			expect(testid('snippet-notice')?.textContent).toContain('Code execution is unavailable')
		);
	} finally {
		unmount(c2);
	}
});

it('lists recorded ops with the read-only warning and no Stage button', async () => {
	captureRun({ ...OK_RESULT, ops: [{ kind: 'delete_element', id: 'e1' }] });
	const c = render({
		snippet: inline('def value(els): return 1\n'),
		entry: 'value',
		entryPoints: ['value']
	});
	try {
		expand();
		await bindElement('a', 'Alpha');
		click(testid('snippet-test-run'));
		await vi.waitFor(() => expect(testid('snippet-ops')).not.toBeNull());
		expect(testid('snippet-stage')).toBeNull();
		expect(testid('snippet-test-ops-readonly')?.textContent).toContain('discarded');
	} finally {
		unmount(c);
	}
});
```

The tests bind elements by driving the **real** picker (`bindElement`): stub `listElementsPage`, type into `snippet-element-search`, advance the 250 ms debounce, click the result. The panel exposes no test-only method.

**If MSW and Vitest's fake timers interfere** (the run request never resolves under `vi.waitFor`), fall back to the selection path instead — `seedElements([...])` + `select({ kind: 'element', id })` from `$lib/state`, then click the row's "Use current selection" button, exactly as `element-context-row.test.ts` does — which needs no timers at all. Say which path you used in your report.

- [ ] **Step 2: Run it to make sure it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- snippet-test-panel'`
Expected: FAIL — `Failed to resolve import "../SnippetTestPanel.svelte"`.

- [ ] **Step 3: Create `SnippetTestPanel.svelte`**

Create `frontend/src/lib/components/Snippet/SnippetTestPanel.svelte`:

```svelte
<script lang="ts">
	// The embedded Test panel: bind elements, run the snippet, read the result
	// — inside the table-script-column / navigation-script-step editor where
	// the code is actually written. Without it, an embedded snippet can only
	// be judged by the error cell or pruned chain it eventually produces.
	//
	// Run state is COMPONENT-LOCAL ($state + a runSeq generation guard bumped
	// in onDestroy), exactly like SnippetSourceEditor's debounced lint and
	// deliberately NOT the tab-keyed store in state/snippet-editor.svelte.ts:
	// several script columns / steps can be open at once, and a nav script
	// step has no stable key (its array index shifts when steps are reordered
	// or removed), so any keying scheme would silently re-attach one step's
	// result to another. The cost — collapsing the panel discards the last
	// result — is accepted: this is a scratch test, not a saved artifact.
	//
	// There is no Stop button on purpose. M1's POST /snippets/cancel performs
	// a real registry + ownership check but the abort itself is a no-op: a run
	// still ends only at wall_timeout_s (10s default). Offering Stop here
	// would be a lie in a panel this small.
	import { onDestroy } from 'svelte';
	import { runSnippet, type SnippetRunBody, type SnippetRunOut } from '$lib/api/snippets';
	import { ApiError } from '$lib/api/errors';
	import { getModelRev, type SnippetBoundElement, type SnippetRunPhase } from '$lib/state';
	import { isResultStale } from '$lib/snippet/console-view';
	import { entryAvailable, type BoundEntry } from '$lib/snippet/entry-stubs';
	import type { SnippetSource } from '$lib/api/types';
	import ElementContextRow from './ElementContextRow.svelte';
	import SnippetResultView from './SnippetResultView.svelte';

	let {
		snippet,
		entry,
		entryPoints,
		onGoToLine = () => {}
	}: {
		snippet: SnippetSource;
		entry: BoundEntry;
		entryPoints: string[];
		onGoToLine?: (line: number) => void;
	} = $props();

	let open = $state(false);
	let elements = $state<SnippetBoundElement[]>([]);
	let phase = $state<SnippetRunPhase>('idle');
	let result = $state<SnippetRunOut | null>(null);
	let notice = $state<string | null>(null);

	// Generation guard: an in-flight response must not land on an unmounted
	// panel (or behind a newer run). Bumped on unmount, checked after await.
	let runSeq = 0;
	onDestroy(() => {
		runSeq++;
	});

	// Gating mirrors the server's SnippetRunIn validators (`value` >= 1
	// element, `step` == 1) plus the two things it cannot check: that a
	// snippet is configured at all (the unconfigured `{}` source has nothing
	// to run) and that the code defines the entry point. The existing amber
	// `snippet-entry-warning` in SnippetSourceEditor already explains the
	// last one, so no second message is rendered here.
	const configured = $derived(
		snippet.definition ? snippet.definition.code.trim() !== '' : Boolean(snippet.ref)
	);
	const entryOk = $derived(entryAvailable(entry, entryPoints));
	const countOk = $derived(entry === 'step' ? elements.length === 1 : elements.length >= 1);
	const runDisabled = $derived(phase !== 'idle' || !configured || !entryOk || !countOk);
	const stale = $derived(result ? isResultStale(result, getModelRev()) : false);

	/** The list owner's half of the value-appends / step-replaces rule (the
	 * entry-dependent half lives in ElementContextRow). */
	function addElement(id: string, label: string): void {
		if (entry === 'step') {
			elements = [{ id, label }]; // step: picking replaces
			return;
		}
		if (elements.some((e) => e.id === id)) return; // duplicate — ignored
		elements = [...elements, { id, label }];
	}

	/** Also reachable from the inline CodeEditor's Mod-Enter keymap, which is
	 * why the gate lives HERE and not only on the button (same discipline as
	 * state/snippet-editor.runSnippetTab's entryAvailable guard). */
	export async function requestRun(): Promise<void> {
		open = true;
		if (runDisabled) return;
		const seq = ++runSeq;
		phase = 'running';
		notice = null;
		const body: SnippetRunBody = {
			run_id: crypto.randomUUID(),
			entry,
			element_ids: elements.map((e) => e.id),
			...(snippet.definition ? { code: snippet.definition.code } : { artifact_id: snippet.ref })
		};
		try {
			const out = await runSnippet(body);
			if (seq !== runSeq) return; // unmounted, or a newer run started
			phase = 'idle';
			result = out;
		} catch (err) {
			if (seq !== runSeq) return;
			phase = 'idle';
			// Same vocabulary as state/snippet-editor.runSnippetTab — a 429 is a
			// normal occurrence, not a defect: snippet_per_user_concurrency
			// defaults to 1, so testing while a console run is live hits it.
			notice =
				err instanceof ApiError && err.status === 429
					? 'Another run is already in progress — wait for it to finish.'
					: err instanceof ApiError && err.status === 503
						? 'Code execution is unavailable on this server.'
						: 'Run failed — check your connection and try again.';
		}
	}
</script>

<div class="rounded border border-border/60">
	<button
		type="button"
		data-testid="snippet-test-toggle"
		class="flex w-full items-center gap-1 px-1.5 py-1 text-left text-muted-foreground transition-colors hover:text-foreground"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<span class="font-mono">{open ? '▾' : '▸'}</span> Test
	</button>
	{#if open}
		<ElementContextRow
			{entry}
			{elements}
			onAdd={addElement}
			onRemove={(id) => (elements = elements.filter((e) => e.id !== id))}
			onClear={() => (elements = [])}
		/>
		<div class="flex items-center gap-2 px-1.5 py-1">
			<button
				type="button"
				data-testid="snippet-test-run"
				class="rounded bg-primary px-2 py-0.5 text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
				disabled={runDisabled}
				onclick={() => void requestRun()}
			>
				Run
			</button>
			<span class="text-muted-foreground/70">
				{entry === 'step' ? 'runs step(el)' : 'runs value(elements)'}
			</span>
		</div>
		<div class="max-h-56 overflow-y-auto border-t border-border/60">
			<SnippetResultView {phase} {notice} {result} {stale} {onGoToLine} opsFooter={opsReadonly} />
		</div>
	{/if}
</div>

{#snippet opsReadonly()}
	<p data-testid="snippet-test-ops-readonly" class="text-warning">
		This snippet mutates the model — embedded {entry}() runs are read-only and these ops are
		discarded.
	</p>
{/snippet}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- snippet-test-panel'`
Expected: PASS, 9 tests.

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Snippet/SnippetTestPanel.svelte \
        frontend/src/lib/components/Snippet/__tests__/snippet-test-panel.test.ts
git commit -m "feat(snippet): add the embedded test panel

Component-local run state, gating that mirrors the server's SnippetRunIn
validators, and a read-only ops surface (no staging)."
```

---

### Task 4: Wire the panel into `SnippetSourceEditor`

The panel renders in **both** modes — inline sends `code`, saved sends `artifact_id`. `entryPoints` comes from the editor's existing debounced lint in inline mode; in saved mode it is `[entry]`, because the ref dropdown is already filtered by `entryAvailable`, so a selectable ref provably has the entry point. `Mod-Enter` in the inline `CodeEditor` (currently `onRun={() => {}}`) triggers the run, and a traceback frame click moves that editor's cursor.

**Files:**
- Modify: `frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte`
- Test: `frontend/src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts` (append)
- Modify: `frontend/README.md`

**Interfaces:**
- Consumes: `SnippetTestPanel` props + `requestRun()` from Task 3; `CodeEditor`'s existing `goToLine(line: number)` export.
- Produces: nothing downstream — this is the top of the component chain.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts`:

```ts
describe('SnippetSourceEditor — test panel', () => {
	it('renders the test panel in ref mode', async () => {
		await setArtifactHeaders([
			{
				id: 'value-snip',
				kind: 'code_snippet',
				name: 'Value snippet',
				updated_at: '2026-07-17T00:00:00Z',
				updated_by: null,
				entry_points: ['value']
			}
		]);
		const c = render({ ref: 'value-snip' }, 'value', vi.fn());
		try {
			expect(document.querySelector('[data-testid="snippet-test-toggle"]')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('renders the test panel in inline mode and enables Run once lint unlocks the entry and an element is bound', async () => {
		vi.useFakeTimers();
		server.use(
			http.post('*/snippets/lint', () =>
				HttpResponse.json({ diagnostics: [], entry_points: ['value'] })
			)
		);
		const c = render(inlineSnippet('def value(elements):\n    return 1\n'), 'value', vi.fn());
		try {
			await vi.advanceTimersByTimeAsync(310);
			click(document.querySelector('[data-testid="snippet-test-toggle"]'));
			const run = document.querySelector('[data-testid="snippet-test-run"]') as HTMLButtonElement;
			expect(run).toBeTruthy();
			expect(run.disabled).toBe(true); // no element bound yet
		} finally {
			unmount(c);
			vi.useRealTimers();
		}
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- snippet-source-editor'`
Expected: FAIL — both new tests, `expect(received).not.toBeNull()` receiving `null`; the panel is not rendered yet.

- [ ] **Step 3: Wire it in**

In `frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte`, add the import next to the existing `CodeEditor` import:

```svelte
	import CodeEditor from './CodeEditor.svelte';
	import SnippetTestPanel from './SnippetTestPanel.svelte';
```

Add the two component references after the `seeding` declaration:

```svelte
	let seeding = $state(false);

	// bind:this handles the two directions the editor and the test panel need
	// to reach each other: Mod-Enter in the code editor triggers a run, and a
	// traceback frame in the run's result jumps the editor's cursor.
	let editor: CodeEditor | undefined = $state();
	let testPanel: SnippetTestPanel | undefined = $state();
```

Replace the `CodeEditor` usage (currently `onRun={() => {}}`):

```svelte
			<div class="h-48 overflow-hidden rounded border border-input">
				<CodeEditor
					bind:this={editor}
					code={def.code}
					{diagnostics}
					onChange={handleCodeChange}
					onRun={() => void testPanel?.requestRun()}
				/>
			</div>
```

Then add the panel **after** the closing `{/if}` of the `{#if !inline} … {:else if snippet.definition} … {/if}` block, so it renders in both modes — immediately before the component's final `</div>`:

```svelte
	<SnippetTestPanel
		bind:this={testPanel}
		{snippet}
		{entry}
		entryPoints={inline ? entryPoints : [entry]}
		onGoToLine={(l) => editor?.goToLine(l)}
	/>
</div>
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- snippet-source-editor'`
Expected: PASS — the 7 pre-existing tests plus the 2 new ones.

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'`
Expected: PASS, whole suite.

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors.

- [ ] **Step 5: Document it in `frontend/README.md`**

In the "Script columns & steps (M2/M3)" section, insert a new bullet immediately after the **Ref/inline contract** bullet (before **Error cells**):

```markdown
- **Test panel.** Both modes render `SnippetTestPanel.svelte` (`snippet-test-
  toggle`), a collapsed disclosure that expands to the shared
  `ElementContextRow` (chips + fuzzy search + "Use current selection"), a Run
  button, and `SnippetResultView` — the same result surface the tab console
  renders, minus ops staging. Inline mode posts `{ code }` to
  `POST /snippets/run`, ref mode posts `{ artifact_id }`; both post `entry` +
  `element_ids`. Run is gated on all four of: a configured source, the entry
  point being available (`entryAvailable`, from the editor's local lint inline
  / implied by the pre-filtered dropdown in ref mode), and the element count
  the server's `SnippetRunIn` validators require (`value` ≥ 1, `step` == 1) —
  so the UI never sends a request that would 422. The gate lives in
  `requestRun()` itself, not just on the button, because the editor's
  `Mod-Enter` keymap calls it directly. Run state is **component-local**
  (`$state` + a `runSeq` generation guard bumped in `onDestroy`), NOT the
  tab-keyed `_runs` map: several script columns/steps can be open at once and
  a nav script step is identified only by an array index that shifts on
  reorder. Recorded ops are listed but **never stageable** — embedded
  `value()`/`step()` evaluation is read-only, so the panel says so
  (`snippet-test-ops-readonly`) instead of offering a Stage button. There is
  no Stop button: M1's cancel is a server-side no-op and the wall timeout is
  10s.
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte \
        frontend/src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts \
        frontend/README.md
git commit -m "feat(snippet): show the test panel in the embedded source editor

Both ref and inline modes; Mod-Enter runs it and traceback frames jump
the inline editor's cursor."
```

---

### Task 5: End-to-end leg through the real sandbox

One Playwright test proving the whole path against the real WASM guest: add a script column, write an inline `value()`, expand Test, bind an element, Run, read the result. Follows the existing file's conventions — `loadFiles` first (the suite shares one backend project), `setCode` for CM6, and the runner-availability skip so a harness without the fetched guest binary degrades to a skip instead of a failure.

**Files:**
- Modify: `frontend/e2e/script-embedding.spec.ts`

**Interfaces:**
- Consumes: `setCode`, `buildSoftwareSystemNav`, `loadFiles`, `openDefaultProject`, and the `METAMODEL_PATH` / `MODEL_PATH` / `VIEW_PATH` constants already defined at the top of that file, plus the `snippet-test-toggle` / `snippet-test-run` / `snippet-element-search` / `snippet-result` testids.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `frontend/e2e/script-embedding.spec.ts`:

```ts
test('script column: the Test panel runs the inline snippet against a bound element', async ({
	page
}) => {
	test.setTimeout(120_000);
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });
	await expect(page.getByText('live')).toBeVisible({ timeout: 60_000 });

	// A nav -> "Open as table" gets us a table whose settings dialog can host
	// a script column (identical entry point to the test above).
	await buildSoftwareSystemNav(page, page.getByRole('tabpanel'));
	const navTabpanel = page.getByRole('tabpanel');
	const openAsTableButton = navTabpanel.getByRole('button', { name: 'Open as table' });
	await expect(openAsTableButton).toBeEnabled();
	await openAsTableButton.click();

	const tabpanel = page.getByRole('tabpanel');
	await expect(tabpanel.getByTestId('table-grid')).toBeVisible({ timeout: 15_000 });
	await expect(tabpanel.getByTestId('table-row')).toHaveCount(12, { timeout: 15_000 });

	await tabpanel.getByTestId('table-settings-button').click();
	const settings = page.getByRole('dialog', { name: 'Table settings' });
	await expect(settings).toBeVisible();
	await settings.getByTestId('add-script-column').click();

	const editor = settings.getByTestId('script-column-editor').nth(0);
	await editor.getByTestId('snippet-mode-inline').click();
	await setCode(page, editor.getByTestId('snippet-editor'), INLINE_COLUMN_CODE);

	// Expand Test, bind one element through the fuzzy search, run.
	await editor.getByTestId('snippet-test-toggle').click();
	const runButton = editor.getByTestId('snippet-test-run');
	await expect(runButton).toBeDisabled(); // nothing bound yet
	await editor.getByTestId('snippet-element-search').fill('SoftwareSystem-001');
	await editor.getByRole('button', { name: /SoftwareSystem-001/ }).first().click();
	await expect(runButton).toBeEnabled({ timeout: 15_000 }); // lint must unlock value()
	await runButton.click();

	// Runner-availability guard, same rationale as the test above: without the
	// fetched WASM guest the route 503s and the panel says so.
	const notice = editor.getByTestId('snippet-notice');
	const result = editor.getByTestId('snippet-result');
	await expect(result.or(notice)).toBeVisible({ timeout: 60_000 });
	if ((await notice.count()) > 0 && (await notice.textContent())?.includes('unavailable')) {
		test.skip(true, 'snippet runner not booted (guest binary not fetched)');
	}
	await expect(result).toHaveText('2'); // INLINE_COLUMN_CODE returns the constant 2
});
```

- [ ] **Step 2: Run it**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e -- --grep "the Test panel runs"'`
Expected: PASS, or a clean `skipped` if the guest binary is not fetched. If the guest binary *is* available and the assertion fails on the result text, fetch it and re-check: `bash spikes/code_exec/fetch_python_wasi.sh`.

- [ ] **Step 3: Run the full lint/format/typecheck gate**

Run: `pixi run dr-tidy`
Expected: clean — ruff, mypy, pyright, and the frontend formatter/linter all pass. (No Python changed in this plan, so any Python failure here is pre-existing; confirm with `git stash` before chasing it.)

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/script-embedding.spec.ts
git commit -m "test(snippet): e2e leg for the embedded test panel

Adds a script column, writes an inline value(), binds an element through
the Test panel and asserts the sandbox result."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Placement (in-editor disclosure) | 3, 4 |
| Both ref and inline modes | 3 (request shape), 4 (rendered in both) |
| State ownership (component-local + generation guard) | 3 |
| `ElementContextRow` → controlled | 1 |
| `SnippetConsole` split | 2 |
| `SnippetTestPanel` + error mapping (429/503/generic) | 3 |
| Ops listed, no Stage, read-only warning | 2 (footer slot), 3 (warning) |
| `SnippetSourceEditor` wiring + `entryPoints` per mode | 4 |
| Run gating (configured / entry / count) | 3 |
| No Stop button | 3 |
| Testing (unit legs + e2e) | 1, 2, 3, 4, 5 |
| Out of scope (no prefill, no persistence, no backend) | Global Constraints |

One deliberate deviation from the spec, noted at its task: the ops warning renders **below** the op list rather than above (one footer slot serves both callers).

One spec item intentionally not given its own test: the "unmount mid-run neutralizes the in-flight response" leg. The `runSeq` guard is implemented and commented in Task 3, but an MSW-based test of it is fragile (it must hold a response open across an `unmount`) and Svelte 5 tolerates post-unmount `$state` writes anyway, so the guard is defence-in-depth rather than an observable behaviour. If the implementer wants it, the `resolveArtifact`-style deferred-promise pattern in `snippet-source-editor.test.ts`'s race test is the model to copy.

**Type consistency:** `SnippetBoundElement` / `BoundEntry` / `SnippetRunPhase` / `SnippetRunOut` / `SnippetRunBody` / `SnippetSource` are used with the names and shapes they already have in the codebase. `requestRun` is named identically in Tasks 3, 4 and the tests. `opsFooter` is named identically in Tasks 2 and 3.
