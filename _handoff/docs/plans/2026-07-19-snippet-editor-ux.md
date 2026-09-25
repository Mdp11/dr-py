# Snippet Editor UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four UX gaps in the snippet workspace tab: placeholder ghost text instead of a starter comment, real code completion (facade + Python keywords + local variables), an explain-and-insert-stub flow for the `value`/`step` entry points, and a tabbed docs modal replacing the cramped sidebar.

**Architecture:** All changes are frontend-only (SvelteKit + CodeMirror 6). Pure logic goes in Svelte-free modules (`$lib/snippet/`, `$lib/editor/`) with vitest coverage; components stay thin templates. The docs sidebar component is replaced by a dialog built from the existing `ui/dialog` + `ui/tabs` primitives.

**Tech Stack:** Svelte 5 (runes), CodeMirror 6 (`@codemirror/view` `placeholder`, `@codemirror/lang-python` language-data completion), vitest (happy-dom), Playwright e2e.

Spec: `docs/superpowers/specs/2026-07-19-snippet-editor-ux-design.md`

## Global Constraints

- Everything runs through pixi. Frontend npm scripts MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test'` (the bare `pixi run -e frontend npm test` fails with "Missing script").
- Unit tests: `npm test` = `vitest run`. Single file: `npm test -- <path>`.
- Type check: `npm run check` (svelte-check). Lint/format: `pixi run dr-tidy` before finishing.
- e2e (`npm run test:e2e`) boots the backend itself; run-dependent snippet tests self-skip if the WASM guest binary isn't fetched. Only the final task runs e2e.
- No backend/server changes of any kind.
- Follow existing code style: dense "why" docstrings/comments on invariants, thin Svelte templates, pure helpers in `.ts` modules.
- Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Empty default draft + CodeMirror placeholder

New snippets start with an empty document; the old guidance comment becomes ghost text (CM `placeholder()`), shown only while the doc is empty, disappearing on first input (standard behavior — deliberately not on focus).

**Files:**
- Modify: `frontend/src/lib/state/snippet-editor.svelte.ts` (lines ~29–32 `DEFAULT_CODE`, ~203–211 `hasDirtySnippetDrafts`)
- Modify: `frontend/src/lib/components/Snippet/CodeEditor.svelte`
- Modify: `frontend/src/lib/editor/theme.ts` (editor chrome theme object)
- Test: `frontend/src/lib/state/__tests__/snippet-editor.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: fresh drafts have `code === ''`; `hasDirtySnippetDrafts()` returns true only when a draft's `dirty` flag is set. Later tasks rely on `updateSnippetCode(tabId, code)` (unchanged signature).

- [ ] **Step 1: Update the failing state test**

In `frontend/src/lib/state/__tests__/snippet-editor.test.ts`, find the test asserting a fresh draft's code (around line 56–59, `expect(draft.code).toContain('dr')`) and change the assertion to expect an empty draft. Keep the surrounding test structure exactly as-is; only the assertion changes:

```ts
expect(draft.code).toBe('');
```

Also add a test for the dirty-tracking change (same file, alongside the other `ensureSnippetDraft` tests, reusing the file's existing setup helpers/`tabId` conventions):

```ts
it('a fresh never-saved draft does not count as dirty until edited', async () => {
	const tabId = 'snip:draft:9';
	await ensureSnippetDraft(tabId);
	expect(hasDirtySnippetDrafts()).toBe(false);
	updateSnippetCode(tabId, 'print(1)\n');
	expect(hasDirtySnippetDrafts()).toBe(true);
});
```

Import `hasDirtySnippetDrafts` and `updateSnippetCode` from `../snippet-editor.svelte` (extend the existing import list). If the file resets module state between tests via a helper (check the top of the file — mirror whatever the other tests do for isolation), follow that pattern.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/snippet-editor.test.ts'`
Expected: FAIL — fresh draft code is the old comment, and `hasDirtySnippetDrafts()` returns `true` for a fresh draft (current rule counts any never-saved draft).

- [ ] **Step 3: Implement the state change**

In `frontend/src/lib/state/snippet-editor.svelte.ts`:

Replace the `DEFAULT_CODE` constant (lines 29–32):

```ts
// New drafts start EMPTY — the "explore via dr" guidance lives in the editor
// as CM placeholder ghost text (CodeEditor.svelte), not as document content
// the user has to delete.
const DEFAULT_CODE = '';
```

Replace `hasDirtySnippetDrafts` and its docstring (lines 203–211):

