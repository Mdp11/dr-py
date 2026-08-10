<script lang="ts">
	// Test-support only: NewProjectWizard's `open` is a plain $bindable prop
	// (bound from routes/projects/+page.svelte's `wizardOpen`), not a store —
	// unlike ExportArtifactsDialog/ImportArtifactsDialog, which read an
	// external store and so can be driven open/closed directly from a test via
	// that store's setters. Svelte's top-level `mount()` cannot establish a
	// real two-way `bind:` (mutating the plain props object passed to `mount`
	// does not propagate into the child), so exercising a close→reopen cycle
	// on a bindable prop from a `.test.ts` file needs an actual parent
	// component to hold the source of truth and re-render on toggle — this is
	// that parent, doing nothing but what `+page.svelte` already does.
	import NewProjectWizard from '../projects/NewProjectWizard.svelte';

	let {
		onCreated,
		onListChanged
	}: { onCreated: (id: string) => void | Promise<void>; onListChanged?: () => void } = $props();

	let open = $state(true);
</script>

<button type="button" data-testid="host-toggle-open" onclick={() => (open = !open)}>
	toggle
</button>
<NewProjectWizard bind:open {onCreated} {onListChanged} />
