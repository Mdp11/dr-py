<script lang="ts">
	/**
	 * The exporter tab's searchable add-table typeahead — the CLIENT-SIDE
	 * sibling of `Sidebar/Search.svelte`: same ARIA combobox
	 * pattern (focus stays on the input, the active row is announced via
	 * `aria-activedescendant`, options are non-interactive `<li role="option">`
	 * — `Metamodel/MetamodelSearch.svelte` carries the fuller note), but the
	 * candidates are the in-memory committed-table headers, so there is no
	 * debounce, no request sequencing, and the list shows ALL tables on focus
	 * (a picker is for browsing too, not only for narrowing).
	 *
	 * Deliberately NOT filtered against already-added entries: duplicates are
	 * legal and useful ("table A as a wide xlsx AND as a split JSON");
	 * the server dedupes colliding output names at export time.
	 */
	let {
		tables,
		disabled,
		onPick
	}: {
		tables: { id: string; name: string }[];
		disabled: boolean;
		onPick: (id: string) => void;
	} = $props();

	let query = $state('');
	let isOpen = $state(false);
	let active = $state(0);
	let inputEl = $state<HTMLElement | null>(null);
	let dropdownEl = $state<HTMLElement | null>(null);

	/** Per-instance id root — `aria-*` wiring must resolve THIS instance's
	 * nodes, never a second mounted picker's. */
	const uid = $props.id();
	const listboxId = `${uid}-listbox`;
	const optionId = (i: number): string => `${uid}-option-${i}`;

	const results = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return q === '' ? tables : tables.filter((t) => t.name.toLowerCase().includes(q));
	});
	/** Clamped for the window between the list shrinking under a new query
	 * and the active row being reset. */
	const activeIndex = $derived(results.length === 0 ? 0 : Math.min(active, results.length - 1));

	// A new query starts back at the top hit.
	$effect(() => {
		void query;
		active = 0;
	});

	function pick(id: string): void {
		onPick(id);
		query = '';
		isOpen = false;
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			isOpen = false;
			(e.currentTarget as HTMLInputElement).blur();
			return;
		}
		// Not prevented: the focus move is what the user asked for.
		if (e.key === 'Tab') {
			isOpen = false;
			return;
		}
		if (!isOpen || results.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = (activeIndex + 1) % results.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = (activeIndex - 1 + results.length) % results.length;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			pick(results[activeIndex].id);
		}
	}

	function onDocPointerDown(e: PointerEvent): void {
		if (!isOpen) return;
		const target = e.target as Node | null;
		if (!target) return;
		if (inputEl && inputEl.contains(target)) return;
		// The bound reference, not an id lookup — an id is a global name and
		// would cross-match the moment a second picker mounted.
		if (dropdownEl && dropdownEl.contains(target)) return;
		isOpen = false;
	}

	$effect(() => {
		document.addEventListener('pointerdown', onDocPointerDown);
		return () => document.removeEventListener('pointerdown', onDocPointerDown);
	});
</script>

<div class="relative">
	<input
		bind:this={inputEl}
		data-testid="add-table-input"
		type="text"
		placeholder="Add table…"
		role="combobox"
		aria-expanded={isOpen}
		aria-controls={listboxId}
		aria-autocomplete="list"
		aria-activedescendant={isOpen && results.length > 0 ? optionId(activeIndex) : undefined}
		class="w-56 rounded border border-input bg-card px-2 py-1 text-xs placeholder:text-muted-foreground/50"
		{disabled}
		value={query}
		oninput={(e) => {
			query = e.currentTarget.value;
			isOpen = true;
		}}
		onfocus={() => (isOpen = true)}
		onclick={() => (isOpen = true)}
		onkeydown={onKeydown}
	/>
	{#if isOpen}
		<div
			bind:this={dropdownEl}
			class="absolute left-0 top-full z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded border border-border bg-popover shadow-lg"
		>
			{#if results.length === 0}
				<!-- Outside the listbox: a status line is not an option, and an
				     option is the only thing a listbox may contain. -->
				<p class="px-2 py-1 text-xs text-muted-foreground/50">No matching tables.</p>
			{/if}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<ul
				id={listboxId}
				role="listbox"
				aria-label="Committed tables"
				class="flex flex-col gap-0.5 p-1 text-xs"
			>
				{#each results as t, i (t.id)}
					<!-- Pointer handlers live on the OPTION itself: the listbox
					     pattern forbids interactive descendants inside an option;
					     the keyboard equivalent is the input's own ↑/↓/Enter. -->
					<li
						id={optionId(i)}
						role="option"
						aria-selected={i === activeIndex}
						data-testid="add-table-option-{t.id}"
						class="cursor-pointer truncate rounded px-1.5 py-0.5 text-left transition-colors hover:bg-muted {i ===
						activeIndex
							? 'bg-muted'
							: ''}"
						onpointerenter={() => (active = i)}
						onclick={() => pick(t.id)}
						title={t.id}
					>
						{t.name}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
