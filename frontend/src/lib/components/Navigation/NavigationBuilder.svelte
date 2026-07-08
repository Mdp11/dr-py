<script lang="ts">
	import {
		canEdit,
		ensureDraft,
		getDraft,
		getSaveConflict,
		reloadDraft,
		saveDraft,
		setDraftName,
		updateDefinition
	} from '$lib/state';
	import type { NavScope, NavStep, PathNavigation, SetExpression } from '$lib/api/types';
	import ScopeEditor from './ScopeEditor.svelte';
	import StepRow from './StepRow.svelte';
	import SetExpressionEditor from './SetExpressionEditor.svelte';
	import ChainPreview from './ChainPreview.svelte';

	let { tabId }: { tabId: string } = $props();
	$effect(() => {
		void ensureDraft(tabId);
	});
	const draft = $derived(getDraft(tabId));
	const conflict = $derived(getSaveConflict(tabId));
	const editable = $derived(canEdit());
	let saveError = $state<string | null>(null);

	const path = $derived(
		draft?.definition.kind === 'path' ? (draft.definition as PathNavigation) : null
	);
	const setExpr = $derived(
		draft?.definition.kind === 'set_op' ? (draft.definition as SetExpression) : null
	);
	// Types flowing into step i: previous step's target types, or the start
	// scope's types for step 0 ([] = unconstrained).
	function sourceTypesFor(i: number): string[] {
		if (!path) return [];
		if (i === 0) return path.start.kind === 'scope' ? path.start.types : [];
		return path.steps[i - 1].target.types;
	}

	function patchPath(next: Partial<PathNavigation>): void {
		if (!path) return;
		updateDefinition(tabId, { ...path, ...next });
	}
	function setStep(i: number, next: NavStep): void {
		if (!path) return;
		patchPath({ steps: path.steps.map((s, idx) => (idx === i ? next : s)) });
	}
	function removeStep(i: number): void {
		if (!path) return;
		patchPath({ steps: path.steps.filter((_, idx) => idx !== i) });
	}
	function addStep(): void {
		if (!path) return;
		patchPath({
			steps: [
				...path.steps,
				{
					relationship_type: '',
					direction: 'out',
					target: { kind: 'scope', types: [], criteria: [] },
					children: []
				}
			]
		});
	}
	function toSetExpression(): void {
		if (!draft) return;
		// Seed operand[0] with the current path INLINE (spec: "current draft
		// inline"), so switching modes loses nothing.
		const operands = path ? [{ definition: path, step_index: null }] : [];
		updateDefinition(tabId, {
			kind: 'set_op',
			schema_version: 1,
			op: 'union',
			operands
		} as SetExpression);
	}
	function toPath(): void {
		updateDefinition(tabId, {
			kind: 'path',
			schema_version: 1,
			start: { kind: 'scope', types: [], criteria: [] },
			steps: []
		} as PathNavigation);
	}
	async function save(): Promise<void> {
		saveError = null;
		try {
			await saveDraft(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}
</script>

{#if !draft}
	<p class="p-4 text-xs text-zinc-500">Loading…</p>
{:else}
	<div class="flex h-full flex-col">
		<div class="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
			<input
				class="w-56 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
				value={draft.name}
				disabled={!editable}
				oninput={(e) => setDraftName(tabId, e.currentTarget.value)}
			/>
			<div class="flex rounded border border-zinc-700 text-xs">
				<button type="button" class="px-2 py-0.5 {path ? 'bg-zinc-700' : ''}" onclick={toPath}
					>Path</button
				>
				<button
					type="button"
					class="px-2 py-0.5 {setExpr ? 'bg-zinc-700' : ''}"
					onclick={toSetExpression}>Set op</button
				>
			</div>
			{#if editable}
				<button
					type="button"
					class="ml-auto rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-40"
					disabled={!draft.dirty && draft.artifactId !== null}
					onclick={() => void save()}
				>
					Save{draft.dirty ? ' *' : ''}
				</button>
			{/if}
		</div>
		{#if conflict !== undefined}
			<div class="flex items-center gap-2 bg-amber-950/60 px-3 py-1.5 text-xs text-amber-300">
				Someone else modified this navigation.
				<button type="button" class="underline" onclick={() => void reloadDraft(tabId)}>
					Reload their version
				</button>
			</div>
		{/if}
		{#if saveError}
			<p class="px-3 py-1 text-xs text-red-400">{saveError}</p>
		{/if}
		<div class="min-h-0 flex-1 space-y-2 overflow-auto p-3">
			{#if path}
				{#if path.start.kind === 'scope'}
					<ScopeEditor
						scope={path.start}
						label="Start"
						onChange={(next: NavScope) => patchPath({ start: next })}
					/>
				{:else}
					<SetExpressionEditor expr={path.start} onChange={(next) => patchPath({ start: next })} />
				{/if}
				{#each path.steps as step, i (i)}
					<StepRow
						{step}
						index={i}
						sourceTypes={sourceTypesFor(i)}
						onChange={setStep}
						onRemove={removeStep}
					/>
				{/each}
				<button type="button" class="text-xs text-sky-500 hover:text-sky-300" onclick={addStep}
					>+ add step</button
				>
			{:else if setExpr}
				<SetExpressionEditor expr={setExpr} onChange={(next) => updateDefinition(tabId, next)} />
			{/if}
		</div>
		<ChainPreview {tabId} />
	</div>
{/if}
