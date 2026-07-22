<script lang="ts">
	import { browser } from '$app/environment';
	import { ChevronDown, ChevronRight, Undo2 } from '@lucide/svelte';
	import {
		clearSelection,
		deriveStagedElementRows,
		ensureTreeItems,
		getCachedElements,
		getCachedTreeItems,
		getSelection,
		getStagedDiff,
		revertStagedForElement,
		select,
		type StagedElementRow
	} from '$lib/state';
	import { isTempId } from '$lib/state/ops';

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
		deriveStagedElementRows(getStagedDiff(), getCachedElements(), getCachedTreeItems())
	);
	const selection = $derived(getSelection());

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
		revertStagedForElement(row.id);
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
			<ul class="max-h-48 overflow-auto px-1 pb-1 text-xs" role="list">
				{#each rows as row (row.id)}
					{@const badge = BADGE[row.status]}
					<li
						class="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted"
						class:bg-muted={selection?.kind === 'element' && selection.id === row.id}
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
			</ul>
		{/if}
	</section>
{/if}
