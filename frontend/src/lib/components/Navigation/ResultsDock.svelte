<script lang="ts">
	// The single always-live results panel for the whole navigation tree: one
	// node picker (mirroring `nodeEntries`'s depth-first, lettered listing) plus
	// the chosen node's chain table. Replaces the old per-node nested preview
	// card — there is exactly one results surface per tab now, and
	// selecting a card (see PathCard/CombineFrame/RefCard's `onCardClick`)
	// moves it here via `selectNode`. The dock never registers/unregisters
	// visibility itself: every node in the tree is always rendered by its own
	// card (no collapse toggle — see navigation-editor.svelte.ts), so the
	// selected node's preview is already kept live by that card's own
	// register/unregister effect.
	import {
		artifactHeaderById,
		getDraft,
		getEvalError,
		getPreview,
		isRunnable,
		loadMorePreview,
		getSelectedPath,
		select,
		selectNode
	} from '$lib/state';
	import {
		OP_NOTE,
		chainColumns,
		nodeAt,
		nodeEntries,
		pathKey,
		titleForPath
	} from '$lib/navigation/tree';
	import ChainBadge from './ChainBadge.svelte';

	let { tabId }: { tabId: string } = $props();

	const draft = $derived(getDraft(tabId));
	const selected = $derived(getSelectedPath(tabId));
	const entries = $derived(
		draft ? nodeEntries(draft.definition, (id) => artifactHeaderById(id)?.name) : []
	);
	const selectedEntry = $derived(entries.find((e) => pathKey(e.path) === pathKey(selected)));
	const node = $derived(draft ? nodeAt(draft.definition, selected) : null);
	const preview = $derived(getPreview(tabId, selected));
	const errored = $derived(getEvalError(tabId, selected));
	const runnable = $derived(node ? isRunnable(node) : false);
	const columns = $derived(node?.kind === 'path' ? chainColumns(node) : []);
	const isPristineRoot = $derived(
		selected.length === 0 && node?.kind === 'path' && !runnable && node.steps.length === 0
	);
	// A bare-Path root has one unlettered entry (depth 0, no indent needed
	// under it); a set_op root letters its top-level operands at depth 1 —
	// those must render at indent 0 too, so only depth beyond that nests.
	const rootIsPath = $derived(draft?.definition.kind === 'path');
	const title = $derived(
		draft ? titleForPath(draft.definition, selected, (id) => artifactHeaderById(id)?.name) : ''
	);

	function onPickerChange(value: string): void {
		const entry = entries.find((e) => pathKey(e.path) === value);
		if (entry) selectNode(tabId, entry.path);
	}

	function indentFor(depth: number): string {
		return '  '.repeat(depth ? depth - (rootIsPath ? 0 : 1) : 0);
	}
</script>

<div data-testid="results-dock" class="flex h-full flex-col border-t border-zinc-800 bg-zinc-950">
	<div class="flex items-center gap-2 border-b border-zinc-900 px-3 py-1.5">
		<span class="font-mono text-[10px] tracking-[0.14em] text-zinc-500 uppercase">Results</span>
		<select
			data-testid="node-picker"
			aria-label="Results node"
			value={pathKey(selected)}
			onchange={(e) => onPickerChange(e.currentTarget.value)}
			class="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs text-zinc-200"
		>
			{#each entries as e (pathKey(e.path))}
				<option value={pathKey(e.path)}>
					{indentFor(e.depth) + (e.kind === 'ref' ? `⧉ ${e.title}` : e.title)}
				</option>
			{/each}
		</select>
		<span data-testid="results-status" class="ml-auto font-mono text-[11px]">
			{#if errored && !preview}
				<span class="text-red-400">Evaluation failed — edit the definition to retry</span>
			{:else if preview?.loading}
				<span class="text-zinc-500">auto-runs as you edit · evaluating…</span>
			{:else if preview}
				<span class="text-emerald-400">auto-runs as you edit · ✓ {preview.total} chains</span>
			{:else}
				<span class="text-zinc-500">auto-runs as you edit · waiting for a runnable path</span>
			{/if}
		</span>
	</div>
	<div class="min-h-0 flex-1 overflow-auto px-3 py-2">
		{#if selectedEntry?.kind === 'ref'}
			<p class="text-xs text-zinc-500">
				Linked saved navigation — open it in its own tab to see its results.
			</p>
		{:else if errored && !preview}
			<p class="text-xs text-red-400">Evaluation failed — edit the definition to retry</p>
		{:else if !preview && !runnable}
			<p class="text-xs text-zinc-500">
				{#if isPristineRoot}
					Pick what to start from — results appear here automatically as you build.
				{:else}
					Nothing to run yet — pick what {title} starts from, or add a step. Results appear here automatically.
				{/if}
			</p>
		{:else if preview}
			<table class="w-full text-xs">
				<thead>
					<tr class="text-left text-zinc-500">
						{#if node?.kind === 'set_op'}
							<th class="py-1 pr-2 font-normal text-zinc-300">
								Combined elements <span class="text-zinc-500">{OP_NOTE[node.op]}</span>
							</th>
						{:else}
							{#each columns as col (col.index)}
								<th class="py-1 pr-2 font-normal">
									<span class="inline-flex items-center gap-1">
										<ChainBadge value={col.index} />
										{col.label}
									</span>
								</th>
							{/each}
						{/if}
					</tr>
				</thead>
				<tbody>
					{#each preview.chains as chain, ci (ci)}
						<tr class="border-t border-zinc-900">
							{#each chain as item (item.id)}
								<td class="py-0.5 pr-2">
									<button
										type="button"
										class="rounded bg-zinc-800 px-1.5 py-0.5 hover:bg-zinc-700"
										title={item.type_name}
										onclick={() => select({ kind: 'element', id: item.id })}
									>
										{item.display_name}
									</button>
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
			{#if preview.truncated}
				<p class="mt-1 text-[10px] text-zinc-500">(results capped)</p>
			{/if}
			{#if !preview.loading && preview.chains.length < preview.total}
				<button
					type="button"
					class="mt-1 text-xs text-sky-500 hover:text-sky-300"
					onclick={() => void loadMorePreview(tabId, selected)}>Load more</button
				>
			{/if}
			{#if preview.loading}<p class="py-2 text-xs text-zinc-500">Evaluating…</p>{/if}
		{/if}
	</div>
</div>
