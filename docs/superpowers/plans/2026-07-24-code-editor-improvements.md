# Code Editor Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Python snippet editor vertically resizable everywhere, replace CodeMirror's stock Ctrl+F panel with a designed one, and add a Reformat control that also sanitizes tabs.

**Architecture:** All three land in `frontend/src/lib/editor/` (pure, unit-testable modules) plus thin wiring in the two `CodeEditor` hosts. Sizes live in one global-per-kind reactive store backed by `localStorage`. The search panel is a plain-DOM CodeMirror `Panel` that delegates every behaviour to `@codemirror/search`'s own commands and is styled through the existing `EditorView.theme` in `theme.ts`. Reformat is a new `POST /snippets/format` endpoint shelling `ruff format`, called from a control inside `CodeEditor` so all three editor instances inherit it.

**Tech Stack:** SvelteKit 5 (runes), CodeMirror 6, Tailwind 4, vitest + happy-dom + MSW, FastAPI, pytest, pixi.

## Global Constraints

- **Everything runs through pixi.** There is no global `python` or `node`.
  - Python core/API tests: `pixi run core-test`, or `pixi run -e core-dev pytest <path>` for one test.
  - Frontend npm scripts MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test'`. The bare `pixi run -e frontend npm test` fails with "Missing script".
  - Lint/format/typecheck: `pixi run dr-tidy` (ruff --fix, mypy, pyright, prettier, eslint — all must pass).
- **Indentation unit stays FOUR spaces.** `INDENT_WIDTH = 4` in `frontend/src/lib/editor/indent.ts` is not changed by any task in this plan. Nothing renumbers it, and the backend formatter is pinned to the same 4.
- **`localStorage` access is wrapped in try/catch, NOT gated on `$app/environment`'s `browser`.** The vitest alias `src/__mocks__/app-environment.ts` exports `browser = false`, so a `browser` guard would make every persistence test read the default. `state/workspace.svelte.ts` already establishes the try/catch pattern — follow it.
- **New API routes that only read go in `authz._READ_ONLY_POST_SUFFIXES`** so viewers are not 403'd.
- **Docstring style:** this repo carries dense comments explaining *why* an invariant exists. Every non-obvious decision below has a rationale sentence in the plan; carry it into the code comment.
- **Test testids** use the `data-testid` convention and are queried with `document.querySelector`; the repo does not depend on `@testing-library/svelte`. Mount with `mount`/`flushSync`/`unmount` from `svelte`.
- **Commit after every task**, with a `feat(frontend/editor):`-style scope matching recent history.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `frontend/src/lib/editor/editor-size.ts` | Pure size geometry + localStorage read/write. No Svelte. |
| `frontend/src/lib/editor/__tests__/editor-size.test.ts` | Unit tests for the above. |
| `frontend/src/lib/state/editor-size.svelte.ts` | Reactive global-per-kind size store over that module. |
| `frontend/src/lib/editor/search-panel.ts` | The custom CodeMirror search `Panel` + `luxurySearch` extension. |
| `frontend/src/lib/editor/__tests__/search-panel.test.ts` | Panel behaviour against a real `EditorView`. |
| `frontend/src/lib/editor/format.ts` | Pure text helpers the reformat transaction needs (`lineStartOffset`). |
| `frontend/src/lib/editor/__tests__/format.test.ts` | Unit tests for the above. |
| `src/data_rover/api/script_format.py` | `ruff format` subprocess seam + typed failures. |
| `tests/api/test_snippets_format.py` | Endpoint tests. |

**Modified**

| File | Change |
|---|---|
| `frontend/src/lib/components/ResizeHandle.svelte` | `side` accepts `'top' \| 'bottom'` for `axis: 'y'`; optional `label`. |
| `frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte` | `h-48` → store-driven height + bottom grip. |
| `frontend/src/lib/components/Snippet/SnippetTab.svelte` | fixed flex pair → measured split with a divider. |
| `frontend/src/lib/components/Snippet/CodeEditor.svelte` | `luxurySearch` extension; Format control replaces the Fix-indentation button; `Shift-Alt-f`. |
| `frontend/src/lib/editor/theme.ts` | `cm-dr-search*` styling beside the existing `.cm-panels` rules. |
| `frontend/src/lib/api/snippets.ts` | `formatSnippet(code, cfg?)`. |
| `frontend/src/lib/api/types.ts` | `SnippetFormatOutSchema` / `SnippetFormatOut`. |
| `frontend/src/lib/components/Snippet/__tests__/code-editor.test.ts` | Format-control cases; `snippet-fix-indent` → `snippet-format`. |
| `frontend/src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts` | Inline-resize case. |
| `frontend/README.md` | Editor section: size stores, search panel, format flow. |
| `src/data_rover/api/schemas.py` | `SnippetFormatIn` / `SnippetFormatOut`. |
| `src/data_rover/api/routes/snippets.py` | `POST /snippets/format`. |
| `src/data_rover/api/authz.py` | `/snippets/format` in `_READ_ONLY_POST_SUFFIXES`. |
| `src/data_rover/api/settings.py` | `snippet_format_timeout_s`. |
| `pixi.toml` | `ruff` into `[feature.api.dependencies]`. |
| `CLAUDE.md` | Snippet paragraph: format endpoint + ruff runtime dep. |

---

## Task 1: Size geometry + store

**Files:**
- Create: `frontend/src/lib/editor/editor-size.ts`
- Create: `frontend/src/lib/state/editor-size.svelte.ts`
- Test: `frontend/src/lib/editor/__tests__/editor-size.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `editor-size.ts`: `INLINE_MIN_H = 96`, `INLINE_MAX_H = 800`, `INLINE_DEFAULT_H = 192`, `SPLIT_MIN_PANEL_H = 80`, `SPLIT_DIVIDER_H = 6`, `SPLIT_DEFAULT_RATIO = 0.6`; `clampInlineHeight(px: number): number`; `clampSplitRatio(r: number): number`; `splitHeights(args: { containerH: number; ratio: number; dividerH: number; minPanelH: number }): { topH: number; bottomH: number }`; `ratioFromPointer(args: { pointerY: number; containerH: number; dividerH: number; minPanelH: number }): number`; `loadInlineHeight(): number`; `saveInlineHeight(px: number): void`; `loadSplitRatio(): number`; `saveSplitRatio(r: number): void`.
  - `state/editor-size.svelte.ts`: `getInlineEditorHeight(): number`; `setInlineEditorHeight(px: number): void`; `getSnippetSplitRatio(): number`; `setSnippetSplitRatio(r: number): void`; `resetEditorSize(): void`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/editor/__tests__/editor-size.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
	INLINE_DEFAULT_H,
	INLINE_MAX_H,
	INLINE_MIN_H,
	SPLIT_DEFAULT_RATIO,
	clampInlineHeight,
	clampSplitRatio,
	loadInlineHeight,
	loadSplitRatio,
	ratioFromPointer,
	saveInlineHeight,
	saveSplitRatio,
	splitHeights
} from '../editor-size';

afterEach(() => localStorage.clear());

describe('clampInlineHeight', () => {
	it('clamps to the bounds and rounds', () => {
		expect(clampInlineHeight(10)).toBe(INLINE_MIN_H);
		expect(clampInlineHeight(9999)).toBe(INLINE_MAX_H);
		expect(clampInlineHeight(240.6)).toBe(241);
	});

	it('falls back to the default for a non-finite value', () => {
		expect(clampInlineHeight(Number.NaN)).toBe(INLINE_DEFAULT_H);
	});
});

describe('clampSplitRatio', () => {
	it('keeps a ratio inside 0.1..0.9 and defaults a non-finite one', () => {
		expect(clampSplitRatio(0.01)).toBeCloseTo(0.1);
		expect(clampSplitRatio(0.99)).toBeCloseTo(0.9);
		expect(clampSplitRatio(0.5)).toBeCloseTo(0.5);
		expect(clampSplitRatio(Number.NaN)).toBeCloseTo(SPLIT_DEFAULT_RATIO);
	});
});

describe('splitHeights', () => {
	it('splits the area left after the divider by the ratio', () => {
		expect(splitHeights({ containerH: 406, ratio: 0.5, dividerH: 6, minPanelH: 80 })).toEqual({
			topH: 200,
			bottomH: 200
		});
	});

	it('never lets either panel drop below the minimum', () => {
		const h = splitHeights({ containerH: 406, ratio: 0.99, dividerH: 6, minPanelH: 80 });
		expect(h.bottomH).toBe(80);
		expect(h.topH).toBe(320);
	});

	it('yields the EDITOR first when the container cannot hold two minimums', () => {
		// The console keeps as much of its minimum as fits; the editor collapses.
		expect(splitHeights({ containerH: 106, ratio: 0.6, dividerH: 6, minPanelH: 80 })).toEqual({
			topH: 20,
			bottomH: 80
		});
	});

	it('is degenerate-safe for a zero-height container', () => {
		expect(splitHeights({ containerH: 0, ratio: 0.6, dividerH: 6, minPanelH: 80 })).toEqual({
			topH: 0,
			bottomH: 0
		});
	});
});

describe('ratioFromPointer', () => {
	it('translates a pointer position into a clamped ratio', () => {
		expect(
			ratioFromPointer({ pointerY: 200, containerH: 406, dividerH: 6, minPanelH: 80 })
		).toBeCloseTo(0.5);
		// dragged past the bottom minimum
		expect(
			ratioFromPointer({ pointerY: 999, containerH: 406, dividerH: 6, minPanelH: 80 })
		).toBeCloseTo(0.8);
		// dragged above the top minimum
		expect(
			ratioFromPointer({ pointerY: -50, containerH: 406, dividerH: 6, minPanelH: 80 })
		).toBeCloseTo(0.2);
	});
});

describe('persistence', () => {
	it('round-trips a clamped inline height', () => {
		saveInlineHeight(300);
		expect(loadInlineHeight()).toBe(300);
		saveInlineHeight(5);
		expect(loadInlineHeight()).toBe(INLINE_MIN_H);
	});

	it('round-trips a split ratio', () => {
		saveSplitRatio(0.42);
		expect(loadSplitRatio()).toBeCloseTo(0.42);
	});

	it('returns the defaults for missing, empty and garbage values', () => {
		expect(loadInlineHeight()).toBe(INLINE_DEFAULT_H);
		localStorage.setItem('ui.snippet.inlineEditorH', '');
		expect(loadInlineHeight()).toBe(INLINE_DEFAULT_H);
		localStorage.setItem('ui.snippet.inlineEditorH', 'not-a-number');
		expect(loadInlineHeight()).toBe(INLINE_DEFAULT_H);
		localStorage.setItem('ui.snippet.tabSplitRatio', 'nope');
		expect(loadSplitRatio()).toBeCloseTo(SPLIT_DEFAULT_RATIO);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

```sh
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/editor/__tests__/editor-size.test.ts'
```

Expected: FAIL — `Failed to resolve import "../editor-size"`.

- [ ] **Step 3: Write `editor-size.ts`**

```ts
/**
 * Size geometry for the snippet code editor: the inline editors' pixel height
 * and the standalone tab's editor/console split ratio.
 *
 * Pure functions plus `localStorage` read/write, no Svelte and no component
 * DOM, so the clamping can be unit-tested without a browser — mirrors
 * `components/Sidebar/split.ts`, which does the same job for the sidebar's
 * tree/pool divider.
 *
 * Storage access is wrapped in try/catch rather than gated on
 * `$app/environment`'s `browser`: the vitest alias stubs `browser` to `false`,
 * so a guard would make every persistence test read the default instead of
 * what it just wrote. `state/workspace.svelte.ts` sets the same precedent.
 */

