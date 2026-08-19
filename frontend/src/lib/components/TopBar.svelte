<script lang="ts">
	import { untrack } from 'svelte';
	import { confirm } from '$lib/state/confirm.svelte';
	import { resolve, assets } from '$app/paths';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import {
		getActiveProjectId,
		getEffectiveIssues,
		getFilename,
		getLastError,
		getLastRunAt,
		getMetamodel,
		getMetamodelFilename,
		getViewFilename,
		getModelGeneration,
		getModelRev,
		getModelSummary,
		getStagedArtifactDepth,
		getStagedChangeCount,
		getStagedDepth,
		getStagedViewDepth,
		getStrictMode,
		isRunning,
		openIssuesTab,
		openMetamodelTab,
		popLastStaged,
		refreshSummary,
		setDiffDrawerOpen,
		setHistoryDrawerOpen
	} from '$lib/state';
	import { downloadModel } from '$lib/api/model-read';
	import { saveResponseToFile } from '$lib/util/fileSave';
	import { getView } from '$lib/state';
	import { runValidation } from '$lib/state/validate-action';
	import {
		AlertCircle,
		AlertTriangle,
		ChevronDown,
		Database,
		Download,
		FileInput,
		GitCompareArrows,
		History,
		Info,
		ListChecks,
		RefreshCw,
		Settings,
		Shapes,
		Undo2
	} from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import ApplyCrDialog from './ApplyCrDialog.svelte';
	import ArtifactsMenu from './ArtifactsMenu.svelte';
	import SettingsDialog from './SettingsDialog.svelte';

	// Shared trigger style for every flat left-nav control (P-10.3, reordered
	// and consolidated by P-22). Kept as one constant so the six controls stay
	// visually identical without repeating the class list.
	const barBtn =
		'flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50';

	let applyCrOpen = $state(false);
	let settingsOpen = $state(false);
	const view = $derived(getView());

	const metamodel = $derived(getMetamodel());
	const summary = $derived(getModelSummary());
	const modelFilename = $derived(getFilename());
	const metamodelFilename = $derived(getMetamodelFilename());
	const viewFilename = $derived(getViewFilename());
	const totalChanges = $derived(getStagedChangeCount());
	// Staged artifact ops are composed in HERE rather than folded into
	// getStagedChangeCount(): that function is defined as the MODEL staged
	// diff's counts (same source as the DiffDrawer's `getStagedDiff()`), and
	// artifacts have no representation in that diff. Composing across stores at
	// the call site is the pattern this bar already uses for `viewChanges`.
	const artifactChanges = $derived(getStagedArtifactDepth());
	// Journal depth (staged view-op count), not a baseline diff — see
	// view-edits.svelte.ts. Mirrors the DiffDrawer's own switch to the journal.
	const viewChanges = $derived(getStagedViewDepth());
	const combinedChanges = $derived(totalChanges + artifactChanges + viewChanges);
	// Enabled when the model, an artifact, OR the view has uncommitted/unsaved
	// changes — this Commit button is the ONLY way to the commit drawer, so an
	// artifact-only batch has to enable it too.
	const saveDisabled = $derived(summary === null || combinedChanges === 0);
	const validating = $derived(isRunning());
	const validateDisabled = $derived(validating || summary === null);
	const undoDisabled = $derived(summary === null || getStagedDepth() === 0);
	const issues = $derived(getEffectiveIssues());
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

	// Async because the confirmation is an in-app dialog rather than the browser's
	// blocking one, so leaving is now a two-frame flow: prompt, then navigate.
	// Safe here in a way it would not be inside the workspace's `beforeNavigate`
	// unload guard: this gate runs BEFORE `goto`, with nothing waiting on its
	// answer, whereas `beforeNavigate` has to call `nav.cancel()` synchronously.
	// (That guard still fires on the `goto` below, so a user with unsaved work
	// can see both prompts — the same double-gating as before this change.)
	async function confirmDiscardChanges(): Promise<boolean> {
		if (combinedChanges === 0) return true;
		return await confirm({
			title: 'Leave this project?',
			description: 'Unsaved changes may be lost.',
			confirmLabel: 'Leave',
			variant: 'destructive'
		});
	}

	async function goHome(): Promise<void> {
		if (!(await confirmDiscardChanges())) return;
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

		<div class="h-5 w-px bg-border" aria-hidden="true"></div>
		<nav aria-label="Toolbar" class="flex items-center gap-1">
			<button
				type="button"
				class={barBtn}
				disabled={metamodel === null}
				onclick={() => openMetamodelTab()}
			>
				<Shapes class="h-3.5 w-3.5" /> Metamodel
			</button>
			<button type="button" class={barBtn} onclick={() => openIssuesTab()}>
				<ListChecks class="h-3.5 w-3.5" /> Issues
			</button>
			<ArtifactsMenu />
			<button type="button" class={barBtn} onclick={() => (applyCrOpen = true)}>
				<FileInput class="h-3.5 w-3.5" /> Apply CR
			</button>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger data-testid="model-menu-trigger" class={barBtn}>
					<Database class="h-3.5 w-3.5" />
					Model
					<ChevronDown class="h-3 w-3" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-40">
					<DropdownMenu.Item onSelect={() => setHistoryDrawerOpen(true)}>
						<History class="h-3.5 w-3.5" /> History
					</DropdownMenu.Item>
					<DropdownMenu.Item
						onSelect={() => void goto(resolve(`/p/${getActiveProjectId()}/compare`))}
					>
						<GitCompareArrows class="h-3.5 w-3.5" /> Compare
					</DropdownMenu.Item>
					<DropdownMenu.Item disabled={summary === null} onSelect={() => void onExport()}>
						<Download class="h-3.5 w-3.5" /> Export
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<button type="button" class={barBtn} onclick={() => (settingsOpen = true)}>
				<Settings class="h-3.5 w-3.5" /> Settings
			</button>
		</nav>
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
					<dt class="text-muted-foreground/70">Uncommitted (artifacts)</dt>
					<dd class="text-right font-mono text-foreground/90">{artifactChanges}</dd>
					<dt class="text-muted-foreground/70">Unsaved (view)</dt>
					<dd class="text-right font-mono text-foreground/90">{viewChanges}</dd>
				</dl>
			</div>
		</div>
	</div>
</header>

<ApplyCrDialog bind:open={applyCrOpen} />
<SettingsDialog bind:open={settingsOpen} />
