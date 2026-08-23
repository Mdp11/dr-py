<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import type { PropertyDef } from '$lib/api/types';
	import { visualState } from '$lib/metamodel/diagram-adjacency';
	// A datatype outside the schema's OWN set names an enum or an element type,
	// and is tinted as a reference (mockup: `Zone` in the editor's accent blue
	// against `string` in sand). Shared with the form panel's datatype picker so
	// the canvas and the picker can never disagree about what a primitive is.
	import { PRIMITIVE_DATATYPES } from '$lib/metamodel/helpers';
	import { getDiagramHighlight, getLodActive } from '$lib/state';

	/**
	 * UML class box for an element type — the canvas's primary shape.
	 *
	 * Strict class-diagram notation in the app's own language (approved mockup):
	 * a name compartment over an attribute compartment, an abstract type set in
	 * italic behind a dashed border, and the `{id}` key marker in the code
	 * editor's gold. Every colour is a CSS token, never a hex literal — these
	 * are real DOM nodes (unlike a hand-rolled SVG canvas, which would have
	 * to mirror the palette by hand), so `var(--…)` resolves normally and the
	 * boxes follow the theme for free.
	 *
	 * The node's WIDTH is not set here: `MetamodelDiagram` puts `nodeSize()` on
	 * the flow node's style so the box and the elk layout can never disagree
	 * about its footprint. HEIGHT is content-driven but adds up to the same
	 * number by construction — the header is `HEADER_HEIGHT`, every attribute
	 * row is `ROW_HEIGHT`, the compartment carries no vertical padding, and it
	 * scrolls at `MAX_ROWS` — so an expanded box occupies exactly the space elk
	 * reserved for it. Change any of those three CSS values and `nodeSize` in
	 * diagram-build.ts has to move with it.
	 */

	interface Data {
		name: string;
		abstract: boolean;
		properties: PropertyDef[];
		/** Own `key` entries that name a property — rendered as `{id}`. */
		keyProps: string[];
		collapsed: boolean;
		hasError: boolean;
		onToggleCollapse: (id: string) => void;
	}

	let { id, data, selected = false }: NodeProps = $props();
	const d = $derived(data as unknown as Data);
	const keyProps = $derived(new Set(d.keyProps));
	const lod = $derived(getLodActive());
	const vis = $derived(visualState(id, 'node', selected, getDiagramHighlight()));
</script>

<div
	class="mm-node"
	class:abstract={d.abstract}
	class:selected
	class:error={d.hasError}
	class:mm-lod={lod}
	class:mm-dim={vis === 'dim'}
	class:mm-hot={vis === 'hot'}
	data-testid="mm-node-element"
