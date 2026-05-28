<script lang="ts">
	import * as Tabs from '$lib/components/ui/tabs';
	import { getActiveTab, setActiveTab, type WorkspaceTab } from '$lib/state';
	import DetailView from './Workspace/DetailView.svelte';
	import GraphView from './Workspace/GraphView.svelte';
	import IssuesPanel from './Workspace/IssuesPanel.svelte';

	const activeTab = $derived(getActiveTab());

	function onValueChange(v: string): void {
		setActiveTab(v as WorkspaceTab);
	}
</script>

<section class="flex h-full flex-col overflow-hidden bg-zinc-950 text-sm text-zinc-200">
	<Tabs.Root value={activeTab} {onValueChange} class="flex h-full flex-col">
		<Tabs.List
			class="h-9 w-full justify-start rounded-none border-b border-zinc-800 bg-zinc-950 px-2"
		>
			<Tabs.Trigger value="detail" class="h-7 text-xs">Detail</Tabs.Trigger>
			<Tabs.Trigger value="graph" class="h-7 text-xs">Graph</Tabs.Trigger>
			<Tabs.Trigger value="issues" class="h-7 text-xs">Issues</Tabs.Trigger>
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
	</Tabs.Root>
</section>
