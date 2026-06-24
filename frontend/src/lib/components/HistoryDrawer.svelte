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
	import { revertToCommit } from '$lib/api/history';
	import { getRole, getModelRev, getStagedDepth, getLockState, applyDelta } from '$lib/state';
	import { ConflictError, ValidationError } from '$lib/api';

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
		confirmRev = null;
		revertError = null;
	}

	const canWrite = $derived(getRole() === 'owner' || getRole() === 'editor');
	const quiet = $derived(getStagedDepth() === 0 && getLockState().size === 0);

	let confirmRev = $state<number | null>(null);
	let revertMsg = $state('');
	let reverting = $state(false);
	let revertError = $state<string | null>(null);

	function askRevert(rev: number): void {
		revertError = null;
		if (!quiet) {
			revertError = 'Commit or discard your changes first.';
			confirmRev = rev; // still surface the notice in the dialog
			return;
		}
		confirmRev = rev;
		revertMsg = `Revert to rev ${rev}`;
	}

	async function doRevert(): Promise<void> {
		if (confirmRev === null || !quiet) return;
		reverting = true;
		revertError = null;
		try {
			const res = await revertToCommit({
				targetRev: confirmRev,
				baseRev: getModelRev(),
				message: revertMsg || undefined
			});
			applyDelta(res);
			confirmRev = null;
			backToList();
		} catch (e) {
			if (e instanceof ConflictError) {
				const body = e.body as { detail?: string; rebind_rev?: number; conflicts?: unknown[] };
				if (body?.rebind_rev !== undefined)
					revertError = `Can't revert across a metamodel swap (rev ${body.rebind_rev}).`;
				else if (body?.conflicts) revertError = 'A peer holds a lock on an affected resource.';
				else revertError = 'History moved — reload and retry.';
			} else if (e instanceof ValidationError) {
				revertError = 'Revert would leave a structural error and was rejected.';
			} else {
				revertError = e instanceof Error ? e.message : 'Revert failed.';
			}
		} finally {
			reverting = false;
		}
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
					<li data-testid="commit-row" class="flex items-start gap-3 px-1 py-2 text-sm">
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
								{#if canWrite}
									<button
										class="rounded px-1 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
										onclick={() => askRevert(c.rev)}
									>
										Revert to here
									</button>
								{/if}
							</div>
							{#if confirmRev === c.rev}
								<div class="mt-2 rounded border border-zinc-700 bg-zinc-900/60 p-3 text-sm">
									<p class="text-zinc-200">
										Revert to rev {confirmRev}? Revisions after r{confirmRev} are discarded as state
										(history is preserved).
									</p>
									{#if revertError}
										<p class="mt-1 text-xs text-red-300">{revertError}</p>
									{/if}
									{#if quiet}
										<input
											class="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
											bind:value={revertMsg}
											placeholder="Commit message"
										/>
									{/if}
									<div class="mt-2 flex justify-end gap-2">
										<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => (confirmRev = null)}>
											Cancel
										</Button>
										<Button
											size="sm"
											class="h-7 text-xs"
											disabled={!quiet || reverting}
											onclick={() => doRevert()}
										>
											Revert
										</Button>
									</div>
								</div>
							{/if}
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