>
	<Handle
		type="target"
		position={Position.Left}
		style="background: var(--muted-foreground); border: none; width: 7px; height: 7px; opacity: 0.4;"
	/>
	<div class="mm-header" class:divided={!d.collapsed && d.properties.length > 0}>
		<span class="mm-dot"></span>
		<span class="mm-name" class:italic={d.abstract}>{d.name}</span>
		<!-- `nodrag` is xyflow's opt-out: without it the mousedown that opens this
		     button ALSO starts a node drag, so the box slides out from under the
		     cursor before the click lands. -->
		<button
			type="button"
			class="mm-toggle nodrag"
			title={d.collapsed ? `Expand ${d.name}` : `Collapse ${d.name}`}
			aria-label={d.collapsed ? `Expand ${d.name}` : `Collapse ${d.name}`}
			aria-expanded={!d.collapsed}
			onclick={(e) => {
				// Collapsing is a view gesture, not a selection one: without this the
				// click also reaches Svelte Flow's node handler and re-selects.
				e.stopPropagation();
				d.onToggleCollapse(id);
			}}
		>
			{#if d.collapsed}
				<span class="mm-chip">{d.properties.length}</span>
			{:else}
				<span class="mm-chevron">▾</span>
			{/if}
		</button>
	</div>
	{#if !d.collapsed && d.properties.length > 0}
		<div class="mm-compartment">
			{#each d.properties as p, i (`${i}:${p.name}`)}
				<div class="mm-row">
					<span class="mm-prop">{p.name}</span><span class="mm-punct">: </span><span
						class="mm-type"
						class:ref={!PRIMITIVE_DATATYPES.has(p.datatype)}>{p.datatype}</span
					>
					<span class="mm-mult">[{p.multiplicity}]</span>
					{#if keyProps.has(p.name)}<span class="mm-key">{'{id}'}</span>{/if}
				</div>
			{/each}
		</div>
	{/if}
	{#if lod}
		<span class="mm-lod-name" class:italic={d.abstract}>{d.name}</span>
	{/if}
	<Handle
		type="source"
		position={Position.Right}
		style="background: var(--muted-foreground); border: none; width: 7px; height: 7px; opacity: 0.4;"
	/>
</div>

<style>
	.mm-node {
		position: relative;
		border-radius: 10px;
		background: linear-gradient(
			165deg,
			color-mix(in oklab, var(--popover) 92%, transparent),
			color-mix(in oklab, var(--card) 96%, transparent)
		);
		border: 1px solid color-mix(in oklab, var(--foreground) 10%, transparent);
		box-shadow:
			0 6px 24px oklch(0 0 0 / 45%),
			inset 0 1px 0 color-mix(in oklab, var(--foreground) 4%, transparent);
		overflow: hidden;
		transition: opacity 140ms ease;
	}
	.mm-node.abstract {
		border-style: dashed;
		border-color: color-mix(in oklab, var(--muted-foreground) 45%, transparent);
	}
	.mm-node.selected {
		border-style: solid;
		border-color: color-mix(in oklab, var(--ring) 45%, transparent);
		box-shadow:
			0 6px 28px oklch(0 0 0 / 50%),
			0 0 0 3px color-mix(in oklab, var(--ring) 8%, transparent);
	}
	.mm-node.error {
		border-color: var(--destructive);
	}

	/* Hover neighborhood: the hovered thing and its neighbors stay
	   full-strength while everything else dims. The transition-delay applies
	   only on the way INTO dim, so sweeping the cursor across the canvas
	   doesn't strobe; un-dim is immediate. */
	.mm-node.mm-dim {
		opacity: 0.25;
		transition-delay: 120ms;
	}
	.mm-node.mm-hot {
		border-color: color-mix(in oklab, var(--ring) 55%, transparent);
	}

	.mm-header {
		height: 40px; /* HEADER_HEIGHT in diagram-build.ts */
		padding: 0 14px;
		display: flex;
		align-items: center;
		gap: 9px;
	}
	.mm-header.divided {
		border-bottom: 1px solid color-mix(in oklab, var(--foreground) 7%, transparent);
	}
	.mm-dot {
		width: 8px;
		height: 8px;
		border-radius: 3px;
		flex: none;
		background: var(--ring);
		box-shadow: 0 0 10px color-mix(in oklab, var(--ring) 60%, transparent);
	}
	.mm-name {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 14px;
		letter-spacing: 0.01em;
		color: var(--foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mm-name.italic {
		font-style: italic;
		color: color-mix(in oklab, var(--foreground) 88%, var(--muted-foreground));
	}
	.mm-toggle {
		margin-left: auto;
		display: flex;
		align-items: center;
		cursor: pointer;
	}
	.mm-chip {
		background: color-mix(in oklab, var(--ring) 14%, transparent);
		color: var(--primary);
		border-radius: 99px;
		padding: 1px 8px;
		font-size: 10px;
	}
	.mm-chevron {
		color: var(--cm-comment);
		font-size: 10px;
	}

	.mm-compartment {
		/* NO vertical padding, on purpose: the box's height has to be exactly
		   `nodeSize`'s HEADER_HEIGHT + rows × ROW_HEIGHT, and each row's 22px
		   line box already carries its own leading. 12 rows is MAX_ROWS — past
		   the cap the compartment scrolls internally rather than growing past
		   the space elk reserved for it. */
		padding: 0 14px;
		font-size: 11.5px;
		max-height: calc(12 * 22px);
		overflow-y: auto;
	}
	.mm-row {
		height: 22px; /* ROW_HEIGHT in diagram-build.ts */
		line-height: 22px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.mm-prop {
		color: var(--cm-property);
	}
	.mm-punct {
		color: var(--cm-punctuation);
	}
	.mm-type {
		color: var(--cm-type);
	}
	.mm-type.ref {
		color: var(--cm-accent);
	}
	.mm-mult {
		color: var(--cm-comment);
	}
	.mm-key {
		color: var(--cm-keyword);
		font-size: 9.5px;
		font-weight: 600;
	}

	/* LOD: past the zoom threshold the box shows ONLY its name. The
	   full content is hidden with `visibility` — NOT removed — so the DOM
	   height, and therefore every edge anchor, is byte-identical in both
	   modes. `visibility: hidden` also disables the collapse toggle's hit
	   target, which at 0.3× zoom is unusable anyway. */
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
</style>
