# Navigation builder UI refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cryptic navigation builder UI with the approved "chain rail + results dock" design: numbered sentence rows, plain-language combination frames, a `→ feeds` chip instead of the naked `step [n]` input, one selected node per tab, and a bottom results dock.

**Architecture:** All work is frontend-only. Three layers change:

1. **Pure helpers** (`frontend/src/lib/navigation/tree.ts`) gain `chainColumns` (the single source of truth for the numbered badges used by the rail, the results table, and the feeds popover), `nodeEntries` (depth-first `Path A/B/…` lettering + dock picker tree), `nodeExistsAt`, and `setOperandStepIndex`.
2. **Store** (`frontend/src/lib/state/navigation-editor.svelte.ts`) gains per-tab selection (`getSelectedPath`/`selectNode`) and swaps the user-facing expand toggle for **visible-node registration** (`registerVisibleNode`/`unregisterVisibleNode`, refcounted) over the existing `_expanded` set. Every other invariant from commit `f8e5b78` (debounce, generations, `applyStructuralEdit` remap, `rekeyTab` rescheduling) stays byte-for-byte intact and is extended to carry the selection.
3. **Components** (`frontend/src/lib/components/Navigation/`) are rebuilt: `PathCard` (replaces `PathLeafEditor`), `CombineFrame` (replaces `CombineEditor`), `RefCard`, `FeedsChip`, `ChainBadge`, `StatusChip`, `OperandToolbar`, `ResultsDock` (replaces `ChainPreview`).

**Tech Stack:** Svelte 5 (runes), Tailwind (dark zinc idiom), TypeScript, vitest + happy-dom, Playwright. Existing components reused: `$lib/components/ui/dropdown-menu`, `Sidebar/StereotypePicker.svelte`, `Sidebar/CriterionRow.svelte`, `ResizeHandle.svelte`, `Navigation/ElementStartPicker.svelte`.

## Global Constraints

- **Frontend only.** No backend, schema, or API changes. `step_index`, `/navigations/evaluate`, and the artifacts API stay exactly as they are.
- **No new npm dependencies.** No new CSS files.
- **Read `docs/superpowers/specs/2026-07-09-navigation-builder-ui-refactor-design.md` and commit `f8e5b78` before touching the store.** The spec's "Invariants that must survive" section is binding:
  - Structural mutations go through `applyStructuralEdit` + `remapPath`; per-node state (previews, generations, timers, **selection**) follows NODES, not positions.
  - `rekeyTab` reschedules pending debounced runs and re-issues in-flight ones after the first-save tab rebind; no stuck `loading` previews, no silently swallowed runs.
  - Auto-run remains debounced (400 ms), generation-guarded, fire-and-forget with the eval-error flag as the only failure surface.
- **The mock is the visual reference, not a source of DOM/CSS.** `docs/superpowers/specs/2026-07-09-navigation-builder-mock.html` — re-express in Svelte 5 + Tailwind.
- Badges are styled circles containing plain mono digits — never unicode circled glyphs (`⓪①②`).
- Tailwind palette: `zinc-950/900/800/700` bases, `text-xs`, sky-500 actions, emerald save/success, indigo-400 combination accents, amber `base` badge, red errors, `font-mono` for badges/pills/counts.
- Verification gates (all three must be green before "done"):
  - `pixi run -e frontend bash -c 'cd frontend && npm test'`
  - `pixi run -e frontend bash -c 'cd frontend && npm run check'`
  - `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`
- `npm run lint` has **two pre-existing prettier failures on `main`** (`ProjectCard.test.ts`, `UsersTab.test.ts`). Do not fix them. Do not add new ones — run `npx prettier --write` on every file you touch (repo style: **tabs**, single quotes, 100 cols).
- Commit after each task in conventional style: `feat(navigation): …`, `fix(navigation): …`, `test(navigation): …`, `style(navigation): …`.
- Run a single vitest file with:
  `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/navigation/__tests__/tree.test.ts'`

## Deliberate divergences from the mock (do not "fix" these)

- **Library-ref status chip.** The mock shows `✓ 12 chains` on a ref card. The store cannot evaluate a ref (`nodeAt` returns `null` for a ref operand; a ref carries no definition), and ref introspection is explicitly out of scope. Ref cards render a muted `linked` chip instead, and selecting a ref in the dock shows a directive empty state. The ref's feeds popover offers only "the last step (default)", per spec.
- **The root node is always "visible"** (its status chip is live), so an edit re-runs it too. The spec accepts this ("an edit re-runs every visible node — typically 1–6 evaluate calls, debounced"). This *changes* `f8e5b78`'s "the new root Combine starts collapsed" behavior; that commit's real invariant — per-node state follows the node through `remapPath` — is what the reworked tests must keep pinning.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `frontend/src/lib/components/Navigation/ChainBadge.svelte` | The circled mono digit / ghost dot. One implementation, three call sites. |
| `frontend/src/lib/components/Navigation/StatusChip.svelte` | Live per-card status: `✓ N chains` / `incomplete …` / `⚠ failed` / `…` / `linked`. |
| `frontend/src/lib/components/Navigation/FeedsChip.svelte` | `→ feeds ⟨n⟩ label ▾` chip + popover; writes `step_index`. |
| `frontend/src/lib/components/Navigation/OperandToolbar.svelte` | `↑ ↓ ✕` for a node used as a combination part. |
| `frontend/src/lib/components/Navigation/PathCard.svelte` | Path node: header, chain rail, add-step buttons, `Combine with… ▾`, Options. |
| `frontend/src/lib/components/Navigation/CombineFrame.svelte` | Combination node: eyebrow, operator select, dividers, parts, `+ Add another part ▾`. |
| `frontend/src/lib/components/Navigation/RefCard.svelte` | Compact library-ref part row. |
| `frontend/src/lib/components/Navigation/ResultsDock.svelte` | Bottom dock: node picker, status line, chains table, Load more. |

**Modified:** `tree.ts`, `navigation-editor.svelte.ts`, `state/index.ts`, `NavigationNode.svelte`, `NavigationBuilder.svelte`, `RelationshipStepRow.svelte`, `FilterStepRow.svelte`, `ScopeEditor.svelte`, `e2e/navigation.spec.ts`.

**Deleted:** `PathLeafEditor.svelte`, `CombineEditor.svelte`, `ChainPreview.svelte`, `__tests__/chain-preview.test.ts` (→ `results-dock.test.ts`), `__tests__/combine-editor.test.ts` (→ `combine-frame.test.ts`).

---

## Task 1: Pure tree helpers (`chainColumns`, `nodeEntries`, `nodeExistsAt`, `setOperandStepIndex`)

**Files:**
- Modify: `frontend/src/lib/navigation/tree.ts` (append after `precedingTargetTypes`)
- Test: `frontend/src/lib/navigation/__tests__/tree.test.ts` (append)

**Interfaces:**
- Consumes: existing `NodePath`, `nodeAt`, `updateNodeAt`, `readElementStart`, `pathKey` from the same file.
- Produces (every later task depends on these exact names/types):
  ```ts
  export interface ChainColumn { index: number; label: string; sub?: string }
  export function chainColumns(node: PathNavigation): ChainColumn[];

  export interface NodeEntry {
    path: NodePath;
    kind: 'path' | 'set_op' | 'ref';
    title: string;
    depth: number;
    ref?: string;
  }
  export function nodeEntries(
    root: NavigationDefinition,
    refName?: (id: string) => string | undefined
  ): NodeEntry[];

  export function nodeExistsAt(root: NavigationDefinition, path: NodePath): boolean;
  export function setOperandStepIndex(
    root: NavigationDefinition,
    parentPath: NodePath,
    i: number,
    stepIndex: number | null
  ): NavigationDefinition;

  export const OP_LABEL: Record<SetExpression['op'], string>;
  export const OP_DIVIDER: Record<SetExpression['op'], string>;
  export const OP_NOTE: Record<SetExpression['op'], string>;
  export function titleForPath(
    root: NavigationDefinition,
    path: NodePath,
    refName?: (id: string) => string | undefined
  ): string;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/navigation/__tests__/tree.test.ts`. Extend the existing import block at the top of the file to also import `chainColumns`, `nodeEntries`, `nodeExistsAt`, `setOperandStepIndex`, `titleForPath`, `OP_DIVIDER`, and `type ChainColumn` (keep the existing imports).

```ts
describe('chainColumns', () => {
	function path(start: PathNavigation['start'], steps: PathNavigation['steps']): PathNavigation {
		return { kind: 'path', schema_version: 2, start, steps, exclude_visited: true };
	}
	const hop = (rt: string, targets: string[] = []) =>
		({
			kind: 'relationship' as const,
			relationship_type: rt,
			direction: 'out' as const,
			target_types: targets,
			children: []
		});

	it('a bare start scope is a single column labelled Start', () => {
		const cols = chainColumns(path({ kind: 'scope', types: [], criteria: [] }, []));
		expect(cols).toEqual([{ index: 0, label: 'Start', sub: undefined }]);
	});

	it('the start column sub-label lists the start types', () => {
		const cols = chainColumns(path({ kind: 'scope', types: ['B', 'A'], criteria: [] }, []));
		expect(cols[0].sub).toBe('A, B');
	});

	it('an element start sub-labels as "one element"', () => {
		const cols = chainColumns(path(elementStartScope('e1'), []));
		expect(cols[0].sub).toBe('one element');
	});

	it('a combination start sub-labels as "combination"', () => {
		const cols = chainColumns(path(emptyCombine(), []));
		expect(cols[0].sub).toBe('combination');
	});

	it('each relationship step adds one numbered column; filter steps add none', () => {
		const cols = chainColumns(
			path({ kind: 'scope', types: ['SoftwareSystem'], criteria: [] }, [
				hop('SystemContainsComponent', ['Component']),
				{ kind: 'filter', criteria: [] },
				hop('DependsOn')
			])
		);
		expect(cols.map((c) => c.index)).toEqual([0, 1, 2]);
		expect(cols.map((c) => c.label)).toEqual(['Start', 'SystemContainsComponent', 'DependsOn']);
		expect(cols[1].sub).toBe('Component');
		expect(cols[2].sub).toBeUndefined(); // "any type"
	});

	it('an unset relationship type is labelled "unset step"', () => {
		const cols = chainColumns(path({ kind: 'scope', types: [], criteria: [] }, [hop('')]));
		expect(cols[1].label).toBe('unset step');
	});
});

describe('nodeEntries', () => {
	it('a bare root path is a single entry titled "Path"', () => {
		const entries = nodeEntries(emptyPath());
		expect(entries).toEqual([{ path: [], kind: 'path', title: 'Path', depth: 0 }]);
	});

	it('letters paths depth-first and puts the root combination last', () => {
		const root: SetExpression = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{ definition: emptyPath(), step_index: null }
			]
		};
		const entries = nodeEntries(root);
		expect(entries.map((e) => e.title)).toEqual(['Path A', 'Path B', 'Whole combination']);
		expect(entries.map((e) => pathKey(e.path))).toEqual(['0', '1', '']);
		expect(entries.map((e) => e.depth)).toEqual([1, 1, 0]);
	});

	it('nested combinations deepen the entries and are titled "Combination"', () => {
		const root: SetExpression = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{
					definition: {
						kind: 'set_op',
						schema_version: 2,
						op: 'intersection',
						operands: [
							{ definition: emptyPath(), step_index: null },
							{ definition: emptyPath(), step_index: null }
						]
					},
					step_index: null
				}
			]
		};
		const entries = nodeEntries(root);
		expect(entries.map((e) => e.title)).toEqual([
			'Path A',
			'Path B',
			'Path C',
			'Combination',
			'Whole combination'
		]);
		expect(entries.map((e) => pathKey(e.path))).toEqual(['0', '1.0', '1.1', '1', '']);
		expect(entries.find((e) => e.title === 'Path B')?.depth).toBe(2);
	});

	it('a ref operand becomes a ref entry whose title resolves through refName', () => {
		const root: SetExpression = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{ ref: 'nav-1', step_index: null }
			]
		};
		const entries = nodeEntries(root, (id) => (id === 'nav-1' ? 'Sensors network' : undefined));
		expect(entries[1]).toEqual({
			path: [1],
			kind: 'ref',
			title: 'Sensors network',
			depth: 1,
			ref: 'nav-1'
		});
		// unresolved refs fall back to the id
		expect(nodeEntries(root)[1].title).toBe('nav-1');
	});

	it('a combination start is walked through the "start" segment', () => {
		const root: PathNavigation = { ...emptyPath(), start: emptyCombine() };
		const entries = nodeEntries(root);
		expect(entries.map((e) => pathKey(e.path))).toEqual(['start.0', 'start.1', 'start', '']);
	});

	it('lettering continues past Z as AA', () => {
		const operands = Array.from({ length: 27 }, () => ({
			definition: emptyPath(),
			step_index: null
		}));
		const entries = nodeEntries({ kind: 'set_op', schema_version: 2, op: 'union', operands });
		expect(entries[25].title).toBe('Path Z');
		expect(entries[26].title).toBe('Path AA');
	});
});

describe('titleForPath', () => {
	it('returns the entry title for a node path, else an empty string', () => {
		const root: SetExpression = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{ definition: emptyPath(), step_index: null }
			]
		};
		expect(titleForPath(root, [1])).toBe('Path B');
		expect(titleForPath(root, [])).toBe('Whole combination');
		expect(titleForPath(root, [9])).toBe('');
	});
});

describe('nodeExistsAt', () => {
	const root: SetExpression = {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: emptyPath(), step_index: null },
			{ ref: 'nav-1', step_index: null }
		]
	};

	it('is true for the root and for definition operands', () => {
		expect(nodeExistsAt(root, [])).toBe(true);
		expect(nodeExistsAt(root, [0])).toBe(true);
	});

	it('is true for a REF operand (which nodeAt cannot address)', () => {
		expect(nodeExistsAt(root, [1])).toBe(true);
		expect(nodeAt(root, [1])).toBeNull();
	});

	it('is false past a ref, out of range, or through a scope start', () => {
		expect(nodeExistsAt(root, [1, 0])).toBe(false);
		expect(nodeExistsAt(root, [5])).toBe(false);
		expect(nodeExistsAt(root, [0, 'start'])).toBe(false);
	});
});

describe('setOperandStepIndex', () => {
	const root: SetExpression = {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: emptyPath(), step_index: null },
			{ definition: emptyPath(), step_index: 2 }
		]
	};

	it('writes null (last step), 0 (start) and k (column k)', () => {
		expect((setOperandStepIndex(root, [], 0, 0) as SetExpression).operands[0].step_index).toBe(0);
		expect((setOperandStepIndex(root, [], 0, 3) as SetExpression).operands[0].step_index).toBe(3);
		expect((setOperandStepIndex(root, [], 1, null) as SetExpression).operands[1].step_index).toBe(
			null
		);
	});

	it('leaves the sibling operands untouched', () => {
		const next = setOperandStepIndex(root, [], 0, 1) as SetExpression;
		expect(next.operands[1].step_index).toBe(2);
	});

	it('is a no-op on a non-set_op parent path', () => {
		expect(setOperandStepIndex(emptyPath(), [], 0, 1)).toEqual(emptyPath());
	});
});

describe('OP_DIVIDER', () => {
	it('carries the glyph + word for every operator', () => {
		expect(OP_DIVIDER.union).toBe('∪ union');
		expect(OP_DIVIDER.intersection).toBe('∩ intersection');
		expect(OP_DIVIDER.difference).toBe('− minus');
		expect(OP_DIVIDER.symmetric_difference).toBe('⊕ symmetric difference');
	});
});
```

