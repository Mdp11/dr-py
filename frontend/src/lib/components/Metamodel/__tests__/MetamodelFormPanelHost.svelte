<script lang="ts">
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import type { DiagramSelection } from '$lib/metamodel/diagram-build';
	import MetamodelFormPanel from '../forms/MetamodelFormPanel.svelte';

	let {
		readOnly = false,
		onReveal
	}: { readOnly?: boolean; onReveal?: (sel: DiagramSelection) => void } = $props();
</script>

<SvelteFlowProvider>
	<MetamodelFormPanel {readOnly} {onReveal} />
</SvelteFlowProvider>
