<script lang="ts">
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';

	import type { Element } from '$lib/api/types';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		backEntries,
		canGoBack,
		canGoForward,
		forwardEntries,
		getCachedElements,
		getCachedTreeItems,
		goBack,
		goForward,
		goToVisit,
		noteResolved,
		type VisitMenuEntry
	} from '$lib/state';
	// Not re-exported from the state barrel; the table cells that overlay staged
	// renames import it from the module directly too.
	import { getStagedNameOverride } from '$lib/state/model.svelte';
	import { elementDisplayName } from '$lib/util/element-name';
	import { longpress } from '$lib/util/long-press';
	import { cn } from '$lib/utils.js';

	type Row = { index: number; id: string; name: string; type_name: string | undefined };

	let backOpen = $state(false);
	let forwardOpen = $state(false);
	let backRows: Row[] = $state([]);
	let forwardRows: Row[] = $state([]);

	// O(1) per-id lookup instead of getTreeElements(), which allocates a fresh
	// Map + a synthetic Element per tree row on every call — wasteful for a
	// menu that only ever needs <=10 ids, right before it paints, against a
	// model that can be ~80MB. Reproduces getTreeElements()'s exact precedence
	// (full `_elements` entry wins; otherwise synthesize a minimal Element from
	// the lite `_treeItems` row, same shape it uses) for a single id.
	function lookupElement(id: string): Element | undefined {
		const full = getCachedElements().get(id);
		if (full !== undefined) return full;
		const t = getCachedTreeItems().get(id);
		if (t === undefined) return undefined;
		const properties = t.display_name && t.display_name !== id ? { name: t.display_name } : {};
		return { id, type_name: t.type_name, properties, rev: 0 };
	}

	// Rows are resolved ONCE, when the menu opens (not in $derived: the
	// noteResolved write-back mutates $state, which a derived must not do).
	// Resolution order: staged rename > lite/full cache > the entry's
	// last-known label > bare id — so a later-deleted element keeps showing
	// its last-known name.
	function resolveRows(entries: VisitMenuEntry[]): Row[] {
		return entries.map(({ index, entry }) => {
			const el = lookupElement(entry.id);
			const staged = getStagedNameOverride(entry.id);
			const liveName = staged ?? (el ? elementDisplayName(el) : undefined);
			const liveType = el?.type_name;
			if (liveName !== undefined && liveType !== undefined) {
				noteResolved(entry.id, liveName, liveType);
			}
			return {
				index,
				id: entry.id,
				name: liveName ?? entry.name ?? entry.id,
				type_name: liveType ?? entry.type_name
			};
		});
	}

	function openBackMenu() {
		if (!canGoBack()) return;
		backRows = resolveRows(backEntries());
		backOpen = true;
	}

	function openForwardMenu() {
		if (!canGoForward()) return;
		forwardRows = resolveRows(forwardEntries());
		forwardOpen = true;
	}
</script>

{#snippet entryItem(row: Row)}
	<DropdownMenu.Item
		data-testid={`inspector-history-entry-${row.index}`}
		class="flex flex-col items-start gap-0.5"
		onclick={() => goToVisit(row.index, row.id)}
	>
		<span class="flex w-full items-baseline gap-2">
			<span data-testid="inspector-history-entry-name" class="min-w-0 truncate">{row.name}</span>
			{#if row.type_name}
				<span class="ml-auto shrink-0 text-xs text-muted-foreground">{row.type_name}</span>
			{/if}
		</span>
		<span class="w-full truncate font-mono text-[10px] text-muted-foreground/70">{row.id}</span>
	</DropdownMenu.Item>
{/snippet}

<div class="flex items-center gap-0.5 border-b border-border px-2 py-1">
	<DropdownMenu.Root bind:open={backOpen}>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<!-- Spread first, override after: bits-ui's own open-toggle
				     handlers are replaced so the menu opens ONLY via longpress /
				     contextmenu; plain click navigates. Plain <button> because
				     use:longpress is an action (DOM elements only). -->
				<button
					{...props}
					type="button"
					class={cn(buttonVariants({ variant: 'ghost', size: 'icon-xs' }))}
					data-testid="inspector-history-back"
					aria-label="Back"
					title="Back — hold or right-click for history"
					disabled={!canGoBack()}
					onclick={() => goBack()}
					onpointerdown={undefined}
					onkeydown={undefined}
					use:longpress={{ onLongPress: openBackMenu }}
				>
					<ChevronLeft />
				</button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="w-64">
			{#each backRows as row (row.index)}
				{@render entryItem(row)}
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
	<DropdownMenu.Root bind:open={forwardOpen}>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					class={cn(buttonVariants({ variant: 'ghost', size: 'icon-xs' }))}
					data-testid="inspector-history-forward"
					aria-label="Forward"
					title="Forward — hold or right-click for history"
					disabled={!canGoForward()}
					onclick={() => goForward()}
					onpointerdown={undefined}
					onkeydown={undefined}
					use:longpress={{ onLongPress: openForwardMenu }}
				>
					<ChevronRight />
				</button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="w-64">
			{#each forwardRows as row (row.index)}
				{@render entryItem(row)}
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>
