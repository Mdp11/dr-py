<script lang="ts">
	import { canEdit, getDraft, getMetamodel, isExpanded, toggleExpanded, updateDefinition } from '$lib/state';
	import {
		elementStartScope,
		emptyCombine,
		precedingTargetTypes,
		readElementStart,
		updateNodeAt
	} from '$lib/navigation/tree';
	import type { NodePath } from '$lib/navigation/tree';
	import { effectivePropertiesForTypes } from '$lib/metamodel/helpers';
	import type {
		NavFilterStep,
		NavRelationshipStep,
		NavScope,
		NavStepItem,
		PathNavigation
	} from '$lib/api/types';
	import ScopeEditor from './ScopeEditor.svelte';
	import ElementStartPicker from './ElementStartPicker.svelte';
	import NavigationNode from './NavigationNode.svelte';
	import RelationshipStepRow from './RelationshipStepRow.svelte';
	import FilterStepRow from './FilterStepRow.svelte';
	import ChainPreview from './ChainPreview.svelte';

	let { tabId, path, node }: { tabId: string; path: NodePath; node: PathNavigation } = $props();
	const editable = $derived(canEdit());
	const draft = $derived(getDraft(tabId));
	const mm = $derived(getMetamodel());
	function patch(next: Partial<PathNavigation>) {
		if (!draft) return;
		updateDefinition(
			tabId,
			updateNodeAt(draft.definition, path, (n) => ({ ...(n as PathNavigation), ...next }))
		);
	}

	// Types flowing into relationship step `i` (rel-type/target-type picker
	// scope), and the property-picker scope for filter step `i` — both derive
	// from the nearest preceding relationship step's target_types, else the
	// path's own start types. See `precedingTargetTypes`.
	function sourceTypesFor(i: number): string[] {
		return precedingTargetTypes(node, i);
	}
	function propertyNamesFor(i: number): string[] {
		if (!mm) return [];
		return effectivePropertiesForTypes(mm, precedingTargetTypes(node, i)).map((p) => p.name);
	}

	function setStep(i: number, next: NavStepItem): void {
		const steps = node.steps.map((s, idx) => (idx === i ? next : s));
		patch({ steps });
	}
	function removeStep(i: number): void {
		patch({ steps: node.steps.filter((_, idx) => idx !== i) });
	}
	function addRelationshipStep(): void {
		const step: NavRelationshipStep = {
			kind: 'relationship',
			relationship_type: '',
			direction: 'out',
			target_types: [],
			children: []
		};
		patch({ steps: [...node.steps, step] });
	}
	function addFilterStep(): void {
		const step: NavFilterStep = { kind: 'filter', criteria: [] };
		patch({ steps: [...node.steps, step] });
	}

	type StartMode = 'scope' | 'element' | 'combine';
	const startMode = $derived<StartMode>(
		node.start.kind === 'set_op'
			? 'combine'
			: readElementStart(node.start) !== null
				? 'element'
				: 'scope'
	);

	function setStartMode(mode: StartMode): void {
		if (mode === 'scope') patch({ start: { kind: 'scope', types: [], criteria: [] } });
		else if (mode === 'element') patch({ start: elementStartScope('') });
		else patch({ start: emptyCombine() });
	}
</script>

<div class="space-y-2 rounded border border-zinc-800 p-2">
	<div class="flex items-center gap-2 text-xs">
		<button type="button" onclick={() => toggleExpanded(tabId, path)} aria-label="Toggle preview"
			>{isExpanded(tabId, path) ? '▾' : '▸'}</button
		>
		<span class="text-zinc-400">Navigation</span>
		<label
			class="ml-auto flex items-center gap-1.5 text-zinc-400"
			title="When on, a chain never revisits an element it already contains"
		>
			<input
				type="checkbox"
				checked={node.exclude_visited}
				disabled={!editable}
				onchange={(e) => patch({ exclude_visited: e.currentTarget.checked })}
			/>
			Exclude visited
		</label>
	</div>
	<div class="flex items-center gap-2 text-xs">
		<span class="text-zinc-400">Start from</span>
		<select
			aria-label="Start mode"
			disabled={!editable}
			value={startMode}
			onchange={(e) => setStartMode(e.currentTarget.value as StartMode)}
			class="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5"
		>
			<option value="scope">Filter</option>
			<option value="element">Element</option>
			<option value="combine">Combination</option>
		</select>
	</div>
	{#if node.start.kind === 'scope'}
		{#if startMode === 'element'}
			<ElementStartPicker
				value={readElementStart(node.start)}
				onPick={(id) => patch({ start: elementStartScope(id) })}
			/>
		{:else}
			<ScopeEditor scope={node.start} label="Start" onChange={(s: NavScope) => patch({ start: s })} />
		{/if}
	{:else if node.start.kind === 'set_op'}
		<NavigationNode {tabId} path={[...path, 'start']} />
	{/if}
	{#each node.steps as step, i (i)}
		{#if step.kind === 'relationship'}
			<RelationshipStepRow
				step={step as NavRelationshipStep}
				index={i}
				sourceTypes={sourceTypesFor(i)}
				onChange={setStep}
				onRemove={removeStep}
			/>
		{:else}
			<FilterStepRow
				step={step as NavFilterStep}
				index={i}
				propertyNames={propertyNamesFor(i)}
				onChange={setStep}
				onRemove={removeStep}
			/>
		{/if}
	{/each}
	<div class="flex items-center gap-3 text-xs">
		<button type="button" class="text-sky-500 hover:text-sky-300" onclick={addRelationshipStep}
			>+ relationship step</button
		>
		<button type="button" class="text-sky-500 hover:text-sky-300" onclick={addFilterStep}
			>+ filter step</button
		>
	</div>
	{#if isExpanded(tabId, path)}
		<ChainPreview {tabId} {path} />
	{/if}
</div>
