# Table Column Editing & Inline Navigation Definitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make table property columns editable after creation (searchable property picker + free text), and let navigation columns and navigation/chains row sources carry an inline navigation definition edited with the existing navigation-builder components.

**Architecture:** Frontend-only. The backend already supports everything: `NavigationSource` accepts an inline `definition` (`core/table/resolve.py` inlines refs transitively), the `RowStart` start sentinel (`{kind:"row"}`) binds to the row element in `core/table/evaluate.py`, and `POST /navigations/evaluate` accepts `row_element_id` for previewing row-rooted definitions. Reuse mechanism (approved design, Approach A): the navigation-builder tree (`NavigationNode`/`PathCard`/`CombineFrame`/`StatusChip`) talks to the navigation-editor store exclusively through a `tabId` string, so table editors host **ephemeral "embedded drafts"** in that store under synthetic `navemb:*` ids and render `NavigationNode` unchanged. The column's stored definition remains the source of truth; the draft is just the editing surface (created on mount / mode-switch, closed on unmount).

**Tech Stack:** SvelteKit / Svelte 5 runes, Zod, Vitest (happy-dom, `mount`/`flushSync` render convention), Playwright. All commands run through pixi from the repo root.

**Spec:** `docs/superpowers/specs/2026-07-13-table-column-editing-and-inline-navigations-design.md`

## Global Constraints

- No backend/schema changes. Python code is untouched.
- Frontend npm scripts MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test'` (the bare `pixi run -e frontend npm test` fails with "Missing script").
- Vitest single file: `pixi run -e frontend bash -c 'cd frontend && npm test -- <path>'` (`test` = `vitest run`).
- Svelte component tests follow the repo convention: `mount`/`unmount`/`flushSync` from `svelte`, real stores reset in `beforeEach`/`afterEach`, API mocked with `vi.spyOn(artifactsApi, …)` (see `frontend/src/lib/components/Navigation/__tests__/status-chip.test.ts`).
- Preserve the dense docstring/comment style: comments explain *why* invariants exist, not what the next line does.
- The row-start UI copy is exactly: start-mode option **"the row's element"**, rendered start line **"each row's element"**, StatusChip hint **"no row to preview against"**.
- Commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `RowStart` in frontend types + tree helpers

**Files:**
- Modify: `frontend/src/lib/api/types.ts:398-407` (PathNavigation)
- Modify: `frontend/src/lib/navigation/tree.ts` (new helpers + row-aware label branches)
- Test: `frontend/src/lib/navigation/__tests__/tree.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `NavRowStart` (`{kind:'row'}`) in `$lib/api/types`; `PathNavigation.start: NavScope | SetExpression | NavRowStart`; from `$lib/navigation/tree`: `emptyRowPath(): PathNavigation` and `containsRowStart(defn: NavigationDefinition): boolean`. Tasks 2–5 import all of these.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/navigation/__tests__/tree.test.ts` (extend the existing import list from `../tree` with `emptyRowPath`, `containsRowStart`, `chainColumns`, `nodeLabel`, `isRunnable`, `emptyPath`; import `type NavigationDefinition` from `$lib/api/types` if not already):

```ts
describe('RowStart', () => {
	it('emptyRowPath is a runnable row-rooted path', () => {
		const p = emptyRowPath();
		expect(p.start).toEqual({ kind: 'row' });
		expect(isRunnable(p)).toBe(true); // "the row element itself" is a valid column
		expect(containsRowStart(p)).toBe(true);
	});

	it('containsRowStart finds a row start nested inside a set-op operand', () => {
		const defn: NavigationDefinition = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{ definition: emptyRowPath(), step_index: null }
			]
		};
		expect(containsRowStart(defn)).toBe(true);
		expect(containsRowStart(emptyPath())).toBe(false);
	});

	it('chainColumns labels a row start without touching scope fields', () => {
		expect(chainColumns(emptyRowPath())[0]).toEqual({
			index: 0,
			label: 'Start',
			sub: 'row element'
		});
	});

	it('nodeLabel heads a row-rooted path with Row', () => {
		expect(nodeLabel(emptyRowPath())).toBe('Row');
		expect(
			nodeLabel({ ...emptyRowPath(), steps: [{ kind: 'relationship', relationship_type: 'Owns', direction: 'out', target_types: [], children: [] }] })
		).toBe('Row → Owns');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/navigation/__tests__/tree.test.ts'`
Expected: FAIL — `emptyRowPath` is not exported (TS/compile error) or test failures.

- [ ] **Step 3: Implement**

`frontend/src/lib/api/types.ts` — above `PathNavigation` add, and extend `start`:

```ts
/** Start = the element(s) the caller roots this navigation at — a table
 * column supplies its row's element(s). Mirrors core/navigation/schema.py's
 * RowStart; only valid where a row binding exists (embedded column editors),
 * never in a standalone saved navigation. */
export interface NavRowStart {
	kind: 'row';
}
```

```ts
	start: NavScope | SetExpression | NavRowStart;
```

(No Zod change: `NavigationDefinitionSchema` types `start` as `z.unknown()`.)

`frontend/src/lib/navigation/tree.ts`:

1. After `emptyPath()` add:

```ts
/** A fresh path rooted at the caller-supplied row element (RowStart). The
 * embedded column editor's seed — a standalone builder never creates one. */
export function emptyRowPath(): PathNavigation {
	return {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'row' },
		steps: [],
		exclude_visited: true
	};
}

/** True when any path in the tree is row-rooted — such a definition is only
 * evaluable with a row binding (previews skip / hint without one). */
export function containsRowStart(defn: NavigationDefinition): boolean {
	if (defn.kind === 'path') {
		if (defn.start.kind === 'row') return true;
		return defn.start.kind === 'set_op' ? containsRowStart(defn.start) : false;
	}
	return defn.operands.some((op) => (op.definition ? containsRowStart(op.definition) : false));
}
```

2. `nodeLabel` — replace the `head` computation (the `startTypes` line stays, it already guards on `'scope'`):

```ts
	const head =
		defn.start.kind === 'set_op'
			? '(combination)'
			: defn.start.kind === 'row'
				? 'Row'
				: startTypes.length
					? startTypes.join('/')
					: 'Any';
```

3. `chainColumns` — the `sub` chain MUST check `'row'` before `readElementStart` (which reads `scope.types` and would throw on a RowStart):

```ts
	let sub: string | undefined;
	if (start.kind === 'set_op') sub = 'combination';
	else if (start.kind === 'row') sub = 'row element';
	else if (readElementStart(start) !== null) sub = 'one element';
	else if (start.types.length > 0) sub = [...start.types].sort().join(', ');
```

Leave `nodeAt`/`updateNodeAt`/`nodeEntries`/`nodeExistsAt`/`precedingTargetTypes`/`isRunnable` alone — their `'start'` handling only descends into `set_op` starts and their scope reads are already kind-guarded (`precedingTargetTypes` falls through to `[]` for a row start = "any type", which is the wanted picker scope).

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/navigation/__tests__/tree.test.ts'`
Expected: PASS. Also run `pixi run -e frontend bash -c 'cd frontend && npm run check'` — expect no new errors (pre-existing count unchanged).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/navigation/tree.ts frontend/src/lib/navigation/__tests__/tree.test.ts
git commit -m "feat(frontend): RowStart start kind in navigation types and tree helpers"
```

---

### Task 2: Embedded drafts in the navigation-editor store + row-bound previews

**Files:**
- Modify: `frontend/src/lib/api/artifacts.ts:43-53` (`evaluateNavigation` body)
- Modify: `frontend/src/lib/state/navigation-editor.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (barrel exports)
- Test: `frontend/src/lib/state/__tests__/navigation-editor.test.ts`

