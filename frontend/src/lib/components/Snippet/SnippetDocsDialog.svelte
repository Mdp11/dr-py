<script lang="ts">
	// Tabbed snippet-docs modal (replaces the old 320px SnippetDocsPanel
	// sidebar): API Reference / Project / Limits & rules, with a shared filter
	// box above the tab panels (inert on the Limits tab). All list
	// shaping/filtering is pure ($lib/snippet/docs-view); this stays a thin
	// template.
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import { getMetamodel, getSnippetDocs } from '$lib/state';
	import {
		elementTypeRows,
		filterFacade,
		filterRelRows,
		filterTypeRows,
		formatBytes,
		formatSeconds,
		groupFacade,
		relationshipRows
	} from '$lib/snippet/docs-view';

	let { open = $bindable(false) }: { open: boolean } = $props();

	let filter = $state('');

	const docs = $derived(getSnippetDocs());
	const groups = $derived(docs ? groupFacade(filterFacade(docs.facade, filter)) : null);
	const typeRows = $derived(filterTypeRows(elementTypeRows(getMetamodel()), filter));
	const relRows = $derived(filterRelRows(relationshipRows(getMetamodel()), filter));

	const sections = $derived([
		{ title: 'dr', entries: groups?.dr ?? [] },
		{ title: 'Element', entries: groups?.element ?? [] },
		{ title: 'Errors', entries: groups?.errors ?? [] }
	]);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[85vh] max-w-3xl flex-col" data-testid="snippet-docs">
		<Dialog.Header>
			<Dialog.Title class="font-display text-lg font-light tracking-wide">
				Snippet docs
			</Dialog.Title>
		</Dialog.Header>

		{#if !docs}
			<p class="text-xs text-muted-foreground/70">Docs unavailable.</p>
		{:else}
			<Tabs.Root value="reference" class="flex min-h-0 flex-1 flex-col gap-3">
				<Tabs.List class="h-8 shrink-0">
					<Tabs.Trigger
						value="reference"
						class="h-7 text-xs"
						data-testid="snippet-docs-tab-reference"
					>
						API Reference
					</Tabs.Trigger>
					<Tabs.Trigger value="project" class="h-7 text-xs" data-testid="snippet-docs-tab-project">
						Project
					</Tabs.Trigger>
					<Tabs.Trigger value="limits" class="h-7 text-xs" data-testid="snippet-docs-tab-limits">
						Limits &amp; rules
					</Tabs.Trigger>
				</Tabs.List>

				<input
					data-testid="snippet-docs-filter"
					aria-label="Filter docs"
					class="w-64 shrink-0 rounded border border-input bg-card px-2 py-1 text-xs"
					placeholder="Filter…"
					bind:value={filter}
				/>

				<Tabs.Content value="reference" class="min-h-0 flex-1 overflow-y-auto pr-2 text-sm">
					{#each sections as section (section.title)}
						{#if section.entries.length > 0}
							<p class="mt-4 text-xs font-semibold uppercase text-muted-foreground first:mt-0">
								{section.title}
							</p>
							{#each section.entries as entry (entry.name)}
								<div class="mt-3">
									<code class="text-xs">{entry.signature}</code>
									<p class="mt-0.5 text-xs text-muted-foreground">{entry.doc}</p>
									{#if entry.example}
										<pre
											class="mt-1 rounded bg-muted p-2 text-[11px] leading-snug">{entry.example}</pre>
									{/if}
								</div>
							{/each}
						{/if}
					{/each}
				</Tabs.Content>

				<Tabs.Content value="project" class="min-h-0 flex-1 overflow-y-auto pr-2 text-sm">
					{#if typeRows.length === 0}
						<p class="text-xs text-muted-foreground">No matching element types.</p>
					{/if}
					{#each typeRows as row (row.name)}
						<div class="mt-3 first:mt-0">
							<span class="text-xs font-semibold">{row.name}</span>
							{#if row.abstract}<span class="ml-1 text-[10px] text-muted-foreground">abstract</span
								>{/if}
							{#each row.properties as p (p.name)}
								<p class="ml-3 text-xs text-muted-foreground">
									{p.name}: {p.datatype} ({p.multiplicity})
								</p>
							{/each}
						</div>
					{/each}
					{#if relRows.length > 0}
						<p class="mt-4 text-xs font-semibold uppercase text-muted-foreground">Relationships</p>
						{#each relRows as row (row.name)}
							<p class="ml-3 text-xs text-muted-foreground">
								{row.name}: {row.source} → {row.target}{row.containment ? ' (containment)' : ''}
							</p>
						{/each}
					{/if}
				</Tabs.Content>

				<Tabs.Content value="limits" class="min-h-0 flex-1 overflow-y-auto pr-2 text-sm">
					<ul class="space-y-1.5 text-xs text-muted-foreground">
						<li>Wall timeout: {formatSeconds(docs.limits.wall_timeout_s)}</li>
						<li>Memory: {formatBytes(docs.limits.memory_bytes)}</li>
						<li>Stdout cap: {formatBytes(docs.limits.stdout_bytes)}</li>
						<li>Result cap: {formatBytes(docs.limits.result_repr_bytes)}</li>
						<li>Max ops: {docs.limits.max_ops}</li>
						<li>Max op bytes: {formatBytes(docs.limits.max_op_bytes)}</li>
						<li>Read page size: {docs.limits.page_limit}</li>
					</ul>
					<ul class="mt-4 list-disc space-y-1.5 pl-4 text-xs text-muted-foreground">
						{#each docs.notes as note (note)}
							<li>{note}</li>
						{/each}
					</ul>
				</Tabs.Content>
			</Tabs.Root>
		{/if}
	</Dialog.Content>
</Dialog.Root>
