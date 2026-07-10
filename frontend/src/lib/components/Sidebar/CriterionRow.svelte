<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { Trash2 } from '@lucide/svelte';
	import { Input } from '$lib/components/ui/input';
	import { getCachedElements, getCachedRelationships, getMetamodel } from '$lib/state';
	import { isValidRegex } from '$lib/search/evaluate';
	import { CRITERION_LABELS, type Criterion, type TargetKind } from '$lib/search/types';
	import {
		compatibleOps,
		propertyItemsFor,
		PROPERTY_OP_LABELS,
		resolvePropertyKind
	} from '$lib/search/property-ops';
	import StereotypePicker from './StereotypePicker.svelte';
	import PropertyPicker from './PropertyPicker.svelte';

	type Props = {
		criterion: Criterion;
		index: number;
		target: TargetKind;
		onChange: (index: number, next: Criterion) => void;
		onRemove: (index: number) => void;
		/** When non-null, scope the property picker to these names (a navigation
		 * filter step's reachable-type property union). `null` (default, all
		 * existing/search callers) leaves the picker unscoped — unchanged
		 * behaviour. */
		propertyNames?: string[] | null;
	};
	let { criterion, index, target, onChange, onRemove, propertyNames = null }: Props = $props();

	const mm = $derived(getMetamodel());

	const elementTypeNames = $derived([...(mm?.elements ?? []).map((e) => e.name)].sort());
	const relTypeNames = $derived([...(mm?.relationships ?? []).map((r) => r.name)].sort());

	// Picker rows: every (name, datatype) pair for this target, plus instance-only
	// keys as untyped. Same-named properties of different datatypes are distinct.
	// Instance-only keys are discovered from the FETCHED SUBSET (cached
	// entities); metamodel-declared properties are always complete.
	const propertyItems = $derived(
		propertyItemsFor(target, mm, {
			elements: [...getCachedElements().values()],
			relationships: [...getCachedRelationships().values()]
		})
	);

	// Scoped subset for a navigation filter step: only properties reachable at
	// that point in the chain. `propertyNames === null` (every non-navigation
	// caller) leaves the picker unscoped.
	const scopedItems = $derived(
		propertyNames === null
			? propertyItems
			: propertyItems.filter((it) => propertyNames!.includes(it.name))
	);

	// Which inline picker popover is open (keyed by a string id within this row).
	let openPicker = $state<string | null>(null);

	function patch(next: Partial<Criterion>): void {
		onChange(index, { ...criterion, ...next } as Criterion);
	}

	// Pick a property: record its name and datatype, and if the current operator
	// isn't valid for that datatype, fall back to `equals` (valid for every kind).
	function pickProperty(name: string, datatype: string | null): void {
		if (criterion.type !== 'property') return;
		const kind = resolvePropertyKind(datatype, mm);
		const ops = compatibleOps(kind);
		const op = ops.includes(criterion.op) ? criterion.op : 'equals';
		// A boolean property's value is a true/false select; seed a valid default
		// so the select doesn't show a blank/invalid state.
		const value =
			kind === 'boolean' && criterion.value !== 'true' && criterion.value !== 'false'
				? 'true'
				: criterion.value;
		onChange(index, { ...criterion, name, datatype, op, value });
	}

	function toggleName(field: 'names' | 'relTypes', name: string): void {
		const current = (criterion as Record<string, unknown>)[field] as string[];
		const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
		patch({ [field]: next } as Partial<Criterion>);
	}

	const regexInvalid = $derived(
		(criterion.type === 'property' &&
			criterion.op === 'matches' &&
			!isValidRegex(criterion.value)) ||
			(criterion.type === 'name_id' && criterion.op === 'matches' && !isValidRegex(criterion.value))
	);

	function summary(names: string[]): string {
		return names.length === 0 ? 'any' : names.join(', ');
	}
</script>

