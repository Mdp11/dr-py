<script lang="ts">
	import { untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import {
		getChangesBadgeTotal,
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
		getUndoDepth,
		getViewChangesCount,
		hasPendingOps,
		isRunning,
		refreshChangesBadge,
		refreshSummary,
		setDiffDrawerOpen,
		undo
	} from '$lib/state';
	import { getView } from '$lib/state';
	import { runValidation } from '$lib/state/validate-action';
	import { AlertCircle, AlertTriangle, FolderOpen, Info, RefreshCw, Undo2 } from '@lucide/svelte';
	import ApplyCrDialog from './ApplyCrDialog.svelte';
	import LoadFilesDialog from './LoadFilesDialog.svelte';

	let applyCrOpen = $state(false);
	let loadOpen = $state(false);
	const view = $derived(getView());

	const metamodel = $derived(getMetamodel());
	const summary = $derived(getModelSummary());
	const modelFilename = $derived(getFilename());
	const metamodelFilename = $derived(getMetamodelFilename());
	const viewFilename = $derived(getViewFilename());
	const totalChanges = $derived(getChangesBadgeTotal());
	const viewChanges = $derived(getViewChangesCount());
	const combinedChanges = $derived(totalChanges + viewChanges);
	const pending = $derived(hasPendingOps());
	const saveDisabled = $derived(summary === null || (combinedChanges === 0 && !pending));
	const validating = $derived(isRunning());
	const validateDisabled = $derived(validating || summary === null);
	const undoDisabled = $derived(summary === null || getUndoDepth() === 0);
	const issues = $derived(getIssues());
	const lastRunAt = $derived(getLastRunAt());
	const lastValidateError = $derived(getLastError());
	const errorCount = $derived(issues.filter((i) => i.severity === 'error').length);
	const warningCount = $derived(issues.length - errorCount);

	// Post-flush refresh policy: every acked ops batch / undo / apply-cr bumps
	// model_rev; on each bump re-fetch (a) the summary — element/relationship
	// counts are NOT maintained incrementally by deltas — and (b) the server
	// change-set badge. The summary presence check is untracked so the
	// refreshed summary object (new identity, same rev) can't retrigger the
	// effect.
	$effect(() => {
		void getModelRev();
		void getModelGeneration();
		const hasModel = untrack(() => getModelSummary() !== null);
		if (!hasModel) return;
		refreshSummary().catch(() => {
			// best-effort; counts catch up on the next bump
		});
		refreshChangesBadge().catch(() => {
			// best-effort badge; a failed refresh keeps the previous value
		});
	});

	function confirmDiscardChanges(message: string): boolean {
		if (totalChanges === 0 && !hasPendingOps()) return true;
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

	let undoing = $state(false);

	async function onUndo(): Promise<void> {
		if (undoing) return;
		undoing = true;
		try {
			await undo();
		} catch (err) {
			console.error('Undo failed', err);
		} finally {
			undoing = false;
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

		<div class="flex items-center gap-2">
			<a
				href={resolve('/compare')}
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
			disabled={undoDisabled || undoing}
			aria-busy={undoing}
			onclick={() => void onUndo()}
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
			disabled={saveDisabled}
			onclick={() => setDiffDrawerOpen(true)}
		>
			Save
		</Button>
		<div class="group relative flex items-center">
			<span class="font-mono text-xs {combinedChanges > 0 ? 'text-red-400' : 'text-zinc-500'}">
				● {combinedChanges}
				{combinedChanges === 1 ? 'change' : 'changes'}
			</span>
			<div
				role="tooltip"
				class="pointer-events-none absolute right-0 top-full z-30 hidden w-max rounded border border-zinc-800 bg-zinc-900 p-2 shadow-lg group-hover:block group-focus-within:block"
			>
				<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
					<dt class="text-zinc-500">Model</dt>
					<dd class="text-right font-mono text-zinc-200">{totalChanges}</dd>
					<dt class="text-zinc-500">View</dt>
					<dd class="text-right font-mono text-zinc-200">{viewChanges}</dd>
				</dl>
			</div>
		</div>
	</div>
</header>

<ApplyCrDialog bind:open={applyCrOpen} />
<LoadFilesDialog bind:open={loadOpen} />
