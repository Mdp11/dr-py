<script lang="ts">
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';

	import { buttonVariants } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		backEntries,
		canGoBack,
		canGoForward,
		forwardEntries,
		getTreeElements,
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

	// Rows are resolved ONCE, when the menu opens (not in $derived: the
	// noteResolved write-back mutates $state, which a derived must not do).
	// Resolution order: staged rename > lite/full cache > the entry's
	// last-known label > bare id — so a later-deleted element keeps showing
	// its last-known name.
	function resolveRows(entries: VisitMenuEntry[]): Row[] {
		const cache = getTreeElements();
		return entries.map(({ index, entry }) => {
			const el = cache.get(entry.id);
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
		onclick={() => goToVisit(row.index)}
	>
		<span class="flex w-full items-baseline gap-2">
			<span class="min-w-0 truncate">{row.name}</span>
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
