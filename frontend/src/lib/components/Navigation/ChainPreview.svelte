<script lang="ts">
	import {
		getDraft,
		getEvalError,
		getPreview,
		isRunnable,
		loadMorePreview,
		select
	} from '$lib/state';
	import { nodeAt } from '$lib/navigation/tree';
	import type { NodePath } from '$lib/navigation/tree';

	// `path` addresses the NODE this preview belongs to (the root of the
	// definition is `[]`) — a set-op's own operands render their own nested
	// ChainPreview, each keyed by its own path (see navigation-editor.svelte.ts
	// per-node preview state). Required, not defaulted: every caller
	// (CombineFrame, PathCard) is itself rendering at a known node path
	// and must be explicit about which node's preview this is — this
	// component only ever appears inside a parent's `isExpanded(tabId, path)`
	// guard, never as a bare root-only preview.
	let { tabId, path }: { tabId: string; path: NodePath } = $props();
	const draft = $derived(getDraft(tabId));
	const preview = $derived(getPreview(tabId, path));
	const node = $derived(draft ? nodeAt(draft.definition, path) : null);
	// The preview re-runs automatically on every definition edit (see
	// navigation-editor.svelte.ts) — there is no manual Run button. When
	// there's no preview yet because the definition isn't complete enough to
	// evaluate, show a hint instead of an empty panel; when the last run
	// FAILED (preview cleared, definition runnable), show the error line —
	// otherwise a failed evaluate would be indistinguishable from pending.
	const runnable = $derived(node ? isRunnable(node) : false);
	const errored = $derived(getEvalError(tabId, path));
</script>

<div class="flex min-h-0 flex-1 flex-col border-t border-zinc-800">
	<div class="flex items-center gap-2 px-2 py-1.5">
		{#if preview && !preview.loading}
			<span class="text-xs text-zinc-500">
				{preview.chains.length} of {preview.total} chains
				{#if preview.truncated}(results capped){/if}
			</span>
		{:else if !preview && errored}
			<p class="text-xs text-red-400">Evaluation failed — edit the definition to retry</p>
		{:else if !preview && !runnable}
			<p class="text-xs text-zinc-500">Complete the steps to see results</p>
		{/if}
	</div>
	{#if preview}
		<div class="min-h-0 flex-1 overflow-auto px-2 pb-2">
			<table class="w-full text-xs">
				<thead>
					<tr class="text-left text-zinc-500">
						<th class="py-1 pr-2 font-normal">Start</th>
						{#each preview.stepTypes as st, i (i)}
							<th class="py-1 pr-2 font-normal">{st} →</th>
						{/each}
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
			{#if !preview.loading && preview.chains.length < preview.total}
				<button
					type="button"
					class="mt-1 text-xs text-sky-500 hover:text-sky-300"
					onclick={() => void loadMorePreview(tabId, path)}>Load more</button
				>
			{/if}
			{#if preview.loading}<p class="py-2 text-xs text-zinc-500">Evaluating…</p>{/if}
		</div>
	{/if}
</div>
