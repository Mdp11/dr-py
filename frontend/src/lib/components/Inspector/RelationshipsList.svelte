<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { Element, Relationship } from '$lib/api/types';
	import { emit, getIssues, getWorkingModel, indexIssues, select } from '$lib/state';
	import { AlertCircle, AlertTriangle, Pencil, X } from '@lucide/svelte';

	type Props = {
		elementId: string;
	};

	let { elementId }: Props = $props();

	const working = $derived(getWorkingModel());
	const issueIndex = $derived(indexIssues(getIssues()));

	const outgoing = $derived(working.relationships.filter((r) => r.source_id === elementId));
	const incoming = $derived(working.relationships.filter((r) => r.target_id === elementId));

	type Group = { type_name: string; items: Relationship[] };

	function groupByType(rels: Relationship[]): Group[] {
		const map = new SvelteMap<string, Relationship[]>();
		for (const r of rels) {
			const arr = map.get(r.type_name);
			if (arr) arr.push(r);
			else map.set(r.type_name, [r]);
		}
		return Array.from(map.entries())
			.map(([type_name, items]) => ({ type_name, items }))
			.sort((a, b) => a.type_name.localeCompare(b.type_name));
	}

	const outgoingGroups = $derived(groupByType(outgoing));
	const incomingGroups = $derived(groupByType(incoming));

	function findElement(id: string): Element | null {
		return working.elements.find((e) => e.id === id) ?? null;
	}

	function displayName(el: Element | null, fallbackId: string): string {
		if (el === null) return fallbackId;
		const n = el.properties?.name;
		return typeof n === 'string' && n.length > 0 ? n : el.id;
	}

	let outgoingOpen = $state(true);
	let incomingOpen = $state(true);
	// SvelteSet is reactive on its own; mutate in place (no `$state` wrapper).
	const collapsedGroups = new SvelteSet<string>();

	function groupKey(direction: 'out' | 'in', type_name: string): string {
		return `${direction}:${type_name}`;
	}

	function toggleGroup(direction: 'out' | 'in', type_name: string): void {
		const key = groupKey(direction, type_name);
		if (collapsedGroups.has(key)) collapsedGroups.delete(key);
		else collapsedGroups.add(key);
	}

	function isGroupOpen(direction: 'out' | 'in', type_name: string): boolean {
		return !collapsedGroups.has(groupKey(direction, type_name));
	}

	function navigateTo(id: string): void {
		select({ kind: 'element', id });
	}

	function editRelationship(id: string): void {
		select({ kind: 'relationship', id });
	}

	function disconnect(id: string): void {
		emit({ kind: 'delete_relationship', id });
	}
</script>

{#snippet groupBlock(direction: 'out' | 'in', group: Group)}
	{@const arrow = direction === 'out' ? '→' : '←'}
	{@const open = isGroupOpen(direction, group.type_name)}
	<div class="flex flex-col">
		<button
			type="button"
			class="flex items-center gap-1 py-0.5 text-left text-[11px] font-medium text-zinc-300 hover:text-zinc-100"
			onclick={() => toggleGroup(direction, group.type_name)}
		>
			<span class="font-mono text-[10px] text-zinc-500">{open ? '▾' : '▸'}</span>
			<span>{group.type_name}</span>
			<span class="text-zinc-500">({group.items.length})</span>
		</button>
		{#if open}
			<ul class="flex flex-col">
				{#each group.items as rel (rel.id)}
					{@const otherId = direction === 'out' ? rel.target_id : rel.source_id}
					{@const other = findElement(otherId)}
					<li class="group/row flex items-center gap-1 py-0.5 pl-3 pr-1 hover:bg-zinc-900">
						<span class="font-mono text-[10px] text-zinc-500">{arrow}</span>
						<button
							type="button"
							class="flex flex-1 items-center gap-1 truncate rounded text-left text-[11px] text-zinc-200 hover:text-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
							onclick={() => navigateTo(otherId)}
							title={otherId}
						>
							<span class="truncate">{displayName(other, otherId)}</span>
							{#if other !== null}
								<span class="shrink-0 rounded bg-zinc-800 px-1 font-mono text-[9px] text-zinc-400">
									{other.type_name}
								</span>
							{/if}
							{#if issueIndex.errorIds.has(rel.id) || issueIndex.errorIds.has(otherId)}
								<AlertCircle class="h-3 w-3 shrink-0 text-red-400" />
							{:else if issueIndex.warningIds.has(rel.id) || issueIndex.warningIds.has(otherId)}
								<AlertTriangle class="h-3 w-3 shrink-0 text-amber-400" />
							{/if}
						</button>
						<button
							type="button"
							class="rounded p-0.5 text-zinc-500 opacity-0 hover:text-zinc-200 group-hover/row:opacity-100"
							onclick={() => editRelationship(rel.id)}
							aria-label="Edit relationship"
							title="Edit relationship properties"
						>
							<Pencil class="h-3 w-3" />
						</button>
						<button
							type="button"
							class="rounded p-0.5 text-zinc-500 opacity-0 hover:text-red-400 group-hover/row:opacity-100"
							onclick={() => disconnect(rel.id)}
							aria-label="Disconnect relationship"
							title="Disconnect"
						>
							<X class="h-3 w-3" />
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/snippet}

<div class="flex flex-col gap-2">
	<div class="flex flex-col">
		<button
			type="button"
			class="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200"
			onclick={() => (outgoingOpen = !outgoingOpen)}
		>
			<span class="font-mono">{outgoingOpen ? '▾' : '▸'}</span>
			<span>Outgoing</span>
			<span class="text-zinc-500">({outgoing.length})</span>
		</button>
		{#if outgoingOpen}
			{#if outgoingGroups.length === 0}
				<p class="pl-3 text-[11px] italic text-zinc-500">(none)</p>
			{:else}
				<div class="mt-1 flex flex-col gap-1">
					{#each outgoingGroups as g (g.type_name)}
						{@render groupBlock('out', g)}
					{/each}
				</div>
			{/if}
		{/if}
	</div>

	<div class="flex flex-col">
		<button
			type="button"
			class="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 hover:text-zinc-200"
			onclick={() => (incomingOpen = !incomingOpen)}
		>
			<span class="font-mono">{incomingOpen ? '▾' : '▸'}</span>
			<span>Incoming</span>
			<span class="text-zinc-500">({incoming.length})</span>
		</button>
		{#if incomingOpen}
			{#if incomingGroups.length === 0}
				<p class="pl-3 text-[11px] italic text-zinc-500">(none)</p>
			{:else}
				<div class="mt-1 flex flex-col gap-1">
					{#each incomingGroups as g (g.type_name)}
						{@render groupBlock('in', g)}
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>
