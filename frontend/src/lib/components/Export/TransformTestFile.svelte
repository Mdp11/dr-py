<script lang="ts">
	// One file of a transform test run: what the call printed, its failure
	// (with a traceback whose frames jump the host's editor), and the document
	// before/after. Presentation only — TransformTestPanel owns the run and,
	// for a split run, the per-file disclosure around this.
	import type { TransformPreviewFileOut } from '$lib/api/types';
	import { errorKindLabel, tracebackLines } from '$lib/snippet/console-view';

	let {
		file,
		onGoToLine = () => {}
	}: {
		file: TransformPreviewFileOut;
		onGoToLine?: (line: number) => void;
	} = $props();

	let tracebackOpen = $state(false);
</script>

<div class="flex flex-col gap-2 text-xs">
	{#if file.stdout}
		<pre
			data-testid="transform-test-stdout"
			class="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">{file.stdout}</pre>
	{/if}

	{#if file.error}
		{@const error = file.error}
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
				class="max-h-72 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{file.input}</pre>
		</div>
		<div class="flex min-w-0 flex-col gap-1">
			<span class="text-[10px] uppercase tracking-wide text-muted-foreground/70"
				>after transform</span
			>
			{#if file.output !== null}
				<pre
					data-testid="transform-test-output"
					class="max-h-72 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{file.output}</pre>
			{:else}
				<p data-testid="transform-test-no-output" class="text-muted-foreground/70">
					no output — the transform failed
				</p>
			{/if}
		</div>
	</div>
</div>
