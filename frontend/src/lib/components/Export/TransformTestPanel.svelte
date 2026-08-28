<script lang="ts">
	// The exporter entry's Test panel: render the entry's table the way the
	// export would, run `transform(doc)` once, show what it printed and the
	// document before/after. The sibling of Snippet/SnippetTestPanel — same
	// disclosure, same component-local run state and generation guard (see
	// that file's header for why the state is NOT store-keyed) — minus the
	// element binding: the document IS the input, and the server builds it
	// (`POST /exports/preview-transform`), so there is nothing to bind.
	//
	// The whole ENTRY is the request, not just the snippet: the sample is
	// rendered under the entry's column overrides, `json_doc` shaping and
	// split, so the before-pane is exactly what the export would hand the
	// transform — which is why this panel lives beside the entry row rather
	// than inside the shared SnippetSourceEditor.
	import { onDestroy } from 'svelte';
	import { previewTransform } from '$lib/api/exports';
	import { ApiError } from '$lib/api/errors';
	import type { ExporterEntry, TransformPreviewOut } from '$lib/api/types';
	import { errorKindLabel, tracebackLines } from '$lib/snippet/console-view';
	import { isEmptySnippetSource } from '$lib/snippet/source';

	let {
		entry,
		onGoToLine = () => {}
	}: {
		entry: ExporterEntry;
		onGoToLine?: (line: number) => void;
	} = $props();

	const contentId = `transform-test-panel:${crypto.randomUUID()}`;

	let open = $state(false);
	let running = $state(false);
	let result = $state<TransformPreviewOut | null>(null);
	let notice = $state<string | null>(null);
	let tracebackOpen = $state(false);

	let runSeq = 0;
	onDestroy(() => {
		runSeq++;
	});

	// Mirrors SnippetTestPanel's `configured`: an unconfigured `{}` source or
	// blank inline code has nothing to run. Every server-side strictness
	// (JSON-family format, the ref resolving, the entry point existing) is
	// reported by the 422 notice below rather than pre-empted here.
	const configured = $derived(
		!isEmptySnippetSource(entry.transform) &&
			(entry.transform?.definition ? entry.transform.definition.code.trim() !== '' : true)
	);
	const runDisabled = $derived(running || !configured);

	/** Also reachable from the inline CodeEditor's Mod-Enter (through
	 * TransformSourceEditor's `onRun`), so the gate lives here, not only on
	 * the button. */
	export async function requestRun(): Promise<void> {
		open = true;
		if (runDisabled) {
			if (!running) notice = 'Pick a saved snippet or write some code first.';
			return;
		}
		const seq = ++runSeq;
		running = true;
		notice = null;
		try {
			const out = await previewTransform(entry);
			if (seq !== runSeq) return;
			running = false;
			result = out;
			tracebackOpen = false;
		} catch (err) {
			if (seq !== runSeq) return;
			running = false;
			notice = describeFailure(err);
		}
	}

	/** 422 carries the server's own sentence naming the entry's problem
	 * (missing table, non-JSON format, unresolvable ref…) — show it verbatim.
	 * The rest is SnippetTestPanel's vocabulary. */
	function describeFailure(err: unknown): string {
		if (err instanceof ApiError) {
			if (err.status === 422) {
				const detail = (err.body as { detail?: unknown } | null)?.detail;
				return typeof detail === 'string' ? detail : err.message;
			}
			if (err.status === 429) return 'Another run is already in progress — wait for it to finish.';
			if (err.status === 503) return 'Code execution is unavailable on this server.';
		}
		return 'Run failed — check your connection and try again.';
	}
</script>

<div data-testid="transform-test-panel" class="rounded border border-border/60 text-[11px]">
	<button
		type="button"
		data-testid="transform-test-toggle"
		class="flex w-full items-center gap-1 px-1.5 py-1 text-left text-muted-foreground transition-colors hover:text-foreground"
		aria-expanded={open}
		aria-controls={contentId}
		onclick={() => (open = !open)}
	>
		<span class="font-mono">{open ? '▾' : '▸'}</span> Test
	</button>
	{#if open}
		<div id={contentId}>
			<div class="flex items-center gap-2 px-1.5 py-1">
				<button
					type="button"
					data-testid="transform-test-run"
					class="rounded bg-primary px-2 py-0.5 text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
					disabled={runDisabled}
					onclick={() => void requestRun()}
				>
					Run
				</button>
				<span class="text-muted-foreground/70">renders the table, then runs transform(doc)</span>
			</div>
			<div class="flex flex-col gap-2 border-t border-border/60 p-2 text-xs">
				{#if running}
					<div class="flex items-center gap-2 text-muted-foreground">
						<div
							class="h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary"
						></div>
						Running…
					</div>
				{/if}

				{#if notice}
					<p data-testid="transform-test-notice" class="text-warning">{notice}</p>
				{/if}

				{#if result}
					<div class="flex flex-wrap items-center gap-2 text-muted-foreground/70">
						{#if result.split_file !== null}
							<span
								data-testid="transform-test-split"
								class="rounded bg-muted px-1 text-[10px]"
								title="A split export runs the transform once per file; this is the first one."
							>
								first split file: {result.split_file}
							</span>
						{/if}
						{#if result.truncated}
							<span
								data-testid="transform-test-truncated"
								class="rounded bg-muted px-1 text-[10px]"
							>
								sample covers only the head of the table
							</span>
						{/if}
						<span>{result.duration_ms} ms</span>
					</div>

					{#if result.stdout}
						<pre
							data-testid="transform-test-stdout"
							class="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">{result.stdout}</pre>
					{/if}

					{#if result.error}
						{@const error = result.error}
						<div
							data-testid="transform-test-error"
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

					<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
						<div class="flex min-w-0 flex-col gap-1">
							<span class="text-[10px] uppercase tracking-wide text-muted-foreground/70"
								>before transform</span
							>
							<pre
								data-testid="transform-test-input"
								class="max-h-72 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{result.input}</pre>
						</div>
						<div class="flex min-w-0 flex-col gap-1">
							<span class="text-[10px] uppercase tracking-wide text-muted-foreground/70"
								>after transform</span
							>
							{#if result.output !== null}
								<pre
									data-testid="transform-test-output"
									class="max-h-72 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{result.output}</pre>
							{:else}
								<p data-testid="transform-test-no-output" class="text-muted-foreground/70">
									no output — the transform failed
								</p>
							{/if}
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
