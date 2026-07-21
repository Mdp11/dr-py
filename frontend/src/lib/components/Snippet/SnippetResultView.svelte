<script lang="ts">
	// Pure presentation of one run outcome — extracted from SnippetConsole so
	// two owners can render the identical surface: the tab console (store-backed,
	// stages ops) and the embedded test panel (component-local state, cannot).
	// Everything here is a function of its props: no store reads, no fetches.
	//
	// The Stage button lives INSIDE the ops block, so it arrives as the
	// `opsFooter` snippet rather than a `canStage` flag — its presence is what
	// decides whether anything renders under the list, and the test panel uses
	// the same slot for its "these ops are discarded" warning.
	import type { Snippet } from 'svelte';
	import type { SnippetRunOut } from '$lib/api/snippets';
	import type { SnippetRunPhase } from '$lib/state';
	import { errorKindLabel, opSummary, tracebackLines } from '$lib/snippet/console-view';

	let {
		phase,
		notice,
		result,
		stale,
		onGoToLine,
		opsFooter
	}: {
		phase: SnippetRunPhase;
		notice: string | null;
		result: SnippetRunOut | null;
		stale: boolean;
		onGoToLine: (line: number) => void;
		opsFooter?: Snippet;
	} = $props();

	let tracebackOpen = $state(false);
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 text-xs">
	{#if phase === 'running'}
		<div class="flex items-center gap-2 text-muted-foreground">
			<div class="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary"></div>
			Running…
		</div>
	{:else if phase === 'stopping'}
		<p class="text-warning">Stopping — run ends at wall timeout.</p>
	{/if}

	{#if notice}
		<p data-testid="snippet-notice" class="text-warning">{notice}</p>
	{/if}

	{#if result}
		{#if stale}
			<p data-testid="snippet-stale" class="rounded bg-warning/15 px-2 py-1 text-warning">
				The model changed during/after this run — results may be out of date. Re-run before staging.
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
				{@render opsFooter?.()}
			</div>
		{/if}
	{/if}
</div>
