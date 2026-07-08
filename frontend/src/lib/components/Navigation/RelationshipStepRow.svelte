<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { Trash2 } from '@lucide/svelte';
	import { getMetamodel } from '$lib/state';
	import {
		relationshipTypesFromScope,
		scopeAllowedTargetTypes
	} from '$lib/metamodel/connection-rules';
	import type { NavDirection, NavRelationshipStep } from '$lib/api/types';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';

	type Props = {
		step: NavRelationshipStep;
		index: number;
		/** Types flowing INTO this step (previous scope's types; [] = any). */
		sourceTypes: string[];
		onChange: (index: number, next: NavRelationshipStep) => void;
		onRemove: (index: number) => void;
	};
	let { step, index, sourceTypes, onChange, onRemove }: Props = $props();

	const mm = $derived(getMetamodel());
	let relPickerOpen = $state(false);
	let targetPickerOpen = $state(false);

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

	// Target-type picker options: the mapping-allowed union when the hop is
	// outgoing from known source types, else every element type (unconstrained
	// convenience picker — the backend is the semantic authority).
	const targetTypeNames = $derived.by(() => {
		if (!mm) return [];
		if (step.direction !== 'out' || sourceTypes.length === 0) {
			return [...mm.elements.map((e) => e.name)].sort();
		}
		const rt = mm.relationships.find((r) => r.name === step.relationship_type);
		if (!rt) return [...mm.elements.map((e) => e.name)].sort();
		// Ephemeral scratch set: built and drained into the returned array within
		// this derivation — never stored or read reactively itself (the $derived
		// wrapper tracks the resulting array).
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const out = new Set<string>();
		for (const t of sourceTypes) for (const n of scopeAllowedTargetTypes(mm, t, rt)) out.add(n);
		return out.size > 0 ? [...out].sort() : [...mm.elements.map((e) => e.name)].sort();
	});

	const checkedTargetTypes = $derived(new SvelteSet(step.target_types));

	function patch(next: Partial<NavRelationshipStep>): void {
		onChange(index, { ...step, ...next });
	}

	function toggleTargetType(name: string): void {
		// Ephemeral scratch set: built, mutated, and spread into the onChange
		// payload within this call — never stored or read reactively.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const next = new Set(step.target_types);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		patch({ target_types: [...next].sort() });
	}
</script>

<div class="space-y-1.5 rounded border border-zinc-800 p-2" data-testid="relationship-step">
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
	<div class="flex items-center gap-2 text-xs">
		<span class="text-zinc-400">Target types</span>
		<StereotypePicker
			mode="filter"
			names={targetTypeNames}
			checked={checkedTargetTypes}
			onToggle={toggleTargetType}
			onSelectAll={() => patch({ target_types: [...targetTypeNames] })}
			onDeselectAll={() => patch({ target_types: [] })}
			open={targetPickerOpen}
			onOpenChange={(v) => (targetPickerOpen = v)}
			searchPlaceholder="Filter types…"
		>
			{#snippet trigger()}
				<span class="cursor-pointer rounded border border-zinc-700 px-1.5 py-0.5">
					{step.target_types.length === 0 ? 'Any type' : step.target_types.join(', ')}
				</span>
			{/snippet}
		</StereotypePicker>
	</div>
</div>
