<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve, assets } from '$app/paths';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
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
	import { Ellipsis, AlertCircle, AlertTriangle, Info, RefreshCw, Undo2 } from '@lucide/svelte';
	import ApplyCrDialog from './ApplyCrDialog.svelte';
	import SwapMetamodelDrawer from './SwapMetamodelDrawer.svelte';
	import SettingsDialog from './SettingsDialog.svelte';

	let applyCrOpen = $state(false);
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

	function goHome(): void {
		if (!confirmDiscardChanges('Leave this project? Unsaved changes may be lost.')) return;
		void goto(resolve('/projects'));
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
	class="sticky top-0 z-20 col-span-5 flex h-11 items-center justify-between border-b border-border bg-background px-4 text-sm"
>
	<div class="flex items-center gap-3">
		<button
			type="button"
			class="flex items-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			aria-label="Data Rover"
			onclick={goHome}
		>
			<img src={`${assets}/dr-mark.png`} alt="" class="h-7 w-auto" />
		</button>

		<div class="group relative flex items-center">
			<button
				type="button"
				class="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label="Loaded files"
			>
				<Info class="h-4 w-4" />
			</button>
			<div
				role="tooltip"
				class="pointer-events-none absolute top-full left-0 z-30 hidden w-max rounded border border-border bg-popover p-2 shadow-lg group-focus-within:block group-hover:block"
			>
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					<dt class="text-muted-foreground/70">Metamodel</dt>
					<dd class="font-mono text-foreground/90">
						{metamodelFilename ?? (metamodel ? 'loaded' : '—')}
					</dd>
					<dt class="text-muted-foreground/70">Model</dt>
					<dd class="font-mono text-foreground/90">
						{modelFilename ?? (summary ? 'loaded' : '—')}
					</dd>
					<dt class="text-muted-foreground/70">View</dt>
					<dd class="font-mono text-foreground/90">{view ? (viewFilename ?? view.name) : '—'}</dd>
				</dl>
			</div>
		</div>
	</div>

	<div class="flex items-center gap-2">
		<span class="contents" aria-live="polite">
			{#if validating}
				<span class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
					Running validation…
				</span>
			{:else if lastValidateError !== null}
				<span
					class="rounded bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] text-destructive"
				>
					Validation failed
				</span>
			{:else if lastRunAt !== null}
				{#if issues.length === 0}
					<span class="rounded bg-success/15 px-1.5 py-0.5 font-mono text-[10px] text-success">
						✓ no issues
					</span>
				{:else}
					<span
						class="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
					>
						{#if errorCount > 0}
							<AlertCircle class="h-3 w-3 text-destructive" />
							<span class="text-destructive"
								>{errorCount} {errorCount === 1 ? 'error' : 'errors'}</span
							>
						{/if}
						{#if warningCount > 0}
							<AlertTriangle class="h-3 w-3 text-warning" />
							<span class="text-warning">
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
			class="h-7 gap-1 text-xs"
			disabled={undoDisabled}
			onclick={onUndo}
		>
			<Undo2 class="h-3 w-3" />
			Undo
		</Button>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1 text-xs"
			disabled={validateDisabled}
			aria-busy={validating}
			onclick={() => void runValidation()}
		>
			<RefreshCw class="h-3 w-3 {validating ? 'animate-spin' : ''}" />
			Validate
		</Button>
		<Button
			variant="outline"
			size="sm"
			class="h-7 text-xs"
			disabled={saveDisabled}
			onclick={() => setDiffDrawerOpen(true)}
		>
			Commit
		</Button>
		{#if strictOn}
			<span
				class="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] text-warning"
				title="Strict mode on: commits with validation errors are blocked."
			>
				Strict
			</span>
		{/if}
		<div class="group relative flex items-center">
			<span
				class="font-mono text-xs {combinedChanges > 0
					? 'text-destructive'
					: 'text-muted-foreground/70'}"
			>
				● {combinedChanges}
				{combinedChanges === 1 ? 'change' : 'changes'}
			</span>
			<div
				role="tooltip"
				class="absolute top-full right-0 z-30 hidden w-max rounded border border-border bg-popover p-2 shadow-lg group-focus-within:block group-hover:block"
			>
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					<dt class="text-muted-foreground/70">Uncommitted (model)</dt>
					<dd class="text-right font-mono text-foreground/90">{totalChanges}</dd>
					<dt class="text-muted-foreground/70">Unsaved (view)</dt>
					<dd class="text-right font-mono text-foreground/90">{viewChanges}</dd>
				</dl>
			</div>
		</div>
		<kbd
			class="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70"
			title="Command palette">⌘K</kbd
		>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label="More actions"
			>
				<Ellipsis class="h-4 w-4" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-48">
				<DropdownMenu.Item>
					{#snippet child({ props })}
						<a {...props} href={resolve(`/p/${getActiveProjectId()}/compare`)}>Compare</a>
					{/snippet}
				</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => (applyCrOpen = true)}>Apply CR</DropdownMenu.Item>
				<DropdownMenu.Item disabled={metamodel === null} onclick={() => (swapOpen = true)}>
					Swap Metamodel
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item disabled={summary === null} onclick={() => void onExport()}>
					Export
				</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => setHistoryDrawerOpen(true)}>History</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item onclick={() => (settingsOpen = true)}>Settings</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
</header>

<ApplyCrDialog bind:open={applyCrOpen} />
<SwapMetamodelDrawer bind:open={swapOpen} />
<SettingsDialog bind:open={settingsOpen} />
