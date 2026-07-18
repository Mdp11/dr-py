<script lang="ts">
	import { getMetamodel, getSnippetDocs } from '$lib/state';
	import {
		elementTypeRows,
		formatBytes,
		formatSeconds,
		groupFacade,
		relationshipRows
	} from '$lib/snippet/docs-view';

	const docs = $derived(getSnippetDocs());
	const groups = $derived(docs ? groupFacade(docs.facade) : null);
	const typeRows = $derived(elementTypeRows(getMetamodel()));
	const relRows = $derived(relationshipRows(getMetamodel()));
</script>

<div class="h-full overflow-y-auto border-l border-border text-sm" data-testid="snippet-docs">
	{#if !docs}
		<p class="p-3 text-xs text-muted-foreground/70">Docs unavailable.</p>
	{:else}
		<details open class="border-b border-border p-3">
			<summary class="cursor-pointer font-medium">Reference</summary>
			{#each [{ title: 'dr', entries: groups?.dr ?? [] }, { title: 'Element', entries: groups?.element ?? [] }, { title: 'Errors', entries: groups?.errors ?? [] }] as section (section.title)}
				<p class="mt-3 text-xs font-semibold uppercase text-muted-foreground">{section.title}</p>
				{#each section.entries as entry (entry.name)}
					<div class="mt-2">
						<code class="text-xs">{entry.signature}</code>
						<p class="text-xs text-muted-foreground">{entry.doc}</p>
						{#if entry.example}
							<pre
								class="mt-1 rounded bg-muted p-1.5 text-[11px] leading-snug">{entry.example}</pre>
						{/if}
					</div>
				{/each}
			{/each}
		</details>
		<details class="border-b border-border p-3">
			<summary class="cursor-pointer font-medium">This project</summary>
			{#if typeRows.length === 0}
				<p class="mt-2 text-xs text-muted-foreground">No element types in this project.</p>
			{/if}
			{#each typeRows as row (row.name)}
				<div class="mt-2">
					<span class="text-xs font-semibold">{row.name}</span>
					{#if row.abstract}<span class="ml-1 text-[10px] text-muted-foreground">abstract</span
						>{/if}
					{#each row.properties as p (p.name)}
						<p class="ml-2 text-xs text-muted-foreground">
							{p.name}: {p.datatype} ({p.multiplicity})
						</p>
					{/each}
				</div>
			{/each}
			{#if relRows.length > 0}
				<p class="mt-3 text-xs font-semibold uppercase text-muted-foreground">Relationships</p>
				{#each relRows as row (row.name)}
					<p class="ml-2 text-xs text-muted-foreground">
						{row.name}: {row.source} → {row.target}{row.containment ? ' (containment)' : ''}
					</p>
				{/each}
			{/if}
		</details>
		<details class="p-3">
			<summary class="cursor-pointer font-medium">Rules &amp; limits</summary>
			<ul class="mt-2 space-y-1 text-xs text-muted-foreground">
				<li>Wall timeout: {formatSeconds(docs.limits.wall_timeout_s)}</li>
				<li>Memory: {formatBytes(docs.limits.memory_bytes)}</li>
				<li>Stdout cap: {formatBytes(docs.limits.stdout_bytes)}</li>
				<li>Result cap: {formatBytes(docs.limits.result_repr_bytes)}</li>
				<li>Max ops: {docs.limits.max_ops}</li>
				<li>Max op bytes: {formatBytes(docs.limits.max_op_bytes)}</li>
				<li>Read page size: {docs.limits.page_limit}</li>
			</ul>
			<ul class="mt-3 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
				{#each docs.notes as note (note)}
					<li>{note}</li>
				{/each}
			</ul>
		</details>
	{/if}
</div>
