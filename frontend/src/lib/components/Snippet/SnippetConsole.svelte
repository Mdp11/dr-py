<script lang="ts">
	// Store-bound wrapper over SnippetResultView: reads the run state for
	// `tabId`, derives staleness against the working copy's stamp, and owns the ONE
	// thing the pure view cannot — staging the run's recorded ops into the op
	// buffer. Everything else is presentation and lives in SnippetResultView
	// (shared with the embedded test panel, which stages nothing).
	import {
		canEdit,
		getSnippetRun,
		getWorkingStamp,
		markRunStaged,
		scriptsNeedEngine,
		stageSnippetOps
	} from '$lib/state';
	import ScriptsNeedEngine from '$lib/components/ScriptsNeedEngine.svelte';
	import { isResultStale } from '$lib/snippet/console-view';
	import SnippetResultView from './SnippetResultView.svelte';

	let { tabId, onGoToLine }: { tabId: string; onGoToLine: (line: number) => void } = $props();

	const run = $derived(getSnippetRun(tabId));
	const stale = $derived(run.result ? isResultStale(run.result, getWorkingStamp()) : false);
	const editable = $derived(canEdit());

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
		// 'stale' -> `stale` above already re-derives from the same stamp check
		// stageSnippetOps just performed, so the banner appears and the Stage
		// button disables on its own. 'locks' -> the shared lock-notice banner
		// (StatusBar / getLockNotice) already surfaces the refusal.
	}
</script>

{#snippet stageFooter()}
	{#if editable && run.result}
		{@const result = run.result}
		<button
			type="button"
			data-testid="snippet-stage"
			class="self-start rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
			disabled={stale || run.stagedResult === result}
			onclick={() => void stage()}
		>
			{run.stagedResult === result ? 'Staged' : `Stage ops (${result.ops.length})`}
		</button>
	{/if}
	{#if stageError}
		<p class="text-destructive">{stageError}</p>
	{/if}
{/snippet}

<div class="flex h-full flex-col overflow-hidden border-t border-border">
	{#if scriptsNeedEngine()}
		<ScriptsNeedEngine />
	{:else}
		<SnippetResultView
			phase={run.phase}
			notice={run.notice}
			result={run.result}
			{stale}
			{onGoToLine}
			opsFooter={stageFooter}
			staleHint="Re-run before staging."
		/>
	{/if}
</div>