/** Inline editor (table script column, navigation script step) bounds, px.
 * The default is 192 — exactly the `h-48` these editors shipped with, so the
 * first render after this change is pixel-identical to the last one before. */
export const INLINE_MIN_H = 96;
export const INLINE_MAX_H = 800;
export const INLINE_DEFAULT_H = 192;

/** Standalone snippet tab: minimum height for EITHER of the editor/console
 * panes, the divider strip's thickness, and the initial share given to the
 * editor (0.6 ≈ the `flex-[3]`/`flex-[2]` pair it replaces). */
export const SPLIT_MIN_PANEL_H = 80;
export const SPLIT_DIVIDER_H = 6;
export const SPLIT_DEFAULT_RATIO = 0.6;

const LS_INLINE_H = 'ui.snippet.inlineEditorH';
const LS_SPLIT_RATIO = 'ui.snippet.tabSplitRatio';

/** Ratio bounds. The real min-panel enforcement happens in `splitHeights`
 * against a measured container; this is the guard on the *stored* value so a
 * hand-edited or corrupt key cannot persist an unusable extreme. */
const RATIO_MIN = 0.1;
const RATIO_MAX = 0.9;

export function clampInlineHeight(px: number): number {
	if (!Number.isFinite(px)) return INLINE_DEFAULT_H;
	return Math.round(Math.max(INLINE_MIN_H, Math.min(INLINE_MAX_H, px)));
}

export function clampSplitRatio(r: number): number {
	if (!Number.isFinite(r)) return SPLIT_DEFAULT_RATIO;
	return Math.max(RATIO_MIN, Math.min(RATIO_MAX, r));
}

export interface SplitHeights {
	/** Editor pane height, px. */
	topH: number;
	/** Console pane height, px. */
	bottomH: number;
}

/**
 * Resolve the editor/console pane heights for a measured container.
 *
 * When the container is too short to hold two minimums the EDITOR yields
 * first: a console squeezed to nothing hides the run output and the traceback
 * links that are the only way back to the offending line, whereas a squeezed
 * editor is still scrollable.
 */
export function splitHeights(args: {
	containerH: number;
	ratio: number;
	dividerH: number;
	minPanelH: number;
}): SplitHeights {
	const { containerH, ratio, dividerH, minPanelH } = args;
	const expandable = containerH - dividerH;
	if (expandable <= 0) return { topH: 0, bottomH: 0 };
	if (expandable <= minPanelH * 2) {
		const bottomH = Math.max(0, Math.min(minPanelH, expandable));
		return { topH: Math.max(0, expandable - bottomH), bottomH };
	}
	const rawTop = Math.round(expandable * ratio);
	const topH = Math.max(minPanelH, Math.min(expandable - minPanelH, rawTop));
	return { topH, bottomH: expandable - topH };
}

/** Translate a divider drag (pointer Y measured from the container's top) into
 * a new editor-share ratio, clamped so neither pane drops below `minPanelH`. */
export function ratioFromPointer(args: {
	pointerY: number;
	containerH: number;
	dividerH: number;
	minPanelH: number;
}): number {
	const { pointerY, containerH, dividerH, minPanelH } = args;
	const expandable = containerH - dividerH;
	if (expandable <= 0) return SPLIT_DEFAULT_RATIO;
	const topH = Math.max(minPanelH, Math.min(expandable - minPanelH, pointerY));
	return Math.max(0, Math.min(1, topH / expandable));
}

function readNumber(key: string, fallback: number): number {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null || raw.trim() === '') return fallback;
		const n = Number(raw);
		return Number.isFinite(n) ? n : fallback;
	} catch {
		// No storage (SSR/prerender, or denied): callers get the default.
		return fallback;
	}
}

function writeNumber(key: string, value: number): void {
	try {
		localStorage.setItem(key, String(value));
	} catch {
		/* storage full/denied: the size simply doesn't persist */
	}
}

export function loadInlineHeight(): number {
	return clampInlineHeight(readNumber(LS_INLINE_H, INLINE_DEFAULT_H));
}

export function saveInlineHeight(px: number): void {
	writeNumber(LS_INLINE_H, clampInlineHeight(px));
}

export function loadSplitRatio(): number {
	return clampSplitRatio(readNumber(LS_SPLIT_RATIO, SPLIT_DEFAULT_RATIO));
}

