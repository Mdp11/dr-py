<script lang="ts">
	// Test-support only: Svelte's top-level `mount()` cannot establish a real
	// reactive prop binding — mutating the plain object passed as `props` does
	// not propagate into the child (see NewProjectWizardHost.svelte for the
	// same rationale, confirmed empirically for this component too). Exercising
	// MetamodelYamlEditor's "external replacement" effect (baseline load /
	// draft restore / discard changing the `code` prop out from under the user)
	// needs an actual parent holding the source of truth in `$state` and
	// re-rendering on change — this is that parent, exposing `setCode` so the
	// test can drive it the way a real host tab would.
	import MetamodelYamlEditor from '../MetamodelYamlEditor.svelte';

	let { onChange }: { onChange: (code: string) => void } = $props();

	let code = $state('elements: []\n');

	export function setCode(next: string): void {
		code = next;
	}
</script>

<MetamodelYamlEditor {code} {onChange} />
