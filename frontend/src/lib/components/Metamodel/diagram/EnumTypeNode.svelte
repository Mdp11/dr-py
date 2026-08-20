<script lang="ts">
	import type { NodeProps } from '@xyflow/svelte';
	import { visualState } from '$lib/metamodel/diagram-adjacency';
	import { getDiagramHighlight, getLodActive } from '$lib/state';

	/**
	 * The `«enumeration»` chip — UML's stereotyped classifier for an enum, in
	 * the code editor's gold (the same token that colours a YAML keyword, which
	 * is what an enum literal reads as in the draft).
	 *
	 * No `Handle`s, deliberately: `buildDiagram` draws no edge to an enum node
	 * (a property's datatype naming one is a text reference, not an
	 * association), so a connection anchor here would only invite a gesture the
	 * metamodel has no shape for.
	 *
	 * Literals render as one interpunct-separated line rather than a row each,
	 * per the approved mockup. `nodeSize` reserves a row per literal, so the
	 * space elk leaves is always at least what this draws.
	 */

	interface Data {
		name: string;
		literals: string[];
		collapsed: boolean;
		onToggleCollapse: (id: string) => void;
	}

	let { id, data, selected = false }: NodeProps = $props();
	const d = $derived(data as unknown as Data);
	const lod = $derived(getLodActive());
	const vis = $derived(visualState(id, 'node', selected, getDiagramHighlight()));
</script>

<div
	class="mm-node"
	class:selected
	class:mm-lod={lod}
	class:mm-dim={vis === 'dim'}
	class:mm-hot={vis === 'hot'}
	data-testid="mm-node-enum"
>
	<div class="mm-header">
		<div class="mm-titles">
			<span class="mm-stereotype">«enumeration»</span>
			<span class="mm-name">{d.name}</span>
		</div>
		<!-- `nodrag`: see ElementTypeNode — the mousedown would otherwise start a
		     node drag under the cursor. -->
		<button
			type="button"
			class="mm-toggle nodrag"
			title={d.collapsed ? `Expand ${d.name}` : `Collapse ${d.name}`}
			aria-label={d.collapsed ? `Expand ${d.name}` : `Collapse ${d.name}`}
			aria-expanded={!d.collapsed}
			onclick={(e) => {
				e.stopPropagation();
				d.onToggleCollapse(id);
			}}
		>
			{#if d.collapsed}
				<span class="mm-chip">{d.literals.length}</span>
			{:else}
				<span class="mm-chevron">▾</span>
			{/if}
		</button>
	</div>
	{#if !d.collapsed && d.literals.length > 0}
		<div class="mm-literals">{d.literals.join(' · ')}</div>
	{/if}
	{#if lod}
		<span class="mm-lod-name">{d.name}</span>
	{/if}
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
		border: 1px solid color-mix(in oklab, var(--cm-keyword) 30%, transparent);
		box-shadow: 0 6px 20px oklch(0 0 0 / 40%);
		overflow: hidden;
		transition: opacity 140ms ease;
	}
	.mm-node.selected {
		border-color: color-mix(in oklab, var(--ring) 45%, transparent);
		box-shadow:
			0 6px 28px oklch(0 0 0 / 50%),
			0 0 0 3px color-mix(in oklab, var(--ring) 8%, transparent);
	}

	/* Hover neighborhood (spec §5): the hovered thing and its neighbors stay
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
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 13px 3px;
	}
	.mm-titles {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.mm-stereotype {
		color: var(--cm-comment);
		font-size: 9px;
		letter-spacing: 0.06em;
	}
	.mm-name {
		color: var(--cm-keyword);
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 13px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mm-toggle {
		margin-left: auto;
		display: flex;
		align-items: center;
		cursor: pointer;
	}
	.mm-chip {
		background: color-mix(in oklab, var(--cm-keyword) 14%, transparent);
		color: var(--cm-keyword);
		border-radius: 99px;
		padding: 1px 8px;
		font-size: 10px;
	}
	.mm-chevron {
		color: var(--cm-comment);
		font-size: 10px;
	}

	.mm-literals {
		padding: 2px 13px 9px;
		font-size: 11px;
		line-height: 1.7;
		color: var(--cm-property);
		max-height: calc(12 * 22px);
		overflow-y: auto;
	}

	/* LOD (spec §4): see ElementTypeNode's identical block for the rationale
	   (`visibility`, not removal, keeps the DOM height — and every edge
	   anchor — byte-identical in both modes). The enum name keeps its gold
	   token rather than switching to the neutral foreground the other two
	   node shapes use. */
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
</style>
