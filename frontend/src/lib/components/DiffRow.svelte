<script lang="ts">
	import type { Element, Relationship } from '$lib/api/types';
	import type { EntityDiff, EntityStatus } from '$lib/state';

	type Props = {
		diff: EntityDiff;
		kind: 'element' | 'relationship';
		onDiscard?: (id: string) => void;
	};

	const { diff, kind, onDiscard }: Props = $props();

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
			? 'text-success'
			: status === 'modified'
				? 'text-warning'
				: 'text-destructive'
	);
</script>

<div class="flex flex-col gap-1 rounded border border-border bg-muted/40 px-2 py-1.5 text-xs">
	<div class="flex items-center gap-2">
		<span class="w-3 font-mono {glyphClass}" aria-label={status}>{glyphChar}</span>
		<span class="font-mono text-foreground">{label}</span>
		{#if typeName}
			<span
				class="rounded border border-input bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
			>
				{typeName}
			</span>
		{/if}
		<span class="ml-auto font-mono text-[10px] text-muted-foreground/70">{diff.id}</span>
		{#if onDiscard}
			<button
				type="button"
				class="rounded border border-input px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-ring hover:text-foreground"
				onclick={() => onDiscard?.(diff.id)}
			>
				Discard
			</button>
		{/if}
	</div>

	{#if kind === 'relationship' && status === 'added'}
		{@const eps = endpoints(diff.after)}
		{#if eps}
			<div class="pl-5 font-mono text-[11px] text-muted-foreground">{eps}</div>
		{/if}
	{/if}

	{#if status === 'modified' && diff.modifiedFields && diff.modifiedFields.length > 0}
		<ul class="flex flex-col gap-0.5 pl-5">
			{#each diff.modifiedFields as field (field)}
				<li class="font-mono text-[11px] text-muted-foreground">
					<span class="text-muted-foreground/70">{field}:</span>
					<span class="text-destructive/80 line-through">{formatValue(beforeValue(field))}</span>
					<span class="text-muted-foreground/70"> → </span>
					<span class="text-success">{formatValue(afterValue(field))}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
