<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import {
		loadFirstPage,
		loadMore,
		getCommits,
		getHasMore,
		getLoading,
		resetHistory,
		modelAt,
		getCommits as _allCommits
	} from '$lib/state/history.svelte';
	import { onCommitEvent } from '$lib/state/realtime.svelte';
	import { GitCommitVertical, RefreshCw, AlertTriangle, ArrowLeft } from '@lucide/svelte';
	import CompareDiff from './CompareDiff.svelte';
	import { computeDiff, type Diff } from '$lib/state/diff';

	type Props = { open: boolean };
	let { open = $bindable(false) }: Props = $props();

	type Mode = 'list' | 'diff';
	let mode = $state<Mode>('list');
	let diff = $state<Diff | null>(null);
	let diffTitle = $state('');
	let diffError = $state<string | null>(null);
	let spanRebind = $state(false); // does the current diff span a rebind commit?
	let compareFrom = $state<number | null>(null); // selected first rev for 2-commit compare

	function spanCrossesRebind(lo: number, hi: number): boolean {
		return _allCommits().some((c) => c.is_rebind && c.rev > lo && c.rev <= hi);
	}

	async function showDiff(fromRev: number, toRev: number, title: string): Promise<void> {
		mode = 'diff';
		diff = null;
		diffError = null;
		diffTitle = title;
		spanRebind = spanCrossesRebind(fromRev, toRev);
		try {
			const [from, to] = await Promise.all([modelAt(fromRev), modelAt(toRev)]);
			diff = computeDiff(from, to);
		} catch (e) {
			diffError = e instanceof Error ? e.message : 'Failed to load diff';
		}
	}

	function diffCommit(rev: number): void {
		showDiff(rev - 1, rev, `Changes in r${rev}`);
	}

	function pickCompare(rev: number): void {
		if (compareFrom === null) {
			compareFrom = rev;
		} else {
			const lo = Math.min(compareFrom, rev);
			const hi = Math.max(compareFrom, rev);
			compareFrom = null;
			showDiff(lo, hi, `r${lo} → r${hi}`);
		}
	}

	function backToList(): void {
		mode = 'list';
		diff = null;
		compareFrom = null;
		spanRebind = false;
	}

	// Load the first page whenever the drawer opens; subscribe to commit feed
	// events for live refresh while open.
	let unsub: (() => void) | null = null;
	$effect(() => {
		if (open) {
			resetHistory();
			loadFirstPage();
			unsub = onCommitEvent(() => loadFirstPage());
		} else {
			unsub?.();
			unsub = null;
		}
		return () => {
			unsub?.();
			unsub = null;
		};
	});

	function fmtTs(ts: string): string {
		const d = new Date(ts);
		return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Commit history</Dialog.Title>
		</Dialog.Header>

		{#if mode === 'diff'}
			<div class="space-y-2">
				<button
					class="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
					onclick={backToList}
				>
					<ArrowLeft class="h-3 w-3" /> Back
				</button>
				<h3 class="text-sm text-zinc-200">{diffTitle}</h3>
				{#if spanRebind}
					<div
						class="rounded border border-amber-700 bg-amber-900/30 px-2 py-1 text-[11px] text-amber-200"
					>
						These revisions use different metamodels; the diff is structural.
					</div>
				{/if}
				{#if diffError}
					<p class="text-sm text-red-300">{diffError}</p>
				{:else if diff === null}
					<p class="text-sm text-zinc-400">Computing diff…</p>
				{:else}
					<CompareDiff {diff} unchangedHidden={0} />
				{/if}
			</div>
		{:else if getLoading() && getCommits().length === 0}
			<p class="py-6 text-center text-sm text-zinc-400">Loading…</p>
		{:else if getCommits().length === 0}
			<p class="py-6 text-center text-sm text-zinc-400">No commits yet.</p>
		{:else}
			<ul class="max-h-[60vh] divide-y divide-zinc-800 overflow-y-auto">
				{#each getCommits() as c (c.rev)}
					<li class="flex items-start gap-3 px-1 py-2 text-sm">
						<GitCommitVertical class="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="font-mono text-xs text-zinc-500">r{c.rev}</span>
								<span class="truncate text-zinc-200">{c.message || '(no message)'}</span>
								{#if c.is_rebind}
									<span class="rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-200"
										>rebind</span
									>
								{/if}
								{#if c.validation_error_count > 0}
									<span
										class="flex items-center gap-1 rounded bg-yellow-900/40 px-1.5 py-0.5 text-[10px] text-yellow-200"
									>
										<AlertTriangle class="h-3 w-3" />{c.validation_error_count}
									</span>
								{/if}
							</div>
							<div class="flex items-center gap-2 text-[11px] text-zinc-500">
								{c.author_id ?? 'unknown'} · {fmtTs(c.ts)} · {c.op_count}
								{c.op_count === 1 ? 'op' : 'ops'}
								<button
									class="rounded px-1 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
									onclick={() => diffCommit(c.rev)}
								>
									Diff
								</button>
								<button
									class="rounded px-1 py-0.5 text-[10px] hover:bg-zinc-800 {compareFrom === c.rev
										? 'text-indigo-300'
										: 'text-zinc-400 hover:text-zinc-200'}"
									onclick={() => pickCompare(c.rev)}
								>
									{compareFrom !== null && compareFrom !== c.rev
										? 'Select B'
										: compareFrom === c.rev
											? 'Selected'
											: 'Compare'}
								</button>
							</div>
						</div>
					</li>
				{/each}
			</ul>

			{#if getHasMore()}
				<div class="pt-2 text-center">
					<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => loadMore()}>
						<RefreshCw class="mr-1 h-3 w-3" /> Load more
					</Button>
				</div>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>