The new tests also need `elementStartScope`, `nodeAt` and `pathKey` plus the `PathNavigation` type in scope — extend the existing import statements at the top of the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/navigation/__tests__/tree.test.ts'`
Expected: FAIL — `chainColumns is not a function` (and friends).

- [ ] **Step 3: Implement the helpers**

Append to `frontend/src/lib/navigation/tree.ts` (after `precedingTargetTypes`):

```ts
/** Plain-language operator labels for the combination frame's `<select>`. */
export const OP_LABEL: Record<SetExpression['op'], string> = {
	union: 'Union — keeps elements found in ANY part',
	intersection: 'Intersection — keeps elements found in EVERY part',
	difference: 'Difference — first part minus all the others',
	symmetric_difference: 'Symmetric difference — in exactly one part'
};

/** Glyph + word shown on the dashed divider between consecutive parts. */
export const OP_DIVIDER: Record<SetExpression['op'], string> = {
	union: '∪ union',
	intersection: '∩ intersection',
	difference: '− minus',
	symmetric_difference: '⊕ symmetric difference'
};

/** The dock's muted note under a combination node's single column header. */
export const OP_NOTE: Record<SetExpression['op'], string> = {
	union: "(union of the parts' fed steps)",
	intersection: "(intersection of the parts' fed steps)",
	difference: "(first part's fed step minus the others)",
	symmetric_difference: "(in exactly one of the parts' fed steps)"
};

/**
 * One numbered column of the CHAINS a path evaluates to. Column 0 is the
 * start; each RELATIONSHIP step adds one column; filter steps add none (they
 * narrow the frontier, they don't advance it). This is the single source of
 * truth for the three places the circled-number badge appears: the editor
 * rail, the results-table headers, and the `→ feeds` popover.
 */
export interface ChainColumn {
	index: number;
	/** 'Start' for column 0; the relationship type for a hop. */
	label: string;
	/** Start types / 'one element' / 'combination' for column 0; the hop's
	 * target types otherwise. Undefined means "any type" (nothing to show). */
	sub?: string;
}

export function chainColumns(node: PathNavigation): ChainColumn[] {
	const { start } = node;
	let sub: string | undefined;
	if (start.kind === 'set_op') sub = 'combination';
	else if (readElementStart(start) !== null) sub = 'one element';
	else if (start.types.length > 0) sub = [...start.types].sort().join(', ');
	const cols: ChainColumn[] = [{ index: 0, label: 'Start', sub }];
	for (const step of node.steps) {
		if (step.kind !== 'relationship') continue;
		cols.push({
			index: cols.length,
			label: step.relationship_type || 'unset step',
			sub: step.target_types.length > 0 ? [...step.target_types].sort().join(', ') : undefined
		});
	}
	return cols;
}

/** Spreadsheet lettering: 0 -> A … 25 -> Z, 26 -> AA. */
function pathLetter(i: number): string {
	let n = i;
	let out = '';
	do {
		out = String.fromCharCode(65 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}

/**
 * One selectable node of the definition tree, depth-first. Paths are lettered
 * `Path A`, `Path B`, … in visit order (a lone root path is just `Path`); a
 * set_op is emitted AFTER its children (`Whole combination` at the root,
 * `Combination` when nested) so the dock picker reads exactly like the mock;
 * ref operands are emitted in place (they carry no definition, so `nodeAt`
 * cannot address them — that's what `kind: 'ref'` is for).
 */
export interface NodeEntry {
	path: NodePath;
	kind: 'path' | 'set_op' | 'ref';
	title: string;
	depth: number;
	ref?: string;
}

export function nodeEntries(
	root: NavigationDefinition,
	refName?: (id: string) => string | undefined
): NodeEntry[] {
	const entries: NodeEntry[] = [];
	const lettered = root.kind === 'set_op' || root.start.kind === 'set_op';
	let letter = 0;

	function visit(node: NavigationDefinition, path: NodePath, depth: number): void {
		if (node.kind === 'path') {
			if (node.start.kind === 'set_op') visit(node.start, [...path, 'start'], depth + 1);
			entries.push({
				path,
				kind: 'path',
				title: lettered ? `Path ${pathLetter(letter++)}` : 'Path',
				depth
			});
			return;
		}
		node.operands.forEach((op, i) => {
			const childPath = [...path, i];
			if (op.definition) visit(op.definition, childPath, depth + 1);
			else if (op.ref)
				entries.push({
					path: childPath,
					kind: 'ref',
					title: refName?.(op.ref) ?? op.ref,
					depth: depth + 1,
					ref: op.ref
				});
		});
		entries.push({
			path,
			kind: 'set_op',
			title: path.length === 0 ? 'Whole combination' : 'Combination',
			depth
		});
	}

	visit(root, [], 0);
	return entries;
}

/** The `nodeEntries` title of the node at `path` (`''` when it has none). */
export function titleForPath(
	root: NavigationDefinition,
	path: NodePath,
	refName?: (id: string) => string | undefined
): string {
	const key = pathKey(path);
	return nodeEntries(root, refName).find((e) => pathKey(e.path) === key)?.title ?? '';
}

/**
 * True when `path` addresses something that EXISTS in the tree — a definition
 * node (like `nodeAt`) or a REF operand (which `nodeAt` reports as null
 * because it has no definition to return). Selection may land on a ref, so it
 * needs this laxer existence check, not `nodeAt(...) !== null`.
 */
export function nodeExistsAt(root: NavigationDefinition, path: NodePath): boolean {
	let node: NavigationDefinition = root;
	for (let i = 0; i < path.length; i++) {
		const seg = path[i];
		if (seg === 'start') {
			if (node.kind !== 'path' || node.start.kind !== 'set_op') return false;
			node = node.start;
			continue;
		}
		if (node.kind !== 'set_op') return false;
		const op = node.operands[seg];
		if (!op) return false;
		if (!op.definition) return op.ref !== undefined && i === path.length - 1; // a ref is a leaf
		node = op.definition;
	}
	return true;
}

/** Set operand `i`'s `step_index` on the combine at `parentPath` (null = the
 * path's last step; 0 = its start; k = chain column k). Field edit — moves no
 * nodes, so callers route it through `updateDefinition`, not
 * `applyStructuralEdit`. */
export function setOperandStepIndex(
	root: NavigationDefinition,
	parentPath: NodePath,
	i: number,
	stepIndex: number | null
): NavigationDefinition {
	return updateNodeAt(root, parentPath, (n) => {
		if (n.kind !== 'set_op') return n;
		const operands = n.operands.map(
			(op, idx): NavOperand => (idx === i ? { ...op, step_index: stepIndex } : op)
		);
		return { ...n, operands };
	});
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/navigation/__tests__/tree.test.ts'`
Expected: PASS (all pre-existing tree tests plus the new ones).

- [ ] **Step 5: Format and commit**

```bash
cd frontend && npx prettier --write src/lib/navigation/tree.ts src/lib/navigation/__tests__/tree.test.ts
cd .. && git add frontend/src/lib/navigation
git commit -m "feat(navigation): chain columns, node entries, and step_index helpers"
```

---

## Task 2: Store — per-tab selection + visible-node registration

**Files:**
- Modify: `frontend/src/lib/state/navigation-editor.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts:212-232` (the navigation-editor export block)
- Modify (keep compiling, old UI): `frontend/src/lib/components/Navigation/PathLeafEditor.svelte`, `CombineEditor.svelte`
- Test: `frontend/src/lib/state/__tests__/navigation-editor.test.ts`
- Test (mechanical update): `frontend/src/lib/components/Navigation/__tests__/chain-preview.test.ts`

**Interfaces:**
- Consumes: `nodeExistsAt` from Task 1.
- Produces:
  ```ts
  export function isNodeVisible(tabId: string, path?: NodePath): boolean;
  export function registerVisibleNode(tabId: string, path: NodePath): void;
  export function unregisterVisibleNode(tabId: string, path: NodePath): void;
  export function getSelectedPath(tabId: string): NodePath;   // [] = root
  export function selectNode(tabId: string, path: NodePath): void;
  ```
  `toggleExpanded` and `isExpanded` are **removed** (no dead export surface).

