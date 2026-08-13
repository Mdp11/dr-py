<script lang="ts">
	import type { NodeProps } from '@xyflow/svelte';

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
</script>

<div class="mm-node" class:selected data-testid="mm-node-enum">
	<div class="mm-header">
		<div class="mm-titles">
			<span class="mm-stereotype">«enumeration»</span>
			<span class="mm-name">{d.name}</span>
		</div>
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
				<span class="mm-chip">{d.literals.length}</span>
			{:else}
				<span class="mm-chevron">▾</span>
			{/if}
		</button>
	</div>
	{#if !d.collapsed && d.literals.length > 0}
		<div class="mm-literals">{d.literals.join(' · ')}</div>
	{/if}
</div>

<style>
	.mm-node {
		border-radius: 10px;
		background: linear-gradient(
			165deg,
			color-mix(in oklab, var(--popover) 92%, transparent),
			color-mix(in oklab, var(--card) 96%, transparent)
		);
		border: 1px solid color-mix(in oklab, var(--cm-keyword) 30%, transparent);
		box-shadow: 0 6px 20px oklch(0 0 0 / 40%);
		overflow: hidden;
	}
	.mm-node.selected {
		border-color: color-mix(in oklab, var(--ring) 45%, transparent);
		box-shadow:
			0 6px 28px oklch(0 0 0 / 50%),
			0 0 0 3px color-mix(in oklab, var(--ring) 8%, transparent);
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
</style>
