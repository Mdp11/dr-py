<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import MetamodelYamlEditor from '../Metamodel/MetamodelYamlEditor.svelte';
	import {
		canEdit,
		closeViewJsonEditor,
		discardViewJsonDraft,
		editViewJsonBuffer,
		getActiveProjectId,
		getViewJsonEditor,
		initViewJsonEditor,
		noteViewJsonServerChanged,
		saveViewJson
	} from '$lib/state';
	import { onCommitEvent, onViewEvent } from '$lib/state/realtime.svelte';

	let { viewId }: { viewId: string } = $props();

	const ed = $derived(getViewJsonEditor());
	const editable = $derived(canEdit());
	const stripError = $derived(ed.parseErrors.find((e) => e.line === null) ?? null);

	function init(): void {
		const pid = getActiveProjectId();
		if (pid !== null) void initViewJsonEditor(pid, viewId);
	}

	// Re-binds when the View menu's Edit points the tab at another view; the
	// teardown flushes the previous view's draft before the next load.
	$effect(() => {
		void viewId;
		init();
		return () => closeViewJsonEditor();
	});

	// Subscribed here rather than at module scope: realtime sits in an import
	// cycle with the view store (see view.svelte.ts's deferred taps).
	$effect(() => {
		const offView = onViewEvent((e) => {
			if (e.action === 'updated') noteViewJsonServerChanged(e.view.id);
		});
		const offCommit = onCommitEvent(({ scope }) => {
			if (scope.includes('view')) noteViewJsonServerChanged(null);
		});
		return () => {
			offView();
			offCommit();
		};
	});

	function onKeydown(e: KeyboardEvent): void {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
			e.preventDefault();
			if (editable && ed.dirty) void saveViewJson();
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex h-full min-h-0 flex-col gap-2 p-2" onkeydown={onKeydown}>
	{#if ed.phase === 'loading' || ed.phase === 'idle'}
		<p class="text-sm text-muted-foreground">Loading view…</p>
	{:else if ed.phase === 'error'}
		<div class="flex flex-col items-start gap-2">
			<p
				class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-sm text-destructive"
			>
				Couldn't load the view: {ed.loadError}
			</p>
			<Button size="sm" variant="outline" onclick={init}>Retry</Button>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-2 text-xs">
			{#if editable}
				<Button
					size="sm"
					data-testid="view-json-save"
					disabled={!ed.dirty || ed.saving || ed.parseErrors.length > 0}
					aria-busy={ed.saving}
					onclick={() => void saveViewJson()}
				>
					{ed.saving ? 'Saving…' : 'Save'}
				</Button>
				{#if ed.dirty}
					<Button size="sm" variant="ghost" onclick={() => void discardViewJsonDraft()}>
						Discard changes
					</Button>
				{/if}
				<span class="text-muted-foreground/70"> Edits apply to the view only when saved. </span>
			{:else}
				<p class="text-muted-foreground/70">The view is read-only for your role.</p>
			{/if}
		</div>

		{#if ed.stale}
			<div
				class="flex items-center gap-2 rounded border border-warning/40 bg-warning/15 px-2 py-1.5 text-xs text-warning"
			>
				<span>This view changed on the server since you opened it.</span>
				<Button size="sm" variant="outline" onclick={() => void discardViewJsonDraft()}>
					Reload (discard my changes)
				</Button>
			</div>
		{/if}

		{#if ed.draftRestored}
			<p class="rounded border border-border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
				Draft restored from your last session. “Discard changes” returns to the saved view.
			</p>
		{/if}

		<div class="min-h-0 flex-1">
			<MetamodelYamlEditor
				code={ed.buffer}
				errors={ed.parseErrors}
				readOnly={!editable || ed.saving}
				language="json"
				testid="view-json-editor"
				onChange={editViewJsonBuffer}
			/>
		</div>

		{#if stripError}
			<p
				class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-xs text-destructive"
			>
				{stripError.message}
			</p>
		{/if}

		{#if ed.saveError}
			<p
				data-testid="view-json-save-error"
				role="alert"
				class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-xs text-destructive"
			>
				{ed.saveError}
			</p>
		{/if}
	{/if}
</div>
