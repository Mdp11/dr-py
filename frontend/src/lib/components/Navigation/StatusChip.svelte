<script lang="ts">
	// The always-live per-card status. Four states, mirroring the store's
	// per-node surfaces: a settled preview (count), an in-flight run (never
	// blank — a bare ellipsis), a failed run (the eval-error flag is the only
	// failure surface auto-run has), and a node that isn't runnable yet.
	// A REF part has no evaluable definition (`nodeAt` returns null for it),
	// so it reports only that it is linked.
	import { getDraft, getEvalError, getPreview, isRunnable } from '$lib/state';
	import { nodeAt, type NodePath } from '$lib/navigation/tree';

	let {
		tabId,
		path,
		kind = 'node'
	}: { tabId: string; path: NodePath; kind?: 'node' | 'ref' } = $props();

	const draft = $derived(getDraft(tabId));
	const node = $derived(draft ? nodeAt(draft.definition, path) : null);
	const preview = $derived(getPreview(tabId, path));
	const errored = $derived(getEvalError(tabId, path));
	const runnable = $derived(node ? isRunnable(node) : false);
</script>

<span data-testid="status-chip" aria-live="polite" class="text-[11px]">
	{#if kind === 'ref'}
		<span class="font-mono text-zinc-500">linked</span>
	{:else if preview?.loading}
		<span class="text-zinc-500">…</span>
	{:else if preview}
		<span class="font-mono text-emerald-400">✓ {preview.total} chains</span>
	{:else if errored}
		<span class="font-mono text-red-400">⚠ failed</span>
	{:else if !runnable}
		<span class="text-zinc-500 italic">incomplete — pick a start or add a step</span>
	{/if}
</span>
