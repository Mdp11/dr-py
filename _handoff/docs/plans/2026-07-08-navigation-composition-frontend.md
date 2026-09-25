# Navigation Composition + Step-Model — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Start only after the backend plan is fully green** (schema v2 + evaluator committed).

**Goal:** Replace the navigation builder with a self-contained recursive composition tree — inline nested navigations combined by N-ary operators, per-node collapsible previews, three-mode starts (filter / specific element / combination), the two-kind step editor (relationship / filter), and Save-as.

**Architecture:** A single recursive `NavigationNode.svelte` renders every node (a Path leaf or a Combine node). Pure tree helpers (`lib/navigation/tree.ts`) address nodes by positional `NodePath` and do immutable updates, auto-wrap/unwrap, and label derivation. `navigation-editor.svelte.ts` keeps its load-bearing invariants (generation guard, debounce, eval-error surfacing) but re-keys preview state per node. The step editor splits into `RelationshipStepRow` and `FilterStepRow`; filter property pickers are scoped to the union of effective properties over the reachable types.

**Tech Stack:** SvelteKit + Svelte 5 runes, TypeScript, Zod, vitest (happy-dom + MSW), Playwright.

## Global Constraints

- Frontend commands MUST run from inside `frontend/`:
  - `pixi run -e frontend bash -c 'cd frontend && npm test -- <pattern>'`
  - `pixi run -e frontend bash -c 'cd frontend && npm run check'`
  - `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e -- navigation.spec.ts'`
  - The bare `pixi run -e frontend npm test` FAILS (wrong cwd).
- `pixi run tidy` must be green before any "done" claim; revert reformats of files this branch never touched (pre-existing drift).
- Commit trailer: every commit ends with a blank line then exactly `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `feat/stage1-navigation` (continue on it).
- **Read `frontend/README.md` before touching `frontend/src/lib/state/`** (it documents the optimistic-ops/state invariants).
- IDE `<new-diagnostics>` about unresolved `$lib/*` or "no exported member" on `*.svelte.ts` are out-of-env noise; `npm run check` is the authoritative gate.
- Zero schema change beyond the step union already shipped by the backend plan; the transport zod schema in `types.ts` stays permissive (`z.unknown()` for steps/operands).
- Known pre-existing noise (not this branch): `SwapMetamodelDrawer.test.ts` teardown flake in full-suite runs only (isolated run clean).

## File structure

- `lib/api/types.ts` — v2 step union types; transport schema default `schema_version` → 2.
- `lib/navigation/tree.ts` **(new)** — `NodePath`, `nodeAt`, `updateNodeAt`, `insertNavigation`, `insertGroup`, `removeOperand`, `moveOperand`, `wrapRoot`, `unwrapSingleton`, `nodeLabel`, `isRunnable`, `emptyPath`, `emptyCombine`, `elementStartScope`/`readElementStart`.
- `lib/metamodel/helpers.ts` — add `effectivePropertiesForTypes(mm, typeNames)`.
- `lib/state/navigation-editor.svelte.ts` — per-node preview keying; expand/collapse; `saveAsDraft`.
- `lib/components/Navigation/NavigationNode.svelte` **(new)** — recursive node renderer.
- `lib/components/Navigation/CombineEditor.svelte` **(new)** — operator + operand list (replaces `SetExpressionEditor.svelte`, which is deleted).
- `lib/components/Navigation/PathLeafEditor.svelte` **(new)** — start-mode block + step list.
- `lib/components/Navigation/ElementStartPicker.svelte` **(new)** — element typeahead.
- `lib/components/Navigation/RelationshipStepRow.svelte` **(new)** — replaces `StepRow.svelte`.
- `lib/components/Navigation/FilterStepRow.svelte` **(new)**.
- `lib/components/Navigation/ChainPreview.svelte` — per-node preview panel.
- `lib/components/Navigation/NavigationBuilder.svelte` — drop the toggle; render root node; Save + Save-as.
- `lib/components/Sidebar/CriterionRow.svelte` — add optional `propertyNames` prop.

---

### Task 1: v2 types + pure tree helpers + property helper

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (nav types + transport default)
- Create: `frontend/src/lib/navigation/tree.ts`
- Modify: `frontend/src/lib/metamodel/helpers.ts` (add one function)
- Create/Test: `frontend/src/lib/navigation/__tests__/tree.test.ts`
- Test: `frontend/src/lib/metamodel/helpers.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `type NavRelationshipStep = { kind: 'relationship'; relationship_type: string; direction: NavDirection; target_types: string[]; children: NavStepItem[] }`
  - `type NavFilterStep = { kind: 'filter'; criteria: unknown[] }`
  - `type NavStepItem = NavRelationshipStep | NavFilterStep`
  - `PathNavigation.steps: NavStepItem[]`
  - `type NodePath = ReadonlyArray<number | 'start'>`; `pathKey(p): string`
  - `nodeAt(root, path): NavigationDefinition | null`
  - `updateNodeAt(root, path, fn): NavigationDefinition`
  - `insertNavigation(root, path)`, `insertGroup(root, path)`, `removeOperand(root, path, i)`, `moveOperand(root, path, i, dir)` all `: NavigationDefinition`
  - `nodeLabel(defn, mm): string`
  - `isRunnable(defn): boolean` (moved from state)
  - `effectivePropertiesForTypes(mm, typeNames: string[]): PropertyDef[]`

- [ ] **Step 1: Write the failing tree-helper tests**

Create `frontend/src/lib/navigation/__tests__/tree.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	emptyPath,
	emptyCombine,
	insertNavigation,
	moveOperand,
	nodeAt,
	pathKey,
	removeOperand,
	updateNodeAt,
	wrapRoot
} from '../tree';
import type { PathNavigation, SetExpression } from '$lib/api/types';

describe('node addressing', () => {
	it('pathKey stringifies positional paths', () => {
		expect(pathKey([])).toBe('');
		expect(pathKey([1, 'start', 0])).toBe('1.start.0');
	});

	it('nodeAt descends operands and start slots', () => {
		const inner = emptyPath();
		const root: SetExpression = {
			kind: 'set_op', schema_version: 2, op: 'union',
			operands: [{ definition: inner, step_index: null }]
		};
		expect(nodeAt(root, [])).toBe(root);
		expect(nodeAt(root, [0])).toEqual(inner);
	});
});

describe('composition mutators', () => {
	it('wrapRoot turns a bare path into a 2-operand union', () => {
		const p = emptyPath();
		const wrapped = wrapRoot(p) as SetExpression;
		expect(wrapped.kind).toBe('set_op');
		expect(wrapped.op).toBe('union');
		expect(wrapped.operands).toHaveLength(2);
		expect(wrapped.operands[0].definition).toEqual(p);
	});

	it('insertNavigation on a bare-path root auto-wraps', () => {
		const next = insertNavigation(emptyPath(), []) as SetExpression;
		expect(next.kind).toBe('set_op');
		expect(next.operands).toHaveLength(2);
	});

	it('insertNavigation on a combine appends an operand (N-ary)', () => {
		const c = emptyCombine();
		const next = insertNavigation(c, []) as SetExpression;
		expect(next.operands).toHaveLength(c.operands.length + 1);
	});

	it('removeOperand down to one auto-unwraps to the child', () => {
		const c = emptyCombine(); // 2 operands
		const next = removeOperand(c, [], 1);
		expect(next.kind).toBe('path'); // unwrapped
	});

	it('moveOperand reorders within a combine', () => {
		const c = emptyCombine();
		c.operands[0].step_index = 7;
		const next = moveOperand(c, [], 0, 'down') as SetExpression;
		expect(next.operands[1].step_index).toBe(7);
	});

	it('updateNodeAt rebuilds immutably along the path', () => {
		const c = emptyCombine();
		const next = updateNodeAt(c, [0], (n) => ({ ...(n as PathNavigation), exclude_visited: false }));
		expect((next as SetExpression).operands[0].definition).not.toBe(c.operands[0].definition);
		expect(c).toEqual(emptyCombine()); // original untouched
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- tree.test'`
Expected: FAIL — cannot resolve `../tree`.

- [ ] **Step 3: Add the v2 step types to `types.ts`**

Replace the `NavStep` interface (lines ~380–385) and update `PathNavigation.steps`:

```ts
export interface NavRelationshipStep {
	kind: 'relationship';
	relationship_type: string;
	direction: NavDirection;
	target_types: string[];
	children: NavStepItem[];
}

export interface NavFilterStep {
	kind: 'filter';
	criteria: unknown[]; // search Criterion objects; typed at the editor layer
}

export type NavStepItem = NavRelationshipStep | NavFilterStep;

export interface PathNavigation {
	kind: 'path';
	schema_version: number;
	start: NavScope | SetExpression;
	steps: NavStepItem[];
	exclude_visited: boolean;
}
```

In `NavigationDefinitionSchema`, change both `schema_version` defaults from `.default(1)` to `.default(2)`. Leave `steps`/`operands` as `z.array(z.unknown())` (the editor constructs values directly).

- [ ] **Step 4: Add `effectivePropertiesForTypes` to `helpers.ts`**

Append to `frontend/src/lib/metamodel/helpers.ts`:

```ts
/**
 * Union of effective (inherited) properties across `typeNames` AND their
 * subtypes. `[]` means "any type" → union over every element type. Deduped by
 * name (first occurrence wins; order is stable for form rendering). Used to
 * scope a navigation filter step's property picker to the properties reachable
 * at that point — offered as a union because navigation property matching is
 * existence-gated (an element lacking a picked property simply drops out).
 */
