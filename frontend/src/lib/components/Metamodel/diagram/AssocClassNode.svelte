<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import type { PropertyDef } from '$lib/api/types';

	/**
	 * The box for a relationship type that UML draws as an ASSOCIATION CLASS —
	 * one that carries its own properties or sits in a generalization hierarchy
	 * (`needsAssocBox` in diagram-build.ts decides). Its mappings arrive as two
	 * dashed edge halves through this box, which is the flow-graph rendering of
	 * UML's line-tethered association class.
	 *
	 * Deliberately a sibling of `ElementTypeNode` rather than a variant of it:
	 * the two shapes read differently on purpose (amber tint vs jade, no key
	 * markers here — a relationship's `key` DSL lives on the element side), and
	 * Tasks 11-13 extend the element box on its own. See that file for the
	 * shared conventions (token-only colours, width owned by `nodeSize`).
	 */

	interface Data {
		name: string;
		abstract: boolean;
		properties: PropertyDef[];
		collapsed: boolean;
		hasError: boolean;
		onToggleCollapse: (id: string) => void;
	}

	let { id, data, selected = false }: NodeProps = $props();
	const d = $derived(data as unknown as Data);

	const PRIMITIVES = new Set(['string', 'integer', 'float', 'boolean', 'date', 'datetime']);
</script>

<div
	class="mm-node"
	class:abstract={d.abstract}
	class:selected
	class:error={d.hasError}
	data-testid="mm-node-assoc"
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
		/* Amber hairline — the association class's own identity next to the jade
		   element boxes and the gold enum chips. */
		border: 1px solid color-mix(in oklab, var(--cm-number) 30%, transparent);
		box-shadow: 0 6px 20px oklch(0 0 0 / 40%);
		overflow: hidden;
	}
	.mm-node.abstract {
		border-style: dashed;
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
		height: 40px;
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
		background: var(--cm-number);
		box-shadow: 0 0 10px color-mix(in oklab, var(--cm-number) 55%, transparent);
	}
	.mm-name {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 13px;
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
		background: color-mix(in oklab, var(--cm-number) 14%, transparent);
		color: var(--cm-number);
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
		max-height: calc(12 * 22px);
		overflow-y: auto;
	}
	.mm-row {
		height: 22px;
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
</style>
