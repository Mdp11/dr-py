<script lang="ts">
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import MetamodelDiagram from '../Metamodel/MetamodelDiagram.svelte';

	/** Mirrors how MetamodelTab mounts the canvas: `MetamodelDiagram` reaches the
	 * flow instance through `useSvelteFlow()` (Fit view, search-pan), which needs
	 * a `SvelteFlowProvider` ABOVE it — a hook resolves context at the call
	 * site's init, so a provider the component renders itself would be too late. */
</script>

<div style="width:800px;height:600px">
	<SvelteFlowProvider>
		<MetamodelDiagram />
	</SvelteFlowProvider>
</div>
