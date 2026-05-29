<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { Trash2 } from '@lucide/svelte';
	import { Input } from '$lib/components/ui/input';
	import { getMetamodel, getWorkingModel } from '$lib/state';
	import { isValidRegex } from '$lib/search/evaluate';
	import { CRITERION_LABELS, type Criterion, type TargetKind } from '$lib/search/types';
	import StereotypePicker from './StereotypePicker.svelte';

	type Props = {
		criterion: Criterion;
		index: number;
		target: TargetKind;
		onChange: (index: number, next: Criterion) => void;
		onRemove: (index: number) => void;
	};
	let { criterion, index, target, onChange, onRemove }: Props = $props();

	const mm = $derived(getMetamodel());
	const working = $derived(getWorkingModel());

	const elementTypeNames = $derived([...(mm?.elements ?? []).map((e) => e.name)].sort());
	const relTypeNames = $derived([...(mm?.relationships ?? []).map((r) => r.name)].sort());
	const propertyNames = $derived.by(() => {
		const set = new Set<string>();
		const defs = target === 'element' ? (mm?.elements ?? []) : (mm?.relationships ?? []);
		for (const t of defs) for (const p of t.properties ?? []) set.add(p.name);
		const entities = target === 'element' ? working.elements : working.relationships;
		for (const e of entities) for (const k of Object.keys(e.properties ?? {})) set.add(k);
		return [...set].sort();
	});

	// Which inline picker popover is open (keyed by a string id within this row).
	let openPicker = $state<string | null>(null);

	function patch(next: Partial<Criterion>): void {
		onChange(index, { ...criterion, ...next } as Criterion);
	}

	function toggleName(field: 'names' | 'relTypes', name: string): void {
		const current = (criterion as Record<string, unknown>)[field] as string[];
		const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
		patch({ [field]: next } as Partial<Criterion>);
	}

	const regexInvalid = $derived(
		(criterion.type === 'property' && criterion.op === 'matches' && !isValidRegex(criterion.value)) ||
			(criterion.type === 'name_id' && criterion.op === 'matches' && !isValidRegex(criterion.value))
	);

	function summary(names: string[]): string {
		return names.length === 0 ? 'any' : names.join(', ');
	}
</script>

