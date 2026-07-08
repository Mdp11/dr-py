<script lang="ts">
	import { Trash2 } from '@lucide/svelte';
	import { getArtifactHeaders } from '$lib/state';
	import type { NavOperand, SetExpression } from '$lib/api/types';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';

	type Props = { expr: SetExpression; onChange: (next: SetExpression) => void };
	let { expr, onChange }: Props = $props();

	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));
	let addOpen = $state(false);

	function nameFor(op: NavOperand): string {
		if (op.ref) return navHeaders.find((h) => h.id === op.ref)?.name ?? op.ref;
		return op.definition?.kind === 'path' ? '(inline path)' : '(inline set)';
	}
	function addRef(name: string): void {
		const header = navHeaders.find((h) => h.name === name);
		if (!header) return;
		onChange({ ...expr, operands: [...expr.operands, { ref: header.id }] });
	}
	function removeOperand(i: number): void {
		onChange({ ...expr, operands: expr.operands.filter((_, idx) => idx !== i) });
	}
	function setStepIndex(i: number, raw: string): void {
		const operands = [...expr.operands];
		operands[i] = { ...operands[i], step_index: raw === '' ? null : Number(raw) };
		onChange({ ...expr, operands });
	}
</script>

<div class="space-y-1.5 rounded border border-zinc-800 p-2 text-xs">
	<div class="flex items-center gap-2">
		<span class="text-zinc-400">Set operation</span>
		<select
			class="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5"
			value={expr.op}
			onchange={(e) => onChange({ ...expr, op: e.currentTarget.value as SetExpression['op'] })}
		>
			<option value="union">union</option>
			<option value="intersection">intersection</option>
			<option value="difference">difference</option>
			<option value="symmetric_difference">symmetric difference</option>
		</select>
	</div>
	<ul class="space-y-1">
		{#each expr.operands as op, i (i)}
			<li class="flex items-center gap-2">
				<span class="flex-1 truncate">{nameFor(op)}</span>
				<label class="text-zinc-500">
					step
					<input
						class="w-10 rounded border border-zinc-700 bg-zinc-900 px-1"
						type="number"
						min="0"
						value={op.step_index ?? ''}
						placeholder="last"
						oninput={(e) => setStepIndex(i, e.currentTarget.value)}
					/>
				</label>
				<button
					type="button"
					class="text-zinc-500 hover:text-red-400"
					onclick={() => removeOperand(i)}><Trash2 class="size-3" /></button
				>
			</li>
		{/each}
	</ul>
	<StereotypePicker
		mode="create"
		names={navHeaders.map((h) => h.name)}
		onPick={addRef}
		open={addOpen}
		onOpenChange={(v) => (addOpen = v)}
		searchPlaceholder="Add saved navigation…"
	>
		{#snippet trigger()}
			<span class="cursor-pointer text-sky-500 hover:text-sky-300">+ operand</span>
		{/snippet}
	</StereotypePicker>
</div>
