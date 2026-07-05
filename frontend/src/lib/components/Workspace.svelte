<script lang="ts">
	import { X } from '@lucide/svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import { closeTab, getActiveTab, getDynamicTabs, setActiveTab } from '$lib/state';
	import DetailView from './Workspace/DetailView.svelte';
	import GraphView from './Workspace/GraphView.svelte';
	import IssuesPanel from './Workspace/IssuesPanel.svelte';
	import NavigationBuilder from './Navigation/NavigationBuilder.svelte';

	const activeTab = $derived(getActiveTab());
	const dynamicTabs = $derived(getDynamicTabs());

	function onValueChange(v: string): void {
		setActiveTab(v);
	}
</script>

<section class="flex h-full flex-col overflow-hidden bg-zinc-950 text-sm text-zinc-200">
	<Tabs.Root value={activeTab} {onValueChange} class="flex h-full flex-col">
		<Tabs.List
			class="h-9 w-full justify-start overflow-x-auto rounded-none border-b border-zinc-800 bg-zinc-950 px-2"
		>
			<Tabs.Trigger value="detail" class="h-7 text-xs">Detail</Tabs.Trigger>
			<Tabs.Trigger value="graph" class="h-7 text-xs">Graph</Tabs.Trigger>
			<Tabs.Trigger value="issues" class="h-7 text-xs">Issues</Tabs.Trigger>
			{#each dynamicTabs as tab (tab.id)}
				<Tabs.Trigger value={tab.id} class="group h-7 gap-1 text-xs">
					<span class="max-w-40 truncate">{tab.title}</span>
					<button
						type="button"
						aria-label="Close {tab.title}"
						class="rounded p-0.5 opacity-50 hover:bg-zinc-700 hover:opacity-100"
						onclick={(e) => {
							e.stopPropagation();
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
				<NavigationBuilder tabId={tab.id} />
			</Tabs.Content>
		{/each}
	</Tabs.Root>
</section>
