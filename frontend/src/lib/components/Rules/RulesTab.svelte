<script lang="ts">
	// The rules tab root: name + Save toolbar over the shared YAML editor, with
	// a drift-warning strip between them. Mirrors Export/ExporterTab.svelte's
	// chrome-bar-over-content shape; the editor itself is the metamodel tab's,
	// reused — same YAML surface, same gutter markers, different document.
	import {
		canEdit,
		editRulesDraft,
		ensureRulesDraft,
		getRulesDraft,
		getRulesLockHolder,
		retryRulesLock,
		saveRulesDraft,
		setRulesName
	} from '$lib/state';
	import ArtifactExportButton from '$lib/components/ArtifactExportButton.svelte';
	import MetamodelYamlEditor from '$lib/components/Metamodel/MetamodelYamlEditor.svelte';

	let { tabId }: { tabId: string } = $props();

	$effect(() => {
		void ensureRulesDraft(tabId);
	});

	const draft = $derived(getRulesDraft(tabId));
	const editable = $derived(canEdit());
	/** Non-null while a peer holds this rule set's `art:` lease: the tab is
	 * UNSAVEABLE until the check-out succeeds — Save is disabled behind the
	 * banner ("Retry"), and the editor goes read-only so it cannot accumulate
	 * edits that could never land. */
	const lockHolder = $derived(getRulesLockHolder(tabId));
	const locked = $derived(lockHolder !== null);
	/** First message-only lint error (no line anchor) for the strip below the
	 * toolbar; positioned errors render in the gutter instead. A rule set's
	 * errors are message-only far more often than not — only a YAML PARSE
	 * failure carries a position, so every schema violation lands here. */
	const stripError = $derived(draft?.lintErrors.find((e) => e.line === null) ?? null);

	let saveError = $state<string | null>(null);

	function save(): void {
		saveError = null;
		try {
			saveRulesDraft(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}
</script>

{#if !draft}
	<p class="p-4 text-xs text-muted-foreground/70">Loading…</p>
{:else}
	<div class="flex h-full flex-col overflow-hidden" data-testid="rules-tab">
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<input
				class="w-56 rounded border border-input bg-card px-2 py-1 text-xs"
				aria-label="Rule set name"
				value={draft.name}
				disabled={!editable || locked}
				oninput={(e) => setRulesName(tabId, e.currentTarget.value)}
			/>
			<span class="flex-1"></span>
			{#if editable}
				<button
					type="button"
					data-testid="rules-save"
					class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
					disabled={locked}
					onclick={save}
				>
					Save{draft.dirty ? ' *' : ''}
				</button>
			{/if}
			<ArtifactExportButton {tabId} />
		</div>
		{#if saveError}
			<p class="px-3 py-1 text-xs text-destructive">{saveError}</p>
		{/if}
		{#if stripError}
			<p
				data-testid="rules-lint-error"
				class="mx-3 my-1 max-h-24 overflow-auto whitespace-pre-wrap rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-xs text-destructive"
			>
				{stripError.message}
			</p>
		{/if}
		{#if lockHolder !== null}
			<div
				class="flex items-center gap-2 bg-warning/15 px-3 py-1.5 text-xs text-warning"
				role="status"
			>
				Checked out by {lockHolder} — you will not be able to save.
				<button type="button" class="underline" onclick={() => void retryRulesLock(tabId)}>
					Retry
				</button>
			</div>
		{/if}
		{#if draft.lintWarnings.length > 0}
			<!-- Drift, not invalidity: a rule naming something the metamodel no
			     longer has is SKIPPED at validation time, so this reads as a
			     notice and never as an error. -->
			<div
				data-testid="rules-drift-warnings"
				class="max-h-24 overflow-y-auto border-b border-border/70 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
			>
				<!-- Keyed by index: the whole list is replaced by every lint
				     response, and two rules can carry identical text. -->
				{#each draft.lintWarnings as w, i (i)}
					<p><span class="text-foreground/80">{w.rule}</span> — {w.message}</p>
				{/each}
			</div>
		{/if}
		<div class="min-h-0 flex-1">
			<MetamodelYamlEditor
				testid="rules-editor"
				code={draft.yaml}
				errors={draft.lintErrors}
				readOnly={!editable || locked}
				onChange={(yaml) => editRulesDraft(tabId, yaml)}
			/>
		</div>
	</div>
{/if}
