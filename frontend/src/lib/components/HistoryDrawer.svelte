<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import {
		loadFirstPage,
		loadMore,
		getCommits,
		getHasMore,
		getLoading,
		resetHistory
	} from '$lib/state/history.svelte';
	import { onCommitEvent } from '$lib/state/realtime.svelte';
	import { GitCommitVertical, RefreshCw, AlertTriangle } from '@lucide/svelte';

	type Props = { open: boolean };
	let { open = $bindable(false) }: Props = $props();

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

		{#if getLoading() && getCommits().length === 0}
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
							<div class="text-[11px] text-zinc-500">
								{c.author_id ?? 'unknown'} · {fmtTs(c.ts)} · {c.op_count}
								{c.op_count === 1 ? 'op' : 'ops'}
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
