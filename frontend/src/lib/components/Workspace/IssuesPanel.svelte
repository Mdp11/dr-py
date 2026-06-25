<script lang="ts">
	import type { Issue } from '$lib/api/types';
	import { Button } from '$lib/components/ui/button';
	import {
		getCachedElements,
		getCachedRelationships,
		getIssues,
		getLastError,
		getLastRunAt,
		getModelSummary,
		getViewWarnings,
		isRunning,
		select
	} from '$lib/state';
	import { runValidation } from '$lib/state/validate-action';
	import { nameProp } from '$lib/util/element-name';
	import { AlertCircle, AlertTriangle, RefreshCw } from '@lucide/svelte';

	const modelIssues = $derived(getIssues());
	const viewWarnings = $derived(getViewWarnings());
	const issues = $derived<readonly Issue[]>([...modelIssues, ...viewWarnings]);
	const lastRunAt = $derived(getLastRunAt());
	const running = $derived(isRunning());
	const lastError = $derived(getLastError());
	const summary = $derived(getModelSummary());
	const elements = $derived(getCachedElements());
	const relationships = $derived(getCachedRelationships());

	type OriginFilter = 'all' | 'uncommitted' | 'on_server' | 'resolved';
	let filter = $state<OriginFilter>('all');

	function originBadge(o: Issue['origin']): { label: string; cls: string } {
		if (o === 'uncommitted') return { label: 'new', cls: 'bg-sky-900 text-sky-200' };
		if (o === 'resolved') return { label: 'fixed', cls: 'bg-emerald-950 text-emerald-300' };
		return { label: 'on server', cls: 'bg-zinc-800 text-zinc-400' };
	}

	const filtered = $derived(filter === 'all' ? issues : issues.filter((i) => i.origin === filter));
	// Active = not resolved. Resolved rows are shown (when in view) but never
	// counted as problems and render struck-through. A single errors/warnings
	// pair scoped to `filtered` feeds BOTH the header summary and the body
	// sections, so the two always agree under any active filter.
	const errors = $derived(
		filtered.filter((i) => i.severity === 'error' && i.origin !== 'resolved')
	);
	const warnings = $derived(
		filtered.filter((i) => i.severity === 'warning' && i.origin !== 'resolved')
	);
	const resolved = $derived(filtered.filter((i) => i.origin === 'resolved'));
	// Global (not filter-scoped): gates the "Fixed" filter button.
	const hasResolved = $derived(issues.some((i) => i.origin === 'resolved'));

	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	function relativeTime(ts: number | null): string {
		if (ts === null) return '';
		const secs = Math.max(0, Math.floor((now - ts) / 1000));
		if (secs < 5) return 'just now';
		if (secs < 60) return `${secs}s ago`;
		const mins = Math.floor(secs / 60);
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		return `${hrs}h ago`;
	}

	// Target kind/label resolution uses the cached subset; an uncached target
	// falls back to "element" + raw id (clicking it triggers a cache-or-fetch
	// in the detail/inspector views).
	function kindFor(id: string): 'element' | 'relationship' {
		if (!elements.has(id) && relationships.has(id)) return 'relationship';
		return 'element';
	}

	function targetLabel(id: string): string {
		const el = elements.get(id);
		if (el) return nameProp(el.properties) ?? el.id;
		const rel = relationships.get(id);
		if (rel) return `${rel.type_name}:${rel.id.slice(0, 6)}`;
		return id;
	}

	function onTargetClick(id: string): void {
		select({ kind: kindFor(id), id });
	}

	async function rerun(): Promise<void> {
		// Reset the filter so a re-run never strands the user on an empty view
		// (e.g. sitting on "Fixed" when this run has no resolved issues).
		filter = 'all';
		await runValidation();
	}
</script>

