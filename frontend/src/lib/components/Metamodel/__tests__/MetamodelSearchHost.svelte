<script lang="ts">
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import type { DiagramSelection } from '$lib/metamodel/diagram-build';
	import MetamodelSearch from '../MetamodelSearch.svelte';

	let { onReveal }: { onReveal?: (sel: DiagramSelection) => void } = $props();
</script>

<!-- `useSvelteFlow` resolves context at its call site, so the provider must
     wrap the component under test exactly as MetamodelTab wraps the real
     surface. -->
<SvelteFlowProvider>
	<MetamodelSearch {onReveal} />
</SvelteFlowProvider>