export function effectivePropertiesForTypes(
	mm: Metamodel,
	typeNames: string[]
): PropertyDef[] {
	const roots = typeNames.length === 0 ? mm.elements.map((e) => e.name) : typeNames;
	// Expand each requested type to itself + all its subtypes.
	const reachable = new Set<string>();
	for (const t of mm.elements) {
		if (roots.some((r) => isSubtype(mm, t.name, r))) reachable.add(t.name);
	}
	const byName = new Map<string, PropertyDef>();
	for (const name of reachable) {
		for (const p of effectiveProperties(mm, name)) {
			if (!byName.has(p.name)) byName.set(p.name, p);
		}
	}
	return [...byName.values()];
}
```

(`Metamodel`, `PropertyDef`, `effectiveProperties`, `isSubtype` are already in this module / its imports.)

- [ ] **Step 5: Create `lib/navigation/tree.ts`**

```ts
/**
 * Pure helpers over a NavigationDefinition tree: positional node addressing,
 * immutable updates, composition mutators (auto-wrap / auto-unwrap / N-ary
 * insert / reorder), and auto-derived node labels. No Svelte, no I/O — fully
 * unit-testable. Node addresses are POSITIONAL (NodePath): a number descends
 * into operands[i].definition, 'start' descends into a Path's start.
 */
import type {
	NavOperand,
	NavigationDefinition,
	PathNavigation,
	SetExpression
} from '$lib/api/types';

export type NodePath = ReadonlyArray<number | 'start'>;

export function pathKey(path: NodePath): string {
	return path.join('.');
}

export function emptyPath(): PathNavigation {
	return {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'scope', types: [], criteria: [] },
		steps: [],
		exclude_visited: true
	};
}

export function emptyCombine(): SetExpression {
	return {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: emptyPath(), step_index: null },
			{ definition: emptyPath(), step_index: null }
		]
	};
}

/** Descend a positional path. Returns the addressed sub-definition, or null
 * for a ref operand / out-of-range / a scope start (not a node). */
export function nodeAt(root: NavigationDefinition, path: NodePath): NavigationDefinition | null {
	let node: NavigationDefinition | null = root;
	for (const seg of path) {
		if (node === null) return null;
		if (seg === 'start') {
			if (node.kind !== 'path') return null;
			node = node.start.kind === 'set_op' ? (node.start as SetExpression) : null;
		} else {
			if (node.kind !== 'set_op') return null;
			node = node.operands[seg]?.definition ?? null;
		}
	}
	return node;
}

/** Immutable update: rebuild spread-copies along `path`, applying `fn` at the
 * addressed node. Unknown/invalid paths return `root` unchanged. */
export function updateNodeAt(
	root: NavigationDefinition,
	path: NodePath,
	fn: (n: NavigationDefinition) => NavigationDefinition
): NavigationDefinition {
	if (path.length === 0) return fn(root);
	const [seg, ...rest] = path;
	if (seg === 'start') {
		if (root.kind !== 'path' || root.start.kind !== 'set_op') return root;
		return { ...root, start: updateNodeAt(root.start, rest, fn) as SetExpression };
	}
	if (root.kind !== 'set_op') return root;
	const child = root.operands[seg]?.definition;
	if (!child) return root;
	const operands = root.operands.map((op, i): NavOperand =>
		i === seg ? { ...op, definition: updateNodeAt(child, rest, fn) } : op
	);
	return { ...root, operands };
}