<div class="flex flex-col gap-1 rounded border border-border bg-muted/50 p-2">
	<div class="flex items-center gap-2">
		<span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
			{CRITERION_LABELS[criterion.type]}
		</span>
		<button
			type="button"
			class="ml-auto flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
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
					<span class="rounded border border-input px-2 py-1 text-foreground/90 hover:bg-muted">
						Type: {summary(entityCriterion.names)}
					</span>
				{/snippet}
			</StereotypePicker>
		{:else if criterion.type === 'property'}
			{@const propCriterion = criterion}
			{@const datatype = propCriterion.datatype ?? null}
			{@const kind = resolvePropertyKind(datatype, mm)}
			{@const ops = compatibleOps(kind)}
			{@const noProperty = propCriterion.name === ''}
			<PropertyPicker
				items={scopedItems}
				onPick={(name, dt) => pickProperty(name, dt)}
				open={openPicker === 'prop'}
				onOpenChange={(o) => (openPicker = o ? 'prop' : null)}
				searchPlaceholder="Filter properties…"
			>
				{#snippet trigger()}
					<span
						class="flex max-w-[18rem] items-center gap-1 rounded border border-input px-2 py-1 text-foreground/90 hover:bg-muted"
					>
						<span class="truncate" title={propCriterion.name || undefined}>
							{propCriterion.name || 'property…'}
						</span>
						{#if !noProperty}
							<span
								class="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
							>
								{datatype ?? 'untyped'}
							</span>
						{/if}
					</span>
				{/snippet}
			</PropertyPicker>
			<select
				class="rounded border border-input bg-card px-1 py-1 text-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
				value={propCriterion.op}
				disabled={noProperty}
				title={noProperty ? 'Select a property first' : undefined}
				onchange={(e) => patch({ op: e.currentTarget.value as typeof propCriterion.op })}
			>
				{#each ops as op (op)}
					<option value={op}>{PROPERTY_OP_LABELS[op]}</option>
				{/each}
			</select>
			{#if propCriterion.op !== 'exists' && propCriterion.op !== 'is_empty'}
				{#if kind === 'boolean'}
					<select
						class="rounded border border-input bg-card px-1 py-1 text-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
						value={propCriterion.value}
						disabled={noProperty}
						onchange={(e) => patch({ value: e.currentTarget.value })}
					>
						<option value="true">true</option>
						<option value="false">false</option>
					</select>
				{:else}
					<Input
						type="text"
						value={propCriterion.value}
						disabled={noProperty}
						oninput={(e) => patch({ value: (e.currentTarget as HTMLInputElement).value })}
						class="h-7 w-32 border-input bg-card text-xs disabled:cursor-not-allowed disabled:opacity-50"
						placeholder="value"
					/>
				{/if}
			{/if}
		{:else if criterion.type === 'name_id'}
			{@const nameIdCriterion = criterion}
			<select
				class="rounded border border-input bg-card px-1 py-1 text-foreground/90"
				value={nameIdCriterion.field}
				onchange={(e) => patch({ field: e.currentTarget.value as 'name' | 'id' })}
			>
				<option value="name">name</option>
				<option value="id">id</option>
			</select>
			<select
				class="rounded border border-input bg-card px-1 py-1 text-foreground/90"
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
				class="h-7 w-32 border-input bg-card text-xs"
				placeholder="value"
			/>
		{:else if criterion.type === 'relation_count'}
			{@const relCountCriterion = criterion}
			<span>has</span>
			<select
				class="rounded border border-input bg-card px-1 py-1 text-foreground/90"
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
				class="h-7 w-16 border-input bg-card text-xs"
			/>
			<span>relations</span>
			<select
				class="rounded border border-input bg-card px-1 py-1 text-foreground/90"
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
					<span class="rounded border border-input px-2 py-1 text-foreground/90 hover:bg-muted">
						of type: {summary(relCountCriterion.relTypes)}
					</span>
				{/snippet}
			</StereotypePicker>
		{:else if criterion.type === 'orphan'}
			<span class="text-muted-foreground">No relations (orphan element).</span>
		{:else if criterion.type === 'connected_to_type'}
			{@const connCriterion = criterion}
			<span>connected</span>
			<select
				class="rounded border border-input bg-card px-1 py-1 text-foreground/90"
				value={connCriterion.direction}
				onchange={(e) =>
					patch({ direction: e.currentTarget.value as typeof connCriterion.direction })}
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
					<span class="rounded border border-input px-2 py-1 text-foreground/90 hover:bg-muted">
						{summary(connCriterion.names)}
					</span>
				{/snippet}
			</StereotypePicker>
		{:else if criterion.type === 'endpoint_type'}
			{@const endpointCriterion = criterion}
			<select
				class="rounded border border-input bg-card px-1 py-1 text-foreground/90"
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
					<span class="rounded border border-input px-2 py-1 text-foreground/90 hover:bg-muted">
						{summary(endpointCriterion.names)}
					</span>
				{/snippet}
			</StereotypePicker>
		{/if}
	</div>

	{#if regexInvalid}
		<p class="text-[11px] text-destructive">Invalid regular expression.</p>
	{/if}
</div>
