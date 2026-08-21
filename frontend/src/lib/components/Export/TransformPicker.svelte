<script lang="ts">
	// Ref-only snippet picker for the export transform hook (spec §8/§11):
	// the reusable core of SnippetSourceEditor's ref mode (refOptions +
	// refMissing) without its inline-code half — transform is TableRef-only
	// by schema. Options are committed code_snippet artifacts whose
	// server-derived entry_points include 'transform'
	// (referenceableArtifactHeaders excludes staged temp ids — a temp id
	// must never reach a payload). A selected ref that fell out of the list
	// (deleted, or its entry_points no longer cover transform) is surfaced
	// as "(missing)" and never silently cleared — the user might be mid-edit
	// of the snippet elsewhere. All strictness is server-side at export time
	// (422/503/429); this control never blocks Save.
	import { referenceableArtifactHeaders } from '$lib/state';
	import { entryAvailable } from '$lib/snippet/entry-stubs';

	let {
		value,
		disabled = false,
		onChange
	}: {
		value: string | null;
		disabled?: boolean;
		onChange: (ref: string | null) => void;
	} = $props();

	const options = $derived(
		referenceableArtifactHeaders('code_snippet').filter((a) =>
			entryAvailable('transform', a.entry_points ?? undefined)
		)
	);
	const missing = $derived(!!value && !options.some((h) => h.id === value));
</script>

<select
	data-testid="transform-picker"
	aria-label="Transform snippet"
	class="rounded border border-input bg-card px-1.5 py-0.5 text-xs"
	{disabled}
	value={value ?? ''}
	onchange={(e) => onChange(e.currentTarget.value || null)}
>
	<option value="">No transform</option>
	{#if missing}
		<option {value}>saved snippet (missing)</option>
	{/if}
	{#each options as h (h.id)}
		<option value={h.id}>{h.name}</option>
	{/each}
</select>