/** Wrap a definition into a 2-operand union with a fresh empty second operand. */
export function wrapRoot(defn: NavigationDefinition): SetExpression {
	return {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: defn, step_index: null },
			{ definition: emptyPath(), step_index: null }
		]
	};
}

/** A combine node reduced to one operand collapses to that operand's child
 * (or ref → left as a 1-operand set, since a bare ref is not a definition). */
function unwrapSingleton(node: SetExpression): NavigationDefinition {
	if (node.operands.length === 1 && node.operands[0].definition) {
		return node.operands[0].definition;
	}
	return node;
}

/** Insert an empty Path operand at `path`. On a bare-Path node, auto-wrap. */
export function insertNavigation(root: NavigationDefinition, path: NodePath): NavigationDefinition {
	return updateNodeAt(root, path, (n) => {
		if (n.kind === 'path') return wrapRoot(n);
		return { ...n, operands: [...n.operands, { definition: emptyPath(), step_index: null }] };
	});
}

/** Insert an empty Combine group operand at `path` (auto-wrap on a bare Path). */
export function insertGroup(root: NavigationDefinition, path: NodePath): NavigationDefinition {
	return updateNodeAt(root, path, (n) => {
		if (n.kind === 'path') {
			return { ...wrapRoot(n), operands: [
				{ definition: n, step_index: null },
				{ definition: emptyCombine(), step_index: null }
			] };
		}
		return { ...n, operands: [...n.operands, { definition: emptyCombine(), step_index: null }] };
	});
}

/** Add a ref operand at `path` (auto-wrap on a bare Path). */
export function insertRef(root: NavigationDefinition, path: NodePath, ref: string): NavigationDefinition {
	return updateNodeAt(root, path, (n) => {
		if (n.kind === 'path') {
			return { ...wrapRoot(n), operands: [
				{ definition: n, step_index: null },
				{ ref, step_index: null }
			] };
		}
		return { ...n, operands: [...n.operands, { ref, step_index: null }] };
	});
}

/** Remove operand `i` from the combine at `path`; auto-unwrap to one child. */
export function removeOperand(root: NavigationDefinition, path: NodePath, i: number): NavigationDefinition {
	return updateNodeAt(root, path, (n) => {
		if (n.kind !== 'set_op') return n;
		const operands = n.operands.filter((_, idx) => idx !== i);
		return unwrapSingleton({ ...n, operands });
	});
}

/** Move operand `i` up/down within the combine at `path`. */
export function moveOperand(
	root: NavigationDefinition,
	path: NodePath,
	i: number,
	dir: 'up' | 'down'
): NavigationDefinition {
	return updateNodeAt(root, path, (n) => {
		if (n.kind !== 'set_op') return n;
		const j = dir === 'up' ? i - 1 : i + 1;
		if (j < 0 || j >= n.operands.length) return n;
		const operands = [...n.operands];
		[operands[i], operands[j]] = [operands[j], operands[i]];
		return { ...n, operands };
	});
}
```

Add label + runnable helpers to the same file:

```ts
const OP_GLYPH: Record<SetExpression['op'], string> = {
	union: '∪', intersection: '∩', difference: '−', symmetric_difference: '⊕'
};

/** Auto-derived collapsed-node summary (no schema field). */
export function nodeLabel(defn: NavigationDefinition): string {
	if (defn.kind === 'set_op') return `${OP_GLYPH[defn.op]} of ${defn.operands.length}`;
	const startTypes = defn.start.kind === 'scope' ? defn.start.types : [];
	const head =
		defn.start.kind === 'set_op'
			? '(combination)'
			: startTypes.length
				? startTypes.join('/')
				: 'Any';
	const hops = defn.steps
		.filter((s): s is Extract<typeof s, { kind: 'relationship' }> => s.kind === 'relationship')
		.map((s) => s.relationship_type || '?');
	return [head, ...hops].join(' → ');
}

/** Label for one operand (ref → its saved name resolved by the caller). */
export function operandLabel(op: NavOperand, refName?: string): string {
	if (op.ref) return `(ref) ${refName ?? op.ref}`;
	return op.definition ? nodeLabel(op.definition) : '(empty)';
}

/** True when a definition is complete enough to evaluate. A set-op needs ≥1
 * operand; a path needs every relationship step to have a relationship_type and
 * must not be a pristine empty draft. */
export function isRunnable(defn: NavigationDefinition): boolean {
	if (defn.kind === 'set_op') return defn.operands.length > 0;
	if (defn.steps.some((s) => s.kind === 'relationship' && !s.relationship_type)) return false;
	const { start } = defn;
	const pristine =
		start.kind === 'scope' && start.types.length === 0 && start.criteria.length === 0;
	return !(pristine && defn.steps.length === 0);
}
```

Add the element-start helpers:

```ts
import type { NavScope } from '$lib/api/types';

/** A Scope selecting exactly one element by id (Specific-element start). */
export function elementStartScope(elementId: string): NavScope {
	return {
		kind: 'scope',
		types: [],
		criteria: [{ type: 'name_id', field: 'id', op: 'equals', value: elementId }]
	};
}

/** If `scope` is an element-start (empty types + one id-equals criterion),
 * return the element id; else null (→ the editor shows Filter mode). */
export function readElementStart(scope: NavScope): string | null {
	if (scope.types.length !== 0 || scope.criteria.length !== 1) return null;
	const c = scope.criteria[0] as { type?: string; field?: string; op?: string; value?: string };
	return c.type === 'name_id' && c.field === 'id' && c.op === 'equals' ? (c.value ?? '') : null;
}
```

- [ ] **Step 6: Run tree tests to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- tree.test'`
Expected: PASS.

- [ ] **Step 7: Add a property-scoping test to `helpers.test.ts`**

Append (adapt the fixture-builder name to the one already used in the file):

```ts
it('effectivePropertiesForTypes unions props over subtypes; [] = all', () => {
	// mm: Component (abstract) with prop `cost`; Service extends Component adds `sla`.
	const named = effectivePropertiesForTypes(mm, ['Component']).map((p) => p.name);
	expect(named).toContain('cost'); // own
	expect(named).toContain('sla'); // subtype-only, unioned
	const all = effectivePropertiesForTypes(mm, []).map((p) => p.name);
	expect(all).toContain('cost');
});
```

