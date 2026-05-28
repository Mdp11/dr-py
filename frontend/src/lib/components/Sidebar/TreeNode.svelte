<script lang="ts">
	import type { Element } from '$lib/api/types';
	import { ChevronDown, ChevronRight } from '@lucide/svelte';
	import TreeNode from './TreeNode.svelte';

	type Props = {
		id: string;
		depth: number;
		elementsById: Map<string, Element>;
		childrenByParent: Map<string, string[]>;
		keepSet: Set<string>;
		collapsed: Set<string>;
		selectedId: string | null;
		onToggle: (id: string) => void;
		onPick: (id: string) => void;
	};

	let {
		id,
		depth,
		elementsById,
		childrenByParent,
		keepSet,
		collapsed,
		selectedId,
		onToggle,
		onPick
	}: Props = $props();

	const el = $derived(elementsById.get(id));
	const allChildren = $derived(childrenByParent.get(id) ?? []);
	const visibleChildren = $derived(allChildren.filter((c) => keepSet.has(c)));
	const hasChildren = $derived(visibleChildren.length > 0);
	const isCollapsed = $derived(collapsed.has(id));
	const isSelected = $derived(selectedId === id);

	function displayName(e: Element): string {
		const n = e.properties?.name;
		return typeof n === 'string' && n.length > 0 ? n : e.id;
	}
</script>

{#if el}
	<li>
		<div
			class="flex items-center gap-1 rounded px-1 py-0.5"
			class:bg-zinc-800={isSelected}
			style="padding-left: {depth * 12 + 4}px"
		>
			{#if hasChildren}
				<button
					type="button"
					class="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-200"
					onclick={() => onToggle(id)}
					aria-label={isCollapsed ? 'Expand' : 'Collapse'}
				>
					{#if isCollapsed}
						<ChevronRight class="h-3 w-3" />
					{:else}
						<ChevronDown class="h-3 w-3" />
					{/if}
				</button>
			{:else}
				<span class="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-700">•</span>
			{/if}
			<button
				type="button"
				class="flex flex-1 items-center gap-2 truncate text-left text-zinc-200 hover:text-zinc-50"
				class:font-medium={isSelected}
				onclick={() => onPick(id)}
				title={id}
			>
				<span class="truncate">{displayName(el)}</span>
				<span class="ml-auto shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">
					{el.type_name}
				</span>
			</button>
		</div>
		{#if hasChildren && !isCollapsed}
			<ul class="flex flex-col">
				{#each visibleChildren as childId (childId)}
					<TreeNode
						id={childId}
						depth={depth + 1}
						{elementsById}
						{childrenByParent}
						{keepSet}
						{collapsed}
						{selectedId}
						{onToggle}
						{onPick}
					/>
				{/each}
			</ul>
		{/if}
	</li>
{/if}
