# Staged Elements Sidebar Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible "Staged elements" section to the sidebar listing every element touched by the staged-ops buffer (new/modified/deleted, badged), with click-to-select and a per-row cascade revert — making snippet-staged (and manual) uncommitted elements reachable and editable.

**Architecture:** A pure derivation module (`staged-rows.ts`) turns the existing `getStagedDiff()` output plus the element/tree-item caches into badge-annotated rows; a new `revertStagedForElement()` in the model store extends per-entity discard with a relationship-endpoint cascade; a new `StagedSection.svelte` renders the rows below the containment tree in `Sidebar.svelte`. No server changes, no new endpoints — display data for uncached rows reuses `ensureTreeItems`.

**Tech Stack:** SvelteKit / Svelte 5 runes, TypeScript, vitest (happy-dom), lucide icons, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-22-staged-elements-sidebar-section-design.md`

## Global Constraints

- All commands run through pixi; frontend npm scripts MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test'` (bare `pixi run -e frontend npm test` fails with "Missing script").
- Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`); reactive collections from `svelte/reactivity` where store state is involved — but plain `Map`/`Set` for ephemeral per-call computation scratch (add `// eslint-disable-next-line svelte/prefer-svelte-reactivity` where the linter complains, mirroring `getStagedDiff`).
- Never hardcode temp-id strings in tests — always `createTempId()` (the prefix is an implementation detail of `ops.ts`).
- Preserve the dense docstring style of `model.svelte.ts` — new functions get a *why*-focused docstring.
- Commit messages follow the repo convention: `feat(frontend): ...`, `test(frontend): ...`.
- Section copy (user-visible strings): header `Staged elements`, badges `new` / `edited` / `deleted`, revert tooltip `Revert staged changes`.

---

### Task 1: Pure row derivation (`staged-rows.ts`)

**Files:**
- Create: `frontend/src/lib/state/staged-rows.ts`
- Modify: `frontend/src/lib/state/index.ts` (add export block)
- Test: `frontend/src/lib/state/__tests__/staged-rows.test.ts`

**Interfaces:**
- Consumes: `Diff` / `EntityDiff` from `./diff`, `isTempId` from `./ops`, `elementDisplayName` from `$lib/util/element-name`, `Element` / `TreeItem` from `$lib/api/types`.
- Produces (used by Task 3):
  - `type StagedRowStatus = 'new' | 'modified' | 'deleted'`
  - `interface StagedElementRow { id: string; status: StagedRowStatus; displayName: string; typeName: string | null }`
  - `function deriveStagedElementRows(diff: Diff, elements: ReadonlyMap<string, Element>, treeItems: ReadonlyMap<string, TreeItem>): StagedElementRow[]`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/staged-rows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Element, Relationship, TreeItem } from '$lib/api/types';
import type { Diff, EntityDiff } from '../diff';
import { createTempId } from '../ops';
import { deriveStagedElementRows } from '../staged-rows';

const el = (id: string, name: string, type = 'Device'): Element => ({
	id,
	type_name: type,
	properties: { name },
	rev: 1
});

const rel = (id: string, source: string, target: string): Relationship => ({
	id,
	type_name: 'Owns',
	source_id: source,
	target_id: target,
	properties: {},
	rev: 1
});

const lite = (id: string, display: string, type = 'Device'): TreeItem => ({
	id,
	type_name: type,
	display_name: display,
	child_count: 0
});

const diff = (elements: EntityDiff[], relationships: EntityDiff[] = []): Diff => ({
	elements,
	relationships,
	counts: { added: 0, modified: 0, deleted: 0 }
});

const none = new Map<string, Element>();
const noLite = new Map<string, TreeItem>();