```ts
/** Mirrors hasDirtyNavDrafts/hasDirtyTableDrafts: only the `dirty` flag
 * matters. A never-saved draft (`artifactId === null`) with untouched code is
 * empty (DEFAULT_CODE is ''), so there is no content to lose — the old rule
 * that counted every never-saved draft guarded the starter comment, which is
 * now placeholder text outside the document. */
export function hasDirtySnippetDrafts(): boolean {
	for (const d of _drafts.values()) if (d.dirty) return true;
	return false;
}
```

- [ ] **Step 4: Run the state tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/snippet-editor.test.ts'`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Add the placeholder extension to the editor**

In `frontend/src/lib/components/Snippet/CodeEditor.svelte`:

Extend the `@codemirror/view` import (line 4):

```ts
import { EditorView, keymap, hoverTooltip, placeholder } from '@codemirror/view';
```

Add above the `$effect` that creates the view (after the `docHover` definition):

```ts
// Ghost-text guidance shown only while the document is empty (never part of
// the content — see snippet-editor.svelte.ts DEFAULT_CODE). A DOM factory
// because the string form collapses newlines.
function placeholderDom(): HTMLElement {
	const el = document.createElement('div');
	el.textContent =
		'Explore the model through the dr facade, e.g.:\n' +
		'for el in dr.elements():\n' +
		'    print(el.type, el.name)';
	el.style.whiteSpace = 'pre';
	return el;
}
```

Add `placeholder(placeholderDom)` to the `extensions` array, after `editorLuxuryTheme`:

```ts
extensions: [
	basicSetup,
	python(),
	editorLuxuryTheme,
	placeholder(placeholderDom),
	lintGutter(),
	...
```

- [ ] **Step 6: Style the placeholder in the luxury theme**

In `frontend/src/lib/editor/theme.ts`, inside the `editorTheme = EditorView.theme({...})` object (chrome section, e.g. right after the `.cm-scroller` entry), add:

```ts
// Placeholder ghost text — muted so it reads as a hint, not content.
'.cm-placeholder': {
	color: 'var(--muted-foreground)',
	opacity: '0.7'
},
```

- [ ] **Step 7: Run the full unit suite + svelte-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS / 0 errors. If another test asserted the old starter-comment behavior, fix it to the new expectation (empty default, dirty-flag-only).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/state/snippet-editor.svelte.ts frontend/src/lib/state/__tests__/snippet-editor.test.ts frontend/src/lib/components/Snippet/CodeEditor.svelte frontend/src/lib/editor/theme.ts
git commit -m "feat(snippet-ui): placeholder ghost text instead of starter comment"
```

---

### Task 2: General completion alongside the facade source

Stop overriding CM completion. The facade source becomes a Python language-data source coexisting with `lang-python`'s built-ins (`python()` already registers `localCompletionSource` — document-local variables/functions — and `globalCompletion` — keywords/builtins; the current `override` suppresses both).

**Files:**
- Modify: `frontend/src/lib/components/Snippet/CodeEditor.svelte`
- Test: `frontend/e2e/snippet-flow.spec.ts` (assertion added here, executed in Task 6)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: no API changes; `computeCompletions`/`resolveDocAt` signatures untouched.

- [ ] **Step 1: Rewire the completion registration**

In `frontend/src/lib/components/Snippet/CodeEditor.svelte`:

Change the lang-python import (line 5):

```ts
import { python, pythonLanguage } from '@codemirror/lang-python';
```

Replace the `@codemirror/autocomplete` import (lines 7–11) — `autocompletion` itself is no longer called (basicSetup already installs the completion UI); only the types remain:

```ts
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
```

Update the comment above `completionSource` (lines 47–49) and keep the function as-is:

```ts
// Adapters close over the live `docs`/`vocab` props, same pattern as
// `onChange` — docs arriving after mount simply start returning results,
// no reconfigure needed. Registered as a Python language-data source so it
// COEXISTS with lang-python's keyword/local-variable sources (an
// autocompletion({override}) would suppress them — that was the old bug).
```

In the `extensions` array, replace the line

```ts
autocompletion({ override: [completionSource] }),
```

with

```ts
pythonLanguage.data.of({ autocomplete: completionSource }),
```

- [ ] **Step 2: Verify unit tests + svelte-check still pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS / 0 errors (facade completion logic is pure and untested through CM; this step catches import/type breakage).

- [ ] **Step 3: Add an e2e regression assertion for general completion**

In `frontend/e2e/snippet-flow.spec.ts`, after the existing `typing dr. offers facade completions` test, add:

```ts
test('typing a plain identifier offers keyword/builtin completions', async ({ page }) => {
	await openNewSnippet(page);
	await page.locator('[data-testid="snippet-editor"] .cm-content').click();
	await page.keyboard.insertText('pri');
	const tooltip = page.locator('.cm-tooltip-autocomplete');
	await expect(tooltip).toBeVisible({ timeout: 5000 });
	await expect(tooltip).toContainText('print');
});
```

(Not executed now — Task 6 runs the e2e suite.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/Snippet/CodeEditor.svelte frontend/e2e/snippet-flow.spec.ts
git commit -m "fix(snippet-ui): facade completions coexist with python keyword/local sources"
```

