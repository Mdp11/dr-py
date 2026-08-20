<script lang="ts">
	import { BaseEdge, EdgeLabel, getSmoothStepPath, Position, type EdgeProps } from '@xyflow/svelte';
	import { getLodActive } from '$lib/state';

	/**
	 * UML association: the relationship name at the midpoint, end multiplicities
	 * near the boxes they constrain, a filled diamond at the SOURCE end for a
	 * containment (composition) type, and an open arrowhead for navigability.
	 *
	 * A relationship that needs an association-class box arrives as two edge
	 * halves through it (`assoc-in:` / `assoc-out:` in diagram-build.ts). Those
	 * halves are drawn DASHED — UML's tether between an association and its
	 * class — which is why the dash test is "does either endpoint name a `rel:`
	 * node" rather than anything carried in `data`.
	 *
	 * Multiplicity labels sit 24px in from each endpoint, offset along the side
	 * the handle is on so they stay clear of the box they annotate.
	 *
	 * NB `EdgeLabel` is v1's replacement for the `EdgeLabelRenderer` of older
	 * Svelte Flow releases: it portals its children into the flow's label layer
	 * and takes the position directly.
	 */

	interface Data {
		relName?: string;
		label?: string;
		/** Draws the diamond — set on the ONE half that owns the whole end. */
		containment?: boolean;
		/** Belongs to a containment relationship, whichever half this is. Added by
		 * `MetamodelDiagram` (see the note there): a relationship drawn through an
		 * association-class box is two edges, and both must read the same colour
		 * or one relationship type looks like two. */
		containmentRel?: boolean;
		sourceMult?: string;
		targetMult?: string;
		arrow?: boolean;
	}

	let {
		source,
		target,
		data,
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		selected = false
	}: EdgeProps = $props();

	const d = $derived((data ?? {}) as unknown as Data);
	const tethered = $derived(source.startsWith('rel:') || target.startsWith('rel:'));
	const lod = $derived(getLodActive());

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

	const LABEL_INSET = 24;

	/** Step `LABEL_INSET` off an endpoint, away from the box it belongs to. */
	function inset(pos: Position, x: number, y: number): { x: number; y: number } {
		switch (pos) {
			case Position.Left:
				return { x: x - LABEL_INSET, y: y - 10 };
			case Position.Right:
				return { x: x + LABEL_INSET, y: y - 10 };
			case Position.Top:
				return { x: x + 14, y: y - LABEL_INSET };
			default:
				return { x: x + 14, y: y + LABEL_INSET };
		}
	}

	const sourceLabelAt = $derived(inset(sourcePosition, sourceX, sourceY));
	const targetLabelAt = $derived(inset(targetPosition, targetX, targetY));

	// Containment reads as structure (the app's muted hairline); a plain
	// association reads as navigation (the editor's jade), per the mockup. Keyed
	// off `containmentRel`, not `containment`, so BOTH halves of a boxed
	// containment take the same colour — the marker is the half-specific part.
	const structural = $derived(d.containmentRel ?? d.containment ?? false);
	const stroke = $derived(
		selected
			? 'var(--primary)'
			: structural
				? 'color-mix(in oklab, var(--muted-foreground) 70%, transparent)'
				: 'color-mix(in oklab, var(--ring) 85%, transparent)'
	);
	const labelColor = $derived(structural ? 'var(--muted-foreground)' : 'var(--cm-string)');
</script>

<BaseEdge
	path={path[0]}
	label={lod ? undefined : d.label}
	labelX={path[1]}
	labelY={path[2]}
	labelStyle="color: {labelColor}; font-size: 11px; font-weight: 600;"
	markerStart={d.containment ? 'url(#uml-diamond)' : undefined}
	markerEnd={d.arrow ? 'url(#uml-arrow)' : undefined}
	style="stroke: {stroke}; stroke-width: {selected ? 2 : 1.5}px;{tethered
		? ' stroke-dasharray: 5 4;'
		: ''}"
/>

{#if !lod && d.sourceMult}
	<EdgeLabel
		x={sourceLabelAt.x}
		y={sourceLabelAt.y}
		transparent
		style="color: var(--cm-comment); font-size: 10px;"
	>
		{d.sourceMult}
	</EdgeLabel>
{/if}
{#if !lod && d.targetMult}
	<EdgeLabel
		x={targetLabelAt.x}
		y={targetLabelAt.y}
		transparent
		style="color: var(--cm-comment); font-size: 10px;"
	>
		{d.targetMult}
	</EdgeLabel>
{/if}
