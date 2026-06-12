<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import type { Element, Relationship } from '$lib/api/types';
	import type { EntityDiff } from '$lib/state/diff';

	type Props = { diff: EntityDiff; mode: 'split' | 'unified' };
	let { diff, mode }: Props = $props();

	const badge = $derived(diff.status === 'added' ? '+' : diff.status === 'deleted' ? '-' : '~');
	const badgeClass = $derived(
		diff.status === 'added'
			? 'bg-green-500/20 text-green-300'
			: diff.status === 'deleted'
				? 'bg-red-500/20 text-red-300'
				: 'bg-yellow-500/20 text-yellow-200'
	);

	const before = $derived(diff.before ?? null);
	const after = $derived(diff.after ?? null);
	const entity = $derived((after ?? before) as Element | Relationship);

	function isRelationship(e: Element | Relationship): e is Relationship {
		return 'source_id' in e && 'target_id' in e;
	}

	/** Unified list of row keys to render. For relationships, endpoint keys come first. */
	function rowKeys(b: typeof before, a: typeof after): string[] {
		const keys = new SvelteSet<string>();
		if (b) for (const k of Object.keys(b.properties)) keys.add(k);
		if (a) for (const k of Object.keys(a.properties)) keys.add(k);
		const propRows = [...keys];

		const ref = a ?? b;
		if (ref && isRelationship(ref)) {
			return ['source_id', 'target_id', ...propRows];
		}
		return propRows;
	}

	const ENDPOINT_KEYS = new Set(['source_id', 'target_id']);

	/** Get the value for a row key from an entity snapshot. */
	function getValue(snapshot: typeof before, key: string): unknown {
		if (!snapshot) return undefined;
		if (ENDPOINT_KEYS.has(key) && isRelationship(snapshot)) {
			return (snapshot as Relationship)[key as 'source_id' | 'target_id'];
		}
		return snapshot.properties[key];
	}

	function changed(key: string): boolean {
		return JSON.stringify(getValue(before, key)) !== JSON.stringify(getValue(after, key));
	}

	function fmt(v: unknown): string {
		return v === undefined ? '—' : JSON.stringify(v);
	}
</script>

<div class="border-t border-zinc-700">
	<div class="flex items-center gap-2 px-3 py-2 text-sm">
		<span
			class={`inline-flex h-5 w-5 items-center justify-center rounded font-mono font-bold ${badgeClass}`}
			>{badge}</span
		>
		<span class="font-semibold text-indigo-300">{entity.type_name}</span>
		<span class="font-mono text-xs text-zinc-400">{diff.id}</span>
	</div>

	{#if mode === 'split'}
		<div class="grid grid-cols-2 font-mono text-xs">
			<div class="border-r border-zinc-700 px-3 pb-3">
				<div class="mb-1 text-[10px] uppercase text-zinc-500">Before</div>
				{#if before}
					{#each rowKeys(before, after) as key (key)}
						<div
							class={`rounded px-1.5 py-0.5 ${changed(key) ? 'bg-red-500/15 text-red-300' : 'text-zinc-400'}`}
						>
							{key}: {fmt(getValue(before, key))}
						</div>
					{/each}
				{:else}
					<div class="italic text-zinc-600">— not present —</div>
				{/if}
			</div>
			<div class="px-3 pb-3">
				<div class="mb-1 text-[10px] uppercase text-zinc-500">After</div>
				{#if after}
					{#each rowKeys(before, after) as key (key)}
						<div
							class={`rounded px-1.5 py-0.5 ${changed(key) ? 'bg-green-500/15 text-green-300' : 'text-zinc-400'}`}
						>
							{key}: {fmt(getValue(after, key))}
						</div>
					{/each}
				{:else}
					<div class="italic text-zinc-600">— removed —</div>
				{/if}
			</div>
		</div>
	{:else}
		<div class="px-3 pb-3 font-mono text-xs">
			{#each rowKeys(before, after) as key (key)}
				{#if changed(key)}
					{#if before}
						<div class="rounded bg-red-500/15 px-1.5 py-0.5 text-red-300">
							- {key}: {fmt(getValue(before, key))}
						</div>
					{/if}
					{#if after}
						<div class="rounded bg-green-500/15 px-1.5 py-0.5 text-green-300">
							+ {key}: {fmt(getValue(after, key))}
						</div>
					{/if}
				{:else}
					<div class="px-1.5 py-0.5 text-zinc-400">
						{key}: {fmt(getValue(after ?? before, key))}
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
