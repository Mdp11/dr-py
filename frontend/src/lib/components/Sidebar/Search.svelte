<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import {
		getSearchText,
		getWorkingModel,
		select,
		setSearchText
	} from '$lib/state';
	import type { Element } from '$lib/api/types';

	type ScoredHit = { el: Element; score: number; displayName: string };

	const MAX_RESULTS = 50;

	const searchText = $derived(getSearchText());
	const working = $derived(getWorkingModel());

	let isOpen = $state(false);
	let inputEl = $state<HTMLElement | null>(null);

	function elementDisplayName(el: Element): string {
		const n = el.properties?.name;
		return typeof n === 'string' && n.length > 0 ? n : el.id;
	}

	const results = $derived.by<ScoredHit[]>(() => {
		const q = searchText.trim().toLowerCase();
		if (q === '') return [];
		const hits: ScoredHit[] = [];
		for (const el of working.elements) {
			let score = 0;
			const nameVal = el.properties?.name;
			const nameStr = typeof nameVal === 'string' ? nameVal : null;
			if (nameStr && nameStr.toLowerCase().includes(q)) score += 2;
			if (el.id.toLowerCase().includes(q)) score += 1;
			if (el.type_name.toLowerCase().includes(q)) score += 1;
			for (const [k, v] of Object.entries(el.properties ?? {})) {
				if (k === 'name') continue;
				if (typeof v === 'string' && v.toLowerCase().includes(q)) score += 0.5;
			}
			if (score > 0) hits.push({ el, score, displayName: elementDisplayName(el) });
		}
		hits.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.el.id.localeCompare(b.el.id);
		});
		return hits.slice(0, MAX_RESULTS);
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
	<Input
		bind:ref={inputEl}
		type="text"
		placeholder="Filter by name, type, id…"
		value={searchText}
		oninput={onInput}
		onfocus={onFocusOrClick}
		onclick={onFocusOrClick}
		onkeydown={onKeydown}
		class="h-7 border-zinc-800 bg-zinc-900 text-xs placeholder:text-zinc-600"
	/>
	{#if showDropdown}
		<div
			id="sidebar-search-dropdown"
			class="absolute left-3 right-3 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 shadow-lg"
		>
			<ul class="flex flex-col gap-0.5 p-1 text-xs">
				{#if results.length === 0}
					<li class="px-1 py-0.5 text-zinc-600">No matches.</li>
				{:else}
					{#each results as r (r.el.id)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
								onclick={() => onPick(r.el.id)}
							>
								<span class="truncate text-zinc-200">{r.displayName}</span>
								<span class="ml-auto shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">
									{r.el.type_name}
								</span>
								<span class="shrink-0 font-mono text-[10px] text-zinc-600">{r.el.id}</span>
							</button>
						</li>
					{/each}
				{/if}
			</ul>
		</div>
	{/if}
</section>