**Design notes (read before coding):**
- Registration is **refcounted** (`_visibleCounts: Map<previewKey, number>`). Svelte gives no ordering guarantee between the unmount of a card and the mount of its replacement at the same path (e.g. a Path becoming a Combination). A naive add/delete pair would let a late unregister tear down a node that is on screen — cancelling its debounce timer and killing auto-run. With a refcount, mount→unmount and unmount→mount both settle correctly.
- `ensureDraft` pins the ROOT (count 1, never released except by `closeDraft`/`reloadDraft`/reset). The root is always rendered, and the pin makes the root's preview survive the auto-wrap kind-change (PathCard → CombineFrame at path `[]`).
- `registerVisibleNode` kicks an immediate fire-and-forget run only on the 0→1 transition **and** when the node has neither a preview nor a pending debounce timer (an `applyStructuralEdit` that just scheduled a run must not be double-fired).
- `unregisterVisibleNode` on the 1→0 transition does exactly what the old collapse branch did: cancel timer, delete preview + eval-error, bump generation.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/lib/state/__tests__/navigation-editor.test.ts`:

(a) Replace the imports `isExpanded` and `toggleExpanded` with `isNodeVisible`, `registerVisibleNode`, `unregisterVisibleNode`, `getSelectedPath`, `selectNode`. Also import `pathKey` from `$lib/navigation/tree` (alongside the existing edit imports).

(b) Mechanically rework the existing call sites, preserving each test's assertion intent:

- `describe('saveAsDraft')` → `'carries the previous tab’s expanded/preview node-keys to the new tab key'`: rename to `'carries the previous tab’s visible/preview node-keys to the new tab key'`; `isExpanded(...)` → `isNodeVisible(...)`.
- `describe('node-scoped previews')`:
  - `'runs a preview for the root node and stores it under the root key'` — replace the `toggleExpanded` collapse/re-expand pair with:
    ```ts
    expect(isNodeVisible(tabId, [])).toBe(true); // root pinned by ensureDraft
    unregisterVisibleNode(tabId, []); // release the pin
    registerVisibleNode(tabId, []); // re-register → immediate run
    await flushEvaluate();
    ```
  - `'collapsing a node drops its preview and cancels its timer'` → rename to `'unregistering the last reference to a node drops its preview'`; `toggleExpanded(tabId, [])` → `unregisterVisibleNode(tabId, [])`; assertions unchanged (`getPreview` undefined, `isNodeVisible` false).
- `describe('structural edits keep expansion attached to nodes')` → rename to `'structural edits keep per-node state attached to nodes'`:
  - every `toggleExpanded(tabId, p)` that EXPANDED becomes `registerVisibleNode(tabId, p)`.
  - every `toggleExpanded(tabId, p)` that COLLAPSED becomes `unregisterVisibleNode(tabId, p)`.
  - `isExpanded` → `isNodeVisible`.
  - `'auto-wrap moves the root expansion (and its preview) to operand 0'` → rewrite the post-edit assertions (the root is now pinned and re-runs; the invariant that must survive is that the built PATH's state travelled to operand 0):
    ```ts
    const draft = getDraft(tabId)!;
    applyStructuralEdit(tabId, insertNavigationEdit(draft.definition, []));
    // The built path travelled to operand 0 — its visibility + selection follow it.
    expect(isNodeVisible(tabId, [0])).toBe(true);
    expect(pathKey(getSelectedPath(tabId))).toBe('0');
    expect(getPreview(tabId, [])).toBeUndefined(); // invalidated by the edit
    await vi.advanceTimersByTimeAsync(400);
    // Operand 0 (the moved path) re-ran with its own definition…
    expect(getPreview(tabId, [0])).toBeDefined();
    expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ definition: expect.objectContaining({ kind: 'path' }) })
    );
    // …and the pinned root (now the Combine) re-ran too — accepted cost of
    // every VISIBLE node keeping a live status chip.
    expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ definition: expect.objectContaining({ kind: 'set_op' }) })
    );
    ```
  - `'unwrap lifts the surviving operand’s expansion onto the parent'`: the root pin means `unregisterVisibleNode(tabId, [])` no longer removes the root (count 2 → 1 after the operand test registers). Rewrite it to register operand `[1]` only, and after the remove assert `isNodeVisible(tabId, [])` is true and `getPreview(tabId, [])` is defined after 400 ms.

(c) Add the new describe block at the end of the file:

```ts
describe('visible-node registration', () => {
	it('registering a runnable node runs it immediately (fire-and-forget)', async () => {
		const tabId = 'nav:draft:vis1';
		await ensureDraft(tabId);
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [{ definition: runnablePath('A'), step_index: null }]
		});
		evaluate.mockClear();
		registerVisibleNode(tabId, [0]);
		await flushEvaluate();
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(getPreview(tabId, [0])?.total).toBe(1);
	});

	it('registering does NOT double-fire a run that is already scheduled', async () => {
		vi.useFakeTimers();
		const tabId = 'nav:draft:vis2';
		await ensureDraft(tabId);
		const evaluate = vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		registerVisibleNode(tabId, []); // count 2 (root pinned by ensureDraft)
		updateDefinition(tabId, runnablePath('A')); // schedules the debounced run
		registerVisibleNode(tabId, []); // count 3 — must not fire immediately
		expect(evaluate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(400);
		expect(evaluate).toHaveBeenCalledTimes(1);
	});

	it('is refcounted: a node stays live while another reference holds it', async () => {
		vi.useFakeTimers();
		const tabId = 'nav:draft:vis3';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, runnablePath('A'));
		await vi.advanceTimersByTimeAsync(400);
		registerVisibleNode(tabId, []); // a second holder (the card component)
		unregisterVisibleNode(tabId, []); // that holder goes away…
		expect(isNodeVisible(tabId, [])).toBe(true); // …the pin keeps it live
		expect(getPreview(tabId, [])).toBeDefined();
		unregisterVisibleNode(tabId, []); // release the pin too
		expect(isNodeVisible(tabId, [])).toBe(false);
		expect(getPreview(tabId, [])).toBeUndefined();
	});

	it('unregistering the last reference orphans an in-flight evaluate', async () => {
		const tabId = 'nav:draft:vis4';
		await ensureDraft(tabId);
		const d = deferred<typeof CHAIN_PAGE>();
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockImplementation(() => d.promise);
		updateDefinition(tabId, runnablePath('A'));
		const inflight = runPreview(tabId, []);
		unregisterVisibleNode(tabId, []); // releases the root pin
		d.resolve(CHAIN_PAGE);
		await inflight;
		expect(getPreview(tabId, [])).toBeUndefined();
	});
});

describe('node selection', () => {
	function combine2() {
		return {
			kind: 'set_op' as const,
			schema_version: 2,
			op: 'union' as const,
			operands: [
				{ definition: runnablePath('A'), step_index: null },
				{ definition: runnablePath('B'), step_index: null }
			]
		};
	}

	it('defaults to the root node', async () => {
		await ensureDraft('nav:draft:sel1');
		expect(getSelectedPath('nav:draft:sel1')).toEqual([]);
	});

	it('selectNode stores the node path', async () => {
		const tabId = 'nav:draft:sel2';
		await ensureDraft(tabId);
		updateDefinition(tabId, combine2());
		selectNode(tabId, [1]);
		expect(getSelectedPath(tabId)).toEqual([1]);
	});

	it('a structural edit remaps the selection through remapPath', async () => {
		const tabId = 'nav:draft:sel3';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: runnablePath('A'), step_index: null },
				{ definition: runnablePath('B'), step_index: null },
				{ definition: runnablePath('C'), step_index: null }
			]
		});
		selectNode(tabId, [2]); // C
		applyStructuralEdit(tabId, removeOperandEdit(getDraft(tabId)!.definition, [], 0));
		expect(getSelectedPath(tabId)).toEqual([1]); // C followed its node
	});

	it('a removed selected node falls back to the root', async () => {
		const tabId = 'nav:draft:sel4';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, combine2());
		selectNode(tabId, [0]);
		applyStructuralEdit(tabId, removeOperandEdit(getDraft(tabId)!.definition, [], 0));
		expect(getSelectedPath(tabId)).toEqual([]);
	});

	it('auto-wrap carries the selection onto operand 0', async () => {
		const tabId = 'nav:draft:sel5';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		updateDefinition(tabId, runnablePath('A'));
		applyStructuralEdit(tabId, insertNavigationEdit(getDraft(tabId)!.definition, []));
		expect(getSelectedPath(tabId)).toEqual([0]);
	});

	it('a field edit that deletes the selected node falls back to the root', async () => {
		const tabId = 'nav:draft:sel6';
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		// A path whose START is a combination; select the start's operand 0…
		updateDefinition(tabId, { ...runnablePath('A'), start: emptyCombine() });
		selectNode(tabId, ['start', 0]);
		// …then replace the start with a plain scope: the selected node is gone.
		updateDefinition(tabId, runnablePath('A'));
		expect(getSelectedPath(tabId)).toEqual([]);
	});

	it('rekeyTab carries the selection across the first-save rebind', async () => {
		const tabId = openNavigationTab({ artifactId: null, title: 'New navigation' });
		await ensureDraft(tabId);
		vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
		vi.spyOn(artifactsApi, 'createArtifact').mockResolvedValue({
			id: 'a9',
			kind: 'navigation',
			name: 'Mine',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			payload: {}
		});
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
		updateDefinition(tabId, combine2());
		selectNode(tabId, [1]);
		await saveDraft(tabId);
		expect(getSelectedPath('nav:a9')).toEqual([1]);
		expect(getSelectedPath(tabId)).toEqual([]); // the retired tab keeps nothing
	});

	it('closeDraft clears the selection', async () => {
		const tabId = 'nav:draft:sel8';
		await ensureDraft(tabId);
		updateDefinition(tabId, combine2());
		selectNode(tabId, [1]);
		closeDraft(tabId);
		expect(getSelectedPath(tabId)).toEqual([]);
	});
});
```

The new tests need `emptyCombine` imported from `$lib/navigation/tree`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/navigation-editor.test.ts'`
Expected: FAIL — `registerVisibleNode is not a function`, `getSelectedPath is not a function`.

- [ ] **Step 3: Implement the store changes**

In `frontend/src/lib/state/navigation-editor.svelte.ts`:

1. Extend the tree import: `import { emptyPath, isRunnable, nodeAt, nodeExistsAt, pathKey, type NodePath, type StructuralEdit } from '$lib/navigation/tree';`

2. Add the new state next to `_expanded`:

```ts
/** tabId -> the pathKey of the ONE selected node (`''` = root). The dock
 * renders this node's chains; a card click sets it. Selection is per-node
 * state like previews, so `applyStructuralEdit` remaps it and `rekeyTab`
 * carries it. */
const _selected = new SvelteMap<string, string>();

/**
 * previewKey -> how many live references hold this node visible. Card
 * components register on mount and unregister on unmount; `ensureDraft` pins
 * the ROOT with one reference for the lifetime of the draft. Refcounted
 * because Svelte gives no ordering guarantee between the unmount of a card
 * and the mount of its replacement at the same path (a Path auto-wrapping
 * into a Combination swaps components at path `[]`): a plain add/delete pair
 * would let the late unregister tear down a node that is on screen, cancelling
 * its debounce timer and silently killing auto-run. Control state, never read
 * from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _visibleCounts = new Map<string, number>();
```

3. Replace `isExpanded` and `toggleExpanded` with:

```ts
/** True when the node at `path` is rendered somewhere (and thus previewed). */
export function isNodeVisible(tabId: string, path: NodePath = []): boolean {
	return _expanded.get(tabId)?.has(pathKey(path)) ?? false;
}

/**
 * Take a reference on the node at `path`: it becomes VISIBLE (its preview
 * auto-runs on every edit, keeping its status chip live). Called by each card
 * component on mount, and once by `ensureDraft` to pin the always-rendered
 * root. Only the 0 -> 1 transition may kick a run, and only when nothing is
 * already pending for the node — an `applyStructuralEdit` that has just
 * scheduled the debounced run must not be double-fired. Fire-and-forget, like
 * the saved-artifact open: the eval-error flag is the failure surface.
 */
export function registerVisibleNode(tabId: string, path: NodePath): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const key = previewKey(tabId, path);
	const next = (_visibleCounts.get(key) ?? 0) + 1;
	_visibleCounts.set(key, next);
	markExpanded(tabId, path);
	if (next > 1) return;
	if (_previews.has(key) || _debounceTimers.has(key)) return;
	const node = nodeAt(draft.definition, path);
	if (node && isRunnable(node)) void runPreview(tabId, path).catch(() => {});
}

/**
 * Release a reference. On the LAST one the node stops being visible: cancel
 * its pending timer, delete its preview + eval-error, and bump its generation
 * so any in-flight evaluate response is orphaned (exactly what collapsing used
 * to do). Earlier references keep it alive.
 */
export function unregisterVisibleNode(tabId: string, path: NodePath): void {
	const key = previewKey(tabId, path);
	const next = (_visibleCounts.get(key) ?? 0) - 1;
	if (next > 0) {
		_visibleCounts.set(key, next);
		return;
	}
	_visibleCounts.delete(key);
	_expanded.get(tabId)?.delete(pathKey(path));
	cancelAutoRun(key);
	_previews.delete(key);
	_evalErrors.delete(key);
	bumpGeneration(key);
}

/** The tab's selected node path (`[]` = root, the default). */
export function getSelectedPath(tabId: string): NodePath {
	return parsePathKey(_selected.get(tabId) ?? '');
}

/** Select the node the results dock shows. Exactly one per tab. */
export function selectNode(tabId: string, path: NodePath): void {
	_selected.set(tabId, pathKey(path));
}
```

4. `ensureDraft`: replace both `markExpanded(tabId, [])` calls with `pinRoot(tabId)`, defined next to `markExpanded`:

```ts
/** Pin the ROOT node visible for the draft's lifetime. The root is always
 * rendered, and the pin keeps its preview alive across the PathCard ->
 * CombineFrame component swap that an auto-wrap performs at path `[]`.
 * Released only by closeDraft/reloadDraft/reset. */
function pinRoot(tabId: string): void {
	markExpanded(tabId, []);
	const key = previewKey(tabId, []);
	_visibleCounts.set(key, (_visibleCounts.get(key) ?? 0) + 1);
}
```

5. `updateDefinition`: after the expanded-set sweep, drop a selection whose node the edit removed:

```ts
	// A field edit can delete the selected node (e.g. replacing a combination
	// start with a plain scope). Selection must never dangle: fall back to the
	// root, which always exists.
	const selPk = _selected.get(tabId);
	if (selPk !== undefined && selPk !== '' && !nodeExistsAt(defn, parsePathKey(selPk))) {
		_selected.set(tabId, '');
	}
```
Note: this block runs even when the tab has no expanded set, so move the early `if (!expanded) return;` guard into an `if (expanded) { …sweep… }` wrapper.

6. `applyStructuralEdit`: after the expanded-key remap block and BEFORE the `updateDefinition` call, remap the selection:

```ts
	// Selection is per-node state too: it must follow the node through the
	// mutation (a removed selected node falls back to the root).
	const selPk = _selected.get(tabId);
	if (selPk !== undefined) {
		const np = edit.remapPath(parsePathKey(selPk));
		_selected.set(tabId, np === null ? '' : pathKey(np));
	}
```

7. `rekeyTab`: `move(_visibleCounts)` alongside `move(_previews)`; and carry the selection:

```ts
	const sel = _selected.get(oldTab);
	if (sel !== undefined) {
		_selected.delete(oldTab);
		_selected.set(newTab, sel);
	}
```

8. `clearTabKeys`: add `for (const k of _visibleCounts.keys()) if (k.startsWith(prefix)) keys.add(k);` to the key collection, and `_visibleCounts.delete(key)` to the drain loop.

9. `closeDraft` and `reloadDraft`: add `_selected.delete(tabId);`.

10. `resetNavigationEditors`: add `_visibleCounts.clear();` and `_selected.clear();`.

11. Update the module docstring: the "A node is only previewed while it is EXPANDED (collapsing drops its preview); the root is expanded by default" sentence becomes: a node is previewed while it is VISIBLE — card components register/unregister it, `ensureDraft` pins the root — there is no user-facing collapse toggle. Keep every other paragraph.

