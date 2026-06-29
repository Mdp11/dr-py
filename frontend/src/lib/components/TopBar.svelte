<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import {
		getActiveProjectId,
		getFilename,
		getIssues,
		getLastError,
		getLastRunAt,
		getMetamodel,
		getMetamodelFilename,
		getViewFilename,
		getModelGeneration,
		getModelRev,
		getModelSummary,
		getStagedChangeCount,
		getStagedDepth,
		getStrictMode,
		getViewChangesCount,
		isRunning,
		popLastStaged,
		refreshSummary,
		setDiffDrawerOpen,
		setHistoryDrawerOpen
	} from '$lib/state';
	import { downloadModel } from '$lib/api/model-read';
	import { saveResponseToFile } from '$lib/util/fileSave';
	import { getView } from '$lib/state';
	import { runValidation } from '$lib/state/validate-action';
	import { AlertCircle, AlertTriangle, FolderOpen, Info, RefreshCw, Undo2 } from '@lucide/svelte';
	import ApplyCrDialog from './ApplyCrDialog.svelte';
	import LoadFilesDialog from './LoadFilesDialog.svelte';
	import SwapMetamodelDrawer from './SwapMetamodelDrawer.svelte';
	import SettingsDialog from './SettingsDialog.svelte';

	let applyCrOpen = $state(false);
	let loadOpen = $state(false);
	let swapOpen = $state(false);
	let settingsOpen = $state(false);
	const view = $derived(getView());

	const metamodel = $derived(getMetamodel());
	const summary = $derived(getModelSummary());
	const modelFilename = $derived(getFilename());
	const metamodelFilename = $derived(getMetamodelFilename());
	const viewFilename = $derived(getViewFilename());
	const totalChanges = $derived(getStagedChangeCount());
	const viewChanges = $derived(getViewChangesCount());
	const combinedChanges = $derived(totalChanges + viewChanges);
	// Enabled when the model OR the view has uncommitted/unsaved changes.
	const saveDisabled = $derived(summary === null || combinedChanges === 0);
	const validating = $derived(isRunning());
	const validateDisabled = $derived(validating || summary === null);
	const undoDisabled = $derived(summary === null || getStagedDepth() === 0);
	const issues = $derived(getIssues());
	const lastRunAt = $derived(getLastRunAt());
	const lastValidateError = $derived(getLastError());
	const strictOn = $derived(getStrictMode());
	const errorCount = $derived(issues.filter((i) => i.severity === 'error').length);
	const warningCount = $derived(issues.length - errorCount);

	// Post-commit refresh policy: every commit / apply-cr bumps model_rev; on
	// each bump re-fetch the summary — element/relationship counts are NOT
	// maintained incrementally by deltas. The staged badge is client-derived
	// and reactive via getStagedChangeCount(), so no server refresh is needed.
	// The summary presence check is untracked so the refreshed summary object
	// (new identity, same rev) can't retrigger the effect.
	$effect(() => {
		void getModelRev();
		void getModelGeneration();
		const hasModel = untrack(() => getModelSummary() !== null);
		if (!hasModel) return;
		refreshSummary().catch(() => {
			// best-effort; counts catch up on the next bump
		});
	});

	function confirmDiscardChanges(message: string): boolean {
		if (combinedChanges === 0) return true;
		return window.confirm(message);
	}

	function onLoadClick(): void {
		if (
			!confirmDiscardChanges(
				'Loading new files discards the current model and unsaved changes. Continue?'
			)
		) {
			return;
		}
		loadOpen = true;
	}

	function onUndo(): void {
		popLastStaged();
	}

	async function onExport(): Promise<void> {
		try {
			const resp = await downloadModel();
			await saveResponseToFile(resp, modelFilename ?? 'model.json');
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			console.error('Export failed', err);
		}
	}
</script>

<header
	class="sticky top-0 z-20 col-span-5 flex h-10 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 text-sm"