---

### Task 3: Entry-point hint bar + insert stub

The entry `<select>` becomes always selectable. Selecting an entry the code doesn't define shows a hint bar explaining the one-arg function contract with an **Insert stub** button; Run stays gated on lint-confirmed availability.

**Files:**
- Create: `frontend/src/lib/snippet/entry-stubs.ts`
- Create: `frontend/src/lib/snippet/__tests__/entry-stubs.test.ts`
- Modify: `frontend/src/lib/components/Snippet/SnippetTab.svelte`

**Interfaces:**
- Consumes: `updateSnippetCode(tabId: string, code: string): void` and `getSnippetLint(tabId): SnippetLintState | undefined` (`{ diagnostics, entryPoints: string[] }`) from `$lib/state`.
- Produces: `entry-stubs.ts` exports used by SnippetTab:
  - `type BoundEntry = 'value' | 'step'`
  - `ENTRY_HINTS: Record<BoundEntry, string>` — one-sentence explanation per entry
  - `entryAvailable(entry: 'script' | BoundEntry, entryPoints: string[] | undefined): boolean`
  - `withStub(code: string, entry: BoundEntry): string` — code with the stub appended

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/snippet/__tests__/entry-stubs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ENTRY_HINTS, entryAvailable, withStub } from '../entry-stubs';

describe('entryAvailable', () => {
	it('script is always available, even before lint responds', () => {
		expect(entryAvailable('script', undefined)).toBe(true);
		expect(entryAvailable('script', [])).toBe(true);
	});

	it('value/step require the lint-derived entry list', () => {
		expect(entryAvailable('value', undefined)).toBe(false);
		expect(entryAvailable('value', ['script'])).toBe(false);
		expect(entryAvailable('value', ['script', 'value'])).toBe(true);
		expect(entryAvailable('step', ['script', 'step'])).toBe(true);
	});
});

describe('withStub', () => {
	it('an empty document gets just the stub', () => {
		const out = withStub('', 'value');
		expect(out).toMatch(/^def value\(el\):/);
		expect(out.endsWith('\n')).toBe(true);
	});

	it('existing code keeps a blank-line separator before the stub', () => {
		const out = withStub('print(1)\n', 'step');
		expect(out).toContain('print(1)\n\n\ndef step(el):');
	});

	it('the stub defines the one-arg function lint derives entry points from', () => {
		// Mirrors core/script/lint.derive_entry_points: top-level def, one arg.
		expect(withStub('', 'value')).toContain('def value(el):');
		expect(withStub('', 'step')).toContain('def step(el):');
	});
});

