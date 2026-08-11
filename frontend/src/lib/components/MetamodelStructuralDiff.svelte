<script lang="ts">
	import type { MetamodelStructuralDiff } from '$lib/api/types';

	type Props = { diff: MetamodelStructuralDiff };
	let { diff }: Props = $props();

	const empty = $derived(
		diff.enums.added.length +
			diff.enums.removed.length +
			diff.enums.changed.length +
			diff.element_types.added.length +
			diff.element_types.removed.length +
			diff.element_types.changed.length +
			diff.relationship_types.added.length +
			diff.relationship_types.removed.length +
			diff.relationship_types.changed.length ===
			0
	);

	function fmt(v: unknown): string {
		if (v === null || v === undefined) return '—';
		return typeof v === 'string' ? v : JSON.stringify(v);
	}
</script>

{#if empty}
	<p class="text-xs text-muted-foreground">No structural changes.</p>
{:else}
	{@const counts = [
		['element types', diff.element_types],
		['relationship types', diff.relationship_types],
		['enums', diff.enums]
	] as const}
	<div class="flex flex-col gap-2 text-xs">
		<p class="text-[10px] text-muted-foreground">
			{#each counts as [label, d] (label)}
				{#if d.added.length + d.removed.length + d.changed.length > 0}
					<span class="mr-3">
						{label}:
						{#if d.added.length}<span class="text-success">+{d.added.length}</span>{/if}
						{#if d.removed.length}<span class="text-destructive">−{d.removed.length}</span>{/if}
						{#if d.changed.length}<span class="text-foreground/80">~{d.changed.length}</span>{/if}
					</span>
				{/if}
			{/each}
		</p>
		{@render typeSection('Element types', diff.element_types.added, diff.element_types.removed)}
		{#each diff.element_types.changed as chg (chg.name)}
			{@render changedType(chg.name, chg.attributes, chg.properties, null)}
		{/each}
		{@render typeSection(
			'Relationship types',
			diff.relationship_types.added,
			diff.relationship_types.removed
		)}
		{#each diff.relationship_types.changed as chg (chg.name)}
			{@render changedType(chg.name, chg.attributes, chg.properties, chg.mappings)}
		{/each}
		{#if diff.enums.added.length || diff.enums.removed.length || diff.enums.changed.length}
			<section class="flex flex-col gap-0.5 rounded border border-border bg-muted/40 px-2 py-1.5">
				<h4 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
					Enums
				</h4>
				{#each diff.enums.added as e (e.name)}
					<p><span class="text-success">+ added</span> <span class="font-mono">{e.name}</span></p>
				{/each}
				{#each diff.enums.removed as e (e.name)}
					<p>
						<span class="text-destructive">− removed</span> <span class="font-mono">{e.name}</span>
					</p>
				{/each}
				{#each diff.enums.changed as e (e.name)}
					<p>
						<span class="font-mono">{e.name}</span>
						{#if e.added.length}<span class="text-success">+{e.added.join(', +')}</span>{/if}
						{#if e.removed.length}<span class="text-destructive">−{e.removed.join(', −')}</span
							>{/if}
					</p>
				{/each}
			</section>
		{/if}
	</div>
{/if}

{#snippet typeSection(title: string, added: { name: string }[], removed: { name: string }[])}
	{#if added.length || removed.length}
		<section class="flex flex-col gap-0.5 rounded border border-border bg-muted/40 px-2 py-1.5">
			<h4 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				{title}
			</h4>
			{#each added as t (t.name)}
				<p><span class="text-success">+ added</span> <span class="font-mono">{t.name}</span></p>
			{/each}
			{#each removed as t (t.name)}
				<p>
					<span class="text-destructive">− removed</span> <span class="font-mono">{t.name}</span>
				</p>
			{/each}
		</section>
	{/if}
{/snippet}

{#snippet changedType(
	name: string,
	attributes: { field: string; from?: unknown; to?: unknown }[],
	properties: {
		added: { name: string }[];
		removed: { name: string }[];
		changed: { name: string; fields: { field: string; from?: unknown; to?: unknown }[] }[];
	},
	mappings: {
		added: { source: string; target: string }[];
		removed: { source: string; target: string }[];
	} | null
)}
	<section class="flex flex-col gap-0.5 rounded border border-border bg-muted/40 px-2 py-1.5">
		<p class="font-mono font-semibold">{name}</p>
		{#each attributes as a (a.field)}
			<p class="pl-2">
				{a.field}: <span class="font-mono">{fmt(a.from)}</span> →
				<span class="font-mono">{fmt(a.to)}</span>
			</p>
		{/each}
		{#each properties.added as p (p.name)}
			<p class="pl-2"><span class="text-success">+ property</span> {p.name}</p>
		{/each}
		{#each properties.removed as p (p.name)}
			<p class="pl-2"><span class="text-destructive">− property</span> {p.name}</p>
		{/each}
		{#each properties.changed as p (p.name)}
			{#each p.fields as f (f.field)}
				<p class="pl-2">
					{p.name}.{f.field}: <span class="font-mono">{fmt(f.from)}</span> →
					<span class="font-mono">{fmt(f.to)}</span>
				</p>
			{/each}
		{/each}
		{#if mappings}
			{#each mappings.added as m (m.source + m.target)}
				<p class="pl-2"><span class="text-success">+ mapping</span> {m.source} → {m.target}</p>
			{/each}
			{#each mappings.removed as m (m.source + m.target)}
				<p class="pl-2">
					<span class="text-destructive">− mapping</span>
					{m.source} → {m.target}
				</p>
			{/each}
		{/if}
	</section>
{/snippet}