**Interfaces:**
- Consumes: `emptyRowPath`, `containsRowStart` from Task 1.
- Produces (exported from `$lib/state`):
  - `interface EmbeddedContext { rowContext: boolean; rowElementId: string | null }`
  - `NavDraft.embedded?: EmbeddedContext` (present only on embedded drafts)
  - `ensureEmbeddedDraft(id: string, definition: NavigationDefinition, ctx: EmbeddedContext): NavDraft` — sync; id MUST start with `'navemb:'`
  - `setEmbeddedRowElement(id: string, rowElementId: string | null): void`
  - `saveDraft`/`saveAsDraft` now throw `Error('embedded navigation drafts cannot be saved')` for `navemb:*` ids
  - `evaluateNavigation` body gains `row_element_id?: string | null`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/state/__tests__/navigation-editor.test.ts` (add `ensureEmbeddedDraft`, `setEmbeddedRowElement` to the store import list and `emptyRowPath` to the tree import list; `CHAIN_PAGE` and the reset hooks already exist in the file):

```ts
describe('embedded drafts', () => {
	it('creates a pinned draft and runs the root preview with the row binding', async () => {
		const evalSpy = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		const draft = ensureEmbeddedDraft('navemb:t1', emptyRowPath(), {
			rowContext: true,
			rowElementId: 'e1'
		});
		expect(draft.embedded).toEqual({ rowContext: true, rowElementId: 'e1' });
		await vi.waitFor(() => expect(getPreview('navemb:t1')?.loading).toBe(false));
		expect(evalSpy).toHaveBeenCalledWith(
			expect.objectContaining({ row_element_id: 'e1' })
		);
	});

	it('skips previews for a row-rooted draft with no bound row (no 422 surfacing)', async () => {
		const evalSpy = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		ensureEmbeddedDraft('navemb:t2', emptyRowPath(), { rowContext: true, rowElementId: null });
		await Promise.resolve();
		expect(evalSpy).not.toHaveBeenCalled();
		expect(getPreview('navemb:t2')).toBeUndefined();
		expect(getEvalError('navemb:t2')).toBe(false);
	});

	it('setEmbeddedRowElement re-runs expanded previews under the new binding', async () => {
		const evalSpy = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		ensureEmbeddedDraft('navemb:t3', emptyRowPath(), { rowContext: true, rowElementId: null });
		setEmbeddedRowElement('navemb:t3', 'e9');
		await vi.waitFor(
			() => expect(evalSpy).toHaveBeenCalledWith(expect.objectContaining({ row_element_id: 'e9' })),
			{ timeout: 2000 } // updateDefinition's sweep debounces (AUTO_RUN_DEBOUNCE_MS)
		);
		expect(getDraft('navemb:t3')?.embedded?.rowElementId).toBe('e9');
	});

	it('rejects saveDraft/saveAsDraft on an embedded draft', async () => {
		ensureEmbeddedDraft('navemb:t4', emptyRowPath(), { rowContext: true, rowElementId: null });
		await expect(saveDraft('navemb:t4')).rejects.toThrow(/cannot be saved/);
		await expect(saveAsDraft('navemb:t4', 'x')).rejects.toThrow(/cannot be saved/);
	});

	it('rejects a non-navemb id', () => {
		expect(() =>
			ensureEmbeddedDraft('nav:draft:x', emptyRowPath(), { rowContext: true, rowElementId: null })
		).toThrow(/navemb/);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/navigation-editor.test.ts'`
Expected: FAIL — `ensureEmbeddedDraft` not exported.

- [ ] **Step 3: Implement**

`frontend/src/lib/api/artifacts.ts` — extend the `evaluateNavigation` body type:

```ts
export function evaluateNavigation(
	body: {
		definition?: NavigationDefinition;
		artifact_id?: string;
		limit?: number;
		offset?: number;
		/** Binds any RowStart in `definition` (embedded column previews). */
		row_element_id?: string | null;
	},
	cfg?: ClientConfig
): Promise<ChainPage> {
	return apiFetch('/navigations/evaluate', { method: 'POST', body, schema: ChainPageSchema }, cfg);
}
```

`frontend/src/lib/state/navigation-editor.svelte.ts`:

1. Import `containsRowStart` from `$lib/navigation/tree` (extend the existing import).

2. Extend `NavDraft` and add the context type + prefix (below the `NavDraft` interface):

```ts
export interface EmbeddedContext {
	/** True when the hosting surface roots the navigation at a table row —
	 * PathCard offers the "the row's element" start mode only then. */
	rowContext: boolean;
	/** Sample element row-rooted previews are bound to (the hosting table's
	 * first row); null = no rows, so row-rooted previews are skipped. */
	rowElementId: string | null;
}
```

Add to `NavDraft`:

```ts
	/** Present only on EMBEDDED drafts (`navemb:*` ids): drafts hosted by a
	 * table column / row-source editor rather than a workspace tab. Their
	 * definition is mirrored into the hosting table definition by the editor
	 * component; they are never saved and never appear in the tab strip. */
	embedded?: EmbeddedContext;
```

```ts
const EMBEDDED_PREFIX = 'navemb:';
```

3. After `ensureDraft` add:

```ts
/**
 * Create (or return) an EMBEDDED draft: the navigation-builder components are
 * store-coupled through a tabId string, so a table column editor hosts its
 * inline definition here under a synthetic id and renders NavigationNode
 * unchanged. Sync (no artifact fetch): the seed definition comes from the
 * hosting column. Mirrors ensureDraft's saved-artifact open: pin the root and
 * show results immediately — runPreview itself skips a row-rooted node with
 * no bound row element.
 */
export function ensureEmbeddedDraft(
	id: string,
	definition: NavigationDefinition,
	ctx: EmbeddedContext
): NavDraft {
	if (!id.startsWith(EMBEDDED_PREFIX)) {
		throw new Error(`embedded draft ids must start with "${EMBEDDED_PREFIX}"`);
	}
	const existing = _drafts.get(id);
	if (existing) return existing;
	const draft: NavDraft = {
		name: '',
		artifactId: null,
		artifactRev: null,
		definition: normalizeDefinition(definition),
		dirty: false,
		embedded: ctx
	};
	_drafts.set(id, draft);
	pinRoot(id);
	if (isRunnable(draft.definition)) void runPreview(id, []).catch(() => {});
	return draft;
}

/**
 * Update an embedded draft's sample-row binding (the hosting table's first
 * row changed). The definition is unchanged, but every preview was evaluated
 * against the OLD binding — reuse updateDefinition's invalidation sweep
 * (bump generations, clear previews, reschedule debounced runs) rather than
 * duplicating it. The `dirty: true` it sets is meaningless on an embedded
 * draft (nothing reads it), so not worth a parallel code path.
 */
export function setEmbeddedRowElement(id: string, rowElementId: string | null): void {
	const draft = _drafts.get(id);
	if (!draft?.embedded || draft.embedded.rowElementId === rowElementId) return;
	_drafts.set(id, { ...draft, embedded: { ...draft.embedded, rowElementId } });
	updateDefinition(id, draft.definition);
}
```

4. `saveDraft` and `saveAsDraft` — first line after the draft lookup (`if (!draft) return;`) in BOTH:

```ts
	if (tabId.startsWith(EMBEDDED_PREFIX)) {
		throw new Error('embedded navigation drafts cannot be saved');
	}
```

5. `runPreview` — after the `if (!node) return;` guard, insert the skip and thread the binding:

```ts
	const emb = draft.embedded;
	const key = previewKey(tabId, path);
	// A row-rooted node with no bound row element is not evaluable (the
	// backend 422s on an unbound RowStart). Skip QUIETLY — no preview, no
	// eval-error: StatusChip derives the "no row to preview against" hint
	// from this same predicate, and a red "failed" would be a lie.
	if (emb && emb.rowElementId === null && containsRowStart(node)) {
		bumpGeneration(key); // orphan any in-flight run for the old binding
		_previews.delete(key);
		_evalErrors.delete(key);
		return;
	}
```

(delete the now-duplicate `const key = previewKey(tabId, path);` line below) and extend the evaluate call:

```ts
		const page = await api.evaluateNavigation({
			definition: node,
			limit: PAGE,
			offset: 0,
			row_element_id: emb?.rowElementId ?? undefined
		});
```

6. `loadMorePreview` — same body extension (read `const emb = draft.embedded;` after the draft guard):

```ts
		const page = await api.evaluateNavigation({
			definition: node,
			limit: PAGE,
			offset: preview.chains.length,
			row_element_id: emb?.rowElementId ?? undefined
		});
```

7. `frontend/src/lib/state/index.ts` — add `ensureEmbeddedDraft`, `setEmbeddedRowElement`, `type EmbeddedContext` to the `./navigation-editor.svelte` export list (alphabetical order within the list).

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/state/__tests__/navigation-editor.test.ts'`
Expected: PASS (all — including the pre-existing tests, which exercise `saveDraft` etc. on `nav:` ids and must be unaffected).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api/artifacts.ts frontend/src/lib/state/navigation-editor.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/navigation-editor.test.ts
git commit -m "feat(frontend): embedded navigation drafts with row-bound previews"
```

---

### Task 3: PathCard "the row's element" start mode + StatusChip needs-row hint

**Files:**
- Modify: `frontend/src/lib/components/Navigation/PathCard.svelte:143-155` (start modes) and the start rendering block (~254)
- Modify: `frontend/src/lib/components/Navigation/StatusChip.svelte`
- Test: `frontend/src/lib/components/Navigation/__tests__/path-card.test.ts`, `frontend/src/lib/components/Navigation/__tests__/status-chip.test.ts`

**Interfaces:**
- Consumes: `NavDraft.embedded` (Task 2), `containsRowStart` (Task 1), `emptyRowPath` (Task 1).
- Produces: UI only. The start `<select>` gains `<option value="row">the row's element</option>` visible only when `getDraft(tabId)?.embedded?.rowContext` is true (or the start already IS a row start — a defensive render for a payload authored elsewhere); StatusChip gains the "no row to preview against" state.

- [ ] **Step 1: Write the failing tests**

Append to `path-card.test.ts` (follow the file's existing render conventions — it mounts `PathCard` with `{tabId, path, node}` after seeding a draft; add `ensureEmbeddedDraft` to its `$lib/state` imports and `emptyRowPath` to its tree imports):

```ts
it('offers the row start mode only on a row-context embedded draft', async () => {
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
	ensureEmbeddedDraft('navemb:pc1', emptyRowPath(), { rowContext: true, rowElementId: null });
	const node = getDraft('navemb:pc1')!.definition;
	const c = mount(PathCard, {
		target: document.body,
		props: { tabId: 'navemb:pc1', path: [], node: node as PathNavigation }
	});
	flushSync();
	try {
		const select = document.querySelector('select[aria-label="Start mode"]')!;
		expect([...select.querySelectorAll('option')].map((o) => o.value)).toContain('row');
		expect((select as HTMLSelectElement).value).toBe('row');
		expect(document.body.textContent).toContain("each row's element");
	} finally {
		unmount(c);
	}
});

it('does not offer the row start mode on an ordinary tab draft', async () => {
	const tabId = 'nav:draft:pc2';
	await ensureDraft(tabId);
	const node = getDraft(tabId)!.definition;
	const c = mount(PathCard, {
		target: document.body,
		props: { tabId, path: [], node: node as PathNavigation }
	});
	flushSync();
	try {
		const select = document.querySelector('select[aria-label="Start mode"]')!;
		expect([...select.querySelectorAll('option')].map((o) => o.value)).not.toContain('row');
	} finally {
		unmount(c);
	}
});
```

Append to `status-chip.test.ts`:

```ts
it('shows the no-row hint for a row-rooted embedded draft with no binding', () => {
	const evalSpy = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
	ensureEmbeddedDraft('navemb:chip1', emptyRowPath(), { rowContext: true, rowElementId: null });
	const c = render('navemb:chip1');
	try {
		expect(document.body.textContent).toContain('no row to preview against');
		expect(evalSpy).not.toHaveBeenCalled();
	} finally {
		unmount(c);
	}
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Navigation/__tests__/path-card.test.ts src/lib/components/Navigation/__tests__/status-chip.test.ts'`
Expected: FAIL — no `row` option / no hint text.

- [ ] **Step 3: Implement**

`PathCard.svelte`:

1. Replace the start-mode block (lines 143–155):

```ts
	type StartMode = 'scope' | 'element' | 'combine' | 'row';
	const startMode = $derived<StartMode>(
		node.start.kind === 'set_op'
			? 'combine'
			: node.start.kind === 'row'
				? 'row'
				: readElementStart(node.start) !== null
					? 'element'
					: 'scope'
	);
	// Row-rooting is only meaningful where a caller supplies a row binding —
	// an embedded table-column editor. A standalone tab must never author a
	// RowStart (an unbound one is unevaluable), so the option is gated on the
	// draft's context; `startMode === 'row'` keeps an already-row-rooted
	// payload renderable wherever it appears.
	const rowStartAvailable = $derived(draft?.embedded?.rowContext === true);
	function setStartMode(mode: StartMode): void {
		if (mode === 'row') patch({ start: { kind: 'row' } });
		else if (mode === 'scope') patch({ start: { kind: 'scope', types: [], criteria: [] } });
		else if (mode === 'element') patch({ start: elementStartScope('') });
		else patch({ start: emptyCombine() });
	}
```

2. In the start-mode `<select>` add after the `combine` option:

```svelte
					{#if rowStartAvailable || startMode === 'row'}
						<option value="row">the row's element</option>
					{/if}
```

3. In the start rendering chain, add a `row` branch FIRST (before the `scope` branch at line ~254):

```svelte
			{#if node.start.kind === 'row'}
				<div class="relative pl-7">
					<span class="text-muted-foreground italic">each row's element</span>
				</div>
			{:else if node.start.kind === 'scope'}
```

(the rest of the chain is unchanged; TS narrows `node.start` to `NavScope` in the scope branch because the `row` kind was eliminated.)

`StatusChip.svelte`:

```ts
	import { containsRowStart, nodeAt, type NodePath } from '$lib/navigation/tree';
	...
	// Mirrors runPreview's skip predicate exactly: an embedded draft with no
	// bound row and a row-rooted node gets no preview AND no error — this
	// hint is the only surface telling the user why.
	const needsRow = $derived(
		draft?.embedded !== undefined &&
			draft.embedded.rowElementId === null &&
			node !== null &&
			containsRowStart(node)
	);
```

Template — insert between the `preview` and `errored` branches:

```svelte
	{:else if needsRow}
		<span class="text-muted-foreground/70 italic">no row to preview against</span>
	{:else if errored}
```

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Navigation/__tests__/'`
Expected: PASS (whole Navigation component suite — the existing PathCard/StatusChip tests must be unaffected).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Navigation/PathCard.svelte frontend/src/lib/components/Navigation/StatusChip.svelte frontend/src/lib/components/Navigation/__tests__/path-card.test.ts frontend/src/lib/components/Navigation/__tests__/status-chip.test.ts
git commit -m "feat(frontend): row-element start mode in PathCard, no-row preview hint"
```

---

### Task 4: Inline navigation definitions in NavigationColumnEditor

**Files:**
- Modify: `frontend/src/lib/components/Table/NavigationColumnEditor.svelte`
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte` (pass `sampleRowElementId`)
- Test: Create `frontend/src/lib/components/Table/__tests__/NavigationColumnEditor.test.ts`

**Interfaces:**
- Consumes: `ensureEmbeddedDraft`/`setEmbeddedRowElement`/`closeDraft`/`getDraft` (Task 2), `emptyRowPath` (Task 1), `NavigationNode` (existing), `api.getArtifact` (existing).
- Produces: `NavigationColumnEditor` prop `sampleRowElementId?: string | null` (default `null`). Mode buttons `data-testid="nav-mode-ref"` / `"nav-mode-inline"`; inline editor container `data-testid="inline-nav-editor"`. Task 7's e2e uses these testids.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/components/Table/__tests__/NavigationColumnEditor.test.ts`:

```ts
// Inline-mode tests for the nav-column editor: switching modes seeds/closes
// an embedded draft in the navigation-editor store, and embedded-draft edits
// are mirrored back into the column via onChange. Real stores (reset per
// test), spied artifacts API — same convention as status-chip.test.ts.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import {
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	setProjectInfo
} from '$lib/state';
import type { Column } from '$lib/api/types';
import NavigationColumnEditor from '../NavigationColumnEditor.svelte';

type NavColumn = Extract<Column, { kind: 'navigation' }>;

const CHAIN_PAGE = {
	step_types: [],
	chains: [[{ id: 'e1', type_name: 'B', display_name: 'e1', child_count: 0 }]],
	total: 1,
	truncated: false
};

function navColumn(navigation: NavColumn['navigation']): NavColumn {
	return {
		kind: 'navigation',
		source: { kind: 'row', chain_index: 0 },
		navigation,
		step_index: null,
		mode: 'collapse',
		keep_empty: true,
		sort_mode: 'value',
		cell_cap: 20,
		header: '',
		width_px: null
	};
}

function render(column: NavColumn, onChange: (next: NavColumn) => void) {
	const c = mount(NavigationColumnEditor, {
		target: document.body,
		props: { column, columnIndex: 1, columns: [column], sampleRowElementId: 'row-el-1', onChange }
	});
	flushSync();
	return c;
}

function click(el: Element | null): void {
	if (!el) throw new Error('element not found');
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

beforeEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
});
afterEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('NavigationColumnEditor inline mode', () => {
	it('switching to inline seeds a fresh row-rooted definition', async () => {
		const onChange = vi.fn();
		const c = render(navColumn({}), onChange);
		try {
			click(document.querySelector('[data-testid="nav-mode-inline"]'));
			await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
			const next = onChange.mock.calls.at(-1)![0] as NavColumn;
			expect(next.navigation.definition).toMatchObject({
				kind: 'path',
				start: { kind: 'row' }
			});
			expect(next.navigation.ref).toBeUndefined();
		} finally {
			unmount(c);
		}
	});

	it('switching to inline with a saved ref selected seeds a copy of that navigation', async () => {
		const saved = {
			kind: 'path',
			schema_version: 2,
			start: { kind: 'scope', types: ['System'], criteria: [] },
			steps: [],
			exclude_visited: true
		};
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'navigation',
			name: 'Saved',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			payload: saved as unknown as Record<string, unknown>
		});
		const onChange = vi.fn();
		const c = render(navColumn({ ref: 'a1' }), onChange);
		try {
			click(document.querySelector('[data-testid="nav-mode-inline"]'));
			await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
			const next = onChange.mock.calls.at(-1)![0] as NavColumn;
			expect(next.navigation.definition).toMatchObject({
				kind: 'path',
				start: { kind: 'scope', types: ['System'] }
			});
		} finally {
			unmount(c);
		}
	});

	it('renders the embedded builder for an inline column and mirrors edits via onChange', async () => {
		const inline = {
			kind: 'path' as const,
			schema_version: 2,
			start: { kind: 'row' as const },
			steps: [],
			exclude_visited: true
		};
		const onChange = vi.fn();
		const c = render(navColumn({ definition: inline }), onChange);
		try {
			await vi.waitFor(() =>
				expect(document.querySelector('[data-testid="inline-nav-editor"]')).toBeTruthy()
			);
			// Edit through the REAL embedded PathCard: add a relationship step.
			click(
				[...document.querySelectorAll('button')].find((b) =>
					b.textContent?.includes('Follow a relationship')
				) ?? null
			);
			await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
			const next = onChange.mock.calls.at(-1)![0] as NavColumn;
			expect(next.navigation.definition).toMatchObject({
				kind: 'path',
				steps: [{ kind: 'relationship' }]
			});
		} finally {
			unmount(c);
		}
	});

	it('switching back to saved clears the inline definition from the column', async () => {
		const inline = {
			kind: 'path' as const,
			schema_version: 2,
			start: { kind: 'row' as const },
			steps: [],
			exclude_visited: true
		};
		const onChange = vi.fn();
		const c = render(navColumn({ definition: inline }), onChange);
		try {
			await vi.waitFor(() =>
				expect(document.querySelector('[data-testid="inline-nav-editor"]')).toBeTruthy()
			);
			click(document.querySelector('[data-testid="nav-mode-ref"]'));
			const next = onChange.mock.calls.at(-1)![0] as NavColumn;
			expect(next.navigation).toEqual({});
		} finally {
			unmount(c);
		}
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/NavigationColumnEditor.test.ts'`
Expected: FAIL — no `nav-mode-inline` testid.

- [ ] **Step 3: Implement**

`NavigationColumnEditor.svelte` — script section: replace the header comment (the "Stage-2.1 deferral" note is now stale) and add the inline machinery. Full new script:

```svelte
<script lang="ts">
	// Per-column editor for a `navigation`-kind column: the column's `source`
	// (a row slot / an earlier column's output), the navigation itself —
	// either a saved-artifact REF or an INLINE definition edited with the
	// real navigation builder — plus `step_index`, `sort_mode`, `cell_cap`,
	// `mode`, `keep_empty`. A fully controlled component: emits a whole new
	// column via `onChange`. Inline mode hosts an EMBEDDED draft in the
	// navigation-editor store (see ensureEmbeddedDraft) and renders
	// NavigationNode against it; the column's stored definition stays the
	// source of truth — the draft is only the editing surface, so a remount
	// (column reorder/remove) simply re-seeds from the column.
	import { onDestroy } from 'svelte';
	import * as api from '$lib/api/artifacts';
	import {
		closeDraft,
		ensureEmbeddedDraft,
		getArtifactHeaders,
		getDraft,
		setEmbeddedRowElement
	} from '$lib/state';
	import { columnLabel } from '$lib/table/columns';
	import { emptyRowPath } from '$lib/navigation/tree';
	import type { Column, NavigationDefinition } from '$lib/api/types';
	import NavigationNode from '../Navigation/NavigationNode.svelte';

	type NavColumn = Extract<Column, { kind: 'navigation' }>;

	let {
		column,
		columnIndex,
		columns,
		sampleRowElementId = null,
		onChange
	}: {
		column: NavColumn;
		columnIndex: number;
		columns: Column[];
		/** The hosting table's first row element — binds row-rooted previews.
		 * Null (no rows) shows the "no row to preview against" hint. */
		sampleRowElementId?: string | null;
		onChange: (next: NavColumn) => void;
	} = $props();

	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));
	const priorColumns = $derived(columns.slice(0, columnIndex));

	// One embedded-draft id per mounted editor instance (never persisted).
	const embId = `navemb:${crypto.randomUUID()}`;

	const inline = $derived(column.navigation.definition != null);
	const embDraft = $derived(getDraft(embId));

	// The last inline definition, kept while in ref mode so toggling
	// saved -> inline -> saved within one mount doesn't lose work. Only the
	// active mode is ever written to the column.
	let lastInline = $state<NavigationDefinition | null>(null);
	let seeding = $state(false);

	// Lifecycle: an inline column needs its embedded draft (e.g. a saved
	// table reopened with an inline definition already in the payload); a
	// ref-mode column must not leave one behind.
	$effect(() => {
		if (inline && !getDraft(embId)) {
			ensureEmbeddedDraft(embId, column.navigation.definition!, {
				rowContext: true,
				rowElementId: sampleRowElementId
			});
		} else if (!inline && getDraft(embId)) {
			closeDraft(embId);
		}
	});

	// Mirror embedded-draft edits back into the column. Reference equality is
	// the loop guard: ColumnManager's whole-column swap preserves the
	// definition object it was handed, so after a round-trip
	// column.navigation.definition IS embDraft.definition and this no-ops.
	$effect(() => {
		if (!inline || !embDraft) return;
		if (embDraft.definition !== column.navigation.definition) {
			onChange({ ...column, navigation: { definition: embDraft.definition } });
		}
	});

	// Keep the preview row binding in sync with the hosting table's rows.
	$effect(() => {
		if (getDraft(embId)) setEmbeddedRowElement(embId, sampleRowElementId);
	});

	onDestroy(() => closeDraft(embId));

	async function switchToInline(): Promise<void> {
		if (inline || seeding) return;
		// Seed preference: the in-memory definition from an earlier toggle, a
		// COPY of the currently selected saved navigation ("customize this
		// one"), then a fresh row-rooted path.
		let seed: NavigationDefinition | null = lastInline;
		if (!seed && column.navigation.ref) {
			seeding = true;
			try {
				const artifact = await api.getArtifact(column.navigation.ref);
				seed = artifact.payload as unknown as NavigationDefinition;
			} catch {
				seed = null; // unknown/foreign ref: fall through to a fresh path
			} finally {
				seeding = false;
			}
		}
		const draft = ensureEmbeddedDraft(embId, seed ?? emptyRowPath(), {
			rowContext: true,
			rowElementId: sampleRowElementId
		});
		// Write the draft's (normalized) definition so the mirror effect's
		// reference-equality guard holds from the first render.
		onChange({ ...column, navigation: { definition: draft.definition } });
	}

	function switchToRef(): void {
		if (!inline) return;
		lastInline = column.navigation.definition ?? null;
		closeDraft(embId);
		onChange({ ...column, navigation: {} });
	}

	function setSourceKind(e: Event): void {
		const kind = (e.currentTarget as HTMLSelectElement).value;
		if (kind === 'row') onChange({ ...column, source: { kind: 'row', chain_index: 0 } });
		else {
			const index = priorColumns.length > 0 ? priorColumns.length - 1 : 0;
			onChange({ ...column, source: { kind: 'column', index } });
		}
	}
	function setSourceChainIndex(e: Event): void {
		const v = Number((e.currentTarget as HTMLInputElement).value) || 0;
		onChange({ ...column, source: { kind: 'row', chain_index: v } });
	}
	function setSourceColumnIndex(e: Event): void {
		const v = Number((e.currentTarget as HTMLSelectElement).value) || 0;
		onChange({ ...column, source: { kind: 'column', index: v } });
	}
	function setRef(e: Event): void {
		const ref = (e.currentTarget as HTMLSelectElement).value;
		onChange({ ...column, navigation: ref ? { ref } : {} });
	}
	function setStepIndex(e: Event): void {
		const raw = (e.currentTarget as HTMLInputElement).value.trim();
		onChange({ ...column, step_index: raw === '' ? null : Number(raw) });
	}
	function setSortMode(e: Event): void {
		const v = (e.currentTarget as HTMLSelectElement).value as NavColumn['sort_mode'];
		onChange({ ...column, sort_mode: v });
	}
	function setCellCap(e: Event): void {
		const v = Number((e.currentTarget as HTMLInputElement).value);
		onChange({ ...column, cell_cap: Number.isFinite(v) ? v : column.cell_cap });
	}
	function setMode(e: Event): void {
		const v = (e.currentTarget as HTMLSelectElement).value as NavColumn['mode'];
		onChange({ ...column, mode: v });
	}
	function setKeepEmpty(e: Event): void {
		onChange({ ...column, keep_empty: (e.currentTarget as HTMLInputElement).checked });
	}
</script>
```

Template — replace the `navigation` row (the `<div class="flex flex-wrap items-center gap-2">` containing the saved-nav `<select>` and step input) with:

```svelte
	<div class="flex flex-wrap items-center gap-2">
		<span class="text-muted-foreground/70">navigation</span>
		<div class="flex overflow-hidden rounded border border-input">
			<button
				type="button"
				data-testid="nav-mode-ref"
				class="px-1.5 py-0.5 {inline ? 'hover:bg-muted' : 'bg-muted font-medium'}"
				disabled={seeding}
				onclick={switchToRef}
			>
				saved
			</button>
			<button
				type="button"
				data-testid="nav-mode-inline"
				class="border-l border-input px-1.5 py-0.5 {inline
					? 'bg-muted font-medium'
					: 'hover:bg-muted'}"
				disabled={seeding}
				onclick={switchToInline}
			>
				inline
			</button>
		</div>
		{#if !inline}
			<select
				aria-label="Saved navigation for column"
				value={column.navigation.ref ?? ''}
				onchange={setRef}
				class="rounded border border-input bg-card px-1 py-0.5"
			>
				<option value="">Select a saved navigation…</option>
				{#each navHeaders as h (h.id)}
					<option value={h.id}>{h.name}</option>
				{/each}
			</select>
		{/if}
		<label class="flex items-center gap-1">
			step
			<input
				type="number"
				class="w-12 rounded border border-input bg-card px-1 py-0.5"
				value={column.step_index ?? ''}
				oninput={setStepIndex}
			/>
		</label>
	</div>
	{#if inline && embDraft}
		<div data-testid="inline-nav-editor" class="mt-1">
			<NavigationNode tabId={embId} path={[]} />
		</div>
	{/if}
```

`ColumnManager.svelte` — derive the sample row and pass it through (script additions):

```ts
	import { getTableDraft, getTablePage, updateTableDefinition } from '$lib/state';
	...
	// The table's first row element binds row-rooted inline-navigation
	// previews (RowStart needs a sample). key[0] is the base row element id
	// for every row-source kind; non-string (missing page / null slot) means
	// "no row" and the embedded editors show a hint instead of previewing.
	const page = $derived(getTablePage(tabId));
	const sampleRowElementId = $derived.by(() => {
		const k = page?.rows?.[0]?.key?.[0];
		return typeof k === 'string' ? k : null;
	});
```

and the render site:

```svelte
						{#if col.kind === 'navigation'}
							<NavigationColumnEditor
								column={col}
								columnIndex={i}
								columns={defn.columns}
								{sampleRowElementId}
								onChange={(next) => onColumnChange(i, next)}
							/>
						{/if}
```

Also rename `onNavColumnChange` → `onColumnChange` (it is column-kind-agnostic and Task 6 reuses it for property columns); update its doc comment's first line to "Whole-column field replacement for the per-column editors".

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/'`
Expected: PASS (new file + existing ColumnManager/TableGrid tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Table/NavigationColumnEditor.svelte frontend/src/lib/components/Table/ColumnManager.svelte frontend/src/lib/components/Table/__tests__/NavigationColumnEditor.test.ts
git commit -m "feat(frontend): inline navigation definitions in table navigation columns"
```

---

### Task 5: Inline navigation definitions in RowSourceEditor

**Files:**
- Modify: `frontend/src/lib/components/Table/RowSourceEditor.svelte`
- Test: Create `frontend/src/lib/components/Table/__tests__/RowSourceEditor.test.ts`

**Interfaces:**
- Consumes: same store surface as Task 4 (`ensureEmbeddedDraft` with `rowContext: false`), `emptyPath` from `$lib/navigation/tree`.
- Produces: mode buttons `data-testid="rowsource-mode-ref"` / `"rowsource-mode-inline"`; inline container `data-testid="inline-rowsource-editor"`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/components/Table/__tests__/RowSourceEditor.test.ts`:

```ts
// Inline-mode tests for the row-source editor. RowSourceEditor is NOT a
// controlled component — it calls updateTableDefinition directly — so these
// spy on the table-editor store like ColumnManager.test.ts does, while the
// navigation-editor store runs for real (embedded drafts).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as tableStore from '$lib/state/table-editor.svelte';
import {
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	setProjectInfo
} from '$lib/state';
import type { TableDefinition } from '$lib/api/types';
import RowSourceEditor from '../RowSourceEditor.svelte';

const CHAIN_PAGE = { step_types: [], chains: [], total: 0, truncated: false };

function defnWith(rowSource: TableDefinition['row_source']): TableDefinition {
	return {
		schema_version: 1,
		default_cell_mode: 'collapse',
		row_source: rowSource,
		columns: [
			{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null }
		]
	};
}

function render(defn: TableDefinition) {
	const c = mount(RowSourceEditor, { target: document.body, props: { tabId: 't', defn } });
	flushSync();
	return c;
}

function click(el: Element | null): void {
	if (!el) throw new Error('element not found');
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

beforeEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
});
afterEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('RowSourceEditor inline mode', () => {
	it('switching a navigation row source to inline seeds a scope-started path', async () => {
		const upd = vi.spyOn(tableStore, 'updateTableDefinition').mockImplementation(() => {});
		const c = render(defnWith({ kind: 'navigation', navigation: {}, step_index: null }));
		try {
			click(document.querySelector('[data-testid="rowsource-mode-inline"]'));
			await vi.waitFor(() => expect(upd).toHaveBeenCalled());
			const defn = upd.mock.calls.at(-1)![1] as TableDefinition;
			expect(defn.row_source).toMatchObject({
				kind: 'navigation',
				navigation: { definition: { kind: 'path', start: { kind: 'scope' } } }
			});
		} finally {
			unmount(c);
		}
	});

	it('renders the embedded builder for an inline row source', async () => {
		vi.spyOn(tableStore, 'updateTableDefinition').mockImplementation(() => {});
		const inline = {
			kind: 'path' as const,
			schema_version: 2,
			start: { kind: 'scope' as const, types: ['System'], criteria: [] },
			steps: [],
			exclude_visited: true
		};
		const c = render(defnWith({ kind: 'chains', navigation: { definition: inline } }));
		try {
			await vi.waitFor(() =>
				expect(document.querySelector('[data-testid="inline-rowsource-editor"]')).toBeTruthy()
			);
			// No row context: the start-mode select must NOT offer the row option.
			const select = document.querySelector('select[aria-label="Start mode"]')!;
			expect([...select.querySelectorAll('option')].map((o) => o.value)).not.toContain('row');
		} finally {
			unmount(c);
		}
	});

	it('switching back to saved clears the inline definition', async () => {
		const upd = vi.spyOn(tableStore, 'updateTableDefinition').mockImplementation(() => {});
		const inline = {
			kind: 'path' as const,
			schema_version: 2,
			start: { kind: 'scope' as const, types: [], criteria: [] },
			steps: [],
			exclude_visited: true
		};
		const c = render(defnWith({ kind: 'navigation', navigation: { definition: inline }, step_index: null }));
		try {
			await vi.waitFor(() =>
				expect(document.querySelector('[data-testid="inline-rowsource-editor"]')).toBeTruthy()
			);
			click(document.querySelector('[data-testid="rowsource-mode-ref"]'));
			const defn = upd.mock.calls.at(-1)![1] as TableDefinition;
			expect(defn.row_source).toMatchObject({ kind: 'navigation', navigation: {} });
		} finally {
			unmount(c);
		}
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/RowSourceEditor.test.ts'`
Expected: FAIL — no `rowsource-mode-inline` testid.

- [ ] **Step 3: Implement**

`RowSourceEditor.svelte` — full new script (the header comment's "Stage-2.1 deferral" note is now stale; replace it):

```svelte
<script lang="ts">
	// The row-source picker for a table definition: scope | navigation |
	// chains. `scope` reuses `ScopeEditor.svelte` directly — `ScopeRows` is
	// structurally identical to `NavScope`. `navigation`/`chains` carry a
	// NavigationSource: either a saved-navigation REF (a `<select>` over the
	// artifact library) or an INLINE definition edited with the real
	// navigation builder via an EMBEDDED draft (rowContext: false — a row
	// source defines the rows, so it keeps an ordinary Scope start and its
	// previews need no row binding).
	import { onDestroy } from 'svelte';
	import {
		closeDraft,
		ensureEmbeddedDraft,
		getArtifactHeaders,
		getDraft,
		updateTableDefinition
	} from '$lib/state';
	import { emptyPath } from '$lib/navigation/tree';
	import type { NavigationDefinition, RowSource, TableDefinition } from '$lib/api/types';
	import NavigationNode from '../Navigation/NavigationNode.svelte';
	import ScopeEditor from '../Navigation/ScopeEditor.svelte';

	let { tabId, defn }: { tabId: string; defn: TableDefinition } = $props();

	const rowSource = $derived(defn.row_source);
	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));

	const embId = `navemb:${crypto.randomUUID()}`;
	const inline = $derived(
		rowSource.kind !== 'scope' && rowSource.navigation.definition != null
	);
	const embDraft = $derived(getDraft(embId));

	// Kept while in ref mode so toggling doesn't lose an inline definition
	// within one mount. Only the active mode is written to the definition.
	let lastInline = $state<NavigationDefinition | null>(null);

	function apply(next: RowSource): void {
		updateTableDefinition(tabId, { ...defn, row_source: next });
	}

	// Lifecycle: an inline row source needs its embedded draft (a saved table
	// reopened with one in the payload); scope/ref modes must not leave one.
	$effect(() => {
		if (inline && rowSource.kind !== 'scope' && !getDraft(embId)) {
			ensureEmbeddedDraft(embId, rowSource.navigation.definition!, {
				rowContext: false,
				rowElementId: null
			});
		} else if (!inline && getDraft(embId)) {
			closeDraft(embId);
		}
	});

	// Mirror embedded-draft edits back into the row source (reference
	// equality is the loop guard, same as NavigationColumnEditor).
	$effect(() => {
		if (!inline || !embDraft || rowSource.kind === 'scope') return;
		if (embDraft.definition !== rowSource.navigation.definition) {
			apply({ ...rowSource, navigation: { definition: embDraft.definition } });
		}
	});

	onDestroy(() => closeDraft(embId));

	function switchToInline(): void {
		if (rowSource.kind === 'scope' || inline) return;
		const draft = ensureEmbeddedDraft(embId, lastInline ?? emptyPath(), {
			rowContext: false,
			rowElementId: null
		});
		apply({ ...rowSource, navigation: { definition: draft.definition } });
	}

	function switchToRef(): void {
		if (rowSource.kind === 'scope' || !inline) return;
		lastInline = rowSource.navigation.definition ?? null;
		closeDraft(embId);
		apply({ ...rowSource, navigation: {} });
	}

	function onKindChange(e: Event): void {
		const kind = (e.currentTarget as HTMLSelectElement).value;
		if (kind === 'scope') apply({ kind: 'scope', types: [], criteria: [] });
		else if (kind === 'navigation') apply({ kind: 'navigation', navigation: {}, step_index: null });
		else apply({ kind: 'chains', navigation: {} });
	}

	function onRefChange(e: Event): void {
		if (rowSource.kind === 'scope') return;
		const ref = (e.currentTarget as HTMLSelectElement).value;
		apply({ ...rowSource, navigation: ref ? { ref } : {} });
	}

	function onStepIndexChange(e: Event): void {
		if (rowSource.kind !== 'navigation') return;
		const raw = (e.currentTarget as HTMLInputElement).value.trim();
		apply({ ...rowSource, step_index: raw === '' ? null : Number(raw) });
	}
</script>
```

Template — replace the non-scope branch (`{:else} … {/if}`) with:

```svelte
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			<div class="flex overflow-hidden rounded border border-input text-[11px]">
				<button
					type="button"
					data-testid="rowsource-mode-ref"
					class="px-1.5 py-0.5 {inline ? 'hover:bg-muted' : 'bg-muted font-medium'}"
					onclick={switchToRef}
				>
					saved
				</button>
				<button
					type="button"
					data-testid="rowsource-mode-inline"
					class="border-l border-input px-1.5 py-0.5 {inline
						? 'bg-muted font-medium'
						: 'hover:bg-muted'}"
					onclick={switchToInline}
				>
					inline
				</button>
			</div>
			{#if !inline}
				<select
					aria-label="Saved navigation"
					value={rowSource.navigation.ref ?? ''}
					onchange={onRefChange}
					class="rounded border border-input bg-card px-1 py-0.5 text-xs"
				>
					<option value="">Select a saved navigation…</option>
					{#each navHeaders as h (h.id)}
						<option value={h.id}>{h.name}</option>
					{/each}
				</select>
			{/if}
			{#if rowSource.kind === 'navigation'}
				<label class="flex items-center gap-1 text-[11px] text-muted-foreground/70">
					step
					<input
						type="number"
						class="w-14 rounded border border-input bg-card px-1 py-0.5 text-xs"
						value={rowSource.step_index ?? ''}
						oninput={onStepIndexChange}
					/>
				</label>
			{/if}
		</div>
		{#if inline && embDraft}
			<div data-testid="inline-rowsource-editor" class="mt-1">
				<NavigationNode tabId={embId} path={[]} />
			</div>
		{/if}
	{/if}
```

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Table/RowSourceEditor.svelte frontend/src/lib/components/Table/__tests__/RowSourceEditor.test.ts
git commit -m "feat(frontend): inline navigation definitions in table row sources"
```

---

### Task 6: PropertyColumnEditor + add-then-edit property flow

**Files:**
- Create: `frontend/src/lib/components/Table/PropertyColumnEditor.svelte`
- Modify: `frontend/src/lib/components/Table/ColumnManager.svelte` (render editor; add-with-empty-name; drop the quick-add input)
- Test: Create `frontend/src/lib/components/Table/__tests__/PropertyColumnEditor.test.ts`; verify `ColumnManager.test.ts` still passes

**Interfaces:**
- Consumes: `getMetamodel` from `$lib/state`, `effectivePropertiesForTypes` from `$lib/metamodel/helpers`, `PropertyPicker` (`items: PropertyItem[]`, `onPick(name, datatype)`), `onColumnChange` from Task 4's rename.
- Produces: `PropertyColumnEditor` with props `{column, columnIndex, columns, rowSource, onChange}`; free-text input `aria-label="Property name"`; picker trigger `data-testid="property-pick-trigger"`. Task 7's e2e uses the aria-label.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/components/Table/__tests__/PropertyColumnEditor.test.ts`:

```ts
// The property-column editor: name (picker + free text), source, keep_empty —
// all editable after creation. Controlled component like
// NavigationColumnEditor; the metamodel store is mocked for picker scoping.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as modelState from '$lib/state/model.svelte';
import type { Column, RowSource } from '$lib/api/types';
import PropertyColumnEditor from '../PropertyColumnEditor.svelte';

type PropColumn = Extract<Column, { kind: 'property' }>;

const MM = {
	name: 'mm',
	elements: [
		{ name: 'Block', extends: null, abstract: false, properties: [{ name: 'mass', datatype: 'real' }], keys: [] },
		{ name: 'Other', extends: null, abstract: false, properties: [{ name: 'color', datatype: 'string' }], keys: [] }
	],
	relationships: []
};

function propColumn(name = ''): PropColumn {
	return {
		kind: 'property',
		source: { kind: 'row', chain_index: 0 },
		name,
		mode: 'collapse',
		keep_empty: true,
		header: '',
		width_px: null
	};
}

function render(column: PropColumn, rowSource: RowSource, onChange: (n: PropColumn) => void) {
	const c = mount(PropertyColumnEditor, {
		target: document.body,
		props: { column, columnIndex: 1, columns: [column], rowSource, onChange }
	});
	flushSync();
	return c;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('PropertyColumnEditor', () => {
	it('edits the property name as free text', () => {
		vi.spyOn(modelState, 'getMetamodel').mockReturnValue(null);
		const onChange = vi.fn();
		const c = render(propColumn('old'), { kind: 'scope', types: [], criteria: [] }, onChange);
		try {
			const input = document.querySelector('input[aria-label="Property name"]') as HTMLInputElement;
			expect(input.value).toBe('old');
			input.value = 'mass';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: 'mass' }));
		} finally {
			unmount(c);
		}
	});

	it('scopes picker suggestions to the scope row types for a row-slot source', () => {
		vi.spyOn(modelState, 'getMetamodel').mockReturnValue(MM as never);
		const onChange = vi.fn();
		const c = render(propColumn(), { kind: 'scope', types: ['Block'], criteria: [] }, onChange);
		try {
			(document.querySelector('[data-testid="property-pick-trigger"]') as HTMLElement).click();
			flushSync();
			expect(document.body.textContent).toContain('mass');
			expect(document.body.textContent).not.toContain('color');
		} finally {
			unmount(c);
		}
	});

	it('falls back to all properties when the source types are unknowable', () => {
		vi.spyOn(modelState, 'getMetamodel').mockReturnValue(MM as never);
		const onChange = vi.fn();
		const c = render(propColumn(), { kind: 'chains', navigation: {} }, onChange);
		try {
			(document.querySelector('[data-testid="property-pick-trigger"]') as HTMLElement).click();
			flushSync();
			expect(document.body.textContent).toContain('mass');
			expect(document.body.textContent).toContain('color');
		} finally {
			unmount(c);
		}
	});

	it('toggles keep_empty', () => {
		vi.spyOn(modelState, 'getMetamodel').mockReturnValue(null);
		const onChange = vi.fn();
		const c = render(propColumn(), { kind: 'scope', types: [], criteria: [] }, onChange);
		try {
			const box = document.querySelector(
				'[data-testid="property-column-editor"] input[type="checkbox"]'
			) as HTMLInputElement;
			box.click();
			flushSync();
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ keep_empty: false }));
		} finally {
			unmount(c);
		}
	});
});
```

Note: if `getMetamodel` lives in a different module than `$lib/state/model.svelte`, locate it with `grep -rn "export function getMetamodel" frontend/src/lib/state/` and adjust the import; mock whatever module actually exports it (spying on the barrel does not intercept the component's direct binding).

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/PropertyColumnEditor.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `PropertyColumnEditor.svelte`**

```svelte
<script lang="ts">
	// Per-column editor for a `property`-kind column: the property `name`
	// (searchable metamodel-aware picker + free text — free text covers
	// instance-only keys the metamodel doesn't declare), the column `source`
	// (mirrors NavigationColumnEditor), and `keep_empty`. Fully controlled:
	// emits a whole new column via `onChange`.
	import { getMetamodel } from '$lib/state';
	import { effectivePropertiesForTypes } from '$lib/metamodel/helpers';
	import { columnLabel } from '$lib/table/columns';
	import type { Column, RowSource } from '$lib/api/types';
	import type { PropertyItem } from '$lib/search/property-ops';
	import PropertyPicker from '../Sidebar/PropertyPicker.svelte';

	type PropColumn = Extract<Column, { kind: 'property' }>;

	let {
		column,
		columnIndex,
		columns,
		rowSource,
		onChange
	}: {
		column: PropColumn;
		columnIndex: number;
		columns: Column[];
		rowSource: RowSource;
		onChange: (next: PropColumn) => void;
	} = $props();

	const mm = $derived(getMetamodel());
	const priorColumns = $derived(columns.slice(0, columnIndex));

	// Suggestions scoped to the source's element types when knowable: a
	// row-slot source over scope rows narrows to the scope's types; anything
	// else (navigation/chains rows, earlier-column sources) falls back to the
	// union over all element types ([] = "any"). Typed free text always wins.
	const sourceTypes = $derived(
		column.source.kind === 'row' && rowSource.kind === 'scope' ? rowSource.types : []
	);
	const items = $derived<PropertyItem[]>(
		mm
			? effectivePropertiesForTypes(mm, sourceTypes).map((p) => ({
					name: p.name,
					datatype: p.datatype
				}))
			: []
	);

	let pickerOpen = $state(false);

	function setSourceKind(e: Event): void {
		const kind = (e.currentTarget as HTMLSelectElement).value;
		if (kind === 'row') onChange({ ...column, source: { kind: 'row', chain_index: 0 } });
		else {
			const index = priorColumns.length > 0 ? priorColumns.length - 1 : 0;
			onChange({ ...column, source: { kind: 'column', index } });
		}
	}
	function setSourceChainIndex(e: Event): void {
		const v = Number((e.currentTarget as HTMLInputElement).value) || 0;
		onChange({ ...column, source: { kind: 'row', chain_index: v } });
	}
	function setSourceColumnIndex(e: Event): void {
		const v = Number((e.currentTarget as HTMLSelectElement).value) || 0;
		onChange({ ...column, source: { kind: 'column', index: v } });
	}
	function setName(e: Event): void {
		onChange({ ...column, name: (e.currentTarget as HTMLInputElement).value });
	}
	function setKeepEmpty(e: Event): void {
		onChange({ ...column, keep_empty: (e.currentTarget as HTMLInputElement).checked });
	}
</script>

<div
	data-testid="property-column-editor"
	class="mt-1.5 space-y-1.5 rounded border border-border/60 bg-muted/30 p-2 text-[11px]"
>
	<div class="flex flex-wrap items-center gap-2">
		<span class="text-muted-foreground/70">source</span>
		<select
			aria-label="Column source kind"
			value={column.source.kind}
			onchange={setSourceKind}
			class="rounded border border-input bg-card px-1 py-0.5"
		>
			<option value="row">Row</option>
			<option value="column" disabled={priorColumns.length === 0}>Earlier column</option>
		</select>
		{#if column.source.kind === 'row'}
			<label class="flex items-center gap-1">
				chain
				<input
					type="number"
					class="w-12 rounded border border-input bg-card px-1 py-0.5"
					value={column.source.chain_index}
					oninput={setSourceChainIndex}
				/>
			</label>
		{:else}
			<select
				aria-label="Source column"
				value={column.source.index}
				onchange={setSourceColumnIndex}
				class="rounded border border-input bg-card px-1 py-0.5"
			>
				{#each priorColumns as c, i (i)}
					<option value={i}>{i}: {columnLabel(c)}</option>
				{/each}
			</select>
		{/if}
	</div>
	<div class="flex flex-wrap items-center gap-2">
		<span class="text-muted-foreground/70">property</span>
		<PropertyPicker
			{items}
			open={pickerOpen}
			onOpenChange={(o) => (pickerOpen = o)}
			onPick={(name) => onChange({ ...column, name })}
			searchPlaceholder="Filter properties…"
		>
			{#snippet trigger()}
				<span
					data-testid="property-pick-trigger"
					class="rounded border border-input px-1.5 py-0.5 hover:bg-muted"
				>
					pick…
				</span>
			{/snippet}
		</PropertyPicker>
		<input
			aria-label="Property name"
			class="w-32 rounded border border-input bg-card px-1.5 py-0.5"
			placeholder="property name"
			value={column.name}
			oninput={setName}
		/>
		<label class="flex items-center gap-1">
			<input type="checkbox" checked={column.keep_empty} onchange={setKeepEmpty} />
			keep empty
		</label>
	</div>
</div>
```

`ColumnManager.svelte`:

1. Import `PropertyColumnEditor` and render it under property columns (after the navigation block):

```svelte
						{#if col.kind === 'navigation'}
							<NavigationColumnEditor
								column={col}
								columnIndex={i}
								columns={defn.columns}
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
						{/if}
```

2. `addPropertyColumn` becomes add-then-edit (name set in the editor, matching the nav-column flow); delete the `newPropertyName` state, its stale "sanctioned shortcut" comment, and the `placeholder="property name"` quick-add `<input>` from the add-buttons row:

```ts
	function addPropertyColumn(): void {
		if (!defn) return;
		apply(
			addColumn(defn, {
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: '',
				mode: 'collapse',
				keep_empty: true,
				header: '',
				width_px: null
			})
		);
	}
```

- [ ] **Step 4: Run tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- src/lib/components/Table/__tests__/'`
Expected: PASS — including the existing `ColumnManager.test.ts` "adds a property column" test (it never used the quick-add input; it clicks the button directly).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Table/PropertyColumnEditor.svelte frontend/src/lib/components/Table/ColumnManager.svelte frontend/src/lib/components/Table/__tests__/PropertyColumnEditor.test.ts
git commit -m "feat(frontend): editable property columns with a metamodel-aware picker"
```

---

### Task 7: E2E coverage + full verification

**Files:**
- Modify: `frontend/e2e/table.spec.ts` (section 2 + header comment lines 37–38; new test)

**Interfaces:**
- Consumes: testids/labels from Tasks 4–6: `add-property-column`, `aria-label="Property name"`, `add-navigation-column`, `nav-mode-inline`, `inline-nav-editor`, `rowsource-mode-inline`, plus the existing nav-builder e2e interaction patterns already in this spec file (relationship picker, `✓ N chains` status text).

- [ ] **Step 1: Update the property-column section of the existing test**

In `frontend/e2e/table.spec.ts`, update the header comment (lines ~37–38) to describe the new flow, and replace section 2 (lines ~123–126):

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

- [ ] **Step 2: Add the inline-navigation e2e test**

Append a new test to `table.spec.ts` (the setup below is the existing test's section 1, inlined — same fixture facts documented in the file's header comment; the file-level `METAMODEL_PATH`/`MODEL_PATH`/`VIEW_PATH` constants and helper imports already exist):

```ts
test('inline navigation column and inline row source', async ({ page }) => {
	test.setTimeout(120_000);
	// Reload the fixtures: the suite shares one backend project across spec
	// files/tests (workers: 1), so state from the previous test must not be
	// assumed (same rationale as the first test's header comment).
	page.on('dialog', (dialog) => void dialog.accept());
	await openDefaultProject(page);
	await loadFiles(page, { metamodel: METAMODEL_PATH, model: MODEL_PATH, view: VIEW_PATH });
	await expect(page.getByText('live')).toBeVisible({ timeout: 60_000 });

	// --- Build a minimal navigation, then "Open as table" (mirrors test 1) ---
	await page.getByRole('button', { name: 'New navigation' }).click();
	const tabpanel = page.getByRole('tabpanel');
	const dock = tabpanel.getByTestId('results-dock');
	await expect(dock).toContainText('Pick what to start from');
	await tabpanel.getByText('any element', { exact: true }).click();
	await page.getByPlaceholder('Filter types…').fill('SoftwareSystem');
	await page.getByRole('checkbox', { name: 'SoftwareSystem', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(tabpanel.getByText('SoftwareSystem', { exact: true })).toBeVisible();
	await expect(dock).toContainText(/✓ \d+ chains/, { timeout: 15_000 });
	const openAsTableButton = tabpanel.getByRole('button', { name: 'Open as table' });
	await expect(openAsTableButton).toBeEnabled();
	await openAsTableButton.click();
	await expect(tabpanel.getByTestId('table-grid')).toBeVisible({ timeout: 15_000 });
	await expect(tabpanel.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });
	const header = tabpanel.getByTestId('table-header');

	// --- Inline navigation column ------------------------------------------
	const columnCountBefore = await header.locator('> div').count();
	await tabpanel.getByTestId('add-navigation-column').click();
	await expect(header.locator('> div')).toHaveCount(columnCountBefore + 1, { timeout: 10_000 });
	await tabpanel.getByTestId('nav-mode-inline').click();

	// The embedded builder appears with a row-rooted path ("each row's
	// element"); add a relationship step exactly like the standalone builder.
	const inlineEditor = tabpanel.getByTestId('inline-nav-editor');
	await expect(inlineEditor).toBeVisible();
	await expect(inlineEditor).toContainText("each row's element");
	await inlineEditor.getByRole('button', { name: '+ Follow a relationship' }).click();
	await inlineEditor.getByText('pick a relationship…', { exact: true }).click();
	await page.getByPlaceholder('Relationship type…').fill('SystemContainsComponent');
	await page.getByRole('button', { name: 'SystemContainsComponent', exact: true }).click();

	// The embedded status chip previews against the table's first row.
	await expect(inlineEditor.getByTestId('status-chip')).toContainText(/✓ \d+ chains/, {
		timeout: 15_000
	});
	// And the grid itself re-evaluated with the inline definition.
	await expect(tabpanel.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });

	// --- Inline row source ---------------------------------------------------
	// Switch the rows to an inline chains navigation: the seed is an empty
	// scope-started path, which evaluates to one chain per element — rows
	// appear without further editing.
	await tabpanel.getByLabel('Row source kind').selectOption('chains');
	await tabpanel.getByTestId('rowsource-mode-inline').click();
	await expect(tabpanel.getByTestId('inline-rowsource-editor')).toBeVisible();
	await expect(tabpanel.getByTestId('table-row').first()).toBeVisible({ timeout: 15_000 });
});
```

Adapt locators to the actual DOM while implementing (e.g. the exact tabpanel locator name used at the top of the file) — the interaction sequence and assertions above are the contract. Note the row-source switch drops the earlier columns' meaning (chains of length 1); that is fine — the assertion is only that rows render.

- [ ] **Step 3: Run the e2e suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e -- table.spec.ts'`
Expected: PASS (playwright boots backend + dev server itself). If the inline test flakes on the relationship picker, mirror the exact waits the existing test uses around the same picker.

- [ ] **Step 4: Full verification**

```bash
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
pixi run tidy
```

Expected: vitest suite green; `check` reports no NEW errors vs. main; `tidy` clean (re-run `git diff` after tidy — commit any formatting it applied).

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/table.spec.ts
git commit -m "test(frontend): e2e inline navigation column, inline row source, property edit"
```

---

## Self-review notes (already applied)

- **Spec coverage:** §1 groundwork → Task 1 + Task 3; §2 embedded drafts → Task 2; §3 inline in column/row-source → Tasks 4–5; §4 property editor + add-then-edit → Task 6; §5 testing → per-task tests + Task 7. Out-of-scope items untouched.
- **Type consistency:** `EmbeddedContext {rowContext, rowElementId}` used identically in Tasks 2–5; `ensureEmbeddedDraft(id, definition, ctx)` signature consistent; `onColumnChange` rename happens in Task 4 and is consumed in Task 6; `emptyRowPath`/`containsRowStart` defined in Task 1, consumed in 2–4.
- **Known judgment calls an implementer should preserve:** runPreview's no-row skip is quiet (no eval-error) because StatusChip's `needsRow` derives from the same predicate; the mirror `$effect`s rely on reference equality of the definition object surviving ColumnManager's `structuredClone(defn)` — the clone happens BEFORE the new column is spliced in (`clone.columns[index] = next`), so the mirrored definition object is preserved by construction. Do not "fix" either.
