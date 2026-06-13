<script lang="ts">
	import { X } from '@lucide/svelte';
	import type { Element, Relationship } from '$lib/api/types';
	import {
		closeResultsPanel,
		getCachedElements,
		getCachedRelationships,
		getSearchResults,
		getSearchResultsNote,
		getSearchResultsTarget,
		select
	} from '$lib/state';
	import { elementDisplayName as elementName } from '$lib/util/element-name';

	const results = $derived(getSearchResults());
	const target = $derived(getSearchResultsTarget());
	const note = $derived(getSearchResultsNote());
	const elementsById = $derived(getCachedElements());
	const relationshipsById = $derived(getCachedRelationships());

	type Row =
		| { kind: 'element'; id: string; el: Element }
		| { kind: 'relationship'; id: string; rel: Relationship };

	// Resolve display rows from the cached entities (the search evaluated over
	// exactly these); drop stale ids.
	const rows = $derived.by<Row[]>(() => {
		const out: Row[] = [];
		for (const r of results) {
			if (r.kind === 'element') {
				const el = elementsById.get(r.id);
				if (el) out.push({ kind: 'element', id: r.id, el });
			} else {
				const rel = relationshipsById.get(r.id);
				if (rel) out.push({ kind: 'relationship', id: r.id, rel });
			}
		}
		return out;
	});

	function endpointLabel(id: string): string {
		const el = elementsById.get(id);
		return el ? elementName(el) : id;
	}

	function onPick(row: Row): void {
		select({ kind: row.kind, id: row.id });
	}
</script>

<section
	data-testid="results-panel"
	class="col-span-5 flex h-full flex-col overflow-hidden border-t border-zinc-800 bg-zinc-950"
>
	<header class="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
		<h2 class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
			Results
			<span class="ml-1 font-mono text-zinc-500">({rows.length})</span>
		</h2>
		<span class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
			{target}
		</span>
		{#if note}
			<span class="text-[10px] italic text-amber-300/80">{note}</span>
		{/if}
		<button
			type="button"
			aria-label="Close results"
			class="ml-auto flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
			onclick={() => closeResultsPanel()}
		>
			<X class="h-3.5 w-3.5" />
		</button>
	</header>

	<div class="flex-1 overflow-y-auto">
		{#if rows.length === 0}
			<p class="px-3 py-2 text-xs text-zinc-600">No results.</p>
		{:else}
			<ul class="flex flex-col p-1 text-xs">
				{#each rows as row (row.id)}
					<li>
						<button
							type="button"
							class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
							onclick={() => onPick(row)}
						>
							{#if row.kind === 'element'}
								<span class="truncate text-zinc-200">{elementName(row.el)}</span>
								<span
									class="ml-auto shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400"
								>
									{row.el.type_name}
								</span>
								<span class="shrink-0 font-mono text-[10px] text-zinc-600">{row.id}</span>
							{:else}
								<span class="shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">
									{row.rel.type_name}
								</span>
								<span class="truncate text-zinc-300">
									{endpointLabel(row.rel.source_id)} → {endpointLabel(row.rel.target_id)}
								</span>
								<span class="ml-auto shrink-0 font-mono text-[10px] text-zinc-600">{row.id}</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>
