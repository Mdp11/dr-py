<script lang="ts">
	import { Trash2 } from '@lucide/svelte';
	import { getMetamodel } from '$lib/state';
	import {
		relationshipTypesFromScope,
		scopeAllowedTargetTypes
	} from '$lib/metamodel/connection-rules';
	import type { NavDirection, NavScope, NavStep } from '$lib/api/types';
	import ScopeEditor from './ScopeEditor.svelte';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';

	type Props = {
		step: NavStep;
		index: number;
		/** Types flowing INTO this step (previous scope's types; [] = any). */
		sourceTypes: string[];
		onChange: (index: number, next: NavStep) => void;
		onRemove: (index: number) => void;
	};
	let { step, index, sourceTypes, onChange, onRemove }: Props = $props();

	const mm = $derived(getMetamodel());
	let relPickerOpen = $state(false);

	// Valid hop types from the incoming types; unconstrained when sourceTypes
	// is empty or direction is 'in'/'either' (keep permissive: the backend is
	// the semantic authority, the picker is a convenience filter).
	const relTypeNames = $derived.by(() => {
		if (!mm) return [];
		if (step.direction !== 'out' || sourceTypes.length === 0) {
			return mm.relationships
				.filter((r) => !r.abstract)
				.map((r) => r.name)
				.sort();
		}
		// Ephemeral scratch set: built and drained into the returned array within
		// this derivation — never stored or read reactively itself (the $derived
		// wrapper tracks the resulting array).
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const names = new Set<string>();
		for (const t of sourceTypes) {
			for (const entry of relationshipTypesFromScope(mm, t)) names.add(entry.rt.name);
		}
		return [...names].sort();
	});

	// Target types the mapping allows (narrows the ScopeEditor's type list).
	const targetTypeOptions = $derived.by(() => {
		if (!mm || step.direction !== 'out' || sourceTypes.length === 0) return null;
		const rt = mm.relationships.find((r) => r.name === step.relationship_type);
		if (!rt) return null;
		// Ephemeral scratch set: built and drained into the returned array within
		// this derivation — never stored or read reactively itself (the $derived
		// wrapper tracks the resulting array).
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const out = new Set<string>();
		for (const t of sourceTypes) for (const n of scopeAllowedTargetTypes(mm, t, rt)) out.add(n);
		return out.size > 0 ? [...out].sort() : null;
	});

	function patch(next: Partial<NavStep>): void {
		onChange(index, { ...step, ...next });
	}
</script>

<div class="space-y-1.5 rounded border border-zinc-800 p-2">
	<div class="flex items-center gap-2 text-xs">
		<span class="text-zinc-500">Step {index + 1}</span>
		<StereotypePicker
			mode="create"
			names={relTypeNames}
			onPick={(name) => patch({ relationship_type: name })}
			open={relPickerOpen}
			onOpenChange={(v) => (relPickerOpen = v)}
			searchPlaceholder="Relationship type…"
		>
			{#snippet trigger()}
				<span class="cursor-pointer rounded border border-zinc-700 px-1.5 py-0.5">
					{step.relationship_type || 'pick relationship'}
				</span>
			{/snippet}
		</StereotypePicker>
		<select
			class="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs"
			value={step.direction}
			onchange={(e) => patch({ direction: e.currentTarget.value as NavDirection })}
		>
			<option value="out">outgoing</option>
			<option value="in">incoming</option>
			<option value="either">either</option>
		</select>
		<button
			type="button"
			aria-label="Remove step"
			class="ml-auto text-zinc-500 hover:text-red-400"
			onclick={() => onRemove(index)}
		>
			<Trash2 class="size-3.5" />
		</button>
	</div>
	<ScopeEditor
		scope={step.target}
		allowedTypes={targetTypeOptions}
		label="Target filter"
		onChange={(next: NavScope) => patch({ target: next })}
	/>
</div>
