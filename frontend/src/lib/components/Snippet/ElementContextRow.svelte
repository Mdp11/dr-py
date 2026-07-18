<script lang="ts">
	// Shown only for `value`/`step` entry points, which need a bound element.
	// A "use current selection" shortcut plus a tiny debounced search — this
	// is a component-local micro-search (see Navigation/ElementStartPicker.svelte
	// for the same debounce shape), not a store: nothing here outlives the row.
	import {
		getCachedElements,
		getSelection,
		getSnippetRun,
		setSnippetElementContext
	} from '$lib/state';
	import { listElementsPage } from '$lib/api/model-read';
	import { elementDisplayName } from '$lib/util/element-name';
	import type { Element } from '$lib/api/types';

	const MAX_RESULTS = 8;
	const DEBOUNCE_MS = 250;

	let { tabId }: { tabId: string } = $props();

	const run = $derived(getSnippetRun(tabId));
	const selection = $derived(getSelection());
	const canUseSelection = $derived(selection?.kind === 'element');

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

	function useSelection(): void {
		if (!selection || selection.kind !== 'element') return;
		const el = getCachedElements().get(selection.id);
		if (!el) return;
		setSnippetElementContext(tabId, el.id, elementDisplayName(el));
	}

	function pick(el: Element): void {
		setSnippetElementContext(tabId, el.id, elementDisplayName(el));
		query = '';
		results = [];
	}
</script>

<div class="relative flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
	<span class="text-muted-foreground">Element:</span>
	<span class="font-mono text-foreground/90">{run.elementLabel ?? 'no element bound'}</span>
	<button
		type="button"
		class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
		disabled={!canUseSelection}
		onclick={useSelection}
	>
		Use current selection
	</button>
	<div class="relative">
		<input
			data-testid="snippet-element-search"
			class="w-48 rounded border border-input bg-card px-2 py-1 text-xs"
			placeholder="Search elements…"
			value={query}
			oninput={(e) => (query = e.currentTarget.value)}
		/>
		{#if query.trim() !== ''}
			<ul
				class="absolute left-0 top-full z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded border border-border bg-popover shadow-lg"
			>
				{#if results.length === 0}
					<li class="px-2 py-1 text-muted-foreground/50">
						{searching ? 'Searching…' : 'No matches.'}
					</li>
				{:else}
					{#each results as el (el.id)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-2 px-2 py-1 text-left transition-colors hover:bg-muted"
								onclick={() => pick(el)}
							>
								<span class="truncate text-foreground/90">{elementDisplayName(el)}</span>
								<span
									class="ml-auto shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
								>
									{el.type_name}
								</span>
							</button>
						</li>
					{/each}
				{/if}
			</ul>
		{/if}
	</div>
</div>
