<script lang="ts">
	// The exporter entry's Test panel: render the entry's table the way the
	// export would, run `transform(doc)` once per file the export would write,
	// show what each call printed and its document before/after. The sibling
	// of Snippet/SnippetTestPanel — same disclosure, same component-local run
	// state and generation guard (see that file's header for why the state is
	// NOT store-keyed) — minus the element binding: the document IS the input,
	// and the server builds it (`POST /exports/preview-transform`), so there is
	// nothing to bind.
	//
	// The whole ENTRY is the request, not just the snippet: the sample is
	// rendered under the entry's column overrides, `json_doc` shaping and
	// split, so the before-pane is exactly what the export would hand the
	// transform — which is why this panel lives beside the entry row rather
	// than inside the shared SnippetSourceEditor.
	//
	// Unsplit, the single file renders flat. Split, the run is the export's
	// full run and each file gets its own collapsible (all collapsed at first,
	// headed by the filename the export would write), so a failing partition
	// can be found by name rather than by scrolling one long pane.
	import { onDestroy } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { previewTransform } from '$lib/api/exports';
	import { ApiError } from '$lib/api/errors';
	import type { ExporterEntry, TransformPreviewOut } from '$lib/api/types';
	import { isEmptySnippetSource } from '$lib/snippet/source';
	import TransformTestFile from './TransformTestFile.svelte';

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
	/** Indices of the expanded files of a split result; reset per run so a
	 * fresh run always starts fully collapsed. */
	const expanded = new SvelteSet<number>();

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
	const failedCount = $derived(result?.files.filter((f) => f.error !== null).length ?? 0);

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
			expanded.clear();
		} catch (err) {
			if (seq !== runSeq) return;
			running = false;
			notice = describeFailure(err);
		}
	}

	function toggleFile(i: number): void {
		if (expanded.has(i)) expanded.delete(i);
		else expanded.add(i);
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
				<span class="text-muted-foreground/70">
					{#if entry.json_split?.enabled}
						renders every file, then runs transform(doc) on each
					{:else}
						renders the table, then runs transform(doc)
					{/if}
				</span>
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
						{#if result.split}
							<span data-testid="transform-test-split" class="rounded bg-muted px-1 text-[10px]">
								{result.files.length}
								{result.files.length === 1 ? 'file' : 'files'}{failedCount > 0
									? `, ${failedCount} failed`
									: ''}
							</span>
						{/if}
						{#if result.truncated}
							<span
								data-testid="transform-test-truncated"
								class="rounded bg-muted px-1 text-[10px]"
							>
								{#if result.split}
									more files exist than were transformed; only the first are shown
								{:else}
									sample covers only the head of the table
								{/if}
							</span>
						{/if}
						<span>{result.duration_ms} ms</span>
					</div>

					{#if result.split}
						{#each result.files as file, i (file.filename)}
							{@const fileOpen = expanded.has(i)}
							{@const fileId = `${contentId}:file:${i}`}
							<div
								data-testid="transform-test-file"
								data-filename={file.filename}
								class="rounded border border-border/60"
							>
								<button
									type="button"
									data-testid="transform-test-file-toggle"
									class="flex w-full items-center gap-2 px-1.5 py-1 text-left transition-colors hover:bg-muted/50"
									aria-expanded={fileOpen}
									aria-controls={fileId}
									onclick={() => toggleFile(i)}
								>
									<span class="font-mono text-muted-foreground">{fileOpen ? '▾' : '▸'}</span>
									<span class="truncate font-mono">{file.filename}</span>
									{#if file.error}
										<span
											data-testid="transform-test-file-failed"
											class="rounded bg-destructive/20 px-1 text-[10px] text-destructive"
										>
											failed
										</span>
									{/if}
									<span class="ml-auto text-[10px] text-muted-foreground/70">
										{file.duration_ms} ms
									</span>
								</button>
								{#if fileOpen}
									<div id={fileId} class="border-t border-border/60 p-2">
										<TransformTestFile {file} {onGoToLine} />
									</div>
								{/if}
							</div>
						{/each}
					{:else if result.files.length > 0}
						<TransformTestFile file={result.files[0]} {onGoToLine} />
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</div>
