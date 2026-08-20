<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronDown, ChevronRight } from '@lucide/svelte';

	import { getMetamodelPanel, toggleMetamodelPanelSection } from '$lib/state';
	import type { PanelSectionKey } from '$lib/state/metamodel-panel.svelte';

	/**
	 * One collapsible TOC section (spec 2026-08-20 §7.1) — the
	 * `Sidebar/StagedSection.svelte` header-button idiom over the panel
	 * module's persisted per-section state.
	 */

	let {
		title,
		count,
		section,
		children
	}: { title: string; count: number; section: PanelSectionKey; children: Snippet } = $props();

	const collapsed = $derived(getMetamodelPanel().sections[section]);
</script>

<div class="flex flex-col gap-0.5">
	<button
		type="button"
		class="microlabel flex select-none items-center gap-1 py-0.5 text-left transition-colors hover:text-foreground/80"
		data-testid={`mm-section-${section}`}
		aria-expanded={!collapsed}
		onclick={() => toggleMetamodelPanelSection(section)}
	>
		{#if collapsed}
			<ChevronRight class="h-3 w-3" />
		{:else}
			<ChevronDown class="h-3 w-3" />
		{/if}
		<span class="flex-1">{title}</span>
		<span class="font-mono text-[10px] normal-case text-muted-foreground">{count}</span>
	</button>
	{#if !collapsed}
		{@render children()}
	{/if}
</div>
