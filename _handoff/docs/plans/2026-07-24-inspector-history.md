# Inspector Inspection History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back/forward navigation over the trail of elements the user inspects, with a long-press (or right-click) dropdown on each arrow listing up to 10 entries in that direction (Name + Stereotype + ellipsized id).

**Architecture:** A new in-memory state module (`inspection-history.svelte.ts`) holds a visit stack + cursor with browser semantics (new visit truncates the forward stack). Visits are captured by a one-line guarded hook inside `select()` — the single choke point all navigation paths already funnel through. A new `HistoryNav.svelte` cluster in the Inspector renders the two arrows; a reusable `longpress` Svelte action opens per-direction bits-ui dropdowns whose rows are resolved lazily from the existing lite caches.

**Tech Stack:** Svelte 5 runes, bits-ui DropdownMenu, lucide icons, vitest + happy-dom + MSW.

**Spec:** `docs/superpowers/specs/2026-07-24-inspector-history-design.md`

## Global Constraints

- All frontend commands run via pixi FROM INSIDE `frontend/`: `pixi run -e frontend bash -c 'cd frontend && <cmd>'`. The bare `pixi run -e frontend npm test` FAILS (runs from repo root).
- Elements only: relationship selections and `select(null)` never push history.
- In-memory only: no localStorage. History resets on project open.
- Stack cap: **50** entries. Dropdown shows at most **10** per direction, nearest first.
- Long-press duration: **500 ms**; move tolerance **6 px**.
- State-folder conventions: module-private `$state`, accessor functions only (never exported live bindings), a `reset*()` for tests, re-export from `state/index.ts`.
- Work on a feature branch (e.g. `feat/inspector-history`), created at execution start (superpowers:using-git-worktrees).
- Commit messages follow the repo style seen in `git log`: `feat(frontend/...): ...`, `test(frontend/...): ...`.

---

### Task 1: `inspection-history.svelte.ts` state module

**Files:**
- Create: `frontend/src/lib/state/inspection-history.svelte.ts`
- Test: `frontend/src/lib/state/__tests__/inspection-history.test.ts`

**Interfaces:**
- Consumes: `select` from `./selection.svelte` (existing: `select(s: {kind:'element'|'relationship'; id:string} | null): void`).
- Produces (used by Tasks 2 and 4):
  - `pushVisit(id: string): void`
  - `canGoBack(): boolean` / `canGoForward(): boolean`
  - `goBack(): void` / `goForward(): void` / `goToVisit(index: number): void`
  - `backEntries(limit?: number): VisitMenuEntry[]` / `forwardEntries(limit?: number): VisitMenuEntry[]` where `VisitMenuEntry = { index: number; entry: VisitEntry }` and `VisitEntry = { id: string; name?: string; type_name?: string }`
  - `noteResolved(id: string, name: string, type_name: string): void`
  - `remapVisitIds(idMap: Record<string, string>): void`
  - `resetInspectionHistory(): void`
  - `getVisitStack(): readonly VisitEntry[]` / `getVisitCursor(): number` (test/introspection accessors)

Note: `history.svelte.ts` already exists (commit-history browser) — this module is deliberately named `inspection-history.svelte.ts`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/inspection-history.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { clearSelection, getSelection } from '../selection.svelte';
import {
	backEntries,
	canGoBack,
	canGoForward,
	forwardEntries,
	getVisitCursor,
	getVisitStack,
	goBack,
	goForward,
	goToVisit,
	noteResolved,
	pushVisit,
	remapVisitIds,
	resetInspectionHistory
} from '../inspection-history.svelte';

beforeEach(() => {
	resetInspectionHistory();
	clearSelection();
});

describe('visit stack', () => {
	it('starts empty: neither direction available', () => {
		expect(getVisitStack()).toEqual([]);
		expect(getVisitCursor()).toBe(-1);
		expect(canGoBack()).toBe(false);
		expect(canGoForward()).toBe(false);
	});

	it('pushVisit appends and advances the cursor', () => {
		pushVisit('a');
		pushVisit('b');
		expect(getVisitStack().map((e) => e.id)).toEqual(['a', 'b']);
		expect(getVisitCursor()).toBe(1);
		expect(canGoBack()).toBe(true);
		expect(canGoForward()).toBe(false);
	});

	it('dedupes a consecutive re-visit of the current entry', () => {
		pushVisit('a');
		pushVisit('a');
		expect(getVisitStack()).toHaveLength(1);
	});

	it('a new visit truncates the forward stack (browser semantics)', () => {
		pushVisit('a');
		pushVisit('b');
		pushVisit('c');
		goBack(); // cursor -> b
		goBack(); // cursor -> a
		pushVisit('d');
		expect(getVisitStack().map((e) => e.id)).toEqual(['a', 'd']);
		expect(getVisitCursor()).toBe(1);
		expect(canGoForward()).toBe(false);
	});

	it('caps the stack at 50, dropping the oldest', () => {
		for (let i = 0; i < 55; i++) pushVisit(`e${i}`);
		expect(getVisitStack()).toHaveLength(50);
		expect(getVisitStack()[0].id).toBe('e5');
		expect(getVisitCursor()).toBe(49);
	});
});