In `frontend/src/lib/state/index.ts`, replace `isExpanded` and `toggleExpanded` in the navigation-editor export block with `getSelectedPath`, `isNodeVisible`, `registerVisibleNode`, `selectNode`, `unregisterVisibleNode` (keep the list alphabetical).

- [ ] **Step 4: Keep the old components compiling**

`PathLeafEditor.svelte` and `CombineEditor.svelte` still import `isExpanded`/`toggleExpanded`. They are deleted in Tasks 4–6; for now, in **each** file:
- Drop the `▸/▾` toggle `<button>` entirely.
- Replace the `isExpanded`/`toggleExpanded` imports with `registerVisibleNode, unregisterVisibleNode`.
- Add, after the `draft` derivation (capture the path array so the teardown releases the reference it took, not whatever `path` has become):
  ```ts
  $effect(() => {
      const p = path;
      registerVisibleNode(tabId, p);
      return () => unregisterVisibleNode(tabId, p);
  });
  ```
- Replace `{#if isExpanded(tabId, path)}<ChainPreview …/>{/if}` with an unconditional `<ChainPreview {tabId} {path} />`.

In `frontend/src/lib/components/Navigation/__tests__/chain-preview.test.ts`, replace the `toggleExpanded(tabId, []); toggleExpanded(tabId, []);` pairs with `await runPreview(tabId, []).catch(() => {});` (import `runPreview` from `$lib/state`; drop the `toggleExpanded` import). The `flushEvaluate()` calls can stay.

- [ ] **Step 5: Run the full unit suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'`
Expected: PASS — every navigation test green (store, tree, chain-preview, combine-editor, step-editor, element-start).

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors.

- [ ] **Step 6: Format and commit**

```bash
cd frontend && npx prettier --write src/lib/state/navigation-editor.svelte.ts src/lib/state/index.ts src/lib/state/__tests__/navigation-editor.test.ts src/lib/components/Navigation
cd .. && git add frontend/src
git commit -m "feat(navigation): per-tab node selection and refcounted visible-node registration"
```

---

## Task 3: `ChainBadge`, `StatusChip`, `OperandToolbar`, `FeedsChip`

**Files:**
- Create: `frontend/src/lib/components/Navigation/ChainBadge.svelte`
- Create: `frontend/src/lib/components/Navigation/StatusChip.svelte`
- Create: `frontend/src/lib/components/Navigation/OperandToolbar.svelte`
- Create: `frontend/src/lib/components/Navigation/FeedsChip.svelte`
- Test: `frontend/src/lib/components/Navigation/__tests__/feeds-chip.test.ts` (new)
- Test: `frontend/src/lib/components/Navigation/__tests__/status-chip.test.ts` (new)

**Interfaces:**
- Consumes: `ChainColumn`, `OP_DIVIDER` (Task 1); `getPreview`, `getEvalError`, `isRunnable`, `getDraft` (store).
- Produces:
  ```ts
  // ChainBadge.svelte
  { value: number | null; tone?: 'default' | 'start' | 'combine' }   // value null -> ghost dot
  // StatusChip.svelte
  { tabId: string; path: NodePath; kind?: 'node' | 'ref' }
  // OperandToolbar.svelte
  { canMoveUp: boolean; canMoveDown: boolean; onUp: () => void; onDown: () => void; onRemove: () => void }
  // FeedsChip.svelte
  { columns: ChainColumn[]; value: number | null; disabled?: boolean; onPick: (v: number | null) => void }
  ```

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/components/Navigation/__tests__/feeds-chip.test.ts`:

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChainColumn } from '$lib/navigation/tree';
import FeedsChip from '../FeedsChip.svelte';

const COLUMNS: ChainColumn[] = [
	{ index: 0, label: 'Start', sub: 'SoftwareSystem' },
	{ index: 1, label: 'SystemContainsComponent', sub: 'Component' },
	{ index: 2, label: 'DependsOn' }
];

function render(props: {
	columns: ChainColumn[];
	value: number | null;
	onPick: (v: number | null) => void;
}) {
	const c = mount(FeedsChip, { target: document.body, props });
	flushSync();
	return c;
}
function chip(): HTMLButtonElement {
	const b = document.querySelector('[data-testid="feeds-chip"]');
	if (!b) throw new Error('feeds chip not found');
	return b as HTMLButtonElement;
}
function options(): HTMLButtonElement[] {
	return [...document.querySelectorAll('[data-testid="feeds-option"]')] as HTMLButtonElement[];
}

afterEach(() => {
	document.body.innerHTML = '';
});

it('reads "last step" with the LAST column number when the value is null', () => {
	const c = render({ columns: COLUMNS, value: null, onPick: () => {} });
	try {
		expect(chip().textContent).toContain('feeds');
		expect(chip().textContent).toContain('last step');
		expect(chip().textContent).toContain('2');
	} finally {
		unmount(c);
	}
});

it('reads "the start" for value 0', () => {
	const c = render({ columns: COLUMNS, value: 0, onPick: () => {} });
	try {
		expect(chip().textContent).toContain('the start');
	} finally {
		unmount(c);
	}
});

it('reads "after <relationship>" for an intermediate column', () => {
	const c = render({ columns: COLUMNS, value: 1, onPick: () => {} });
	try {
		expect(chip().textContent).toContain('after SystemContainsComponent');
	} finally {
		unmount(c);
	}
});

it('offers one option per column and writes null for the last step', () => {
	const onPick = vi.fn();
	const c = render({ columns: COLUMNS, value: null, onPick });
	try {
		chip().click();
		flushSync();
		const opts = options();
		expect(opts).toHaveLength(3);
		expect(document.body.textContent).toContain(
			'Feed the combination with the elements reached at…'
		);
		expect(opts[0].textContent).toContain('the start');
		expect(opts[0].textContent).toContain('SoftwareSystem');
		expect(opts[2].textContent).toContain('the last step');
		expect(opts[2].textContent).toContain('default');
		opts[2].click();
		flushSync();
		expect(onPick).toHaveBeenCalledWith(null);
	} finally {
		unmount(c);
	}
});

it('writes 0 for the start and k for column k', () => {
	const onPick = vi.fn();
	const c = render({ columns: COLUMNS, value: null, onPick });
	try {
		chip().click();
		flushSync();
		options()[0].click();
		flushSync();
		expect(onPick).toHaveBeenCalledWith(0);
		chip().click();
		flushSync();
		options()[1].click();
		flushSync();
		expect(onPick).toHaveBeenCalledWith(1);
	} finally {
		unmount(c);
	}
});

it('a single-column node offers only the last-step default', () => {
	const c = render({ columns: [{ index: 0, label: 'Start' }], value: null, onPick: () => {} });
	try {
		chip().click();
		flushSync();
		expect(options()).toHaveLength(1);
		expect(options()[0].textContent).toContain('the last step');
	} finally {
		unmount(c);
	}
});
```

`frontend/src/lib/components/Navigation/__tests__/status-chip.test.ts`:

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import {
	ensureDraft,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	runPreview,
	setProjectInfo,
	updateDefinition
} from '$lib/state';
import StatusChip from '../StatusChip.svelte';

const CHAIN_PAGE = {
	step_types: ['Uses'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 1,
	truncated: false
};

function runnablePath(startType = 'Component') {
	return {
		kind: 'path' as const,
		schema_version: 2,
		start: { kind: 'scope' as const, types: [startType], criteria: [] },
		steps: [],
		exclude_visited: true
	};
}

beforeEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});
afterEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

function render(tabId: string, kind: 'node' | 'ref' = 'node') {
	const c = mount(StatusChip, { target: document.body, props: { tabId, path: [], kind } });
	flushSync();
	return c;
}

it('shows the chain count after a successful run', async () => {
	const tabId = 'nav:draft:chip-ok';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
	updateDefinition(tabId, runnablePath());
	await runPreview(tabId, []);
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('✓ 1 chains');
	} finally {
		unmount(c);
	}
});

it('shows the incomplete hint for a pristine draft', async () => {
	const tabId = 'nav:draft:chip-incomplete';
	await ensureDraft(tabId);
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('incomplete — pick a start or add a step');
	} finally {
		unmount(c);
	}
});

it('shows the failure marker when the last evaluate failed', async () => {
	const tabId = 'nav:draft:chip-failed';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockRejectedValue(new Error('boom'));
	updateDefinition(tabId, runnablePath());
	await runPreview(tabId, []).catch(() => {});
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('⚠ failed');
	} finally {
		unmount(c);
	}
});

it('does not blank the chip while an evaluate is in flight', async () => {
	const tabId = 'nav:draft:chip-loading';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockImplementation(() => new Promise(() => {}));
	updateDefinition(tabId, runnablePath());
	void runPreview(tabId, []).catch(() => {});
	const c = render(tabId);
	try {
		expect(document.querySelector('[data-testid="status-chip"]')?.textContent?.trim()).toBe('…');
	} finally {
		unmount(c);
	}
});

