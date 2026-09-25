# Metamodel Navigation at Scale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a very large metamodel comfortable to consult, navigate and edit: unbounded zoom-out with a level-of-detail render mode (P-17), hover highlighting with dimming (P-18), type search with autocomplete that pans the canvas to the selection, and a side panel that becomes a collapsible table of contents and can be hidden entirely.

**Architecture:** Frontend-only presentation work on the metamodel diagram surface. A new pure adjacency/highlight module (`diagram-adjacency.ts`) plus a small reactive canvas-state module (`metamodel-canvas.svelte.ts`) let node/edge components derive their own hover/LOD classes with **no array rebuilds on hover**. Search and the panel TOC navigate through one shared `revealSelection` helper over a pure `revealTarget` function. Panel collapse state is a second small state module persisted per-project in localStorage.

**Tech Stack:** Svelte 5 (runes), `@xyflow/svelte` 1.5.2, TypeScript, vitest + happy-dom (svelte `mount`/`flushSync`, no testing-library), Tailwind + CSS tokens.

**Spec:** `docs/superpowers/specs/2026-08-20-metamodel-navigation-at-scale-design.md`

## Global Constraints

- **Frontend-only.** No backend routes, no wire schema, no lease/commit/staging changes, no `yaml-edit.ts` changes.
- **Hover must never rebuild `flowNodes`/`flowEdges`** (spec §3). LOD may ride a rebuild only at threshold crossings — in this plan it doesn't rebuild anything either (visibility-based, see Task 3).
- **`nodeSize` and elk layout untouched.** LOD hides content with `visibility: hidden` so DOM heights — and therefore edge anchors — are byte-identical in both modes.
- **Colours are CSS tokens only** (`var(--…)`, `color-mix`), never hex literals — the standing convention in `Metamodel/diagram/`.
- **All four features are read affordances**: available to viewers; nothing consults `readOnly`/`canDragLayout`.
- LOD hysteresis: enter below **0.4**, exit above **0.5** (`LOD_ENTER`/`LOD_EXIT`, exported constants).
- Commands: full suite `pixi run frontend-test`; single file `pixi run frontend-test -- -- <path>` (the double `--`: pixi passes the rest to `npm test`, npm passes what follows its own `--` to vitest); typecheck `pixi run frontend-check`; format/lint `pixi run dr-tidy`.
- Every commit message ends with the repo's standard trailer (see the harness Git rules).
- Dense docstrings explaining *why* are the house style — preserve it in every new module.

---

### Task 1: Adjacency index + highlight/label/visual-state pure helpers

**Files:**
- Create: `frontend/src/lib/metamodel/diagram-adjacency.ts`
- Test: `frontend/src/lib/metamodel/diagram-adjacency.test.ts`
- Branch setup (first step).

**Interfaces:**
- Consumes: `DiagramEdgeSpec` from `$lib/metamodel/diagram-build` and `selectionForNodeId` from the same module.
- Produces (later tasks rely on these exact names):
  - `type DiagramHover = { kind: 'node'; id: string } | { kind: 'edge'; id: string; relName: string | null }`
  - `interface DiagramAdjacency { edgeEndpoints; nodeEdges; relEdges; relNodes }` (ReadonlyMap/ReadonlySet as below)
  - `buildAdjacency(edges: DiagramEdgeSpec[]): DiagramAdjacency`
  - `interface HighlightSet { nodes: ReadonlySet<string>; edges: ReadonlySet<string> }`
  - `highlightFor(hover: DiagramHover, adj: DiagramAdjacency): HighlightSet`
  - `hoverLabel(hover: DiagramHover, adj: DiagramAdjacency): string | null`
  - `visualState(id: string, kind: 'node' | 'edge', selected: boolean, highlight: HighlightSet | null): 'hot' | 'dim' | 'normal'`

- [ ] **Step 1: Create the branch**

```bash
cd /home/mdp/workspace/data-rover-py && git checkout -b feat/metamodel-navigation
```

- [ ] **Step 2: Write the failing test**

Create `frontend/src/lib/metamodel/diagram-adjacency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { DiagramEdgeSpec } from './diagram-build';
import {
	buildAdjacency,
	highlightFor,
	hoverLabel,
	visualState,
	type DiagramHover
} from './diagram-adjacency';

/** Hand-built edge list mirroring the FIXTURE metamodel's shapes: one
 * generalization, one plain association, and one boxed relationship whose two
 * tether halves must read as ONE relationship. */
const EDGES: DiagramEdgeSpec[] = [
	{ id: 'gen:el:Zone', source: 'el:Zone', target: 'el:NamedElement', type: 'generalization', data: {} },
	{
		id: 'assoc:Contains:0',
		source: 'el:Zone',
		target: 'el:Building',
		type: 'association',
		data: { relName: 'Contains' }
	},
	{
		id: 'assoc-in:Monitors:0',
		source: 'el:Building',
		target: 'rel:Monitors',
		type: 'association',
		data: { relName: 'Monitors' }
	},
	{
		id: 'assoc-out:Monitors:0',
		source: 'rel:Monitors',
		target: 'el:Zone',
		type: 'association',
		data: { relName: 'Monitors' }
	}
];

describe('buildAdjacency', () => {
	const adj = buildAdjacency(EDGES);

	it('indexes every edge (generalizations included) under both endpoints', () => {
		expect(adj.nodeEdges.get('el:Zone')).toEqual(
			new Set(['gen:el:Zone', 'assoc:Contains:0', 'assoc-out:Monitors:0'])
		);
		expect(adj.nodeEdges.get('el:NamedElement')).toEqual(new Set(['gen:el:Zone']));
	});

	it('groups a boxed relationship’s tether halves under one rel name', () => {
		expect(adj.relEdges.get('Monitors')).toEqual(
			new Set(['assoc-in:Monitors:0', 'assoc-out:Monitors:0'])
		);
		expect(adj.relNodes.get('Monitors')).toEqual(
			new Set(['el:Building', 'rel:Monitors', 'el:Zone'])
		);
	});

	it('records each edge’s two endpoints', () => {
		expect(adj.edgeEndpoints.get('gen:el:Zone')).toEqual(['el:Zone', 'el:NamedElement']);
	});
});

describe('highlightFor', () => {
	const adj = buildAdjacency(EDGES);

	it('node hover lights the node, every incident edge, and each other endpoint', () => {
		const h = highlightFor({ kind: 'node', id: 'el:Zone' }, adj);
		expect(h.nodes).toEqual(new Set(['el:Zone', 'el:NamedElement', 'el:Building', 'rel:Monitors']));
		expect(h.edges).toEqual(new Set(['gen:el:Zone', 'assoc:Contains:0', 'assoc-out:Monitors:0']));
	});

	it('association hover lights ALL edges of the relationship plus every endpoint', () => {
		const h = highlightFor({ kind: 'edge', id: 'assoc-in:Monitors:0', relName: 'Monitors' }, adj);
		expect(h.edges).toEqual(new Set(['assoc-in:Monitors:0', 'assoc-out:Monitors:0']));
		expect(h.nodes).toEqual(new Set(['el:Building', 'rel:Monitors', 'el:Zone']));
	});

	it('generalization hover (no relName) lights just that edge and its two boxes', () => {
		const h = highlightFor({ kind: 'edge', id: 'gen:el:Zone', relName: null }, adj);
		expect(h.edges).toEqual(new Set(['gen:el:Zone']));
		expect(h.nodes).toEqual(new Set(['el:Zone', 'el:NamedElement']));
	});

	it('a hover over something no longer indexed yields an empty set, not a crash', () => {
		const h = highlightFor({ kind: 'node', id: 'el:Gone' }, adj);
		expect(h.nodes).toEqual(new Set(['el:Gone']));
		expect(h.edges).toEqual(new Set());
	});
});

describe('hoverLabel', () => {
	const adj = buildAdjacency(EDGES);

	it('names the hovered thing: node name, rel name, or sub ▷ super', () => {
		expect(hoverLabel({ kind: 'node', id: 'el:Zone' }, adj)).toBe('Zone');
		expect(hoverLabel({ kind: 'edge', id: 'assoc:Contains:0', relName: 'Contains' }, adj)).toBe(
			'Contains'
		);
		expect(hoverLabel({ kind: 'edge', id: 'gen:el:Zone', relName: null }, adj)).toBe(
			'Zone ▷ NamedElement'
		);
	});

	it('returns null for an unindexed generalization edge', () => {
		expect(hoverLabel({ kind: 'edge', id: 'gen:el:Gone', relName: null }, adj)).toBeNull();
	});
});

describe('visualState', () => {
	const hl = { nodes: new Set(['el:A']), edges: new Set(['e1']) };

	it('is normal with no highlight active', () => {
		expect(visualState('el:A', 'node', false, null)).toBe('normal');
	});
	it('is hot inside the set, dim outside it', () => {
		expect(visualState('el:A', 'node', false, hl)).toBe('hot');
		expect(visualState('el:B', 'node', false, hl)).toBe('dim');
		expect(visualState('e1', 'edge', false, hl)).toBe('hot');
		expect(visualState('e2', 'edge', false, hl)).toBe('dim');
	});
	it('a selected element outside the set stays normal, never dim (spec §5)', () => {
		expect(visualState('el:B', 'node', true, hl)).toBe('normal');
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pixi run frontend-test -- -- src/lib/metamodel/diagram-adjacency.test.ts`
Expected: FAIL — cannot resolve `./diagram-adjacency`.

- [ ] **Step 4: Write the implementation**

Create `frontend/src/lib/metamodel/diagram-adjacency.ts`:

