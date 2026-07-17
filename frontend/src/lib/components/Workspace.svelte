<script lang="ts">
	import { X } from '@lucide/svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		closeDraft,
		closeTab,
		closeTableDraft,
		getActiveTab,
		getDynamicTabs,
		isTabDirty,
		setActiveTab
	} from '$lib/state';
	import DetailView from './Workspace/DetailView.svelte';
	import GraphView from './Workspace/GraphView.svelte';
	import IssuesPanel from './Workspace/IssuesPanel.svelte';
	import NavigationBuilder from './Navigation/NavigationBuilder.svelte';
	import TableView from './Table/TableView.svelte';

	const activeTab = $derived(getActiveTab());
	const dynamicTabs = $derived(getDynamicTabs());

	function onValueChange(v: string): void {
		setActiveTab(v);
	}
</script>

<section class="flex h-full flex-col overflow-hidden bg-background text-sm text-foreground/90">
	<Tabs.Root value={activeTab} {onValueChange} class="flex h-full flex-col">
		<Tabs.List
			class="h-9 w-full justify-start overflow-x-auto rounded-none border-b border-border bg-background px-2"
		>
			<Tabs.Trigger value="detail" class="h-7 text-xs">Detail</Tabs.Trigger>
			<Tabs.Trigger value="graph" class="h-7 text-xs">Graph</Tabs.Trigger>
			<Tabs.Trigger value="issues" class="h-7 text-xs">Issues</Tabs.Trigger>
			{#each dynamicTabs as tab (tab.id)}
				<Tabs.Trigger value={tab.id} class="group h-7 gap-1 text-xs">
					<span class="max-w-40 truncate"
						>{tab.title}{isTabDirty(tab.kind, tab.id) ? ' *' : ''}</span
					>
					<button
						type="button"
						aria-label="Close {tab.title}"
						class="rounded p-0.5 opacity-50 transition-[color,background-color,border-color,opacity] hover:bg-muted hover:opacity-100"
						onclick={(e) => {
							e.stopPropagation();
							if (tab.kind === 'table') {
								closeTableDraft(tab.id);
							} else {
								closeDraft(tab.id);
							}
							closeTab(tab.id);
						}}
					>
						<X class="size-3" />
					</button>
				</Tabs.Trigger>
			{/each}
		</Tabs.List>
		<Tabs.Content value="detail" class="flex-1 overflow-auto">
			<DetailView />
		</Tabs.Content>
		<Tabs.Content value="graph" class="flex-1 overflow-hidden">
			<GraphView />
		</Tabs.Content>
		<Tabs.Content value="issues" class="flex-1 overflow-hidden">
			<IssuesPanel />
		</Tabs.Content>
		{#each dynamicTabs as tab (tab.id)}
			<Tabs.Content value={tab.id} class="flex-1 overflow-hidden">
				{#if tab.kind === 'table'}
					<TableView tabId={tab.id} />
				{:else}
					<NavigationBuilder tabId={tab.id} />
				{/if}
			</Tabs.Content>
		{/each}
	</Tabs.Root>
</section>