describe('navigation', () => {
	it('goBack/goForward move the cursor and select the entry', () => {
		pushVisit('a');
		pushVisit('b');
		goBack();
		expect(getVisitCursor()).toBe(0);
		expect(getSelection()).toEqual({ kind: 'element', id: 'a' });
		expect(canGoForward()).toBe(true);
		goForward();
		expect(getVisitCursor()).toBe(1);
		expect(getSelection()).toEqual({ kind: 'element', id: 'b' });
	});

	it('goToVisit jumps to an absolute index', () => {
		pushVisit('a');
		pushVisit('b');
		pushVisit('c');
		goToVisit(0);
		expect(getVisitCursor()).toBe(0);
		expect(getSelection()).toEqual({ kind: 'element', id: 'a' });
	});

	it('goBack/goForward/goToVisit are no-ops out of range', () => {
		pushVisit('a');
		goBack();
		goForward();
		goToVisit(5);
		goToVisit(-1);
		expect(getVisitCursor()).toBe(0);
		expect(getVisitStack()).toHaveLength(1);
	});
});

describe('dropdown slices', () => {
	it('backEntries/forwardEntries are nearest-first with absolute indices', () => {
		for (const id of ['a', 'b', 'c', 'd', 'e']) pushVisit(id);
		goBack();
		goBack(); // cursor at 'c' (index 2)
		expect(backEntries().map((x) => [x.index, x.entry.id])).toEqual([
			[1, 'b'],
			[0, 'a']
		]);
		expect(forwardEntries().map((x) => [x.index, x.entry.id])).toEqual([
			[3, 'd'],
			[4, 'e']
		]);
	});

	it('slices honor the 10-entry limit', () => {
		for (let i = 0; i < 15; i++) pushVisit(`e${i}`);
		expect(backEntries()).toHaveLength(10);
		expect(backEntries(3)).toHaveLength(3);
	});
});