describe('deriveStagedElementRows', () => {
	it('maps added/modified/deleted element diffs to badged rows', () => {
		const tmp = createTempId();
		const cache = new Map([
			[tmp, el(tmp, 'Fresh')],
			['e1', el('e1', 'Edited')]
		]);
		const rows = deriveStagedElementRows(
			diff([
				{ id: tmp, status: 'added', after: cache.get(tmp) },
				{ id: 'e1', status: 'modified', before: el('e1', 'Old'), after: cache.get('e1') },
				{ id: 'e2', status: 'deleted', before: el('e2', 'Gone', 'Sensor') }
			]),
			cache,
			noLite
		);
		expect(rows).toEqual([
			{ id: tmp, status: 'new', displayName: 'Fresh', typeName: 'Device' },
			{ id: 'e1', status: 'modified', displayName: 'Edited', typeName: 'Device' },
			{ id: 'e2', status: 'deleted', displayName: 'Gone', typeName: 'Sensor' }
		]);
	});

	it('omits a temp element deleted in the same buffer (net no-op)', () => {
		const tmp = createTempId();
		const rows = deriveStagedElementRows(
			diff([{ id: tmp, status: 'deleted', before: el(tmp, 'Ghost') }]),
			none,
			noLite
		);
		expect(rows).toEqual([]);
	});

	it('marks real endpoints of staged relationship changes as modified', () => {
		const tmpEl = createTempId();
		const tmpRel = createTempId();
		const cache = new Map([
			[tmpEl, el(tmpEl, 'Fresh')],
			['s1', el('s1', 'Source')]
		]);
		const rows = deriveStagedElementRows(
			diff(
				[{ id: tmpEl, status: 'added', after: cache.get(tmpEl) }],
				[{ id: tmpRel, status: 'added', after: rel(tmpRel, 's1', tmpEl) }]
			),
			cache,
			noLite
		);
		// s1 (real endpoint) becomes modified; tmpEl endpoint stays 'new'
		expect(rows).toEqual([
			{ id: tmpEl, status: 'new', displayName: 'Fresh', typeName: 'Device' },
			{ id: 's1', status: 'modified', displayName: 'Source', typeName: 'Device' }
		]);
	});

	it('endpoint rule never downgrades an existing deleted status', () => {
		const rows = deriveStagedElementRows(
			diff(
				[{ id: 'e1', status: 'deleted', before: el('e1', 'Gone') }],
				[{ id: 'r1', status: 'deleted', before: rel('r1', 'e1', 'e2') }]
			),
			none,
			noLite
		);
		expect(rows).toEqual([
			{ id: 'e2', status: 'modified', displayName: 'e2', typeName: null },
			{ id: 'e1', status: 'deleted', displayName: 'Gone', typeName: 'Device' }
		]);
	});

	it('falls back to the lite tree-item cache, then to the bare id', () => {
		const rows = deriveStagedElementRows(
			diff(
				[],
				[{ id: 'r1', status: 'added', after: rel('r1', 'known', 'unknown') }]
			),
			none,
			new Map([['known', lite('known', 'Known thing', 'Sensor')]])
		);
		expect(rows).toEqual([
			{ id: 'known', status: 'modified', displayName: 'Known thing', typeName: 'Sensor' },
			{ id: 'unknown', status: 'modified', displayName: 'unknown', typeName: null }
		]);
	});

	it('sorts new → modified → deleted, alphabetical within a group', () => {
		const t1 = createTempId();
		const t2 = createTempId();
		const cache = new Map([
			[t1, el(t1, 'zeta')],
			[t2, el(t2, 'alpha')],
			['m1', el('m1', 'beta')]
		]);
		const rows = deriveStagedElementRows(
			diff([
				{ id: 'd1', status: 'deleted', before: el('d1', 'aaa') },
				{ id: t1, status: 'added', after: cache.get(t1) },
				{ id: 'm1', status: 'modified', before: el('m1', 'x'), after: cache.get('m1') },
				{ id: t2, status: 'added', after: cache.get(t2) }
			]),
			cache,
			noLite
		);
		expect(rows.map((r) => [r.status, r.displayName])).toEqual([
			['new', 'alpha'],
			['new', 'zeta'],
			['modified', 'beta'],
			['deleted', 'aaa']
		]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/staged-rows.test.ts'`
Expected: FAIL — cannot resolve `../staged-rows`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/state/staged-rows.ts`:

```ts
/**
 * Pure derivation of the sidebar "Staged elements" section rows from the
 * staged-edits diff (`getStagedDiff()`) plus the display caches. Element-id
 * centric: one row per element touched by staged ops — created (temp id),
 * modified (property edits OR appearing as an endpoint of any staged
 * relationship change), or deleted. Deleted rows read name/type from the
 * diff's `before` snapshot (the element is gone from the cache after the
 * optimistic apply). Kept free of store imports so it is trivially
 * unit-testable; StagedSection.svelte wires it to the live stores.
 */
import type { Element, TreeItem } from '$lib/api/types';
import type { Diff } from './diff';
import { isTempId } from './ops';
import { elementDisplayName } from '$lib/util/element-name';

export type StagedRowStatus = 'new' | 'modified' | 'deleted';

export interface StagedElementRow {
	id: string;
	status: StagedRowStatus;
	displayName: string;
	/** null → display data unavailable in either cache; the section
	 * lite-fetches these ids via ensureTreeItems and re-derives when they
	 * land. */
	typeName: string | null;
}

const STATUS_RANK: Record<StagedRowStatus, number> = { new: 0, modified: 1, deleted: 2 };

export function deriveStagedElementRows(
	diff: Diff,
	elements: ReadonlyMap<string, Element>,
	treeItems: ReadonlyMap<string, TreeItem>
): StagedElementRow[] {
	// Computation scratch rebuilt per call, never read reactively.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const status = new Map<string, StagedRowStatus>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const deletedBefore = new Map<string, Element>();

	for (const d of diff.elements) {
		if (d.status === 'added') status.set(d.id, 'new');
		else if (d.status === 'modified') status.set(d.id, 'modified');
		else if (d.status === 'deleted') {
			// A temp element deleted in the same buffer is a net no-op (the diff
			// reports it deleted only because the delete's journal snapshot
			// captured the optimistically-created state) — hide it entirely.
			if (isTempId(d.id)) continue;
			status.set(d.id, 'deleted');
			if (d.before !== undefined) deletedBefore.set(d.id, d.before as Element);
		}
	}

	// Endpoint rule: an element touched only by staged relationship changes
	// counts as modified. `after ?? before` covers created/updated rels (cache
	// state) and deleted/cascade-journal entries (before snapshot) alike.
	// First-write-wins via `status.has` so a deleted element never downgrades.
	for (const d of diff.relationships) {
		const r = d.after ?? d.before;
		if (r === undefined || !('source_id' in r)) continue;
		for (const end of [r.source_id, r.target_id]) {
			if (isTempId(end) || status.has(end)) continue;
			status.set(end, 'modified');
		}
	}

	const rows: StagedElementRow[] = [];
	for (const [id, st] of status) {
		if (st === 'deleted') {
			const before = deletedBefore.get(id);
			rows.push({
				id,
				status: st,
				displayName: before !== undefined ? elementDisplayName(before) : id,
				typeName: before?.type_name ?? null
			});
			continue;
		}
		const full = elements.get(id);
		if (full !== undefined) {
			rows.push({ id, status: st, displayName: elementDisplayName(full), typeName: full.type_name });
			continue;
		}
		const liteRow = treeItems.get(id);
		rows.push({
			id,
			status: st,
			displayName: liteRow?.display_name ?? id,
			typeName: liteRow?.type_name ?? null
		});
	}

	rows.sort(
		(a, b) =>
			STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.displayName.localeCompare(b.displayName)
	);
	return rows;
}
```

In `frontend/src/lib/state/index.ts`, add (alongside the other module re-export blocks):

```ts
export {
	deriveStagedElementRows,
	type StagedElementRow,
	type StagedRowStatus
} from './staged-rows';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/staged-rows.test.ts'`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/staged-rows.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/staged-rows.test.ts
git commit -m "feat(frontend): derive staged-element rows for the sidebar staged section"
```

---

### Task 2: Cascade revert (`revertStagedForElement`)

**Files:**
- Modify: `frontend/src/lib/state/model.svelte.ts` (after `revertStagedFor`, ~line 636)
- Modify: `frontend/src/lib/state/index.ts` (add `revertStagedForElement` next to `revertStagedFor`)
- Test: `frontend/src/lib/state/__tests__/model.staged.test.ts` (append a describe block; extend the import list)

**Interfaces:**
- Consumes (module-private, already in `model.svelte.ts`): `_queue`, `_relationships`, `queuedTargetId`, `revertOptimistic`, `QueuedOp`.
- Produces (used by Task 3): `function revertStagedForElement(id: string): void` exported from `$lib/state`.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/lib/state/__tests__/model.staged.test.ts`, extend the import from `'../index'` with `getCachedRelationships`, `revertStagedForElement`, `seedRelationships`, and add `import { createTempId } from '../ops';`. Append:

```ts
describe('revertStagedForElement (cascade)', () => {
	it('reverting a created element removes staged relationships referencing its temp id', () => {
		seedElements([{ id: 'e2', type_name: 'T', properties: {}, rev: 1 }]);
		const tmpEl = createTempId();
		const tmpRel = createTempId();
		emit({ kind: 'create_element', temp_id: tmpEl, type_name: 'T', properties: { name: 'A' } });
		emit({
			kind: 'create_relationship',
			temp_id: tmpRel,
			type_name: 'R',
			source_id: tmpEl,
			target_id: 'e2',
			properties: {}
		});
		revertStagedForElement(tmpEl);
		expect(hasStagedOps()).toBe(false);
		expect(getCachedElements().has(tmpEl)).toBe(false);
		expect(getCachedRelationships().has(tmpRel)).toBe(false);
		expect(getCachedElements().has('e2')).toBe(true); // untouched
	});

	it('reverting a real element reverts its update AND incident staged rel ops, keeping other edits', () => {
		seedElements([
			{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 },
			{ id: 'e2', type_name: 'T', properties: { name: 'x' }, rev: 1 }
		]);
		const tmpRel = createTempId();
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		emit({
			kind: 'create_relationship',
			temp_id: tmpRel,
			type_name: 'R',
			source_id: 'e1',
			target_id: 'e2',
			properties: {}
		});
		emit({ kind: 'update_element', id: 'e2', properties_patch: { name: 'y' } });
		revertStagedForElement('e1');
		expect(getCachedElements().get('e1')?.properties.name).toBe('a'); // reverted
		expect(getCachedRelationships().has(tmpRel)).toBe(false); // cascade
		expect(getCachedElements().get('e2')?.properties.name).toBe('y'); // e2 edit survives
		expect(getStagedDepth()).toBe(1);
	});

	it('reverting a staged delete restores the element and its cascade-deleted relationships', () => {
		seedElements([
			{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 },
			{ id: 'e2', type_name: 'T', properties: {}, rev: 1 }
		]);
		seedRelationships([
			{ id: 'r1', type_name: 'R', source_id: 'e1', target_id: 'e2', properties: {}, rev: 1 }
		]);
		emit({ kind: 'delete_element', id: 'e1' });
		expect(getCachedRelationships().has('r1')).toBe(false); // optimistic cascade
		revertStagedForElement('e1');
		expect(getCachedElements().get('e1')?.properties.name).toBe('a');
		expect(getCachedRelationships().has('r1')).toBe(true);
		expect(hasStagedOps()).toBe(false);
	});

	it('resolves endpoints of a staged delete_relationship from the journal (rel gone from cache)', () => {
		seedElements([
			{ id: 'e1', type_name: 'T', properties: {}, rev: 1 },
			{ id: 'e2', type_name: 'T', properties: {}, rev: 1 }
		]);
		seedRelationships([
			{ id: 'r1', type_name: 'R', source_id: 'e1', target_id: 'e2', properties: {}, rev: 1 }
		]);
		emit({ kind: 'delete_relationship', id: 'r1' });
		expect(getCachedRelationships().has('r1')).toBe(false);
		revertStagedForElement('e1'); // e1 is only reachable via the journal snapshot
		expect(getCachedRelationships().has('r1')).toBe(true); // restored
		expect(hasStagedOps()).toBe(false);
	});

	it('is a no-op when nothing targets the id', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		revertStagedForElement('other');
		expect(getStagedDepth()).toBe(1);
		expect(getCachedElements().get('e1')?.properties.name).toBe('b');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/model.staged.test.ts'`
Expected: FAIL — `revertStagedForElement` is not exported.

- [ ] **Step 3: Write the implementation**

In `frontend/src/lib/state/model.svelte.ts`, insert directly after `revertStagedFor` (before `revertAllStaged`):

```ts
/** Resolve a queued relationship op's endpoints: create ops carry them
 * inline; update/delete ops resolve via the cache, falling back to the op's
 * own journal snapshot (a staged delete removed the rel from the cache, but
 * its pre-state is journaled). Returns null for element ops and rels that
 * were never cached (endpoints unknowable client-side). */
function queuedRelEndpoints(q: QueuedOp): { source_id: string; target_id: string } | null {
	const op = q.op;
	if (op.kind === 'create_relationship') {
		return { source_id: op.source_id, target_id: op.target_id };
	}
	if (op.kind !== 'update_relationship' && op.kind !== 'delete_relationship') return null;
	const cached = _relationships.get(op.id);
	if (cached !== undefined) return { source_id: cached.source_id, target_id: cached.target_id };
	for (const entry of q.revert) {
		if (entry.entity === 'relationship' && entry.id === op.id && entry.before !== null) {
			return { source_id: entry.before.source_id, target_id: entry.before.target_id };
		}
	}
	return null;
}

/** Cascade revert for the "Staged elements" section: revert and remove every
 * staged op targeting `id` PLUS every staged relationship op whose source or
 * target is `id`. The relationship cascade is mandatory for created elements
 * — a surviving staged rel referencing the reverted temp id would 422 the
 * eventual commit with an unknown id. Side effect accepted by design: this
 * can demote the OTHER endpoint of a removed staged rel from "modified" back
 * to untouched. */
export function revertStagedForElement(id: string): void {
	const remove = _queue.filter((q) => {
		if (queuedTargetId(q) === id) return true;
		const ep = queuedRelEndpoints(q);
		return ep !== null && (ep.source_id === id || ep.target_id === id);
	});
	if (remove.length === 0) return;
	revertOptimistic(remove);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const removeSet = new Set(remove);
	_queue = _queue.filter((q) => !removeSet.has(q));
}
```

In `frontend/src/lib/state/index.ts`, add `revertStagedForElement,` immediately after the existing `revertStagedFor,` entry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/model.staged.test.ts'`
Expected: PASS (all pre-existing + 5 new tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/model.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/model.staged.test.ts
git commit -m "feat(frontend): cascade per-element staged revert across incident relationship ops"
```

---

### Task 3: `StagedSection.svelte` + mount + component tests

**Files:**
- Create: `frontend/src/lib/components/Sidebar/StagedSection.svelte`
- Modify: `frontend/src/lib/components/Sidebar.svelte` (import + mount after `<ContainmentTree />`)
- Test: `frontend/src/lib/components/__tests__/staged-section.test.ts`

**Interfaces:**
- Consumes: `deriveStagedElementRows` / `StagedElementRow` (Task 1), `revertStagedForElement` (Task 2), and existing state exports `getStagedDiff`, `getCachedElements`, `getCachedTreeItems`, `ensureTreeItems`, `select`, `getSelection`, `clearSelection`; `isTempId` from `$lib/state/ops`.
- Produces: `StagedSection` component (no props). DOM hooks for tests: `data-testid="staged-section"` on the section, `data-staged-id`/`data-status` on rows, `data-testid="staged-revert"` on revert buttons.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/components/__tests__/staged-section.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import {
	clearSelection,
	emit,
	getCachedElements,
	getSelection,
	getStagedDepth,
	resetModelStore,
	seedElements
} from '$lib/state';
import { createTempId } from '$lib/state/ops';
import StagedSection from '../Sidebar/StagedSection.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function mountSection(): void {
	app = mount(StagedSection, { target: host });
	flushSync();
}

beforeEach(() => {
	resetModelStore();
	clearSelection();
	localStorage.clear();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

describe('StagedSection', () => {
	it('renders nothing when no ops are staged', () => {
		mountSection();
		expect(host.querySelector('[data-testid="staged-section"]')).toBeNull();
	});

	it('lists staged elements with status badges and a count', () => {
		seedElements([
			{ id: 'e1', type_name: 'Device', properties: { name: 'Edited one' }, rev: 1 },
			{ id: 'e2', type_name: 'Device', properties: { name: 'Doomed' }, rev: 1 }
		]);
		const tmp = createTempId();
		emit({ kind: 'create_element', temp_id: tmp, type_name: 'Device', properties: { name: 'Fresh' } });
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'Edited two' } });
		emit({ kind: 'delete_element', id: 'e2' });
		mountSection();
		expect(host.textContent).toContain('Staged elements');
		expect(host.textContent).toContain('3');
		expect(host.querySelector(`[data-staged-id="${tmp}"]`)?.getAttribute('data-status')).toBe('new');
		expect(host.querySelector('[data-staged-id="e1"]')?.getAttribute('data-status')).toBe('modified');
		expect(host.querySelector('[data-staged-id="e2"]')?.getAttribute('data-status')).toBe('deleted');
		expect(host.textContent).toContain('Fresh');
		expect(host.textContent).toContain('Edited two');
		expect(host.textContent).toContain('Doomed'); // name from journal pre-state
	});

	it('clicking a row selects the element; deleted rows have no select button', () => {
		seedElements([{ id: 'e2', type_name: 'Device', properties: { name: 'Doomed' }, rev: 1 }]);
		const tmp = createTempId();
		emit({ kind: 'create_element', temp_id: tmp, type_name: 'Device', properties: { name: 'Fresh' } });
		emit({ kind: 'delete_element', id: 'e2' });
		mountSection();
		const newRow = host.querySelector(`[data-staged-id="${tmp}"]`)!;
		(newRow.querySelector('button.staged-select') as HTMLButtonElement).click();
		flushSync();
		expect(getSelection()).toEqual({ kind: 'element', id: tmp });
		const deletedRow = host.querySelector('[data-staged-id="e2"]')!;
		expect(deletedRow.querySelector('button.staged-select')).toBeNull();
	});

	it('revert un-creates a new element, clears its selection, and hides the empty section', () => {
		const tmp = createTempId();
		emit({ kind: 'create_element', temp_id: tmp, type_name: 'Device', properties: { name: 'Fresh' } });
		mountSection();
		(host.querySelector(`[data-staged-id="${tmp}"] button.staged-select`) as HTMLButtonElement).click();
		flushSync();
		(host.querySelector('[data-testid="staged-revert"]') as HTMLButtonElement).click();
		flushSync();
		expect(getStagedDepth()).toBe(0);
		expect(getCachedElements().has(tmp)).toBe(false);
		expect(getSelection()).toBeNull();
		expect(host.querySelector('[data-testid="staged-section"]')).toBeNull();
	});

	it('revert on a modified element keeps the selection', () => {
		seedElements([{ id: 'e1', type_name: 'Device', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		mountSection();
		(host.querySelector('[data-staged-id="e1"] button.staged-select') as HTMLButtonElement).click();
		flushSync();
		(host.querySelector('[data-testid="staged-revert"]') as HTMLButtonElement).click();
		flushSync();
		expect(getCachedElements().get('e1')?.properties.name).toBe('a');
		expect(getSelection()).toEqual({ kind: 'element', id: 'e1' });
	});

	it('header toggle collapses the row list', () => {
		const tmp = createTempId();
		emit({ kind: 'create_element', temp_id: tmp, type_name: 'Device', properties: { name: 'Fresh' } });
		mountSection();
		expect(host.querySelector(`[data-staged-id="${tmp}"]`)).not.toBeNull();
		(host.querySelector('[data-testid="staged-header"]') as HTMLButtonElement).click();
		flushSync();
		expect(host.querySelector(`[data-staged-id="${tmp}"]`)).toBeNull();
		expect(localStorage.getItem('ui.stagedSectionCollapsed')).toBe('true');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/__tests__/staged-section.test.ts'`
Expected: FAIL — cannot resolve `../Sidebar/StagedSection.svelte`.

- [ ] **Step 3: Write the component and mount it**

Create `frontend/src/lib/components/Sidebar/StagedSection.svelte` with this full content:

```svelte
<script lang="ts">
	import { browser } from '$app/environment';
	import { ChevronDown, ChevronRight, Undo2 } from '@lucide/svelte';
	import {
		clearSelection,
		deriveStagedElementRows,
		ensureTreeItems,
		getCachedElements,
		getCachedTreeItems,
		getSelection,
		getStagedDiff,
		revertStagedForElement,
		select,
		type StagedElementRow
	} from '$lib/state';
	import { isTempId } from '$lib/state/ops';

	// "Staged elements" section: the navigation path to elements touched by
	// the staged-edits buffer (snippet-staged or manual). The tree renders only
	// server-paged rows, so staged temp elements appear NOWHERE else until
	// commit — this section is derived purely from client state. See
	// docs/superpowers/specs/2026-07-22-staged-elements-sidebar-section-design.md.

	const LS_COLLAPSED = 'ui.stagedSectionCollapsed';

	let collapsed = $state(browser && localStorage.getItem(LS_COLLAPSED) === 'true');
	$effect(() => {
		if (browser) localStorage.setItem(LS_COLLAPSED, String(collapsed));
	});

	const rows = $derived(
		deriveStagedElementRows(getStagedDiff(), getCachedElements(), getCachedTreeItems())
	);
	const selection = $derived(getSelection());

	// Modified rows can be in neither cache (staged-rel endpoint of an element
	// this client never loaded) — lite-fetch their display rows. ensureTreeItems
	// dedups cached/in-flight/temp ids, so re-runs are cheap.
	$effect(() => {
		const missing = rows
			.filter((r) => r.status === 'modified' && r.typeName === null && !isTempId(r.id))
			.map((r) => r.id);
		if (missing.length > 0) void ensureTreeItems(missing);
	});

	const BADGE: Record<StagedElementRow['status'], { label: string; cls: string }> = {
		new: { label: 'new', cls: 'text-success' },
		modified: { label: 'edited', cls: 'text-warning' },
		deleted: { label: 'deleted', cls: 'text-destructive' }
	};

	function onRowClick(row: StagedElementRow): void {
		select({ kind: 'element', id: row.id });
	}

	function onRevert(row: StagedElementRow): void {
		// Un-creating the selected temp element would leave the Inspector on a
		// dead id — clear selection first. Edits/deletes revert to a real
		// server-known element, so selection stays put.
		if (row.status === 'new' && selection?.kind === 'element' && selection.id === row.id) {
			clearSelection();
		}
		revertStagedForElement(row.id);
	}
</script>

{#if rows.length > 0}
	<section class="flex min-h-0 flex-col border-t border-border" data-testid="staged-section">
		<button
			type="button"
			class="microlabel flex select-none items-center gap-1 px-3 py-1.5 transition-colors hover:bg-muted hover:text-foreground/80"
			data-testid="staged-header"
			onclick={() => (collapsed = !collapsed)}
		>
			{#if collapsed}
				<ChevronRight class="h-3 w-3" />
			{:else}
				<ChevronDown class="h-3 w-3" />
			{/if}
			<span class="flex-1 text-left">Staged elements</span>
			<span class="font-mono text-[10px] normal-case text-muted-foreground">{rows.length}</span>
		</button>
		{#if !collapsed}
			<ul class="max-h-48 overflow-auto px-1 pb-1 text-xs" role="list">
				{#each rows as row (row.id)}
					{@const badge = BADGE[row.status]}
					<li
						class="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted"
						class:bg-muted={selection?.kind === 'element' && selection.id === row.id}
						data-staged-id={row.id}
						data-status={row.status}
					>
						{#if row.status === 'deleted'}
							<span class="flex-1 truncate text-muted-foreground line-through">
								{row.displayName}
							</span>
						{:else}
							<button
								type="button"
								class="staged-select flex-1 truncate text-left text-foreground/90"
								onclick={() => onRowClick(row)}
							>
								{row.displayName}
							</button>
						{/if}
						{#if row.typeName !== null}
							<span
								class="rounded border border-input bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
							>
								{row.typeName}
							</span>
						{/if}
						<span class="font-mono text-[10px] {badge.cls}">{badge.label}</span>
						<button
							type="button"
							class="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-border hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
							title="Revert staged changes"
							aria-label="Revert staged changes to {row.displayName}"
							data-testid="staged-revert"
							onclick={() => onRevert(row)}
						>
							<Undo2 class="h-3 w-3" />
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}
```

In `frontend/src/lib/components/Sidebar.svelte`:

```svelte
	import StagedSection from './Sidebar/StagedSection.svelte';
```

and in the loaded branch of the template, after `<ContainmentTree />`:

```svelte
		<ContainmentTree />
		<StagedSection />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/__tests__/staged-section.test.ts'`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Sidebar/StagedSection.svelte frontend/src/lib/components/Sidebar.svelte frontend/src/lib/components/__tests__/staged-section.test.ts
git commit -m "feat(frontend): staged-elements sidebar section with click-to-select and cascade revert"
```

---

### Task 4: Full verification sweep

**Files:** none new — runs the whole suite and repo hygiene.

- [ ] **Step 1: Run the full frontend unit suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'`
Expected: PASS — no regressions (DiffDrawer/model-store/tree tests all green).

- [ ] **Step 2: Run svelte-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors (warnings only if pre-existing).

- [ ] **Step 3: Run repo-wide tidy**

Run: `pixi run dr-tidy`
Expected: exits 0; commit any formatting deltas it produces.

- [ ] **Step 4: Commit (only if tidy changed files)**

```bash
git add -A
git commit -m "chore(frontend): tidy after staged-elements section"
```

---

## Self-review notes

- Spec coverage: section visibility/collapse/count (Task 3), badge rules incl. temp-delete no-op and endpoint-modified (Task 1), deleted-row naming from journal (Tasks 1/3), click-to-select with deleted rows inert (Task 3), cascade revert incl. journal endpoint resolution (Task 2), both view modes (section lives in Sidebar.svelte outside the view-gated pool — mode-independent by construction), lite-fetch for uncached modified rows (Task 3 effect).
- Commit-time emptying needs no code: `clearStaged()` empties `_queue`, `getStagedDiff()` returns an empty diff, `rows.length === 0` hides the section.
- Type consistency: `StagedElementRow`/`StagedRowStatus`/`deriveStagedElementRows`/`revertStagedForElement` names match across Tasks 1–3.
