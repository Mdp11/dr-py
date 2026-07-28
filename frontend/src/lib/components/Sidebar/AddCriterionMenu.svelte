<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { CRITERION_LABELS, type CriterionType } from '$lib/search/types';

	// The single "which criterion?" affordance. Every add-a-criterion site —
	// the advanced-search dialog, a navigation start scope, a "Keep only…"
	// filter step, an "Any of" group's alternatives — routes through this menu,
	// so the offered vocabulary and the picking gesture are identical
	// everywhere. Callers vary only in the type LIST they offer — normally
	// `criteriaForKind(target)`, minus `any_of` inside a group, since groups do
	// not nest — and in the trigger's wording/styling, owned via
	// `children`/`class`.
	type Props = {
		/** Offered types, in display order. */
		types: readonly CriterionType[];
		onAdd: (type: CriterionType) => void;
		/** Trigger styling — each host matches its surrounding chrome. */
		class?: string;
		/** Trigger contents (label, optional icon). */
		children: Snippet;
	};
	let { types, onAdd, class: className = '', children }: Props = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger class={className}>
		{@render children()}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-52">
		{#each types as t (t)}
			<DropdownMenu.Item onSelect={() => onAdd(t)}>
				{CRITERION_LABELS[t]}
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
