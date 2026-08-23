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
 * cursor is for the LOD tooltip.
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
 * against examples/smart-city.metamodel.yaml. */
export const LOD_ENTER = 0.4;
export const LOD_EXIT = 0.5;

/** Width of an edge's invisible hit area, in FLOW units — xyflow's own default,
 * restated here so the LOD widening below has something to be a widening OF. */
export const EDGE_HIT_WIDTH = 20;
/** ...and in simplified mode. Flow units scale with the zoom, so at the zooms
 * that turn LOD on the default 20 is a few screen pixels wide: an edge becomes
 * practically un-hoverable exactly where the cursor tooltip is the only way to
 * read what it connects. Tripling it is a deliberate trade, not a free win —
 * the band is measured in flow units, so whether two of them overlap does NOT
 * depend on the zoom, and at elk's 48-unit node spacing edges that run close
 * together will now share hit area, with the topmost taking the pointer. That
 * is worth it only under LOD, where the alternative is a target too thin to
 * hit at all; at normal zoom the default stands and precision is untouched. */
export const EDGE_HIT_WIDTH_LOD = 60;

/** `$state.raw`, like the adjacency below and for the same reason: a hover is
 * replaced wholesale (never mutated in place) and its IDENTITY is half the memo
 * key in `getDiagramHighlight`. A proxied `$state` would compare a proxy
 * against the raw literal a caller still holds — Svelte's own
 * `state_proxy_equality_mismatch` warning — for no benefit, since nothing here
 * reads a field of the hover reactively. */
let _hover = $state.raw<DiagramHover | null>(null);
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

/** Install the adjacency for a freshly built diagram — and drop the hover with
 * it. A rebuild (an undo, a peer's rebind, any draft edit) can retire the very
 * node or edge the pointer is sitting on, and a `_hover` left pointing at an id
 * the new index has never heard of resolves to an EMPTY highlight set, which
 * `visualState` reads as "nothing is hot, so dim everything but the selection":
 * the canvas greys out wholesale and stays that way until the next pointer
 * event happens to land somewhere. Clearing is the honest reset — no highlight
 * until the pointer says where it is now. */
export function setDiagramAdjacency(a: DiagramAdjacency | null): void {
	_adjacency = a;
	_hover = null;
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

/** The cursor sink the canvas's `pointermove` calls: record
 * the position ONLY while the LOD tooltip could be showing — simplified mode is
 * on AND something is hovered — and clear it otherwise.
 *
 * The guard is the point, not an optimization detail: `pointermove` fires
 * continuously across the whole canvas, and writing `$state` on every one of
 * those events invalidates every reader of `getHoverCursor()` for a value only
 * the tooltip ever reads and only while it is open. Clearing on the way out
 * (rather than leaving the last position behind) also means `_cursor` never
 * outlives the mode that produced it: nothing renders from a stale point when
 * LOD next engages, before the pointer has moved. */
export function noteHoverCursor(p: { x: number; y: number }): void {
	if (!_lod || _hover === null) {
		if (_cursor !== null) _cursor = null;
		return;
	}
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
