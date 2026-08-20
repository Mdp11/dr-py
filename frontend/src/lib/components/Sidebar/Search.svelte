<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import {
		getSearchText,
		getView,
		seedElements,
		select,
		setSearchDialogOpen,
		setSearchText
	} from '$lib/state';
	import { beginDrag } from '$lib/state/tree-drag.svelte';
	import { listElementsPage } from '$lib/api/model-read';
	import type { Element } from '$lib/api/types';
	import { SlidersHorizontal } from '@lucide/svelte';
	import { elementDisplayName } from '$lib/util/element-name';
	import AdvancedSearchDialog from './AdvancedSearchDialog.svelte';

	/**
	 * The sidebar element typeahead. Server-backed (debounced, out-of-order
	 * responses dropped), unlike the metamodel tab's type search — but the two
	 * are the same WIDGET, and `Metamodel/MetamodelSearch.svelte` carries the
	 * fuller note on the ARIA combobox pattern they now share: focus stays on
	 * the input, the active row is announced via `aria-activedescendant`, and
	 * the options are non-interactive `<li role="option">` because the listbox
	 * pattern forbids interactive descendants inside an option. Fixing one of
	 * the two would have left the app teaching the same widget twice.
	 *
	 * Keyboard: ↑/↓ move the active row, Enter selects it, Escape closes and
	 * blurs, Tab closes on the way out so the list is not left floating over the
	 * tree with nothing focused pointing at it.
	 */
	const MAX_RESULTS = 50;
	const DEBOUNCE_MS = 250;

	const searchText = $derived(getSearchText());

	let isOpen = $state(false);
	let inputEl = $state<HTMLElement | null>(null);
	let dropdownEl = $state<HTMLElement | null>(null);
	let active = $state(0);

	/** Per-instance id root for the listbox and its options — `aria-*` wiring
	 * must resolve THIS instance's nodes, never a second one's. */
	const uid = $props.id();
	const listboxId = `${uid}-listbox`;
	const optionId = (i: number): string => `${uid}-option-${i}`;

	// Server-side search: GET /model/elements?q=... ranks by the same score
	// the old client loop used. Debounced; out-of-order responses dropped.
	let results: Element[] = $state([]);
	let searching = $state(false);
	let requestSeq = 0;

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
	/** Clamped for the window between a new result page landing and the active
	 * row being reset — a shorter page must never leave `active` past its end. */
	const activeIndex = $derived(results.length === 0 ? 0 : Math.min(active, results.length - 1));

	// A new query starts back at the top hit.
	$effect(() => {
		void searchText;
		active = 0;
	});

	// Focus never moves off the input, so nothing scrolls the active row into
	// view on its own once the list is longer than its 288px max height.
	$effect(() => {
		if (!showDropdown) return;
		document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' });
	});

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
			return;
		}
		// Not prevented: the focus move is what the user asked for, closing is
		// only the cleanup riding along with it.
		if (e.key === 'Tab') {
			isOpen = false;
			return;
		}
		if (!showDropdown || results.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = (activeIndex + 1) % results.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = (activeIndex - 1 + results.length) % results.length;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			onPick(results[activeIndex].id);
		}
	}

	function onPick(id: string): void {
		select({ kind: 'element', id });
		isOpen = false;
	}

	const DRAG_THRESHOLD_PX = 4;
	function onResultPointerDown(e: PointerEvent, id: string): void {
		if (e.button !== 0 || !e.isPrimary) return;
		if (getView() === null) return; // no active view => nowhere to drop; plain click
		const sx = e.clientX;
		const sy = e.clientY;
		let started = false;
		const move = (ev: PointerEvent): void => {
			if (started) return;
			if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX) return;
			started = true;
			beginDrag({ kind: 'element', ids: [id] }, true); // bypassMovable: search element
			cleanup();
		};
		const up = (): void => cleanup();
		function cleanup(): void {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
		}
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
	}

	function onDocPointerDown(e: PointerEvent): void {
		if (!isOpen) return;
		const target = e.target as Node | null;
		if (!target) return;
		if (inputEl && inputEl.contains(target)) return;
		// The bound reference, not a document-wide id lookup: an id is a global
		// name and would cross-match the moment a second search mounted.
		if (dropdownEl && dropdownEl.contains(target)) return;
		isOpen = false;
	}

	$effect(() => {
		document.addEventListener('pointerdown', onDocPointerDown);
		return () => document.removeEventListener('pointerdown', onDocPointerDown);
	});
</script>

<section class="relative flex flex-col gap-2 px-3 py-2">
	<h2 class="microlabel">Search</h2>
	<div class="flex items-center gap-1">
		<Input
			bind:ref={inputEl}
			type="text"
			placeholder="Filter by name, type, id…"
			role="combobox"
			aria-expanded={showDropdown}
			aria-controls={listboxId}
			aria-autocomplete="list"
			aria-activedescendant={showDropdown && results.length > 0 ? optionId(activeIndex) : undefined}
			value={searchText}
			oninput={onInput}
			onfocus={onFocusOrClick}
			onclick={onFocusOrClick}
			onkeydown={onKeydown}
			class="h-7 flex-1 border-border bg-card text-xs placeholder:text-muted-foreground/50"
		/>
		<button
			type="button"
			data-testid="advanced-search-button"
			aria-label="Advanced search"
			class="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			onclick={() => setSearchDialogOpen(true)}
		>
			<SlidersHorizontal class="h-3.5 w-3.5" />
		</button>
	</div>
	{#if showDropdown}
		<!-- The id stays as a stable handle for the e2e spec and the row tests;
		     the outside-click check above is scoped by reference instead. -->
		<div
			bind:this={dropdownEl}
			id="sidebar-search-dropdown"
			class="absolute left-3 right-3 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded border border-border bg-popover shadow-lg"
		>
			{#if results.length === 0}
				<!-- Outside the listbox: a status line is not an option, and an option
				     is the only thing a listbox may contain. -->
				<p class="px-2 py-1 text-xs text-muted-foreground/50">
					{searching ? 'Searching…' : 'No matches.'}
				</p>
			{/if}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<ul
				id={listboxId}
				role="listbox"
				aria-label="Matching elements"
				class="flex flex-col gap-0.5 p-1 text-xs"
			>
				{#each results as el, i (el.id)}
					<!-- The pointer handlers live on the OPTION itself: the listbox
					     pattern forbids interactive descendants inside an option, and
					     the keyboard equivalent is the input's own ↑/↓/Enter — which is
					     where a combobox's keyboard belongs, and why the rule above is
					     suppressed rather than answered with a key handler on an element
					     that can never hold focus. -->
					<li
						id={optionId(i)}
						role="option"
						aria-selected={i === activeIndex}
						class="flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted {i ===
						activeIndex
							? 'bg-muted'
							: ''}"
						style="touch-action: none"
						onpointerdown={(e) => onResultPointerDown(e, el.id)}
						onpointerenter={() => (active = i)}
						onclick={() => onPick(el.id)}
						title={el.id}
					>
						<!-- "<name> <stereotype>"; displayName falls back to the id when
						     the element has no usable name property. The raw id stays
						     reachable via the row's title tooltip. -->
						<span class="truncate text-foreground/90">{elementDisplayName(el)}</span>
						<span
							class="ml-auto shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
						>
							{el.type_name}
						</span>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
	<AdvancedSearchDialog />
</section>