- [ ] **Step 8: Run helper tests + check + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- tree.test helpers.test && npm run check'`
Expected: PASS, check 0 errors.

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/navigation/ frontend/src/lib/metamodel/helpers.ts frontend/src/lib/metamodel/helpers.test.ts
git commit -m "$(cat <<'EOF'
feat(navigation): v2 step types + pure composition-tree helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Per-node preview keying in the editor state

**Files:**
- Modify: `frontend/src/lib/state/navigation-editor.svelte.ts`
- Modify: `frontend/src/lib/state/__tests__/navigation-editor.test.ts`
- Modify: `frontend/README.md` (navigation-state section: per-node keying note)

**Interfaces:**
- Consumes: `pathKey`, `nodeAt`, `isRunnable` from `lib/navigation/tree.ts`; `api.evaluateNavigation`.
- Produces (public accessors, now node-scoped where noted):
  - `getPreview(tabId, path): NavPreview | undefined`
  - `getEvalError(tabId, path): boolean`
  - `isExpanded(tabId, path): boolean`; `toggleExpanded(tabId, path): void`
  - `runPreview(tabId, path): Promise<void>`; `loadMorePreview(tabId, path): Promise<void>`
  - `updateDefinition(tabId, defn)` unchanged signature (now re-keys per node)
  - existing `getDraft/ensureDraft/setDraftName/saveDraft/reloadDraft/closeDraft/resetNavigationEditors/getSaveConflict` unchanged signatures

- [ ] **Step 1: Write the failing state tests**

In `navigation-editor.test.ts`, add deferred-promise tests for node-scoped previews (mirror the existing generation-guard pattern already in the file):

```ts
it('runs a preview for the root node and stores it under the root key', async () => {
	const tabId = 'nav:draft:1';
	await ensureDraft(tabId);
	updateDefinition(tabId, runnablePath()); // helper: a path with one complete rel step
	toggleExpanded(tabId, []); // expand root
	await flushEvaluate(); // resolves the MSW/deferred evaluate
	expect(getPreview(tabId, [])).toBeDefined();
});

it('collapsing a node drops its preview and cancels its timer', async () => {
	const tabId = 'nav:draft:2';
	await ensureDraft(tabId);
	updateDefinition(tabId, runnablePath());
	toggleExpanded(tabId, []);
	await flushEvaluate();
	toggleExpanded(tabId, []); // collapse
	expect(getPreview(tabId, [])).toBeUndefined();
});

it('a stale evaluate response for an edited node is dropped', async () => {
	// Use the deferred-promise harness already in this file: start a run, edit
	// the definition (bumps the node generation), then resolve the old promise.
	// Assert the preview is NOT the stale payload.
});
```

Add whatever small helpers (`runnablePath`, `flushEvaluate`) the file's existing tests use; if none, define `runnablePath()` returning a path with `start.types=['Component']` and one `{kind:'relationship', relationship_type:'Uses', direction:'out', target_types:[], children:[]}` step.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- navigation-editor.test'`
Expected: FAIL — `getPreview`/`toggleExpanded` arity/signature mismatch.

- [ ] **Step 3: Re-key the state module**

Rewrite the internal maps and public functions of `navigation-editor.svelte.ts` to be node-scoped. Key everything by `previewKey(tabId, path) = ${tabId}::${pathKey(path)}`:

```ts
import { pathKey, nodeAt, isRunnable } from '$lib/navigation/tree';

function previewKey(tabId: string, path: NodePath): string {
	return `${tabId}::${pathKey(path)}`;
}
```

- `_previews`, `_evalErrors`, `_generations`, `_debounceTimers` become keyed by `previewKey`. Add `_expanded: SvelteMap<string, SvelteSet<string>>` (tabId → set of pathKeys), and `_conflicts` stays keyed by `tabId` (save conflict is per-draft).
- `bumpGeneration`, `isCurrent`, `cancelAutoRun`, `scheduleAutoRun` take a full `previewKey` string.
- `runPreview(tabId, path)` / `loadMorePreview(tabId, path)`: evaluate `nodeAt(draft.definition, path)` (fall back to the whole definition when `path === []`); for a `ref` operand path, evaluate `{ artifact_id: op.ref }` — but `nodeAt` returns null for refs, so guard and skip refs (refs get no per-node preview in this iteration; note it). All generation/staleness logic keyed by `previewKey`, same discipline as today.
- `updateDefinition(tabId, defn)`: set the draft, then for **every expanded path of this tab**, if the node at that path still exists, bump its generation, clear its preview + eval-error, and reschedule its debounced run (via `scheduleAutoRun(previewKey)` reading `nodeAt(currentDraft, path)` at fire time). Paths whose node no longer exists are removed from the expanded set and their keys cleared.
- `toggleExpanded(tabId, path)`: flip membership in `_expanded[tabId]`; on expand, immediately schedule/run the node's preview if `isRunnable(nodeAt(defn, path))`; on collapse, cancel the timer and delete the preview/eval-error keys.
- `ensureDraft`: after loading a saved artifact, mark the root path `[]` expanded and run it if runnable (root expanded by default).
- `closeDraft`/`resetNavigationEditors`: clear all keys for the tab (iterate `_expanded[tabId]` plus any lingering keys), cancel all timers, delete the expanded set, bump generations.
- `getPreview(tabId, path)`/`getEvalError(tabId, path)`/`isExpanded(tabId, path)`: read by `previewKey`.

Preserve every docstring invariant from the current module; extend them to note the per-node keying. Update the `$lib/state` barrel export (`frontend/src/lib/state/index.ts`) for any renamed/changed signatures.

- [ ] **Step 4: Run state tests to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- navigation-editor.test'`
Expected: PASS.

- [ ] **Step 5: Document + check + commit**

Update the navigation-state section of `frontend/README.md` to describe per-node preview keying (`${tabId}::${nodePath}`, expand-to-run, collapse-drops).

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors.

