<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import {
		getSearchText,
		seedElements,
		select,
		setSearchDialogOpen,
		setSearchText
	} from '$lib/state';
	import { listElementsPage } from '$lib/api/model-read';
	import type { Element } from '$lib/api/types';
	import { SlidersHorizontal } from '@lucide/svelte';
	import AdvancedSearchDialog from './AdvancedSearchDialog.svelte';

	const MAX_RESULTS = 50;
	const DEBOUNCE_MS = 250;

	const searchText = $derived(getSearchText());

	let isOpen = $state(false);
	let inputEl = $state<HTMLElement | null>(null);

	// Server-side search: GET /model/elements?q=... ranks by the same score
	// the old client loop used. Debounced; out-of-order responses dropped.
	let results: Element[] = $state([]);
	let searching = $state(false);
	let requestSeq = 0;

	function elementDisplayName(el: Element): string {
		const n = el.properties?.name;
		return typeof n === 'string' && n.length > 0 ? n : el.id;
	}

	$effect(() => {
		const q = searchText.trim();
		const seq = ++requestSeq;
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
					if (seq !== requestSeq) return; // stale response
					seedElements(page.items);
					results = page.items;
				} catch {
					if (seq !== requestSeq) return;
					results = [];
				} finally {
					if (seq === requestSeq) searching = false;
				}
			})();
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	const showDropdown = $derived(isOpen && searchText.trim() !== '');

	function onInput(e: Event): void {
		setSearchText((e.currentTarget as HTMLInputElement).value);
		isOpen = true;
	}

	function onFocusOrClick(): void {
		if (searchText.trim() !== '') isOpen = true;
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			isOpen = false;
			(e.currentTarget as HTMLInputElement).blur();
		}
	}

	function onPick(id: string): void {
		select({ kind: 'element', id });
		isOpen = false;
	}

	function onDocPointerDown(e: PointerEvent): void {
		if (!isOpen) return;
		const target = e.target as Node | null;
		if (!target) return;
		if (inputEl && inputEl.contains(target)) return;
		const dropdown = document.getElementById('sidebar-search-dropdown');
		if (dropdown && dropdown.contains(target)) return;
		isOpen = false;
	}

	$effect(() => {
		document.addEventListener('pointerdown', onDocPointerDown);
		return () => document.removeEventListener('pointerdown', onDocPointerDown);
	});
</script>

<section class="relative flex flex-col gap-2 px-3 py-2">
	<h2 class="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Search</h2>
	<div class="flex items-center gap-1">
		<Input
			bind:ref={inputEl}
			type="text"
			placeholder="Filter by name, type, id…"
			value={searchText}
			oninput={onInput}
			onfocus={onFocusOrClick}
			onclick={onFocusOrClick}
			onkeydown={onKeydown}
			class="h-7 flex-1 border-zinc-800 bg-zinc-900 text-xs placeholder:text-zinc-600"
		/>
		<button
			type="button"
			data-testid="advanced-search-button"
			aria-label="Advanced search"
			class="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
			onclick={() => setSearchDialogOpen(true)}
		>
			<SlidersHorizontal class="h-3.5 w-3.5" />
		</button>
	</div>
	{#if showDropdown}
		<div
			id="sidebar-search-dropdown"
			class="absolute left-3 right-3 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 shadow-lg"
		>
			<ul class="flex flex-col gap-0.5 p-1 text-xs">
				{#if results.length === 0}
					<li class="px-1 py-0.5 text-zinc-600">
						{searching ? 'Searching…' : 'No matches.'}
					</li>
				{:else}
					{#each results as el (el.id)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
								onclick={() => onPick(el.id)}
							>
								<span class="truncate text-zinc-200">{elementDisplayName(el)}</span>
								<span
									class="ml-auto shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400"
								>
									{el.type_name}
								</span>
								<span class="shrink-0 font-mono text-[10px] text-zinc-600">{el.id}</span>
							</button>
						</li>
					{/each}
				{/if}
			</ul>
		</div>
	{/if}
	<AdvancedSearchDialog />
</section>