describe('metadata', () => {
	it('noteResolved stamps last-known display data onto matching entries', () => {
		pushVisit('a');
		pushVisit('b');
		noteResolved('a', 'Pump A', 'Pump');
		expect(getVisitStack()[0]).toEqual({ id: 'a', name: 'Pump A', type_name: 'Pump' });
		expect(getVisitStack()[1]).toEqual({ id: 'b' });
	});

	it('remapVisitIds rewrites mapped ids and leaves the rest', () => {
		pushVisit('tmp1');
		pushVisit('x');
		remapVisitIds({ tmp1: 'real1' });
		expect(getVisitStack().map((e) => e.id)).toEqual(['real1', 'x']);
	});

	it('resetInspectionHistory clears everything', () => {
		pushVisit('a');
		resetInspectionHistory();
		expect(getVisitStack()).toEqual([]);
		expect(getVisitCursor()).toBe(-1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/inspection-history.test.ts'`
Expected: FAIL — cannot resolve `../inspection-history.svelte`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/state/inspection-history.svelte.ts`:

```ts
import { select } from './selection.svelte';

// The Inspector's back/forward visit trail. In-memory only (resets on project
// open / page reload). Entries are pushed with only the id — at select() time
// the element may not be fetched yet; display data is stamped on lazily by the
// dropdown via noteResolved(). `history.svelte.ts` is the commit-history
// browser; this module is the INSPECTION history.
export type VisitEntry = { id: string; name?: string; type_name?: string };
export type VisitMenuEntry = { index: number; entry: VisitEntry };

const STACK_MAX = 50;

let _stack: VisitEntry[] = $state([]);
let _cursor = $state(-1); // index of the current entry; -1 = empty

// Re-entrancy guard: goBack/goForward/goToVisit call select(), which calls
// pushVisit() (the selection choke-point hook) — the guard makes that inner
// push a no-op so replaying history never mutates it.
let _navigating = false;

export function getVisitStack(): readonly VisitEntry[] {
	return _stack;
}

export function getVisitCursor(): number {
	return _cursor;
}

export function pushVisit(id: string): void {
	if (_navigating) return;
	// Consecutive dedup. Also absorbs applyDelta's post-commit selection
	// re-point: remapVisitIds() runs first, so the re-selected canonical id
	// already sits at the cursor.
	if (_stack[_cursor]?.id === id) return;
	_stack = [..._stack.slice(0, _cursor + 1), { id }];
	if (_stack.length > STACK_MAX) _stack = _stack.slice(_stack.length - STACK_MAX);
	_cursor = _stack.length - 1;
}

export function canGoBack(): boolean {
	return _cursor > 0;
}

export function canGoForward(): boolean {
	return _cursor >= 0 && _cursor < _stack.length - 1;
}

function navigateTo(index: number): void {
	if (index < 0 || index >= _stack.length) return;
	_cursor = index;
	_navigating = true;
	try {
		select({ kind: 'element', id: _stack[index].id });
	} finally {
		_navigating = false;
	}
}

export function goBack(): void {
	if (canGoBack()) navigateTo(_cursor - 1);
}

export function goForward(): void {
	if (canGoForward()) navigateTo(_cursor + 1);
}

export function goToVisit(index: number): void {
	navigateTo(index);
}

/** Up to `limit` entries strictly behind the cursor, nearest first. */
export function backEntries(limit = 10): VisitMenuEntry[] {
	const out: VisitMenuEntry[] = [];
	for (let i = _cursor - 1; i >= 0 && out.length < limit; i--) {
		out.push({ index: i, entry: _stack[i] });
	}
	return out;
}

/** Up to `limit` entries strictly ahead of the cursor, nearest first. */
export function forwardEntries(limit = 10): VisitMenuEntry[] {
	const out: VisitMenuEntry[] = [];
	for (let i = _cursor + 1; i < _stack.length && out.length < limit; i++) {
		out.push({ index: i, entry: _stack[i] });
	}
	return out;
}

/** Stamp last-known display data onto every entry for `id` (dropdown
 * write-back), so a later-deleted element keeps its last-known label. */
export function noteResolved(id: string, name: string, type_name: string): void {
	for (const e of _stack) {
		if (e.id === id) {
			e.name = name;
			e.type_name = type_name;
		}
	}
}

/** Rewrite entry ids through a commit's temp→canonical id_map. MUST be called
 * BEFORE applyDelta's selection re-point so the re-point's pushVisit dedups
 * instead of appending a duplicate entry. */
export function remapVisitIds(idMap: Record<string, string>): void {
	for (const e of _stack) {
		const mapped = idMap[e.id];
		if (mapped !== undefined) e.id = mapped;
	}
}

export function resetInspectionHistory(): void {
	_stack = [];
	_cursor = -1;
	_navigating = false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/inspection-history.test.ts'`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/inspection-history.svelte.ts frontend/src/lib/state/__tests__/inspection-history.test.ts
git commit -m "feat(frontend/state): inspection-history visit stack with browser semantics"
```

---

### Task 2: Capture hook, commit remap, project-open reset, barrel exports

**Files:**
- Modify: `frontend/src/lib/state/selection.svelte.ts` (add hook in `select()`)
- Modify: `frontend/src/lib/state/model.svelte.ts:367-376` (remap call in `applyDelta`)
- Modify: `frontend/src/lib/state/index.ts` (barrel exports)
- Modify: `frontend/src/routes/p/[projectId]/+page.svelte:66-71` (reset on project mount)
- Test: `frontend/src/lib/state/__tests__/inspection-history.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `pushVisit`, `remapVisitIds`, `resetInspectionHistory`, plus existing `select`, `applyDelta`, `initWorkspaceTabs`.
- Produces: every `select({kind:'element', id})` anywhere in the app now records a visit; the barrel re-exports the Task 1 API so components can import from `$lib/state`.

Note on the module cycle: selection → inspection-history → selection is a real ES-module cycle, but all cross-references are call-time (function bodies), not module-init-time, so it is benign under Vite/vitest. If it ever bites, invert with a registered callback (see spec) — do NOT eagerly restructure now.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/state/__tests__/inspection-history.test.ts` (add `select` to the existing `../selection.svelte` import):

```ts
describe('capture via select()', () => {
	it('selecting an element pushes a visit', () => {
		select({ kind: 'element', id: 'a' });
		select({ kind: 'element', id: 'b' });
		expect(getVisitStack().map((e) => e.id)).toEqual(['a', 'b']);
	});

	it('relationship selections and deselects do not push', () => {
		select({ kind: 'element', id: 'a' });
		select({ kind: 'relationship', id: 'r1' });
		select(null);
		expect(getVisitStack().map((e) => e.id)).toEqual(['a']);
	});

	it('re-selecting the current element does not push', () => {
		select({ kind: 'element', id: 'a' });
		select({ kind: 'element', id: 'a' });
		expect(getVisitStack()).toHaveLength(1);
	});

	it('goBack replays selection without re-pushing (re-entrancy guard)', () => {
		select({ kind: 'element', id: 'a' });
		select({ kind: 'element', id: 'b' });
		goBack();
		expect(getSelection()).toEqual({ kind: 'element', id: 'a' });
		expect(getVisitStack().map((e) => e.id)).toEqual(['a', 'b']);
		expect(getVisitCursor()).toBe(0);
	});

	it('commit remap + selection re-point dedups instead of duplicating', () => {
		// Mirrors applyDelta's ordering contract: remapVisitIds() first, then
		// the selection re-point through select().
		select({ kind: 'element', id: 'tmp1' });
		remapVisitIds({ tmp1: 'real1' });
		select({ kind: 'element', id: 'real1' });
		expect(getVisitStack().map((e) => e.id)).toEqual(['real1']);
		expect(getVisitCursor()).toBe(0);
	});
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/inspection-history.test.ts'`
Expected: the three push-capture tests FAIL (`select()` does not push yet); the Task 1 tests still PASS.

- [ ] **Step 3: Add the hook in `select()`**

In `frontend/src/lib/state/selection.svelte.ts`, add the import and change `select`:

```ts
import { pushVisit } from './inspection-history.svelte';
```

```ts
export function select(s: Selection): void {
	_selection = s;
	// Every element selection is an inspection "visit", recorded at this one
	// choke point so all navigation paths (tree, search, palette, graph,
	// endpoint links, table cells) feed the Inspector's back/forward history.
	// Replays from goBack/goForward are guarded inside pushVisit.
	if (s !== null && s.kind === 'element') pushVisit(s.id);
}
```

- [ ] **Step 4: Wire the commit remap in `applyDelta`**

In `frontend/src/lib/state/model.svelte.ts`, add to the imports from sibling modules:

```ts
import { remapVisitIds } from './inspection-history.svelte';
```

and in `applyDelta` (currently lines 367-376), add the call BEFORE the selection re-point:

```ts
	if (Object.keys(d.id_map).length > 0) {
		remapCaches(d.id_map);
		// Rewrite the inspection history BEFORE the selection re-point below:
		// the re-point goes through select(), whose pushVisit then finds the
		// canonical id already at the cursor and dedups (no duplicate entry).
		remapVisitIds(d.id_map);
		// keep the global selection pointing at the same entity across the
		// temp-id -> canonical-id rename (the old architecture kept temp ids
		// alive until file save; the delta protocol renames on first flush ack)
		const sel = getSelection();
		if (sel !== null && d.id_map[sel.id] !== undefined) {
			select({ kind: sel.kind, id: d.id_map[sel.id] });
		}
	}
```

- [ ] **Step 5: Barrel exports**

In `frontend/src/lib/state/index.ts`, add (alphabetically near the existing `./history.svelte` block):

```ts
export {
	backEntries,
	canGoBack,
	canGoForward,
	forwardEntries,
	getVisitCursor,
	getVisitStack,
	goBack,
	goForward,
	goToVisit,
	noteResolved,
	pushVisit,
	remapVisitIds,
	resetInspectionHistory,
	type VisitEntry,
	type VisitMenuEntry
} from './inspection-history.svelte';
```

- [ ] **Step 6: Reset on project open**

In `frontend/src/routes/p/[projectId]/+page.svelte`: add `resetInspectionHistory` to the `$lib/state` import list (alphabetical position, after `refreshView`), and extend the existing mount hook (lines 66-71):

```ts
	onMount(() => {
		// setActiveProject(params.projectId) already ran in +layout.ts's load,
		// so the active id is set before this mount fires.
		const pid = getActiveProjectId();
		if (pid) initWorkspaceTabs(pid);
		// The visit trail is per-project and in-memory: opening a project
		// (including switching projects) starts it fresh.
		resetInspectionHistory();
	});
```

- [ ] **Step 7: Run the full test file + whole suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/inspection-history.test.ts'`
Expected: PASS.

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'`
Expected: PASS. Watch specifically for regressions in existing suites that call `select()` (inspector, tree, search, table tests) — if one fails because history state leaks between tests, that suite's `beforeEach` does not need editing: the leak would be within a single test file via the module-level stack, which is fine for suites that never read history. Only if a suite asserts on selection push side effects should you add `resetInspectionHistory()` to ITS `beforeEach` — expected: none do.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/state/selection.svelte.ts frontend/src/lib/state/model.svelte.ts frontend/src/lib/state/index.ts frontend/src/routes/p/\[projectId\]/+page.svelte frontend/src/lib/state/__tests__/inspection-history.test.ts
git commit -m "feat(frontend/state): capture inspection visits at the select() choke point"
```

---

### Task 3: `longpress` Svelte action

**Files:**
- Create: `frontend/src/lib/util/long-press.ts`
- Test: `frontend/src/lib/util/__tests__/long-press.test.ts`

**Interfaces:**
- Consumes: nothing project-specific (pure DOM).
- Produces: `longpress(node: HTMLElement, options: LongPressOptions)` action with `LongPressOptions = { onLongPress: () => void; durationMs?: number; moveTolerancePx?: number }` (defaults 500 ms / 6 px). Contract: holds ≥ duration without moving → `onLongPress()` fires and the NEXT click on the node is suppressed (capture-phase `preventDefault` + `stopImmediatePropagation`, which also defeats Svelte's delegated `onclick`); `contextmenu` fires `onLongPress()` immediately and prevents the native menu; release/move-beyond-tolerance/leave/cancel before the deadline → normal click.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/util/__tests__/long-press.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { longpress } from '../long-press';

function pointerDown(node: HTMLElement, x = 10, y = 10) {
	node.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, clientX: x, clientY: y, bubbles: true })
	);
}

describe('longpress action', () => {
	let node: HTMLButtonElement;
	let onLongPress: ReturnType<typeof vi.fn>;
	let action: ReturnType<typeof longpress>;

	beforeEach(() => {
		vi.useFakeTimers();
		node = document.createElement('button');
		document.body.appendChild(node);
		onLongPress = vi.fn();
		action = longpress(node, { onLongPress });
	});

	afterEach(() => {
		action.destroy();
		node.remove();
		vi.useRealTimers();
	});

	it('fires after 500ms hold and suppresses the following click', () => {
		const clicked = vi.fn();
		node.addEventListener('click', clicked);
		pointerDown(node);
		vi.advanceTimersByTime(500);
		expect(onLongPress).toHaveBeenCalledOnce();
		node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(clicked).not.toHaveBeenCalled();
	});

	it('a quick tap does not fire and does not suppress the click', () => {
		const clicked = vi.fn();
		node.addEventListener('click', clicked);
		pointerDown(node);
		vi.advanceTimersByTime(200);
		node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		vi.advanceTimersByTime(1000);
		node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		expect(onLongPress).not.toHaveBeenCalled();
		expect(clicked).toHaveBeenCalledOnce();
	});

	it('moving beyond the tolerance cancels the press', () => {
		pointerDown(node, 10, 10);
		node.dispatchEvent(
			new PointerEvent('pointermove', { clientX: 30, clientY: 10, bubbles: true })
		);
		vi.advanceTimersByTime(1000);
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('pointerleave cancels the press', () => {
		pointerDown(node);
		node.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
		vi.advanceTimersByTime(1000);
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('contextmenu fires immediately and prevents the native menu', () => {
		const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		node.dispatchEvent(e);
		expect(onLongPress).toHaveBeenCalledOnce();
		expect(e.defaultPrevented).toBe(true);
	});

	it('non-primary buttons are ignored', () => {
		node.dispatchEvent(
			new PointerEvent('pointerdown', { button: 2, clientX: 10, clientY: 10, bubbles: true })
		);
		vi.advanceTimersByTime(1000);
		expect(onLongPress).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/util/__tests__/long-press.test.ts'`
Expected: FAIL — cannot resolve `../long-press`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/util/long-press.ts`:

```ts
// Svelte action for a press-and-hold gesture. A primary-button pointer held
// `durationMs` without moving past `moveTolerancePx` fires `onLongPress`, and
// the click that follows the release is suppressed at capture phase
// (preventDefault + stopImmediatePropagation — the latter also defeats
// Svelte's root-delegated onclick handlers) so the node's normal click action
// does not also run. `contextmenu` (right-click / long-press on some touch
// platforms) fires immediately, replacing the native menu.
export type LongPressOptions = {
	onLongPress: () => void;
	durationMs?: number;
	moveTolerancePx?: number;
};

export function longpress(node: HTMLElement, options: LongPressOptions) {
	let opts = options;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let fired = false;
	let startX = 0;
	let startY = 0;

	const cancel = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0) return; // primary only; right-click goes via contextmenu
		fired = false;
		startX = e.clientX;
		startY = e.clientY;
		cancel();
		timer = setTimeout(() => {
			timer = null;
			fired = true;
			opts.onLongPress();
		}, opts.durationMs ?? 500);
	};

	const onPointerMove = (e: PointerEvent) => {
		if (timer === null) return;
		const tol = opts.moveTolerancePx ?? 6;
		if (Math.abs(e.clientX - startX) > tol || Math.abs(e.clientY - startY) > tol) cancel();
	};

	const onPointerEnd = () => cancel();

	const onClickCapture = (e: MouseEvent) => {
		if (!fired) return;
		fired = false;
		e.preventDefault();
		e.stopImmediatePropagation();
	};

	const onContextMenu = (e: MouseEvent) => {
		e.preventDefault();
		cancel();
		opts.onLongPress();
	};

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('pointermove', onPointerMove);
	node.addEventListener('pointerup', onPointerEnd);
	node.addEventListener('pointerleave', onPointerEnd);
	node.addEventListener('pointercancel', onPointerEnd);
	node.addEventListener('click', onClickCapture, true);
	node.addEventListener('contextmenu', onContextMenu);

	return {
		update(next: LongPressOptions) {
			opts = next;
		},
		destroy() {
			cancel();
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointermove', onPointerMove);
			node.removeEventListener('pointerup', onPointerEnd);
			node.removeEventListener('pointerleave', onPointerEnd);
			node.removeEventListener('pointercancel', onPointerEnd);
			node.removeEventListener('click', onClickCapture, true);
			node.removeEventListener('contextmenu', onContextMenu);
		}
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/util/__tests__/long-press.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/util/long-press.ts frontend/src/lib/util/__tests__/long-press.test.ts
git commit -m "feat(frontend/util): reusable longpress action (hold-500ms / contextmenu)"
```

---

### Task 4: `HistoryNav.svelte` + Inspector integration

**Files:**
- Create: `frontend/src/lib/components/Inspector/HistoryNav.svelte`
- Modify: `frontend/src/lib/components/Inspector.svelte` (render `<HistoryNav />` in all states)
- Test: `frontend/src/lib/components/__tests__/inspector-history-nav.test.ts`

**Interfaces:**
- Consumes: Task 1/2 state API via `$lib/state` (`backEntries`, `canGoBack`, `canGoForward`, `forwardEntries`, `goBack`, `goForward`, `goToVisit`, `noteResolved`, type `VisitMenuEntry`) plus existing `getTreeElements`, `getStagedNameOverride` (already barrel-exported); Task 3's `longpress` from `$lib/util/long-press`; `elementDisplayName` from `$lib/util/element-name`; `buttonVariants` from `$lib/components/ui/button`; `* as DropdownMenu` from `$lib/components/ui/dropdown-menu`; `ChevronLeft`/`ChevronRight` from `@lucide/svelte`; `cn` from `$lib/utils.js`.
- Produces: `<HistoryNav />` (no props) — testids `inspector-history-back`, `inspector-history-forward`, `inspector-history-entry-<absolute stack index>`.

Implementation notes that are load-bearing:
- **Plain `<button>` + `buttonVariants`, not the `Button` component** — `use:longpress` is a Svelte action and actions only work on DOM elements.
- **Controlled dropdowns** (`bind:open` on `DropdownMenu.Root`, which the local wrapper supports). The trigger uses the `child` snippet and spreads bits-ui's `{...props}` FIRST, then overrides `onclick`/`onpointerdown`/`onkeydown` AFTER the spread so bits-ui's own open-on-click/pointerdown/keydown toggles are disabled — the menu opens ONLY via the action setting `open = true`. The spread still wires the aria attributes and the anchor id the Content positions against.
- **Row resolution happens in the open handler, NOT in `$derived`** — `noteResolved` mutates `$state`, and mutating state inside a derived throws Svelte's `state_unsafe_mutation`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/__tests__/inspector-history-nav.test.ts` (boilerplate mirrors `inspector-stereotype.test.ts`):

```ts
import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { server } from '../../api/__tests__/server';
import { resetModelStore, seedElements, setModelApiConfig } from '../../state/model.svelte';
import { resetInspectionHistory } from '../../state/inspection-history.svelte';
import { clearSelection, getSelection, select } from '../../state/selection.svelte';
import Inspector from '../Inspector.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setModelApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	server.resetHandlers();
	clearSelection();
	vi.useRealTimers();
});
afterAll(() => {
	setModelApiConfig(undefined);
	server.close();
});
beforeEach(() => {
	resetModelStore();
	resetInspectionHistory();
	clearSelection();
	server.use(
		http.get(`*/model/elements/:id/relationships`, () => HttpResponse.json({ items: [], total: 0 }))
	);
	seedElements([
		{ id: 'e1', type_name: 'Pump', properties: { name: 'P-101' }, rev: 1 },
		{ id: 'e2', type_name: 'Tank', properties: { name: 'T-200' }, rev: 1 }
	]);
});

function backButton(): HTMLButtonElement {
	return document.querySelector('[data-testid="inspector-history-back"]') as HTMLButtonElement;
}
function forwardButton(): HTMLButtonElement {
	return document.querySelector('[data-testid="inspector-history-forward"]') as HTMLButtonElement;
}

it('arrows render in every state and disable without history', () => {
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		// no selection at all — the cluster still renders
		expect(backButton()).not.toBeNull();
		expect(backButton().disabled).toBe(true);
		expect(forwardButton().disabled).toBe(true);
	} finally {
		unmount(component);
	}
});

it('click-Back returns to the previous element and enables Forward', () => {
	select({ kind: 'element', id: 'e1' });
	select({ kind: 'element', id: 'e2' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		expect(backButton().disabled).toBe(false);
		expect(forwardButton().disabled).toBe(true);
		backButton().click();
		flushSync();
		expect(getSelection()).toEqual({ kind: 'element', id: 'e1' });
		expect(forwardButton().disabled).toBe(false);
		forwardButton().click();
		flushSync();
		expect(getSelection()).toEqual({ kind: 'element', id: 'e2' });
	} finally {
		unmount(component);
	}
});

it('long-press Back opens a dropdown with Name + Stereotype + id; picking jumps', () => {
	vi.useFakeTimers();
	select({ kind: 'element', id: 'e1' });
	select({ kind: 'element', id: 'e2' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		backButton().dispatchEvent(
			new PointerEvent('pointerdown', { button: 0, clientX: 5, clientY: 5, bubbles: true })
		);
		vi.advanceTimersByTime(600);
		flushSync();
		const entry = document.querySelector('[data-testid="inspector-history-entry-0"]');
		expect(entry).not.toBeNull();
		expect(entry?.textContent).toContain('P-101');
		expect(entry?.textContent).toContain('Pump');
		expect(entry?.textContent).toContain('e1');
		(entry as HTMLElement).click();
		flushSync();
		expect(getSelection()).toEqual({ kind: 'element', id: 'e1' });
	} finally {
		unmount(component);
		vi.useRealTimers();
	}
});

it('right-click (contextmenu) also opens the dropdown', () => {
	select({ kind: 'element', id: 'e1' });
	select({ kind: 'element', id: 'e2' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		backButton().dispatchEvent(
			new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
		);
		flushSync();
		expect(document.querySelector('[data-testid="inspector-history-entry-0"]')).not.toBeNull();
	} finally {
		unmount(component);
	}
});

it('an entry whose element is unknown falls back to its bare id', () => {
	// e3 is never cached and the fetch 404s -> row shows the id as its label.
	server.use(
		http.get(`*/model/elements/e3`, () => new HttpResponse(null, { status: 404 }))
	);
	select({ kind: 'element', id: 'e3' });
	select({ kind: 'element', id: 'e2' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		backButton().dispatchEvent(
			new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
		);
		flushSync();
		const entry = document.querySelector('[data-testid="inspector-history-entry-0"]');
		expect(entry?.textContent).toContain('e3');
	} finally {
		unmount(component);
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/__tests__/inspector-history-nav.test.ts'`
Expected: FAIL — `[data-testid="inspector-history-back"]` not found (HistoryNav does not exist).

- [ ] **Step 3: Implement `HistoryNav.svelte`**

Create `frontend/src/lib/components/Inspector/HistoryNav.svelte`:

```svelte
<script lang="ts">
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';

	import { buttonVariants } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		backEntries,
		canGoBack,
		canGoForward,
		forwardEntries,
		getStagedNameOverride,
		getTreeElements,
		goBack,
		goForward,
		goToVisit,
		noteResolved,
		type VisitMenuEntry
	} from '$lib/state';
	import { elementDisplayName } from '$lib/util/element-name';
	import { longpress } from '$lib/util/long-press';
	import { cn } from '$lib/utils.js';

	type Row = { index: number; id: string; name: string; type_name: string | undefined };

	let backOpen = $state(false);
	let forwardOpen = $state(false);
	let backRows: Row[] = $state([]);
	let forwardRows: Row[] = $state([]);

	// Rows are resolved ONCE, when the menu opens (not in $derived: the
	// noteResolved write-back mutates $state, which a derived must not do).
	// Resolution order: staged rename > lite/full cache > the entry's
	// last-known label > bare id — so a later-deleted element keeps showing
	// its last-known name.
	function resolveRows(entries: VisitMenuEntry[]): Row[] {
		const cache = getTreeElements();
		return entries.map(({ index, entry }) => {
			const el = cache.get(entry.id);
			const staged = getStagedNameOverride(entry.id);
			const liveName = staged ?? (el ? elementDisplayName(el) : undefined);
			const liveType = el?.type_name;
			if (liveName !== undefined && liveType !== undefined) {
				noteResolved(entry.id, liveName, liveType);
			}
			return {
				index,
				id: entry.id,
				name: liveName ?? entry.name ?? entry.id,
				type_name: liveType ?? entry.type_name
			};
		});
	}

	function openBackMenu() {
		if (!canGoBack()) return;
		backRows = resolveRows(backEntries());
		backOpen = true;
	}

	function openForwardMenu() {
		if (!canGoForward()) return;
		forwardRows = resolveRows(forwardEntries());
		forwardOpen = true;
	}
</script>

{#snippet entryItem(row: Row)}
	<DropdownMenu.Item
		data-testid={`inspector-history-entry-${row.index}`}
		class="flex flex-col items-start gap-0.5"
		onclick={() => goToVisit(row.index)}
	>
		<span class="flex w-full items-baseline gap-2">
			<span class="min-w-0 truncate">{row.name}</span>
			{#if row.type_name}
				<span class="ml-auto shrink-0 text-xs text-muted-foreground">{row.type_name}</span>
			{/if}
		</span>
		<span class="w-full truncate font-mono text-[10px] text-muted-foreground/70">{row.id}</span>
	</DropdownMenu.Item>
{/snippet}

<div class="flex items-center gap-0.5 border-b border-border px-2 py-1">
	<DropdownMenu.Root bind:open={backOpen}>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<!-- Spread first, override after: bits-ui's own open-toggle
				     handlers are replaced so the menu opens ONLY via longpress /
				     contextmenu; plain click navigates. Plain <button> because
				     use:longpress is an action (DOM elements only). -->
				<button
					{...props}
					type="button"
					class={cn(buttonVariants({ variant: 'ghost', size: 'icon-xs' }))}
					data-testid="inspector-history-back"
					aria-label="Back"
					title="Back — hold or right-click for history"
					disabled={!canGoBack()}
					onclick={() => goBack()}
					onpointerdown={undefined}
					onkeydown={undefined}
					use:longpress={{ onLongPress: openBackMenu }}
				>
					<ChevronLeft />
				</button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="w-64">
			{#each backRows as row (row.index)}
				{@render entryItem(row)}
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
	<DropdownMenu.Root bind:open={forwardOpen}>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					class={cn(buttonVariants({ variant: 'ghost', size: 'icon-xs' }))}
					data-testid="inspector-history-forward"
					aria-label="Forward"
					title="Forward — hold or right-click for history"
					disabled={!canGoForward()}
					onclick={() => goForward()}
					onpointerdown={undefined}
					onkeydown={undefined}
					use:longpress={{ onLongPress: openForwardMenu }}
				>
					<ChevronRight />
				</button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="w-64">
			{#each forwardRows as row (row.index)}
				{@render entryItem(row)}
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>
```

- [ ] **Step 4: Mount it in the Inspector**

In `frontend/src/lib/components/Inspector.svelte`: add the import

```ts
	import HistoryNav from './Inspector/HistoryNav.svelte';
```

and render it as the FIRST child of the `<aside>` (before the `{#if selection === null}` block, so it is present in all four states — Back must keep working after a deselect):

```svelte
<aside
	data-testid="inspector"
	class="flex h-full flex-col overflow-hidden border-l border-border bg-background text-sm text-foreground/80"
>
	<HistoryNav />
	{#if selection === null}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/__tests__/inspector-history-nav.test.ts'`
Expected: PASS. Known risk spots if it does not:
- Menu items not in DOM after `flushSync()` → bits-ui may open on a microtask; try `await Promise.resolve(); flushSync();` (make the test `async`) before querying, or query by `[role="menuitem"]` to confirm the content mounted at all (precedent: `Table/__tests__/TableGrid.test.ts:560-573` clicks a real trigger and queries `[role="menuitem"]` under happy-dom).
- Menu opens on the plain click test → the `onpointerdown={undefined}`/`onclick` overrides are not winning over the spread; verify they appear AFTER `{...props}` in the markup.

- [ ] **Step 6: Run the existing Inspector suites for regressions**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/__tests__/'`
Expected: PASS — in particular `inspector-stereotype`, `inspector-loading`, `inspector-refetch` must not break from the new header row.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/Inspector/HistoryNav.svelte frontend/src/lib/components/Inspector.svelte frontend/src/lib/components/__tests__/inspector-history-nav.test.ts
git commit -m "feat(frontend/inspector): back/forward visit navigation with long-press history menus"
```

---

### Task 5: Docs, full verification, tidy

**Files:**
- Modify: `frontend/README.md` ("Where to find things" store list)

**Interfaces:**
- Consumes: everything above.
- Produces: green suite + docs; the branch is ready for review/merge.

- [ ] **Step 1: Document the new store**

In `frontend/README.md`, find the "Where to find things" store list (the block of one-liners around lines 465-535 describing each `state/*.svelte.ts` module) and add, next to the `history.svelte.ts` line:

```markdown
- `state/inspection-history.svelte.ts` — the Inspector's back/forward visit trail: in-memory stack + cursor (cap 50), pushed from `select()`, replayed with a re-entrancy guard; per-direction dropdown slices resolve labels lazily.
```

- [ ] **Step 2: Full frontend test suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'`
Expected: PASS (0 failures).

- [ ] **Step 3: Type/lint checks**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors, 0 warnings from svelte-check.

Run: `pixi run dr-tidy`
Expected: formatting/lint clean across frontend, core, backend (it may rewrite files — if it does, re-run the test suite, then include the rewrites in the commit).

- [ ] **Step 4: Commit**

```bash
git add frontend/README.md
git add -u
git commit -m "docs(frontend): document the inspection-history store"
```

---

## Self-review notes (already applied)

- Spec coverage: state module (Task 1), choke-point capture + remap-before-re-point + reset-on-open + barrel (Task 2), long-press action (Task 3), header cluster + controlled dropdowns + lazy label resolution + all-states rendering (Task 4), README line (Task 5). Out-of-scope items (shortcuts, persistence, relationship visits, pruning) have no tasks — by design.
- The spec names the remap function `remapIds`; the implementation name is `remapVisitIds` (barrel-safe, self-describing). Used consistently in Tasks 1/2/4.
- `noteResolved` mutating `$state` inside `$derived` would throw `state_unsafe_mutation` — Task 4 resolves rows in the open handlers instead; this constraint is stated where it matters.
- Deleted-entry navigation intentionally lands on the Inspector's existing "Selection not found" state; no extra code needed (covered by the e3-404 test in Task 4 only for label fallback).
