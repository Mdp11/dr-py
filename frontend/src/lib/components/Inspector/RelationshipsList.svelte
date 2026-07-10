<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { Element, Issue, Relationship } from '$lib/api/types';
	import {
		emit,
		ensureElement,
		getCachedElements,
		getCachedRelationships,
		getIssuesByOwner,
		getModelGeneration,
		getStructureRev,
		indexIssues,
		seedElements,
		seedRelationships,
		select
	} from '$lib/state';
	import { deleteLock } from '$lib/state/edit-gate';
	import { listElementRelationships } from '$lib/api/model-read';
	import { nameProp } from '$lib/util/element-name';
	import { AlertCircle, AlertTriangle, Pencil, X } from '@lucide/svelte';

	type Props = {
		elementId: string;
	};

	let { elementId }: Props = $props();

	const elements = $derived(getCachedElements());
	const relationships = $derived(getCachedRelationships());

	// Issues come from the store's issue mirror (kept exact by ops deltas and
	// full validateAll runs), indexed over every target id like before.
	const issueIndex = $derived.by(() => {
		const all: Issue[] = [];
		for (const issues of getIssuesByOwner().values()) all.push(...issues);
		return indexIssues(all);
	});

	// Seed policy: fetch this element's incident-relationship page on mount and
	// after every STRUCTURAL acked delta (structureRev bump — property-only
	// acks while typing don't refetch); the LIST itself derives from the
	// reactive cache so optimistic emits (new/deleted relationships) show
	// instantly, before the server acks.
	const PAGE_LIMIT = 500;
	let fetchedTotal: number | null = $state(null);
	let fetchSeq = 0;

	$effect(() => {
		const id = elementId;
		void getStructureRev();
		void getModelGeneration(); // model swap with an equal rev still refetches
		const seq = ++fetchSeq;
		void (async () => {
			try {
				const page = await listElementRelationships(id, { direction: 'both', limit: PAGE_LIMIT });
				if (seq !== fetchSeq) return;
				seedRelationships(page.items);
				fetchedTotal = page.total;
				// other-endpoint display names: fetch the elements we don't have yet
				const missing = new SvelteSet<string>();
				for (const r of page.items) {
					if (!elements.has(r.source_id)) missing.add(r.source_id);
					if (!elements.has(r.target_id)) missing.add(r.target_id);
				}
				const fetched = await Promise.all([...missing].map((mid) => ensureElement(mid)));
				if (seq !== fetchSeq) return;
				seedElements(fetched.filter((e): e is Element => e !== null));
			} catch {
				if (seq === fetchSeq) fetchedTotal = null;
			}
		})();
	});

	const outgoing = $derived([...relationships.values()].filter((r) => r.source_id === elementId));
	const incoming = $derived([...relationships.values()].filter((r) => r.target_id === elementId));
	const truncated = $derived(
		fetchedTotal !== null && fetchedTotal > PAGE_LIMIT ? fetchedTotal : null
	);

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
		return elements.get(id) ?? null;
	}

	function displayName(el: Element | null, fallbackId: string): string {
		if (el === null) return fallbackId;
		return nameProp(el.properties) ?? el.id;
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

	async function disconnect(id: string, sourceId: string): Promise<void> {
		if (!(await deleteLock(sourceId))) return;
		emit({ kind: 'delete_relationship', id });
	}
</script>

{#snippet groupBlock(direction: 'out' | 'in', group: Group)}
	{@const roleLabel = direction === 'out' ? 'to' : 'from'}
	{@const open = isGroupOpen(direction, group.type_name)}
	<div class="flex flex-col">
		<button
			type="button"
			class="flex items-center gap-1 py-0.5 text-left text-[11px] font-medium text-foreground/80 hover:text-foreground"
			onclick={() => toggleGroup(direction, group.type_name)}
		>
			<span class="font-mono text-[10px] text-muted-foreground/70">{open ? '▾' : '▸'}</span>
			<span>{group.type_name}</span>
			<span class="text-muted-foreground/70">({group.items.length})</span>
		</button>
		{#if open}
			<ul class="flex flex-col">
				{#each group.items as rel (rel.id)}
					{@const otherId = direction === 'out' ? rel.target_id : rel.source_id}
					{@const other = findElement(otherId)}
					<li class="group/row flex items-center gap-1 py-0.5 pl-3 pr-1 hover:bg-muted">
						<span class="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
							>{roleLabel}</span
						>
						<button
							type="button"
							class="flex flex-1 items-center gap-1 truncate rounded text-left text-[11px] text-foreground/90 hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onclick={() => navigateTo(otherId)}
							title={otherId}
						>
							<span class="truncate">{displayName(other, otherId)}</span>
							{#if other !== null}
								<span
									class="shrink-0 rounded bg-muted px-1 font-mono text-[9px] text-muted-foreground"
								>
									{other.type_name}
								</span>
							{/if}
							{#if issueIndex.errorIds.has(rel.id) || issueIndex.errorIds.has(otherId)}
								<AlertCircle class="h-3 w-3 shrink-0 text-destructive" />
							{:else if issueIndex.warningIds.has(rel.id) || issueIndex.warningIds.has(otherId)}
								<AlertTriangle class="h-3 w-3 shrink-0 text-warning" />
							{/if}
						</button>
						<button
							type="button"
							class="rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover/row:opacity-100"
							onclick={() => editRelationship(rel.id)}
							aria-label="Edit relationship"
							title="Edit relationship properties"
						>
							<Pencil class="h-3 w-3" />
						</button>
						<button
							type="button"
							class="rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover/row:opacity-100"
							onclick={() => void disconnect(rel.id, rel.source_id)}
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
	{#if truncated !== null}
		<p class="text-[10px] italic text-muted-foreground/70">
			Showing the first {PAGE_LIMIT} of {truncated} relationships.
		</p>
	{/if}
	<div class="flex flex-col">
		<button
			type="button"
			class="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
			onclick={() => (outgoingOpen = !outgoingOpen)}
		>
			<span class="font-mono">{outgoingOpen ? '▾' : '▸'}</span>
			<span>Outgoing</span>
			<span class="text-muted-foreground/70">({outgoing.length})</span>
		</button>
		{#if outgoingOpen}
			{#if outgoingGroups.length === 0}
				<p class="pl-3 text-[11px] italic text-muted-foreground/70">(none)</p>
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
			class="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
			onclick={() => (incomingOpen = !incomingOpen)}
		>
			<span class="font-mono">{incomingOpen ? '▾' : '▸'}</span>
			<span>Incoming</span>
			<span class="text-muted-foreground/70">({incoming.length})</span>
		</button>
		{#if incomingOpen}
			{#if incomingGroups.length === 0}
				<p class="pl-3 text-[11px] italic text-muted-foreground/70">(none)</p>
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