describe('ENTRY_HINTS', () => {
	it('names the required function signature per entry', () => {
		expect(ENTRY_HINTS.value).toContain('def value(el):');
		expect(ENTRY_HINTS.step).toContain('def step(el):');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/snippet/__tests__/entry-stubs.test.ts'`
Expected: FAIL — cannot resolve `../entry-stubs`.

- [ ] **Step 3: Implement `entry-stubs.ts`**

Create `frontend/src/lib/snippet/entry-stubs.ts`:

```ts
// Pure helpers for the value/step entry-point UX — kept Svelte-free so the
// hint/stub logic is unit-testable (mirrors docs-view.ts / console-view.ts).
//
// Backend contract (core/script/lint.derive_entry_points +
// routes/snippets.py): an entry unlocks when the code defines a TOP-LEVEL
// one-argument function of that name; value/step runs are read-only — the
// server calls the function with the bound element and shows repr(return).

export type BoundEntry = 'value' | 'step';

export const ENTRY_HINTS: Record<BoundEntry, string> = {
	value:
		'value runs a top-level function def value(el): against the bound element (read-only) and shows its return value. Your snippet doesn’t define one yet.',
	step: 'step runs a top-level function def step(el): — one tick of a step-wise evaluation for the bound element (read-only). Your snippet doesn’t define one yet.'
};

const STUBS: Record<BoundEntry, string> = {
	value:
		'def value(el):\n' +
		'    # Read-only: compute and return a value for the bound element.\n' +
		'    return el.name\n',
	step:
		'def step(el):\n' +
		'    # Read-only: one tick of a step-wise evaluation for the bound element.\n' +
		'    return el.name\n'
};

export function entryAvailable(
	entry: 'script' | BoundEntry,
	entryPoints: string[] | undefined
): boolean {
	return entry === 'script' || (entryPoints?.includes(entry) ?? false);
}

/** Append the entry's stub, PEP8-separated (two blank lines) from existing
 * top-level code; an empty document gets the stub alone. */
export function withStub(code: string, entry: BoundEntry): string {
	const stub = STUBS[entry];
	return code.trim() === '' ? stub : `${code.trimEnd()}\n\n\n${stub}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/snippet/__tests__/entry-stubs.test.ts'`
Expected: PASS.

- [ ] **Step 5: Wire the hint bar into SnippetTab**

In `frontend/src/lib/components/Snippet/SnippetTab.svelte`:

Add to the script imports:

```ts
import { ENTRY_HINTS, entryAvailable, withStub, type BoundEntry } from '$lib/snippet/entry-stubs';
```

Replace the `runDisabled` derivation (lines 46–48) with:

```ts
const entryOk = $derived(entryAvailable(run.entry, lint?.entryPoints));
const runDisabled = $derived(
	run.phase !== 'idle' || !entryOk || (run.entry !== 'script' && run.elementId === null)
);
```

Replace the `<select>` (lines 80–94) — options always selectable, with native tooltips:

```svelte
<select
	data-testid="snippet-entry"
	class="rounded border border-input bg-card px-2 py-1 text-xs"
	value={run.entry}
	onchange={(e) =>
		setSnippetEntry(tabId, e.currentTarget.value as 'script' | 'value' | 'step')}
>
	<option value="script" title="Run the whole file top-to-bottom">script</option>
	<option value="value" title="Call a top-level value(el) with a chosen element (read-only)">
		value
	</option>
	<option value="step" title="Call a top-level step(el) with a chosen element (read-only)">
		step
	</option>
</select>
```

Add the hint bar directly after the save-error `{#if saveError}` block (before the conflict banner), shown only once lint has responded:

```svelte
{#if lint && run.entry !== 'script' && !entryOk}
	<div
		data-testid="snippet-entry-hint"
		class="flex items-center gap-2 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
	>
		<span>{ENTRY_HINTS[run.entry as BoundEntry]}</span>
		<button
			type="button"
			data-testid="snippet-insert-stub"
			class="shrink-0 rounded border border-input px-2 py-0.5 text-foreground/80 transition-colors hover:bg-muted"
			onclick={() => draft && updateSnippetCode(tabId, withStub(draft.code, run.entry as BoundEntry))}
		>
			Insert stub
		</button>
	</div>
{/if}
```

- [ ] **Step 6: Run the unit suite + svelte-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS / 0 errors.

- [ ] **Step 7: Add the e2e flow assertion**

In `frontend/e2e/snippet-flow.spec.ts`, add after the completion tests:

```ts
test('selecting an undefined entry hints and inserts a stub', async ({ page }) => {
	await openNewSnippet(page);
	await page.getByTestId('snippet-entry').selectOption('value');
	await expect(page.getByTestId('snippet-entry-hint')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId('snippet-insert-stub').click();
	// The debounced lint picks up the stub and the hint clears.
	await expect(page.getByTestId('snippet-entry-hint')).toBeHidden({ timeout: 10_000 });
	await expect(page.locator('[data-testid="snippet-editor"] .cm-content')).toContainText(
		'def value(el):'
	);
});
```

(Executed in Task 6.)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/snippet/entry-stubs.ts frontend/src/lib/snippet/__tests__/entry-stubs.test.ts frontend/src/lib/components/Snippet/SnippetTab.svelte frontend/e2e/snippet-flow.spec.ts
git commit -m "feat(snippet-ui): explain value/step entries and insert a stub on demand"
```

---

### Task 4: Docs filter helpers

Pure lowercase-substring filters for the docs modal, in the existing Svelte-free view-model module.

**Files:**
- Modify: `frontend/src/lib/snippet/docs-view.ts`
- Test: `frontend/src/lib/snippet/__tests__/docs-view.test.ts`

**Interfaces:**
- Consumes: existing types in `docs-view.ts` (`FacadeDocEntry` from `$lib/api/types`; `TypeRow`, `RelRow`).
- Produces (used by Task 5):
  - `filterFacade(entries: FacadeDocEntry[], q: string): FacadeDocEntry[]`
  - `filterTypeRows(rows: TypeRow[], q: string): TypeRow[]`
  - `filterRelRows(rows: RelRow[], q: string): RelRow[]`
  - All three: blank/whitespace `q` returns the input unchanged; matching is case-insensitive substring.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/snippet/__tests__/docs-view.test.ts` (reuse the file's existing fixture style — it already builds `FacadeDocEntry` arrays and metamodel rows; import the new functions from `../docs-view`):

```ts
describe('filterFacade', () => {
	const entries: FacadeDocEntry[] = [
		{ name: 'dr.create', kind: 'function', signature: 'dr.create(type_name)', doc: 'Record a create.', example: null },
		{ name: 'Element.set', kind: 'method', signature: 'Element.set(key, value)', doc: 'Update a property.', example: null }
	];

	it('blank query returns input unchanged', () => {
		expect(filterFacade(entries, '')).toEqual(entries);
		expect(filterFacade(entries, '   ')).toEqual(entries);
	});

	it('matches name, signature, and doc, case-insensitively', () => {
		expect(filterFacade(entries, 'CREATE').map((e) => e.name)).toEqual(['dr.create']);
		expect(filterFacade(entries, 'key, value').map((e) => e.name)).toEqual(['Element.set']);
		expect(filterFacade(entries, 'property').map((e) => e.name)).toEqual(['Element.set']);
		expect(filterFacade(entries, 'zzz')).toEqual([]);
	});
});

describe('filterTypeRows / filterRelRows', () => {
	const types: TypeRow[] = [
		{ name: 'Building', abstract: false, properties: [{ name: 'height', datatype: 'integer', multiplicity: '0..1' }] },
		{ name: 'Sensor', abstract: false, properties: [] }
	];
	const rels: RelRow[] = [
		{ name: 'Owns', abstract: false, source: 'Building', target: 'Sensor', containment: true }
	];

	it('matches type name or property name', () => {
		expect(filterTypeRows(types, 'sens').map((t) => t.name)).toEqual(['Sensor']);
		expect(filterTypeRows(types, 'height').map((t) => t.name)).toEqual(['Building']);
		expect(filterTypeRows(types, '')).toEqual(types);
	});

	it('matches relationship name or endpoints', () => {
		expect(filterRelRows(rels, 'owns')).toEqual(rels);
		expect(filterRelRows(rels, 'sensor')).toEqual(rels);
		expect(filterRelRows(rels, 'zzz')).toEqual([]);
	});
});
```

Add `FacadeDocEntry` to the test file's type imports and `filterFacade, filterRelRows, filterTypeRows, type RelRow, type TypeRow` to its `../docs-view` import as needed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/snippet/__tests__/docs-view.test.ts'`
Expected: FAIL — `filterFacade` etc. not exported.

- [ ] **Step 3: Implement the filters**

Append to `frontend/src/lib/snippet/docs-view.ts`:

```ts
// Docs-modal filters — case-insensitive substring over the human-searchable
// fields; a blank query is the identity so the modal renders the full
// reference without special-casing.

function norm(q: string): string {
	return q.trim().toLowerCase();
}

export function filterFacade(entries: FacadeDocEntry[], q: string): FacadeDocEntry[] {
	const n = norm(q);
	if (!n) return entries;
	return entries.filter((e) =>
		`${e.name}\n${e.signature}\n${e.doc}`.toLowerCase().includes(n)
	);
}

export function filterTypeRows(rows: TypeRow[], q: string): TypeRow[] {
	const n = norm(q);
	if (!n) return rows;
	return rows.filter(
		(r) =>
			r.name.toLowerCase().includes(n) ||
			r.properties.some((p) => p.name.toLowerCase().includes(n))
	);
}

export function filterRelRows(rows: RelRow[], q: string): RelRow[] {
	const n = norm(q);
	if (!n) return rows;
	return rows.filter((r) =>
		`${r.name}\n${r.source}\n${r.target}`.toLowerCase().includes(n)
	);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/snippet/__tests__/docs-view.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/snippet/docs-view.ts frontend/src/lib/snippet/__tests__/docs-view.test.ts
git commit -m "feat(snippet-ui): docs filter helpers for the docs modal"
```

---

### Task 5: SnippetDocsDialog replaces the sidebar

A wide tabbed dialog (API Reference / Project / Limits & rules) opened by the Docs button; the 320px sidebar and `SnippetDocsPanel.svelte` are deleted.

**Files:**
- Create: `frontend/src/lib/components/Snippet/SnippetDocsDialog.svelte`
- Delete: `frontend/src/lib/components/Snippet/SnippetDocsPanel.svelte`
- Modify: `frontend/src/lib/components/Snippet/SnippetTab.svelte`
- Modify: `frontend/e2e/snippet-flow.spec.ts` (docs test now clicks tabs)
- Test: `frontend/src/lib/components/__tests__/SnippetDocsDialog.test.ts`

**Interfaces:**
- Consumes: `getSnippetDocs()`/`getMetamodel()` from `$lib/state`; `groupFacade`, `elementTypeRows`, `relationshipRows`, `formatBytes`, `formatSeconds` and Task 4's `filterFacade`, `filterTypeRows`, `filterRelRows` from `$lib/snippet/docs-view`; `ui/dialog` + `ui/tabs` primitives (namespace imports, `Dialog.Root bind:open` / `Tabs.Root` pattern as in `SettingsDialog.svelte` and `DiffDrawer.svelte`).
- Produces: `SnippetDocsDialog.svelte` with props `{ open: boolean }` where `open` is `$bindable(false)`. Keeps testids `snippet-docs` (dialog body) and `snippet-docs-toggle` (button, unchanged) so e2e locators survive; tab triggers get `data-testid="snippet-docs-tab-reference" / -project / -limits`.

- [ ] **Step 1: Write the failing component test**

Create `frontend/src/lib/components/__tests__/SnippetDocsDialog.test.ts`, following the `SettingsDialog.test.ts` mount pattern (flushSync/mount/unmount, `document.body` cleanup, `bodyText()` helper):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SnippetDocsDialog from '../Snippet/SnippetDocsDialog.svelte';
import type { SnippetDocsOut } from '$lib/api/types';

const DOCS: SnippetDocsOut = {
	facade: [
		{
			name: 'dr.create',
			kind: 'function',
			signature: 'dr.create(type_name, properties=None) -> str',
			doc: 'Record a dry-run element create.',
			example: 'tmp = dr.create("Building")'
		},
		{
			name: 'Element.set',
			kind: 'method',
			signature: 'Element.set(key, value)',
			doc: 'Update a property.',
			example: null
		},
		{
			name: 'dr.NotFoundError',
			kind: 'exception',
			signature: 'dr.NotFoundError',
			doc: 'Missing id.',
			example: null
		}
	],
	limits: {
		wall_timeout_s: 10,
		memory_bytes: 268435456,
		stdout_bytes: 262144,
		result_repr_bytes: 65536,
		max_ops: 1000,
		max_op_bytes: 1048576,
		page_limit: 500
	},
	notes: ['Writes are recorded as proposals.']
};

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getSnippetDocs: vi.fn((): SnippetDocsOut | null => DOCS),
		getMetamodel: vi.fn(() => null)
	};
});
import { getSnippetDocs } from '$lib/state';

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

function bodyText(): string {
	return document.body.textContent ?? '';
}

describe('SnippetDocsDialog', () => {
	it('renders the reference tab by default with facade entries', () => {
		const app = mount(SnippetDocsDialog, { target: document.body, props: { open: true } });
		flushSync();
		expect(bodyText()).toContain('dr.create');
		expect(bodyText()).toContain('Record a dry-run element create.');
		void unmount(app);
	});

	it('filter narrows reference entries', async () => {
		const app = mount(SnippetDocsDialog, { target: document.body, props: { open: true } });
		flushSync();
		const input = document.querySelector<HTMLInputElement>(
			'[data-testid="snippet-docs-filter"]'
		);
		expect(input).not.toBeNull();
		input!.value = 'NotFound';
		input!.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(bodyText()).toContain('dr.NotFoundError');
		expect(bodyText()).not.toContain('Element.set');
		void unmount(app);
	});

	it('limits tab shows run limits and notes', async () => {
		const app = mount(SnippetDocsDialog, { target: document.body, props: { open: true } });
		flushSync();
		const tab = document.querySelector<HTMLElement>('[data-testid="snippet-docs-tab-limits"]');
		expect(tab).not.toBeNull();
		tab!.click();
		flushSync();
		expect(bodyText()).toContain('Wall timeout');
		expect(bodyText()).toContain('Writes are recorded as proposals.');
		void unmount(app);
	});

	it('shows the unavailable state without docs', () => {
		vi.mocked(getSnippetDocs).mockReturnValue(null);
		const app = mount(SnippetDocsDialog, { target: document.body, props: { open: true } });
		flushSync();
		expect(bodyText()).toContain('Docs unavailable.');
		void unmount(app);
	});
});
```

Note: if the `ui/tabs` trigger needs a keyboard/pointer event rather than `.click()` in happy-dom, mirror whatever `DiffDrawer.strict.test.ts` does to switch tabs — check it before fighting the event model.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/__tests__/SnippetDocsDialog.test.ts'`
Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement `SnippetDocsDialog.svelte`**

Create `frontend/src/lib/components/Snippet/SnippetDocsDialog.svelte`:

```svelte
<script lang="ts">
	// Tabbed snippet-docs modal (replaces the old 320px SnippetDocsPanel
	// sidebar): API Reference / Project / Limits & rules, with a filter box on
	// the two list-like tabs. All list shaping/filtering is pure
	// ($lib/snippet/docs-view); this stays a thin template.
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import { getMetamodel, getSnippetDocs } from '$lib/state';
	import {
		elementTypeRows,
		filterFacade,
		filterRelRows,
		filterTypeRows,
		formatBytes,
		formatSeconds,
		groupFacade,
		relationshipRows
	} from '$lib/snippet/docs-view';

	let { open = $bindable(false) }: { open: boolean } = $props();

	let filter = $state('');

	const docs = $derived(getSnippetDocs());
	const groups = $derived(docs ? groupFacade(filterFacade(docs.facade, filter)) : null);
	const typeRows = $derived(filterTypeRows(elementTypeRows(getMetamodel()), filter));
	const relRows = $derived(filterRelRows(relationshipRows(getMetamodel()), filter));

	const sections = $derived([
		{ title: 'dr', entries: groups?.dr ?? [] },
		{ title: 'Element', entries: groups?.element ?? [] },
		{ title: 'Errors', entries: groups?.errors ?? [] }
	]);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[85vh] max-w-3xl flex-col" data-testid="snippet-docs">
		<Dialog.Header>
			<Dialog.Title class="font-display text-lg font-light tracking-wide">
				Snippet docs
			</Dialog.Title>
		</Dialog.Header>

		{#if !docs}
			<p class="text-xs text-muted-foreground/70">Docs unavailable.</p>
		{:else}
			<Tabs.Root value="reference" class="flex min-h-0 flex-1 flex-col gap-3">
				<Tabs.List class="h-8 shrink-0">
					<Tabs.Trigger
						value="reference"
						class="h-7 text-xs"
						data-testid="snippet-docs-tab-reference"
					>
						API Reference
					</Tabs.Trigger>
					<Tabs.Trigger value="project" class="h-7 text-xs" data-testid="snippet-docs-tab-project">
						Project
					</Tabs.Trigger>
					<Tabs.Trigger value="limits" class="h-7 text-xs" data-testid="snippet-docs-tab-limits">
						Limits &amp; rules
					</Tabs.Trigger>
				</Tabs.List>

				<input
					data-testid="snippet-docs-filter"
					class="w-64 shrink-0 rounded border border-input bg-card px-2 py-1 text-xs"
					placeholder="Filter…"
					bind:value={filter}
				/>

				<Tabs.Content value="reference" class="min-h-0 flex-1 overflow-y-auto pr-2 text-sm">
					{#each sections as section (section.title)}
						{#if section.entries.length > 0}
							<p class="mt-4 text-xs font-semibold uppercase text-muted-foreground first:mt-0">
								{section.title}
							</p>
							{#each section.entries as entry (entry.name)}
								<div class="mt-3">
									<code class="text-xs">{entry.signature}</code>
									<p class="mt-0.5 text-xs text-muted-foreground">{entry.doc}</p>
									{#if entry.example}
										<pre class="mt-1 rounded bg-muted p-2 text-[11px] leading-snug">{entry.example}</pre>
									{/if}
								</div>
							{/each}
						{/if}
					{/each}
				</Tabs.Content>

				<Tabs.Content value="project" class="min-h-0 flex-1 overflow-y-auto pr-2 text-sm">
					{#if typeRows.length === 0}
						<p class="text-xs text-muted-foreground">No matching element types.</p>
					{/if}
					{#each typeRows as row (row.name)}
						<div class="mt-3 first:mt-0">
							<span class="text-xs font-semibold">{row.name}</span>
							{#if row.abstract}<span class="ml-1 text-[10px] text-muted-foreground">abstract</span
								>{/if}
							{#each row.properties as p (p.name)}
								<p class="ml-3 text-xs text-muted-foreground">
									{p.name}: {p.datatype} ({p.multiplicity})
								</p>
							{/each}
						</div>
					{/each}
					{#if relRows.length > 0}
						<p class="mt-4 text-xs font-semibold uppercase text-muted-foreground">Relationships</p>
						{#each relRows as row (row.name)}
							<p class="ml-3 text-xs text-muted-foreground">
								{row.name}: {row.source} → {row.target}{row.containment ? ' (containment)' : ''}
							</p>
						{/each}
					{/if}
				</Tabs.Content>

				<Tabs.Content value="limits" class="min-h-0 flex-1 overflow-y-auto pr-2 text-sm">
					<ul class="space-y-1.5 text-xs text-muted-foreground">
						<li>Wall timeout: {formatSeconds(docs.limits.wall_timeout_s)}</li>
						<li>Memory: {formatBytes(docs.limits.memory_bytes)}</li>
						<li>Stdout cap: {formatBytes(docs.limits.stdout_bytes)}</li>
						<li>Result cap: {formatBytes(docs.limits.result_repr_bytes)}</li>
						<li>Max ops: {docs.limits.max_ops}</li>
						<li>Max op bytes: {formatBytes(docs.limits.max_op_bytes)}</li>
						<li>Read page size: {docs.limits.page_limit}</li>
					</ul>
					<ul class="mt-4 list-disc space-y-1.5 pl-4 text-xs text-muted-foreground">
						{#each docs.notes as note (note)}
							<li>{note}</li>
						{/each}
					</ul>
				</Tabs.Content>
			</Tabs.Root>
		{/if}
	</Dialog.Content>
</Dialog.Root>
```

If `Dialog.Content` doesn't forward `data-testid` (check `dialog-content.svelte` — the shadcn-svelte ports usually spread rest props), put `data-testid="snippet-docs"` on an inner wrapper `<div>` instead and adjust the test selectors accordingly.

- [ ] **Step 4: Swap the sidebar for the dialog in SnippetTab**

In `frontend/src/lib/components/Snippet/SnippetTab.svelte`:

- Replace the import `import SnippetDocsPanel from './SnippetDocsPanel.svelte';` with `import SnippetDocsDialog from './SnippetDocsDialog.svelte';`
- Rename `let showDocs = $state(false);` to `let docsOpen = $state(false);`
- Docs button: `aria-pressed` goes away; `onclick={() => (docsOpen = true)}`.
- Delete the sidebar block:

```svelte
{#if showDocs}
	<div class="w-80 shrink-0">
		<SnippetDocsPanel />
	</div>
{/if}
```

- Add at the end of the component (after the closing outer `</div>`):

```svelte
<SnippetDocsDialog bind:open={docsOpen} />
```

- Delete `frontend/src/lib/components/Snippet/SnippetDocsPanel.svelte` (`git rm`).

- [ ] **Step 5: Run the component test + full suite + svelte-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS / 0 errors. If any existing test imports `SnippetDocsPanel`, update it to the dialog or delete it if fully superseded.

- [ ] **Step 6: Update the docs e2e test for tabs**

In `frontend/e2e/snippet-flow.spec.ts`, replace the `docs panel lists the facade reference and limits` test body ('Wall timeout' now lives behind the Limits tab):

```ts
test('docs modal lists the facade reference and limits', async ({ page }) => {
	await openNewSnippet(page);
	await page.getByTestId('snippet-docs-toggle').click();
	const modal = page.getByTestId('snippet-docs');
	await expect(modal).toBeVisible();
	await expect(modal).toContainText('dr.create');
	await page.getByTestId('snippet-docs-tab-limits').click();
	await expect(modal).toContainText('Wall timeout');
});
```

- [ ] **Step 7: Commit**

```bash
git add -A frontend/src/lib/components/Snippet/ frontend/src/lib/components/__tests__/SnippetDocsDialog.test.ts frontend/e2e/snippet-flow.spec.ts
git commit -m "feat(snippet-ui): tabbed docs modal replaces the sidebar panel"
```

---

### Task 6: Full verification

**Files:** none new — runs the whole gate.

- [ ] **Step 1: Unit tests + svelte-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS / 0 errors.

- [ ] **Step 2: Lint/format across the repo**

Run: `pixi run dr-tidy`
Expected: clean (prettier may rewrite the new files — re-stage if so).

- [ ] **Step 3: Snippet e2e spec**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e -- snippet-flow.spec.ts'`
Expected: PASS (run-dependent tests self-skip if the WASM guest binary isn't fetched; the docs-modal, completion, and entry-hint tests don't need the runner and must pass).

- [ ] **Step 4: Commit any formatting fallout**

```bash
git add -A
git commit -m "chore(snippet-ui): formatting fallout from dr-tidy"
```

(Skip if the tree is clean.)
