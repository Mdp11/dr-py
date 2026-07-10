<script lang="ts">
	import {
		getFilename,
		getIssueCounts,
		getModelSummary,
		getTypeFilter,
		getFeedConnected,
		getPresence,
		getStagedChangeCount,
		getLockNotice,
		getStaleResources
	} from '$lib/state';

	const summary = $derived(getModelSummary());
	const filename = $derived(getFilename());
	const totalChanges = $derived(getStagedChangeCount());
	const lockNotice = $derived(getLockNotice());
	// Own-lock expiry surfacing: getStaleResources reads the reactive _stale
	// SvelteMap, so this derives live as locks lapse / are re-acquired / discarded.
	const staleResources = $derived(getStaleResources());

	// null = not validated yet; render zeros, matching the pre-validation UX.
	const issueCounts = $derived(getIssueCounts());
	const errorCount = $derived(issueCounts?.error ?? 0);
	const warningCount = $derived(issueCounts?.warning ?? 0);

	const typeFilter = $derived(getTypeFilter());
	const feedConnected = $derived(getFeedConnected());
	const presenceCount = $derived(getPresence().length);
	const totalElements = $derived(summary?.element_count ?? 0);
	// shown/total now comes from the summary's per-type counts (the client no
	// longer holds the whole model to count it directly)
	const shownCount = $derived.by(() => {
		if (summary === null) return 0;
		let n = 0;
		for (const [typeName, count] of Object.entries(summary.elements_by_type)) {
			if (typeFilter.has(typeName)) n += count;
		}
		return n;
	});
</script>

<footer
	class="col-span-5 flex h-6 items-center gap-3 border-t border-border bg-background px-3 font-mono text-xs text-muted-foreground"
>
	<span>Showing {shownCount}/{totalElements} elements</span>
	<span class="text-muted-foreground/40">·</span>
	<span>{totalChanges} uncommitted</span>
	{#if lockNotice}
		<span class="text-muted-foreground/40">·</span>
		<span class="text-warning" title="Lock status">{lockNotice}</span>
	{/if}
	{#if staleResources.length > 0}
		<span class="text-muted-foreground/40">·</span>
		<span class="text-warning" title="One or more of your locks expired">
			⚠ {staleResources.length} lock{staleResources.length === 1 ? '' : 's'} expired — re-edit or discard
			to continue
		</span>
	{/if}
	<span class="text-muted-foreground/40">·</span>
	<span class={errorCount > 0 ? 'text-destructive' : ''}>
		{errorCount}
		{errorCount === 1 ? 'error' : 'errors'}
	</span>
	<span class="text-muted-foreground/40">·</span>
	<span class={warningCount > 0 ? 'text-warning' : ''}>
		{warningCount}
		{warningCount === 1 ? 'warning' : 'warnings'}
	</span>
	<span class="text-muted-foreground/40">·</span>
	<span class="truncate">{filename ?? 'unsaved'}</span>
	<span class="text-muted-foreground/40">·</span>
	<span
		class={feedConnected ? 'text-success' : 'text-muted-foreground/50'}
		title={feedConnected ? 'Live feed connected' : 'Live feed disconnected'}
	>
		● {feedConnected ? 'live' : 'offline'}
	</span>
	{#if presenceCount > 0}
		<span class="text-muted-foreground/40">·</span>
		<span title="People connected to this project">{presenceCount} here</span>
	{/if}
</footer>
