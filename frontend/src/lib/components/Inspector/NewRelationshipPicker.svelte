<script lang="ts">
	import type { Element, RelationshipType } from '$lib/api/types';
	import { isSubtype } from '$lib/metamodel/helpers';
	import { createTempId, emit, ensureElement, getCachedElements, getMetamodel } from '$lib/state';
	import { fetchElementsOfType } from '$lib/state/element-queries';
	import { Plus, X } from '@lucide/svelte';

	type Props = {
		sourceId: string;
	};

	let { sourceId }: Props = $props();

	const mm = $derived(getMetamodel());
	const elements = $derived(getCachedElements());

	$effect(() => {
		void ensureElement(sourceId);
	});

	const source = $derived(elements.get(sourceId) ?? null);

	const availableTypes = $derived.by((): RelationshipType[] => {
		if (mm === null || source === null) return [];
		return mm.relationships
			.filter((rt) => !rt.abstract)
			.filter((rt) => isSubtype(mm, source.type_name, rt.source))
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name));
	});

	let expanded = $state(false);
	let selectedType = $state<string>('');
	let selectedTarget = $state<string>('');

	const chosenType = $derived.by((): RelationshipType | null => {
		if (mm === null || selectedType === '') return null;
		return mm.relationships.find((rt) => rt.name === selectedType) ?? null;
	});

	// Candidate targets are fetched server-side (paged, capped) per chosen
	// relationship type — the client no longer scans a whole-model snapshot.
	const TARGET_CAP = 200;
	let candidateTargets: Element[] = $state([]);
	let candidatesTotal = $state(0);
	let fetchSeq = 0;

	$effect(() => {
		const meta = mm;
		const t = chosenType;
		const seq = ++fetchSeq;
		if (meta === null || t === null) {
			candidateTargets = [];
			candidatesTotal = 0;
			return;
		}
		void (async () => {
			try {
				const res = await fetchElementsOfType(meta, t.target, TARGET_CAP);
				if (seq !== fetchSeq) return;
				candidateTargets = res.elements;
				candidatesTotal = res.total;
			} catch (err) {
				if (seq !== fetchSeq) return;
				candidateTargets = [];
				candidatesTotal = 0;
				console.error('Target candidates fetch failed', err);
			}
		})();
	});

	function displayName(el: Element): string {
		const n = el.properties?.name;
		return typeof n === 'string' && n.length > 0 ? n : el.id;
	}

	function reset(): void {
		selectedType = '';
		selectedTarget = '';
	}

	function onTypeChange(e: Event): void {
		selectedType = (e.target as HTMLSelectElement).value;
		selectedTarget = '';
	}

	function onTargetChange(e: Event): void {
		selectedTarget = (e.target as HTMLSelectElement).value;
	}

	function create(): void {
		if (selectedType === '' || selectedTarget === '') return;
		emit({
			kind: 'create_relationship',
			temp_id: createTempId(),
			type_name: selectedType,
			source_id: sourceId,
			target_id: selectedTarget,
			properties: {}
		});
		reset();
	}

	function cancel(): void {
		reset();
		expanded = false;
	}

	const selectCls =
		'h-7 w-full rounded border border-zinc-800 bg-zinc-900 px-1 text-xs text-zinc-100 outline-none focus:border-zinc-600';
</script>

<div class="flex flex-col">
	{#if !expanded}
		{#if availableTypes.length === 0}
			<p class="text-[11px] italic text-zinc-500">(no valid relationships from this type)</p>
		{:else}
			<button
				type="button"
				class="inline-flex w-fit items-center gap-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
				onclick={() => (expanded = true)}
			>
				<Plus class="h-3 w-3" /> New relationship
			</button>
		{/if}
	{:else}
		<div class="flex flex-col gap-2 rounded border border-zinc-800 bg-zinc-950 p-2">
			<div class="flex items-center justify-between">
				<span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
					New relationship
				</span>
				<button
					type="button"
					class="rounded p-0.5 text-zinc-500 hover:text-zinc-200"
					onclick={cancel}
					aria-label="Cancel"
				>
					<X class="h-3 w-3" />
				</button>
			</div>

			<label class="flex flex-col gap-1">
				<span class="text-[10px] text-zinc-500">Type</span>
				<select class={selectCls} value={selectedType} onchange={onTypeChange}>
					<option value="">(choose type)</option>
					{#each availableTypes as rt (rt.name)}
						<option value={rt.name}>{rt.name} → {rt.target}</option>
					{/each}
				</select>
			</label>

			{#if chosenType !== null}
				<label class="flex flex-col gap-1">
					<span class="text-[10px] text-zinc-500">Target ({chosenType.target})</span>
					<select class={selectCls} value={selectedTarget} onchange={onTargetChange}>
						<option value="">(choose target)</option>
						{#each candidateTargets as el (el.id)}
							<option value={el.id}>
								{displayName(el)} — {el.type_name}
							</option>
						{/each}
					</select>
					{#if candidateTargets.length === 0}
						<span class="text-[10px] italic text-zinc-500">
							No elements of type {chosenType.target} (or subtype) exist.
						</span>
					{:else if candidatesTotal > candidateTargets.length}
						<span class="text-[10px] italic text-zinc-500">
							Showing the first {candidateTargets.length} of {candidatesTotal} candidates.
						</span>
					{/if}
				</label>
			{/if}

			<div class="flex justify-end gap-1">
				<button
					type="button"
					class="rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
					onclick={cancel}
				>
					Cancel
				</button>
				<button
					type="button"
					class="rounded border border-zinc-700 bg-blue-900/40 px-2 py-0.5 text-[11px] text-zinc-100 hover:bg-blue-900/60 disabled:cursor-not-allowed disabled:opacity-50"
					disabled={selectedType === '' || selectedTarget === ''}
					onclick={create}
				>
					Create
				</button>
			</div>
		</div>
	{/if}
</div>
