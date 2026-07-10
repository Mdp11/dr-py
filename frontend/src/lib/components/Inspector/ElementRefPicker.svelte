<script lang="ts">
	import type { Element } from '$lib/api/types';
	import { ensureElement, getCachedElements, getMetamodel } from '$lib/state';
	import { fetchElementsOfType } from '$lib/state/element-queries';
	import { elementDisplayName as displayName } from '$lib/util/element-name';
	import { X } from '@lucide/svelte';

	type Props = {
		valueId: string | null;
		targetTypeName: string;
		onChange: (id: string | null) => void;
	};

	let { valueId, targetTypeName, onChange }: Props = $props();

	let open = $state(false);

	const mm = $derived(getMetamodel());
	const elements = $derived(getCachedElements());

	// Candidates are fetched on open (paged, capped) instead of scanning a
	// whole-model snapshot.
	const CANDIDATE_CAP = 200;
	let candidates: Element[] = $state([]);
	let candidatesTotal = $state(0);
	// false = subtype queries were skipped once the cap was hit, so the total
	// is a lower bound ("N+")
	let candidatesTotalExact = $state(true);
	let fetchSeq = 0;

	$effect(() => {
		const meta = mm;
		const isOpen = open;
		const typeName = targetTypeName;
		const seq = ++fetchSeq;
		if (!isOpen || meta === null) return;
		void (async () => {
			try {
				const res = await fetchElementsOfType(meta, typeName, CANDIDATE_CAP);
				if (seq !== fetchSeq) return;
				candidates = res.elements;
				candidatesTotal = res.total;
				candidatesTotalExact = res.totalIsExact;
			} catch (err) {
				if (seq !== fetchSeq) return;
				candidates = [];
				candidatesTotal = 0;
				candidatesTotalExact = true;
				console.error('Reference candidates fetch failed', err);
			}
		})();
	});

	// resolve the current value's display name (cache-or-fetch)
	$effect(() => {
		if (valueId !== null) void ensureElement(valueId);
	});

	const current = $derived(valueId !== null ? (elements.get(valueId) ?? null) : null);

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
			class="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/90"
		>
			<span class="truncate max-w-[160px]" title={valueId}>
				{current ? displayName(current) : valueId}
			</span>
			<button
				type="button"
				class="text-muted-foreground transition-colors hover:text-foreground"
				onclick={clear}
				aria-label="Clear reference"
			>
				<X class="h-3 w-3" />
			</button>
		</span>
	{:else}
		<span class="text-xs italic text-muted-foreground/70">unset</span>
	{/if}
	<button
		type="button"
		class="rounded border border-input bg-card px-1.5 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-muted"
		onclick={() => (open = !open)}
	>
		Browse...
	</button>
	{#if open}
		<div
			class="absolute left-0 top-full z-10 mt-1 max-h-56 w-64 overflow-auto rounded border border-border bg-popover text-xs shadow-lg"
		>
			{#if candidates.length === 0}
				<p class="px-2 py-1 text-muted-foreground/70">No matching elements.</p>
			{:else}
				<ul class="flex flex-col">
					{#each candidates as el (el.id)}
						<li>
							<button
								type="button"
								class="flex w-full items-center justify-between gap-2 px-2 py-1 text-left transition-colors hover:bg-muted"
								onclick={() => pick(el.id)}
							>
								<span class="truncate">{displayName(el)}</span>
								<span
									class="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
								>
									{el.type_name}
								</span>
							</button>
						</li>
					{/each}
				</ul>
				{#if candidatesTotal > candidates.length || !candidatesTotalExact}
					<p class="px-2 py-1 italic text-muted-foreground/70">
						Showing the first {candidates.length} of {candidatesTotal}{candidatesTotalExact
							? ''
							: '+'}.
					</p>
				{/if}
			{/if}
		</div>
	{/if}
</div>
