<script lang="ts">
	// Run status + result rendering + ops staging. Reads the run state for
	// `tabId` and nothing else — SnippetTab owns the editor and hands this
	// component only `onGoToLine` so a traceback frame can jump the editor
	// cursor without this component knowing the editor exists.
	import { canEdit, getModelRev, getSnippetRun, markRunStaged, stageSnippetOps } from '$lib/state';
	import {
		errorKindLabel,
		isResultStale,
		opSummary,
		tracebackLines
	} from '$lib/snippet/console-view';

	let { tabId, onGoToLine }: { tabId: string; onGoToLine: (line: number) => void } = $props();

	const run = $derived(getSnippetRun(tabId));
	const stale = $derived(run.result ? isResultStale(run.result, getModelRev()) : false);
	const editable = $derived(canEdit());

	let tracebackOpen = $state(false);
	let stageError = $state<string | null>(null);

	async function stage(): Promise<void> {
		stageError = null;
		const result = getSnippetRun(tabId).result;
		if (!result) return;
		const outcome = await stageSnippetOps(result);
		if (outcome.ok) {
			markRunStaged(tabId);
		} else if (outcome.reason === 'missing') {
			stageError = 'One or more referenced elements no longer exist — re-run the snippet.';
		} else if (outcome.reason === 'empty') {
			stageError = 'Nothing to stage.';
		}
		// 'stale' -> `stale` above already re-derives from the same rev check
		// stageSnippetOps just performed, so the banner appears and the Stage
		// button disables on its own. 'locks' -> the shared lock-notice banner
		// (StatusBar / getLockNotice) already surfaces the refusal.
	}
</script>

<div class="flex h-full flex-col overflow-hidden border-t border-border">
	<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 text-xs">
		{#if run.phase === 'running'}
			<div class="flex items-center gap-2 text-muted-foreground">
				<div class="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary"></div>
				Running…
			</div>
		{:else if run.phase === 'stopping'}
			<p class="text-warning">Stopping — run ends at wall timeout.</p>
		{/if}

		{#if run.notice}
			<p data-testid="snippet-notice" class="text-warning">{run.notice}</p>
		{/if}

		{#if run.result}
			{@const result = run.result}
			{#if stale}
				<p data-testid="snippet-stale" class="rounded bg-warning/15 px-2 py-1 text-warning">
					The model changed during/after this run — results may be out of date. Re-run before
					staging.
				</p>
			{/if}

			{#if result.stdout}
				<pre
					data-testid="snippet-stdout"
					class="whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">{result.stdout}</pre>
			{/if}

			{#if result.result_repr !== null}
				<pre
					data-testid="snippet-result"
					class="whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">{result.result_repr}</pre>
			{/if}

			<div class="flex items-center gap-2 text-muted-foreground/70">
				{#if result.truncated}
					<span class="rounded bg-muted px-1 text-[10px]">output truncated at server limit</span>
				{/if}
				<span>{result.duration_ms} ms</span>
			</div>

			{#if result.error}
				{@const error = result.error}
				<div
					data-testid="snippet-error"
					class="rounded border border-destructive/30 bg-destructive/10 p-2"
				>
					<div class="flex items-center gap-2">
						<span class="rounded bg-destructive/20 px-1 text-[10px] text-destructive">
							{errorKindLabel(error.kind)}
						</span>
						<span class="text-destructive">{error.message}</span>
					</div>
					{#if error.traceback}
						<button
							type="button"
							class="mt-1 text-[11px] underline"
							onclick={() => (tracebackOpen = !tracebackOpen)}
						>
							{tracebackOpen ? 'Hide' : 'Show'} traceback
						</button>
						{#if tracebackOpen}
							<div class="mt-1 flex flex-col font-mono text-[11px]">
								{#each tracebackLines(error.traceback) as tl, i (i)}
									{#if tl.line !== null}
										<button
											type="button"
											class="whitespace-pre text-left text-info/90 underline decoration-dotted hover:text-info"
											onclick={() => onGoToLine(tl.line as number)}
										>
											{tl.text}
										</button>
									{:else}
										<span class="whitespace-pre">{tl.text}</span>
									{/if}
								{/each}
							</div>
						{/if}
					{/if}
				</div>
			{/if}

			{#if result.ops.length > 0}
				<div class="flex flex-col gap-1">
					<ul data-testid="snippet-ops" class="flex flex-col gap-0.5 font-mono text-[11px]">
						{#each result.ops as op, i (i)}
							<li>{opSummary(op)}</li>
						{/each}
					</ul>
					{#if editable}
						<button
							type="button"
							data-testid="snippet-stage"
							class="self-start rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
							disabled={stale || run.stagedRunId === result.run_id}
							onclick={() => void stage()}
						>
							{run.stagedRunId === result.run_id ? 'Staged' : `Stage ops (${result.ops.length})`}
						</button>
					{/if}
					{#if stageError}
						<p class="text-destructive">{stageError}</p>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
</div>
