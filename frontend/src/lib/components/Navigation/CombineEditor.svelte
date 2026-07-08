<script lang="ts">
	import { Trash2, ChevronUp, ChevronDown } from '@lucide/svelte';
	import {
		canEdit,
		getArtifactHeaders,
		isExpanded,
		toggleExpanded,
		updateDefinition,
		getDraft
	} from '$lib/state';
	import {
		insertGroup,
		insertNavigation,
		insertRef,
		moveOperand,
		operandLabel,
		removeOperand,
		updateNodeAt as updateNodeAtLocal
	} from '$lib/navigation/tree';
	import type { NodePath } from '$lib/navigation/tree';
	import type { NavOperand, NavigationDefinition, SetExpression } from '$lib/api/types';
	import NavigationNode from './NavigationNode.svelte';
	import ChainPreview from './ChainPreview.svelte';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';

	let { tabId, path, node }: { tabId: string; path: NodePath; node: SetExpression } = $props();
	const editable = $derived(canEdit());
	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));
	const draft = $derived(getDraft(tabId));
	let addOpen = $state(false);

	function mutate(next: (root: NavigationDefinition) => NavigationDefinition) {
		if (!draft) return;
		updateDefinition(tabId, next(draft.definition));
	}
	function setOp(op: SetExpression['op']) {
		mutate((root) => updateNodeAtLocal(root, path, (n) => ({ ...(n as SetExpression), op })));
	}
	function setStepIndex(i: number, raw: string) {
		mutate((root) =>
			updateNodeAtLocal(root, path, (n) => {
				const s = n as SetExpression;
				const operands = s.operands.map(
					(op, idx): NavOperand =>
						idx === i ? { ...op, step_index: raw === '' ? null : Number(raw) } : op
				);
				return { ...s, operands };
			})
		);
	}
	function refName(op: NavOperand): string | undefined {
		return op.ref ? navHeaders.find((h) => h.id === op.ref)?.name : undefined;
	}
</script>

<div class="space-y-1.5 rounded border border-zinc-800 p-2 text-xs">
	<div class="flex items-center gap-2">
		<button type="button" onclick={() => toggleExpanded(tabId, path)} aria-label="Toggle preview">
			{isExpanded(tabId, path) ? '▾' : '▸'}
		</button>
		<span class="text-zinc-400">Combine</span>
		<select
			disabled={!editable}
			value={node.op}
			onchange={(e) => setOp(e.currentTarget.value as SetExpression['op'])}
			class="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5"
		>
			<option value="union">union</option>
			<option value="intersection">intersection</option>
			<option value="difference">difference</option>
			<option value="symmetric_difference">symmetric difference</option>
		</select>
	</div>
	<ul class="space-y-1 border-l border-zinc-800 pl-2">
		{#each node.operands as op, i (i)}
			<li class="space-y-1">
				<div class="flex items-center gap-2">
					<span class="flex-1 truncate">
						{operandLabel(op, refName(op))}
						{#if node.op === 'difference'}
							<span class="ml-1 rounded bg-zinc-800 px-1 text-[10px] text-zinc-400"
								>{i === 0 ? 'base' : 'subtracted'}</span
							>
						{/if}
					</span>
					<label class="text-zinc-500"
						>step
						<input
							type="number"
							min="0"
							class="w-10 rounded border border-zinc-700 bg-zinc-900 px-1"
							value={op.step_index ?? ''}
							placeholder="last"
							oninput={(e) => setStepIndex(i, e.currentTarget.value)}
						/>
					</label>
					<button
						type="button"
						aria-label="Move up"
						disabled={i === 0}
						onclick={() => mutate((r) => moveOperand(r, path, i, 'up'))}
						><ChevronUp class="size-3" /></button
					>
					<button
						type="button"
						aria-label="Move down"
						disabled={i === node.operands.length - 1}
						onclick={() => mutate((r) => moveOperand(r, path, i, 'down'))}
						><ChevronDown class="size-3" /></button
					>
					<button
						type="button"
						aria-label="Remove operand"
						class="hover:text-red-400"
						onclick={() => mutate((r) => removeOperand(r, path, i))}
						><Trash2 class="size-3" /></button
					>
				</div>
				{#if op.definition}
					<NavigationNode {tabId} path={[...path, i]} />
				{/if}
			</li>
		{/each}
	</ul>
	{#if editable}
		<div class="flex gap-3">
			<button
				type="button"
				class="text-sky-500 hover:text-sky-300"
				onclick={() => mutate((r) => insertNavigation(r, path))}>+ insert navigation</button
			>
			<button
				type="button"
				class="text-sky-500 hover:text-sky-300"
				onclick={() => mutate((r) => insertGroup(r, path))}>+ group</button
			>
			<StereotypePicker
				mode="create"
				names={navHeaders.map((h) => h.name)}
				onPick={(name) => {
					const h = navHeaders.find((x) => x.name === name);
					if (h) mutate((r) => insertRef(r, path, h.id));
				}}
				open={addOpen}
				onOpenChange={(v) => (addOpen = v)}
				searchPlaceholder="Add saved navigation…"
			>
				{#snippet trigger()}<span class="cursor-pointer text-sky-500 hover:text-sky-300"
						>+ from library</span
					>{/snippet}
			</StereotypePicker>
		</div>
	{/if}
	{#if isExpanded(tabId, path)}
		<ChainPreview {tabId} {path} />
	{/if}
</div>
