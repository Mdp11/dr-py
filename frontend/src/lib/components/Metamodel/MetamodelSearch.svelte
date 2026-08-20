<script lang="ts">
	import { useSvelteFlow } from '@xyflow/svelte';

	import type { DiagramSelection } from '$lib/metamodel/diagram-build';
	import { searchTypes, type TypeSearchHit } from '$lib/metamodel/diagram-search';
	import { getMetamodelDiagramView } from '$lib/state';

	import { revealSelection } from './reveal-action';

	/**
	 * The toolbar typeahead (spec 2026-08-20 §6): substring match over element
	 * types, relationship types and enums, keyboard-driven (↑/↓/Enter/Esc), and
	 * on pick the canvas navigates through the shared `revealSelection` action.
	 * Mirrors `Sidebar/Search.svelte`'s dropdown treatment, minus the debounce
	 * and staleness protocol — this search is pure client-side over the parsed
	 * draft, so results are synchronous. It is also a READ affordance available
	 * to every role (spec's viewer-can-navigate stance): it never consults
	 * `readOnly` or `getRole()`, only `getMetamodelDiagramView()`.
	 *
	 * Each row highlights the matched substring (spec §6) by splitting
	 * `hit.name` at `matchStart`/`matchLength` — positions `searchTypes` already
	 * computed, so the view never re-derives the match. The three text pieces
	 * are written with NO intervening whitespace in the markup: Svelte renders
	 * template whitespace literally, and a stray newline between them would
	 * inject a space into the middle of the rendered name.
	 *
	 * `onReveal` is a test seam: production leaves it unset and the default
	 * routes through `revealSelection` with this component's flow context.
	 */

	let { onReveal }: { onReveal?: (sel: DiagramSelection) => void } = $props();

	const view = $derived(getMetamodelDiagramView());
	const flow = useSvelteFlow();

	let query = $state('');
	let open = $state(false);
	let active = $state(0);
	let inputEl = $state<HTMLElement | null>(null);

	const hits = $derived(view.mm === null ? [] : searchTypes(view.mm, query));
	const showDropdown = $derived(open && query.trim() !== '');

	// New query → the active row resets to the top hit.
	$effect(() => {
		void query;
		active = 0;
	});

	const KIND_BADGE: Record<TypeSearchHit['kind'], string> = {
		element: 'type',
		relationship: 'rel',
		enum: 'enum'
	};

	function pick(hit: TypeSearchHit): void {
		(onReveal ?? ((sel: DiagramSelection) => revealSelection(flow, view, sel)))(hit.sel);
		query = '';
		open = false;
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			open = false;
			return;
		}
		if (!showDropdown || hits.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = (active + 1) % hits.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = (active - 1 + hits.length) % hits.length;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			pick(hits[Math.min(active, hits.length - 1)]);
		}
	}

	function onDocPointerDown(e: PointerEvent): void {
		if (!open) return;
		const target = e.target as Node | null;
		if (target === null) return;
		if (inputEl !== null && inputEl.contains(target)) return;
		const dropdown = document.getElementById('mm-search-dropdown');
		if (dropdown !== null && dropdown.contains(target)) return;
		open = false;
	}

	$effect(() => {
		document.addEventListener('pointerdown', onDocPointerDown);
		return () => document.removeEventListener('pointerdown', onDocPointerDown);
	});
</script>

<div class="relative">
	<input
		bind:this={inputEl}
		class="rounded bg-card px-2 py-1 text-xs text-foreground"
		data-testid="mm-search-input"
		aria-label="Find a type"
		placeholder="Find type…"
		value={query}
		oninput={(e) => {
			query = (e.currentTarget as HTMLInputElement).value;
			open = true;
		}}
		onfocus={() => {
			if (query.trim() !== '') open = true;
		}}
		onkeydown={onKeydown}
	/>
	{#if showDropdown}
		<div
			id="mm-search-dropdown"
			class="absolute left-0 top-full z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded border border-border bg-popover shadow-lg"
		>
			<ul class="flex flex-col gap-0.5 p-1 text-xs">
				{#if hits.length === 0}
					<li class="px-1 py-0.5 text-muted-foreground/50">No matches.</li>
				{:else}
					{#each hits as hit, i (`${hit.kind}:${hit.name}`)}
						<li>
							<button
								type="button"
								data-testid="mm-search-hit"
								class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted {i ===
								active
									? 'bg-muted'
									: ''}"
								onpointerenter={() => (active = i)}
								onclick={() => pick(hit)}
							>
								<span class="truncate text-foreground/90"
									>{hit.name.slice(0, hit.matchStart)}<mark
										class="bg-transparent font-semibold text-foreground"
										data-testid="mm-search-match"
										>{hit.name.slice(hit.matchStart, hit.matchStart + hit.matchLength)}</mark
									>{hit.name.slice(hit.matchStart + hit.matchLength)}</span
								>
								{#if hit.mapless}
									<span class="shrink-0 text-[10px] text-muted-foreground/70">no mappings</span>
								{/if}
								<span
									class="ml-auto shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
								>
									{KIND_BADGE[hit.kind]}
								</span>
							</button>
						</li>
					{/each}
				{/if}
			</ul>
		</div>
	{/if}
</div>
