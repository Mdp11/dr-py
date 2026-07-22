<script lang="ts">
	import { browser } from '$app/environment';
	import { ChevronDown, ChevronRight, Undo2 } from '@lucide/svelte';
	import {
		clearSelection,
		deriveStagedElementRows,
		discardElementCascade,
		ensureTreeItems,
		getCachedElements,
		getCachedTreeItems,
		getSelection,
		getStagedDiff,
		getStagedOps,
		select,
		stagedRelationshipOpIds,
		type StagedElementRow
	} from '$lib/state';
	import { isTempId } from '$lib/state/ops';
	import { computeWindow } from './windowing';

	// "Staged elements" section: the navigation path to elements touched by
	// the staged-edits buffer (snippet-staged or manual). The tree renders only
	// server-paged rows, so staged temp elements appear NOWHERE else until
	// commit — this section is derived purely from client state. See
	// docs/superpowers/specs/2026-07-22-staged-elements-sidebar-section-design.md.

	const LS_COLLAPSED = 'ui.stagedSectionCollapsed';

	let collapsed = $state(browser && localStorage.getItem(LS_COLLAPSED) === 'true');
	$effect(() => {
		// No `browser` guard needed here (unlike the read above): `$effect`
		// bodies never run during SSR in Svelte 5, only client-side, so
		// `localStorage` is always safe to touch from inside one.
		localStorage.setItem(LS_COLLAPSED, String(collapsed));
	});

	const rows = $derived(
		deriveStagedElementRows(
			getStagedDiff(),
			getCachedElements(),
			getCachedTreeItems(),
			stagedRelationshipOpIds(getStagedOps())
		)
	);
	const selection = $derived(getSelection());

	// ----- virtualized windowing -----
	// A snippet batch can stage thousands of ops, and this scroller only ever
	// shows ~8 rows — mount the visible window (+overscan) instead of the whole
	// list, exactly as ContainmentTree does. Spacer divs above/below keep the
	// scrollbar proportional to the FULL row count so every row stays reachable
	// (a "…and N more" cap was rejected: this is the surface for reviewing and
	// discarding staged edits, so nothing may be unreachable).
	const ROW_H = 28;
	const OVERSCAN = 8;

	let scrollEl: HTMLElement | null = $state(null);
	let scrollTop = $state(0);
	// Height is measured from the live element; in a detached test host it stays
	// 0, and computeWindow then still mounts OVERSCAN rows — degrading to "some
	// rows", never to "no rows".
	let viewportH = $state(0);

	const win = $derived(
		computeWindow({ scrollTop, viewportH, rowH: ROW_H, total: rows.length, overscan: OVERSCAN })
	);
	const windowedRows = $derived(rows.slice(win.start, win.end));

	function onScroll(): void {
		if (scrollEl) scrollTop = scrollEl.scrollTop;
	}

	$effect(() => {
		if (!scrollEl) return;
		viewportH = scrollEl.clientHeight;
		const ro = new ResizeObserver(() => {
			if (scrollEl) viewportH = scrollEl.clientHeight;
		});
		ro.observe(scrollEl);
		return () => ro.disconnect();
	});

	// Modified rows can be in neither cache (staged-rel endpoint of an element
	// this client never loaded) — lite-fetch their display rows. ensureTreeItems
	// dedups cached/in-flight/temp ids, so re-runs are cheap.
	$effect(() => {
		const missing = rows
			.filter((r) => r.status === 'modified' && r.typeName === null && !isTempId(r.id))
			.map((r) => r.id);
		if (missing.length > 0) void ensureTreeItems(missing);
	});

	const BADGE: Record<StagedElementRow['status'], { label: string; cls: string }> = {
		new: { label: 'new', cls: 'text-success' },
		modified: { label: 'edited', cls: 'text-warning' },
		deleted: { label: 'deleted', cls: 'text-destructive' }
	};

	function onRowClick(row: StagedElementRow): void {
		select({ kind: 'element', id: row.id });
	}

	function onRevert(row: StagedElementRow): void {
		// Un-creating the selected temp element would leave the Inspector on a
		// dead id — clear selection first. Edits/deletes revert to a real
		// server-known element, so selection stays put.
		if (row.status === 'new' && selection?.kind === 'element' && selection.id === row.id) {
			clearSelection();
		}
		// discardElementCascade, not the bare revert: staged edits always hold a
		// lease (manual via the edit gate, snippet batches via acquireLocks), and
		// nothing else releases it once the buffer empties — a raw revert would
		// leave the element checked out against peers for the full TTL.
		void discardElementCascade(row.id);
	}
</script>

{#if rows.length > 0}
	<section class="flex min-h-0 flex-col border-t border-border" data-testid="staged-section">
		<button
			type="button"
			class="microlabel flex select-none items-center gap-1 px-3 py-1.5 transition-colors hover:bg-muted hover:text-foreground/80"
			data-testid="staged-header"
			onclick={() => (collapsed = !collapsed)}
		>
			{#if collapsed}
				<ChevronRight class="h-3 w-3" />
			{:else}
				<ChevronDown class="h-3 w-3" />
			{/if}
			<span class="flex-1 text-left">Staged elements</span>
			<span class="font-mono text-[10px] normal-case text-muted-foreground">{rows.length}</span>
		</button>
		{#if !collapsed}
			<ul
				bind:this={scrollEl}
				onscroll={onScroll}
				class="max-h-48 overflow-auto px-1 pb-1 text-xs"
				role="list"
			>
				<li style="height: {win.padTop}px" aria-hidden="true"></li>
				{#each windowedRows as row (row.id)}
					{@const badge = BADGE[row.status]}
					{@const isSelected = selection?.kind === 'element' && selection.id === row.id}
					<li
						class="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted"
						class:bg-muted={isSelected}
						style="height: {ROW_H}px"
						data-staged-id={row.id}
						data-status={row.status}
					>
						{#if row.status === 'deleted'}
							<span class="flex-1 truncate text-muted-foreground line-through">
								{row.displayName}
							</span>
						{:else}
							<button
								type="button"
								class="staged-select flex-1 truncate text-left text-foreground/90"
								aria-current={isSelected ? 'true' : undefined}
								onclick={() => onRowClick(row)}
							>
								{row.displayName}
							</button>
						{/if}
						{#if row.typeName !== null}
							<span
								class="rounded border border-input bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
							>
								{row.typeName}
							</span>
						{/if}
						<span class="font-mono text-[10px] {badge.cls}">{badge.label}</span>
						<button
							type="button"
							class="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-border hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
							title="Revert staged changes"
							aria-label="Revert staged changes to {row.displayName}"
							data-testid="staged-revert"
							onclick={() => onRevert(row)}
						>
							<Undo2 class="h-3 w-3" />
						</button>
					</li>
				{/each}
				<li style="height: {win.padBottom}px" aria-hidden="true"></li>
			</ul>
		{/if}
	</section>
{/if}
