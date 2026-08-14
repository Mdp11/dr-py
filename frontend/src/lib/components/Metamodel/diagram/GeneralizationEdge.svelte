<script lang="ts">
	import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/svelte';

	/**
	 * UML generalization: a solid line from the subtype to the supertype,
	 * closed by a hollow triangle at the SUPERTYPE end. The triangle is the
	 * shared `uml-gen` marker `MetamodelDiagram` defines once — markers are
	 * document-global, so every edge references the same three definitions
	 * rather than minting its own per instance.
	 */

	let {
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
</script>

<BaseEdge
	path={path[0]}
	markerEnd="url(#uml-gen)"
	style={selected
		? 'stroke: var(--ring); stroke-width: 2px;'
		: 'stroke: color-mix(in oklab, var(--muted-foreground) 80%, transparent); stroke-width: 1.5px;'}
/>
