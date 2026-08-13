<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import type { PropertyDef } from '$lib/api/types';

	/**
	 * UML class box for an element type — the canvas's primary shape.
	 *
	 * Strict class-diagram notation in the app's own language (approved mockup):
	 * a name compartment over an attribute compartment, an abstract type set in
	 * italic behind a dashed border, and the `{id}` key marker in the code
	 * editor's gold. Every colour is a CSS token, never a hex literal — these
	 * are real DOM nodes (unlike the SVG canvas in GraphView.svelte, which has
	 * to mirror the palette by hand), so `var(--…)` resolves normally and the
	 * boxes follow the theme for free.
	 *
	 * The node's WIDTH is not set here: `MetamodelDiagram` puts `nodeSize()` on
	 * the flow node's style so the box and the elk layout can never disagree
	 * about its footprint. Height stays content-driven, with the attribute
	 * compartment capped at the same row budget `nodeSize` reserves.
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

	/** Datatypes the metamodel schema defines itself; anything else names an
	 * enum or an element type and is tinted as a reference (mockup: `Zone` in
	 * the editor's accent blue against `string` in sand). */
	const PRIMITIVES = new Set(['string', 'integer', 'float', 'boolean', 'date', 'datetime']);
</script>

<div
	class="mm-node"
	class:abstract={d.abstract}
	class:selected
	class:error={d.hasError}
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
		<button
			type="button"
			class="mm-toggle"
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
			{#each d.properties as p (p.name)}
				<div class="mm-row">
					<span class="mm-prop">{p.name}</span><span class="mm-punct">: </span><span
						class="mm-type"
						class:ref={!PRIMITIVES.has(p.datatype)}>{p.datatype}</span
					>
					<span class="mm-mult">[{p.multiplicity}]</span>
					{#if keyProps.has(p.name)}<span class="mm-key">{'{id}'}</span>{/if}
				</div>
			{/each}
		</div>
	{/if}
	<Handle
		type="source"
		position={Position.Right}
		style="background: var(--muted-foreground); border: none; width: 7px; height: 7px; opacity: 0.4;"
	/>
</div>

<style>
	.mm-node {
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
		padding: 4px 14px 8px;
		font-size: 11.5px;
		/* 12 rows is MAX_ROWS in diagram-build.ts: past the cap the box scrolls
		   internally rather than growing past the space elk reserved for it. */
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
</style>
