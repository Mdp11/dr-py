<script lang="ts">
	import { X } from '@lucide/svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		closeDraft,
		closeExporterDraft,
		closeMetamodelEditor,
		closeSnippetDraft,
		closeTab,
		closeTableDraft,
		getActiveTab,
		getDynamicTabs,
		isTabDirty,
		setActiveTab
	} from '$lib/state';
	import IssuesPanel from './Workspace/IssuesPanel.svelte';
	import NavigationBuilder from './Navigation/NavigationBuilder.svelte';
	import TableView from './Table/TableView.svelte';
	import SnippetTab from './Snippet/SnippetTab.svelte';
	import MetamodelTab from './Metamodel/MetamodelTab.svelte';
	import ExporterTab from './Export/ExporterTab.svelte';

	const activeTab = $derived(getActiveTab());
	const dynamicTabs = $derived(getDynamicTabs());
	// Whether the active tab id (possibly null — "nothing open") actually
	// names a dynamic tab still in the strip: drives the empty-placeholder
	// fallback below. A stale/closed id (e.g. mid re-render) falls through to
	// the placeholder too rather than rendering nothing.
	const hasActivePane = $derived(activeTab !== null && dynamicTabs.some((t) => t.id === activeTab));

	function onValueChange(v: string): void {
		setActiveTab(v);
	}
</script>

<section class="flex h-full flex-col overflow-hidden bg-background text-sm text-foreground/90">
	<Tabs.Root value={activeTab ?? ''} {onValueChange} class="flex h-full flex-col">
		<Tabs.List
			class="h-9 w-full justify-start overflow-x-auto rounded-none border-b border-border bg-background px-2"
		>
			{#each dynamicTabs as tab (tab.id)}
				<Tabs.Trigger value={tab.id} class="group h-7 gap-1 text-xs">
					<span class="max-w-40 truncate"
						>{tab.title}{tab.kind !== 'issues' && isTabDirty(tab.kind, tab.id) ? ' *' : ''}</span
					>
					<button
						type="button"
						aria-label="Close {tab.title}"
						class="rounded p-0.5 opacity-50 transition-[color,background-color,border-color,opacity] hover:bg-muted hover:opacity-100"
						onclick={(e) => {
							e.stopPropagation();
							// Explicit per-kind dispatch: each kind's own closer releases
							// its own draft/lease, so a bare fallback `else` would risk
							// running the wrong closer (e.g. the navigation closer's
							// `nav:` lease release for an `exporter` tab). An unhandled
							// kind is a silent no-op rather than a wrong-editor close.
							// `issues` needs no arm: the singleton Issues tab has no
							// draft and holds no lease, so `closeTab` alone suffices.
							if (tab.kind === 'table') closeTableDraft(tab.id);
							else if (tab.kind === 'snippet') closeSnippetDraft(tab.id);
							// Also run by MetamodelTab's own unmount teardown (closing
							// the tab unmounts it). The double call is idempotent — the
							// second sees no lease held and an already-idle phase — and
							// keeps this close path symmetric with the other kinds.
							else if (tab.kind === 'metamodel') closeMetamodelEditor();
							else if (tab.kind === 'exporter') closeExporterDraft(tab.id);
							else if (tab.kind === 'navigation') closeDraft(tab.id);
							closeTab(tab.id);
						}}
					>
						<X class="size-3" />
					</button>
				</Tabs.Trigger>
			{/each}
		</Tabs.List>
		{#each dynamicTabs as tab (tab.id)}
			<Tabs.Content value={tab.id} class="flex-1 overflow-hidden">
				{#if tab.kind === 'table'}
					<TableView tabId={tab.id} />
				{:else if tab.kind === 'snippet'}
					<SnippetTab tabId={tab.id} />
				{:else if tab.kind === 'metamodel'}
					<MetamodelTab />
				{:else if tab.kind === 'exporter'}
					<ExporterTab tabId={tab.id} />
				{:else if tab.kind === 'navigation'}
					<NavigationBuilder tabId={tab.id} />
				{:else if tab.kind === 'issues'}
					<IssuesPanel />
				{/if}
			</Tabs.Content>
		{/each}
		{#if !hasActivePane}
			<div
				data-testid="workspace-empty"
				class="flex flex-1 items-center justify-center text-xs text-muted-foreground/70"
			>
				Open an artifact from the sidebar, or Issues from the top bar.
			</div>
		{/if}
	</Tabs.Root>
</section>
