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