{#snippet issueRow(it: Issue, idx: number)}
	<li
		class="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5"
		class:opacity-60={it.origin === 'resolved'}
	>
		<div class="flex items-start gap-1.5">
			{#if it.severity === 'error'}
				<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
			{:else}
				<AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
			{/if}
			<span class="flex-1 text-zinc-200" class:line-through={it.origin === 'resolved'}>
				{it.message}
			</span>
			<span class="rounded px-1 py-0.5 text-[9px] uppercase {originBadge(it.origin).cls}">
				{originBadge(it.origin).label}
			</span>
			<span class="font-mono text-[10px] text-zinc-600">#{idx + 1}</span>
		</div>
		{#if it.target_ids.length > 0}
			<div class="flex flex-wrap items-center gap-1 pl-5">
				{#each it.target_ids as tid (tid)}
					<button
						type="button"
						class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 hover:bg-zinc-700 hover:text-zinc-50"
						onclick={() => onTargetClick(tid)}
						title={tid}
					>
						{targetLabel(tid)}
					</button>
				{/each}
			</div>
		{/if}
	</li>
{/snippet}

<div class="flex h-full flex-col">
	<header class="flex items-center justify-between border-b border-zinc-800 px-3 py-2 text-xs">
		<div class="flex flex-col gap-0.5">
			<div class="flex items-center gap-2 text-zinc-300">
				{#if issues.length === 0 && lastRunAt === null}
					<span class="text-zinc-500">Not validated yet.</span>
				{:else if issues.length === 0}
					<span class="text-emerald-400">No issues</span>
				{:else}
					<span class="text-red-400"
						>{errors.length} {errors.length === 1 ? 'error' : 'errors'}</span
					>
					<span class="text-zinc-700">·</span>
					<span class="text-amber-400">
						{warnings.length}
						{warnings.length === 1 ? 'warning' : 'warnings'}
					</span>
				{/if}
			</div>
			{#if lastRunAt !== null}
				<span class="text-[10px] text-zinc-500">last run {relativeTime(lastRunAt)}</span>
			{/if}
		</div>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1 text-xs"
			onclick={rerun}
			disabled={running || summary === null}
		>
			<RefreshCw class="h-3 w-3 {running ? 'animate-spin' : ''}" />
			{running ? 'Running…' : 'Re-run'}
		</Button>
	</header>

	{#if lastError !== null}
		<div class="border-b border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200">
			Validation failed: {lastError}
		</div>
	{/if}

	<div class="flex-1 overflow-auto px-3 py-2 text-xs">
		{#if lastRunAt === null}
			<p class="text-zinc-500">Run Validate to check for issues.</p>
		{:else if issues.length === 0}
			<p class="text-emerald-400">No issues (validated {relativeTime(lastRunAt)}).</p>
		{:else}
			<div class="mb-2 flex flex-wrap gap-1">
				{#each [['all', 'All'], ['uncommitted', 'New'], ['on_server', 'On server'], ['resolved', 'Fixed']] as [val, label] (val)}
					<button
						type="button"
						class="rounded px-2 py-0.5 text-[10px] {filter === val
							? 'bg-zinc-200 text-zinc-900'
							: 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}"
						disabled={val === 'resolved' && !hasResolved}
						onclick={() => (filter = val as OriginFilter)}
					>
						{label}
					</button>
				{/each}
			</div>
			{#if filtered.length === 0}
				<p class="text-zinc-500">No issues match this filter.</p>
			{:else}
				<div class="flex flex-col gap-3">
					{#if errors.length > 0}
						<section class="flex flex-col gap-1">
							<h3 class="text-[10px] font-semibold uppercase tracking-wider text-red-300">
								Errors ({errors.length})
							</h3>
							<ul class="flex flex-col gap-1">
								{#each errors as it, i (i)}
									{@render issueRow(it, i)}
								{/each}
							</ul>
						</section>
					{/if}
					{#if warnings.length > 0}
						<section class="flex flex-col gap-1">
							<h3 class="text-[10px] font-semibold uppercase tracking-wider text-amber-300">
								Warnings ({warnings.length})
							</h3>
							<ul class="flex flex-col gap-1">
								{#each warnings as it, i (i)}
									{@render issueRow(it, i)}
								{/each}
							</ul>
						</section>
					{/if}
					{#if resolved.length > 0}
						<section class="flex flex-col gap-1">
							<h3 class="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
								Resolved by your edits ({resolved.length})
							</h3>
							<ul class="flex flex-col gap-1">
								{#each resolved as it, i (i)}
									{@render issueRow(it, i)}
								{/each}
							</ul>
						</section>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
</div>
