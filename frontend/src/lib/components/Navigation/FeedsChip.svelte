<script lang="ts">
	// "→ feeds ⟨2⟩ last step" — WHICH chain column of this path feeds the
	// combination it is a part of. Writes `step_index`: null = the last step
	// (the backend default), 0 = the start, k = chain column k. Only PATH parts
	// get a chip; a combination part contributes its members and has no steps
	// to feed (the backend rejects a non-0/null step_index for a set operand).
	import { Popover } from 'bits-ui';
	import type { ChainColumn } from '$lib/navigation/tree';
	import ChainBadge from './ChainBadge.svelte';

	let {
		columns,
		value,
		disabled = false,
		onPick
	}: {
		columns: ChainColumn[];
		value: number | null;
		disabled?: boolean;
		onPick: (v: number | null) => void;
	} = $props();

	let open = $state(false);
	const lastIndex = $derived(columns.length - 1);
	const shownIndex = $derived(value === null ? lastIndex : Math.min(value, lastIndex));
	const shownLabel = $derived(
		value === null
			? 'last step'
			: value === 0
				? 'the start'
				: `after ${columns[value]?.label ?? 'step'}`
	);

	function pick(v: number | null): void {
		onPick(v);
		open = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		{disabled}
		data-testid="feeds-chip"
		title="Which elements this path contributes to the combination"
		class="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-40"
	>
		→ feeds <ChainBadge value={shownIndex} tone="combine" size="sm" />
		{shownLabel} ▾
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			align="end"
			sideOffset={4}
			class="z-50 w-[300px] rounded-md border border-zinc-700 bg-zinc-900 p-1.5 text-xs shadow-xl"
		>
			<p class="px-1.5 pt-0.5 pb-1.5 text-zinc-500">
				Feed the combination with the elements reached at…
			</p>
			{#each columns as col (col.index)}
				{@const isLast = col.index === lastIndex}
				<button
					type="button"
					data-testid="feeds-option"
					class="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-zinc-800"
					onclick={() => pick(isLast ? null : col.index)}
				>
					<ChainBadge value={col.index} tone="combine" size="sm" />
					<span class="text-zinc-200">
						{col.index === 0 && !isLast
							? 'the start'
							: isLast
								? 'the last step'
								: `after ${col.label}`}
					</span>
					<span class="ml-auto text-[10px] text-zinc-500">
						{isLast ? 'default' : (col.sub ?? '')}
					</span>
				</button>
			{/each}
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
