<script lang="ts">
	// The table tab root: a slim chrome bar (name input, dirty dot, Settings,
	// Export, Save/Save as…, lock-denied banner) above a full-height
	// `TableGrid`.
	// Definition editing (row source + columns) lives in a NON-MODAL floating
	// panel opened by the ⚙ Settings button (or a column's edit button), so the
	// grid gets the whole area and the sidebar/inspector stay usable while a
	// column is being composed.
	import {
		abandonTableEvaluationSuspension,
		canEdit,
		canRequestScriptErrors,
		downloadTable,
		ensureTableDraft,
		getActiveTab,
		getScriptErrors,
		getScriptErrorsPhase,
		getTableDraft,
		getTableLoading,
		getTableLockHolder,
		getTablePage,
		getTableScriptStatus,
		getTableWarnings,
		getUncomputedScriptCellReason,
		hasSuspendedTableEdits,
		reloadTableDraft,
		requestScriptErrors,
		requestScrollToCell,
		resumeTableEvaluation,
		retryTableLock,
		revertSuspendedTableEdits,
		saveAsTableDraft,
		saveTableDraft,
		seedSnippetExpanded,
		setTableName,
		suspendTableEvaluation,
		updateTableDefinition,
		type ExportProgress
	} from '$lib/state';
	import type { ExportFormat } from '$lib/api/types';
	import { AlertTriangle, Check, Search, Settings, X } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { ConfirmDialog } from '$lib/components/ui/confirm-dialog';
	import {
		addColumn,
		newNavigationColumn,
		newPropertyColumn,
		newScriptColumn
	} from '$lib/table/columns';
	import {
		clampSettingsRect,
		defaultSettingsRect,
		loadSettingsRect,
		saveSettingsRect,
		type Rect
	} from '$lib/table/settings-rect';
	import ArtifactExportButton from '$lib/components/ArtifactExportButton.svelte';
	import ColumnManager from './ColumnManager.svelte';
	import ExportDialog from './ExportDialog.svelte';
	import ScriptErrorsPanel from './ScriptErrorsPanel.svelte';
	import ScriptWarningsPanel from './ScriptWarningsPanel.svelte';
	import TableGrid from './TableGrid.svelte';

	let { tabId }: { tabId: string } = $props();
	$effect(() => {
		void ensureTableDraft(tabId);
	});
	const draft = $derived(getTableDraft(tabId));
	/** Non-null while a peer holds this table's `art:` lease: the tab is
	 * UNSAVEABLE until the check-out succeeds — Save and Save as are disabled
	 * behind the banner ("Retry"). See `navigation-editor.svelte.ts`'s
	 * `ensureDraft` docstring. */
	const lockHolder = $derived(getTableLockHolder(tabId));
	const editable = $derived(canEdit());
	/** A refused check-out disables the SAVE affordances (name, Save, Save as)
	 * but keeps them VISIBLE — paired with the banner, that is what explains
	 * why. It ALSO gates the editing surface: the grid (and its
	 * column-manager/edit-column/add-column chrome) below is wrapped in
	 * `inert={locked}` (see the markup), so a denied tab cannot accumulate
	 * edits it will never be able to commit. The banner's "Save as copy" is the
	 * escape hatch — it lives outside that `inert` container, on purpose. */
	const locked = $derived(lockHolder !== null);
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
	let warningsOpen = $state(false);
	// The panel must not outlive what it describes: a reload that clears the
	// warnings closes it, exactly as the errors panel closes when its badge
	// goes away.
	$effect(() => {
		if (warnings.length === 0) warningsOpen = false;
	});
	function onWarningsKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') warningsOpen = false;
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
	// The Export ▾ items open the export settings dialog on the chosen
	// format, which owns the per-column include/rename/order overrides and
	// runs the download itself. `exportFormat` is bound, so switching format
	// inside the dialog is remembered for the next opening.
	let exportOpen = $state(false);
	let exportFormat = $state<ExportFormat>('xlsx');
	$effect(() => () => exportAbort?.abort());
	// Unmounting with the settings dialog still open would leave the tab
	// suspended forever (nothing else clears that key), so the tab would silently
	// stop evaluating. Drop the suspension WITHOUT evaluating — firing a request
	// for a view that is going away is exactly what we don't want.
	$effect(() => () => abandonTableEvaluationSuspension(tabId));
	// Anything the table is doing that the user did not just get a result for.
	// Surfaced as an always-visible bar in the tab's FIXED chrome — muted text
	// or a line at the bottom of a scrolled grid would let a long computation
	// read as a frozen table.
	const busy = $derived(loading || scriptStatus?.state === 'computing' || exporting);
	let settingsOpen = $state(false);
	// Which column the settings dialog is scoped to — null shows the whole
	// definition editor (row source + every column); a definition index shows
	// only that column's card (see ColumnManager's focusIndex).
	let settingsFocus = $state<number | null>(null);

	// Set by the Save button just before it closes the dialog, so whichever
	// close path runs (Save's onOpenChange, or applyClose() called directly by
	// a discard path) can tell "Save" apart from every DISCARD path (Cancel,
	// the X, Escape) and skip reverting the staged edits. Plain variable, not
	// $state: control flow only, never rendered.
	//
	// Save is the only footer button still a `Dialog.Close`: it sets this flag
	// then closes through the primitive, so bits-ui's `onOpenChange` fires (see
	// its own DialogRootState's handleClose()) and applyClose() there sees the
	// flag and keeps the edits. Every discard path (Cancel, the X, Escape) is
	// gated BEFORE an edit is lost and never goes through the primitive: Cancel
	// and the X are plain buttons (never a `Dialog.Close`, which closes on click
	// before a handler could intercept it), and Escape is OUR keydown handler on
	// `Dialog.Content` — the primitive's own escape layer is switched off
	// (`escapeKeydownBehavior="ignore"`) because it listens on `document`, and
	// with focus free to roam the sidebar and inspector an Escape typed there
	// must not touch this panel. All three run `requestClose`, which closes by
	// assigning `settingsOpen = false` directly and calling `applyClose()`
	// itself once it has confirmed there is nothing staged to lose; a dirty
	// dialog gets the confirmation instead, whose "Discard changes" closes the
	// same direct way. An external assignment to the bound `open` value closes
	// the dialog (the bound prop still drives presence), but bits-ui does NOT
	// report that through `onOpenChange`, only its own internal handleClose()
	// does — so `onOpenChange` below is reached by Save alone.
	let settingsSaved = false;

	function saveSettings(): void {
		settingsSaved = true;
	}

	/** Whether the discard confirmation is showing over the settings dialog. */
	let confirmDiscardOpen = $state(false);

	/** Everything a settings-dialog close must do, regardless of which path
	 * got there. Lives in a function rather than inline in `onOpenChange`
	 * because `applyClose` is reached by TWO routes and both need it: (1)
	 * `onOpenChange` below, for Save (which sets `settingsSaved` first); and
	 * (2) directly, from `requestClose` (Cancel/X/Escape, when nothing is
	 * staged) and from the confirmation's "Discard changes"
	 * (`discardAndClose`) — both of which assign `settingsOpen` themselves,
	 * which bits-ui does NOT report through `onOpenChange` — see the note by
	 * `settingsSaved`'s declaration. The `if (!settingsSaved)` guard just
	 * below is live on both routes: `settingsSaved` is true only for Save, so
	 * every other arrival here reverts.
	 *
	 * Safe to run twice: `revertSuspendedTableEdits` returns early once the
	 * suspend-time snapshot is gone, and `resumeTableEvaluation` returns early
	 * once the suspension is dropped. */
	function applyClose(): void {
		if (!settingsSaved) revertSuspendedTableEdits(tabId);
		settingsFocus = null;
		resumeTableEvaluation(tabId);
	}

	/** The gate. Every DISCARD path (Cancel, the X, Escape) funnels through
	 * here; Save does not, because it keeps the edits. */
	function requestClose(): void {
		if (hasSuspendedTableEdits(tabId)) {
			confirmDiscardOpen = true;
			return;
		}
		applyClose();
		settingsOpen = false;
	}

	function discardAndClose(): void {
		confirmDiscardOpen = false;
		applyClose();
		settingsOpen = false;
	}

	// The settings dialog is a working surface, not an alert: a floating,
	// non-modal panel that opens big and that the user drags by its title bar
	// and resizes from the corner. Its rect is explicit (`left/top/width/
	// height`, overriding the primitive's centering transform) so a drag is a
	// plain offset, and it is remembered across opens and tables
	// (`settings-rect.ts`). It is resolved on every open, not at mount: a
	// stored rect is re-clamped against the CURRENT viewport, and the first-
	// open default is centered over this tab's own area (`tabEl`) so the
	// sidebar and inspector beside it start out uncovered.
	let tabEl = $state<HTMLElement | null>(null);
	let dlg = $state<Rect>({ x: 0, y: 0, w: 0, h: 0 });
	function viewport(): { w: number; h: number } {
		return { w: window.innerWidth, h: window.innerHeight };
	}
	function resolveSettingsRect(): Rect {
		const stored = loadSettingsRect();
		if (stored) return clampSettingsRect(stored, viewport());
		const a = tabEl?.getBoundingClientRect();
		const anchor = a
			? { x: a.left, y: a.top, w: a.width, h: a.height }
			: { x: 0, y: 0, ...viewport() };
		return defaultSettingsRect(anchor, viewport());
	}
	/** Re-clamp when the window shrinks under an open panel, so it can never
	 * end up with its title bar (the only way to drag it back) off screen. */
	function onWindowResize(): void {
		if (settingsOpen) dlg = clampSettingsRect(dlg, viewport());
	}
	// Drag (title bar) and resize (bottom-right corner) share one shape: the
	// pointer-down origin plus the rect at that moment; every move is an
	// absolute delta from it, clamped, and the end persists the result.
	let dlgGesture: { x: number; y: number; rect: Rect } | null = null;
	function dlgGestureStart(e: PointerEvent): void {
		if (e.button !== 0) return;
		dlgGesture = { x: e.clientX, y: e.clientY, rect: dlg };
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		e.preventDefault();
	}
	function onDlgDragMove(e: PointerEvent): void {
		if (!dlgGesture) return;
		const { x, y, rect } = dlgGesture;
		dlg = clampSettingsRect(
			{ ...rect, x: rect.x + (e.clientX - x), y: rect.y + (e.clientY - y) },
			viewport()
		);
	}
	function onDlgResizeMove(e: PointerEvent): void {
		if (!dlgGesture) return;
		const { x, y, rect } = dlgGesture;
		dlg = clampSettingsRect(
			{ ...rect, w: rect.w + (e.clientX - x), h: rect.h + (e.clientY - y) },
			viewport()
		);
	}
	function dlgGestureEnd(): void {
		if (!dlgGesture) return;
		dlgGesture = null;
		saveSettingsRect(dlg);
	}
	/** The panel is portaled to `<body>`, so while another workspace tab is
	 * active it would float over that tab: hide it (state intact — nothing
	 * closes) until this tab is back. */
	const settingsHidden = $derived(getActiveTab() !== tabId);

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
		confirmDiscardOpen = false;
		dlg = resolveSettingsRect();
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
		// A brand-new script column opens with its code editor already showing —
		// the user clicked "+ Script" precisely to write code. Keyed on the
		// pre-append length, which is the appended column's index.
		if (kind === 'script') seedSnippetExpanded(`${tabId}::col:${d.definition.columns.length}`);
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

	/** Banner-only escape hatch for a denied tab: the same fork the (disabled,
	 * while locked) toolbar "Save as…" button uses, reached directly so it
	 * works regardless of that button's own `disabled={locked}` gate — a fork
	 * stages a brand-new CREATE, which needs no lease. Separate prompt copy
	 * from `saveAs` (a "(copy)" default name) so the two affordances read as
	 * distinct even though they call the same store function. */
	async function saveAsCopy(): Promise<void> {
		if (!draft) return;
		const name = window.prompt('Save copy as', `${draft.name} (copy)`);
		if (!name) return;
		saveError = null;
		try {
			await saveAsTableDraft(tabId, name);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}

	async function exportTable(format: ExportFormat): Promise<void> {
		if (exporting) return; // one export at a time — the trigger is disabled too
		saveError = null;
		exporting = true;
		exportAbort = new AbortController();
		try {
			await downloadTable(tabId, {
				format,
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

<svelte:window onresize={onWindowResize} />

{#if !draft}
	<p class="p-4 text-xs text-muted-foreground/70">Loading…</p>
{:else}
	<!-- `inert` while the settings panel is open: the panel is non-modal so
	     the sidebar and inspector stay live, but THIS tab's toolbar and grid do
	     not — evaluation is suspended while the panel is open, and a grid that
	     will not fill its chunks would only mislead. The panel itself is
	     portaled to <body>, outside this subtree. -->
	<div
		class="flex h-full flex-col"
		data-testid="table-tab-body"
		inert={settingsOpen}
		bind:this={tabEl}
	>
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<input
				data-testid="table-name"
				class="w-56 rounded border border-input bg-card px-2 py-1 text-xs"
				value={draft.name}
				disabled={!editable || locked}
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
				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						data-testid="table-export-button"
						class="flex items-center gap-1.5 rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-60"
						disabled={exporting}
						title={exporting
							? 'Waiting for this table\u2019s script values to finish computing'
							: undefined}
					>
						<!-- A disabled trigger with static text is the whole "the export
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
							Export ▾
						{/if}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-44">
						<!-- Both items now OPEN the export dialog on the chosen format
						     instead of downloading straight away: the file's contents are
						     the dialog's business (include/rename/order), and the format
						     is still switchable in place once it is open. -->
						<DropdownMenu.Item
							data-testid="table-export-xlsx"
							onSelect={() => {
								exportFormat = 'xlsx';
								exportOpen = true;
							}}
						>
							Excel (.xlsx)
						</DropdownMenu.Item>
						<DropdownMenu.Item
							data-testid="table-export-json"
							onSelect={() => {
								exportFormat = 'json';
								exportOpen = true;
							}}
						>
							JSON (.json)
						</DropdownMenu.Item>
						<DropdownMenu.Item
							data-testid="table-export-csv"
							onSelect={() => {
								exportFormat = 'csv';
								exportOpen = true;
							}}
						>
							CSV (.csv)
						</DropdownMenu.Item>
						<DropdownMenu.Item
							data-testid="table-export-jsonl"
							onSelect={() => {
								exportFormat = 'jsonl';
								exportOpen = true;
							}}
						>
							JSON Lines (.jsonl)
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
				<ArtifactExportButton {tabId} />
				{#if editable}
					<button
						type="button"
						class="rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
						disabled={locked || (!draft.dirty && draft.artifactId !== null)}
						onclick={() => void save()}
					>
						Save{draft.dirty ? ' *' : ''}
					</button>
					<button
						type="button"
						class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
						disabled={locked}
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
		{#if lockHolder !== null}
			<div
				class="flex items-center gap-2 bg-warning/15 px-3 py-1.5 text-xs text-warning"
				role="status"
			>
				Checked out by {lockHolder} — you will not be able to save.
				<button type="button" class="underline" onclick={() => void retryTableLock(tabId)}>
					Retry
				</button>
				<button type="button" class="underline" onclick={() => void reloadTableDraft(tabId)}>
					Reload
				</button>
				<button
					type="button"
					data-testid="table-save-as-copy"
					class="underline"
					onclick={() => void saveAsCopy()}
				>
					Save as copy
				</button>
			</div>
		{/if}
		{#if warnings.length > 0}
			<!-- A SUMMARY plus a disclosure, not the prose itself: several kinds
			     can fire at once, and the old `join(' · ')` put every one of them
			     on a single line with no indication of how many rows each
			     affected. Stays in the tab's FIXED chrome for the same reason as
			     the status line below. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="relative flex items-center px-3 py-1" onkeydown={onWarningsKeydown}>
				<button
					type="button"
					data-testid="table-warnings-badge"
					aria-expanded={warningsOpen}
					aria-controls="script-warnings-panel-{tabId}"
					aria-haspopup="dialog"
					title="Show what the script evaluation degraded on"
					class="flex items-center gap-1.5 rounded border border-warning/40 bg-warning/15 px-2 py-0.5 text-xs text-warning transition-colors hover:bg-warning/25"
					onclick={() => (warningsOpen = !warningsOpen)}
				>
					<AlertTriangle class="h-3 w-3 shrink-0" />
					{warnings.length} script warning{warnings.length === 1 ? '' : 's'}
				</button>
				{#if warningsOpen}
					<ScriptWarningsPanel id="script-warnings-panel-{tabId}" {warnings} />
				{/if}
			</div>
		{/if}
		<!-- Script-sweep readout. It lives HERE, in the tab's fixed chrome beside
		     the conflict/warnings strips, and NOT inside TableGrid: an in-flow
		     element inside the grid's scroll container would (a) scroll out of
		     view on a long table, hiding the only explanation for the blank
		     `pending` cells, and (b) shift every row's true y relative to the
		     virtualizer's window math (`computeWindowVariable` assumes row 0's
		     top sits at scroll y = 0).
		     The strip mounts only while `computing` (and briefly for `failed`)
		     — idle/ready render nothing here, so a table with no script
		     columns, which never sweeps, never pays a permanent chrome tax.
		     Known, accepted tradeoff: `role="status"` on an element that did
		     not exist a moment ago is generally NOT announced by a screen
		     reader — an `aria-live` region normally has to already be present
		     in the DOM before content changing *inside* it gets announced, and
		     appearing already-populated doesn't count. We're keeping the
		     text-free spinner (see below) rather than reserving a blank band
		     on every table just to guarantee that announcement. -->
		{#if scriptStatus?.state === 'computing'}
			<!-- Spinner only. The sweep's done/total counters and the "values fill
			     in as they finish" clause were removed deliberately: they narrated
			     an internal mechanism. -->
			<div
				class="flex items-center gap-2 bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground"
				data-testid="table-script-status"
				role="status"
			>
				<span
					class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary"
				></span>
				<span class="sr-only">Computing script columns</span>
			</div>
		{:else if scriptStatus?.state === 'failed'}
			<p
				class="px-3 py-1.5 text-xs text-destructive"
				data-testid="table-script-status"
				role="status"
			>
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
		<div class="min-h-0 flex-1" data-testid="table-grid-host" inert={locked}>
			<TableGrid
				{tabId}
				onEditColumn={editable ? editColumn : undefined}
				onAddColumn={editable ? addColumnFromHeader : undefined}
			/>
		</div>
	</div>

	<!-- Outside the `editable` gate, like the Export ▾ trigger that opens it: a
	     viewer can export too, and the overrides it edits are export-only. -->
	<ExportDialog
		{tabId}
		bind:open={exportOpen}
		bind:format={exportFormat}
		onClose={() => (exportOpen = false)}
		onExport={exportTable}
	/>

	{#if editable}
		<Dialog.Root
			bind:open={settingsOpen}
			onOpenChange={(o) => {
				if (o) return; // opening is handled by openSettings, not here — see its comment
				// Only Save reaches here (it sets `settingsSaved` first, so the
				// guard inside keeps the edits). Cancel/the X/Escape and the
				// confirmation's "Discard changes" do NOT — they close by
				// assigning `settingsOpen` directly (see the note by
				// `settingsSaved`'s declaration), which bits-ui does not report
				// through `onOpenChange`.
				applyClose();
			}}
		>
			<!-- Non-modal: no overlay, no focus trap, no scroll lock, outside
			     clicks ignored (they are clicks on the sidebar/inspector now),
			     and Escape handled by our own keydown below rather than the
			     primitive's document-level layer. The explicit left/top override
			     the wrapper's centering classes (tailwind-merge keeps the last
			     conflicting utility). `transition-none`: the wrapper's
			     `duration-200` sets `transition-duration` alone, and the CSS
			     initial `transition-property` is `all`, so without it every
			     drag/resize write is tweened and the panel trails the pointer
			     (the open/close `animate-in` keyframes are an animation, not a
			     transition, and keep their duration). `display:none` while
			     another tab is active — see `settingsHidden`. -->
			<Dialog.Content
				data-testid="table-settings-dialog"
				class="top-0 left-0 flex max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden transition-none sm:max-w-none"
				style="left:{dlg.x}px;top:{dlg.y}px;width:{dlg.w}px;height:{dlg.h}px;{settingsHidden
					? 'display:none;'
					: ''}"
				showCloseButton={false}
				showOverlay={false}
				trapFocus={false}
				preventScroll={false}
				interactOutsideBehavior="ignore"
				escapeKeydownBehavior="ignore"
				onkeydown={(e) => {
					// Only an Escape that bubbled up from INSIDE the panel, and one no
					// child already consumed (a code editor, a picker popover). Gated
					// like every other discard path: a stray Escape must not bin a
					// fully composed script column silently.
					if (e.key !== 'Escape' || e.defaultPrevented) return;
					e.preventDefault();
					requestClose();
				}}
			>
				<!-- The title bar is the drag grip. `role="presentation"`: the
				     drag is pointer-only sugar (the panel is fully usable where it
				     opens), so it is not exposed as a control. -->
				<div
					role="presentation"
					data-testid="settings-drag-handle"
					class="-mx-6 -mt-6 cursor-move touch-none select-none px-6 pt-6 pb-1"
					onpointerdown={dlgGestureStart}
					onpointermove={onDlgDragMove}
					onpointerup={dlgGestureEnd}
					onpointercancel={dlgGestureEnd}
				>
					<Dialog.Title class="font-display text-lg font-light tracking-wide">
						{settingsFocus === null ? 'Table settings' : 'Column settings'}
					</Dialog.Title>
				</div>
				<!-- One body, no tab strip: the JSON export options moved out to the
				     export dialog, where they sit beside the inclusion/order settings
				     they share a file with. -->
				<div
					class="min-h-0 flex-1 overflow-y-auto pr-1"
					data-testid="column-manager-host"
					inert={locked}
				>
					<ColumnManager {tabId} focusIndex={settingsFocus} />
				</div>
				<div class="flex shrink-0 items-center justify-end gap-2 border-t border-border pt-2">
					<button
						type="button"
						data-testid="settings-cancel"
						class="rounded border border-input px-3 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
						onclick={requestClose}
					>
						Cancel
					</button>
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
					onpointerdown={dlgGestureStart}
					onpointermove={onDlgResizeMove}
					onpointerup={dlgGestureEnd}
					onpointercancel={dlgGestureEnd}
				></div>
				<!-- Our own X: the primitive's built-in one is a `Dialog.Close`,
				     whose click cannot be preventDefault-ed, so it could not be
				     gated. `showCloseButton={false}` above turns that one off.
				     `absolute top-4 right-4` positions it regardless of DOM order,
				     so it lives here (late in `Dialog.Content`, beside the resize
				     handle) rather than as the first child: bits-ui's focus scope
				     focuses the first focusable descendant on open, and with the X
				     first that was THIS button — a keyboard user pressing Space/
				     Enter right after opening would close the dialog they just
				     opened instead of landing on the "Columns" tab. -->
				<button
					type="button"
					data-testid="settings-close"
					class="absolute top-4 right-4 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onclick={requestClose}
				>
					<X class="size-4" />
					<span class="sr-only">Close</span>
				</button>
				<ConfirmDialog
					bind:open={confirmDiscardOpen}
					title="Discard changes?"
					description="Your unsaved changes in this dialog — columns, row source, and sort — will be lost. This cannot be undone."
					confirmLabel="Discard changes"
					cancelLabel="Keep editing"
					variant="destructive"
					onConfirm={discardAndClose}
				/>
			</Dialog.Content>
		</Dialog.Root>
	{/if}
{/if}
