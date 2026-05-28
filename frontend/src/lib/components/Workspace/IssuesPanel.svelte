<script lang="ts">
	import type { Issue } from '$lib/api/types';
	import { Button } from '$lib/components/ui/button';
	import {
		getBaseline,
		getIssues,
		getLastError,
		getLastRunAt,
		getWorkingModel,
		isRunning,
		select
	} from '$lib/state';
	import { runValidation } from '$lib/state/validate-action';
	import { AlertCircle, AlertTriangle, RefreshCw } from '@lucide/svelte';

	const issues = $derived(getIssues());
	const lastRunAt = $derived(getLastRunAt());
	const running = $derived(isRunning());
	const lastError = $derived(getLastError());
	const baseline = $derived(getBaseline());
	const working = $derived(getWorkingModel());

	const errors = $derived(issues.filter((i) => i.severity === 'error'));
	const warnings = $derived(issues.filter((i) => i.severity === 'warning'));

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

	const elementIds = $derived(new Set(working.elements.map((e) => e.id)));
	const relationshipIds = $derived(new Set(working.relationships.map((r) => r.id)));

	function kindFor(id: string): 'element' | 'relationship' {
		if (!elementIds.has(id) && relationshipIds.has(id)) return 'relationship';
		return 'element';
	}

	function targetLabel(id: string): string {
		const el = working.elements.find((e) => e.id === id);
		if (el) {
			const n = el.properties?.name;
			if (typeof n === 'string' && n.length > 0) return n;
			return el.id;
		}
		const rel = working.relationships.find((r) => r.id === id);
		if (rel) return `${rel.type_name}:${rel.id.slice(0, 6)}`;
		return id;
	}

	function onTargetClick(id: string): void {
		select({ kind: kindFor(id), id });
	}

	async function rerun(): Promise<void> {
		await runValidation();
	}
</script>

{#snippet issueRow(it: Issue, idx: number)}
	<li class="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5">
		<div class="flex items-start gap-1.5">
			{#if it.severity === 'error'}
				<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
			{:else}
				<AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
			{/if}
			<span class="flex-1 text-zinc-200">{it.message}</span>
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
					<span class="text-red-400">{errors.length} {errors.length === 1 ? 'error' : 'errors'}</span>
					<span class="text-zinc-700">·</span>
					<span class="text-amber-400">
						{warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
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
			disabled={running || baseline === null}
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
			</div>
		{/if}
	</div>
</div>