<div class="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-900/50 p-2">
	<div class="flex items-center gap-2">
		<span class="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
			{CRITERION_LABELS[criterion.type]}
		</span>
		<button
			type="button"
			class="ml-auto flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-red-300"
			aria-label="Remove criterion"
			onclick={() => onRemove(index)}
		>
			<Trash2 class="h-3 w-3" />
		</button>
	</div>

	<div class="flex flex-wrap items-center gap-2 text-xs">
		{#if criterion.type === 'entity_type'}
			{@const entityTypeNames = target === 'element' ? elementTypeNames : relTypeNames}
			{@const entityCriterion = criterion}
			<StereotypePicker
				mode="filter"
				names={entityTypeNames}
				checked={new SvelteSet(entityCriterion.names)}
				onToggle={(n) => toggleName('names', n)}
				onSelectAll={() => patch({ names: entityTypeNames })}
				onDeselectAll={() => patch({ names: [] })}
				open={openPicker === 'names'}
				onOpenChange={(o) => (openPicker = o ? 'names' : null)}
				searchPlaceholder="Filter types…"
			>
				{#snippet trigger()}
					<span class="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800">
						Type: {summary(entityCriterion.names)}
					</span>
				{/snippet}
			</StereotypePicker>
		{:else if criterion.type === 'property'}
			{@const propCriterion = criterion}
			<StereotypePicker
				mode="create"
				names={propertyNames}
				onPick={(n) => patch({ name: n })}
				open={openPicker === 'prop'}
				onOpenChange={(o) => (openPicker = o ? 'prop' : null)}
				searchPlaceholder="Filter properties…"
			>
				{#snippet trigger()}
					<span class="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800">
						{propCriterion.name || 'property…'}
					</span>
				{/snippet}
			</StereotypePicker>
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={propCriterion.op}
				onchange={(e) => patch({ op: e.currentTarget.value as typeof propCriterion.op })}
			>
				<option value="equals">=</option>
				<option value="not_equals">≠</option>
				<option value="contains">contains</option>
				<option value="matches">matches</option>
				<option value="gt">&gt;</option>
				<option value="lt">&lt;</option>
				<option value="gte">≥</option>
				<option value="lte">≤</option>
				<option value="exists">exists</option>
				<option value="is_empty">is empty</option>
			</select>
			{#if propCriterion.op !== 'exists' && propCriterion.op !== 'is_empty'}
				<Input
					type="text"
					value={propCriterion.value}
					oninput={(e) => patch({ value: (e.currentTarget as HTMLInputElement).value })}
					class="h-7 w-32 border-zinc-700 bg-zinc-900 text-xs"
					placeholder="value"
				/>
			{/if}
		{:else if criterion.type === 'name_id'}
			{@const nameIdCriterion = criterion}
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={nameIdCriterion.field}
				onchange={(e) => patch({ field: e.currentTarget.value as 'name' | 'id' })}
			>
				<option value="name">name</option>
				<option value="id">id</option>
			</select>
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={nameIdCriterion.op}
				onchange={(e) => patch({ op: e.currentTarget.value as typeof nameIdCriterion.op })}
			>
				<option value="contains">contains</option>
				<option value="equals">equals</option>
				<option value="matches">matches</option>
			</select>
			<Input
				type="text"
				value={nameIdCriterion.value}
				oninput={(e) => patch({ value: (e.currentTarget as HTMLInputElement).value })}
				class="h-7 w-32 border-zinc-700 bg-zinc-900 text-xs"
				placeholder="value"
			/>
		{:else if criterion.type === 'relation_count'}
			{@const relCountCriterion = criterion}
			<span>has</span>
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={relCountCriterion.op}
				onchange={(e) => patch({ op: e.currentTarget.value as typeof relCountCriterion.op })}
			>
				<option value="at_least">at least</option>
				<option value="at_most">at most</option>
				<option value="exactly">exactly</option>
			</select>
			<Input
				type="number"
				value={String(relCountCriterion.count)}
				oninput={(e) => patch({ count: Number((e.currentTarget as HTMLInputElement).value) || 0 })}
				class="h-7 w-16 border-zinc-700 bg-zinc-900 text-xs"
			/>
			<span>relations</span>
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={relCountCriterion.direction}
				onchange={(e) =>
					patch({ direction: e.currentTarget.value as typeof relCountCriterion.direction })}
			>
				<option value="either">either</option>
				<option value="outgoing">outgoing</option>
				<option value="incoming">incoming</option>
			</select>
			<StereotypePicker
				mode="filter"
				names={relTypeNames}
				checked={new SvelteSet(relCountCriterion.relTypes)}
				onToggle={(n) => toggleName('relTypes', n)}
				onSelectAll={() => patch({ relTypes: relTypeNames })}
				onDeselectAll={() => patch({ relTypes: [] })}
				open={openPicker === 'relTypes'}
				onOpenChange={(o) => (openPicker = o ? 'relTypes' : null)}
				searchPlaceholder="Filter rel types…"
			>
				{#snippet trigger()}
					<span class="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800">
						of type: {summary(relCountCriterion.relTypes)}
					</span>
				{/snippet}
			</StereotypePicker>
		{:else if criterion.type === 'orphan'}
			<span class="text-zinc-400">No relations (orphan element).</span>
		{:else if criterion.type === 'connected_to_type'}
			{@const connCriterion = criterion}
			<span>connected</span>
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={connCriterion.direction}
				onchange={(e) => patch({ direction: e.currentTarget.value as typeof connCriterion.direction })}
			>
				<option value="either">either</option>
				<option value="outgoing">outgoing</option>
				<option value="incoming">incoming</option>
			</select>
			<span>to type</span>
			<StereotypePicker
				mode="filter"
				names={elementTypeNames}
				checked={new SvelteSet(connCriterion.names)}
				onToggle={(n) => toggleName('names', n)}
				onSelectAll={() => patch({ names: elementTypeNames })}
				onDeselectAll={() => patch({ names: [] })}
				open={openPicker === 'names'}
				onOpenChange={(o) => (openPicker = o ? 'names' : null)}
				searchPlaceholder="Filter types…"
			>
				{#snippet trigger()}
					<span class="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800">
						{summary(connCriterion.names)}
					</span>
				{/snippet}
			</StereotypePicker>
		{:else if criterion.type === 'endpoint_type'}
			{@const endpointCriterion = criterion}
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={endpointCriterion.endpoint}
				onchange={(e) => patch({ endpoint: e.currentTarget.value as 'source' | 'target' })}
			>
				<option value="source">source</option>
				<option value="target">target</option>
			</select>
			<span>is type</span>
			<StereotypePicker
				mode="filter"
				names={elementTypeNames}
				checked={new SvelteSet(endpointCriterion.names)}
				onToggle={(n) => toggleName('names', n)}
				onSelectAll={() => patch({ names: elementTypeNames })}
				onDeselectAll={() => patch({ names: [] })}
				open={openPicker === 'names'}
				onOpenChange={(o) => (openPicker = o ? 'names' : null)}
				searchPlaceholder="Filter types…"
			>
				{#snippet trigger()}
					<span class="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800">
						{summary(endpointCriterion.names)}
					</span>
				{/snippet}
			</StereotypePicker>
		{/if}
	</div>

	{#if regexInvalid}
		<p class="text-[11px] text-red-400">Invalid regular expression.</p>
	{/if}
</div>
