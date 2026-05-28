<script lang="ts">
	import type { Element } from '$lib/api/types';
	import { isSubtype } from '$lib/metamodel/helpers';
	import { getMetamodel, getWorkingModel } from '$lib/state';
	import { X } from '@lucide/svelte';

	type Props = {
		valueId: string | null;
		targetTypeName: string;
		onChange: (id: string | null) => void;
	};

	let { valueId, targetTypeName, onChange }: Props = $props();

	let open = $state(false);

	const mm = $derived(getMetamodel());
	const working = $derived(getWorkingModel());

	const candidates = $derived.by((): Element[] => {
		if (mm === null) return [];
		return working.elements
			.filter((el) => isSubtype(mm, el.type_name, targetTypeName))
			.slice()
			.sort((a, b) => displayName(a).localeCompare(displayName(b)));
	});

	const current = $derived(
		valueId !== null ? (working.elements.find((el) => el.id === valueId) ?? null) : null
	);

	function displayName(el: Element): string {
		const n = el.properties?.name;
		return typeof n === 'string' && n.length > 0 ? n : el.id;
	}

	function pick(id: string): void {
		open = false;
		onChange(id);
	}

	function clear(): void {
		onChange(null);
	}
</script>

<div class="relative flex items-center gap-2">
	{#if valueId !== null}
		<span
			class="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200"
		>
			<span class="truncate max-w-[160px]" title={valueId}>
				{current ? displayName(current) : valueId}
			</span>
			<button
				type="button"
				class="text-zinc-500 hover:text-zinc-200"
				onclick={clear}
				aria-label="Clear reference"
			>
				<X class="h-3 w-3" />
			</button>
		</span>
	{:else}
		<span class="text-xs italic text-zinc-500">unset</span>
	{/if}
	<button
		type="button"
		class="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
		onclick={() => (open = !open)}
	>
		Browse...
	</button>
	{#if open}
		<div
			class="absolute left-0 top-full z-10 mt-1 max-h-56 w-64 overflow-auto rounded border border-zinc-800 bg-zinc-950 text-xs shadow-lg"
		>
			{#if candidates.length === 0}
				<p class="px-2 py-1 text-zinc-500">No matching elements.</p>
			{:else}
				<ul class="flex flex-col">
					{#each candidates as el (el.id)}
						<li>
							<button
								type="button"
								class="flex w-full items-center justify-between gap-2 px-2 py-1 text-left hover:bg-zinc-800"
								onclick={() => pick(el.id)}
							>
								<span class="truncate">{displayName(el)}</span>
								<span class="shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">
									{el.type_name}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
