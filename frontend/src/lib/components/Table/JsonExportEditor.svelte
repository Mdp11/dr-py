<script lang="ts">
	// The "JSON export" settings tab: one row per VISIBLE column (key, element
	// rendering, group), plus a live sample. A grouped column names two things
	// — the array at its parent level and its own value inside each entry — so
	// its Key cell carries a second "item" input; blank means "same as array",
	// which is what the placeholder shows.
	//
	// The sample is fetched from `POST /tables/json-preview` rather than built
	// here on purpose: grouping is a non-trivial algorithm over the evaluator's
	// row keys, and a second implementation in TypeScript would drift from
	// `core/table/json_export.py` — the pane would then confidently show
	// something the download does not produce.
	import { getTableDraft, getTableSort, updateTableDefinition } from '$lib/state';
	import { defaultJsonKeys, setColumnJsonOptions, snakeCaseKey } from '$lib/table/columns';
	import { previewTableJson } from '$lib/api/tables';
	import type { Column, TableDefinition } from '$lib/api/types';

	let { tabId }: { tabId: string } = $props();

	const draft = $derived(getTableDraft(tabId));
	const defn = $derived(draft?.definition);
	const keys = $derived(defn ? defaultJsonKeys(defn) : []);

	/** A column whose cells can hold element references — the only place the
	 *  name/id/object choice means anything. A property column never does. */
	function producesElements(col: Column): boolean {
		return col.kind === 'element' || col.kind === 'navigation' || col.kind === 'script';
	}

	/** `group` is honored by the backend only on a visible expand column, so
	 *  the checkbox exists only where it would do something. */
	function canGroup(col: Column): boolean {
		return 'mode' in col && col.mode === 'expand';
	}

	function patch(index: number, p: Parameters<typeof setColumnJsonOptions>[2]): void {
		if (!defn) return;
		updateTableDefinition(tabId, setColumnJsonOptions(defn, index, p));
	}

	function snakeAll(): void {
		if (!defn) return;
		let next: TableDefinition = defn;
		const derived = defaultJsonKeys(defn);
		derived.forEach((k, i) => {
			if (k === null) return; // hidden: no key to rewrite
			// A blank item key keeps following the (now snaked) group key —
			// writing one would only freeze today's fallback into the payload.
			const item = defn.columns[i].json_export?.item_key ?? '';
			next = setColumnJsonOptions(
				next,
				i,
				item ? { key: snakeCaseKey(k), item_key: snakeCaseKey(item) } : { key: snakeCaseKey(k) }
			);
		});
		updateTableDefinition(tabId, next);
	}

	// Preview follows the definition AND the active grid sort — `downloadTable`
	// always sends the sort (`_sortFor` in table-editor.svelte.ts), and since
	// grouping rolls same-key rows into arrays, a different row ORDER can
	// produce a different grouped SHAPE, not just reordered output. Omitting
	// the sort here would let the pane disagree with the download precisely
	// where this route exists to prevent that (see the file header). Read
	// inside the effect (not captured once outside it) so a sort change alone
	// re-triggers the preview. Debounced so typing a key does not fire a
	// whole-table build per keystroke; the last write wins via the token guard.
	let sample = $state('');
	let truncated = $state(false);
	let previewError = $state<string | null>(null);
	let token = 0;
	$effect(() => {
		const d = defn;
		if (!d) return;
		const s = getTableSort(tabId);
		const mine = ++token;
		const timer = setTimeout(() => {
			void previewTableJson({ definition: d, sort: s })
				.then((r) => {
					if (mine !== token) return; // a newer edit is in flight
					sample = r.sample;
					truncated = r.truncated;
					previewError = null;
				})
				.catch((e: unknown) => {
					if (mine !== token) return;
					previewError = e instanceof Error ? e.message : 'Preview failed';
				});
		}, 300);
		return () => clearTimeout(timer);
	});
</script>

{#if defn}
	<div class="flex flex-col gap-3 p-1">
		<div class="flex items-center gap-2">
			<p class="flex-1 text-xs text-muted-foreground">
				One JSON object per row. Grouping an expanded column rolls its rows back into an array.
			</p>
			<button
				type="button"
				data-testid="json-snake-all"
				class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
				onclick={snakeAll}
			>
				snake_case all
			</button>
		</div>

		<table class="w-full text-xs">
			<thead class="text-muted-foreground">
				<tr>
					<th class="py-1 text-left font-normal">Column</th>
					<th class="py-1 text-left font-normal">Key</th>
					<th class="py-1 text-left font-normal">Value</th>
					<th class="py-1 text-left font-normal">Group</th>
				</tr>
			</thead>
			<tbody>
				{#each defn.columns as col, i (i)}
					{#if !col.hidden}
						{@const grouped = canGroup(col) && (col.json_export?.group ?? false)}
						<tr class="border-t border-border">
							<td class="py-1 pr-2 text-muted-foreground">{col.header || col.kind}</td>
							<td class="py-1 pr-2">
								<div class="flex flex-col gap-1">
									<label class="flex items-center gap-1">
										{#if grouped}
											<span class="w-9 shrink-0 text-[10px] uppercase text-muted-foreground/70">
												array
											</span>
										{/if}
										<input
											data-testid={`json-key-${i}`}
											class="w-full rounded border border-input bg-card px-2 py-1"
											placeholder={keys[i] ?? ''}
											value={col.json_export?.key ?? ''}
											oninput={(e) => patch(i, { key: e.currentTarget.value })}
										/>
									</label>
									{#if grouped}
										<label class="flex items-center gap-1">
											<span class="w-9 shrink-0 text-[10px] uppercase text-muted-foreground/70">
												item
											</span>
											<input
												data-testid={`json-item-key-${i}`}
												class="w-full rounded border border-input bg-card px-2 py-1"
												placeholder={keys[i] ?? ''}
												value={col.json_export?.item_key ?? ''}
												oninput={(e) => patch(i, { item_key: e.currentTarget.value })}
											/>
										</label>
									{/if}
								</div>
							</td>
							<td class="py-1 pr-2">
								{#if producesElements(col)}
									<select
										data-testid={`json-value-${i}`}
										class="rounded border border-input bg-card px-1 py-1"
										value={col.json_export?.value ?? 'name'}
										onchange={(e) =>
											patch(i, {
												value: e.currentTarget.value as 'name' | 'id' | 'object'
											})}
									>
										<option value="name">name</option>
										<option value="id">id</option>
										<option value="object">object</option>
									</select>
								{:else}
									<span class="text-muted-foreground/60">–</span>
								{/if}
							</td>
							<td class="py-1">
								{#if canGroup(col)}
									<input
										type="checkbox"
										data-testid={`json-group-${i}`}
										checked={col.json_export?.group ?? false}
										onchange={(e) => patch(i, { group: e.currentTarget.checked })}
									/>
								{:else}
									<span class="text-muted-foreground/60">–</span>
								{/if}
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>

		<div class="flex flex-col gap-1">
			<div class="flex items-center gap-2">
				<span class="text-xs text-muted-foreground">Preview</span>
				{#if truncated}
					<span data-testid="json-preview-truncated" class="text-[11px] text-muted-foreground/70">
						sample only — groups may be incomplete
					</span>
				{/if}
			</div>
			{#if previewError}
				<p class="text-xs text-destructive">{previewError}</p>
			{:else}
				<pre
					data-testid="json-preview"
					class="max-h-64 overflow-auto rounded border border-border bg-muted/30 p-2 text-[11px]">{sample}</pre>
			{/if}
		</div>
	</div>
{/if}
