<script lang="ts">
	import * as Tabs from '$lib/components/ui/tabs';

	let activeTab = $state('detail');
</script>

<section class="flex h-full flex-col overflow-hidden bg-zinc-950 text-sm text-zinc-200">
	<Tabs.Root bind:value={activeTab} class="flex h-full flex-col">
		<Tabs.List class="h-9 w-full justify-start rounded-none border-b border-zinc-800 bg-zinc-950 px-2">
			<Tabs.Trigger value="detail" class="h-7 text-xs">Detail</Tabs.Trigger>
			<Tabs.Trigger value="graph" class="h-7 text-xs">Graph</Tabs.Trigger>
			<Tabs.Trigger value="issues" class="h-7 text-xs">Issues</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="detail" class="flex-1 overflow-auto p-3 text-xs text-zinc-500">
			Select an element to inspect its properties.
		</Tabs.Content>
		<Tabs.Content value="graph" class="flex-1 overflow-auto p-3 text-xs text-zinc-500">
			Graph view placeholder (T9).
		</Tabs.Content>
		<Tabs.Content value="issues" class="flex-1 overflow-auto p-3 text-xs text-zinc-500">
			No validation issues yet.
		</Tabs.Content>
	</Tabs.Root>
</section>