```bash
git add frontend/src/lib/state/navigation-editor.svelte.ts frontend/src/lib/state/__tests__/navigation-editor.test.ts frontend/src/lib/state/index.ts frontend/README.md
git commit -m "$(cat <<'EOF'
feat(navigation): per-node preview state keyed by node path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Recursive node + Combine editor + builder rework

**Files:**
- Create: `frontend/src/lib/components/Navigation/NavigationNode.svelte`
- Create: `frontend/src/lib/components/Navigation/CombineEditor.svelte`
- Create: `frontend/src/lib/components/Navigation/PathLeafEditor.svelte` (start block stubbed until Task 4; step list stubbed until Task 5)
- Modify: `frontend/src/lib/components/Navigation/NavigationBuilder.svelte`
- Delete: `frontend/src/lib/components/Navigation/SetExpressionEditor.svelte`
- Create/Test: `frontend/src/lib/components/Navigation/__tests__/combine-editor.test.ts`

**Interfaces:**
- Consumes: tree helpers (Task 1); `updateDefinition`, `getDraft`, `isExpanded`, `toggleExpanded` (Task 2); `getArtifactHeaders`, `canEdit` from `$lib/state`.
- Produces: `NavigationNode` prop `{ tabId: string; path: NodePath }`; renders the node at `path` and dispatches mutations through `updateDefinition(tabId, updateNodeAt(...))`.

- [ ] **Step 1: Write the failing combine-editor tests**

Create `combine-editor.test.ts` that renders `NavigationNode` on a combine root and drives its buttons (mirror the existing DnD/component test setup in the repo — MSW + happy-dom):

```ts
it('insert navigation appends an operand', async () => { /* click "+ insert navigation", assert draft operands length +1 */ });
it('remove operand down to one auto-unwraps to a bare path', async () => { /* remove, assert getDraft().definition.kind === 'path' */ });
it('reorder moves an operand', async () => { /* click ↓, assert order swapped */ });
it('difference node labels operand 0 as base', async () => { /* set op=difference, assert "base" text present */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- combine-editor.test'`
Expected: FAIL — components not found.

- [ ] **Step 3: Create `NavigationNode.svelte`**

```svelte
<script lang="ts">
	import { getDraft, updateDefinition } from '$lib/state';
	import { nodeAt } from '$lib/navigation/tree';
	import type { NodePath } from '$lib/navigation/tree';
	import CombineEditor from './CombineEditor.svelte';
	import PathLeafEditor from './PathLeafEditor.svelte';

	let { tabId, path }: { tabId: string; path: NodePath } = $props();
	const draft = $derived(getDraft(tabId));
	const node = $derived(draft ? nodeAt(draft.definition, path) : null);
</script>

{#if node?.kind === 'set_op'}
	<CombineEditor {tabId} {path} node={node} />
{:else if node?.kind === 'path'}
	<PathLeafEditor {tabId} {path} node={node} />
{/if}
```

- [ ] **Step 4: Create `CombineEditor.svelte`**

```svelte
<script lang="ts">
	import { Trash2, ChevronUp, ChevronDown } from '@lucide/svelte';
	import { canEdit, getArtifactHeaders, isExpanded, toggleExpanded, updateDefinition, getDraft } from '$lib/state';
	import {
		insertGroup, insertNavigation, insertRef, moveOperand, operandLabel, removeOperand, pathKey
	} from '$lib/navigation/tree';
	import type { NodePath } from '$lib/navigation/tree';
	import type { NavOperand, SetExpression } from '$lib/api/types';
	import NavigationNode from './NavigationNode.svelte';
	import ChainPreview from './ChainPreview.svelte';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';

	let { tabId, path, node }: { tabId: string; path: NodePath; node: SetExpression } = $props();
	const editable = $derived(canEdit());
	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));
	const draft = $derived(getDraft(tabId));
	let addOpen = $state(false);

	function mutate(next: (root: import('$lib/api/types').NavigationDefinition) => import('$lib/api/types').NavigationDefinition) {
		if (!draft) return;
		updateDefinition(tabId, next(draft.definition));
	}
	function setOp(op: SetExpression['op']) {
		mutate((root) => updateNodeAtLocal(root, path, (n) => ({ ...(n as SetExpression), op })));
	}
	function setStepIndex(i: number, raw: string) {
		mutate((root) => updateNodeAtLocal(root, path, (n) => {
			const s = n as SetExpression;
			const operands = s.operands.map((op, idx): NavOperand =>
				idx === i ? { ...op, step_index: raw === '' ? null : Number(raw) } : op);
			return { ...s, operands };
		}));
	}
	function refName(op: NavOperand): string | undefined {
		return op.ref ? navHeaders.find((h) => h.id === op.ref)?.name : undefined;
	}
</script>
```

Import `updateNodeAt as updateNodeAtLocal` from the tree module at the top. Template:

```svelte
<div class="space-y-1.5 rounded border border-zinc-800 p-2 text-xs">
	<div class="flex items-center gap-2">
		<button type="button" onclick={() => toggleExpanded(tabId, path)} aria-label="Toggle preview">
			{isExpanded(tabId, path) ? '▾' : '▸'}
		</button>
		<span class="text-zinc-400">Combine</span>
		<select disabled={!editable} value={node.op} onchange={(e) => setOp(e.currentTarget.value as SetExpression['op'])}
			class="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5">
			<option value="union">union</option>
			<option value="intersection">intersection</option>
			<option value="difference">difference</option>
			<option value="symmetric_difference">symmetric difference</option>
		</select>
	</div>
	<ul class="space-y-1 border-l border-zinc-800 pl-2">
		{#each node.operands as op, i (i)}
			<li class="space-y-1">
				<div class="flex items-center gap-2">
					<span class="flex-1 truncate">
						{operandLabel(op, refName(op))}
						{#if node.op === 'difference'}
							<span class="ml-1 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">{i === 0 ? 'base' : 'subtracted'}</span>
						{/if}
					</span>
					<label class="text-zinc-500">step
						<input type="number" min="0" class="w-10 rounded border border-zinc-700 bg-zinc-900 px-1"
							value={op.step_index ?? ''} placeholder="last"
							oninput={(e) => setStepIndex(i, e.currentTarget.value)} />
					</label>
					<button type="button" aria-label="Move up" disabled={i === 0}
						onclick={() => mutate((r) => moveOperand(r, path, i, 'up'))}><ChevronUp class="size-3" /></button>
					<button type="button" aria-label="Move down" disabled={i === node.operands.length - 1}
						onclick={() => mutate((r) => moveOperand(r, path, i, 'down'))}><ChevronDown class="size-3" /></button>
					<button type="button" aria-label="Remove operand" class="hover:text-red-400"
						onclick={() => mutate((r) => removeOperand(r, path, i))}><Trash2 class="size-3" /></button>
				</div>
				{#if op.definition}
					<NavigationNode {tabId} path={[...path, i]} />
				{/if}
			</li>
		{/each}
	</ul>
	{#if editable}
		<div class="flex gap-3">
			<button type="button" class="text-sky-500 hover:text-sky-300" onclick={() => mutate((r) => insertNavigation(r, path))}>+ insert navigation</button>
			<button type="button" class="text-sky-500 hover:text-sky-300" onclick={() => mutate((r) => insertGroup(r, path))}>+ group</button>
			<StereotypePicker mode="create" names={navHeaders.map((h) => h.name)}
				onPick={(name) => { const h = navHeaders.find((x) => x.name === name); if (h) mutate((r) => insertRef(r, path, h.id)); }}
				open={addOpen} onOpenChange={(v) => (addOpen = v)} searchPlaceholder="Add saved navigation…">
				{#snippet trigger()}<span class="cursor-pointer text-sky-500 hover:text-sky-300">+ from library</span>{/snippet}
			</StereotypePicker>
		</div>
	{/if}
	{#if isExpanded(tabId, path)}
		<ChainPreview {tabId} {path} />
	{/if}
</div>
```

- [ ] **Step 5: Create `PathLeafEditor.svelte` (start + steps stubbed)**

Provide a working leaf that renders the existing `ScopeEditor` for a scope start and an empty steps region + the per-path `exclude_visited` toggle + a collapsible `ChainPreview`. Tasks 4 and 5 fill the start-mode selector and step editor. Skeleton:

```svelte
<script lang="ts">
	import { canEdit, getDraft, isExpanded, toggleExpanded, updateDefinition } from '$lib/state';
	import { updateNodeAt } from '$lib/navigation/tree';
	import type { NodePath } from '$lib/navigation/tree';
	import type { NavScope, PathNavigation } from '$lib/api/types';
	import ScopeEditor from './ScopeEditor.svelte';
	import ChainPreview from './ChainPreview.svelte';

	let { tabId, path, node }: { tabId: string; path: NodePath; node: PathNavigation } = $props();
	const editable = $derived(canEdit());
	const draft = $derived(getDraft(tabId));
	function patch(next: Partial<PathNavigation>) {
		if (!draft) return;
		updateDefinition(tabId, updateNodeAt(draft.definition, path, (n) => ({ ...(n as PathNavigation), ...next })));
	}
</script>

<div class="space-y-2 rounded border border-zinc-800 p-2">
	<div class="flex items-center gap-2 text-xs">
		<button type="button" onclick={() => toggleExpanded(tabId, path)} aria-label="Toggle preview">{isExpanded(tabId, path) ? '▾' : '▸'}</button>
		<span class="text-zinc-400">Navigation</span>
		<label class="ml-auto flex items-center gap-1.5 text-zinc-400" title="When on, a chain never revisits an element it already contains">
			<input type="checkbox" checked={node.exclude_visited} disabled={!editable}
				onchange={(e) => patch({ exclude_visited: e.currentTarget.checked })} />
			Exclude visited
		</label>
	</div>
	{#if node.start.kind === 'scope'}
		<ScopeEditor scope={node.start} label="Start" onChange={(s: NavScope) => patch({ start: s })} />
	{/if}
	<!-- Task 4 adds the start-mode selector; Task 5 adds the step editor. -->
	{#if isExpanded(tabId, path)}
		<ChainPreview {tabId} {path} />
	{/if}
</div>
```

- [ ] **Step 6: Rework `NavigationBuilder.svelte`**

Drop the Path/Set-op toggle and the `SetExpressionEditor` import. Header keeps the name input, the conflict banner, `saveError`, a **Save** button, and a **Save as…** button (Save-as wired in Task 7 — for now its handler calls `save()`; replace in Task 7). Body renders the root node:

```svelte
<div class="min-h-0 flex-1 overflow-auto p-3">
	<NavigationNode {tabId} path={[]} />
</div>
```

Remove `path`/`setExpr`/`toPath`/`toSetExpression`/`sourceTypesFor`/`patchPath`/`addStep`/`setStep`/`removeStep` (they move into the node components). Keep `ensureDraft` effect, `draft`, `conflict`, `editable`, `save()`.

Delete `SetExpressionEditor.svelte`.

- [ ] **Step 7: Run tests + check + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- combine-editor.test && npm run check'`
Expected: PASS, check 0 errors.

```bash
git add frontend/src/lib/components/Navigation/
git rm frontend/src/lib/components/Navigation/SetExpressionEditor.svelte
git commit -m "$(cat <<'EOF'
feat(navigation): recursive composition tree with inline N-ary combine nodes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Start-mode selector + element typeahead

**Files:**
- Create: `frontend/src/lib/components/Navigation/ElementStartPicker.svelte`
- Modify: `frontend/src/lib/components/Navigation/PathLeafEditor.svelte`
- Create/Test: `frontend/src/lib/components/Navigation/__tests__/element-start.test.ts`

**Interfaces:**
- Consumes: `elementStartScope`, `readElementStart`, `emptyCombine` (Task 1); `listElementsPage({ q, limit })` from `$lib/api/model-read`.
- Produces: `ElementStartPicker` prop `{ value: string | null; onPick: (id: string, label: string) => void }`.

- [ ] **Step 1: Write the failing element-start tests**

```ts
it('picking an element writes an id-equals name_id criterion', () => {
	const scope = elementStartScope('el-42');
	expect(readElementStart(scope)).toBe('el-42');
});
it('a plain type scope reads back as Filter mode (null element)', () => {
	expect(readElementStart({ kind: 'scope', types: ['Component'], criteria: [] })).toBeNull();
});
```

Plus a component test rendering `PathLeafEditor`, switching the start mode selector to "Element", typing into the typeahead (MSW-mock `GET /model/elements` returning one item), clicking it, and asserting the draft's `start` equals `elementStartScope(<id>)`.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- element-start.test'`
Expected: FAIL.

- [ ] **Step 3: Create `ElementStartPicker.svelte`**

A debounced typeahead (mirror `Search.svelte`'s query→`listElementsPage` pattern and its element-name derivation). Input `q`, 250 ms debounce, calls `listElementsPage({ q, limit: 20 })`, lists results (display name + type + short id) as buttons; clicking calls `onPick(id, label)`. When `value` is set, show the resolved element as a chip with a "change" affordance. Guard staleness with a local generation counter (same discipline as the editor state).

- [ ] **Step 4: Wire the start-mode selector into `PathLeafEditor.svelte`**

Add a 3-way selector (Filter / Element / Combination) above the start body. Derive the current mode: `start.kind === 'set_op'` → Combination; else `readElementStart(start) !== null` → Element; else Filter. On mode change:
- → Filter: `patch({ start: { kind: 'scope', types: [], criteria: [] } })`.
- → Element: `patch({ start: elementStartScope('') })` then show the picker (empty until picked).
- → Combination: `patch({ start: emptyCombine() })` and render `<NavigationNode {tabId} path={[...path, 'start']} />` for the start subtree.

Render `ElementStartPicker` in Element mode with `value={readElementStart(start)}` and `onPick={(id) => patch({ start: elementStartScope(id) })}`.

- [ ] **Step 5: Run tests + check + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- element-start.test && npm run check'`
Expected: PASS.

```bash
git add frontend/src/lib/components/Navigation/
git commit -m "$(cat <<'EOF'
feat(navigation): three-mode start — filter, specific element, combination

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Two-kind step editor with scoped filter properties

**Files:**
- Create: `frontend/src/lib/components/Navigation/RelationshipStepRow.svelte`
- Create: `frontend/src/lib/components/Navigation/FilterStepRow.svelte`
- Modify: `frontend/src/lib/components/Navigation/PathLeafEditor.svelte` (step list + add buttons)
- Modify: `frontend/src/lib/components/Sidebar/CriterionRow.svelte` (optional `propertyNames` prop)
- Delete: `frontend/src/lib/components/Navigation/StepRow.svelte`
- Create/Test: `frontend/src/lib/components/Navigation/__tests__/step-editor.test.ts`

**Interfaces:**
- Consumes: `relationshipTypesFromScope`, `scopeAllowedTargetTypes` (`connection-rules`); `effectivePropertiesForTypes` (Task 1); `newCriterion` (`$lib/search/types`).
- Produces: `RelationshipStepRow` `{ step, index, sourceTypes, onChange, onRemove }`; `FilterStepRow` `{ step, index, propertyNames, onChange, onRemove }`.

- [ ] **Step 1: Write the failing step-editor tests**

```ts
it('add relationship step appends a relationship item', () => { /* click "+ relationship step", assert steps[-1].kind === 'relationship' */ });
it('add filter step appends a filter item', () => { /* assert steps[-1].kind === 'filter' */ });
it('filter property picker offers the union of reachable-type properties', () => {
	// start types ['Component']; a filter step first → propertyNames includes
	// Component's own + subtype-only props (via effectivePropertiesForTypes).
});
it('reached types come from the nearest preceding relationship step target_types', () => {
	// steps: [rel(target_types=['Service']), filter] → filter propertyNames = Service props.
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- step-editor.test'`
Expected: FAIL.

- [ ] **Step 3: Add `propertyNames` to `CriterionRow.svelte`**

Add an optional prop `propertyNames?: string[] | null` (default `null`). When non-null, filter `propertyItems` to entries whose name is in `propertyNames` before passing them to `PropertyPicker`:

```ts
let { criterion, index, target, onChange, onRemove, propertyNames = null }: Props = $props();
const scopedItems = $derived(
	propertyNames === null ? propertyItems : propertyItems.filter((it) => propertyNames!.includes(it.name))
);
```

Use `scopedItems` in the `<PropertyPicker items={...}>`. All existing (search) callers omit the prop → unchanged behaviour.

- [ ] **Step 4: Create `RelationshipStepRow.svelte`**

Port `StepRow.svelte`'s rel-type picker (via `relationshipTypesFromScope`) and direction toggle, but replace the `ScopeEditor` target with an optional target-type multi-pick (`StereotypePicker` filter mode over `scopeAllowedTargetTypes` union, or all element types when `sourceTypes` is empty / direction ≠ 'out'). It edits a `NavRelationshipStep`; `onChange(index, { ...step, target_types, ... })`. No criteria.

- [ ] **Step 5: Create `FilterStepRow.svelte`**

Render a `CriterionRow` list over `step.criteria` with `target="element"` and `propertyNames={propertyNames}` (passed in from `PathLeafEditor`), plus a "+ condition" button using `newCriterion('property')`. Editing calls `onChange(index, { ...step, criteria })`.

- [ ] **Step 6: Wire the step list into `PathLeafEditor.svelte`**

Render `node.steps` by `kind` (`RelationshipStepRow` / `FilterStepRow`). Add two buttons: **"+ relationship step"** (append `{kind:'relationship', relationship_type:'', direction:'out', target_types:[], children:[]}`) and **"+ filter step"** (append `{kind:'filter', criteria:[]}`). Compute per-step inputs:
- `sourceTypesFor(i)` for a relationship step = the nearest preceding relationship step's `target_types`, else the start types (`start.kind==='scope' ? start.types : []`).
- `propertyNamesFor(i)` for a filter step = `effectivePropertiesForTypes(mm, reachedTypes(i)).map(p => p.name)`, where `reachedTypes(i)` scans `node.steps[0..i-1]` backward for the first `kind==='relationship'` and returns its `target_types`; if none, the start types (or `[]`/element-start type → all).

- [ ] **Step 7: Run tests + check + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- step-editor.test && npm run check'`
Expected: PASS.

```bash
git add frontend/src/lib/components/Navigation/ frontend/src/lib/components/Sidebar/CriterionRow.svelte
git rm frontend/src/lib/components/Navigation/StepRow.svelte
git commit -m "$(cat <<'EOF'
feat(navigation): relationship/filter step editor with type-scoped filter props

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Per-node collapsible previews

**Files:**
- Modify: `frontend/src/lib/components/Navigation/ChainPreview.svelte`
- Create/Test: `frontend/src/lib/components/Navigation/__tests__/chain-preview.test.ts`

**Interfaces:**
- Consumes: `getPreview(tabId, path)`, `getEvalError(tabId, path)`, `isExpanded`, `loadMorePreview(tabId, path)`, `getDraft`, `isRunnable`, `nodeAt` (state + tree).
- Produces: `ChainPreview` prop `{ tabId: string; path: NodePath }`.

- [ ] **Step 1: Write the failing preview test**

```ts
it('shows the node preview table when expanded and evaluated', async () => { /* expand root, resolve evaluate, assert chains render */ });
it('shows an error line when the node evaluate failed', async () => { /* force evaluate reject, assert "Evaluation failed" */ });
it('renders no column for a filter-only narrowing (columns = rel steps)', async () => { /* step_types = ['Uses'] → one hop header */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- chain-preview.test'`
Expected: FAIL — `ChainPreview` still takes only `tabId`.

- [ ] **Step 3: Update `ChainPreview.svelte`**

Add the `path` prop; read `getPreview(tabId, path)` / `getEvalError(tabId, path)`; compute `runnable` from `isRunnable(nodeAt(getDraft(tabId)?.definition, path))`. Keep the existing three-state header (chain count / "Evaluation failed — edit the definition to retry" / "Complete the steps to see results"), the chip table (columns = `step_types`), the chip-click `select`, and `Load more` → `loadMorePreview(tabId, path)`. The component only renders inside an expanded node (the parent guards with `isExpanded`).

- [ ] **Step 4: Run tests + check + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- chain-preview.test && npm run check'`
Expected: PASS.

```bash
git add frontend/src/lib/components/Navigation/ChainPreview.svelte frontend/src/lib/components/Navigation/__tests__/chain-preview.test.ts
git commit -m "$(cat <<'EOF'
feat(navigation): per-node collapsible chain previews

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Save-as

**Files:**
- Modify: `frontend/src/lib/state/navigation-editor.svelte.ts` (`saveAsDraft`)
- Modify: `frontend/src/lib/state/index.ts` (export)
- Modify: `frontend/src/lib/components/Navigation/NavigationBuilder.svelte` (Save as… button)
- Modify: `frontend/src/lib/state/__tests__/navigation-editor.test.ts`

**Interfaces:**
- Consumes: `api.createArtifact`, `bindTabToArtifact`, `loadArtifacts`.
- Produces: `saveAsDraft(tabId: string, name: string): Promise<void>`.

- [ ] **Step 1: Write the failing Save-as test**

```ts
it('saveAsDraft creates a new artifact and rebinds the tab, leaving original untouched', async () => {
	// open a saved nav tab (nav:<id>), call saveAsDraft(tabId, 'Copy'),
	// assert createArtifact called with the current payload + new name,
	// and the tab is rebound to the created id.
});
it('a name-clash 409 on save-as surfaces as an error, not a rev conflict', async () => { /* ... */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- navigation-editor.test'`
Expected: FAIL — `saveAsDraft` undefined.

- [ ] **Step 3: Implement `saveAsDraft`**

```ts
export async function saveAsDraft(tabId: string, name: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = draft.definition as unknown as Record<string, unknown>;
	const created = await api.createArtifact({ kind: 'navigation', name, payload });
	bindTabToArtifact(tabId, created.id);
	_drafts.delete(tabId);
	_drafts.set(`nav:${created.id}`, {
		...draft, name, artifactId: created.id, artifactRev: created.artifact_rev, dirty: false
	});
	// carry over any expanded previews for this tab to the new key namespace
	await loadArtifacts().catch(() => {});
}
```

(The create-path 409 is a name clash — it propagates to the caller as a plain error, surfaced by the builder's `saveError`, exactly like the create branch of `saveDraft`. Do NOT enter rev-conflict state.) Export it from `index.ts`.

- [ ] **Step 4: Wire the button**

In `NavigationBuilder.svelte`, add a **Save as…** button next to Save; its handler prompts for a name (`window.prompt('Save as', draft.name)`) and calls `saveAsDraft(tabId, name)` inside a try/catch that sets `saveError`.

- [ ] **Step 5: Run tests + check + commit**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- navigation-editor.test && npm run check'`
Expected: PASS.

```bash
git add frontend/src/lib/state/ frontend/src/lib/components/Navigation/NavigationBuilder.svelte
git commit -m "$(cat <<'EOF'
feat(navigation): Save as… forks a navigation to a new library copy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: e2e rewrite + frontend verification

**Files:**
- Modify: `frontend/e2e/navigation.spec.ts` (or wherever the Stage-1 nav e2e lives — locate with `git ls-files '*navigation.spec.ts'`)

**Interfaces:**
- Consumes: the full built UI.
- Produces: a green e2e + unit + check + tidy baseline.

- [ ] **Step 1: Rewrite the e2e flow**

Rewrite `navigation.spec.ts` (verify each selector against the live components) to:
1. Open a new navigation tab (sidebar Artifacts → New).
2. Build the root Path leaf: set start types, add a **relationship step** (pick a rel type), add a **filter step** (one property condition).
3. **+ insert navigation** at the root → assert the builder auto-wrapped into a Combine node (operator select + two operand blocks visible).
4. Expand the root node preview → assert combined chains render (or a "Complete the steps" hint if intentionally empty), then expand one nested node's preview.
5. **Save**, then **Save as…** with a new name → assert both appear in the sidebar library.
6. Reopen the saved navigation from the tree → assert the composition structure round-trips (operator, both operands, the relationship + filter steps).

- [ ] **Step 2: Run the e2e**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e -- navigation.spec.ts'`
Expected: PASS (Playwright boots backend + dev server itself).

- [ ] **Step 3: Full unit suite + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: PASS, 0 check errors. (Ignore the known `SwapMetamodelDrawer.test.ts` full-suite teardown flake if it appears; confirm it passes in isolation.)

- [ ] **Step 4: Tidy**

Run: `pixi run tidy`
Expected: all gates green. Revert reformats of files this branch never touched.

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/navigation.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): compose-inline navigation build → combine → save → reopen flow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** recursive inline composition (Tasks 1,3), N-ary operators + explicit grouping (Task 3 + tree helpers), refs + inline (insertRef/library), auto-wrap/unwrap (tree.ts, tested), reorder + difference base (Task 3), auto-labels (nodeLabel), per-node collapsible previews evaluate-on-expand (Tasks 2,6), no size cap (nothing enforces one), three-mode start + element typeahead (Task 4), two-kind steps + union-scoped property picker (Task 5), existence-gate lives backend-side (backend plan), Save-as (Task 7), no schema change beyond v2 union (Task 1 types stay permissive), README updated (Task 2). All present.
- **Type consistency:** `NodePath`, `pathKey`, `nodeAt`, `updateNodeAt`, `insertNavigation/insertGroup/insertRef/removeOperand/moveOperand`, `nodeLabel`, `operandLabel`, `isRunnable`, `elementStartScope`, `readElementStart`, `emptyPath`, `emptyCombine`, `effectivePropertiesForTypes`, `saveAsDraft`, and the node-scoped `getPreview/getEvalError/isExpanded/toggleExpanded/runPreview/loadMorePreview(tabId, path)` names match across every task that uses them.
- **Component-code note:** the Svelte snippets show the load-bearing structure/logic; the implementer mirrors sibling components (`ScopeEditor`, `StereotypePicker`, `Search.svelte`, the old `StepRow`) for styling and picker wiring — the same "embed real code, verify neighboring APIs" posture the Stage-1 plans used.
- **Ordering:** Task 2 must precede Tasks 3–7 (they call the node-scoped state API); Task 1 precedes all.
