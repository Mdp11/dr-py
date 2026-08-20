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
	 * **The ARIA combobox pattern**, matched by `Sidebar/Search.svelte` down to
	 * the same attribute set — the two typeaheads are the same widget over
	 * different data, and a screen-reader user meeting one after the other must
	 * not have to learn it twice. Focus STAYS on the input: the active row is
	 * announced through `aria-activedescendant` pointing at its id, which is why
	 * every option carries one and why they are per-instance
	 * (`$props.id()`) rather than hardcoded. `aria-expanded` tracks the dropdown
	 * and `aria-autocomplete="list"` says the list is filtered by what was
	 * typed but never written back into the field.
	 *
	 * The options are plain `<li role="option">`, not buttons: the listbox
	 * pattern forbids interactive descendants inside an option, and a focusable
	 * button inside one would also fight the input for focus. The keyboard lives
	 * entirely on the input, which is the point of the pattern rather than a
	 * shortcut — hence the one a11y suppression on the list, whose justification
	 * is written at its use site.
	 *
	 * Each row highlights the matched substring (spec §6) by splitting
	 * `hit.name` at `matchStart`/`matchLength` — positions `searchTypes` already
	 * computed, so the view never re-derives the match. The three text pieces
	 * are written with NO intervening whitespace in the markup: Svelte renders
	 * template whitespace literally, and a stray newline between them would
	 * inject a space into the middle of the rendered name.
	 *
	 * The `{#each}` key carries the row INDEX ahead of the identity, because a
	 * metamodel draft may legitimately hold two same-named blocks (`mm.elements`
	 * is a plain array and nothing dedupes it) and Svelte throws
	 * `each_key_duplicate` — in prod as well as dev — on a repeated key, which
	 * would take the whole toolbar down on the first query that matched both.
	 * The panel's TOC keys its rows the same way, for the same reason.
	 *
	 * `onReveal` is a test seam: production leaves it unset and the default
	 * routes through `revealSelection` with this component's flow context.
	 */

	let { onReveal }: { onReveal?: (sel: DiagramSelection) => void } = $props();

	const view = $derived(getMetamodelDiagramView());
	const flow = useSvelteFlow();

	/** Per-instance id root. Everything the dropdown needs to name — the listbox
	 * and each option — hangs off it, so two of these mounted at once can never
	 * resolve each other's nodes (the outside-click check below is scoped by
	 * element reference for the same reason). */
	const uid = $props.id();
	const listboxId = `${uid}-listbox`;
	const optionId = (i: number): string => `${uid}-option-${i}`;

	let query = $state('');
	let open = $state(false);
	let active = $state(0);
	let inputEl = $state<HTMLElement | null>(null);
	let dropdownEl = $state<HTMLElement | null>(null);

	const result = $derived(view.mm === null ? { hits: [], total: 0 } : searchTypes(view.mm, query));
	const hits = $derived(result.hits);
	/** How many matches the cap dropped — the "+N more" note's whole content. */
	const overflow = $derived(result.total - hits.length);
	const showDropdown = $derived(open && query.trim() !== '');
	/** Clamped, because the reset effect below runs AFTER the render that a new
	 * query triggers: for that one frame `active` can still sit past the end of a
	 * now-shorter list, and an `aria-activedescendant` naming a row that isn't
	 * there is worse than one frame of the wrong row. `Sidebar/Search.svelte`
	 * clamps for the same reason (its list also refills asynchronously). */
	const activeIndex = $derived(hits.length === 0 ? 0 : Math.min(active, hits.length - 1));

	// New query → the active row resets to the top hit.
	$effect(() => {
		void query;
		active = 0;
	});

	// Keep the active row visible: arrowing past the bottom of a 20-row list
	// scrolls it into view, since focus never moves and the browser therefore
	// never scrolls on its own. `block: 'nearest'` scrolls the minimum needed,
	// so stepping through the middle of the list doesn't jump the container.
	$effect(() => {
		if (!showDropdown) return;
		document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' });
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
		// Tab is a real exit, not just a blur: leaving the toolbar by keyboard
		// used to leave the list floating over the canvas with nothing focused
		// pointing at it. Deliberately NOT prevented — the focus move is the
		// user's intent, closing is only the cleanup that has to ride along.
		if (e.key === 'Tab') {
			open = false;
			return;
		}
		if (!showDropdown || hits.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = (activeIndex + 1) % hits.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = (activeIndex - 1 + hits.length) % hits.length;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			pick(hits[activeIndex]);
		}
	}

	function onDocPointerDown(e: PointerEvent): void {
		if (!open) return;
		const target = e.target as Node | null;
		if (target === null) return;
		if (inputEl !== null && inputEl.contains(target)) return;
		if (dropdownEl !== null && dropdownEl.contains(target)) return;
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
		role="combobox"
		aria-expanded={showDropdown}
		aria-controls={listboxId}
		aria-autocomplete="list"
		aria-activedescendant={showDropdown && hits.length > 0 ? optionId(activeIndex) : undefined}
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
			bind:this={dropdownEl}
			class="absolute left-0 top-full z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded border border-border bg-popover shadow-lg"
		>
			{#if hits.length === 0}
				<!-- Outside the listbox: the empty-state copy is not an option, and an
				     option is the only thing a listbox may contain. -->
				<p class="px-2 py-1 text-xs text-muted-foreground/50">No matches.</p>
			{/if}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<ul
				id={listboxId}
				role="listbox"
				aria-label="Matching types"
				class="flex flex-col gap-0.5 p-1 text-xs"
			>
				{#each hits as hit, i (`${i}:${hit.kind}:${hit.name}`)}
					<!-- The click/pointer handlers sit on the OPTION rather than an inner
					     button because the listbox pattern forbids interactive
					     descendants; the keyboard equivalent is the input's own
					     ↑/↓/Enter, which is where a combobox's keyboard belongs and why
					     the rule above is suppressed rather than satisfied with a key
					     handler on an element that can never hold focus. -->
					<li
						id={optionId(i)}
						role="option"
						aria-selected={i === activeIndex}
						data-testid="mm-search-hit"
						class="flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted {i ===
						activeIndex
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
					</li>
				{/each}
			</ul>
			{#if overflow > 0}
				<!-- The cap stays (the answer to 180 matches is a better query, not a
				     longer list) but it says so. Outside the listbox and not an option:
				     there is nothing here to arrow onto or pick. -->
				<p
					class="border-t border-border px-2 py-1 text-[10px] text-muted-foreground/70"
					data-testid="mm-search-overflow"
				>
					+{overflow} more — keep typing to narrow.
				</p>
			{/if}
		</div>
	{/if}
</div>
