<script lang="ts">
	import type { Element } from '$lib/api/types';
	import { buildPickerTypeOptions, outCountsByType } from '$lib/metamodel/connection-rules';
	import {
		createTempId,
		emit,
		ensureElement,
		getCachedElements,
		getCachedRelationships,
		getMetamodel,
		seedRelationships
	} from '$lib/state';
	import { connectLock } from '$lib/state/edit-gate';
	import { fetchElementsOfType } from '$lib/state/element-queries';
	import { listElementRelationships } from '$lib/api/model-read';
	import { elementDisplayName as displayName } from '$lib/util/element-name';
	import { SvelteMap } from 'svelte/reactivity';
	import { Plus, X } from '@lucide/svelte';

	type Props = {
		sourceId: string;
	};

	let { sourceId }: Props = $props();

	const mm = $derived(getMetamodel());
	const elements = $derived(getCachedElements());
	const relationships = $derived(getCachedRelationships());

	$effect(() => {
		void ensureElement(sourceId);
	});

	const source = $derived(elements.get(sourceId) ?? null);

	let expanded = $state(false);
	let showAll = $state(false);
	let selectedType = $state<string>('');
	let selectedTarget = $state<string>('');

	// Seed this source's outgoing relationships once expanded, so out-counts
	// (and thus the multiplicity gray-out) are available. The list itself is
	// derived from the reactive cache, so optimistic emits update counts live.
	const SEED_LIMIT = 500;
	$effect(() => {
		if (!expanded) return;
		const id = sourceId;
		void (async () => {
			try {
				const page = await listElementRelationships(id, { direction: 'out', limit: SEED_LIMIT });
				seedRelationships(page.items);
			} catch (err) {
				console.error('Failed to seed source relationships', err);
			}
		})();
	});

	const outCounts = $derived(outCountsByType(relationships.values(), sourceId));

	const typeOptions = $derived.by(() => {
		if (mm === null || source === null) return [];
		return buildPickerTypeOptions(mm, source.type_name, outCounts, showAll);
	});

	const chosenOption = $derived(
		selectedType === '' ? null : (typeOptions.find((o) => o.rt.name === selectedType) ?? null)
	);

	// Candidate targets are fetched server-side per chosen type, across the
	// UNION of its allowed target types (a type can map to several).
	const TARGET_CAP = 200;
	let candidateTargets: Element[] = $state([]);
	let candidatesTotal = $state(0);
	let candidatesTotalExact = $state(true);
	let fetchSeq = 0;

	$effect(() => {
		const meta = mm;
		const opt = chosenOption;
		const seq = ++fetchSeq;
		if (meta === null || opt === null) {
			candidateTargets = [];
			candidatesTotal = 0;
			candidatesTotalExact = true;
			return;
		}
		void (async () => {
			try {
				const byId = new SvelteMap<string, Element>();
				let total = 0;
				let exact = true;
				for (const targetType of opt.targetTypes) {
					const remaining = TARGET_CAP - byId.size;
					if (remaining <= 0) {
						exact = false;
						break;
					}
					const res = await fetchElementsOfType(meta, targetType, remaining);
					if (seq !== fetchSeq) return;
					for (const el of res.elements) byId.set(el.id, el);
					total += res.total;
					if (!res.totalIsExact) exact = false;
				}
				if (seq !== fetchSeq) return;
				candidateTargets = [...byId.values()].sort((a, b) =>
					displayName(a).localeCompare(displayName(b))
				);
				candidatesTotal = total;
				candidatesTotalExact = exact;
			} catch (err) {
				if (seq !== fetchSeq) return;
				candidateTargets = [];
				candidatesTotal = 0;
				candidatesTotalExact = true;
				console.error('Target candidates fetch failed', err);
			}
		})();
	});

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

	async function create(): Promise<void> {
		if (selectedType === '' || selectedTarget === '') return;
		if (!(await connectLock(sourceId, selectedTarget))) return;
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
		showAll = false;
		expanded = false;
	}

	function optionLabel(o: (typeof typeOptions)[number]): string {
		const targets = o.targetTypes.join(' | ');
		const base = `${o.rt.name} → ${targets}`;
		if (o.disabled) return `${base}  (max ${o.outCount}/${o.max})`;
		return base;
	}

	const selectCls =
		'h-7 w-full rounded border border-zinc-800 bg-zinc-900 px-1 text-xs text-zinc-100 outline-none focus:border-zinc-600';
</script>

<div class="flex flex-col">
	{#if !expanded}
		{#if mm === null || source === null}
			<p class="text-[11px] italic text-zinc-500">(loading…)</p>
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

			<label class="flex items-center gap-1 text-[10px] text-zinc-400">
				<input
					type="checkbox"
					checked={showAll}
					onchange={(e) => {
						showAll = (e.target as HTMLInputElement).checked;
						selectedType = '';
						selectedTarget = '';
					}}
				/>
				Show all types
			</label>

			<label class="flex flex-col gap-1">
				<span class="text-[10px] text-zinc-500">Type</span>
				<select class={selectCls} value={selectedType} onchange={onTypeChange}>
					<option value="">(choose type)</option>
					{#each typeOptions as o (o.rt.name)}
						<option
							value={o.rt.name}
							disabled={o.disabled}
							title={o.disabled
								? `${source?.type_name} already has ${o.outCount}/${o.max} ${o.rt.name} target(s)`
								: o.allowed
									? undefined
									: 'Not allowed by the metamodel from this source type'}
						>
							{optionLabel(o)}{o.allowed ? '' : '  (off-metamodel)'}
						</option>
					{/each}
				</select>
				{#if typeOptions.length === 0}
					<span class="text-[10px] italic text-zinc-500">
						(no valid relationships from this type)
					</span>
				{/if}
			</label>

			{#if chosenOption !== null}
				<label class="flex flex-col gap-1">
					<span class="text-[10px] text-zinc-500"
						>Target ({chosenOption.targetTypes.join(' | ')})</span
					>
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
							No elements of type {chosenOption.targetTypes.join(' | ')} (or subtype) exist.
						</span>
					{:else if candidatesTotal > candidateTargets.length || !candidatesTotalExact}
						<span class="text-[10px] italic text-zinc-500">
							Showing the first {candidateTargets.length} of {candidatesTotal}{candidatesTotalExact
								? ''
								: '+'} candidates.
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