```ts
import { selectionForNodeId, type DiagramEdgeSpec } from './diagram-build';

/**
 * Adjacency over a built diagram, derived ONCE per `buildDiagram` result and
 * read on every hover (spec 2026-08-20 §3.2). Pure and O(edges): hover
 * handling must never walk the metamodel, and — the load-bearing rule — must
 * never rebuild the flow's node/edge arrays, so everything a node or edge
 * component needs to style itself is precomputed here.
 *
 * Generalization edges participate but have no relationship NAME, so they are
 * reachable through `nodeEdges`/`edgeEndpoints` (keyed by edge id) rather
 * than `relEdges`/`relNodes` (keyed by rel name) — the invariant is that
 * hovering a node lights every incident edge of BOTH kinds.
 */

export type DiagramHover =
	| { kind: 'node'; id: string }
	| { kind: 'edge'; id: string; relName: string | null };

export interface DiagramAdjacency {
	/** edge id → its two endpoint node ids (assoc halves and gens alike). */
	edgeEndpoints: ReadonlyMap<string, readonly [string, string]>;
	/** node id → every incident edge id, both directions, gens included. */
	nodeEdges: ReadonlyMap<string, ReadonlySet<string>>;
	/** rel name → every edge id carrying it (all mappings, both tether halves). */
	relEdges: ReadonlyMap<string, ReadonlySet<string>>;
	/** rel name → every node id an edge of the rel touches (assoc box included). */
	relNodes: ReadonlyMap<string, ReadonlySet<string>>;
}

export function buildAdjacency(edges: DiagramEdgeSpec[]): DiagramAdjacency {
	const edgeEndpoints = new Map<string, readonly [string, string]>();
	const nodeEdges = new Map<string, Set<string>>();
	const relEdges = new Map<string, Set<string>>();
	const relNodes = new Map<string, Set<string>>();
	const addTo = <K>(map: Map<K, Set<string>>, key: K, value: string): void => {
		let set = map.get(key);
		if (set === undefined) {
			set = new Set();
			map.set(key, set);
		}
		set.add(value);
	};
	for (const e of edges) {
		edgeEndpoints.set(e.id, [e.source, e.target]);
		addTo(nodeEdges, e.source, e.id);
		addTo(nodeEdges, e.target, e.id);
		const rel = e.data.relName;
		if (rel !== undefined) {
			addTo(relEdges, rel, e.id);
			addTo(relNodes, rel, e.source);
			addTo(relNodes, rel, e.target);
		}
	}
	return { edgeEndpoints, nodeEdges, relEdges, relNodes };
}

export interface HighlightSet {
	nodes: ReadonlySet<string>;
	edges: ReadonlySet<string>;
}

/** The neighborhood a hover lights up (spec §5). Node → itself + incident
 * edges + their other endpoints. Edge with a rel name → the WHOLE relationship
 * (all mappings, both tether halves — consistent with click-selection: one
 * relationship reads as one thing). Generalization edge → itself + its two
 * boxes. Tolerant of ids the index doesn't know (mid-edit staleness): the
 * result just shrinks, it never throws. */
export function highlightFor(hover: DiagramHover, adj: DiagramAdjacency): HighlightSet {
	const nodes = new Set<string>();
	const edges = new Set<string>();
	if (hover.kind === 'node') {
		nodes.add(hover.id);
		for (const edgeId of adj.nodeEdges.get(hover.id) ?? []) {
			edges.add(edgeId);
			const ends = adj.edgeEndpoints.get(edgeId);
			if (ends !== undefined) {
				nodes.add(ends[0]);
				nodes.add(ends[1]);
			}
		}
	} else if (hover.relName !== null) {
		for (const edgeId of adj.relEdges.get(hover.relName) ?? []) edges.add(edgeId);
		for (const nodeId of adj.relNodes.get(hover.relName) ?? []) nodes.add(nodeId);
	} else {
		edges.add(hover.id);
		const ends = adj.edgeEndpoints.get(hover.id);
		if (ends !== undefined) {
			nodes.add(ends[0]);
			nodes.add(ends[1]);
		}
	}
	return { nodes, edges };
}

/** Tooltip copy for the LOD cursor tooltip (spec §4): the hovered thing's
 * name. A generalization has no name of its own, so it reads `Sub ▷ Super`
 * (the triangle mirrors the canvas marker). Null when nothing nameable —
 * the tooltip simply doesn't render. */
export function hoverLabel(hover: DiagramHover, adj: DiagramAdjacency): string | null {
	if (hover.kind === 'node') return selectionForNodeId(hover.id)?.name ?? null;
	if (hover.relName !== null) return hover.relName;
	const ends = adj.edgeEndpoints.get(hover.id);
	if (ends === undefined) return null;
	const sub = selectionForNodeId(ends[0])?.name;
	const sup = selectionForNodeId(ends[1])?.name;
	return sub !== undefined && sup !== undefined ? `${sub} ▷ ${sup}` : null;
}

/** The one place the hot/dim/normal decision lives, so the five components
 * that apply it (three nodes, two edges) cannot drift. Selected-but-outside
 * stays 'normal': selection must never be dimmed away (spec §5). */
export function visualState(
	id: string,
	kind: 'node' | 'edge',
	selected: boolean,
	highlight: HighlightSet | null
): 'hot' | 'dim' | 'normal' {
	if (highlight === null) return 'normal';
	const set = kind === 'node' ? highlight.nodes : highlight.edges;
	if (set.has(id)) return 'hot';
	return selected ? 'normal' : 'dim';
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pixi run frontend-test -- -- src/lib/metamodel/diagram-adjacency.test.ts`
Expected: PASS (all describes).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/metamodel/diagram-adjacency.ts frontend/src/lib/metamodel/diagram-adjacency.test.ts
git commit -m "feat(frontend): metamodel diagram adjacency index + hover helpers (P-18 groundwork)"
```

---

### Task 2: Canvas presentation state module (hover, LOD hysteresis, cursor)

**Files:**
- Create: `frontend/src/lib/state/metamodel-canvas.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (add re-exports)
- Test: `frontend/src/lib/state/__tests__/metamodel-canvas.test.ts`

**Interfaces:**
- Consumes: `DiagramHover`, `DiagramAdjacency`, `HighlightSet`, `highlightFor`, `hoverLabel` from `$lib/metamodel/diagram-adjacency` (Task 1).
- Produces (Tasks 3, 4 rely on these exact names, re-exported from `$lib/state`):
  - `LOD_ENTER = 0.4`, `LOD_EXIT = 0.5` (exported consts)
  - `getDiagramHover(): DiagramHover | null` / `setDiagramHover(h: DiagramHover | null): void`
  - `setDiagramAdjacency(a: DiagramAdjacency | null): void`
  - `getDiagramHighlight(): HighlightSet | null` (memoized)
  - `getDiagramHoverLabel(): string | null`
  - `getLodActive(): boolean` / `noteZoom(zoom: number): void`
  - `getHoverCursor(): { x: number; y: number } | null` / `setHoverCursor(p: { x: number; y: number } | null): void`
  - `resetMetamodelCanvas(): void`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/metamodel-canvas.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { buildAdjacency } from '$lib/metamodel/diagram-adjacency';
import type { DiagramEdgeSpec } from '$lib/metamodel/diagram-build';
import {
	getDiagramHighlight,
	getDiagramHover,
	getDiagramHoverLabel,
	getHoverCursor,
	getLodActive,
	LOD_ENTER,
	LOD_EXIT,
	noteZoom,
	resetMetamodelCanvas,
	setDiagramAdjacency,
	setDiagramHover,
	setHoverCursor
} from '../metamodel-canvas.svelte';

const EDGES: DiagramEdgeSpec[] = [
	{
		id: 'assoc:Contains:0',
		source: 'el:Zone',
		target: 'el:Building',
		type: 'association',
		data: { relName: 'Contains' }
	}
];

beforeEach(() => {
	resetMetamodelCanvas();
});

describe('LOD hysteresis', () => {
	it('enters below LOD_ENTER, exits above LOD_EXIT, holds in between', () => {
		expect(getLodActive()).toBe(false);
		noteZoom(LOD_ENTER + 0.01);
		expect(getLodActive()).toBe(false);
		noteZoom(LOD_ENTER - 0.01);
		expect(getLodActive()).toBe(true);
		// Inside the band: the current mode holds — no flicker at the boundary.
		noteZoom((LOD_ENTER + LOD_EXIT) / 2);
		expect(getLodActive()).toBe(true);
		noteZoom(LOD_EXIT + 0.01);
		expect(getLodActive()).toBe(false);
		noteZoom((LOD_ENTER + LOD_EXIT) / 2);
		expect(getLodActive()).toBe(false);
	});
});

describe('hover + highlight', () => {
	it('is null with no hover or no adjacency', () => {
		expect(getDiagramHighlight()).toBeNull();
		setDiagramHover({ kind: 'node', id: 'el:Zone' });
		expect(getDiagramHighlight()).toBeNull(); // adjacency not set yet
	});

	it('derives the highlight and memoizes it per (hover, adjacency)', () => {
		setDiagramAdjacency(buildAdjacency(EDGES));
		setDiagramHover({ kind: 'node', id: 'el:Zone' });
		const first = getDiagramHighlight();
		expect(first?.nodes).toEqual(new Set(['el:Zone', 'el:Building']));
		expect(getDiagramHighlight()).toBe(first); // same identity: memo hit
		setDiagramHover({ kind: 'node', id: 'el:Building' });
		expect(getDiagramHighlight()).not.toBe(first);
	});

	it('exposes the hover label through the same pair', () => {
		setDiagramAdjacency(buildAdjacency(EDGES));
		setDiagramHover({ kind: 'edge', id: 'assoc:Contains:0', relName: 'Contains' });
		expect(getDiagramHoverLabel()).toBe('Contains');
	});
});