>
	<div class="flex items-center gap-3">
		<span class="font-semibold tracking-tight text-zinc-100">Data Rover</span>

		<div class="group relative flex items-center">
			<button
				type="button"
				class="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
				aria-label="Loaded files"
			>
				<Info class="h-4 w-4" />
			</button>
			<div
				role="tooltip"
				class="pointer-events-none absolute left-0 top-full z-30 hidden w-max rounded border border-zinc-800 bg-zinc-900 p-2 shadow-lg group-hover:block group-focus-within:block"
			>
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					<dt class="text-zinc-500">Metamodel</dt>
					<dd class="font-mono text-zinc-200">
						{metamodelFilename ?? (metamodel ? 'loaded' : '—')}
					</dd>
					<dt class="text-zinc-500">Model</dt>
					<dd class="font-mono text-zinc-200">{modelFilename ?? (summary ? 'loaded' : '—')}</dd>
					<dt class="text-zinc-500">View</dt>
					<dd class="font-mono text-zinc-200">{view ? (viewFilename ?? view.name) : '—'}</dd>
				</dl>
			</div>
		</div>

		<Button variant="ghost" size="sm" class="h-7 gap-1 text-xs" onclick={onLoadClick}>
			<FolderOpen class="h-3 w-3" />
			Load Model
		</Button>

		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1 text-xs"
			disabled={metamodel === null}
			onclick={() => (swapOpen = true)}
		>
			Swap Metamodel
		</Button>

		<div class="flex items-center gap-2">
			<a
				href={resolve(`/p/${getActiveProjectId()}/compare`)}
				class="inline-flex h-7 items-center rounded px-2 text-xs text-zinc-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
			>
				Compare
			</a>
			<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => (applyCrOpen = true)}>
				Apply CR
			</Button>
		</div>
	</div>

	<div class="flex items-center gap-2">
		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1 text-xs focus-visible:ring-2 focus-visible:ring-indigo-500"
			disabled={undoDisabled}
			onclick={onUndo}
		>
			<Undo2 class="h-3 w-3" />
			Undo
		</Button>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1 text-xs focus-visible:ring-2 focus-visible:ring-indigo-500"
			disabled={validateDisabled}
			aria-busy={validating}
			onclick={() => void runValidation()}
		>
			<RefreshCw class="h-3 w-3 {validating ? 'animate-spin' : ''}" />
			Validate
		</Button>
		<span class="contents" aria-live="polite">
			{#if validating}
				<span class="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
					Running validation…
				</span>
			{:else if lastValidateError !== null}
				<span class="rounded bg-red-950/60 px-1.5 py-0.5 font-mono text-[10px] text-red-300">
					Validation failed
				</span>
			{:else if lastRunAt !== null}
				{#if issues.length === 0}
					<span
						class="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300"
					>
						✓ no issues
					</span>
				{:else}
					<span
						class="flex items-center gap-1 rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px]"
					>
						{#if errorCount > 0}
							<AlertCircle class="h-3 w-3 text-red-400" />
							<span class="text-red-300">{errorCount} {errorCount === 1 ? 'error' : 'errors'}</span>
						{/if}
						{#if warningCount > 0}
							<AlertTriangle class="h-3 w-3 text-amber-400" />
							<span class="text-amber-300">
								{warningCount}
								{warningCount === 1 ? 'warning' : 'warnings'}
							</span>
						{/if}
					</span>
				{/if}
			{/if}
		</span>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 text-xs focus-visible:ring-2 focus-visible:ring-indigo-500"
			disabled={summary === null}
			onclick={() => void onExport()}
		>
			Export
		</Button>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 text-xs focus-visible:ring-2 focus-visible:ring-indigo-500"
			disabled={saveDisabled}
			onclick={() => setDiffDrawerOpen(true)}
		>
			Commit
		</Button>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 text-xs focus-visible:ring-2 focus-visible:ring-indigo-500"
			onclick={() => setHistoryDrawerOpen(true)}
		>
			History
		</Button>
		{#if strictOn}
			<span
				class="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300"
				title="Strict mode on: commits with validation errors are blocked."
			>
				Strict
			</span>
		{/if}
		<Button
			variant="ghost"
			size="sm"
			class="h-7 text-xs focus-visible:ring-2 focus-visible:ring-indigo-500"
			onclick={() => (settingsOpen = true)}
		>
			Settings
		</Button>
		<div class="group relative flex items-center">
			<span class="font-mono text-xs {combinedChanges > 0 ? 'text-red-400' : 'text-zinc-500'}">
				● {combinedChanges}
				{combinedChanges === 1 ? 'change' : 'changes'}
			</span>
			<div
				role="tooltip"
				class="absolute right-0 top-full z-30 hidden w-max rounded border border-zinc-800 bg-zinc-900 p-2 shadow-lg group-hover:block group-focus-within:block"
			>
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					<dt class="text-zinc-500">Uncommitted (model)</dt>
					<dd class="text-right font-mono text-zinc-200">{totalChanges}</dd>
					<dt class="text-zinc-500">Unsaved (view)</dt>
					<dd class="text-right font-mono text-zinc-200">{viewChanges}</dd>
				</dl>
			</div>
		</div>
	</div>
</header>

<ApplyCrDialog bind:open={applyCrOpen} />
<LoadFilesDialog bind:open={loadOpen} />
<SwapMetamodelDrawer bind:open={swapOpen} />
<SettingsDialog bind:open={settingsOpen} />
