<script lang="ts">
	import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/svelte';
	import { visualState } from '$lib/metamodel/diagram-adjacency';
	import {
		EDGE_HIT_WIDTH,
		EDGE_HIT_WIDTH_LOD,
		getDiagramHighlight,
		getLodActive
	} from '$lib/state';

	/**
	 * UML generalization: a solid line from the subtype to the supertype,
	 * closed by a hollow triangle at the SUPERTYPE end. The triangle is the
	 * shared `uml-gen` marker `MetamodelDiagram` defines once — markers are
	 * document-global, so every edge references the same three definitions
	 * rather than minting its own per instance.
	 */

	let {
		id,
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		selected = false
	}: EdgeProps = $props();

	const path = $derived(
		getSmoothStepPath({
			sourceX,
			sourceY,
			sourcePosition,
			targetX,
			targetY,
			targetPosition
		})
	);

	const vis = $derived(visualState(id, 'edge', selected, getDiagramHighlight()));
	const lod = $derived(getLodActive());
</script>

<!-- `interactionWidth` is in FLOW units, so the hit area shrinks with the zoom;
     it is widened under LOD because that is the mode whose whole point is
     hovering an edge to read what it connects (see EDGE_HIT_WIDTH_LOD).

     The dim transition carries a 120ms DELAY, matching `.mm-node.mm-dim`'s
     `transition-delay` in the three node components: a cursor sweeping across
     the canvas must not strobe the whole picture on its way to a target, and an
     edge that dimmed instantly while the boxes held steady was the worst of
     both. Un-dimming keeps a 0ms delay, so the neighbourhood lights up the
     moment the pointer lands. -->
<BaseEdge
	path={path[0]}
	interactionWidth={lod ? EDGE_HIT_WIDTH_LOD : EDGE_HIT_WIDTH}
	markerEnd="url(#uml-gen)"
	style="{selected || vis === 'hot'
		? 'stroke: var(--ring); stroke-width: 2px;'
		: 'stroke: color-mix(in oklab, var(--muted-foreground) 80%, transparent); stroke-width: 1.5px;'} opacity: {vis ===
	'dim'
		? 0.2
		: 1}; transition: opacity 140ms ease {vis === 'dim' ? '120ms' : '0ms'};"
/>
