<script lang="ts">
	// The table tab root: a slim chrome bar (name input, dirty dot, Settings,
	// Export, Save/Save as…, conflict banner) above a full-height `TableGrid`.
	// Definition editing (row source + columns) lives in a modal opened by the
	// ⚙ Settings button so the grid gets the whole area — see
	// docs/superpowers/specs/2026-07-13-table-settings-popup-design.md.
	import {
		abandonTableEvaluationSuspension,
		canEdit,
		canRequestScriptErrors,
		downloadTable,
		ensureTableDraft,
		getScriptErrors,
		getScriptErrorsPhase,
		getTableConflict,
		getTableDraft,
		getTableLoading,
		getTablePage,
		getTableScriptStatus,
		getTableWarnings,
		getUncomputedScriptCellReason,
		reloadTableDraft,
		requestScriptErrors,
		requestScrollToCell,
		resumeTableEvaluation,
		revertSuspendedTableEdits,
		saveAsTableDraft,
		saveTableDraft,
		setTableName,
		suspendTableEvaluation,
		updateTableDefinition,
		type ExportProgress
	} from '$lib/state';
	import { AlertTriangle, Check, Search, Settings } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		addColumn,
		newNavigationColumn,
		newPropertyColumn,
		newScriptColumn
	} from '$lib/table/columns';
	import ColumnManager from './ColumnManager.svelte';
	import ScriptErrorsPanel from './ScriptErrorsPanel.svelte';
	import TableGrid from './TableGrid.svelte';

	let { tabId }: { tabId: string } = $props();
	$effect(() => {
		void ensureTableDraft(tabId);
	});
	const draft = $derived(getTableDraft(tabId));
	const conflict = $derived(getTableConflict(tabId));
	const editable = $derived(canEdit());
	const page = $derived(getTablePage(tabId));
	const warnings = $derived(getTableWarnings(tabId));
	// Progress of the background script-value sweep: `computing` means some
	// cells came back `pending` and the store has a re-poll scheduled (rows are
	// in BUILD order until it lands — a sort over half-computed values would
	// reshuffle on every poll, so the backend deliberately doesn't sort them).
	const scriptStatus = $derived(getTableScriptStatus(tabId));
	// Whole-table recap of the failing script cells. The grid is virtualized, so
	// without this a failure a few thousand rows down is unreachable — the badge
	// is how it is found.
	//
	// It is fetched ON DEMAND, on the badge click, and the up-front error count
	// is deliberately given up: `POST /tables/script-errors` renders the whole
	// table cache-only, so for the commonest shape (an unsorted collapse script
	// column, whose page never computes anything outside the visible window)
	// fetching it on settle would kick a full background sweep on every table
	// open. So the badge is NEUTRAL until a recap says otherwise.
	const scriptErrors = $derived(getScriptErrors(tabId));
	const scriptErrorsPhase = $derived(getScriptErrorsPhase(tabId));
	// The badge shows exactly while asking would DO something — the store's own
	// answer, not a re-derivation from `scriptStatus`. A settled status is
	// necessary (while `computing` the grid is in degraded build order, which a
	// recap's row indices would not address) but NOT sufficient: a sort or reload
	// in flight has already dropped the askable page state while the previous
	// page's status is still sitting there, and a badge lit in that window
	// invites a click that does nothing at all.
	const canCheckScriptErrors = $derived(canRequestScriptErrors(tabId));
	const scriptErrorCount = $derived(scriptErrors?.total_errors ?? 0);
	// An empty recap means "we checked, there are none" — UNLESS the cells on
	// screen say nothing was ever computed. The backend answers a runner-less
	// recap with zero errors (the honest count: nothing ran, so nothing is known
	// to have failed) and `ScriptErrorsOut` has no room to say which zero it is,
	// so the client tells them apart from the page it is already showing. Only
	// consulted for an empty recap, and `&&` short-circuits, so a table with a
	// real count (or no answer yet) never pays for the scan.
	const uncomputedReason = $derived(
		scriptErrorsPhase === 'done' && scriptErrorCount === 0
			? getUncomputedScriptCellReason(tabId)
			: null
	);
	let scriptErrorsOpen = $state(false);
	// The panel must not outlive what it describes: the badge going away (the
	// table went back to computing, or lost its script column), or the recap
	// being invalidated under it by a newer page state — `idle` means nothing
	// was asked for the state now on screen, so there is nothing to show.
	$effect(() => {
		if (!canCheckScriptErrors || scriptErrorsPhase === 'idle') scriptErrorsOpen = false;
	});
	// Opening IS asking: the store no-ops when a recap for this page state is
	// already on hand (or already in flight), so a double click costs one fetch.
	function toggleScriptErrors(): void {
		if (scriptErrorsOpen) {
			scriptErrorsOpen = false;
			return;
		}
		requestScriptErrors(tabId);
		scriptErrorsOpen = true;
	}
	function jumpToErrorCell(rowIndex: number, columnIndex: number): void {
		requestScrollToCell(tabId, rowIndex, columnIndex);
		scriptErrorsOpen = false;
	}
	// Escape dismisses the panel from anywhere inside it (keydown bubbles from
	// the badge and from every entry button up to their shared wrapper) — the
	// same one-liner idiom `PropertyColumnEditor`'s suggestion popup uses. No
	// focus trap: the panel is a non-modal disclosure, so tabbing out of it is
	// a legitimate way to leave it too.
	function onScriptErrorsKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') scriptErrorsOpen = false;
	}
	const loading = $derived(getTableLoading(tabId));
	// The sweep's fraction, or null when it has no total to divide by. Drives a
	// DETERMINATE bar; everything else falls back to the indeterminate sweep.
	const sweepPercent = $derived.by(() => {
		const s = scriptStatus;
		if (s?.state !== 'computing' || !s.total || s.total <= 0) return null;
		return Math.min(100, Math.round((s.done / s.total) * 100));
	});
	// Any expand column multiplies rows — then the count reads
	// "N elements → M rows" (the pre-split base vs the split result).
	const hasSplit = $derived(
		draft?.definition.columns.some((c) => c.kind !== 'element' && c.mode === 'expand') ?? false
	);
	let saveError = $state<string | null>(null);
	// Export is a retry loop while the backend's script sweep is still filling
	// in this table's cells (202 + Retry-After): the button reports progress and
	// stays disabled for the duration, and the controller aborts the loop when
	// the tab unmounts so it can't keep polling for a view that is gone.
	let exporting = $state(false);
	let exportProgress = $state<ExportProgress | null>(null);
	let exportAbort: AbortController | null = null;
	$effect(() => () => exportAbort?.abort());
	// Unmounting with the settings dialog still open would leave the tab
	// suspended forever (nothing else clears that key), so the tab would silently
	// stop evaluating. Drop the suspension WITHOUT evaluating — firing a request
	// for a view that is going away is exactly what we don't want.
	$effect(() => () => abandonTableEvaluationSuspension(tabId));
	// Anything the table is doing that the user did not just get a result for.
	// Surfaced as an always-visible bar in the tab's FIXED chrome: a page
	// request, a background script sweep and an export retry loop all used to
	// be reported only by muted text (or, for a re-fetch over an existing page,
	// by a line at the very BOTTOM of a scrolled grid) — which is why a long
	// computation read as a frozen table.
	const busy = $derived(loading || scriptStatus?.state === 'computing' || exporting);
	let settingsOpen = $state(false);
	// Which column the settings dialog is scoped to — null shows the whole
	// definition editor (row source + every column); a definition index shows
	// only that column's card (see ColumnManager's focusIndex).
	let settingsFocus = $state<number | null>(null);

	// Set by the Save button just before it closes the dialog, so onOpenChange
	// can tell "Save" apart from every discard path (Cancel, the X, Escape, an
	// overlay click) — those all land in onOpenChange(false) with the flag
	// still false and revert the staged edits first. Plain variable, not
	// $state: control flow only, never rendered.
	//
	// Both footer buttons are `Dialog.Close`, not plain buttons that set
	// `settingsOpen = false` directly: bits-ui's `onOpenChange` fires only from
	// DialogRootState's own handleClose() (wired through Close/Escape/overlay),
	// not from an external assignment to the bound `open` value — the latter
	// closes the dialog (the bound prop still drives presence) but silently
	// skips onOpenChange, so neither the revert nor the resume would run.
	let settingsSaved = false;

	function saveSettings(): void {
		settingsSaved = true;
	}

	// The settings dialog is a working surface, not an alert: open big
	// (most of the viewport) and let the user resize from the corner. The
	// Dialog primitive centers via translate(-50%,-50%), so width/height are
	// controlled here and deltas are doubled to keep the grip under the cursor.
	const DLG_MIN_W = 640;
	const DLG_MIN_H = 400;
	let dlgW = $state(
		Math.min(1280, (typeof window === 'undefined' ? 1280 : window.innerWidth) * 0.92)
	);
	let dlgH = $state((typeof window === 'undefined' ? 720 : window.innerHeight) * 0.85);
	let dlgResize: { x: number; y: number; w: number; h: number } | null = null;
	function onDlgResizeStart(e: PointerEvent): void {
		if (e.button !== 0) return;
		dlgResize = { x: e.clientX, y: e.clientY, w: dlgW, h: dlgH };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function onDlgResizeMove(e: PointerEvent): void {
		if (!dlgResize) return;
		dlgW = Math.min(
			Math.max(DLG_MIN_W, dlgResize.w + 2 * (e.clientX - dlgResize.x)),
			window.innerWidth * 0.98
		);
		dlgH = Math.min(
			Math.max(DLG_MIN_H, dlgResize.h + 2 * (e.clientY - dlgResize.y)),
			window.innerHeight * 0.95
		);
	}
	function onDlgResizeEnd(): void {
		dlgResize = null;
	}

	// Opening the settings dialog STAGES definition edits: the draft still
	// updates on every keystroke (the editors and Save stay immediate), but the
	// table is not re-evaluated until the dialog closes, and then only if the
	// definition actually ended up different. Composing a script or navigation
	// column otherwise fired a full re-evaluation — sweep included — per
	// intermediate state, for a grid the modal was covering anyway.
	function openSettings(focus: number | null): void {
		suspendTableEvaluation(tabId);
		settingsFocus = focus;
		// Reset HERE, not in onOpenChange's `o === true` branch: every open in
		// this component goes through this function via a direct `settingsOpen =
		// true` assignment, never through a `Dialog.Trigger` — and bits-ui's
		// onOpenChange only fires from DialogRootState's own handleOpen/
		// handleClose (see the note by `settingsSaved`'s declaration), so an
		// open driven by this external assignment would never reach it. Without
		// resetting here, a Save leaves `settingsSaved` stuck `true` and the
		// dialog's NEXT close — even a Cancel — would wrongly keep the edits.
		settingsSaved = false;
		settingsOpen = true;
	}

	function editColumn(index: number): void {
		openSettings(index);
	}

	// The header "+" menu appends a fresh column, then focuses the dialog on
	// it — the new column's definition index is always `length - 1` regardless
	// of any hidden columns (addColumn only ever pushes).
	function addColumnFromHeader(kind: 'property' | 'navigation' | 'script'): void {
		const d = getTableDraft(tabId);
		if (!d) return;
		const column =
			kind === 'property'
				? newPropertyColumn()
				: kind === 'script'
					? newScriptColumn()
					: newNavigationColumn();
		// Suspend BEFORE the append: that append is itself a definition edit, and
		// evaluating a blank, unconfigured column is the most pointless reload of
		// the lot. The snapshot taken here is the PRE-append definition, so the
		// dialog's Cancel discards the new column entirely (and Save keeps it).
		suspendTableEvaluation(tabId);
		updateTableDefinition(tabId, addColumn(d.definition, column));
		openSettings(getTableDraft(tabId)!.definition.columns.length - 1);
	}

	async function save(): Promise<void> {
		saveError = null;
		try {
			await saveTableDraft(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}

	async function saveAs(): Promise<void> {
		if (!draft) return;
		const name = window.prompt('Save as', draft.name);
		if (!name) return; // cancelled, or an empty name
		saveError = null;
		try {
			await saveAsTableDraft(tabId, name);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}

	async function exportTable(): Promise<void> {
		if (exporting) return; // one export at a time — the button is disabled too
		saveError = null;
		exporting = true;
		exportAbort = new AbortController();
		try {
			await downloadTable(tabId, {
				onProgress: (p) => (exportProgress = p),
				signal: exportAbort.signal
			});
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exporting = false;
			exportProgress = null;
			exportAbort = null;
		}
	}
</script>

{#if !draft}
	<p class="p-4 text-xs text-muted-foreground/70">Loading…</p>
{:else}
	<div class="flex h-full flex-col">
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<input
				data-testid="table-name"
				class="w-56 rounded border border-input bg-card px-2 py-1 text-xs"
				value={draft.name}
				disabled={!editable}
				oninput={(e) => setTableName(tabId, e.currentTarget.value)}
			/>
			{#if draft.dirty}
				<span title="Unsaved changes" class="text-warning">●</span>
			{/if}
			{#if page}
				<span
					data-testid="table-row-count"
					class="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground"
					title={page.truncated ? 'The row set is incomplete (row limit reached)' : undefined}
				>
					{#if hasSplit && page.base_total != null}
						{page.base_total} element{page.base_total === 1 ? '' : 's'} →
						{page.total}{page.truncated ? '+' : ''} row{page.total === 1 ? '' : 's'}
					{:else}
						{page.total}{page.truncated ? '+' : ''} row{page.total === 1 ? '' : 's'}
					{/if}
				</span>
			{/if}
			<span class="flex-1"></span>
			<div class="flex items-center gap-2">
				{#if editable}
					<button
						type="button"
						data-testid="table-settings-button"
						class="flex items-center gap-1 rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
						onclick={() => openSettings(null)}
					>
						<Settings class="h-3.5 w-3.5" /> Settings
					</button>
				{/if}
				<button
					type="button"
					data-testid="table-export-button"
					class="flex items-center gap-1.5 rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-60"
					disabled={exporting}
					title={exporting
						? 'Waiting for this table\u2019s script values to finish computing'
						: undefined}
					onclick={() => void exportTable()}
				>
					<!-- A disabled button with static text is the whole "the export
					     did nothing" complaint: the spinner is what says the retry
					     loop is alive while the backend answers 202. -->
					{#if exporting}
						<span
							class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary"
						></span>
					{/if}
					{#if exportProgress}
						Preparing… {exportProgress.done}/{exportProgress.total ?? '…'}
					{:else if exporting}
						Exporting…
					{:else}
						Export
					{/if}
				</button>
				{#if editable}
					<button
						type="button"
						class="rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
						disabled={!draft.dirty && draft.artifactId !== null}
						onclick={() => void save()}
					>
						Save{draft.dirty ? ' *' : ''}
					</button>
					<button
						type="button"
						class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
						onclick={() => void saveAs()}
					>
						Save as…
					</button>
				{/if}
			</div>
		</div>
		<!-- Activity bar. Always occupies its 2px of chrome (an appearing/
		     disappearing element here would shift the grid, and the grid's
		     virtualizer measures row tops against a stable origin), and only
		     paints while something is in flight. Determinate whenever the sweep
		     reports a total; an indeterminate sweep otherwise. -->
		<div class="h-0.5 w-full overflow-hidden" data-testid="table-activity" data-busy={busy}>
			{#if busy}
				{#if sweepPercent !== null}
					<div
						class="h-full bg-primary transition-[width] duration-300"
						style:width={`${sweepPercent}%`}
					></div>
				{:else}
					<div class="activity-sweep h-full w-1/4 bg-primary"></div>
				{/if}
			{/if}
		</div>
		{#if conflict !== undefined}
			<div class="flex items-center gap-2 bg-warning/15 px-3 py-1.5 text-xs text-warning">
				Someone else modified this table.
				<button type="button" class="underline" onclick={() => void reloadTableDraft(tabId)}>
					Reload their version
				</button>
			</div>
		{/if}
		{#if warnings.length > 0}
			<div class="bg-warning/15 px-3 py-1.5 text-xs text-warning" data-testid="table-warnings">
				{warnings.join(' · ')}
			</div>
		{/if}
		<!-- Script-sweep readout. It lives HERE, in the tab's fixed chrome beside
		     the conflict/warnings strips, and NOT inside TableGrid: an in-flow
		     element inside the grid's scroll container would (a) scroll out of
		     view on a long table, hiding the only explanation for the blank
		     `pending` cells, and (b) shift every row's true y relative to the
		     virtualizer's window math (`computeWindowVariable` assumes row 0's
		     top sits at scroll y = 0) — a shift that would appear and vanish as
		     the status flipped to `ready`. -->
		{#if scriptStatus?.state === 'computing'}
			<div
				class="flex items-center gap-2 bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground"
				data-testid="table-script-status"
				aria-live="polite"
			>
				<span
					class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary"
				></span>
				Computing script columns {scriptStatus.done}/{scriptStatus.total ?? '…'}
				{#if sweepPercent !== null}<span class="tabular-nums">({sweepPercent}%)</span>{/if}
				<span class="text-muted-foreground/60">— values fill in as they finish</span>
			</div>
		{:else if scriptStatus?.state === 'failed'}
			<p class="px-3 py-1.5 text-xs text-destructive" data-testid="table-script-status">
				{scriptStatus.message ?? 'Computing this table’s script values failed.'}
			</p>
		{/if}
		<!-- Script-error badge + panel. Same fixed-chrome strip family as the
		     conflict/warnings/status lines above (and for the same reason: it
		     must not scroll away, nor offset the virtualizer's row math). The
		     strip is the panel's positioning context — the dropdown is absolute
		     so it overlays the grid instead of pushing it down. -->
		{#if canCheckScriptErrors}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="relative flex items-center px-3 py-1" onkeydown={onScriptErrorsKeydown}>
				<button
					type="button"
					data-testid="script-errors-badge"
					aria-expanded={scriptErrorsOpen}
					aria-controls="script-errors-panel-{tabId}"
					aria-haspopup="dialog"
					title={scriptErrorCount > 0
						? 'Show the rows whose script column failed'
						: uncomputedReason !== null
							? `Script cells on this page were never computed (${uncomputedReason}), so this table could not be checked`
							: 'Check the whole table for failing script cells'}
					class="flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs transition-colors {scriptErrorCount >
					0
						? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
						: uncomputedReason !== null
							? 'border-warning/40 bg-warning/15 text-warning hover:bg-warning/25'
							: 'border-border bg-muted/60 text-muted-foreground hover:bg-muted'}"
					onclick={toggleScriptErrors}
				>
					{#if scriptErrorCount > 0}
						<AlertTriangle class="h-3 w-3 shrink-0" />
						{scriptErrorCount} script error{scriptErrorCount === 1 ? '' : 's'}
					{:else if scriptErrorsPhase === 'loading'}
						<span
							class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary"
						></span>
						Checking for script errors…
					{:else if uncomputedReason !== null}
						<!-- An empty recap over cells that were never computed. Not a
						     failure (nothing is known to have failed) and emphatically
						     not a clean bill of health — so: warning-toned, and honest
						     about the unknown. -->
						<AlertTriangle class="h-3 w-3 shrink-0" />
						Script errors unknown
					{:else if scriptErrors}
						<Check class="h-3 w-3 shrink-0" />
						No script errors
					{:else}
						<Search class="h-3 w-3 shrink-0" />
						Check for script errors
					{/if}
				</button>
				{#if scriptErrorsOpen}
					<ScriptErrorsPanel
						id="script-errors-panel-{tabId}"
						recap={scriptErrors}
						phase={scriptErrorsPhase}
						{uncomputedReason}
						onJump={jumpToErrorCell}
					/>
				{/if}
			</div>
		{/if}
		{#if saveError}
			<p class="px-3 py-1 text-xs text-destructive">{saveError}</p>
		{/if}
		<div class="min-h-0 flex-1">
			<TableGrid
				{tabId}
				onEditColumn={editable ? editColumn : undefined}
				onAddColumn={editable ? addColumnFromHeader : undefined}
			/>
		</div>
	</div>

	{#if editable}
		<Dialog.Root
			bind:open={settingsOpen}
			onOpenChange={(o) => {
				if (o) return; // opening is handled by openSettings, not here — see its comment
				// Every close path (the X, Escape, an overlay click, both footer
				// buttons) lands here. Only Save keeps the staged edits; everything
				// else restores the definition/dirty/sort snapshot taken at open —
				// after which the resume below sees an unchanged definition and
				// skips the reload entirely.
				if (!settingsSaved) revertSuspendedTableEdits(tabId);
				settingsFocus = null;
				resumeTableEvaluation(tabId);
			}}
		>
			<Dialog.Content
				data-testid="table-settings-dialog"
				class="flex max-w-none flex-col overflow-hidden sm:max-w-none"
				style="width:{dlgW}px;height:{dlgH}px"
			>
				<Dialog.Title class="font-display text-lg font-light tracking-wide">
					{settingsFocus === null ? 'Table settings' : 'Column settings'}
				</Dialog.Title>
				<div class="min-h-0 flex-1 overflow-y-auto pr-1">
					<ColumnManager {tabId} focusIndex={settingsFocus} />
				</div>
				<div class="flex shrink-0 items-center justify-end gap-2 border-t border-border pt-2">
					<Dialog.Close
						data-testid="settings-cancel"
						class="rounded border border-input px-3 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
					>
						Cancel
					</Dialog.Close>
					<Dialog.Close
						data-testid="settings-save"
						class="rounded bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80"
						onclick={saveSettings}
					>
						Save
					</Dialog.Close>
				</div>
				<div
					role="separator"
					aria-orientation="horizontal"
					tabindex="-1"
					data-testid="settings-resize-handle"
					class="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize touch-none select-none"
					onpointerdown={onDlgResizeStart}
					onpointermove={onDlgResizeMove}
					onpointerup={onDlgResizeEnd}
					onpointercancel={onDlgResizeEnd}
				></div>
			</Dialog.Content>
		</Dialog.Root>
	{/if}
{/if}
