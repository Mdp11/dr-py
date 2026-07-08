<script lang="ts">
	// Debounced element typeahead for a Path's "specific element" start mode.
	// Mirrors Sidebar/Search.svelte's query -> listElementsPage debounce and
	// its element-name derivation (elementDisplayName over the case-insensitive
	// `name` property, falling back to id).
	import { getElementsBatch, listElementsPage } from '$lib/api/model-read';
	import type { Element } from '$lib/api/types';
	import { elementDisplayName } from '$lib/util/element-name';

	const MAX_RESULTS = 20;
	const DEBOUNCE_MS = 250;

	let { value, onPick }: { value: string | null; onPick: (id: string, label: string) => void } =
		$props();

	let query = $state('');
	let results: Element[] = $state([]);
	let searching = $state(false);
	let searchSeq = 0;

	$effect(() => {
		const q = query.trim();
		const seq = ++searchSeq;
		if (q === '') {
			results = [];
			searching = false;
			return;
		}
		searching = true;
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const page = await listElementsPage({ q, limit: MAX_RESULTS });
					if (seq !== searchSeq) return; // stale response
					results = page.items;
				} catch {
					if (seq !== searchSeq) return;
					results = [];
				} finally {
					if (seq === searchSeq) searching = false;
				}
			})();
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	// Resolve the picked id's display name/type for the chip. A late resolve
	// for a superseded id must not overwrite a newer pick — same generation
	// discipline as the search above.
	let resolved: Element | null = $state(null);
	let resolveSeq = 0;

	$effect(() => {
		const id = value;
		const seq = ++resolveSeq;
		if (!id) {
			resolved = null;
			return;
		}
		void (async () => {
			try {
				const [el] = await getElementsBatch([id]);
				if (seq !== resolveSeq) return;
				resolved = el ?? null;
			} catch {
				if (seq !== resolveSeq) return;
				resolved = null;
			}
		})();
	});

	function pick(el: Element): void {
		onPick(el.id, elementDisplayName(el));
		query = '';
		results = [];
	}

	function changeElement(): void {
		onPick('', '');
	}
</script>

<div class="space-y-1.5 rounded border border-zinc-800 bg-zinc-900/40 p-2">
	<span class="text-xs font-medium text-zinc-400">Start element</span>
	{#if value}
		<div class="flex items-center gap-2 text-xs">
			<span class="truncate text-zinc-200">{resolved ? elementDisplayName(resolved) : value}</span>
			{#if resolved}
				<span class="shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400"
					>{resolved.type_name}</span
				>
			{/if}
			<span class="shrink-0 font-mono text-[10px] text-zinc-600">{value}</span>
			<button
				type="button"
				class="ml-auto shrink-0 text-sky-500 hover:text-sky-300"
				onclick={changeElement}>change</button
			>
		</div>
	{:else}
		<input
			type="text"
			placeholder="Search elements…"
			value={query}
			oninput={(e) => (query = (e.currentTarget as HTMLInputElement).value)}
			class="w-full rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs"
		/>
		{#if query.trim() !== ''}
			<ul class="max-h-40 space-y-0.5 overflow-y-auto text-xs">
				{#if results.length === 0}
					<li class="px-1 py-0.5 text-zinc-600">{searching ? 'Searching…' : 'No matches.'}</li>
				{:else}
					{#each results as el (el.id)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-800"
								onclick={() => pick(el)}
							>
								<span class="truncate text-zinc-200">{elementDisplayName(el)}</span>
								<span
									class="ml-auto shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400"
									>{el.type_name}</span
								>
								<span class="shrink-0 font-mono text-[10px] text-zinc-600">{el.id}</span>
							</button>
						</li>
					{/each}
				{/if}
			</ul>
		{/if}
	{/if}
</div>
