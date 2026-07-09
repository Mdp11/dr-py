<script lang="ts">
	import { getDraft } from '$lib/state';
	import { nodeAt, type NodePath } from '$lib/navigation/tree';
	import type { OperandChrome } from './chrome';
	import CombineFrame from './CombineFrame.svelte';
	import PathCard from './PathCard.svelte';

	let {
		tabId,
		path,
		chrome = null
	}: { tabId: string; path: NodePath; chrome?: OperandChrome | null } = $props();
	const draft = $derived(getDraft(tabId));
	const node = $derived(draft ? nodeAt(draft.definition, path) : null);
</script>

{#if node?.kind === 'set_op'}
	<CombineFrame {tabId} {path} {node} {chrome} />
{:else if node?.kind === 'path'}
	<PathCard {tabId} {path} {node} {chrome} />
{/if}
