<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import {
		clearIssues,
		getBaseline,
		getDiff,
		getFilename,
		getIssues,
		getLastError,
		getLastRunAt,
		getMetamodel,
		getPendingOps,
		isRunning,
		resetOps,
		setBaseline,
		setDiffDrawerOpen,
		setFileHandle,
		setFilename,
		setMetamodel
	} from '$lib/state';
	import type { Metamodel, ModelOut } from '$lib/api/types';
	import { getView } from '$lib/state';
	import { runValidation } from '$lib/state/validate-action';
	import { saveJsonToFile } from '$lib/util/fileSave';
	import { AlertCircle, AlertTriangle, RefreshCw } from '@lucide/svelte';
	import LoadMetamodelDialog from './LoadMetamodelDialog.svelte';
	import LoadModelDialog from './LoadModelDialog.svelte';
	import LoadViewDialog from './LoadViewDialog.svelte';

	let loadMetamodelOpen = $state(false);
	let loadModelOpen = $state(false);
	let loadViewOpen = $state(false);
	let metamodelLabel: string | null = $state(null);
	let viewFilename: string | null = $state(null);
	const view = $derived(getView());

	const metamodel = $derived(getMetamodel());
	const baseline = $derived(getBaseline());
	const modelFilename = $derived(getFilename());
	const diff = $derived(getDiff());
	const totalChanges = $derived(diff.counts.added + diff.counts.modified + diff.counts.deleted);
	const saveDisabled = $derived(totalChanges === 0 || baseline === null);
	const validating = $derived(isRunning());
	const validateDisabled = $derived(validating || baseline === null);
	const issues = $derived(getIssues());
	const lastRunAt = $derived(getLastRunAt());
	const lastValidateError = $derived(getLastError());
	const errorCount = $derived(issues.filter((i) => i.severity === 'error').length);
	const warningCount = $derived(issues.length - errorCount);

	function confirmDiscardChanges(message: string): boolean {
		if (getPendingOps().length === 0) return true;
		return window.confirm(message);
	}

	function onLoadMetamodelClick(): void {
		if (
			!confirmDiscardChanges(
				'Loading a new metamodel discards the current model and unsaved changes. Continue?'
			)
		) {
			return;
		}
		loadMetamodelOpen = true;
	}

	function onLoadModelClick(): void {
		if (!confirmDiscardChanges('Loading a new model discards your unsaved changes. Continue?')) {
			return;
		}
		loadModelOpen = true;
	}

	function onMetamodelUploaded(mm: Metamodel, filename: string): void {
		setMetamodel(mm);
		metamodelLabel = filename;
		setBaseline(null);
		setFilename(null);
		setFileHandle(null);
		resetOps();
		clearIssues();
	}

	function onModelLoaded(loaded: ModelOut, filename: string): void {
		setBaseline(loaded);
		setFilename(filename);
		setFileHandle(null);
		resetOps();
		clearIssues();
	}

	function onLoadViewClick(): void {
		loadViewOpen = true;
	}

	function onViewLoaded(_view: unknown, filename: string): void {
		viewFilename = filename;
	}

	async function onExportView(): Promise<void> {
		if (view === null) return;
		try {
			const suggested = viewFilename ?? `${view.name || 'view'}.view.json`;
			await saveJsonToFile(view, suggested);
		} catch (err) {
			console.error('Export view failed', err);
		}
	}
</script>

<header
	class="sticky top-0 z-20 col-span-5 flex h-10 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 text-sm"
>
	<div class="flex items-center gap-3">
		<span class="font-semibold tracking-tight text-zinc-100">Data Rover</span>

		<div class="flex items-center gap-2">
			<span class="text-xs text-zinc-500">Metamodel:</span>
			<span class="font-mono text-xs text-zinc-300">
				{metamodelLabel ?? (metamodel ? 'loaded' : '—')}
			</span>
			<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={onLoadMetamodelClick}>
				Load metamodel...
			</Button>
		</div>

		<div class="flex items-center gap-2">
			<span class="text-xs text-zinc-500">Model:</span>
			<span class="font-mono text-xs text-zinc-300">
				{modelFilename ?? (baseline ? 'loaded' : '—')}
			</span>
			<Button
				variant="ghost"
				size="sm"
				class="h-7 text-xs"
				disabled={metamodel === null}
				onclick={onLoadModelClick}
			>
				Load model...
			</Button>
		</div>

		<div class="flex items-center gap-2">
			<span class="text-xs text-zinc-500">View:</span>
			<span class="font-mono text-xs text-zinc-300">
				{view ? (viewFilename ?? view.name) : '—'}
			</span>
			<Button
				variant="ghost"
				size="sm"
				class="h-7 text-xs"
				disabled={baseline === null}
				onclick={onLoadViewClick}
			>
				Load view...
			</Button>
			<Button
				variant="ghost"
				size="sm"
				class="h-7 text-xs"
				disabled={view === null}
				onclick={onExportView}
			>
				Export view
			</Button>
		</div>
	</div>

	<div class="flex items-center gap-2">
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
			disabled={saveDisabled}
			onclick={() => setDiffDrawerOpen(true)}
		>
			{totalChanges > 0 ? `Save (${totalChanges})` : 'Save'}
		</Button>
		<span class="font-mono text-xs {totalChanges > 0 ? 'text-red-400' : 'text-zinc-500'}">
			● {totalChanges}
			{totalChanges === 1 ? 'change' : 'changes'}
		</span>
	</div>
</header>

<LoadMetamodelDialog bind:open={loadMetamodelOpen} onUploaded={onMetamodelUploaded} />
<LoadModelDialog bind:open={loadModelOpen} onLoaded={onModelLoaded} />
<LoadViewDialog bind:open={loadViewOpen} onLoaded={onViewLoaded} />