it('a ref node shows the muted linked marker', async () => {
	const tabId = 'nav:draft:chip-ref';
	await ensureDraft(tabId);
	const c = render(tabId, 'ref');
	try {
		expect(document.body.textContent).toContain('linked');
	} finally {
		unmount(c);
	}
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Navigation/__tests__/feeds-chip.test.ts src/lib/components/Navigation/__tests__/status-chip.test.ts'`
Expected: FAIL — cannot resolve `../FeedsChip.svelte`.

- [ ] **Step 3: Implement the components**

`ChainBadge.svelte`:

```svelte
<script lang="ts">
	// The circled mono digit that teaches the chain-column concept. It appears
	// in exactly three places — the editor rail, the results-table headers, and
	// the "→ feeds" popover — all fed by `chainColumns`. A null value renders
	// the ghost dot used by filter rows (they add no column, so no number).
	// Plain digits inside a styled circle, never the unicode circled glyphs
	// (⓪①②), which render as tofu in some fonts.
	let {
		value,
		tone = 'default',
		size = 'md'
	}: {
		value: number | null;
		tone?: 'default' | 'start' | 'combine';
		size?: 'sm' | 'md';
	} = $props();
</script>

<span
	data-testid="chain-badge"
	class="inline-flex flex-none items-center justify-center rounded-full border font-mono
		{size === 'sm' ? 'size-[15px] text-[9px]' : 'size-5 text-[10px]'}
		{value === null
		? 'border-transparent bg-transparent text-zinc-500'
		: tone === 'start'
			? 'border-emerald-800 bg-zinc-900 text-emerald-400'
			: tone === 'combine'
				? 'border-indigo-400/35 bg-zinc-950 text-indigo-400'
				: 'border-zinc-700 bg-zinc-900 text-zinc-400'}"
>
	{value === null ? '·' : value}
</span>
```

`StatusChip.svelte`:

```svelte
<script lang="ts">
	// The always-live per-card status. Four states, mirroring the store's
	// per-node surfaces: a settled preview (count), an in-flight run (never
	// blank — a bare ellipsis), a failed run (the eval-error flag is the only
	// failure surface auto-run has), and a node that isn't runnable yet.
	// A REF part has no evaluable definition (`nodeAt` returns null for it),
	// so it reports only that it is linked.
	import { getDraft, getEvalError, getPreview, isRunnable } from '$lib/state';
	import { nodeAt, type NodePath } from '$lib/navigation/tree';

	let {
		tabId,
		path,
		kind = 'node'
	}: { tabId: string; path: NodePath; kind?: 'node' | 'ref' } = $props();

	const draft = $derived(getDraft(tabId));
	const node = $derived(draft ? nodeAt(draft.definition, path) : null);
	const preview = $derived(getPreview(tabId, path));
	const errored = $derived(getEvalError(tabId, path));
	const runnable = $derived(node ? isRunnable(node) : false);
</script>

<span data-testid="status-chip" class="text-[11px]">
	{#if kind === 'ref'}
		<span class="font-mono text-zinc-500">linked</span>
	{:else if preview?.loading}
		<span class="text-zinc-500">…</span>
	{:else if preview}
		<span class="font-mono text-emerald-400">✓ {preview.total} chains</span>
	{:else if errored}
		<span class="font-mono text-red-400">⚠ failed</span>
	{:else if !runnable}
		<span class="text-zinc-500 italic">incomplete — pick a start or add a step</span>
	{/if}
</span>
```

`OperandToolbar.svelte`:

```svelte
<script lang="ts">
	import { ChevronDown, ChevronUp, Trash2 } from '@lucide/svelte';

	let {
		canMoveUp,
		canMoveDown,
		onUp,
		onDown,
		onRemove
	}: {
		canMoveUp: boolean;
		canMoveDown: boolean;
		onUp: () => void;
		onDown: () => void;
		onRemove: () => void;
	} = $props();
</script>

<span class="flex items-center gap-0.5">
	<button
		type="button"
		aria-label="Move up"
		class="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
		disabled={!canMoveUp}
		onclick={onUp}><ChevronUp class="size-3" /></button
	>
	<button
		type="button"
		aria-label="Move down"
		class="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
		disabled={!canMoveDown}
		onclick={onDown}><ChevronDown class="size-3" /></button
	>
	<button
		type="button"
		aria-label="Remove operand"
		class="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
		onclick={onRemove}><Trash2 class="size-3" /></button
	>
</span>
```

`FeedsChip.svelte` — replaces the naked `step [n]` number input. Use `bits-ui`'s `Popover` directly (same import the repo's `StereotypePicker` uses) so the popover content mounts in the DOM on open:

```svelte
<script lang="ts">
	// "→ feeds ⟨2⟩ last step" — WHICH chain column of this path feeds the
	// combination it is a part of. Writes `step_index`: null = the last step
	// (the backend default), 0 = the start, k = chain column k. Only PATH parts
	// get a chip; a combination part contributes its members and has no steps
	// to feed (the backend rejects a non-0/null step_index for a set operand).
	import { Popover } from 'bits-ui';
	import type { ChainColumn } from '$lib/navigation/tree';
	import ChainBadge from './ChainBadge.svelte';

	let {
		columns,
		value,
		disabled = false,
		onPick
	}: {
		columns: ChainColumn[];
		value: number | null;
		disabled?: boolean;
		onPick: (v: number | null) => void;
	} = $props();

	let open = $state(false);
	const lastIndex = $derived(columns.length - 1);
	const shownIndex = $derived(value === null ? lastIndex : Math.min(value, lastIndex));
	const shownLabel = $derived(
		value === null
			? 'last step'
			: value === 0
				? 'the start'
				: `after ${columns[value]?.label ?? 'step'}`
	);

	function pick(v: number | null): void {
		onPick(v);
		open = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		{disabled}
		data-testid="feeds-chip"
		title="Which elements this path contributes to the combination"
		class="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-40"
	>
		→ feeds <ChainBadge value={shownIndex} tone="combine" size="sm" />
		{shownLabel} ▾
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			align="end"
			sideOffset={4}
			class="z-50 w-[300px] rounded-md border border-zinc-700 bg-zinc-900 p-1.5 text-xs shadow-xl"
		>
			<p class="px-1.5 pt-0.5 pb-1.5 text-zinc-500">
				Feed the combination with the elements reached at…
			</p>
			{#each columns as col (col.index)}
				{@const isLast = col.index === lastIndex}
				<button
					type="button"
					data-testid="feeds-option"
					class="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-zinc-800"
					onclick={() => pick(isLast ? null : col.index)}
				>
					<ChainBadge value={col.index} tone="combine" size="sm" />
					<span class="text-zinc-200">
						{col.index === 0 && !isLast
							? 'the start'
							: isLast
								? 'the last step'
								: `after ${col.label}`}
					</span>
					<span class="ml-auto text-[10px] text-zinc-500">
						{isLast ? 'default' : (col.sub ?? '')}
					</span>
				</button>
			{/each}
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
```

Note the single-column case: column 0 IS the last column, so the only option reads "the last step / default" and writes `null` — matching the test and the backend rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Navigation/__tests__/feeds-chip.test.ts src/lib/components/Navigation/__tests__/status-chip.test.ts'`
Expected: PASS.

If the Popover content does not appear in `document.body` under happy-dom after `chip().click()`, drive `open` through the trigger's click as written; if bits-ui's portal needs a flush, add a second `flushSync()`. Do **not** switch to a bespoke popover.

- [ ] **Step 5: Format and commit**

```bash
cd frontend && npx prettier --write src/lib/components/Navigation
cd .. && git add frontend/src/lib/components/Navigation
git commit -m "feat(navigation): chain badge, status chip, operand toolbar, and feeds chip"
```

---

## Task 4: `PathCard` + sentence-layout step rows

**Files:**
- Create: `frontend/src/lib/components/Navigation/PathCard.svelte`
- Modify: `frontend/src/lib/components/Navigation/RelationshipStepRow.svelte`
- Modify: `frontend/src/lib/components/Navigation/FilterStepRow.svelte`
- Modify: `frontend/src/lib/components/Navigation/ScopeEditor.svelte`
- Modify: `frontend/src/lib/components/Navigation/NavigationNode.svelte`
- Delete: `frontend/src/lib/components/Navigation/PathLeafEditor.svelte`
- Test: `frontend/src/lib/components/Navigation/__tests__/step-editor.test.ts` (update button names)
- Test: `frontend/src/lib/components/Navigation/__tests__/path-card.test.ts` (new)

**Interfaces:**
- Consumes: `chainColumns`, `titleForPath`, `OP_LABEL` (Task 1); `registerVisibleNode`/`unregisterVisibleNode`/`selectNode`/`getSelectedPath` (Task 2); `ChainBadge`, `StatusChip`, `FeedsChip`, `OperandToolbar` (Task 3).
- Produces:
  ```ts
  // The operand chrome a parent CombineFrame hands to any part it renders.
  export interface OperandChrome {
    parentPath: NodePath;
    index: number;
    total: number;            // sibling count (for ↑/↓ disabling)
    stepIndex: number | null; // the operand's step_index (feeds chip value)
    isBase: boolean;          // difference && index === 0
  }
  ```
  Declared in `frontend/src/lib/navigation/tree.ts`? **No** — declare it in `NavigationNode.svelte` is impossible for a type export; put it in `frontend/src/lib/components/Navigation/chrome.ts` (a 12-line module exporting only this interface).

  ```svelte
  <!-- NavigationNode.svelte -->
  { tabId: string; path: NodePath; chrome?: OperandChrome | null }
  <!-- PathCard.svelte -->
  { tabId: string; path: NodePath; node: PathNavigation; chrome?: OperandChrome | null }
  <!-- RelationshipStepRow.svelte -->
  { step: NavRelationshipStep; index: number; column: number; sourceTypes: string[];
    onChange: (index: number, next: NavRelationshipStep) => void; onRemove: (index: number) => void }
  <!-- FilterStepRow.svelte -->
  { step: NavFilterStep; index: number; propertyNames: string[];
    onChange: (index: number, next: NavFilterStep) => void; onRemove: (index: number) => void }
  <!-- ScopeEditor.svelte -->
  { scope: NavScope; allowedTypes?: string[] | null; unsetLabel?: string; onChange: (next: NavScope) => void }
  ```
  `ScopeEditor` loses its `label` prop (the sentence provides the verb) and gains `unsetLabel` (default `'any element'`).

**Copy that the e2e suite and unit tests depend on (exact strings):**
- Add-step buttons: `+ Follow a relationship`, `+ Keep only…`
- Compose menu trigger: `Combine with… ▾`; items `A new path`, `A saved navigation…`, `A nested combination`
- Item descriptions on a bare path (state the auto-wrap outcome):
  - `Turns this into a Union of this path + a new empty one`
  - `Turns this into a Union of this path + a link to a saved navigation`
  - `Turns this into a Union of this path + a nested combination`
- Start row: verb `Start from`, mode `<select aria-label="Start mode">` with options `all matching` / `one element` / `a combination` (values `scope` / `element` / `combine`)
- Rel row: verb `Follow`, then rel pill (`pick a relationship…` when unset), direction select (`outgoing`/`incoming`/`either`), verb `to`, target pill (`any type` when unset)
- Filter row: verb `Keep only`, `+ condition`
- Options expander: summary `Options`, checkbox label `Exclude visited elements`, `title="When on, a chain never revisits an element it already contains"`
- Card root: `data-testid="path-card"`, `data-node-path={pathKey(path)}`, `data-selected={selected}`

- [ ] **Step 1: Write the failing tests**

Update `__tests__/step-editor.test.ts`: `buttonByText('+ relationship step')` → `buttonByText('+ Follow a relationship')`; `buttonByText('+ filter step')` → `buttonByText('+ Keep only…')`. Everything else in that file is unchanged (it asserts store shape and the property-picker scoping, both preserved).

New `frontend/src/lib/components/Navigation/__tests__/path-card.test.ts`:

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import type { PathNavigation, SetExpression } from '$lib/api/types';
import {
	ensureDraft,
	getDraft,
	getSelectedPath,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	setProjectInfo,
	updateDefinition
} from '$lib/state';
import { pathKey } from '$lib/navigation/tree';
import NavigationNode from '../NavigationNode.svelte';

beforeEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue({
		step_types: [],
		chains: [],
		total: 0,
		truncated: false
	});
});
afterEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

function render(tabId: string) {
	const c = mount(NavigationNode, { target: document.body, props: { tabId, path: [] } });
	flushSync();
	return c;
}
function buttonByText(text: string): HTMLButtonElement {
	const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
	if (!b) throw new Error(`button "${text}" not found`);
	return b as HTMLButtonElement;
}
function pathWith(steps: PathNavigation['steps'] = []): PathNavigation {
	return {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'scope', types: ['A'], criteria: [] },
		steps,
		exclude_visited: true
	};
}
async function seed(tabId: string, defn: PathNavigation) {
	await ensureDraft(tabId);
	updateDefinition(tabId, defn);
	flushSync();
}

it('a bare root path is titled "Path" and shows the numbered rail', async () => {
	const tabId = 'nav:draft:pc-title';
	await seed(
		tabId,
		pathWith([
			{
				kind: 'relationship',
				relationship_type: 'Uses',
				direction: 'out',
				target_types: [],
				children: []
			},
			{ kind: 'filter', criteria: [] }
		])
	);
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('Path');
		expect(document.body.textContent).toContain('Start from');
		expect(document.body.textContent).toContain('Follow');
		expect(document.body.textContent).toContain('Keep only');
		// Column badges: 0 (start), 1 (the hop), and the filter's ghost dot.
		const badges = [...document.querySelectorAll('[data-testid="chain-badge"]')].map(
			(b) => b.textContent?.trim() ?? ''
		);
		expect(badges.slice(0, 3)).toEqual(['0', '1', '·']);
	} finally {
		unmount(c);
	}
});

it('clicking the card selects its node; inner controls do not', async () => {
	const tabId = 'nav:draft:pc-select';
	await seed(tabId, pathWith());
	updateDefinition(tabId, {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: pathWith(), step_index: null },
			{ definition: pathWith(), step_index: null }
		]
	} as SetExpression);
	const c = render(tabId);
	flushSync();
	try {
		const cards = [...document.querySelectorAll('[data-testid="path-card"]')] as HTMLElement[];
		expect(cards).toHaveLength(2);
		cards[1].click();
		flushSync();
		expect(pathKey(getSelectedPath(tabId))).toBe('1');
		// An inner control click must NOT change the selection.
		const addBtn = cards[0].querySelector('button')!;
		addBtn.click();
		flushSync();
		expect(pathKey(getSelectedPath(tabId))).toBe('1');
	} finally {
		unmount(c);
	}
});

it('"Combine with… → A new path" auto-wraps the bare path into a union', async () => {
	const tabId = 'nav:draft:pc-wrap';
	await seed(tabId, pathWith());
	const c = render(tabId);
	try {
		buttonByText('Combine with… ▾').click();
		flushSync();
		buttonByText('A new path').click();
		flushSync();
		const defn = getDraft(tabId)!.definition as SetExpression;
		expect(defn.kind).toBe('set_op');
		expect(defn.op).toBe('union');
		expect(defn.operands).toHaveLength(2);
		// The built path travelled to operand 0 and the selection followed it.
		expect(pathKey(getSelectedPath(tabId))).toBe('0');
	} finally {
		unmount(c);
	}
});

it('the Options expander toggles exclude_visited', async () => {
	const tabId = 'nav:draft:pc-options';
	await seed(tabId, pathWith());
	const c = render(tabId);
	try {
		const cb = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(cb.checked).toBe(true);
		cb.click();
		flushSync();
		expect((getDraft(tabId)!.definition as PathNavigation).exclude_visited).toBe(false);
	} finally {
		unmount(c);
	}
});
```

The `A new path` menu item text must be reachable by a plain click after opening the trigger — if the dropdown renders into a portal, the query still finds it in `document.body`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Navigation/__tests__/path-card.test.ts'`
Expected: FAIL — cannot resolve `../PathCard.svelte` (once `NavigationNode` imports it) / `path-card` testid missing.

- [ ] **Step 3: Implement**

(a) `frontend/src/lib/components/Navigation/chrome.ts`:

```ts
import type { NodePath } from '$lib/navigation/tree';

/**
 * The chrome a Combination frame hands to each PART it renders: where the part
 * sits among its siblings (move/remove + the Difference `base` badge) and the
 * `step_index` its feeds chip edits. `null` means the node is not an operand
 * (the root, or a path's combination start), so it gets no toolbar and no chip.
 */
export interface OperandChrome {
	parentPath: NodePath;
	index: number;
	total: number;
	stepIndex: number | null;
	isBase: boolean;
}
```

(b) `RelationshipStepRow.svelte` — keep the whole `<script>` (rel/target type derivations, `toggleTargetType`, `patch`) and add `column: number` to `Props`. Replace the markup with the sentence row:

```svelte
<div class="group relative flex items-baseline gap-2.5 py-0.5" data-testid="relationship-step">
	<ChainBadge value={column} />
	<div class="flex min-h-[22px] flex-1 flex-wrap items-center gap-1.5">
		<span class="text-zinc-400">Follow</span>
		<StereotypePicker … >
			{#snippet trigger()}
				<span
					class="cursor-pointer rounded border px-1.5 py-0.5 font-mono text-[11px]
						{step.relationship_type
						? 'border-zinc-700 bg-zinc-900'
						: 'border-dashed border-zinc-700 text-zinc-500'}"
				>
					{step.relationship_type || 'pick a relationship…'}
				</span>
			{/snippet}
		</StereotypePicker>
		<select …>outgoing / incoming / either</select>
		<span class="text-zinc-400">to</span>
		<StereotypePicker … >
			{#snippet trigger()}
				<span class="… {step.target_types.length ? '' : 'border-dashed text-zinc-500'}">
					{step.target_types.length === 0 ? 'any type' : step.target_types.join(', ')}
				</span>
			{/snippet}
		</StereotypePicker>
		<button type="button" aria-label="Remove step" class="ml-auto …" onclick={() => onRemove(index)}>
			<Trash2 class="size-3.5" />
		</button>
	</div>
</div>
```
Import `ChainBadge from './ChainBadge.svelte'`. Keep the two `StereotypePicker` bodies exactly as they are today (only the trigger snippet's classes/labels change).

(c) `FilterStepRow.svelte` — same shape: `<ChainBadge value={null} />` (ghost), verb `Keep only`, the existing `CriterionRow` list rendered below the verb line (indented `pl-7`), the existing `+ condition` button, a `Remove filter`-titled `✕`. Keep `data-testid="filter-step"` and `aria-label="Remove step"` (the step-editor test's `conditionButtons()` helper scopes on the testid).

(d) `ScopeEditor.svelte` — drop the outer card/label; render inline: the types `StereotypePicker` trigger pill (unset text = `unsetLabel`, default `any element`, dashed+muted), the `+ condition` link, and the `CriterionRow`s below. Keep every handler.

(e) `PathCard.svelte`:

```svelte
<script lang="ts">
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		applyStructuralEdit,
		canEdit,
		getArtifactHeaders,
		getDraft,
		getMetamodel,
		getSelectedPath,
		registerVisibleNode,
		selectNode,
		unregisterVisibleNode,
		updateDefinition
	} from '$lib/state';
	import {
		chainColumns,
		elementStartScope,
		emptyCombine,
		insertGroupEdit,
		insertNavigationEdit,
		insertRefEdit,
		pathKey,
		precedingTargetTypes,
		readElementStart,
		setOperandStepIndex,
		titleForPath,
		updateNodeAt,
		type NodePath,
		type StructuralEdit
	} from '$lib/navigation/tree';
	import { effectivePropertiesForTypes } from '$lib/metamodel/helpers';
	import type { OperandChrome } from './chrome';
	// … NavStepItem / NavRelationshipStep / NavFilterStep / NavScope / PathNavigation / NavigationDefinition types
	// … ChainBadge, StatusChip, FeedsChip, OperandToolbar, ScopeEditor,
	//    ElementStartPicker, NavigationNode, RelationshipStepRow, FilterStepRow,
	//    StereotypePicker imports

	let {
		tabId,
		path,
		node,
		chrome = null
	}: {
		tabId: string;
		path: NodePath;
		node: PathNavigation;
		chrome?: OperandChrome | null;
	} = $props();
</script>
```

Behavior to implement (all handlers carried over verbatim from `PathLeafEditor.svelte` — `patch`, `structural`, `sourceTypesFor`, `propertyNamesFor`, `setStep`, `removeStep`, `addRelationshipStep`, `addFilterStep`, `startMode`, `setStartMode`):

- **Visibility registration** — the card is the node's on-screen presence:
  ```ts
  $effect(() => {
      const p = path;
      registerVisibleNode(tabId, p);
      return () => unregisterVisibleNode(tabId, p);
  });
  ```
- **Selection** — root `<div role="button" tabindex="0" data-testid="path-card" data-node-path={pathKey(path)} data-selected={isSelected}>` with
  ```ts
  function onCardClick(e: MouseEvent): void {
      // Inner controls own their clicks; only the card CHROME selects.
      if ((e.target as HTMLElement).closest('button, select, input, label, summary, a')) return;
      selectNode(tabId, path);
  }
  ```
  and `onkeydown` selecting on `Enter` when `e.target === e.currentTarget`. Selected ring: `class:ring-1` + `class:ring-sky-500`.
- **Header** — `titleForPath(draft.definition, path)`, `<StatusChip {tabId} {path} />`, amber `base` badge when `chrome?.isBase`, then (only when `chrome`) `<FeedsChip columns={chainColumns(node)} value={chrome.stepIndex} onPick={...} />` and `<OperandToolbar …/>`. The chip's `onPick`:
  ```ts
  function setFeeds(v: number | null): void {
      if (!draft || !chrome) return;
      updateDefinition(
          tabId,
          setOperandStepIndex(draft.definition, chrome.parentPath, chrome.index, v)
      );
  }
  ```
  The toolbar's handlers call `structural((r) => moveOperandEdit(r, chrome.parentPath, chrome.index, 'up'|'down'))` and `structural((r) => removeOperandEdit(r, chrome.parentPath, chrome.index))`.
- **Rail** — a `relative` column with a `1px` zinc-800 rail line (`before:absolute before:left-[9px] …` or a plain absolutely-positioned `<span>`), containing:
  - the start row: `<ChainBadge value={0} tone="start" />`, verb `Start from`, the `Start mode` select, then the mode's editor (`ScopeEditor` / `ElementStartPicker` / `<NavigationNode path={[...path,'start']} />`).
  - one `RelationshipStepRow` per relationship step with `column={columnFor(i)}` where
    ```ts
    // The rail's number for step i = 1 + (how many relationship steps precede it).
    function columnFor(i: number): number {
        let n = 1;
        for (let j = 0; j < i; j++) if (node.steps[j].kind === 'relationship') n++;
        return n;
    }
    ```
  - one `FilterStepRow` per filter step.
- **Add row** — two dashed-border buttons `+ Follow a relationship` / `+ Keep only…` (no menu), calling `addRelationshipStep` / `addFilterStep`.
- **Compose menu** — `DropdownMenu.Root` with trigger `Combine with… ▾` and three `DropdownMenu.Item`s. `A new path` → `structural((r) => insertNavigationEdit(r, path))`; `A nested combination` → `structural((r) => insertGroupEdit(r, path))`; `A saved navigation…` → sets `libraryOpen = true`, which opens a controlled `StereotypePicker` (`mode="create"`, `names={navHeaders.map(h => h.name)}`, `searchPlaceholder="Add saved navigation…"`) whose trigger snippet is an empty `<span class="inline-block h-0 w-0"></span>` anchor; its `onPick` resolves the header and calls `structural((r) => insertRefEdit(r, path, h.id))`.

  Each item renders a title `<span>` and a muted description `<span class="block text-[11px] text-zinc-500">`, using the exact copy listed above.
- **Options** — `<details class="…"><summary>Options</summary>` holding the `Exclude visited elements` checkbox with its existing `title` tooltip, wired to `patch({ exclude_visited })`. `{#if editable}` gates the compose menu and add row exactly as `PathLeafEditor` gated its compose toolbar.

(f) `NavigationNode.svelte`:

```svelte
<script lang="ts">
	import { getDraft } from '$lib/state';
	import { nodeAt, type NodePath } from '$lib/navigation/tree';
	import type { OperandChrome } from './chrome';
	import CombineFrame from './CombineFrame.svelte';
	import PathCard from './PathCard.svelte';

	let {
		tabId,
		path,
		chrome = null
	}: { tabId: string; path: NodePath; chrome?: OperandChrome | null } = $props();
	const draft = $derived(getDraft(tabId));
	const node = $derived(draft ? nodeAt(draft.definition, path) : null);
</script>

{#if node?.kind === 'set_op'}
	<CombineFrame {tabId} {path} {node} {chrome} />
{:else if node?.kind === 'path'}
	<PathCard {tabId} {path} {node} {chrome} />
{/if}
```

Task 4 must therefore also create a **minimal placeholder** `CombineFrame.svelte` so the module resolves. Do the honest thing: port `CombineEditor.svelte` to the new name/props signature now (accept `chrome`, ignore it), and give it its real design in Task 5. Delete `PathLeafEditor.svelte` and `CombineEditor.svelte` at the end of this step (`git rm`), updating `combine-editor.test.ts`'s import to `NavigationNode` (it already mounts `NavigationNode`, so nothing else changes) — but its `'+ insert navigation'` button lookups now belong to Task 5; temporarily point `rootButtonByText('+ insert navigation')` at the ported CombineFrame's still-unchanged button text.

- [ ] **Step 4: Run the tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Navigation'`
Expected: PASS — `path-card`, `step-editor`, `element-start`, `chain-preview`, `combine-editor`, `feeds-chip`, `status-chip`.

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors.

- [ ] **Step 5: Format and commit**

```bash
cd frontend && npx prettier --write src/lib/components/Navigation
cd .. && git add -A frontend/src/lib/components/Navigation
git commit -m "feat(navigation): path card with the numbered chain rail and sentence step rows"
```

---

## Task 5: `CombineFrame` + `RefCard`

**Files:**
- Rewrite: `frontend/src/lib/components/Navigation/CombineFrame.svelte`
- Create: `frontend/src/lib/components/Navigation/RefCard.svelte`
- Test: rename `__tests__/combine-editor.test.ts` → `__tests__/combine-frame.test.ts` and rework

**Interfaces:**
- Consumes: `OP_LABEL`, `OP_DIVIDER`, `titleForPath`, `moveOperandEdit`, `removeOperandEdit`, `insertNavigationEdit`, `insertGroupEdit`, `insertRefEdit`, `setOperandStepIndex`; `OperandChrome`; `StatusChip`, `FeedsChip`, `OperandToolbar`, `NavigationNode`.
- Produces:
  ```svelte
  <!-- CombineFrame.svelte --> { tabId; path; node: SetExpression; chrome?: OperandChrome | null }
  <!-- RefCard.svelte -->      { tabId; path: NodePath; refId: string; chrome: OperandChrome }
  ```

**Copy (exact):**
- Eyebrow: `Combination` (mono, uppercase via `uppercase tracking-[0.14em]`)
- Operator `<select aria-label="Combination operator">` options: values `union` / `intersection` / `difference` / `symmetric_difference`, labels from `OP_LABEL`
- Divider text from `OP_DIVIDER`
- Nested-as-operand header note: `contributes its members — no steps to feed`
- Add-part trigger: `+ Add another part ▾`; items:
  - `A new path` — `An empty path — build it with Start / Follow / Keep only`
  - `A saved navigation…` — `Pick one from the library; it stays linked, not copied`
  - `A nested combination` — `A combination inside this one, with its own operator`
- RefCard row: `⧉ <name>`, muted `saved navigation`, `<StatusChip kind="ref" />`, `FeedsChip` with a single column, `open ↗` (aria-label `Open saved navigation`), `OperandToolbar`
- Frame root: `data-testid="combine-frame"`, `data-node-path`, `data-selected`
- RefCard root: `data-testid="ref-card"`, `data-node-path`, `data-selected`

- [ ] **Step 1: Write the failing tests**

`git mv frontend/src/lib/components/Navigation/__tests__/combine-editor.test.ts frontend/src/lib/components/Navigation/__tests__/combine-frame.test.ts`, then rework it. Keep `combineOf`, `seedCombine`, `render`, `buttonsByLabel`. Replace `rootButtonByText` with a menu-driven helper:

```ts
/** Open the LAST "+ Add another part ▾" trigger in document order — the ROOT
 * frame's, since its add-row renders after every nested part — and click the
 * named item. */
function addPart(item: 'A new path' | 'A saved navigation…' | 'A nested combination'): void {
	const triggers = [...document.querySelectorAll('button')].filter(
		(b) => b.textContent?.trim() === '+ Add another part ▾'
	);
	(triggers.at(-1) as HTMLButtonElement).click();
	flushSync();
	const entry = [...document.querySelectorAll('[role="menuitem"], button')].find((b) =>
		b.textContent?.trim().startsWith(item)
	);
	if (!entry) throw new Error(`add-part item "${item}" not found`);
	(entry as HTMLElement).click();
	flushSync();
}
```

Tests:

```ts
it('"+ Add another part → A new path" appends an operand', async () => {
	// same body as the old 'insert navigation appends an operand', via addPart('A new path')
});

it('"+ Add another part → A nested combination" appends a nested set_op operand', async () => {
	// asserts operands.at(-1)?.definition?.kind === 'set_op'
});

it('remove operand down to one auto-unwraps to a bare path', async () => { /* unchanged */ });

it('reorder moves an operand', async () => { /* unchanged */ });

it('difference marks the first part with the base badge and the others without it', async () => {
	const tabId = 'nav:draft:difference';
	await seedCombine(tabId, ['A', 'B'], 'difference');
	const c = render(tabId);
	try {
		const badges = [...document.querySelectorAll('[data-testid="base-badge"]')];
		expect(badges).toHaveLength(1);
		expect(badges[0].textContent?.trim()).toBe('base');
	} finally {
		unmount(c);
	}
});

it('renders the operator word on the divider between consecutive parts', async () => {
	const tabId = 'nav:draft:divider';
	await seedCombine(tabId, ['A', 'B', 'C'], 'intersection');
	const c = render(tabId);
	try {
		const dividers = [...document.querySelectorAll('[data-testid="op-divider"]')];
		expect(dividers).toHaveLength(2); // between 3 parts
		expect(dividers[0].textContent).toContain('∩ intersection');
	} finally {
		unmount(c);
	}
});

it('a path part inside a combination gets a feeds chip; the frame itself does not', async () => {
	const tabId = 'nav:draft:feeds-presence';
	await seedCombine(tabId, ['A', 'B']);
	const c = render(tabId);
	try {
		expect(document.querySelectorAll('[data-testid="feeds-chip"]')).toHaveLength(2);
	} finally {
		unmount(c);
	}
});

it('a nested combination part shows the no-steps-to-feed note and no chip', async () => {
	const tabId = 'nav:draft:nested-note';
	await ensureDraft(tabId);
	updateDefinition(tabId, {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: pathOf('A'), step_index: null },
			{ definition: combineOf(['B', 'C']), step_index: null }
		]
	});
	flushSync();
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('contributes its members — no steps to feed');
		// paths A, B, C each get one chip; the nested frame gets none.
		expect(document.querySelectorAll('[data-testid="feeds-chip"]')).toHaveLength(3);
	} finally {
		unmount(c);
	}
});

it('a ref operand renders a compact ref card with the artifact name', async () => {
	const tabId = 'nav:draft:refcard';
	setArtifactHeaders([
		{ id: 'nav-1', kind: 'navigation', name: 'Sensors network', updated_at: '', updated_by: null }
	]);
	await ensureDraft(tabId);
	updateDefinition(tabId, {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: pathOf('A'), step_index: null },
			{ ref: 'nav-1', step_index: null }
		]
	});
	flushSync();
	const c = render(tabId);
	try {
		const card = document.querySelector('[data-testid="ref-card"]');
		expect(card?.textContent).toContain('Sensors network');
		expect(card?.textContent).toContain('saved navigation');
		expect(card?.textContent).toContain('linked');
	} finally {
		unmount(c);
	}
});

it('the feeds chip writes step_index for the operand it belongs to', async () => {
	const tabId = 'nav:draft:feeds-write';
	await seedCombine(tabId, ['A', 'B']);
	const c = render(tabId);
	try {
		const chips = [...document.querySelectorAll('[data-testid="feeds-chip"]')] as HTMLElement[];
		chips[1].click();
		flushSync();
		const opts = [...document.querySelectorAll('[data-testid="feeds-option"]')] as HTMLElement[];
		opts[0].click(); // single-column path -> the last-step default -> null
		flushSync();
		expect((getDraft(tabId)!.definition as SetExpression).operands[1].step_index).toBeNull();
	} finally {
		unmount(c);
	}
});
```

Helpers `pathOf(type)` (a single-start path) and a `setArtifactHeaders` seed: check how `artifacts.svelte.ts` exposes headers — if there is no setter, mock `artifactsApi.listArtifacts` and `await loadArtifacts()` in the test instead (the existing `resetArtifacts` import shows the module's surface). Use whichever the module actually supports; do not add a new store export just for the test.

Since `CombineFrame` renders each path part, mounting it requires a metamodel for the step rows' pickers. `combine-editor.test.ts` didn't set one and passed — keep it that way (`getMetamodel()` returns null → empty picker lists).

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Navigation/__tests__/combine-frame.test.ts'`
Expected: FAIL — `+ Add another part ▾` not found.

- [ ] **Step 3: Implement**

`CombineFrame.svelte`:
- Indigo-accented frame: `rounded-lg border border-indigo-400/35 bg-indigo-400/[0.035] p-3`; a `depth` derived from `path.length` deepens the tint one notch when nested (`bg-indigo-400/[0.05]`, then `/[0.07]`).
- Header row: mono uppercase `Combination` eyebrow (`text-[10px] tracking-[0.14em] text-indigo-400`), the operator `<select>` (`OP_LABEL` options, `onchange` → `mutate((r) => updateNodeAt(r, path, (n) => ({...(n as SetExpression), op})))`), the `contributes its members — no steps to feed` note **only when `chrome` is set** (a nested frame used as a part), a spacer, and `{#if chrome}<OperandToolbar …/>{/if}`.
- Parts: `{#each node.operands as op, i (i)}` rendering
  - `{#if i > 0}<div data-testid="op-divider" class="…">{OP_DIVIDER[node.op]}</div>{/if}`
  - `{#if op.definition}<NavigationNode {tabId} path={[...path, i]} chrome={chromeFor(i)} />{:else if op.ref}<RefCard {tabId} path={[...path, i]} refId={op.ref} chrome={chromeFor(i)} />{/if}`
  where
  ```ts
  function chromeFor(i: number): OperandChrome {
      return {
          parentPath: path,
          index: i,
          total: node.operands.length,
          stepIndex: node.operands[i].step_index ?? null,
          isBase: node.op === 'difference' && i === 0
      };
  }
  ```
- Bottom: the `+ Add another part ▾` DropdownMenu (three items with the exact copy above), wired to `insertNavigationEdit` / controlled `StereotypePicker` + `insertRefEdit` / `insertGroupEdit` — identical wiring to `PathCard`'s compose menu, just different copy and no auto-wrap (the target is already a `set_op`).
- Selection: same `role="button"`/`data-selected`/`onCardClick` treatment as `PathCard` (the frame is a selectable node — the dock's `Whole combination` entry).
- Registration: the same `$effect` register/unregister pair as `PathCard`.
- The Difference `base` badge lives in the PART's header (PathCard / RefCard / nested CombineFrame), rendered when `chrome.isBase`:
  `<span data-testid="base-badge" class="rounded bg-amber-500/10 px-1 font-mono text-[10px] text-amber-400">base</span>`
  Add it to `PathCard`'s header in this task if Task 4 left it out.

`RefCard.svelte`:

```svelte
<script lang="ts">
	// A LINKED library navigation used as a combination part. It is not
	// editable inline and carries no definition, so the store cannot evaluate
	// it (`nodeAt` returns null for a ref operand) — hence the muted `linked`
	// chip instead of a chain count, and a feeds popover offering only the
	// last-step default (a ref's column count is unknowable client-side
	// without fetching it; out of scope).
	import { ExternalLink } from '@lucide/svelte';
	import {
		applyStructuralEdit,
		artifactHeaderById,
		canEdit,
		getDraft,
		getSelectedPath,
		selectNode,
		updateDefinition
	} from '$lib/state';
	import { openNavigationTab } from '$lib/state/workspace.svelte';
	import {
		moveOperandEdit,
		pathKey,
		removeOperandEdit,
		setOperandStepIndex,
		type NodePath
	} from '$lib/navigation/tree';
	import type { OperandChrome } from './chrome';
	import FeedsChip from './FeedsChip.svelte';
	import OperandToolbar from './OperandToolbar.svelte';
	import StatusChip from './StatusChip.svelte';
</script>
```
Markup: one row — `⧉ {name}` (sky-400), muted `saved navigation`, `<StatusChip {tabId} {path} kind="ref" />`, the base badge when `chrome.isBase`, a spacer, `<FeedsChip columns={[{ index: 0, label: 'Start' }]} value={chrome.stepIndex} onPick={setFeeds} />`, an `open ↗` link-button (`aria-label="Open saved navigation"`) calling `openNavigationTab({ artifactId: refId, title: name })`, and `<OperandToolbar …/>`. **No** visibility registration — a ref has no evaluable node.

Resolve the name via `artifactHeaderById(refId)?.name ?? refId` (confirm the export name in `state/artifacts.svelte.ts`; `state/index.ts:203` exports `artifactHeaderById`).

- [ ] **Step 4: Run the tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Navigation'`
Expected: PASS.
Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'` → 0 errors.

- [ ] **Step 5: Format and commit**

```bash
cd frontend && npx prettier --write src/lib/components/Navigation
cd .. && git add -A frontend/src/lib/components/Navigation
git commit -m "feat(navigation): combination frame with plain-language operators and ref cards"
```

---

## Task 6: `ResultsDock` + `NavigationBuilder` layout

**Files:**
- Create: `frontend/src/lib/components/Navigation/ResultsDock.svelte`
- Modify: `frontend/src/lib/components/Navigation/NavigationBuilder.svelte`
- Delete: `frontend/src/lib/components/Navigation/ChainPreview.svelte`
- Test: rename `__tests__/chain-preview.test.ts` → `__tests__/results-dock.test.ts` and rework

**Interfaces:**
- Consumes: `nodeEntries`, `chainColumns`, `OP_NOTE`, `titleForPath`, `nodeAt`, `pathKey`; `getSelectedPath`, `selectNode`, `getPreview`, `getEvalError`, `loadMorePreview`, `isRunnable`, `select` (model-inspector selection).
- Produces: `<ResultsDock {tabId} />`.

**Copy (exact):**
- Eyebrow `Results`; picker `<select data-testid="node-picker" aria-label="Results node">`
- Status: `auto-runs as you edit · ✓ N chains` / `auto-runs as you edit · evaluating…` / `auto-runs as you edit · waiting for a runnable path` / `Evaluation failed — edit the definition to retry`
- Combination header cell: `Combined elements` + muted `OP_NOTE[op]`
- Empty states:
  - pristine root draft: `Pick what to start from — results appear here automatically as you build.`
  - other incomplete node: `Nothing to run yet — pick what ⟨title⟩ starts from, or add a step. Results appear here automatically.`
  - ref node: `Linked saved navigation — open it in its own tab to see its results.`
- `Load more` button (existing `loadMorePreview` paging), `(results capped)` when `preview.truncated`
- Root container `data-testid="results-dock"`

- [ ] **Step 1: Write the failing tests**

`git mv __tests__/chain-preview.test.ts __tests__/results-dock.test.ts`. Keep `CHAIN_PAGE`, `runnablePath`, `filterNarrowedPath` and the beforeEach/afterEach. Mount `ResultsDock` with `{ tabId }` only. Tests:

```ts
it('renders the selected node’s chains with rail-numbered column headers', async () => {
	// seed runnablePath(), await runPreview(tabId, []), mount.
	// headers: two <th>, first contains badge '0' and 'Start',
	// second contains badge '1' and 'Uses'.
	// status line contains 'auto-runs as you edit' and '✓ 1 chains'
	// one tbody row, one 'b1' element pill button.
});

it('a filter step adds no column', async () => {
	// filterNarrowedPath() -> exactly 2 <th> (Start, Uses)
});

it('shows the evaluation error line when the last run failed', async () => {
	// expects 'Evaluation failed — edit the definition to retry'
});

it('a pristine draft shows the fresh-draft empty state', async () => {
	// 'Pick what to start from — results appear here automatically as you build.'
	// and 'waiting for a runnable path' in the status
});

it('an incomplete non-root node names itself in the empty state', async () => {
	// combine of [runnablePath('A'), emptyPath()]; selectNode(tabId, [1])
	// -> 'Nothing to run yet — pick what Path B starts from, or add a step.'
});

it('a combination node shows one Combined elements column with the operator note', async () => {
	// combine of two runnable paths, root selected, evaluate mocked
	// -> 'Combined elements' and "(union of the parts' fed steps)"
});

it('the node picker lists the tree and selecting an entry moves the dock', async () => {
	// combine of two paths: options are ['Path A','Path B','Whole combination']
	// set the select to pathKey '1' + dispatch 'change' -> getSelectedPath === [1]
});

it('a selected ref node shows the linked empty state', async () => {
	// operands [path, {ref:'nav-1'}]; selectNode(tabId, [1])
	// -> 'Linked saved navigation — open it in its own tab to see its results.'
});

it('Load more pages the selected node’s chains', async () => {
	// PAGE_1 then PAGE_2 mocks; click 'Load more'; expect two rows
});
```

Write each of these out in full (no `// …` in the committed test file) following the file's existing mount/unmount + `try/finally` idiom.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Navigation/__tests__/results-dock.test.ts'`
Expected: FAIL — cannot resolve `../ResultsDock.svelte`.

- [ ] **Step 3: Implement**

`ResultsDock.svelte`:

```ts
const draft = $derived(getDraft(tabId));
const selected = $derived(getSelectedPath(tabId));
const entries = $derived(
    draft ? nodeEntries(draft.definition, (id) => artifactHeaderById(id)?.name) : []
);
const selectedEntry = $derived(entries.find((e) => pathKey(e.path) === pathKey(selected)));
const node = $derived(draft ? nodeAt(draft.definition, selected) : null);
const preview = $derived(getPreview(tabId, selected));
const errored = $derived(getEvalError(tabId, selected));
const runnable = $derived(node ? isRunnable(node) : false);
const columns = $derived(node?.kind === 'path' ? chainColumns(node) : []);
const isPristineRoot = $derived(
    selected.length === 0 && node?.kind === 'path' && !runnable && node.steps.length === 0
);
```
- Header: eyebrow, `<select data-testid="node-picker">` whose options are `{#each entries as e}` with `value={pathKey(e.path)}` and label `'  '.repeat(e.depth ? e.depth - (rootIsPath ? 0 : 1) : 0) + (e.kind === 'ref' ? `⧉ ${e.title}` : e.title)` — indent by `depth`, prefix refs with `⧉`. `onchange` → `selectNode(tabId, parsePathKeyLocal(value))`. Since `parsePathKey` is private to the store, select by matching the entry: `const entry = entries.find(e => pathKey(e.path) === value); if (entry) selectNode(tabId, entry.path);` — no new store export.
- Status span, per the copy list.
- Body:
  - `selectedEntry?.kind === 'ref'` → the linked empty state.
  - `errored && !preview` → the error line (also shown in the status).
  - `!preview && !runnable` → pristine-root or named-node empty state (`titleForPath(draft.definition, selected)` supplies `⟨title⟩`).
  - `preview` → the table. `<thead>`: for `node.kind === 'set_op'`, one `<th>Combined elements <span class="text-zinc-500">{OP_NOTE[node.op]}</span></th>`; otherwise one `<th>` per `columns` entry containing `<ChainBadge value={col.index} />` + `col.label`. `<tbody>`: the existing chain rows with the element pill buttons calling `select({ kind: 'element', id: item.id })`. `Load more` when `preview.chains.length < preview.total`; `Evaluating…` when `preview.loading`; `(results capped)` when `preview.truncated`.

`NavigationBuilder.svelte`: keep `ensureDraft`, `save`, `saveAs`, `saveError`, the conflict banner and the `canEdit` gating **verbatim**. Restyle:
- Topbar: `<input data-testid="nav-name" class="w-56 …">`, a dirty dot `{#if draft.dirty}<span title="Unsaved changes" class="text-amber-400">●</span>{/if}`, spacer, `Save` (emerald) + `Save as…`. Keep the `Save{draft.dirty ? ' *' : ''}` accessible name so the button's name still matches `/^Save( \*)?$/`.
- Body: `<div class="flex min-h-0 flex-1 flex-col">` with an editor scroll region (`min-h-0 flex-1 overflow-auto p-4` wrapping `<div class="mx-auto max-w-[820px]"><NavigationNode {tabId} path={[]} /></div>`), a `<ResizeHandle axis="y" value={dockHeight} min={120} max={640} onchange={(v) => (dockHeight = v)} />`, and `<div class="flex-none" style="height:{dockHeight}px"><ResultsDock {tabId} /></div>` with `let dockHeight = $state(280)`.

`git rm frontend/src/lib/components/Navigation/ChainPreview.svelte` — verify nothing imports it: `grep -rn "ChainPreview" frontend/src` returns nothing.

- [ ] **Step 4: Run the full unit suite + check**

```
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
```
Expected: all green, 0 check errors.

- [ ] **Step 5: Format and commit**

```bash
cd frontend && npx prettier --write src/lib/components/Navigation
cd .. && git add -A frontend/src/lib/components/Navigation
git commit -m "feat(navigation): results dock replaces the nested chain previews"
```

---

## Task 7: e2e rewrite + full gates

**Files:**
- Rewrite: `frontend/e2e/navigation.spec.ts`

**Interfaces:** consumes the `data-testid`s and copy fixed by Tasks 3–6: `path-card`, `combine-frame`, `ref-card`, `feeds-chip`, `feeds-option`, `status-chip`, `base-badge`, `op-divider`, `node-picker`, `results-dock`, `nav-name`, `relationship-step`, `filter-step`.

- [ ] **Step 1: Write the new spec**

Preserve the fixture-facts comment block from the current file verbatim (12 SoftwareSystems, `SystemContainsComponent` reaching Component subtypes, `language: python` on 5 reached Microservices), and rewrite the flow:

```ts
import { expect, test } from '@playwright/test';
import { openDefaultProject } from './helpers/auth';

/**
 * Drives the refactored navigation builder (chain rail + results dock):
 * build a root Path (start types → "+ Follow a relationship" → "+ Keep only…"),
 * "Combine with… → A new path" to auto-wrap it into a Union, select nodes via
 * the cards AND the dock picker, assert the dock's numbered column headers and
 * the per-card status chips, set a "→ feeds" value, flip the operator to
 * Difference and see the `base` badge, then Save / Save as… / reopen and
 * assert the structure round-trips.
 *
 * Fixture facts relied on below (examples/smart-city.model.json,
 * smart-city.metamodel.yaml):
 *  - 12 SoftwareSystem elements; SystemContainsComponent (source: System,
 *    target: Component, no explicit `mappings`) hops from them reach every
 *    Component subtype (Service, Microservice, Database, MessageBroker,
 *    Cache) — the relationship step's own target-type picker only offers the
 *    metamodel-declared "Component" (not its concrete subtypes), so the step
 *    below deliberately leaves target types unset ("any type") and instead
 *    narrows via the filter step below.
 *  - `language` is a Microservice-only property (unique across the whole
 *    metamodel) with values including "python"; 5 of the 28 Microservices
 *    reached this way have `language: "python"` — so the relationship-step +
 *    filter-step combo below is guaranteed to produce a non-empty preview.
 */
test('build, combine, select nodes, save, save-as, and reopen round-trips the structure', async ({
	page
}) => {
	test.setTimeout(120_000);
	await openDefaultProject(page);

	// --- 1. Open a new navigation tab ---------------------------------------
	await page.getByRole('button', { name: 'New navigation' }).click();
	await expect(page.getByText('New navigation', { exact: true })).toBeVisible();
	const tabpanel = page.getByRole('tabpanel');
	const dock = tabpanel.getByTestId('results-dock');

	// A fresh draft is not runnable: the dock says so, directively.
	await expect(dock).toContainText('Pick what to start from');

	// --- 2. Build the root Path ---------------------------------------------
	// Start types: StereotypePicker in `filter` mode (checkbox list). Set this
	// BEFORE adding the hop so its own unset target pill ("any type") can't
	// collide with the start pill ("any element").
	await tabpanel.getByText('any element', { exact: true }).click();
	await page.getByPlaceholder('Filter types…').fill('SoftwareSystem');
	await page.getByRole('checkbox', { name: 'SoftwareSystem', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(tabpanel.getByText('SoftwareSystem', { exact: true })).toBeVisible();

	await tabpanel.getByRole('button', { name: '+ Follow a relationship' }).click();
	const relStep = tabpanel.getByTestId('relationship-step');
	await expect(relStep).toHaveCount(1);
	await relStep.getByText('pick a relationship…', { exact: true }).click();
	await page.getByPlaceholder('Relationship type…').fill('SystemContainsComponent');
	await page.getByRole('button', { name: 'SystemContainsComponent', exact: true }).click();
	await expect(relStep.getByText('SystemContainsComponent', { exact: true })).toBeVisible();

	await tabpanel.getByRole('button', { name: '+ Keep only…' }).click();
	const filterStep = tabpanel.getByTestId('filter-step');
	await expect(filterStep).toHaveCount(1);
	await filterStep.getByRole('button', { name: '+ condition' }).click();
	await filterStep.getByText('property…', { exact: true }).click();
	await page.getByPlaceholder('Filter properties…').fill('language');
	await page.getByRole('button', { name: 'language' }).click();
	await filterStep.getByPlaceholder('value').fill('python');

	// --- 3. The dock auto-runs the (selected, default-root) path ------------
	await expect(dock).toContainText(/✓ \d+ chains/, { timeout: 15_000 });
	// Column headers mirror the rail: Start | SystemContainsComponent.
	await expect(dock.locator('thead th')).toHaveCount(2);
	await expect(dock.locator('thead th').nth(1)).toContainText('SystemContainsComponent');

	// --- 4. "Combine with… → A new path" auto-wraps into a Union -----------
	await tabpanel.getByRole('button', { name: 'Combine with… ▾' }).click();
	await page.getByRole('menuitem', { name: /A new path/ }).click();
	await expect(tabpanel.getByTestId('combine-frame')).toHaveCount(1);
	await expect(tabpanel.getByTestId('path-card')).toHaveCount(2);
	await expect(tabpanel.getByTestId('op-divider')).toContainText('∪ union');
	// The built steps travelled into operand 0 unchanged…
	await expect(tabpanel.getByTestId('relationship-step')).toHaveCount(1);
	await expect(tabpanel.getByTestId('filter-step')).toHaveCount(1);
	// …and the selection followed the node (applyStructuralEdit remap), so the
	// dock still shows Path A's chains rather than falling back to the root.
	await expect(tabpanel.getByTestId('node-picker')).toHaveValue('0');
	await expect(dock).toContainText(/✓ \d+ chains/, { timeout: 15_000 });

	// Path B is empty: its card status chip says so.
	const pathB = tabpanel.getByTestId('path-card').nth(1);
	await expect(pathB.getByTestId('status-chip')).toContainText('incomplete');

	// --- 5. Selection: card click and dock picker are the two ways ----------
	await pathB.click();
	await expect(tabpanel.getByTestId('node-picker')).toHaveValue('1');
	await expect(dock).toContainText('Nothing to run yet — pick what Path B starts from');

	await tabpanel.getByTestId('node-picker').selectOption('');
	await expect(dock).toContainText('Combined elements');
	await expect(tabpanel.getByTestId('combine-frame')).toHaveAttribute('data-selected', 'true');

	// --- 6. The feeds chip writes step_index -------------------------------
	const pathA = tabpanel.getByTestId('path-card').first();
	await pathA.getByTestId('feeds-chip').click();
	await page.getByTestId('feeds-option').first().click(); // "the start"
	await expect(pathA.getByTestId('feeds-chip')).toContainText('the start');

	// --- 7. Difference marks the first part `base` -------------------------
	const operator = tabpanel.getByRole('combobox', { name: 'Combination operator' });
	await operator.selectOption('difference');
	await expect(tabpanel.getByTestId('base-badge')).toHaveCount(1);
	await expect(tabpanel.getByTestId('op-divider')).toContainText('− minus');
	await operator.selectOption('union'); // back to a union for the round-trip

	// --- 8. Save, then Save as… --------------------------------------------
	const nameInput = tabpanel.getByTestId('nav-name');
	await expect(nameInput).toHaveValue('New navigation');
	await nameInput.fill('Nav base');
	await tabpanel.getByRole('button', { name: /^Save( \*)?$/ }).click();
	const navBaseItem = page
		.locator('[data-artifact-id]')
		.filter({ has: page.locator('span.flex-1', { hasText: /^Nav base$/ }) });
	await expect(navBaseItem).toBeVisible();

	page.on('dialog', (dialog) => void dialog.accept('Nav base copy'));
	await tabpanel.getByRole('button', { name: /Save as/ }).click();
	const navBaseCopyItem = page
		.locator('[data-artifact-id]')
		.filter({ has: page.locator('span.flex-1', { hasText: /^Nav base copy$/ }) });
	await expect(navBaseCopyItem).toBeVisible();
	await expect(navBaseItem).toBeVisible();

	// --- 9. Reopen the ORIGINAL and verify the round-trip ------------------
	await page.getByRole('button', { name: 'Close Nav base copy' }).click();
	await navBaseItem.dblclick();
	const reopened = page.getByRole('tabpanel');
	await expect(reopened.getByTestId('combine-frame')).toHaveCount(1);
	await expect(reopened.getByTestId('path-card')).toHaveCount(2);
	await expect(reopened.getByTestId('results-dock')).toContainText(/✓ \d+ chains/, {
		timeout: 15_000
	});

	const reopenedRelStep = reopened.getByTestId('relationship-step');
	await expect(reopenedRelStep).toHaveCount(1);
	await expect(reopenedRelStep.getByText('SystemContainsComponent', { exact: true })).toBeVisible();
	const reopenedFilterStep = reopened.getByTestId('filter-step');
	await expect(reopenedFilterStep).toHaveCount(1);
	await expect(reopenedFilterStep.getByPlaceholder('value')).toHaveValue('python');
	// step_index survived the save/reopen: Path A still feeds the start.
	await expect(reopened.getByTestId('path-card').first().getByTestId('feeds-chip')).toContainText(
		'the start'
	);
});
```

Notes for the implementer:
- The reopened root is a Combination, whose dock default selection is the root (`Whole combination`) — so the `✓ N chains` assertion targets the union's own evaluate. If the union of a python-filtered path and an EMPTY path is not runnable, adjust the reopen assertion to select `Path A` in the picker first (`selectOption('0')`) rather than weakening the assertion. `isRunnable` on a `set_op` is `operands.length > 0`, so the union does run.
- If the DropdownMenu items don't expose `role="menuitem"` under Playwright, fall back to `page.getByRole('button', { name: /A new path/ })`.
- Anything that fails here is a real UI bug — fix the component, don't loosen the selector.

- [ ] **Step 2: Run the e2e suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`
Expected: PASS (the whole e2e suite — `navigation.spec.ts` plus every other spec, since the tabpanel/name-input selectors moved).

`grep -rn "input.w-56\|Toggle preview\|+ insert navigation\|+ relationship step\|+ filter step" frontend/e2e` must return nothing.

- [ ] **Step 3: Run all three gates**

```
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'
```
Expected: all green. Then confirm no NEW prettier failures:
```
pixi run -e frontend bash -c 'cd frontend && npm run lint' 2>&1 | tail -20
```
Expected: exactly the two pre-existing failures (`ProjectCard.test.ts`, `UsersTab.test.ts`) and nothing else.

- [ ] **Step 4: Commit**

```bash
cd frontend && npx prettier --write e2e/navigation.spec.ts
cd .. && git add frontend/e2e/navigation.spec.ts
git commit -m "test(e2e): drive the chain-rail navigation builder and results dock"
```

---

## Final review checklist (run before declaring done)

- [ ] `grep -rn "toggleExpanded\|isExpanded\|ChainPreview\|PathLeafEditor\|CombineEditor" frontend/src frontend/e2e` returns nothing.
- [ ] `frontend/src/lib/state/navigation-editor.svelte.ts` still contains, unchanged in behavior: the 400 ms debounce, `bumpGeneration`/`isCurrent` guards, `scheduleAutoRun`'s fire-time `nodeAt` re-read, `rekeyTab`'s pending-timer reschedule and in-flight re-issue, and `applyStructuralEdit`'s expanded-key remap. The only additions are `_selected`, `_visibleCounts`, and their handling in those same functions.
- [ ] The store's module docstring describes visible-node registration (not the collapse toggle) and the selection map.
- [ ] All three gates green; `npm run lint` shows only the two pre-existing failures.
- [ ] `git log --oneline main..HEAD` shows one commit per task, conventional style.