export function saveSplitRatio(r: number): void {
	writeNumber(LS_SPLIT_RATIO, clampSplitRatio(r));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```sh
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/editor/__tests__/editor-size.test.ts'
```

Expected: PASS (all cases).

- [ ] **Step 5: Write the reactive store**

Create `frontend/src/lib/state/editor-size.svelte.ts`:

```ts
/**
 * Editor size preferences, GLOBAL PER KIND: one remembered height shared by
 * every inline snippet editor, one remembered ratio for the standalone
 * snippet tab's editor/console split.
 *
 * Global rather than per-instance because per-instance memory cannot work for
 * the navigation-script-step case: `SnippetSourceEditor`'s `collapseKey` doc
 * comment records that a nav step's key is minted fresh on every dialog open
 * (`navemb:${crypto.randomUUID()}`), so a per-key size would reset every
 * time. Global also means dragging one inline editor resizes every mounted
 * one live, which is the behaviour a shared preference should have.
 *
 * State is seeded EAGERLY at module load rather than lazily on first read:
 * a lazy read that assigns during a component's render pass trips Svelte's
 * `state_unsafe_mutation`.
 */
import {
	clampInlineHeight,
	clampSplitRatio,
	loadInlineHeight,
	loadSplitRatio,
	saveInlineHeight,
	saveSplitRatio
} from '$lib/editor/editor-size';

let _inlineH = $state(loadInlineHeight());
let _splitRatio = $state(loadSplitRatio());

export function getInlineEditorHeight(): number {
	return _inlineH;
}

export function setInlineEditorHeight(px: number): void {
	const next = clampInlineHeight(px);
	if (next === _inlineH) return;
	_inlineH = next;
	saveInlineHeight(next);
}

export function getSnippetSplitRatio(): number {
	return _splitRatio;
}

export function setSnippetSplitRatio(r: number): void {
	const next = clampSplitRatio(r);
	if (next === _splitRatio) return;
	_splitRatio = next;
	saveSplitRatio(next);
}

/** Re-read both values from storage. Test isolation AND test seeding: a test
 * that writes the storage keys before mounting calls this to pick them up,
 * since module state was seeded once at import. */
export function resetEditorSize(): void {
	_inlineH = loadInlineHeight();
	_splitRatio = loadSplitRatio();
}
```

- [ ] **Step 6: Export the store from the state barrel**

Check whether `frontend/src/lib/state/index.ts` re-exports sibling stores (it is what `SnippetSourceEditor` imports `isSnippetExpanded` from):

```sh
pixi run -e frontend bash -c "cd frontend && grep -n 'snippet-collapse' src/lib/state/index.ts"
```

If `snippet-collapse.svelte.ts` is re-exported there, add the same line for `editor-size.svelte.ts` immediately after it:

```ts
export * from './editor-size.svelte';
```

If it is not re-exported, skip this step and let consumers import from `$lib/state/editor-size.svelte` directly.

- [ ] **Step 7: Typecheck and commit**

```sh
pixi run -e frontend bash -c 'cd frontend && npm run check'
git add frontend/src/lib/editor/editor-size.ts frontend/src/lib/editor/__tests__/editor-size.test.ts frontend/src/lib/state/editor-size.svelte.ts frontend/src/lib/state/index.ts
git commit -m "feat(frontend/editor): size geometry and a global-per-kind size store"
```

---

## Task 2: Inline editor resize grip

**Files:**
- Modify: `frontend/src/lib/components/ResizeHandle.svelte`
- Modify: `frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte:233-241`
- Test: `frontend/src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts`

**Interfaces:**
- Consumes: `INLINE_MAX_H`, `INLINE_MIN_H` from `$lib/editor/editor-size`; `getInlineEditorHeight`, `setInlineEditorHeight` from Task 1's store.
- Produces: `ResizeHandle`'s `side` prop widened to `'left' | 'right' | 'top' | 'bottom'` and a new optional `label?: string` mapped to `aria-label`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts` (the file already has `render`, `click`, MSW `server` and the `resetArtifacts` lifecycle — reuse them; add the two imports at the top of the file):

```ts
// add to the existing import block at the top of the file:
// import { getInlineEditorHeight, resetEditorSize, setInlineEditorHeight } from '$lib/state/editor-size.svelte';
// import { INLINE_MIN_H } from '$lib/editor/editor-size';

describe('SnippetSourceEditor — inline editor height', () => {
	beforeEach(() => {
		localStorage.clear();
		resetEditorSize();
	});

	function inlineSnippet(): SnippetSource {
		return {
			definition: {
				schema_version: 1,
				language: 'python',
				code: 'def value(elements):\n    return 1\n',
				entry_points: []
			}
		};
	}

	it('renders the editor at the stored height and the grip resizes it', () => {
		const c = render(inlineSnippet(), 'value', () => {});
		try {
			const box = document.querySelector('[data-testid="snippet-editor-box"]') as HTMLElement;
			expect(box).toBeTruthy();
			expect(box.style.height).toBe('192px');

			const grip = document.querySelector('[aria-label="Resize snippet editor"]') as HTMLElement;
			expect(grip).toBeTruthy();

			// A drag of +60px from the grip's own pointer position.
			grip.setPointerCapture = () => {};
			grip.releasePointerCapture = () => {};
			grip.dispatchEvent(
				new PointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 300, pointerId: 1 })
			);
			grip.dispatchEvent(
				new PointerEvent('pointermove', { bubbles: true, clientY: 360, pointerId: 1 })
			);
			grip.dispatchEvent(
				new PointerEvent('pointerup', { bubbles: true, clientY: 360, pointerId: 1 })
			);
			flushSync();

			expect(getInlineEditorHeight()).toBe(252);
			expect(box.style.height).toBe('252px');
		} finally {
			unmount(c);
		}
	});

	it('persists the height so a fresh mount reads it back', () => {
		setInlineEditorHeight(310);
		resetEditorSize();
		const c = render(inlineSnippet(), 'value', () => {});
		try {
			const box = document.querySelector('[data-testid="snippet-editor-box"]') as HTMLElement;
			expect(box.style.height).toBe('310px');
		} finally {
			unmount(c);
		}
	});

	it('never renders below the minimum height', () => {
		setInlineEditorHeight(10);
		resetEditorSize();
		const c = render(inlineSnippet(), 'value', () => {});
		try {
			const box = document.querySelector('[data-testid="snippet-editor-box"]') as HTMLElement;
			expect(box.style.height).toBe(`${INLINE_MIN_H}px`);
		} finally {
			unmount(c);
		}
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

```sh
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts'
```

Expected: FAIL — `snippet-editor-box` is null (the box has no testid and no inline height today).

- [ ] **Step 3: Widen `ResizeHandle`'s `side` prop**

In `frontend/src/lib/components/ResizeHandle.svelte`, replace the `Props` type's `side` line and the `signed` computation. New `Props` and destructuring:

```ts
	type Props = {
		/** Current size in px (width for axis 'x', height for axis 'y'). */
		value: number;
		/** Axis to resize along. 'x' = column width, 'y' = row height. */
		axis?: 'x' | 'y';
		/** Which side of the handle grows on drag.
		 *  axis 'x': 'left' grows on drag-right, 'right' grows on drag-left.
		 *  axis 'y': 'top' grows on drag-DOWN (the handle sits under the panel it
		 *  sizes), 'bottom' grows on drag-UP (the handle sits above it).
		 *
		 *  The default is 'left', which for axis 'y' falls through to the
		 *  drag-up-grows branch — that is deliberate, and load-bearing: the two
		 *  pre-existing axis='y' call sites (the workspace results panel and
		 *  NavigationBuilder's results dock) pass no `side` and must keep their
		 *  current behaviour. Do not "tidy" this into separate defaults per axis. */
		side?: 'left' | 'right' | 'top' | 'bottom';
		min?: number;
		max?: number;
		/** Accessible name for the separator. */
		label?: string;
		onchange: (next: number) => void;
	};

	let {
		value,
		axis = 'x',
		side = 'left',
		min = 160,
		max = 720,
		label,
		onchange
	}: Props = $props();
```

In `onPointerMove`, replace the `signed` line with:

```ts
		const signed =
			axis === 'y' ? (side === 'top' ? delta : -delta) : side === 'left' ? delta : -delta;
```

And add the label to the root element's attributes, right after `aria-orientation`:

```svelte
	aria-label={label}
```

- [ ] **Step 4: Wire the grip into `SnippetSourceEditor`**

Add to the import block:

```ts
	import ResizeHandle from '$lib/components/ResizeHandle.svelte';
	import { INLINE_MAX_H, INLINE_MIN_H } from '$lib/editor/editor-size';
	import { getInlineEditorHeight, setInlineEditorHeight } from '$lib/state/editor-size.svelte';
```

Replace the inline-mode editor block (currently `<div class="h-48 overflow-hidden rounded border border-input">…</div>`) with:

```svelte
			<!-- Height is a GLOBAL preference (state/editor-size.svelte.ts), so
			     dragging any inline editor's grip resizes every mounted one and the
			     choice survives a reload — see that store's docstring for why
			     per-instance memory cannot work for navigation script steps. -->
			<div class="overflow-hidden rounded border border-input">
				<div
					data-testid="snippet-editor-box"
					class="overflow-hidden"
					style="height: {getInlineEditorHeight()}px"
				>
					<CodeEditor
						bind:this={editor}
						code={def.code}
						{diagnostics}
						onChange={handleCodeChange}
						onRun={() => void testPanel?.requestRun()}
					/>
				</div>
				<ResizeHandle
					axis="y"
					side="top"
					label="Resize snippet editor"
					value={getInlineEditorHeight()}
					min={INLINE_MIN_H}
					max={INLINE_MAX_H}
					onchange={setInlineEditorHeight}
				/>
			</div>
```

- [ ] **Step 5: Run the tests to verify they pass**

```sh
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts'
```

Expected: PASS. If the drag assertions fail because happy-dom's `PointerEvent` lacks `clientY`, fall back to constructing the event as `new MouseEvent('pointerdown', {...}) as unknown as PointerEvent` — happy-dom's `MouseEvent` carries `clientY` reliably. Keep the assertion values identical.

- [ ] **Step 6: Verify no existing ResizeHandle consumer regressed**

```sh
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
```

Expected: the whole vitest suite passes and `svelte-check` reports no new errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/ResizeHandle.svelte frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte frontend/src/lib/components/Snippet/__tests__/snippet-source-editor.test.ts
git commit -m "feat(frontend/snippet): drag the inline code editor taller"
```

---

## Task 3: Standalone tab editor/console splitter

**Files:**
- Modify: `frontend/src/lib/components/Snippet/SnippetTab.svelte:186-203`
- Test: `frontend/src/lib/components/Snippet/__tests__/snippet-tab-split.test.ts` (create)

**Interfaces:**
- Consumes: `SPLIT_DIVIDER_H`, `SPLIT_MIN_PANEL_H`, `ratioFromPointer`, `splitHeights` from `$lib/editor/editor-size`; `getSnippetSplitRatio`, `setSnippetSplitRatio` from Task 1's store.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/Snippet/__tests__/snippet-tab-split.test.ts`:

```ts
// The snippet tab's editor/console divider. The tab itself needs a snippet
// draft from the store to render anything, so this test drives the split
// through the same pure helpers the component uses and asserts the divider is
// present and wired — the geometry itself is covered exhaustively in
// editor/__tests__/editor-size.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	SPLIT_DIVIDER_H,
	SPLIT_MIN_PANEL_H,
	ratioFromPointer,
	splitHeights
} from '$lib/editor/editor-size';
import {
	getSnippetSplitRatio,
	resetEditorSize,
	setSnippetSplitRatio
} from '$lib/state/editor-size.svelte';

beforeEach(() => {
	localStorage.clear();
	resetEditorSize();
});
afterEach(() => localStorage.clear());

describe('snippet tab split', () => {
	it('a divider drag to 40% of the body gives the editor 40%', () => {
		const containerH = 500;
		const ratio = ratioFromPointer({
			pointerY: 200,
			containerH,
			dividerH: SPLIT_DIVIDER_H,
			minPanelH: SPLIT_MIN_PANEL_H
		});
		setSnippetSplitRatio(ratio);
		const h = splitHeights({
			containerH,
			ratio: getSnippetSplitRatio(),
			dividerH: SPLIT_DIVIDER_H,
			minPanelH: SPLIT_MIN_PANEL_H
		});
		expect(h.topH).toBe(200);
		expect(h.bottomH).toBe(294);
	});

	it('the console keeps its minimum when the divider is dragged to the bottom', () => {
		const containerH = 500;
		setSnippetSplitRatio(
			ratioFromPointer({
				pointerY: 9999,
				containerH,
				dividerH: SPLIT_DIVIDER_H,
				minPanelH: SPLIT_MIN_PANEL_H
			})
		);
		const h = splitHeights({
			containerH,
			ratio: getSnippetSplitRatio(),
			dividerH: SPLIT_DIVIDER_H,
			minPanelH: SPLIT_MIN_PANEL_H
		});
		expect(h.bottomH).toBe(SPLIT_MIN_PANEL_H);
	});

	it('persists the ratio across a store reload', () => {
		setSnippetSplitRatio(0.35);
		resetEditorSize();
		expect(getSnippetSplitRatio()).toBeCloseTo(0.35);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

```sh
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Snippet/__tests__/snippet-tab-split.test.ts'
```

Expected: PASS already if Task 1 is committed — this test guards the composition of Task 1's helpers with the store, and it is the regression net for the ratio contract. If it fails, the bug is in Task 1; fix there.

- [ ] **Step 3: Replace the fixed flex pair in `SnippetTab.svelte`**

Add to the import block:

```ts
	import {
		SPLIT_DIVIDER_H,
		SPLIT_MIN_PANEL_H,
		ratioFromPointer,
		splitHeights
	} from '$lib/editor/editor-size';
	import { getSnippetSplitRatio, setSnippetSplitRatio } from '$lib/state/editor-size.svelte';
```

Add to the `<script>` body, after the `save()` function:

```ts
	// Measured editor/console split. `flex-[3]`/`flex-[2]` gave a fixed 60/40
	// with no way to change it; the ratio now lives in a persisted store and
	// the divider below drives it. Container height comes from a
	// ResizeObserver rather than a one-shot read — the tab body changes height
	// whenever a banner (save error, entry hint, conflict) appears above it.
	let bodyEl: HTMLElement | null = $state(null);
	let bodyH = $state(0);

	$effect(() => {
		if (!bodyEl) return;
		bodyH = bodyEl.clientHeight;
		const ro = new ResizeObserver(() => {
			if (bodyEl) bodyH = bodyEl.clientHeight;
		});
		ro.observe(bodyEl);
		return () => ro.disconnect();
	});

	const paneHeights = $derived(
		splitHeights({
			containerH: bodyH,
			ratio: getSnippetSplitRatio(),
			dividerH: SPLIT_DIVIDER_H,
			minPanelH: SPLIT_MIN_PANEL_H
		})
	);

	// Plain `let`, not `$state`: drag bookkeeping never read in the template
	// (same call as VerticalSplit.svelte's `dragging`).
	let dragging = false;

	function onDividerPointerDown(e: PointerEvent): void {
		if (e.button !== 0 || !e.isPrimary) return;
		e.preventDefault();
		dragging = true;
		(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
		window.addEventListener('pointermove', onDividerPointerMove);
		window.addEventListener('pointerup', endDrag);
		// pointercancel (a system interruption) must end the drag too, or the
		// divider stays locked to the pointer — mirrors VerticalSplit's teardown.
		window.addEventListener('pointercancel', endDrag);
	}

	function onDividerPointerMove(e: PointerEvent): void {
		if (!dragging || bodyEl === null) return;
		const rect = bodyEl.getBoundingClientRect();
		setSnippetSplitRatio(
			ratioFromPointer({
				pointerY: e.clientY - rect.top,
				containerH: rect.height,
				dividerH: SPLIT_DIVIDER_H,
				minPanelH: SPLIT_MIN_PANEL_H
			})
		);
	}

	function endDrag(): void {
		dragging = false;
		window.removeEventListener('pointermove', onDividerPointerMove);
		window.removeEventListener('pointerup', endDrag);
		window.removeEventListener('pointercancel', endDrag);
	}

	$effect(() => endDrag); // drop window listeners on unmount
```

Replace the markup block that currently reads:

```svelte
			<div class="flex min-h-0 flex-1">
				<div class="flex min-h-0 flex-1 flex-col">
					<div class="min-h-0 flex-[3] overflow-hidden"> … CodeEditor … </div>
					<div class="min-h-0 flex-[2] overflow-hidden"> … SnippetConsole … </div>
				</div>
			</div>
```

with:

```svelte
			<div bind:this={bodyEl} class="flex min-h-0 flex-1 flex-col">
				<div class="min-h-0 overflow-hidden" style="height: {paneHeights.topH}px">
					<CodeEditor
						bind:this={editor}
						code={draft.code}
						diagnostics={lint?.diagnostics ?? []}
						docs={getSnippetDocs()}
						{vocab}
						onChange={(c) => updateSnippetCode(tabId, c)}
						onRun={() => void runSnippetTab(tabId)}
					/>
				</div>
				<div
					data-testid="snippet-split-divider"
					role="separator"
					aria-orientation="horizontal"
					aria-label="Resize code editor and console"
					class="shrink-0 cursor-row-resize bg-border transition-colors hover:bg-primary/50"
					style="height: {SPLIT_DIVIDER_H}px"
					onpointerdown={onDividerPointerDown}
				></div>
				<div class="min-h-0 overflow-hidden" style="height: {paneHeights.bottomH}px">
					<SnippetConsole {tabId} onGoToLine={(l) => editor?.goToLine(l)} />
				</div>
			</div>
```

- [ ] **Step 4: Run the suite and typecheck**

```sh
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
```

Expected: PASS, no new `svelte-check` errors. `eslint` may want `a11y` attributes on the divider — the `role`/`aria-orientation`/`aria-label` above satisfy the same rules `VerticalSplit.svelte` passes with.

- [ ] **Step 5: Verify in the running app**

```sh
pixi run backend-start   # separate shell; needs a DB per CLAUDE.md
pixi run frontend-start
```

Open a project → open a snippet tab → drag the divider between the editor and the console. Expected: both panes resize live, neither collapses below ~80px, and the position survives a page reload.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Snippet/SnippetTab.svelte frontend/src/lib/components/Snippet/__tests__/snippet-tab-split.test.ts
git commit -m "feat(frontend/snippet): draggable editor/console split in the snippet tab"
```

---

## Task 4: Custom Ctrl+F search panel

**Files:**
- Create: `frontend/src/lib/editor/search-panel.ts`
- Create: `frontend/src/lib/editor/__tests__/search-panel.test.ts`
- Modify: `frontend/src/lib/editor/theme.ts:141-146`
- Modify: `frontend/src/lib/components/Snippet/CodeEditor.svelte` (extensions array)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `luxurySearch: Extension` (default export shape: a named export), consumed by `CodeEditor`'s extensions array.

- [ ] **Step 1: Confirm the `@codemirror/search` surface you are coding against**

```sh
pixi run -e frontend bash -c "cd frontend && grep -nE '^(declare )?(function|class) (search|findNext|findPrevious|replaceNext|replaceAll|closeSearchPanel|openSearchPanel|getSearchQuery|setSearchQuery|SearchQuery)' node_modules/@codemirror/search/dist/index.d.ts"
pixi run -e frontend bash -c "cd frontend && grep -n 'getCursor\|valid' node_modules/@codemirror/search/dist/index.d.ts | head -20"
```

Expected: `SearchQuery` (constructor config `{search, caseSensitive?, literal?, regexp?, replace?, wholeWord?}`), a `valid` member, `getCursor(state, from?, to?)`, and the commands/effects named above. Adjust the code below only if a name differs.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/lib/editor/__tests__/search-panel.test.ts`:

```ts
// The custom Ctrl+F panel. Mounted against a REAL EditorView in happy-dom —
// the same approach Snippet/__tests__/code-editor.test.ts uses to exercise
// CodeMirror keymap precedence for real rather than through a facet lookup.
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { openSearchPanel, searchPanelOpen } from '@codemirror/search';
import { afterEach, describe, expect, it } from 'vitest';

import { luxurySearch } from '../search-panel';

const DOC = ['a = 1', 'b = 2', 'a = 3', 'A = 4'].join('\n');

let view: EditorView | undefined;

function open(doc = DOC): EditorView {
	view = new EditorView({
		parent: document.body,
		state: EditorState.create({ doc, extensions: [luxurySearch] })
	});
	openSearchPanel(view);
	return view;
}

function q(sel: string): HTMLElement {
	const el = document.querySelector(sel) as HTMLElement;
	if (!el) throw new Error(`missing ${sel}`);
	return el;
}

function input(): HTMLInputElement {
	return q('[data-testid="cm-search-field"]') as HTMLInputElement;
}

function type(value: string): void {
	const el = input();
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
	view?.destroy();
	view = undefined;
	document.body.innerHTML = '';
});

describe('luxurySearch panel', () => {
	it('opens with the custom chrome instead of CodeMirror default buttons', () => {
		open();
		expect(q('[data-testid="cm-search-panel"]')).toBeTruthy();
		expect(document.querySelector('button[name="next"]')).toBeNull();
	});

	it('reports a match count and the current position', () => {
		const v = open();
		type('a');
		// 'a' matches lines 1 and 3 case-sensitively-off => 3 hits ('A = 4' too).
		expect(q('[data-testid="cm-search-count"]').textContent).toBe('1/3');
		q('[data-testid="cm-search-next"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(q('[data-testid="cm-search-count"]').textContent).toBe('2/3');
		expect(v.state.selection.main.empty).toBe(false);
	});

	it('says so when there are no matches', () => {
		open();
		type('zzz');
		expect(q('[data-testid="cm-search-count"]').textContent).toBe('no results');
	});

	it('the match-case chip narrows the query', () => {
		open();
		type('a');
		q('[data-testid="cm-search-case"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(q('[data-testid="cm-search-count"]').textContent).toBe('1/2');
		expect(q('[data-testid="cm-search-case"]').getAttribute('aria-pressed')).toBe('true');
	});

	it('flags an invalid regexp instead of throwing', () => {
		open();
		q('[data-testid="cm-search-regexp"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		type('a(');
		expect(q('[data-testid="cm-search-count"]').textContent).toBe('—');
		expect(input().getAttribute('aria-invalid')).toBe('true');
	});

	it('discloses the replace row only on request, and replaces', () => {
		const v = open();
		expect(document.querySelector('[data-testid="cm-search-replace-field"]')).toBeNull();
		q('[data-testid="cm-search-toggle-replace"]').dispatchEvent(
			new MouseEvent('click', { bubbles: true })
		);
		type('b');
		const rep = q('[data-testid="cm-search-replace-field"]') as HTMLInputElement;
		rep.value = 'Z';
		rep.dispatchEvent(new Event('input', { bubbles: true }));
		q('[data-testid="cm-search-replace-all"]').dispatchEvent(
			new MouseEvent('click', { bubbles: true })
		);
		expect(v.state.doc.toString()).toContain('Z = 2');
	});

	it('Enter finds the next match and Escape closes the panel', () => {
		const v = open();
		type('a');
		input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(q('[data-testid="cm-search-count"]').textContent).toBe('2/3');
		input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(searchPanelOpen(v.state)).toBe(false);
	});
});
```

- [ ] **Step 3: Run it to verify it fails**

```sh
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/editor/__tests__/search-panel.test.ts'
```

Expected: FAIL — `Failed to resolve import "../search-panel"`.

- [ ] **Step 4: Write `search-panel.ts`**

```ts
/**
 * The snippet editor's Ctrl+F panel.
 *
 * CodeMirror's stock search panel is browser-default `<input>`s, text buttons
 * ("next", "previous", "all", "replace", "replace all") and raw checkboxes;
 * `theme.ts` could only ever style the strip they sit in. This replaces the
 * panel's PRESENTATION and nothing else: every action delegates to
 * `@codemirror/search`'s own commands and state, so `Mod-f`, `F3`,
 * `Mod-Shift-l` and the rest keep working exactly as configured upstream.
 *
 * Plain DOM, not a mounted Svelte component. CodeMirror creates and destroys
 * the panel on its own schedule; a nested Svelte root inside it would buy
 * lifecycle problems for styling convenience. Icons are therefore inline SVG
 * (lucide's 24x24 stroke geometry) rather than `@lucide/svelte` components,
 * and the styling lives in `theme.ts` under `cm-dr-search*` class names —
 * the same `EditorView.theme` mechanism as the rest of the editor chrome,
 * and not subject to Tailwind's content-scanning heuristics for class strings
 * assembled inside a `.ts` file.
 */
import type { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';
import {
	SearchQuery,
	closeSearchPanel,
	findNext,
	findPrevious,
	getSearchQuery,
	replaceAll,
	replaceNext,
	search,
	setSearchQuery
} from '@codemirror/search';

/** Stop counting matches past this many. A one-character query against a long
 * snippet would otherwise turn every keystroke into a full-document scan; the
 * counter is a comfort, not a report, so it degrades to "1/1000+". */
const MATCH_CAP = 1000;

interface Counted {
	total: number;
	/** 1-based position of the current match, or 0 when the cursor is not on
	 * (or before) any match. */
	index: number;
	capped: boolean;
}

function countMatches(state: EditorState, query: SearchQuery): Counted {
	if (!query.valid) return { total: 0, index: 0, capped: false };
	const sel = state.selection.main;
	const cursor = query.getCursor(state);
	let total = 0;
	let exact = 0;
	let upcoming = 0;
	for (let it = cursor.next(); !it.done; it = cursor.next()) {
		const m = it.value as { from: number; to: number };
		total++;
		if (m.from === sel.from && m.to === sel.to) exact = total;
		else if (upcoming === 0 && m.from >= sel.from) upcoming = total;
		if (total >= MATCH_CAP) return { total, index: exact || upcoming, capped: true };
	}
	// No match at or after the cursor wraps to the first one — the same
	// wrap-around `findNext` performs, so the counter agrees with the button.
	const index = exact || upcoming || (total > 0 ? 1 : 0);
	return { total, index, capped: false };
}

function countLabel(c: Counted): string {
	if (c.total === 0) return 'no results';
	return c.capped ? `${c.index}/${MATCH_CAP}+` : `${c.index}/${c.total}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	attrs: Record<string, string> = {}
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
	return node;
}

/** Lucide-geometry inline SVG. `paths` are `d` attributes on a 24x24 grid. */
function icon(...paths: string[]): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '2');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of paths) {
		const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		p.setAttribute('d', d);
		svg.append(p);
	}
	return svg;
}

const ICON_CHEVRON_RIGHT = 'm9 18 6-6-6-6';
const ICON_CHEVRON_DOWN = 'm6 9 6 6 6-6';
const ICON_UP = 'm18 15-6-6-6 6';
const ICON_DOWN = 'm6 9 6 6 6-6';
const ICON_X = 'M18 6 6 18M6 6l12 12';

function iconButton(testid: string, label: string, ...paths: string[]): HTMLButtonElement {
	const b = el('button', 'cm-dr-search-btn', {
		type: 'button',
		'data-testid': testid,
		'aria-label': label,
		title: label
	});
	b.append(icon(...paths));
	return b;
}

function chip(testid: string, text: string, label: string): HTMLButtonElement {
	const b = el('button', 'cm-dr-search-chip', {
		type: 'button',
		'data-testid': testid,
		'aria-label': label,
		'aria-pressed': 'false',
		title: label
	});
	b.textContent = text;
	return b;
}

class LuxurySearchPanel implements Panel {
	readonly dom: HTMLElement;
	readonly top = true;

	private readonly field: HTMLInputElement;
	private readonly replaceField: HTMLInputElement;
	private readonly count: HTMLElement;
	private readonly replaceRow: HTMLElement;
	private readonly caseChip: HTMLButtonElement;
	private readonly regexpChip: HTMLButtonElement;
	private readonly wordChip: HTMLButtonElement;
	private readonly discloseBtn: HTMLButtonElement;
	private replaceOpen = false;

	constructor(private readonly view: EditorView) {
		this.dom = el('div', 'cm-dr-search', { 'data-testid': 'cm-search-panel', role: 'search' });

		const row = el('div', 'cm-dr-search-row');
		this.discloseBtn = iconButton(
			'cm-search-toggle-replace',
			'Show replace',
			ICON_CHEVRON_RIGHT
		);
		this.discloseBtn.addEventListener('click', () => this.toggleReplace());

		this.field = el('input', 'cm-dr-search-field', {
			'data-testid': 'cm-search-field',
			type: 'text',
			placeholder: 'Find',
			'aria-label': 'Find',
			spellcheck: 'false'
		});
		this.field.addEventListener('input', () => this.commit());
		this.field.addEventListener('keydown', (e) => this.onFieldKey(e));

		this.count = el('span', 'cm-dr-search-count', { 'data-testid': 'cm-search-count' });

		const prev = iconButton('cm-search-prev', 'Previous match', ICON_UP);
		prev.addEventListener('click', () => findPrevious(this.view));
		const next = iconButton('cm-search-next', 'Next match', ICON_DOWN);
		next.addEventListener('click', () => findNext(this.view));
		const close = iconButton('cm-search-close', 'Close search', ICON_X);
		close.addEventListener('click', () => closeSearchPanel(this.view));

		row.append(this.discloseBtn, this.field, this.count, prev, next, close);

		const chips = el('div', 'cm-dr-search-chips');
		this.caseChip = chip('cm-search-case', 'Aa', 'Match case');
		this.caseChip.addEventListener('click', () => this.toggleChip(this.caseChip));
		this.regexpChip = chip('cm-search-regexp', '.*', 'Regular expression');
		this.regexpChip.addEventListener('click', () => this.toggleChip(this.regexpChip));
		this.wordChip = chip('cm-search-word', 'ab|', 'Whole word');
		this.wordChip.addEventListener('click', () => this.toggleChip(this.wordChip));
		chips.append(this.caseChip, this.regexpChip, this.wordChip);

		this.replaceRow = el('div', 'cm-dr-search-row cm-dr-search-replace');
		this.replaceField = el('input', 'cm-dr-search-field', {
			'data-testid': 'cm-search-replace-field',
			type: 'text',
			placeholder: 'Replace with',
			'aria-label': 'Replace with',
			spellcheck: 'false'
		});
		this.replaceField.addEventListener('input', () => this.commit());
		this.replaceField.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				closeSearchPanel(this.view);
			}
		});
		const replaceOne = el('button', 'cm-dr-search-action', {
			type: 'button',
			'data-testid': 'cm-search-replace'
		});
		replaceOne.textContent = 'Replace';
		replaceOne.addEventListener('click', () => replaceNext(this.view));
		const replaceEvery = el('button', 'cm-dr-search-action', {
			type: 'button',
			'data-testid': 'cm-search-replace-all'
		});
		replaceEvery.textContent = 'All';
		replaceEvery.addEventListener('click', () => replaceAll(this.view));
		this.replaceRow.append(this.replaceField, replaceOne, replaceEvery);

		this.dom.append(row, chips);
		this.syncFromState(view.state);
	}

	mount(): void {
		this.field.focus();
		this.field.select();
	}

	update(update: ViewUpdate): void {
		// Doc/selection changes move the counter; a setSearchQuery effect means
		// something else (the `Mod-Shift-l`-style commands, or a selection-seeded
		// open) changed the query and the inputs must follow.
		const queryChanged = update.transactions.some((tr) =>
			tr.effects.some((e) => e.is(setSearchQuery))
		);
		if (update.docChanged || update.selectionSet || queryChanged) {
			this.syncFromState(update.state, queryChanged);
		}
	}

	/** Push the panel's widget values into a new `SearchQuery`. */
	private commit(): void {
		const query = new SearchQuery({
			search: this.field.value,
			caseSensitive: this.caseChip.getAttribute('aria-pressed') === 'true',
			regexp: this.regexpChip.getAttribute('aria-pressed') === 'true',
			wholeWord: this.wordChip.getAttribute('aria-pressed') === 'true',
			replace: this.replaceField.value
		});
		this.view.dispatch({ effects: setSearchQuery.of(query) });
	}

	private toggleChip(b: HTMLButtonElement): void {
		b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
		this.commit();
	}

	private toggleReplace(): void {
		this.replaceOpen = !this.replaceOpen;
		this.discloseBtn.replaceChildren(
			icon(this.replaceOpen ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT)
		);
		this.discloseBtn.setAttribute('aria-label', this.replaceOpen ? 'Hide replace' : 'Show replace');
		if (this.replaceOpen) this.dom.append(this.replaceRow);
		else this.replaceRow.remove();
	}

	private onFieldKey(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (e.shiftKey) findPrevious(this.view);
			else findNext(this.view);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			closeSearchPanel(this.view);
		}
	}

	/** Refresh the counter, and (when the query itself changed elsewhere) the
	 * widget values. `syncWidgets` is false on plain doc/selection updates so a
	 * sync never fights the user's in-progress typing. */
	private syncFromState(state: EditorState, syncWidgets = true): void {
		const query = getSearchQuery(state);
		if (syncWidgets) {
			if (this.field.value !== query.search) this.field.value = query.search;
			if (this.replaceField.value !== query.replace) this.replaceField.value = query.replace;
			this.caseChip.setAttribute('aria-pressed', String(query.caseSensitive));
			this.regexpChip.setAttribute('aria-pressed', String(query.regexp));
			this.wordChip.setAttribute('aria-pressed', String(query.wholeWord));
		}
		// An empty field is not an error; a non-empty invalid regexp is. `valid`
		// covers both, so the error state is gated on there being input at all.
		const invalid = query.search !== '' && !query.valid;
		this.field.setAttribute('aria-invalid', String(invalid));
		this.field.classList.toggle('cm-dr-search-invalid', invalid);
		this.count.textContent = invalid ? '—' : countLabel(countMatches(state, query));
	}
}

/** The search extension with the custom panel, anchored at the top of the
 * editor. Added AFTER `basicSetup`, which contributes only `searchKeymap` and
 * `highlightSelectionMatches` — never a `search()` configuration — so there is
 * no second panel and no precedence subtlety. */
export const luxurySearch: Extension = search({
	top: true,
	createPanel: (view) => new LuxurySearchPanel(view)
});
```

- [ ] **Step 5: Run the test to verify it passes**

```sh
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/editor/__tests__/search-panel.test.ts'
```

Expected: PASS. Two likely adjustments, both in the test and not the module:
- If `1/3` reads `0/3`, the initial cursor sits before every match — accept whatever the wrap-around rule yields and assert the value the implementation actually produces, as long as it advances on `next`.
- If happy-dom's `KeyboardEvent` does not reach the listener, dispatch on `input()` with `{ bubbles: true, cancelable: true }` (already the case) and confirm the panel is in `document.body`.

- [ ] **Step 6: Style the panel in `theme.ts`**

In `frontend/src/lib/editor/theme.ts`, replace the trailing `'.cm-panels'` block with the panel styling. Keep it as the last group in `editorTheme`'s object:

```ts
		// Search panel. `basicSetup` gives only `searchKeymap`; the panel itself
		// comes from `search-panel.ts` (custom `createPanel`), which builds plain
		// DOM with these class names. Everything below is presentation for that
		// markup — behaviour lives in @codemirror/search.
		'.cm-panels': {
			backgroundColor: 'var(--popover)',
			color: 'var(--popover-foreground)',
			border: 'none'
		},
		'.cm-panels-top': { borderBottom: '1px solid var(--border)' },
		'.cm-panels-bottom': { borderTop: '1px solid var(--border)' },

		'.cm-dr-search': {
			display: 'flex',
			flexDirection: 'column',
			gap: '0.3rem',
			padding: '0.45rem 0.6rem',
			fontFamily: 'inherit',
			fontSize: '0.75rem'
		},
		'.cm-dr-search-row': {
			display: 'flex',
			alignItems: 'center',
			gap: '0.35rem'
		},
		'.cm-dr-search-field': {
			flex: '1',
			minWidth: '0',
			backgroundColor: 'var(--card)',
			color: 'var(--foreground)',
			border: '1px solid var(--border)',
			borderRadius: 'var(--radius-md)',
			padding: '0.2rem 0.5rem',
			fontFamily: MONO,
			fontSize: '0.75rem',
			outline: 'none'
		},
		'.cm-dr-search-field:focus': {
			borderColor: 'var(--primary)',
			boxShadow: '0 0 0 2px oklch(0.78 0.06 155 / 18%)'
		},
		'.cm-dr-search-invalid': {
			borderColor: 'var(--destructive)',
			boxShadow: '0 0 0 2px oklch(0.66 0.14 25 / 18%)'
		},
		'.cm-dr-search-count': {
			flexShrink: '0',
			minWidth: '4.5ch',
			textAlign: 'right',
			color: 'var(--muted-foreground)',
			fontFamily: MONO,
			fontSize: '0.6875rem',
			fontVariantNumeric: 'tabular-nums'
		},
		'.cm-dr-search-btn': {
			display: 'inline-flex',
			alignItems: 'center',
			justifyContent: 'center',
			flexShrink: '0',
			width: '1.5rem',
			height: '1.5rem',
			padding: '0',
			border: 'none',
			borderRadius: 'var(--radius-md)',
			background: 'transparent',
			color: 'var(--muted-foreground)',
			cursor: 'pointer',
			transition: 'background-color 120ms ease, color 120ms ease'
		},
		'.cm-dr-search-btn:hover': {
			backgroundColor: 'var(--accent)',
			color: 'var(--accent-foreground)'
		},
		'.cm-dr-search-btn svg': { width: '0.875rem', height: '0.875rem' },
		'.cm-dr-search-chips': {
			display: 'flex',
			alignItems: 'center',
			gap: '0.3rem',
			paddingLeft: '1.85rem'
		},
		'.cm-dr-search-chip': {
			padding: '0.1rem 0.4rem',
			border: '1px solid var(--border)',
			borderRadius: '999px',
			background: 'transparent',
			color: 'var(--muted-foreground)',
			fontFamily: MONO,
			fontSize: '0.6875rem',
			lineHeight: '1.2',
			cursor: 'pointer',
			transition: 'background-color 120ms ease, color 120ms ease, border-color 120ms ease'
		},
		'.cm-dr-search-chip:hover': { color: 'var(--foreground)' },
		'.cm-dr-search-chip[aria-pressed="true"]': {
			backgroundColor: 'oklch(0.78 0.06 155 / 18%)',
			borderColor: 'oklch(0.78 0.06 155 / 45%)',
			color: 'var(--cm-plain)'
		},
		'.cm-dr-search-replace': { paddingLeft: '1.85rem' },
		'.cm-dr-search-action': {
			flexShrink: '0',
			padding: '0.2rem 0.5rem',
			border: '1px solid var(--border)',
			borderRadius: 'var(--radius-md)',
			background: 'transparent',
			color: 'var(--foreground)',
			fontSize: '0.6875rem',
			cursor: 'pointer',
			transition: 'background-color 120ms ease'
		},
		'.cm-dr-search-action:hover': { backgroundColor: 'var(--accent)' }
```

- [ ] **Step 7: Register the extension in `CodeEditor.svelte`**

Add the import beside the theme import:

```ts
	import { luxurySearch } from '$lib/editor/search-panel';
```

Add it to the extensions array immediately after `editorLuxuryTheme`:

```ts
						editorLuxuryTheme,
						// Custom Ctrl+F panel. basicSetup contributes only searchKeymap +
						// highlightSelectionMatches, so this is the ONLY search() config
						// in the editor — no duplicate panel.
						luxurySearch,
```

- [ ] **Step 8: Run the suite, typecheck, and look at it**

```sh
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
```

Then with the app running (`pixi run frontend-start`, backend up), open a snippet tab, press Ctrl+F, and confirm: the panel is at the top, the counter tracks as you type and as you press Enter, the chips toggle, the chevron reveals the replace row, and Escape closes it.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/editor/search-panel.ts frontend/src/lib/editor/__tests__/search-panel.test.ts frontend/src/lib/editor/theme.ts frontend/src/lib/components/Snippet/CodeEditor.svelte
git commit -m "feat(frontend/editor): designed Ctrl+F search panel with a match counter"
```

---

## Task 5: `POST /snippets/format` backed by ruff

**Files:**
- Modify: `pixi.toml` (`[feature.api.dependencies]`)
- Modify: `src/data_rover/api/settings.py`
- Create: `src/data_rover/api/script_format.py`
- Modify: `src/data_rover/api/schemas.py`
- Modify: `src/data_rover/api/routes/snippets.py`
- Modify: `src/data_rover/api/authz.py:54-69`
- Modify: `CLAUDE.md`
- Test: `tests/api/test_snippets_format.py`

**Interfaces:**
- Consumes: `SNIPPET_MAX_CODE_BYTES` from `data_rover.core.script.schema`; `require_membership` from `..authz`; `get_settings`/`Settings` from `..settings` (same imports `routes/snippets.py` already uses — check its existing import block and match it).
- Produces:
  - `script_format.py`: `FORMAT_INDENT_WIDTH: int = 4`; `class FormatUnavailable(RuntimeError)`; `class FormatTimeout(RuntimeError)`; `class FormatSyntaxError(ValueError)`; `@dataclass(frozen=True) class FormatResult: code: str; changed: bool`; `def ruff_path() -> str | None`; `def reset_ruff_path_cache() -> None`; `def format_code(code: str, *, timeout_s: float) -> FormatResult`.
  - `schemas.py`: `SnippetFormatIn(code: str)`, `SnippetFormatOut(code: str, changed: bool)`.
  - Route `POST /api/v1/projects/{project_id}/snippets/format`.
  - Setting `snippet_format_timeout_s: float = 5.0`.

- [ ] **Step 1: Add ruff to the api environment and verify the exact invocation**

Edit `pixi.toml`, adding one line to `[feature.api.dependencies]` (keep the block's existing ordering style — append after `process-compose`):

```toml
# `ruff format` backs POST /snippets/format. It is a formatter, not an
# executor: it parses and prints the snippet and never runs it, so unlike the
# snippet runner it needs no sandbox. Pinned to the same version core-dev uses
# so CI-formatted and user-formatted code cannot disagree.
ruff = "0.15.*"
```

Then verify the invocation the module will use, by hand:

```sh
printf 'def f( a ):\n\treturn  a+1\n' | pixi run -e api ruff format - --stdin-filename snippet.py --isolated --config "indent-width=4"
```

Expected: `def f(a):\n    return a + 1\n` on stdout, exit 0.

If ruff rejects `--isolated` together with `--config`, drop `--isolated` and re-run; whichever form works is the one you hardcode in Step 3, and note the choice in the module docstring. Also confirm the failure path:

```sh
printf 'def f(:\n' | pixi run -e api ruff format - --stdin-filename snippet.py --isolated --config "indent-width=4"; echo "exit=$?"
```

Expected: non-zero exit with a parse-error message on stderr.

- [ ] **Step 2: Write the failing test**

Create `tests/api/test_snippets_format.py`:

```python
"""POST /snippets/format — the Reformat button's backend.

Formatting is read-only with respect to the model: it never touches
``session.model``, which is why the route sits in
``authz._READ_ONLY_POST_SUFFIXES`` and a viewer may call it.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db, script_format
from data_rover.api.main import create_app
from data_rover.core.script.schema import SNIPPET_MAX_CODE_BYTES

from .conftest import AUTH_HEADERS, papi, seed_default_project


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    script_format.reset_ruff_path_cache()
    return TestClient(create_app())


def _post(c: TestClient, code: str) -> object:
    return c.post(papi("/snippets/format"), json={"code": code}, headers=AUTH_HEADERS)


def test_formats_and_reports_changed(client: TestClient) -> None:
    r = _post(client, "def f( a ):\n\treturn  a+1\n")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["code"] == "def f(a):\n    return a + 1\n"
    assert body["changed"] is True


def test_already_formatted_reports_unchanged(client: TestClient) -> None:
    formatted = "def f(a):\n    return a + 1\n"
    r = _post(client, formatted)
    assert r.status_code == 200, r.text
    assert r.json() == {"code": formatted, "changed": False}


def test_indents_with_four_spaces(client: TestClient) -> None:
    r = _post(client, "if True:\n  x = 1\n  if x:\n    y = 2\n")
    assert r.status_code == 200, r.text
    assert r.json()["code"] == "if True:\n    x = 1\n    if x:\n        y = 2\n"


def test_syntax_error_is_422(client: TestClient) -> None:
    r = _post(client, "def f(:\n")
    assert r.status_code == 422, r.text
    assert r.json()["detail"]


def test_oversized_code_is_rejected(client: TestClient) -> None:
    r = _post(client, "x = 1\n" * (SNIPPET_MAX_CODE_BYTES // 6 + 10))
    assert r.status_code == 422


def test_viewer_may_format(client: TestClient) -> None:
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    finally:
        gen.close()
    r = client.post(
        papi("/snippets/format"),
        json={"code": "x=1\n"},
        headers={"x-user-id": "vw", "x-user-email": "vw@example.com"},
    )
    assert r.status_code == 200, r.text


def test_missing_ruff_is_503_not_500(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same degraded-not-failed posture as a missing snippet guest binary."""
    monkeypatch.setattr(script_format.shutil, "which", lambda _name: None)
    script_format.reset_ruff_path_cache()
    r = _post(client, "x=1\n")
    assert r.status_code == 503, r.text
```

- [ ] **Step 3: Run it to verify it fails**

```sh
pixi run -e core-dev pytest tests/api/test_snippets_format.py -v
```

Expected: FAIL at import — `ModuleNotFoundError: data_rover.api.script_format`.

- [ ] **Step 4: Write `script_format.py`**

```python
"""``ruff format`` seam for ``POST /snippets/format``.

Lives in the api package, not ``core``: it shells out to a binary, and
``core`` is deliberately dependency-light (``core/script/runner.py`` is
sandbox-agnostic by design). It is the sibling of ``script_runner.py``, but
carries none of that module's tripwires — ``ruff format`` PARSES and PRINTS
the snippet, it never executes it, so untrusted input needs no sandbox here.

``indent-width`` is passed explicitly rather than left to ruff's default so
the formatter and the editor's own ``INDENT_WIDTH`` (four spaces, see
``frontend/src/lib/editor/indent.ts``) cannot drift apart silently. Line
length stays at ruff's default.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass

#: Spaces per indentation level handed to ruff. Must equal the editor's
#: ``INDENT_WIDTH`` in ``frontend/src/lib/editor/indent.ts``.
FORMAT_INDENT_WIDTH = 4


class FormatUnavailable(RuntimeError):
    """``ruff`` is not on PATH — the route answers 503, never 500."""


class FormatTimeout(RuntimeError):
    """``ruff`` did not finish inside the configured budget."""


class FormatSyntaxError(ValueError):
    """The snippet does not parse; ruff's own message is carried through."""


@dataclass(frozen=True)
class FormatResult:
    code: str
    #: Whether formatting actually rewrote anything — lets the client skip a
    #: no-op editor transaction (and therefore a no-op undo entry).
    changed: bool


#: Sentinel distinct from ``None``: ``None`` is a RESOLVED "ruff is absent"
#: answer, so it cannot double as "not looked yet".
_UNRESOLVED = object()
_ruff_path: object | str | None = _UNRESOLVED


def ruff_path() -> str | None:
    """Resolved ``ruff`` executable, or None. Cached: PATH does not change
    under a running process, and this is on a per-keystroke-ish path."""
    global _ruff_path
    if _ruff_path is _UNRESOLVED:
        _ruff_path = shutil.which("ruff")
    return _ruff_path  # type: ignore[return-value]


def reset_ruff_path_cache() -> None:
    """Test seam — drop the cached resolution."""
    global _ruff_path
    _ruff_path = _UNRESOLVED


def format_code(code: str, *, timeout_s: float) -> FormatResult:
    exe = ruff_path()
    if exe is None:
        raise FormatUnavailable("code formatter (ruff) is not installed")
    try:
        proc = subprocess.run(
            [
                exe,
                "format",
                "-",
                "--stdin-filename",
                "snippet.py",
                "--isolated",
                "--config",
                f"indent-width={FORMAT_INDENT_WIDTH}",
            ],
            input=code,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise FormatTimeout("formatting timed out") from exc
    if proc.returncode != 0:
        raise FormatSyntaxError(_first_message(proc.stderr))
    return FormatResult(code=proc.stdout, changed=proc.stdout != code)


def _first_message(stderr: str) -> str:
    """First meaningful line of ruff's stderr — the parse error itself. The
    rest is context the editor has no room for."""
    for line in stderr.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return "could not parse this snippet"
```

If Step 1 showed `--isolated` is incompatible with `--config`, remove `"--isolated",` from the argument list and add a one-line comment saying ruff rejected the combination.

- [ ] **Step 5: Add the setting**

In `src/data_rover/api/settings.py`, beside the other `snippet_*` fields (after `snippet_page_limit`):

```python
    #: Wall budget for one ``ruff format`` subprocess (POST /snippets/format).
    #: Generous for a <=64 KiB file; a breach means something is wrong with
    #: the host, which the route reports as 503 rather than hanging the editor.
    snippet_format_timeout_s: float = 5.0
```

- [ ] **Step 6: Add the schemas**

In `src/data_rover/api/schemas.py`, after `SnippetCancelIn`:

```python
class SnippetFormatIn(BaseModel):
    """Body for POST /snippets/format. The cap is enforced here so oversized
    input 422s in validation, before a subprocess is spawned."""

    code: str = Field(max_length=SNIPPET_MAX_CODE_BYTES)


class SnippetFormatOut(BaseModel):
    code: str
    #: False when the snippet was already formatted — the client skips the
    #: editor transaction (and its undo entry) in that case.
    changed: bool
```

`Field` is already imported in this module. Add `SNIPPET_MAX_CODE_BYTES` to the existing `from data_rover.core.script.schema import ...` line if there is one; otherwise add the import beside the other `core.script` imports at the top.

> Note: `max_length` on a `str` counts characters, not bytes. That is a tighter-or-equal bound for non-ASCII and is the right cheap check here; the route does not need a second byte-exact test.

- [ ] **Step 7: Add the route**

In `src/data_rover/api/routes/snippets.py`, add to the imports:

```python
from ..script_format import (
    FormatSyntaxError,
    FormatTimeout,
    FormatUnavailable,
    format_code,
)
```

and to the schema import list: `SnippetFormatIn`, `SnippetFormatOut`.

Add the route immediately after `lint_snippet`:

```python
@router.post("/snippets/format")
def format_snippet_code(
    payload: SnippetFormatIn,
    _membership: Membership = Depends(require_membership),
    settings: Settings = Depends(get_settings),
) -> SnippetFormatOut:
    """Reformat a snippet with ``ruff format``.

    Read-only (listed in ``authz._READ_ONLY_POST_SUFFIXES``): it never touches
    ``session.model``, so a viewer may format their own draft. A missing
    formatter is a 503, matching the missing-guest-binary posture of
    ``POST /snippets/run`` — degraded, never a 500.
    """
    try:
        result = format_code(
            payload.code, timeout_s=settings.snippet_format_timeout_s
        )
    except FormatSyntaxError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (FormatUnavailable, FormatTimeout) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return SnippetFormatOut(code=result.code, changed=result.changed)
```

- [ ] **Step 8: Allowlist the route as read-only**

In `src/data_rover/api/authz.py`, add to `_READ_ONLY_POST_SUFFIXES` next to the other snippet entries:

```python
    "/snippets/format",
```

- [ ] **Step 9: Run the tests to verify they pass**

```sh
pixi run -e core-dev pytest tests/api/test_snippets_format.py -v
```

Expected: all 7 PASS. If `test_formats_and_reports_changed` disagrees on exact output, run the Step-1 command again and use ruff's real output as the expectation — ruff, not the plan, is the authority on formatted text.

- [ ] **Step 10: Update `CLAUDE.md`**

In the "Code execution (snippets)" section's **Routes** bullet, extend the first sentence to name the new endpoint and add a clause for it. Change:

> **Routes (`routes/snippets.py`)** — `POST /snippets/{run,lint,cancel}` under the project prefix.

to:

> **Routes (`routes/snippets.py`)** — `POST /snippets/{run,lint,format,cancel}` under the project prefix.

and append to that same bullet:

> `format` shells `ruff format` through `api/script_format.py` (ruff is an `[feature.api.dependencies]` runtime dep; it parses and prints, never executes, so no sandbox is involved), pins `indent-width=4` to match the editor's own `INDENT_WIDTH`, and answers **422** on unparseable code / **503** when ruff is absent — degraded, never 500. It is in `authz._READ_ONLY_POST_SUFFIXES` too, so viewers may format their own drafts.

- [ ] **Step 11: Lint, typecheck, full api suite, commit**

```sh
pixi run dr-tidy
pixi run core-test
git add pixi.toml pixi.lock src/data_rover/api/script_format.py src/data_rover/api/settings.py src/data_rover/api/schemas.py src/data_rover/api/routes/snippets.py src/data_rover/api/authz.py tests/api/test_snippets_format.py CLAUDE.md
git commit -m "feat(api/snippets): POST /snippets/format backed by ruff format"
```

If `pixi.lock` was not regenerated by the earlier `pixi run -e api ...` call, run `pixi install -e api` before committing so the lock matches `pixi.toml`.

---

## Task 6: Reformat control in the editor

**Files:**
- Create: `frontend/src/lib/editor/format.ts`
- Create: `frontend/src/lib/editor/__tests__/format.test.ts`
- Modify: `frontend/src/lib/api/types.ts`
- Modify: `frontend/src/lib/api/snippets.ts`
- Modify: `frontend/src/lib/components/Snippet/CodeEditor.svelte`
- Test: `frontend/src/lib/components/Snippet/__tests__/code-editor.test.ts`

**Interfaces:**
- Consumes: `POST /snippets/format` from Task 5; `expandTabs`, `hasTabs` from `$lib/editor/indent`.
- Produces: `lineStartOffset(text: string, line: number): number` from `format.ts`; `formatSnippet(code: string, cfg?: ClientConfig): Promise<SnippetFormatOut>` from `api/snippets.ts`; `SnippetFormatOutSchema`/`SnippetFormatOut` from `api/types.ts`; `data-testid="snippet-format"` and `data-testid="snippet-format-error"` in the editor.

- [ ] **Step 1: Write the failing test for the text helper**

Create `frontend/src/lib/editor/__tests__/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lineStartOffset } from '../format';

describe('lineStartOffset', () => {
	const text = 'a\nbb\nccc\n';

	it('returns the character offset a 1-based line starts at', () => {
		expect(lineStartOffset(text, 1)).toBe(0);
		expect(lineStartOffset(text, 2)).toBe(2);
		expect(lineStartOffset(text, 3)).toBe(5);
	});

	it('clamps a line past the end to the last line start', () => {
		expect(lineStartOffset(text, 99)).toBe(9);
	});

	it('clamps a non-positive line to 0', () => {
		expect(lineStartOffset(text, 0)).toBe(0);
		expect(lineStartOffset(text, -3)).toBe(0);
	});

	it('handles an empty document', () => {
		expect(lineStartOffset('', 1)).toBe(0);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

```sh
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/editor/__tests__/format.test.ts'
```

Expected: FAIL — cannot resolve `../format`.

- [ ] **Step 3: Write `format.ts`**

```ts
/**
 * Text helpers for the reformat transaction.
 *
 * Reformatting replaces the whole document in ONE transaction, so the new
 * cursor position has to be computed against the incoming string rather than
 * read back off `EditorState` after the fact (a second dispatch would be a
 * second entry in the undo history). Pure string math, no CodeMirror import,
 * so it unit-tests without a DOM — same rationale as `indent.ts`.
 */

/** Character offset at which the 1-based `line` starts in `text`. A line past
 * the end clamps to the last line's start; a non-positive line clamps to 0. */
export function lineStartOffset(text: string, line: number): number {
	if (line <= 1) return 0;
	let idx = 0;
	for (let i = 1; i < line; i++) {
		const nl = text.indexOf('\n', idx);
		if (nl === -1) return idx;
		idx = nl + 1;
	}
	return idx;
}
```

- [ ] **Step 4: Run it to verify it passes**

```sh
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/editor/__tests__/format.test.ts'
```

Expected: PASS.

- [ ] **Step 5: Add the API client + schema**

In `frontend/src/lib/api/types.ts`, after `SnippetLintOutSchema`/`SnippetLintOut`:

```ts
export const SnippetFormatOutSchema = z.object({
	code: z.string(),
	changed: z.boolean()
});
export type SnippetFormatOut = z.infer<typeof SnippetFormatOutSchema>;
```

In `frontend/src/lib/api/snippets.ts`, add `SnippetFormatOutSchema` and `type SnippetFormatOut` to the `./types` import, then add after `lintSnippet`:

```ts
export function formatSnippet(code: string, cfg?: ClientConfig): Promise<SnippetFormatOut> {
	return apiFetch(
		'/snippets/format',
		{ method: 'POST', body: { code }, schema: SnippetFormatOutSchema },
		cfg
	);
}
```

- [ ] **Step 6: Write the failing component tests**

Append to `frontend/src/lib/components/Snippet/__tests__/code-editor.test.ts`. Add the imports at the top of the file:

```ts
import { afterAll, afterEach, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../api/__tests__/server';
```

and the lifecycle hooks plus the new suite:

```ts
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => {
	server.resetHandlers();
	document.body.innerHTML = '';
});
afterAll(() => server.close());

function docText(): string {
	const content = document.querySelector(
		'[data-testid="snippet-editor"] .cm-content'
	) as HTMLElement;
	const view = EditorView.findFromDOM(content);
	if (!view) throw new Error('no view');
	return view.state.doc.toString();
}

function clickFormat(): void {
	const btn = document.querySelector('[data-testid="snippet-format"]') as HTMLElement;
	if (!btn) throw new Error('no format button');
	btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function settle(): Promise<void> {
	// let the fetch promise chain resolve, then flush Svelte
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

describe('CodeEditor — Reformat', () => {
	it('replaces the document with the formatted code in one undo step', async () => {
		server.use(
			http.post('*/snippets/format', () =>
				HttpResponse.json({ code: 'def f(a):\n    return a + 1\n', changed: true })
			)
		);
		const c = render('def f( a ):\n  return  a+1\n', () => {});
		try {
			clickFormat();
			await settle();
			expect(docText()).toBe('def f(a):\n    return a + 1\n');
		} finally {
			unmount(c);
		}
	});

	it('expands tabs before sending, so tab-indented code can be formatted', async () => {
		let sent = '';
		server.use(
			http.post('*/snippets/format', async ({ request }) => {
				sent = ((await request.json()) as { code: string }).code;
				return HttpResponse.json({ code: sent, changed: false });
			})
		);
		const c = render('def f():\n\treturn 1\n', () => {});
		try {
			clickFormat();
			await settle();
			expect(sent).toBe('def f():\n    return 1\n');
			expect(sent).not.toContain('\t');
		} finally {
			unmount(c);
		}
	});

	it('a 422 shows a message and still sanitizes the tabs locally', async () => {
		server.use(
			http.post('*/snippets/format', () =>
				HttpResponse.json({ detail: 'syntax error at line 1' }, { status: 422 })
			)
		);
		const c = render('def f(:\n\tpass\n', () => {});
		try {
			clickFormat();
			await settle();
			const err = document.querySelector('[data-testid="snippet-format-error"]');
			expect(err?.textContent).toContain('syntax error');
			// The absorbed "Fix indentation" behaviour survives a refused format.
			expect(docText()).toBe('def f(:\n    pass\n');
		} finally {
			unmount(c);
		}
	});

	it('a 503 disables the control instead of failing loudly', async () => {
		server.use(
			http.post('*/snippets/format', () =>
				HttpResponse.json({ detail: 'formatter unavailable' }, { status: 503 })
			)
		);
		const c = render('x=1\n', () => {});
		try {
			clickFormat();
			await settle();
			const btn = document.querySelector('[data-testid="snippet-format"]') as HTMLButtonElement;
			expect(btn.disabled).toBe(true);
		} finally {
			unmount(c);
		}
	});
});
```

The existing `render` helper in this file takes `(code, onRun)`. Reuse it unchanged.

- [ ] **Step 7: Run the tests to verify they fail**

```sh
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Snippet/__tests__/code-editor.test.ts'
```

Expected: FAIL — `no format button` (only the conditional `snippet-fix-indent` exists).

- [ ] **Step 8: Implement the control in `CodeEditor.svelte`**

Add to the imports:

```ts
	import { onDestroy } from 'svelte';
	import { formatSnippet } from '$lib/api/snippets';
	import { ApiError } from '$lib/api/errors';
	import { lineStartOffset } from '$lib/editor/format';
```

Replace the `tabby` / `fixIndentation` block with:

```ts
	/** Whether the CURRENT document still holds a tab character. Derived from
	 * the `code` prop rather than the view so it is correct before the editor
	 * mounts and after an external replacement, and so it stays plain reactive
	 * state (the view is not). Drives the Reformat control's warning tint: a
	 * tab is what CPython's tokenizer rejects with `TabError`. */
	const tabby = $derived(hasTabs(code));

	let formatting = $state(false);
	let formatError = $state<string | null>(null);
	/** Latched on a 503: the deployment has no `ruff`, so every further attempt
	 * would fail the same way. Latching disables the control instead of letting
	 * the user pump a dead endpoint. */
	let formatUnavailable = $state(false);
	let errorTimer: ReturnType<typeof setTimeout> | null = null;

	function flashError(message: string): void {
		formatError = message;
		if (errorTimer) clearTimeout(errorTimer);
		errorTimer = setTimeout(() => (formatError = null), 6000);
	}

	onDestroy(() => {
		if (errorTimer) clearTimeout(errorTimer);
	});

	/** Replace the whole document in ONE transaction, keeping the cursor on the
	 * same line number (clamped). One transaction, not two, so a reformat is a
	 * single undo step — hence computing the new offset from the incoming text
	 * (`lineStartOffset`) instead of reading it back off the new state. */
	function replaceDoc(next: string): void {
		if (!view) return;
		const cur = view.state.doc.toString();
		if (next === cur) return;
		const line = view.state.doc.lineAt(view.state.selection.main.head).number;
		const anchor = lineStartOffset(next, line);
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: next },
			selection: { anchor: Math.min(anchor, next.length) },
			scrollIntoView: true
		});
		view.focus();
	}

	/**
	 * Reformat the snippet: expand tabs locally, then let `ruff format` on the
	 * server do the real work.
	 *
	 * Tabs are expanded BEFORE the request because tab-indented Python is a
	 * `TabError` at parse time — ruff would refuse exactly the documents that
	 * most need formatting. And the expansion is applied even when the server
	 * refuses: that is the old "Fix indentation" button's job, which this
	 * control absorbed, and it must keep working when the snippet does not
	 * parse or the formatter is absent.
	 */
	async function reformat(): Promise<void> {
		if (!view || formatting || formatUnavailable) return;
		const before = view.state.doc.toString();
		const expanded = expandTabs(before);
		formatting = true;
		formatError = null;
		try {
			const out = await formatSnippet(expanded);
			if (out.changed || expanded !== before) replaceDoc(out.code);
		} catch (e) {
			if (e instanceof ApiError && e.status === 503) {
				formatUnavailable = true;
				flashError('Formatter unavailable on this server');
			} else {
				flashError(`Can't format: ${e instanceof Error ? e.message : 'unknown error'}`);
			}
			if (expanded !== before) replaceDoc(expanded);
		} finally {
			formatting = false;
		}
	}
```

Add the keybinding to the existing `Prec.highest` keymap so it shares that group's precedence:

```ts
						Prec.highest(
							keymap.of([
								{ key: 'Mod-Enter', run: () => (onRun(), true) },
								// VS Code's format shortcut. In the same Prec.highest group as
								// Mod-Enter so basicSetup's defaultKeymap cannot claim it first.
								{ key: 'Shift-Alt-f', run: () => (void reformat(), true) }
							])
						),
```

Replace the whole markup block with:

```svelte
<div class="group relative h-full">
	<div bind:this={host} class="h-full overflow-auto text-sm" data-testid="snippet-editor"></div>
	<!-- Editor-corner controls. Muted until the editor is hovered or focused so
	     they never compete with the code; the Reformat control carries a warning
	     tint while a tab character survives in the document, because that is the
	     state CPython rejects outright with TabError. -->
	<div
		class="pointer-events-none absolute top-1 right-3 z-10 flex items-center gap-1.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
	>
		{#if formatError}
			<span
				data-testid="snippet-format-error"
				class="pointer-events-auto max-w-[22rem] truncate rounded border border-destructive/40 bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive"
			>
				{formatError}
			</span>
		{/if}
		<button
			type="button"
			data-testid="snippet-format"
			class="pointer-events-auto rounded border px-1.5 py-0.5 text-[10px] shadow-sm transition-colors disabled:opacity-40 {tabby
				? 'border-warning/40 bg-warning/15 text-warning hover:bg-warning/25'
				: 'border-input bg-card/80 text-muted-foreground hover:bg-muted hover:text-foreground'}"
			title={tabby
				? `This snippet mixes tab and space indentation, which Python rejects. Reformat expands every tab to ${INDENT_WIDTH} spaces and reformats the rest (Shift+Alt+F).`
				: 'Reformat this snippet (Shift+Alt+F)'}
			disabled={formatting || formatUnavailable}
			onclick={() => void reformat()}
		>
			{formatting ? 'Formatting…' : 'Reformat'}
		</button>
	</div>
</div>
```

- [ ] **Step 9: Run the tests to verify they pass**

```sh
pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Snippet/__tests__/code-editor.test.ts'
```

Expected: PASS, including the pre-existing Mod-Enter test. If MSW does not intercept because `apiFetch` resolves a relative URL with no active project base, the request path is `/api/v1/snippets/format`; the `'*/snippets/format'` wildcard covers both that and the project-scoped form, so no change should be needed. If interception still fails, set the handler pattern to `'*/snippets/format'` on `http.post` and confirm `server.listen({ onUnhandledRequest: 'bypass' })` is in effect.

- [ ] **Step 10: Full frontend verification**

```sh
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
pixi run -e frontend bash -c 'cd frontend && npm run lint'
```

Expected: all pass. Confirm nothing still references `snippet-fix-indent`:

```sh
grep -rn 'snippet-fix-indent' frontend/src frontend/e2e || echo "clean"
```

- [ ] **Step 11: Verify in the running app**

With backend + frontend running: open a snippet tab, paste tab-indented Python, hover the editor → the Reformat chip is warning-tinted → click it → tabs become four spaces and the code is reformatted → Ctrl+Z restores the original in one step. Repeat inside a table script column to confirm the inline editors got it too.

- [ ] **Step 12: Commit**

```bash
git add frontend/src/lib/editor/format.ts frontend/src/lib/editor/__tests__/format.test.ts frontend/src/lib/api/types.ts frontend/src/lib/api/snippets.ts frontend/src/lib/components/Snippet/CodeEditor.svelte frontend/src/lib/components/Snippet/__tests__/code-editor.test.ts
git commit -m "feat(frontend/snippet): Reformat control that also sanitizes tabs"
```

---

## Task 7: Frontend docs + full verification

**Files:**
- Modify: `frontend/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Document the editor module additions**

In `frontend/README.md`'s file-map block (the section listing `editor/indent.ts`, `editor/theme.ts`, `editor/completion-source.ts`), add entries in the same two-column style the surrounding lines use:

```
    editor/editor-size.ts  Inline-editor height + snippet-tab split geometry and
                        their localStorage keys (ui.snippet.inlineEditorH /
                        ui.snippet.tabSplitRatio). Pure; the reactive wrapper is
                        state/editor-size.svelte.ts, which is GLOBAL per kind —
                        see its docstring for why per-instance memory cannot work
                        for navigation script steps.
    editor/search-panel.ts  Custom Ctrl+F panel (search({top,createPanel})) with a
                        capped live match counter. Presentation only — every
                        action delegates to @codemirror/search's commands; styled
                        via cm-dr-search* rules in editor/theme.ts.
    editor/format.ts    lineStartOffset() — cursor-line preservation for the
                        one-transaction reformat replacement.
```

- [ ] **Step 2: Document the Reformat flow**

Extend the existing sentence about `hasTabs()` gating the "Fix indentation" button (the `editor/indent.ts` entry in that same block) to say the button is gone:

```
    editor/indent.ts    Indentation policy — FOUR SPACES, never a tab, because
                        ... hasTabs() now tints the Reformat control (which
                        absorbed the old "Fix indentation" button) rather than
                        gating a separate one.
```

And add a short paragraph to the snippet-editor prose section:

> **Reformat.** `CodeEditor`'s corner control (`snippet-format`, `Shift+Alt+F`)
> expands tabs locally with `expandTabs` and then posts to
> `POST /snippets/format` (`ruff format`, `indent-width=4`). The document is
> replaced in ONE transaction so a reformat is a single undo step, with the
> cursor kept on the same line number. The local tab expansion is applied even
> when the server refuses (422 unparseable, 503 no ruff) — that is the old "Fix
> indentation" behaviour, which this control absorbed. A 503 latches the control
> disabled rather than letting the user pump a dead endpoint.

- [ ] **Step 3: Full verification across both stacks**

```sh
pixi run dr-tidy
pixi run core-test
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
```

Expected: ruff/mypy/pyright/prettier/eslint clean, pytest green, vitest green, svelte-check with no new errors. Paste the actual tail of each command's output into the task notes — do not claim green without it.

- [ ] **Step 4: Run the snippet e2e spec**

```sh
pixi run -e frontend bash -c 'cd frontend && npm run test:e2e -- snippet-flow.spec.ts'
```

Expected: PASS. This spec exercises the snippet workspace tab end to end (lint gutter, run, staging) and is the closest thing to a regression net for the tab's new split markup. If it fails on a selector this plan changed, fix the spec to match — but confirm first that the behaviour it asserts still works by hand.

- [ ] **Step 5: Commit**

```bash
git add frontend/README.md
git commit -m "docs(frontend): editor size stores, custom search panel, reformat flow"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 `editor-size.ts` pure module | Task 1 |
| §1 `state/editor-size.svelte.ts` store | Task 1 |
| §1 `ResizeHandle` `top`/`bottom` extension | Task 2 |
| §1 `SnippetSourceEditor` grip | Task 2 |
| §1 `SnippetTab` measured split | Task 3 |
| §2 `search-panel.ts` + `luxurySearch` | Task 4 |
| §2 counter with 1000 cap, invalid-regexp state | Task 4 (Steps 2, 4) |
| §2 `cm-dr-search*` styling in `theme.ts` | Task 4 (Step 6) |
| §3 `api/script_format.py` | Task 5 |
| §3 `POST /snippets/format`, 422/503, authz, size cap, setting, pixi dep | Task 5 |
| §3 frontend client + control + `Shift-Alt-F` + tab expansion + one-transaction replace | Task 6 |
| §4 vitest coverage (editor-size, search-panel, code-editor, snippet-source-editor) | Tasks 1, 2, 4, 6 |
| §4 pytest coverage | Task 5 (Step 2) |
| §4 Playwright untouched | Task 7 (Step 4 runs the existing spec as a regression net only) |
| §5 `frontend/README.md` | Task 7 |
| §5 `CLAUDE.md` | Task 5 (Step 10) |

No gaps. §4's "snippet-tab split" coverage is Task 3's new test file, which the spec did not name explicitly — an addition, not a deviation.

**Placeholder scan:** no TBD/TODO, every code step carries the literal code, and the two places where reality may differ from the plan (ruff's `--isolated`/`--config` combination in Task 5 Step 1; happy-dom's `PointerEvent`/counter-origin details in Task 2 Step 5 and Task 4 Step 5) name the exact fallback rather than saying "handle it".

**Type consistency:** `clampInlineHeight`/`clampSplitRatio`/`splitHeights`/`ratioFromPointer`/`loadInlineHeight`/`saveInlineHeight`/`loadSplitRatio`/`saveSplitRatio` are defined in Task 1 and used with those exact names in Tasks 2 and 3. `getInlineEditorHeight`/`setInlineEditorHeight`/`getSnippetSplitRatio`/`setSnippetSplitRatio`/`resetEditorSize` likewise. `luxurySearch` is defined in Task 4 Step 4 and consumed in Step 7. `FormatResult.changed`, `FormatSyntaxError`, `FormatUnavailable`, `FormatTimeout`, `format_code(code, *, timeout_s)`, `ruff_path`, `reset_ruff_path_cache`, `FORMAT_INDENT_WIDTH` are defined in Task 5 Step 4 and used in Steps 2, 7 with matching signatures. `SnippetFormatOut { code, changed }` is identical on both sides of the wire (Task 5 Step 6, Task 6 Step 5). `lineStartOffset(text, line)` is defined in Task 6 Step 3 and used in Step 8.
