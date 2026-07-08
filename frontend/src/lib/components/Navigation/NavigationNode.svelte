<script lang="ts">
	import { getDraft } from '$lib/state';
	import { nodeAt } from '$lib/navigation/tree';
	import type { NodePath } from '$lib/navigation/tree';
	import CombineEditor from './CombineEditor.svelte';
	import PathLeafEditor from './PathLeafEditor.svelte';

	let { tabId, path }: { tabId: string; path: NodePath } = $props();
	const draft = $derived(getDraft(tabId));
	const node = $derived(draft ? nodeAt(draft.definition, path) : null);
</script>

{#if node?.kind === 'set_op'}
	<CombineEditor {tabId} {path} node={node} />
{:else if node?.kind === 'path'}
	<PathLeafEditor {tabId} {path} node={node} />
{/if}
