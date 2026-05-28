<script lang="ts">
	import {
		createTempId,
		emit,
		getMetamodel,
		getTypeFilter,
		getWorkingModel,
		select,
		toggleType
	} from '$lib/state';
	import { Plus } from '@lucide/svelte';

	const mm = $derived(getMetamodel());
	const working = $derived(getWorkingModel());
	const typeFilter = $derived(getTypeFilter());

	const countsByType = $derived.by(() => {
		const m = new Map<string, number>();
		for (const el of working.elements) {
			m.set(el.type_name, (m.get(el.type_name) ?? 0) + 1);
		}
		return m;
	});

	function onCreateElement(typeName: string): void {
		const tempId = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tempId,
			type_name: typeName,
			properties: {}
		});
		select({ kind: 'element', id: tempId });
	}
</script>

<section class="flex flex-col gap-1 px-3 py-2">
	<h2 class="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Types</h2>
	{#if mm === null}
		<p class="text-xs text-zinc-600">No metamodel loaded.</p>
	{:else if mm.elements.length === 0}
		<p class="text-xs text-zinc-600">No element types defined.</p>
	{:else}
		<ul class="flex flex-col gap-0.5 text-xs">
			{#each mm.elements as et (et.name)}
				{@const count = countsByType.get(et.name) ?? 0}
				{@const checked = typeFilter.has(et.name)}
				{#if et.abstract}
					<li
						class="flex items-center gap-2 px-1 py-0.5 italic text-zinc-600"
						title="Abstract type — not selectable"
					>
						<span class="inline-block h-3 w-3 shrink-0" aria-hidden="true"></span>
						<span class="truncate">{et.name}</span>
						<span class="ml-auto font-mono text-[10px]">({count})</span>
					</li>
				{:else}
					<li class="group flex items-center gap-1">
						<label
							class="flex flex-1 cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-800"
						>
							<input
								type="checkbox"
								class="h-3 w-3 shrink-0 accent-zinc-300"
								{checked}
								onchange={() => toggleType(et.name)}
							/>
							<span class="truncate text-zinc-200">{et.name}</span>
							<span class="ml-auto font-mono text-[10px] text-zinc-500">({count})</span>
						</label>
						<button
							type="button"
							class="shrink-0 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-indigo-500"
							aria-label={`New ${et.name}`}
							title={`New ${et.name}`}
							onclick={() => onCreateElement(et.name)}
						>
							<Plus class="h-3 w-3" />
						</button>
					</li>
				{/if}
			{/each}
		</ul>
	{/if}
</section>
