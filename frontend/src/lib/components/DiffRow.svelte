<script lang="ts">
	import type { Element, Relationship } from '$lib/api/types';
	import type { EntityDiff, EntityStatus } from '$lib/state';

	type Props = {
		diff: EntityDiff;
		kind: 'element' | 'relationship';
	};

	const { diff, kind }: Props = $props();

	const status = $derived(diff.status as Exclude<EntityStatus, 'unchanged'>);
	const entity = $derived((diff.after ?? diff.before) as Element | Relationship | undefined);
	const label = $derived(deriveLabel(entity));
	const typeName = $derived(entity?.type_name ?? '');

	function deriveLabel(e: Element | Relationship | undefined): string {
		if (!e) return diff.id;
		const props = e.properties as Record<string, unknown>;
		const name = props.name ?? props.label ?? props.title;
		return typeof name === 'string' && name.length > 0 ? name : e.id;
	}

	function endpoints(e: Element | Relationship | undefined): string | null {
		if (!e || !('source_id' in e)) return null;
		return `${e.source_id} → ${e.target_id}`;
	}

	function formatValue(v: unknown): string {
		if (v === undefined) return '∅';
		if (v === null) return 'null';
		if (typeof v === 'string') return JSON.stringify(v);
		if (typeof v === 'number' || typeof v === 'boolean') return String(v);
		try {
			return JSON.stringify(v);
		} catch {
			return String(v);
		}
	}

	function beforeValue(key: string): unknown {
		if (!diff.before) return undefined;
		if (key === 'source_id' && 'source_id' in diff.before) return diff.before.source_id;
		if (key === 'target_id' && 'target_id' in diff.before) return diff.before.target_id;
		return (diff.before.properties as Record<string, unknown>)[key];
	}

	function afterValue(key: string): unknown {
		if (!diff.after) return undefined;
		if (key === 'source_id' && 'source_id' in diff.after) return diff.after.source_id;
		if (key === 'target_id' && 'target_id' in diff.after) return diff.after.target_id;
		return (diff.after.properties as Record<string, unknown>)[key];
	}

	const glyphChar = $derived(status === 'added' ? '+' : status === 'modified' ? '~' : '-');
	const glyphClass = $derived(
		status === 'added'
			? 'text-emerald-400'
			: status === 'modified'
				? 'text-amber-400'
				: 'text-red-400'
	);
</script>

<div class="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5 text-xs">
	<div class="flex items-center gap-2">
		<span class="w-3 font-mono {glyphClass}" aria-label={status}>{glyphChar}</span>
		<span class="font-mono text-zinc-100">{label}</span>
		{#if typeName}
			<span
				class="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
			>
				{typeName}
			</span>
		{/if}
		<span class="ml-auto font-mono text-[10px] text-zinc-500">{diff.id}</span>
	</div>

	{#if kind === 'relationship' && status === 'added'}
		{@const eps = endpoints(diff.after)}
		{#if eps}
			<div class="pl-5 font-mono text-[11px] text-zinc-400">{eps}</div>
		{/if}
	{/if}

	{#if status === 'modified' && diff.modifiedFields && diff.modifiedFields.length > 0}
		<ul class="flex flex-col gap-0.5 pl-5">
			{#each diff.modifiedFields as field (field)}
				<li class="font-mono text-[11px] text-zinc-400">
					<span class="text-zinc-500">{field}:</span>
					<span class="text-red-300/80 line-through">{formatValue(beforeValue(field))}</span>
					<span class="text-zinc-500"> → </span>
					<span class="text-emerald-300">{formatValue(afterValue(field))}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