describe('reset', () => {
	it('clears everything', () => {
		setDiagramAdjacency(buildAdjacency(EDGES));
		setDiagramHover({ kind: 'node', id: 'el:Zone' });
		setHoverCursor({ x: 10, y: 20 });
		noteZoom(0.1);
		resetMetamodelCanvas();
		expect(getDiagramHover()).toBeNull();
		expect(getDiagramHighlight()).toBeNull();
		expect(getHoverCursor()).toBeNull();
		expect(getLodActive()).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run frontend-test -- -- src/lib/state/__tests__/metamodel-canvas.test.ts`
Expected: FAIL — cannot resolve `../metamodel-canvas.svelte`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/state/metamodel-canvas.svelte.ts`:

```ts
import {
	highlightFor,
	hoverLabel,
	type DiagramAdjacency,
	type DiagramHover,
	type HighlightSet
} from '$lib/metamodel/diagram-adjacency';

/**
 * Ephemeral presentation state for the metamodel CANVAS: what is hovered,
 * whether the level-of-detail (simplified) render mode is on, and where the
 * cursor is for the LOD tooltip (spec 2026-08-20 §3.1, §4, §5).
 *
 * A separate module from `metamodel-diagram.svelte.ts` on purpose: that module
 * owns draft/positions/selection (durable-ish, per-project), this one owns
 * per-frame canvas ephemera that node and edge components read DIRECTLY —
 * which is the whole design: a hover updates `$state` here and each component
 * re-derives its own class, so `MetamodelDiagram` never rebuilds the
 * `flowNodes`/`flowEdges` arrays on pointer movement. Nothing here persists,
 * and `MetamodelDiagram` resets it all on unmount.
 *
 * The memo below is the module-standard plain-var pattern (see
 * metamodel-diagram.svelte.ts's reactivity note): `getDiagramHighlight()` is
 * called from every node/edge render, so the set is computed once per
 * distinct (hover, adjacency) pair, not once per component.
 */

/** Hysteresis pair: enter simplified mode below ENTER, leave above EXIT. The
 * gap is what stops the boundary flickering while the user sits on it. Tuned
 * against examples/smart-city.metamodel.yaml (spec §4). */
export const LOD_ENTER = 0.4;
export const LOD_EXIT = 0.5;

let _hover = $state<DiagramHover | null>(null);
/** `$state.raw`: the adjacency is replaced wholesale per diagram build and its
 * Maps/Sets must not be proxied — identity is the memo key below. */
let _adjacency = $state.raw<DiagramAdjacency | null>(null);
let _lod = $state(false);
let _cursor = $state<{ x: number; y: number } | null>(null);

let _hlFor: { hover: DiagramHover; adj: DiagramAdjacency } | null = null;
let _hl: HighlightSet | null = null;

export function getDiagramHover(): DiagramHover | null {
	return _hover;
}

export function setDiagramHover(h: DiagramHover | null): void {
	_hover = h;
}

export function setDiagramAdjacency(a: DiagramAdjacency | null): void {
	_adjacency = a;
}

export function getDiagramHighlight(): HighlightSet | null {
	if (_hover === null || _adjacency === null) return null;
	if (_hlFor === null || _hlFor.hover !== _hover || _hlFor.adj !== _adjacency) {
		_hl = highlightFor(_hover, _adjacency);
		_hlFor = { hover: _hover, adj: _adjacency };
	}
	return _hl;
}

export function getDiagramHoverLabel(): string | null {
	if (_hover === null || _adjacency === null) return null;
	return hoverLabel(_hover, _adjacency);
}

export function getLodActive(): boolean {
	return _lod;
}

export function noteZoom(zoom: number): void {
	if (!_lod && zoom < LOD_ENTER) _lod = true;
	else if (_lod && zoom > LOD_EXIT) _lod = false;
}

export function getHoverCursor(): { x: number; y: number } | null {
	return _cursor;
}

export function setHoverCursor(p: { x: number; y: number } | null): void {
	_cursor = p;
}

export function resetMetamodelCanvas(): void {
	_hover = null;
	_adjacency = null;
	_lod = false;
	_cursor = null;
	_hlFor = null;
	_hl = null;
}
```

- [ ] **Step 4: Add the `$lib/state` re-exports**

In `frontend/src/lib/state/index.ts`, beside the existing metamodel exports, add:

```ts
export {
	getDiagramHighlight,
	getDiagramHover,
	getDiagramHoverLabel,
	getHoverCursor,
	getLodActive,
	LOD_ENTER,
	LOD_EXIT,
	noteZoom,
	resetMetamodelCanvas,
	setDiagramAdjacency,
	setDiagramHover,
	setHoverCursor
} from './metamodel-canvas.svelte';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pixi run frontend-test -- -- src/lib/state/__tests__/metamodel-canvas.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/state/metamodel-canvas.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/metamodel-canvas.test.ts
git commit -m "feat(frontend): metamodel canvas state module — hover store + LOD hysteresis"
```

---

### Task 3: Unbounded zoom + LOD rendering (P-17)

**Files:**
- Modify: `frontend/src/lib/components/Metamodel/MetamodelDiagram.svelte` (minZoom, onmove)
- Modify: `frontend/src/lib/components/Metamodel/diagram/ElementTypeNode.svelte`
- Modify: `frontend/src/lib/components/Metamodel/diagram/EnumTypeNode.svelte`
- Modify: `frontend/src/lib/components/Metamodel/diagram/AssocClassNode.svelte`
- Modify: `frontend/src/lib/components/Metamodel/diagram/AssociationEdge.svelte` (label suppression)

**Interfaces:**
- Consumes: `getLodActive`, `noteZoom` from `$lib/state` (Task 2).
- Produces: the `mm-lod` render mode and `.mm-lod-name` overlay class used by Task 4's CSS additions in the same files.

No new unit test in this task: the decision logic (`noteZoom` hysteresis) is already pinned by Task 2, and the node components cannot mount standalone under happy-dom (xyflow's `Handle` needs a live flow store). The gate is `svelte-check` + the existing full suite staying green; visual behaviour is verified manually in Step 5.

- [ ] **Step 1: Unbounded zoom + zoom tracking in `MetamodelDiagram.svelte`**

Add to the `<SvelteFlow>` props (around line 373-395):

```svelte
<SvelteFlow
	bind:nodes={flowNodes}
	bind:edges={flowEdges}
	{nodeTypes}
	{edgeTypes}
	fitView
	minZoom={0.05}
	colorMode="dark"
	...
	onmove={(_, viewport) => noteZoom(viewport.zoom)}
	...
```

Add `noteZoom` to the `$lib/state` import list. `minZoom={0.05}` removes xyflow's default `0.5` floor (P-17's confirmed cause); `onmove` fires for user pans/zooms AND programmatic transforms (fitView, setCenter), so the LOD flag converges without a separate init hook.

- [ ] **Step 2: LOD render in `ElementTypeNode.svelte`**

Script additions:

```ts
import { getLodActive } from '$lib/state';
```

```ts
const lod = $derived(getLodActive());
```

Markup: add the classes and the overlay name to the root div:

```svelte
<div
	class="mm-node"
	class:abstract={d.abstract}
	class:selected
	class:error={d.hasError}
	class:mm-lod={lod}
	data-testid="mm-node-element"
>
```

and immediately before the closing source `Handle`:

```svelte
	{#if lod}
		<span class="mm-lod-name" class:italic={d.abstract}>{d.name}</span>
	{/if}
```

Style additions (inside the existing `<style>`):

```css
	/* LOD (spec §4): past the zoom threshold the box shows ONLY its name. The
	   full content is hidden with `visibility` — NOT removed — so the DOM
	   height, and therefore every edge anchor, is byte-identical in both
	   modes. `visibility: hidden` also disables the collapse toggle's hit
	   target, which at 0.3× zoom is unusable anyway. */
	.mm-node {
		position: relative;
	}
	.mm-node.mm-lod .mm-header,
	.mm-node.mm-lod .mm-compartment {
		visibility: hidden;
	}
	.mm-lod-name {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 10px;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 24px;
		color: var(--foreground);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.mm-lod-name.italic {
		font-style: italic;
	}
```

- [ ] **Step 3: Same treatment for `EnumTypeNode.svelte` and `AssocClassNode.svelte`**

`EnumTypeNode.svelte` — script gets the same `getLodActive` import and `const lod = $derived(getLodActive());`; root div gains `class:mm-lod={lod}`; before the closing `</div>` add:

```svelte
	{#if lod}
		<span class="mm-lod-name">{d.name}</span>
	{/if}
```

Style additions (enum name keeps its gold token; the hidden selector targets `.mm-literals`, this component's content class):

```css
	.mm-node {
		position: relative;
	}
	.mm-node.mm-lod .mm-header,
	.mm-node.mm-lod .mm-literals {
		visibility: hidden;
	}
	.mm-lod-name {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 10px;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 20px;
		color: var(--cm-keyword);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
```

`AssocClassNode.svelte` — identical to ElementTypeNode's additions (import, `const lod`, `class:mm-lod={lod}`, the `{#if lod}` overlay with `class:italic={d.abstract}` before the source Handle), and this CSS (same as ElementTypeNode's block — the compartment class matches):

```css
	.mm-node {
		position: relative;
	}
	.mm-node.mm-lod .mm-header,
	.mm-node.mm-lod .mm-compartment {
		visibility: hidden;
	}
	.mm-lod-name {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 10px;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 24px;
		color: var(--foreground);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.mm-lod-name.italic {
		font-style: italic;
	}
```

- [ ] **Step 4: Label suppression in `AssociationEdge.svelte`**

Script: add `import { getLodActive } from '$lib/state';` and `const lod = $derived(getLodActive());`.

`BaseEdge` label prop becomes:

```svelte
	label={lod ? undefined : d.label}
```

Both multiplicity labels gain the same guard:

```svelte
{#if !lod && d.sourceMult}
```
```svelte
{#if !lod && d.targetMult}
```

(`GeneralizationEdge` has no labels — untouched in this task.)

- [ ] **Step 5: Verify**

Run: `pixi run frontend-check` — expected: clean.
Run: `pixi run frontend-test` — expected: all existing tests still pass.
Manual: `pixi run backend-start` + `pixi run frontend-start`, open the metamodel diagram on the smart-city project, zoom out past ~0.4 — boxes flip to name-only, edge labels vanish, zoom floor is effectively gone; zoom back past ~0.5 — full detail returns, nothing moves.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Metamodel/MetamodelDiagram.svelte frontend/src/lib/components/Metamodel/diagram/
git commit -m "feat(frontend): unbounded zoom-out + level-of-detail render mode on the metamodel canvas (P-17)"
```

---

### Task 4: Hover highlighting + dimming + LOD tooltip (P-18)

**Files:**
- Modify: `frontend/src/lib/components/Metamodel/MetamodelDiagram.svelte` (hover events, adjacency effect, tooltip overlay, cursor tracking, unmount reset)
- Modify: `frontend/src/lib/components/Metamodel/diagram/ElementTypeNode.svelte`
- Modify: `frontend/src/lib/components/Metamodel/diagram/EnumTypeNode.svelte`
- Modify: `frontend/src/lib/components/Metamodel/diagram/AssocClassNode.svelte`
- Modify: `frontend/src/lib/components/Metamodel/diagram/AssociationEdge.svelte`
- Modify: `frontend/src/lib/components/Metamodel/diagram/GeneralizationEdge.svelte`

**Interfaces:**
- Consumes: `buildAdjacency`, `visualState` (Task 1); `setDiagramAdjacency`, `setDiagramHover`, `getDiagramHighlight`, `getDiagramHoverLabel`, `getHoverCursor`, `setHoverCursor`, `getLodActive`, `resetMetamodelCanvas` from `$lib/state` (Task 2).
- Produces: the complete hover surface; nothing later depends on new names from this task.

Decision logic is pinned by Tasks 1-2; this task is wiring + CSS. Gate: `svelte-check` + full suite + manual pass.

- [ ] **Step 1: Wire events and adjacency in `MetamodelDiagram.svelte`**

Extend the `$lib/state` import with `setDiagramAdjacency, setDiagramHover, getDiagramHoverLabel, getHoverCursor, setHoverCursor, getLodActive, resetMetamodelCanvas`, and add this import (note: `diagram-adjacency`, NOT `diagram-build`):

```ts
import { buildAdjacency } from '$lib/metamodel/diagram-adjacency';
```

After the `built` derivation (line ~125), add:

```ts
	// The adjacency the hover store needs: rebuilt only when the parsed
	// metamodel changes (`built` is memoized on it), NEVER on hover. The
	// cleanup keeps a closed canvas from leaving stale hover state behind for
	// the next mount.
	$effect(() => {
		setDiagramAdjacency(buildAdjacency(built.edges));
	});
	$effect(() => {
		return () => resetMetamodelCanvas();
	});

	const lodActive = $derived(getLodActive());
	const lodTooltip = $derived(lodActive ? getDiagramHoverLabel() : null);
	const hoverCursor = $derived(getHoverCursor());
```

On `<SvelteFlow>`, add the four hover handlers:

```svelte
	onnodepointerenter={({ node }) => setDiagramHover({ kind: 'node', id: node.id })}
	onnodepointerleave={() => setDiagramHover(null)}
	onedgepointerenter={({ edge }) =>
		setDiagramHover({
			kind: 'edge',
			id: edge.id,
			relName: (edge.data as { relName?: string } | undefined)?.relName ?? null
		})}
	onedgepointerleave={() => setDiagramHover(null)}
```

On the wrapper div (the `role="application"` one), add cursor tracking for the tooltip:

```svelte
	onpointermove={(e) => {
		if (getLodActive()) setHoverCursor({ x: e.clientX, y: e.clientY });
	}}
```

After the `</SvelteFlow>` closing tag (beside the ConnectionPopover block), add the tooltip overlay:

```svelte
	{#if lodTooltip !== null && hoverCursor !== null}
		<!-- ONE overlay owned here, fed by the hover store — not a per-node
		     tooltip (spec §4). `fixed` + clientX/Y sidesteps canvas-space math. -->
		<div
			class="pointer-events-none fixed z-50 rounded border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-lg"
			style="left: {hoverCursor.x + 12}px; top: {hoverCursor.y + 12}px;"
			data-testid="mm-lod-tooltip"
		>
			{lodTooltip}
		</div>
	{/if}
```

- [ ] **Step 2: Hot/dim classes in the three node components**

In each of `ElementTypeNode.svelte`, `EnumTypeNode.svelte`, `AssocClassNode.svelte`:

Script additions (`getLodActive` import already exists from Task 3 — extend it):

```ts
import { getDiagramHighlight, getLodActive } from '$lib/state';
import { visualState } from '$lib/metamodel/diagram-adjacency';
```

```ts
	const vis = $derived(visualState(id, 'node', selected, getDiagramHighlight()));
```

Root div gains:

```svelte
	class:mm-dim={vis === 'dim'}
	class:mm-hot={vis === 'hot'}
```

Style additions — identical block in all three components (each `<style>` is scoped):

```css
	/* Hover neighborhood (spec §5): the hovered thing and its neighbors stay
	   full-strength while everything else dims. The transition-delay applies
	   only on the way INTO dim, so sweeping the cursor across the canvas
	   doesn't strobe; un-dim is immediate. */
	.mm-node {
		transition: opacity 140ms ease;
	}
	.mm-node.mm-dim {
		opacity: 0.25;
		transition-delay: 120ms;
	}
	.mm-node.mm-hot {
		border-color: color-mix(in oklab, var(--ring) 55%, transparent);
	}
```

(`position: relative` on `.mm-node` was already added in Task 3 — don't duplicate the property, merge into the same rule.)

- [ ] **Step 3: Hot/dim on the two edge components**

`AssociationEdge.svelte` — add `id` to the destructured props:

```ts
	let {
		id,
		source,
		target,
		...
	}: EdgeProps = $props();
```

Script additions:

```ts
import { getDiagramHighlight, getLodActive } from '$lib/state';
import { visualState } from '$lib/metamodel/diagram-adjacency';
```

```ts
	const vis = $derived(visualState(id, 'edge', selected, getDiagramHighlight()));
	const edgeOpacity = $derived(vis === 'dim' ? 0.2 : 1);
```

`BaseEdge`'s `style` becomes:

```svelte
	style="stroke: {stroke}; stroke-width: {selected || vis === 'hot'
		? 2
		: 1.5}px; opacity: {edgeOpacity}; transition: opacity 140ms ease;{tethered
		? ' stroke-dasharray: 5 4;'
		: ''}"
```

`GeneralizationEdge.svelte` — add `id` to the destructured props, add the same two imports and the `vis` derivation, and change `BaseEdge` to:

```svelte
<BaseEdge
	path={path[0]}
	markerEnd="url(#uml-gen)"
	style="{selected || vis === 'hot'
		? 'stroke: var(--ring); stroke-width: 2px;'
		: 'stroke: color-mix(in oklab, var(--muted-foreground) 80%, transparent); stroke-width: 1.5px;'} opacity: {vis ===
	'dim'
		? 0.2
		: 1}; transition: opacity 140ms ease;"
/>
```

- [ ] **Step 4: Verify**

Run: `pixi run frontend-check` — expected: clean.
Run: `pixi run frontend-test` — expected: all pass (the adjacency/visualState logic is already unit-pinned).
Manual: hover a box → it, its edges (gens included) and their far boxes stay lit, the rest dims after a beat; hover an edge of a multi-mapping relationship → every edge of that relationship lights; a selected box outside the neighborhood never dims; zoomed out past the threshold, hovering shows the cursor tooltip with the right name.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Metamodel/
git commit -m "feat(frontend): hover highlighting with dim + LOD cursor tooltip on the metamodel canvas (P-18)"
```

---

### Task 5: `revealTarget` — pure pan/fit geometry

**Files:**
- Create: `frontend/src/lib/metamodel/diagram-reveal.ts`
- Test: `frontend/src/lib/metamodel/diagram-reveal.test.ts`

**Interfaces:**
- Consumes: `buildDiagram`, `nodeIdFor`, `nodeSize`, `DiagramSelection` from `$lib/metamodel/diagram-build`; `Metamodel` from `$lib/api/types`.
- Produces (Task 8 relies on):
  - `type RevealTarget = { kind: 'center'; x: number; y: number } | { kind: 'bounds'; rect: { x: number; y: number; width: number; height: number } } | { kind: 'none' }`
  - `revealTarget(sel: DiagramSelection, mm: Metamodel, positions: Record<string, { x: number; y: number }>, collapsed: ReadonlySet<string>): RevealTarget`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/metamodel/diagram-reveal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { FIXTURE } from './__tests__/fixtures';
import { nodeIdFor, nodeSize, buildDiagram } from './diagram-build';
import { revealTarget } from './diagram-reveal';
import { parseDraft } from './yaml-edit';

/** FIXTURE recap (see fixtures.ts): elements NamedElement (abstract), Zone,
 * Building; enum Status; relationships Observes (abstract+mapless → BOXED but
 * edgeless), Contains (plain Zone→Building edge), Monitors (boxed,
 * Building→Zone). */
const mm = parseDraft(FIXTURE).mm!;
const NONE = new Set<string>();

const POSITIONS = {
	[nodeIdFor({ kind: 'element', name: 'Zone' })]: { x: 100, y: 200 },
	[nodeIdFor({ kind: 'element', name: 'Building' })]: { x: 500, y: 50 },
	[nodeIdFor({ kind: 'relationship', name: 'Observes' })]: { x: 900, y: 900 }
};

function sizeOf(name: string, kind: 'element' | 'relationship' | 'enum') {
	const id = nodeIdFor({ kind, name });
	const spec = buildDiagram(mm).nodes.find((n) => n.id === id)!;
	return nodeSize(spec, false);
}

describe('revealTarget', () => {
	it('centers on an element box (stored position + half its footprint)', () => {
		const t = revealTarget({ kind: 'element', name: 'Zone' }, mm, POSITIONS, NONE);
		const size = sizeOf('Zone', 'element');
		expect(t).toEqual({ kind: 'center', x: 100 + size.width / 2, y: 200 + size.height / 2 });
	});

	it('centers on an enum box, defaulting an unstored position to (0,0)', () => {
		const t = revealTarget({ kind: 'enum', name: 'Status' }, mm, POSITIONS, NONE);
		const size = sizeOf('Status', 'enum');
		expect(t).toEqual({ kind: 'center', x: size.width / 2, y: size.height / 2 });
	});

	it('fits a mapped relationship to the union of all its endpoint boxes', () => {
		const t = revealTarget({ kind: 'relationship', name: 'Contains' }, mm, POSITIONS, NONE);
		expect(t.kind).toBe('bounds');
		if (t.kind !== 'bounds') return;
		const zone = sizeOf('Zone', 'element');
		// Union of Zone (100,200) and Building (500,50) boxes.
		expect(t.rect.x).toBe(100);
		expect(t.rect.y).toBe(50);
		expect(t.rect.x + t.rect.width).toBe(500 + sizeOf('Building', 'element').width);
		expect(t.rect.y + t.rect.height).toBe(200 + zone.height);
	});

	it('a mapless-but-boxed relationship fits to its own assoc box', () => {
		const t = revealTarget({ kind: 'relationship', name: 'Observes' }, mm, POSITIONS, NONE);
		expect(t.kind).toBe('bounds');
		if (t.kind !== 'bounds') return;
		expect(t.rect.x).toBe(900);
		expect(t.rect.y).toBe(900);
	});

	it('is none for a name nothing draws', () => {
		expect(revealTarget({ kind: 'element', name: 'Ghost' }, mm, POSITIONS, NONE)).toEqual({
			kind: 'none'
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run frontend-test -- -- src/lib/metamodel/diagram-reveal.test.ts`
Expected: FAIL — cannot resolve `./diagram-reveal`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/metamodel/diagram-reveal.ts`:

```ts
import type { Metamodel } from '$lib/api/types';
import { buildDiagram, nodeIdFor, nodeSize, type DiagramSelection } from './diagram-build';

/**
 * Where the canvas should GO to show a selection (spec 2026-08-20 §6): the
 * pure geometry half of the shared reveal path — search and the panel TOC
 * both route through it, so the two can never pan differently.
 *
 * Element / enum → center on the box. Relationship → the union rect of every
 * box it involves: its assoc-class box (when boxed) plus every mapping
 * endpoint that is actually drawn — fitting ALL the stereotype pairs a
 * multi-mapping relationship connects on screen at once. `none` when nothing
 * is drawn (a plain mapless relationship): the caller selects without
 * panning, and the form panel is the destination.
 *
 * Positions default to (0,0) exactly like `specToNode`, and sizes come from
 * `nodeSize`, so this works for nodes the viewport has never rendered —
 * same reasoning as the old `findAndCenter` (which this replaces).
 */

export type RevealTarget =
	| { kind: 'center'; x: number; y: number }
	| { kind: 'bounds'; rect: { x: number; y: number; width: number; height: number } }
	| { kind: 'none' };

export function revealTarget(
	sel: DiagramSelection,
	mm: Metamodel,
	positions: Record<string, { x: number; y: number }>,
	collapsed: ReadonlySet<string>
): RevealTarget {
	const built = buildDiagram(mm);
	const specById = new Map(built.nodes.map((n) => [n.id, n]));
	const rectFor = (id: string): { x: number; y: number; width: number; height: number } | null => {
		const spec = specById.get(id);
		if (spec === undefined) return null;
		const pos = positions[id] ?? { x: 0, y: 0 };
		const size = nodeSize(spec, collapsed.has(id));
		return { x: pos.x, y: pos.y, width: size.width, height: size.height };
	};

	if (sel.kind !== 'relationship') {
		const rect = rectFor(nodeIdFor(sel));
		if (rect === null) return { kind: 'none' };
		return { kind: 'center', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	}

	const rel = mm.relationships.find((r) => r.name === sel.name);
	if (rel === undefined) return { kind: 'none' };
	const ids = new Set<string>([nodeIdFor({ kind: 'relationship', name: sel.name })]);
	for (const m of rel.mappings) {
		ids.add(nodeIdFor({ kind: 'element', name: m.source }));
		ids.add(nodeIdFor({ kind: 'element', name: m.target }));
	}
	const rects = [...ids].map(rectFor).filter((r) => r !== null);
	if (rects.length === 0) return { kind: 'none' };
	const minX = Math.min(...rects.map((r) => r.x));
	const minY = Math.min(...rects.map((r) => r.y));
	const maxX = Math.max(...rects.map((r) => r.x + r.width));
	const maxY = Math.max(...rects.map((r) => r.y + r.height));
	return { kind: 'bounds', rect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run frontend-test -- -- src/lib/metamodel/diagram-reveal.test.ts`
Expected: PASS. If the `Contains` case fails because `parseDraft` does not normalize the fixture's `source`/`target` shorthand into `mappings`, check `diagram-build.test.ts` for how it obtains a mapped `mm` from FIXTURE and mirror that — do NOT change `diagram-reveal.ts` to read the shorthand (spec: mappings only).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/metamodel/diagram-reveal.ts frontend/src/lib/metamodel/diagram-reveal.test.ts
git commit -m "feat(frontend): revealTarget — shared pan/fit geometry for metamodel search and panel TOC"
```

---

### Task 6: `searchTypes` — matcher + ranking

**Files:**
- Create: `frontend/src/lib/metamodel/diagram-search.ts`
- Test: `frontend/src/lib/metamodel/diagram-search.test.ts`

**Interfaces:**
- Consumes: `Metamodel` from `$lib/api/types`; `DiagramSelection` from `$lib/metamodel/diagram-build`.
- Produces (Task 9 relies on):
  - `interface TypeSearchHit { sel: DiagramSelection; kind: 'element' | 'relationship' | 'enum'; name: string; mapless: boolean }`
  - `searchTypes(mm: Metamodel, query: string, limit?: number): TypeSearchHit[]` (default limit 20)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/metamodel/diagram-search.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { FIXTURE } from './__tests__/fixtures';
import { searchTypes } from './diagram-search';
import { parseDraft } from './yaml-edit';

const mm = parseDraft(FIXTURE).mm!;

describe('searchTypes', () => {
	it('returns nothing for an empty or whitespace query', () => {
		expect(searchTypes(mm, '')).toEqual([]);
		expect(searchTypes(mm, '   ')).toEqual([]);
	});

	it('matches case-insensitive substrings across all three kinds', () => {
		expect(searchTypes(mm, 'status').map((h) => h.kind)).toEqual(['enum']);
		expect(searchTypes(mm, 'contains').map((h) => h.kind)).toEqual(['relationship']);
		expect(searchTypes(mm, 'zone').map((h) => h.name)).toEqual(['Zone']);
	});

	it('ranks prefix matches before mid-string, then alphabetical', () => {
		// 'o': prefix hit Observes; mid-string hits Monitors, Zone.
		expect(searchTypes(mm, 'o').map((h) => h.name)).toEqual(['Observes', 'Monitors', 'Zone']);
	});

	it('flags mapless relationships', () => {
		const byName = new Map(searchTypes(mm, 's').map((h) => [h.name, h]));
		expect(byName.get('Observes')?.mapless).toBe(true);
		expect(byName.get('Contains')?.mapless).toBe(false);
	});

	it('carries a ready-to-select DiagramSelection', () => {
		expect(searchTypes(mm, 'building')[0].sel).toEqual({ kind: 'element', name: 'Building' });
	});

	it('caps at the limit', () => {
		expect(searchTypes(mm, 'e', 2)).toHaveLength(2);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run frontend-test -- -- src/lib/metamodel/diagram-search.test.ts`
Expected: FAIL — cannot resolve `./diagram-search`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/metamodel/diagram-search.ts`:

```ts
import type { Metamodel } from '$lib/api/types';
import type { DiagramSelection } from './diagram-build';

/**
 * Client-side type search for the metamodel canvas (spec 2026-08-20 §6).
 * Purely over the parsed draft — the metamodel is fully client-side, so
 * unlike element search there is no API call and no debounce-vs-staleness
 * protocol to manage. Case-insensitive substring; prefix matches rank first,
 * alphabetical within a rank. Mapless relationships are included (search is
 * one of only two ways to reach them) and flagged so the row can say so.
 */

export interface TypeSearchHit {
	sel: DiagramSelection;
	kind: 'element' | 'relationship' | 'enum';
	name: string;
	/** Relationships only; always false for the other kinds. */
	mapless: boolean;
}

export function searchTypes(mm: Metamodel, query: string, limit = 20): TypeSearchHit[] {
	const q = query.trim().toLowerCase();
	if (q === '') return [];
	const ranked: (TypeSearchHit & { rank: number })[] = [];
	const consider = (name: string, kind: TypeSearchHit['kind'], mapless = false): void => {
		const at = name.toLowerCase().indexOf(q);
		if (at < 0) return;
		ranked.push({ sel: { kind, name }, kind, name, mapless, rank: at === 0 ? 0 : 1 });
	};
	for (const el of mm.elements) consider(el.name, 'element');
	for (const rel of mm.relationships) consider(rel.name, 'relationship', rel.mappings.length === 0);
	for (const name of Object.keys(mm.enums)) consider(name, 'enum');
	ranked.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
	return ranked.slice(0, limit).map(({ rank: _rank, ...hit }) => hit);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run frontend-test -- -- src/lib/metamodel/diagram-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/metamodel/diagram-search.ts frontend/src/lib/metamodel/diagram-search.test.ts
git commit -m "feat(frontend): searchTypes — client-side metamodel type matcher with ranking"
```

---

### Task 7: Panel preferences state module + tab lifecycle wiring

**Files:**
- Create: `frontend/src/lib/state/metamodel-panel.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (re-exports)
- Modify: `frontend/src/lib/components/Metamodel/MetamodelTab.svelte` (init/close wiring)
- Test: `frontend/src/lib/state/__tests__/metamodel-panel.test.ts`

**Interfaces:**
- Produces (Tasks 8-11 rely on, re-exported from `$lib/state`):
  - `type PanelSectionKey = 'elements' | 'relationships' | 'enums'`
  - `getMetamodelPanel(): { collapsed: boolean; sections: Readonly<Record<PanelSectionKey, boolean>> }` (`true` = collapsed)
  - `setMetamodelPanelCollapsed(v: boolean): void`
  - `toggleMetamodelPanelSection(key: PanelSectionKey): void`
  - `initMetamodelPanel(projectId: string): void` / `closeMetamodelPanel(): void`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/metamodel-panel.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import {
	closeMetamodelPanel,
	getMetamodelPanel,
	initMetamodelPanel,
	setMetamodelPanelCollapsed,
	toggleMetamodelPanelSection
} from '../metamodel-panel.svelte';

beforeEach(() => {
	localStorage.clear();
	closeMetamodelPanel();
});

describe('metamodel panel preferences', () => {
	it('defaults to open panel, all sections expanded', () => {
		initMetamodelPanel('p1');
		const p = getMetamodelPanel();
		expect(p.collapsed).toBe(false);
		expect(p.sections).toEqual({ elements: false, relationships: false, enums: false });
	});

	it('persists whole-panel collapse per project', () => {
		initMetamodelPanel('p1');
		setMetamodelPanelCollapsed(true);
		closeMetamodelPanel();
		initMetamodelPanel('p1');
		expect(getMetamodelPanel().collapsed).toBe(true);
		// A different project starts from its own (default) preference.
		closeMetamodelPanel();
		initMetamodelPanel('p2');
		expect(getMetamodelPanel().collapsed).toBe(false);
	});

	it('persists per-section collapse per project', () => {
		initMetamodelPanel('p1');
		toggleMetamodelPanelSection('enums');
		expect(getMetamodelPanel().sections.enums).toBe(true);
		closeMetamodelPanel();
		initMetamodelPanel('p1');
		expect(getMetamodelPanel().sections.enums).toBe(true);
		expect(getMetamodelPanel().sections.elements).toBe(false);
		toggleMetamodelPanelSection('enums');
		expect(getMetamodelPanel().sections.enums).toBe(false);
	});

	it('close resets in-memory state without touching storage', () => {
		initMetamodelPanel('p1');
		setMetamodelPanelCollapsed(true);
		closeMetamodelPanel();
		expect(getMetamodelPanel().collapsed).toBe(false);
		initMetamodelPanel('p1');
		expect(getMetamodelPanel().collapsed).toBe(true);
	});

	it('survives a corrupt sections entry', () => {
		localStorage.setItem('ui.metamodel.panelSections.p1', 'not json');
		initMetamodelPanel('p1');
		expect(getMetamodelPanel().sections).toEqual({
			elements: false,
			relationships: false,
			enums: false
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run frontend-test -- -- src/lib/state/__tests__/metamodel-panel.test.ts`
Expected: FAIL — cannot resolve `../metamodel-panel.svelte`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/state/metamodel-panel.svelte.ts`:

```ts
/**
 * PERSONAL preferences for the metamodel form panel (spec 2026-08-20 §7):
 * whether the whole 320px column is collapsed, and which TOC sections are
 * folded. Per-project, in localStorage, mirroring the view/collapse
 * preferences in `metamodel-diagram.svelte.ts` — same try/catch stance
 * (storage denial just means the preference doesn't persist), same
 * init/close lifecycle driven by `MetamodelTab`.
 *
 * `setMetamodelPanelCollapsed(false)` is also the "reopen on reveal" hook:
 * `revealSelection` calls it because navigating via search or the TOC
 * implies wanting the form, while a plain canvas click deliberately does NOT
 * reopen a collapsed panel (spec §7.2).
 */

export type PanelSectionKey = 'elements' | 'relationships' | 'enums';

export interface MetamodelPanelState {
	collapsed: boolean;
	/** true = section folded. */
	sections: Readonly<Record<PanelSectionKey, boolean>>;
}

const DEFAULT_SECTIONS: Record<PanelSectionKey, boolean> = {
	elements: false,
	relationships: false,
	enums: false
};

let _projectId: string | null = null;
let _collapsed = $state(false);
let _sections = $state<Record<PanelSectionKey, boolean>>({ ...DEFAULT_SECTIONS });

function panelKey(projectId: string): string {
	return `ui.metamodel.panelCollapsed.${projectId}`;
}

function sectionsKey(projectId: string): string {
	return `ui.metamodel.panelSections.${projectId}`;
}

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* storage full/denied: the preference simply doesn't persist */
	}
}

export function getMetamodelPanel(): MetamodelPanelState {
	return { collapsed: _collapsed, sections: _sections };
}

export function setMetamodelPanelCollapsed(v: boolean): void {
	_collapsed = v;
	if (_projectId !== null) writeStored(panelKey(_projectId), v ? '1' : '0');
}

export function toggleMetamodelPanelSection(key: PanelSectionKey): void {
	_sections = { ..._sections, [key]: !_sections[key] };
	if (_projectId !== null) {
		const folded = (Object.keys(_sections) as PanelSectionKey[]).filter((k) => _sections[k]);
		writeStored(sectionsKey(_projectId), JSON.stringify(folded));
	}
}

export function initMetamodelPanel(projectId: string): void {
	_projectId = projectId;
	_collapsed = readStored(panelKey(projectId)) === '1';
	const next = { ...DEFAULT_SECTIONS };
	const raw = readStored(sectionsKey(projectId));
	if (raw !== null) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				for (const k of parsed) if (typeof k === 'string' && k in next) next[k as PanelSectionKey] = true;
			}
		} catch {
			/* corrupt entry: everything simply opens expanded */
		}
	}
	_sections = next;
}

export function closeMetamodelPanel(): void {
	_projectId = null;
	_collapsed = false;
	_sections = { ...DEFAULT_SECTIONS };
}
```

- [ ] **Step 4: Re-export from `$lib/state` and wire the tab lifecycle**

In `frontend/src/lib/state/index.ts` add:

```ts
export {
	closeMetamodelPanel,
	getMetamodelPanel,
	initMetamodelPanel,
	setMetamodelPanelCollapsed,
	toggleMetamodelPanelSection
} from './metamodel-panel.svelte';
```

In `frontend/src/lib/components/Metamodel/MetamodelTab.svelte`: add `initMetamodelPanel, closeMetamodelPanel` to the `$lib/state` import; in `init()` add `initMetamodelPanel(pid);` after `await initMetamodelDiagram(pid);`; in the `onMount` teardown add `closeMetamodelPanel();` after `closeMetamodelEditor();`.

- [ ] **Step 5: Run the tests**

Run: `pixi run frontend-test -- -- src/lib/state/__tests__/metamodel-panel.test.ts`
Expected: PASS.
Run: `pixi run frontend-test -- -- src/lib/components/Metamodel/__tests__/metamodel-tab.test.ts`
Expected: PASS (the wiring must not disturb the tab's init chain).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/state/metamodel-panel.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/metamodel-panel.test.ts frontend/src/lib/components/Metamodel/MetamodelTab.svelte
git commit -m "feat(frontend): metamodel panel preferences — whole-panel + per-section collapse, persisted per project"
```

---

### Task 8: `revealSelection` — the shared navigate action

**Files:**
- Create: `frontend/src/lib/components/Metamodel/reveal-action.ts`
- Test: `frontend/src/lib/components/Metamodel/__tests__/reveal-action.test.ts`

**Interfaces:**
- Consumes: `revealTarget` (Task 5); `selectDiagramNode`, `setMetamodelPanelCollapsed` from `$lib/state` (existing + Task 7); `MetamodelDiagramView` type from `$lib/state/metamodel-diagram.svelte`.
- Produces (Tasks 9, 10 rely on):
  - `interface RevealFlow { setCenter(x, y, opts?): Promise<boolean>; fitBounds(rect, opts?): Promise<boolean> }`
  - `revealSelection(flow: RevealFlow, view: MetamodelDiagramView, sel: DiagramSelection): void`
  - `REVEAL_ZOOM = 1.2` (exported const)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/Metamodel/__tests__/reveal-action.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE } from '$lib/metamodel/__tests__/fixtures';
import { parseDraft } from '$lib/metamodel/yaml-edit';
import type { MetamodelDiagramView } from '$lib/state/metamodel-diagram.svelte';
import { getMetamodelDiagramView, selectDiagramNode } from '$lib/state/metamodel-diagram.svelte';
import {
	getMetamodelPanel,
	initMetamodelPanel,
	setMetamodelPanelCollapsed
} from '$lib/state/metamodel-panel.svelte';
import { revealSelection, REVEAL_ZOOM, type RevealFlow } from '../reveal-action';

const mm = parseDraft(FIXTURE).mm!;

function makeView(): MetamodelDiagramView {
	return {
		view: 'diagram',
		mm,
		parseErrors: [],
		selection: null,
		positions: { 'el:Zone': { x: 100, y: 200 } },
		collapsed: new Set<string>(),
		canUndo: false,
		errorNodeIds: new Set<string>(),
		unattributedErrorCount: 0
	};
}

function makeFlow(): RevealFlow & { setCenter: ReturnType<typeof vi.fn>; fitBounds: ReturnType<typeof vi.fn> } {
	return {
		setCenter: vi.fn().mockResolvedValue(true),
		fitBounds: vi.fn().mockResolvedValue(true)
	};
}

beforeEach(() => {
	localStorage.clear();
	initMetamodelPanel('p1');
	selectDiagramNode(null);
});

describe('revealSelection', () => {
	it('selects, reopens the panel, and centers on an element', () => {
		setMetamodelPanelCollapsed(true);
		const flow = makeFlow();
		revealSelection(flow, makeView(), { kind: 'element', name: 'Zone' });
		expect(getMetamodelDiagramView().selection).toEqual({ kind: 'element', name: 'Zone' });
		expect(getMetamodelPanel().collapsed).toBe(false);
		expect(flow.setCenter).toHaveBeenCalledTimes(1);
		const [, , opts] = flow.setCenter.mock.calls[0];
		expect(opts).toEqual({ zoom: REVEAL_ZOOM, duration: 300 });
		expect(flow.fitBounds).not.toHaveBeenCalled();
	});

	it('fits bounds for a mapped relationship', () => {
		const flow = makeFlow();
		revealSelection(flow, makeView(), { kind: 'relationship', name: 'Contains' });
		expect(flow.fitBounds).toHaveBeenCalledTimes(1);
		expect(flow.setCenter).not.toHaveBeenCalled();
		expect(getMetamodelDiagramView().selection).toEqual({
			kind: 'relationship',
			name: 'Contains'
		});
	});

	it('selects without panning when nothing is drawn', () => {
		const flow = makeFlow();
		revealSelection(flow, makeView(), { kind: 'element', name: 'Ghost' });
		expect(flow.setCenter).not.toHaveBeenCalled();
		expect(flow.fitBounds).not.toHaveBeenCalled();
		expect(getMetamodelDiagramView().selection).toEqual({ kind: 'element', name: 'Ghost' });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run frontend-test -- -- src/lib/components/Metamodel/__tests__/reveal-action.test.ts`
Expected: FAIL — cannot resolve `../reveal-action`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/components/Metamodel/reveal-action.ts`:

```ts
import { revealTarget } from '$lib/metamodel/diagram-reveal';
import type { DiagramSelection } from '$lib/metamodel/diagram-build';
import type { MetamodelDiagramView } from '$lib/state/metamodel-diagram.svelte';
import { selectDiagramNode } from '$lib/state/metamodel-diagram.svelte';
import { setMetamodelPanelCollapsed } from '$lib/state/metamodel-panel.svelte';

/**
 * THE shared navigate action (spec 2026-08-20 §6/§7.1): search picks and the
 * panel TOC rows both come through here, which is what keeps their behaviour
 * from drifting — select, reopen the panel (navigating by name implies
 * wanting the form; a plain canvas click deliberately does not reopen), then
 * pan/fit per `revealTarget`'s geometry.
 *
 * Takes the flow helpers as a parameter rather than calling `useSvelteFlow`
 * itself: hooks bind context at their call site, so the CALLER (a component
 * under `SvelteFlowProvider`) owns the hook and this stays a plain function
 * a test can hand a fake flow.
 */

export interface RevealFlow {
	setCenter: (
		x: number,
		y: number,
		opts?: { zoom?: number; duration?: number }
	) => Promise<boolean>;
	fitBounds: (
		rect: { x: number; y: number; width: number; height: number },
		opts?: { duration?: number }
	) => Promise<boolean>;
}

/** Same zoom the old find input used — close enough to read a box. */
export const REVEAL_ZOOM = 1.2;

export function revealSelection(
	flow: RevealFlow,
	view: MetamodelDiagramView,
	sel: DiagramSelection
): void {
	selectDiagramNode(sel);
	setMetamodelPanelCollapsed(false);
	if (view.mm === null) return;
	const t = revealTarget(sel, view.mm, view.positions, view.collapsed);
	if (t.kind === 'center') {
		void flow.setCenter(t.x, t.y, { zoom: REVEAL_ZOOM, duration: 300 });
	} else if (t.kind === 'bounds') {
		void flow.fitBounds(t.rect, { duration: 300 });
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run frontend-test -- -- src/lib/components/Metamodel/__tests__/reveal-action.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Metamodel/reveal-action.ts frontend/src/lib/components/Metamodel/__tests__/reveal-action.test.ts
git commit -m "feat(frontend): revealSelection — shared select+reopen+pan action for metamodel navigation"
```

---

### Task 9: `MetamodelSearch` — the autocomplete typeahead

**Files:**
- Create: `frontend/src/lib/components/Metamodel/MetamodelSearch.svelte`
- Create: `frontend/src/lib/components/Metamodel/__tests__/MetamodelSearchHost.svelte`
- Modify: `frontend/src/lib/components/Metamodel/MetamodelDiagram.svelte` (replace the bare find input + delete `findAndCenter`)
- Test: `frontend/src/lib/components/Metamodel/__tests__/metamodel-search.test.ts`

**Interfaces:**
- Consumes: `searchTypes`, `TypeSearchHit` (Task 6); `revealSelection` (Task 8); `getMetamodelDiagramView` from `$lib/state`; `useSvelteFlow` from `@xyflow/svelte`.
- Produces: `MetamodelSearch` component with optional prop `onReveal?: (sel: DiagramSelection) => void` (test seam; defaults to the real `revealSelection` path).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/Metamodel/__tests__/MetamodelSearchHost.svelte`:

```svelte
<script lang="ts">
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import type { DiagramSelection } from '$lib/metamodel/diagram-build';
	import MetamodelSearch from '../MetamodelSearch.svelte';

	let { onReveal }: { onReveal?: (sel: DiagramSelection) => void } = $props();
</script>

<!-- `useSvelteFlow` resolves context at its call site, so the provider must
     wrap the component under test exactly as MetamodelTab wraps the real
     surface. -->
<SvelteFlowProvider>
	<MetamodelSearch {onReveal} />
</SvelteFlowProvider>
```

Create `frontend/src/lib/components/Metamodel/__tests__/metamodel-search.test.ts`:

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as mmApi from '$lib/api/metamodel';
import { FIXTURE } from '$lib/metamodel/__tests__/fixtures';
import type { DiagramSelection } from '$lib/metamodel/diagram-build';
import { setActiveProject } from '../../../state/active-project.svelte';
import { resetCheckout, setProjectInfo } from '../../../state/checkout.svelte';
import {
	initMetamodelEditor,
	resetMetamodelEditor
} from '../../../state/metamodel-editor.svelte';
import MetamodelSearchHost from './MetamodelSearchHost.svelte';

/** Same seeding recipe as metamodel-tab.test.ts: the search reads
 * `getMetamodelDiagramView().mm`, which parses the REAL editor module's
 * buffer, so the editor is initialized with the fixture over spied APIs. */
beforeEach(async () => {
	localStorage.clear();
	resetCheckout();
	resetMetamodelEditor();
	setActiveProject('p1');
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
	vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: FIXTURE, source: 'stored' });
	vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({ positions: {} });
	await initMetamodelEditor('p1');
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

function input(): HTMLInputElement {
	const el = document.querySelector('[data-testid="mm-search-input"]');
	if (!(el instanceof HTMLInputElement)) throw new Error('search input not rendered');
	return el;
}

function type(text: string): void {
	const el = input();
	el.value = text;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

function press(key: string): void {
	input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	flushSync();
}

function rows(): string[] {
	return [...document.querySelectorAll('[data-testid="mm-search-hit"]')].map(
		(r) => r.textContent ?? ''
	);
}

describe('MetamodelSearch', () => {
	it('shows ranked hits with kind badges while typing', () => {
		const c = mount(MetamodelSearchHost, { target: document.body, props: {} });
		flushSync();
		try {
			type('o');
			const r = rows();
			expect(r).toHaveLength(3);
			expect(r[0]).toContain('Observes');
			expect(r[0]).toContain('no mappings');
			expect(r[1]).toContain('Monitors');
			expect(r[2]).toContain('Zone');
		} finally {
			unmount(c);
		}
	});

	it('ArrowDown/Enter picks the active hit and clears the input', () => {
		const picked: DiagramSelection[] = [];
		const c = mount(MetamodelSearchHost, {
			target: document.body,
			props: { onReveal: (sel: DiagramSelection) => picked.push(sel) }
		});
		flushSync();
		try {
			type('o');
			press('ArrowDown'); // active: Monitors
			press('Enter');
			expect(picked).toEqual([{ kind: 'relationship', name: 'Monitors' }]);
			expect(input().value).toBe('');
			expect(rows()).toHaveLength(0);
		} finally {
			unmount(c);
		}
	});

	it('Enter with no navigation picks the first hit; Escape closes', () => {
		const picked: DiagramSelection[] = [];
		const c = mount(MetamodelSearchHost, {
			target: document.body,
			props: { onReveal: (sel: DiagramSelection) => picked.push(sel) }
		});
		flushSync();
		try {
			type('zone');
			press('Enter');
			expect(picked).toEqual([{ kind: 'element', name: 'Zone' }]);
			type('zone');
			press('Escape');
			expect(rows()).toHaveLength(0);
		} finally {
			unmount(c);
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run frontend-test -- -- src/lib/components/Metamodel/__tests__/metamodel-search.test.ts`
Expected: FAIL — cannot resolve `../MetamodelSearch.svelte`.

- [ ] **Step 3: Write the component**

Create `frontend/src/lib/components/Metamodel/MetamodelSearch.svelte`:

```svelte
<script lang="ts">
	import { useSvelteFlow } from '@xyflow/svelte';

	import type { DiagramSelection } from '$lib/metamodel/diagram-build';
	import { searchTypes, type TypeSearchHit } from '$lib/metamodel/diagram-search';
	import { getMetamodelDiagramView } from '$lib/state';

	import { revealSelection } from './reveal-action';

	/**
	 * The toolbar typeahead (spec 2026-08-20 §6): substring match over element
	 * types, relationship types and enums, keyboard-driven (↑/↓/Enter/Esc), and
	 * on pick the canvas navigates through the shared `revealSelection` action.
	 * Mirrors `Sidebar/Search.svelte`'s dropdown treatment, minus the debounce
	 * and staleness protocol — this search is pure client-side over the parsed
	 * draft, so results are synchronous.
	 *
	 * `onReveal` is a test seam: production leaves it unset and the default
	 * routes through `revealSelection` with this component's flow context.
	 */

	let { onReveal }: { onReveal?: (sel: DiagramSelection) => void } = $props();

	const view = $derived(getMetamodelDiagramView());
	const flow = useSvelteFlow();

	let query = $state('');
	let open = $state(false);
	let active = $state(0);
	let inputEl = $state<HTMLElement | null>(null);

	const hits = $derived(view.mm === null ? [] : searchTypes(view.mm, query));
	const showDropdown = $derived(open && query.trim() !== '');

	// New query → the active row resets to the top hit.
	$effect(() => {
		void query;
		active = 0;
	});

	const KIND_BADGE: Record<TypeSearchHit['kind'], string> = {
		element: 'type',
		relationship: 'rel',
		enum: 'enum'
	};

	function pick(hit: TypeSearchHit): void {
		(onReveal ?? ((sel: DiagramSelection) => revealSelection(flow, view, sel)))(hit.sel);
		query = '';
		open = false;
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			open = false;
			return;
		}
		if (!showDropdown || hits.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = (active + 1) % hits.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = (active - 1 + hits.length) % hits.length;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			pick(hits[Math.min(active, hits.length - 1)]);
		}
	}

	function onDocPointerDown(e: PointerEvent): void {
		if (!open) return;
		const target = e.target as Node | null;
		if (target === null) return;
		if (inputEl !== null && inputEl.contains(target)) return;
		const dropdown = document.getElementById('mm-search-dropdown');
		if (dropdown !== null && dropdown.contains(target)) return;
		open = false;
	}

	$effect(() => {
		document.addEventListener('pointerdown', onDocPointerDown);
		return () => document.removeEventListener('pointerdown', onDocPointerDown);
	});
</script>

<div class="relative">
	<input
		bind:this={inputEl}
		class="rounded bg-card px-2 py-1 text-xs text-foreground"
		data-testid="mm-search-input"
		aria-label="Find a type"
		placeholder="Find type…"
		value={query}
		oninput={(e) => {
			query = (e.currentTarget as HTMLInputElement).value;
			open = true;
		}}
		onfocus={() => {
			if (query.trim() !== '') open = true;
		}}
		onkeydown={onKeydown}
	/>
	{#if showDropdown}
		<div
			id="mm-search-dropdown"
			class="absolute left-0 top-full z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded border border-border bg-popover shadow-lg"
		>
			<ul class="flex flex-col gap-0.5 p-1 text-xs">
				{#if hits.length === 0}
					<li class="px-1 py-0.5 text-muted-foreground/50">No matches.</li>
				{:else}
					{#each hits as hit, i (`${hit.kind}:${hit.name}`)}
						<li>
							<button
								type="button"
								data-testid="mm-search-hit"
								class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted {i ===
								active
									? 'bg-muted'
									: ''}"
								onpointerenter={() => (active = i)}
								onclick={() => pick(hit)}
							>
								<span class="truncate text-foreground/90">{hit.name}</span>
								{#if hit.mapless}
									<span class="shrink-0 text-[10px] text-muted-foreground/70">no mappings</span>
								{/if}
								<span
									class="ml-auto shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
								>
									{KIND_BADGE[hit.kind]}
								</span>
							</button>
						</li>
					{/each}
				{/if}
			</ul>
		</div>
	{/if}
</div>
```

- [ ] **Step 4: Replace the bare input in `MetamodelDiagram.svelte`**

- Add `import MetamodelSearch from './MetamodelSearch.svelte';`.
- Delete the `let query = $state('');` declaration and the whole `findAndCenter` function (lines ~206-224).
- Replace the `<input ... aria-label="Find a type" ...>` block in the toolbar with:

```svelte
			<MetamodelSearch />
```

- Remove now-unused imports if any (`selectionForNodeId` stays — the node click handler uses it; `nodeSize` stays — `specToNode` uses it).

- [ ] **Step 5: Run the tests**

Run: `pixi run frontend-test -- -- src/lib/components/Metamodel/__tests__/metamodel-search.test.ts`
Expected: PASS.
Run: `pixi run frontend-check`
Expected: clean (catches any orphaned import from the input removal).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Metamodel/
git commit -m "feat(frontend): metamodel type search with autocomplete, keyboard flow, and canvas reveal"
```

---

### Task 10: Panel TOC — collapsible sections with reveal rows

**Files:**
- Create: `frontend/src/lib/components/Metamodel/forms/PanelSection.svelte`
- Modify: `frontend/src/lib/components/Metamodel/forms/MetamodelFormPanel.svelte`
- Test: `frontend/src/lib/components/Metamodel/__tests__/metamodel-form-panel.test.ts` (new)
- Create: `frontend/src/lib/components/Metamodel/__tests__/MetamodelFormPanelHost.svelte`

**Interfaces:**
- Consumes: `getMetamodelPanel`, `toggleMetamodelPanelSection` (Task 7, via `$lib/state`); `revealSelection` (Task 8); `useSvelteFlow`.
- Produces: `MetamodelFormPanel` gains optional prop `onReveal?: (sel: DiagramSelection) => void` (test seam, defaulting to `revealSelection`); `PanelSection` component (`{ title: string; count: number; section: PanelSectionKey; children: Snippet }`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/Metamodel/__tests__/MetamodelFormPanelHost.svelte`:

```svelte
<script lang="ts">
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import type { DiagramSelection } from '$lib/metamodel/diagram-build';
	import MetamodelFormPanel from '../forms/MetamodelFormPanel.svelte';

	let {
		readOnly = false,
		onReveal
	}: { readOnly?: boolean; onReveal?: (sel: DiagramSelection) => void } = $props();
</script>

<SvelteFlowProvider>
	<MetamodelFormPanel {readOnly} {onReveal} />
</SvelteFlowProvider>
```

Create `frontend/src/lib/components/Metamodel/__tests__/metamodel-form-panel.test.ts`:

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as mmApi from '$lib/api/metamodel';
import { FIXTURE } from '$lib/metamodel/__tests__/fixtures';
import type { DiagramSelection } from '$lib/metamodel/diagram-build';
import { setActiveProject } from '../../../state/active-project.svelte';
import { resetCheckout, setProjectInfo } from '../../../state/checkout.svelte';
import { selectDiagramNode } from '../../../state/metamodel-diagram.svelte';
import {
	initMetamodelEditor,
	resetMetamodelEditor
} from '../../../state/metamodel-editor.svelte';
import { closeMetamodelPanel, initMetamodelPanel } from '../../../state/metamodel-panel.svelte';
import MetamodelFormPanelHost from './MetamodelFormPanelHost.svelte';

beforeEach(async () => {
	localStorage.clear();
	resetCheckout();
	resetMetamodelEditor();
	closeMetamodelPanel();
	setActiveProject('p1');
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
	selectDiagramNode(null);
	vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: FIXTURE, source: 'stored' });
	vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({ positions: {} });
	await initMetamodelEditor('p1');
	initMetamodelPanel('p1');
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

function sectionHeader(key: string): HTMLElement {
	const el = document.querySelector(`[data-testid="mm-section-${key}"]`);
	if (!(el instanceof HTMLElement)) throw new Error(`section ${key} not rendered`);
	return el;
}

describe('MetamodelFormPanel overview TOC', () => {
	it('renders the three sections with counts and rows for every kind', () => {
		const c = mount(MetamodelFormPanelHost, { target: document.body, props: {} });
		flushSync();
		try {
			const text = document.body.textContent ?? '';
			// FIXTURE: 3 element types, 3 relationship types, 1 enum.
			expect(sectionHeader('elements').textContent).toContain('3');
			expect(sectionHeader('relationships').textContent).toContain('3');
			expect(sectionHeader('enums').textContent).toContain('1');
			// Element types are LISTED now (previously absent from the overview).
			expect(text).toContain('NamedElement');
			expect(text).toContain('Building');
			// All relationships listed, mapless one badged.
			expect(text).toContain('Contains');
			expect(text).toContain('Observes');
			expect(text).toContain('no mappings');
			expect(text).toContain('Status');
		} finally {
			unmount(c);
		}
	});

	it('collapsing a section hides its rows and persists via the panel module', () => {
		const c = mount(MetamodelFormPanelHost, { target: document.body, props: {} });
		flushSync();
		try {
			expect(document.body.textContent).toContain('Building');
			sectionHeader('elements').click();
			flushSync();
			expect(document.body.textContent).not.toContain('Building');
			// The other sections are untouched.
			expect(document.body.textContent).toContain('Contains');
		} finally {
			unmount(c);
		}
	});

	it('clicking a row calls the reveal seam with that selection', () => {
		const picked: DiagramSelection[] = [];
		const c = mount(MetamodelFormPanelHost, {
			target: document.body,
			props: { onReveal: (sel: DiagramSelection) => picked.push(sel) }
		});
		flushSync();
		try {
			const row = [...document.querySelectorAll('button')].find(
				(b) => b.textContent?.includes('Building') && b.dataset.testid === 'mm-toc-row'
			);
			expect(row).toBeDefined();
			row!.click();
			expect(picked).toEqual([{ kind: 'element', name: 'Building' }]);
		} finally {
			unmount(c);
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run frontend-test -- -- src/lib/components/Metamodel/__tests__/metamodel-form-panel.test.ts`
Expected: FAIL — no `mm-section-elements` testid (and the panel lists no element types today).

- [ ] **Step 3: Create `PanelSection.svelte`**

Create `frontend/src/lib/components/Metamodel/forms/PanelSection.svelte`:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronDown, ChevronRight } from '@lucide/svelte';

	import { getMetamodelPanel, toggleMetamodelPanelSection } from '$lib/state';
	import type { PanelSectionKey } from '$lib/state/metamodel-panel.svelte';

	/**
	 * One collapsible TOC section (spec 2026-08-20 §7.1) — the
	 * `Sidebar/StagedSection.svelte` header-button idiom over the panel
	 * module's persisted per-section state.
	 */

	let {
		title,
		count,
		section,
		children
	}: { title: string; count: number; section: PanelSectionKey; children: Snippet } = $props();

	const collapsed = $derived(getMetamodelPanel().sections[section]);
</script>

<div class="flex flex-col gap-0.5">
	<button
		type="button"
		class="microlabel flex select-none items-center gap-1 py-0.5 text-left transition-colors hover:text-foreground/80"
		data-testid={`mm-section-${section}`}
		aria-expanded={!collapsed}
		onclick={() => toggleMetamodelPanelSection(section)}
	>
		{#if collapsed}
			<ChevronRight class="h-3 w-3" />
		{:else}
			<ChevronDown class="h-3 w-3" />
		{/if}
		<span class="flex-1">{title}</span>
		<span class="font-mono text-[10px] normal-case text-muted-foreground">{count}</span>
	</button>
	{#if !collapsed}
		{@render children()}
	{/if}
</div>
```

- [ ] **Step 4: Restructure the overview in `MetamodelFormPanel.svelte`**

Script changes:

```ts
	import { useSvelteFlow } from '@xyflow/svelte';
	import {
		applyDiagramEdit,
		getMetamodelDiagramView,
		selectDiagramNode
	} from '$lib/state';
	import PanelSection from './PanelSection.svelte';
	import { revealSelection } from '../reveal-action';
```

Props gain the reveal seam:

```ts
	let {
		readOnly,
		onReveal
	}: { readOnly: boolean; onReveal?: (sel: DiagramSelection) => void } = $props();
```

(add `import type { DiagramSelection } from '$lib/metamodel/diagram-build';` — the type is already imported in this file for `pendingDelete`; reuse it.)

Add:

```ts
	const flow = useSvelteFlow();

	/** TOC rows navigate — select AND pan — through the shared action (spec
	 * §7.1), so the panel and search cannot drift. `onReveal` is the test seam. */
	function reveal(sel: DiagramSelection): void {
		(onReveal ?? ((s: DiagramSelection) => revealSelection(flow, view, s)))(sel);
	}
```

Replace the overview block (the `{#if sel === null}` branch, keeping the header counts and the create-buttons footer exactly as they are) with:

```svelte
		{#if sel === null}
			<div class="flex flex-col gap-3" data-testid="mm-panel-overview">
				<div class="flex flex-col gap-0.5">
					<p class={headingCls}>Metamodel</p>
					<p class="text-[11px] text-muted-foreground">
						{mm.elements.length} element types · {mm.relationships.length} relationship types · {Object.keys(
							mm.enums
						).length} enums
					</p>
					<p class="text-[10px] text-muted-foreground/70">
						Select a box on the canvas — or a row below — to edit what it declares.
					</p>
				</div>

				<PanelSection title="Element types" count={mm.elements.length} section="elements">
					{#if mm.elements.length === 0}
						<p class="text-[11px] italic text-muted-foreground/70">None.</p>
					{:else}
						{#each mm.elements as el, i (`${i}:${el.name}`)}
							<button
								type="button"
								class={linkCls}
								data-testid="mm-toc-row"
								onclick={() => reveal({ kind: 'element', name: el.name })}
							>
								<span class="text-foreground/90">{el.name}</span>
								{#if el.abstract}<span class="text-muted-foreground/70"> — abstract</span>{/if}
							</button>
						{/each}
					{/if}
				</PanelSection>

				<PanelSection
					title="Relationship types"
					count={mm.relationships.length}
					section="relationships"
				>
					{#if mm.relationships.length === 0}
						<p class="text-[11px] italic text-muted-foreground/70">None.</p>
					{:else}
						{#each mm.relationships as rel, i (`${i}:${rel.name}`)}
							<button
								type="button"
								class={linkCls}
								data-testid="mm-toc-row"
								onclick={() => reveal({ kind: 'relationship', name: rel.name })}
							>
								<span class="text-foreground/90">{rel.name}</span>
								{#if rel.abstract}<span class="text-muted-foreground/70"> — abstract</span>{/if}
								{#if rel.mappings.length === 0}
									<span class="text-muted-foreground/70"> — no mappings</span>
								{/if}
							</button>
						{/each}
					{/if}
				</PanelSection>

				<PanelSection title="Enums" count={Object.keys(mm.enums).length} section="enums">
					{#if Object.keys(mm.enums).length === 0}
						<p class="text-[11px] italic text-muted-foreground/70">None.</p>
					{:else}
						{#each Object.entries(mm.enums) as [name, literals] (name)}
							<button
								type="button"
								class={linkCls}
								data-testid="mm-toc-row"
								onclick={() => reveal({ kind: 'enum', name })}
							>
								<span class="text-foreground/90">{name}</span>
								<span class="text-muted-foreground/70"> — {literals.length} literals</span>
							</button>
						{/each}
					{/if}
				</PanelSection>

				{#if !readOnly}
					<div class="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
						<button type="button" class={addBtnCls} onclick={createRelationshipType}>
							<Plus class="h-3 w-3" /> Relationship type
						</button>
						<button type="button" class={addBtnCls} onclick={createEnum}>
							<Plus class="h-3 w-3" /> Enum
						</button>
					</div>
				{/if}
			</div>
```

This subsumes the old mapless-only list (all relationships are listed with mapless badges) and the old flat enums list; delete the `mapless` derivation at the top of the script if nothing else uses it.

- [ ] **Step 5: Run the tests**

Run: `pixi run frontend-test -- -- src/lib/components/Metamodel/__tests__/metamodel-form-panel.test.ts`
Expected: PASS.
Run: `pixi run frontend-test` — the full suite; the panel is rendered by existing tab tests, so anything they asserted about the old overview surfaces here.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Metamodel/
git commit -m "feat(frontend): metamodel panel overview becomes a collapsible TOC with reveal rows"
```

---

### Task 11: Whole-panel collapse

**Files:**
- Modify: `frontend/src/lib/components/Metamodel/MetamodelDiagram.svelte` (the `aside`, lines ~408-412)

**Interfaces:**
- Consumes: `getMetamodelPanel`, `setMetamodelPanelCollapsed` from `$lib/state` (Task 7).

Automated coverage note: the collapse STATE (persistence, reopen-on-reveal) is pinned by Tasks 7-8; the collapsed-rail markup is exercised by `svelte-check` only, consistent with the canvas component's existing coverage level.

- [ ] **Step 1: Replace the fixed `aside`**

Extend the `$lib/state` import with `getMetamodelPanel, setMetamodelPanelCollapsed`, add `import { ChevronsLeft, ChevronsRight } from '@lucide/svelte';`, add:

```ts
	const panel = $derived(getMetamodelPanel());
```

Replace the `<aside>` block with:

```svelte
			{#if !panel.collapsed}
				<!-- The attribute half of the surface. Fixed 320px and independently
				     scrollable: the canvas must keep the whole remaining width no
				     matter how tall a type's property list gets. Collapsible (spec
				     §7.2): hidden, the canvas takes the full width and the rail below
				     stands in. -->
				<aside class="relative w-80 shrink-0 overflow-y-auto border-l border-border">
					<button
						type="button"
						class="absolute right-1.5 top-1.5 z-10 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						title="Hide panel"
						aria-label="Hide panel"
						data-testid="mm-panel-hide"
						onclick={() => setMetamodelPanelCollapsed(true)}
					>
						<ChevronsRight class="h-3.5 w-3.5" />
					</button>
					<MetamodelFormPanel {readOnly} />
				</aside>
			{:else}
				<!-- Collapsed rail. A selection landing from a CANVAS click does not
				     force the panel open (spec §7.2) — the dot is the hint that one
				     is waiting; search/TOC picks reopen via revealSelection. -->
				<div class="flex shrink-0 flex-col items-center border-l border-border px-0.5 pt-1.5">
					<button
						type="button"
						class="relative rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						title="Show panel"
						aria-label="Show panel"
						data-testid="mm-panel-show"
						onclick={() => setMetamodelPanelCollapsed(false)}
					>
						<ChevronsLeft class="h-3.5 w-3.5" />
						{#if view.selection !== null}
							<span
								class="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
								data-testid="mm-panel-selection-dot"
							></span>
						{/if}
					</button>
				</div>
			{/if}
```

- [ ] **Step 2: Verify**

Run: `pixi run frontend-check` — expected: clean.
Run: `pixi run frontend-test` — expected: all pass (tab tests still render the expanded panel — default state is open).
Manual: collapse the panel → canvas takes full width; click a box on the canvas → panel stays collapsed, dot appears; pick a type in search → panel reopens on its form; reload → collapse state remembered.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/Metamodel/MetamodelDiagram.svelte
git commit -m "feat(frontend): collapsible metamodel form panel with pending-selection indicator"
```

---

### Task 12: Full verification + backlog bookkeeping

**Files:**
- Modify: `BACKLOG.md`

- [ ] **Step 1: Run every gate**

```bash
pixi run frontend-test
pixi run frontend-check
pixi run dr-tidy
pixi run core-test
```

Expected: frontend suite green (baseline was 2049+ passing before this branch; now higher), svelte-check clean, dr-tidy clean (re-stage anything it reformats), core suite untouched-green. Fix anything that fails before proceeding — report honestly if something cannot be fixed.

- [ ] **Step 2: Update `BACKLOG.md`**

- P-17: change the heading to `### P-17 · Metamodel diagram: unbounded zoom-out with a level-of-detail mode · \`done\` (2026-08-20, feat/metamodel-navigation)` and append one line to the entry: `Shipped: minZoom 0.05, LOD name-only render below zoom 0.4 (hysteresis to 0.5) with a cursor tooltip; spec docs/superpowers/specs/2026-08-20-metamodel-navigation-at-scale-design.md.`
- P-18: change the heading to `### P-18 · Metamodel diagram: hover highlighting · \`done\` (2026-08-20, feat/metamodel-navigation)` and append: `Shipped: hover lights the neighborhood (gens included) and dims the rest; adjacency derived per diagram build in frontend/src/lib/metamodel/diagram-adjacency.ts.`
- In T-7's paragraph, append the sentence: `The 2026-08-20 metamodel-navigation features (LOD, hover highlighting, type search, panel TOC/collapse) join this list — unit-covered, no e2e.`
- In the header "Last updated" block, update the date to 2026-08-20 and add one sentence noting P-17/P-18 closed by the metamodel-navigation pass, which also shipped the two owner-requested navigation features (search autocomplete, collapsible panel) recorded in the 2026-08-20 spec.

- [ ] **Step 3: Commit**

```bash
git add BACKLOG.md
git commit -m "docs: backlog updates for metamodel navigation at scale (P-17, P-18 done)"
```

- [ ] **Step 4: Manual smoke pass (final)**

`pixi run backend-start` + `pixi run frontend-start`, smart-city project, metamodel tab → Diagram:
1. Zoom out far — everything visible, name-only boxes, tooltip on hover.
2. Hover boxes and edges — correct neighborhoods, dimming, no lag while dragging the viewport.
3. Search `zo` → autocomplete → Enter → canvas centers Zone, panel shows its form.
4. Search a multi-mapping relationship → viewport fits all endpoints, all edges lit.
5. Collapse sections, collapse the panel, reload — everything remembered; TOC row click pans and reopens the panel.
6. As a viewer (second browser/user): all four features work read-only.

---

## Self-Review (completed at write time)

- **Spec coverage:** §4 → Task 3 (+ tooltip in Task 4); §5 → Tasks 1, 2, 4; §6 → Tasks 6, 8, 9; §7.1 → Tasks 7, 10; §7.2 → Tasks 7, 8, 11; §8 non-goals respected (no backend, no `nodeSize`/elk changes — LOD is visibility-based); §9 testing map → Tasks 1, 2, 5, 6, 7, 8, 9, 10; §10 bookkeeping → Task 12.
- **Type consistency:** `DiagramHover` uses `{ kind: 'edge'; id; relName }` everywhere (Tasks 1, 2, 4); `RevealFlow`/`revealTarget`/`REVEAL_ZOOM` names match across Tasks 5, 8, 9, 10; `PanelSectionKey` matches across Tasks 7, 9, 10.
- **Known judgment calls recorded:** LOD hides via `visibility: hidden` (stronger than the spec's "footprint identical" — DOM-identical); a mapless-but-boxed relationship pans to its box (spec's `none` case narrows to truly-undrawn, per fixture reality); node components get no standalone mount tests (xyflow store dependency) — their decision logic is pure-function-tested instead.
