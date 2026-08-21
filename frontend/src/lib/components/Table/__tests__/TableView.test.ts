// Behaviour test for the settings-popup refactor (Task 1): the definition
// editor (ColumnManager) no longer sits inline in the tab — it lives behind a
// ⚙ Settings button that opens a Dialog, and the button is editor-only. This
// covers the button's edit-gating and that the manager is not mounted until the
// popup opens; the full open→edit→grid-updates flow is covered by e2e
// (e2e/table.spec.ts). Uses the repo's mount/flushSync/unmount Svelte-5 render
// convention (see TableGrid.test.ts) rather than @testing-library/svelte.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScriptWarning } from '$lib/api/types';
// The export dialog's JSON preview talks to `POST /tables/json-preview`
// directly via `$lib/api/tables`, not through the `$lib/state` barrel mocked
// below — stub it so opening that dialog on the JSON format never fires a real
// network call.
// Spread the real module rather than replacing it wholesale: this file is
// safe today only because `$lib/state` is ALSO fully mocked below, so
// `state/table-editor.svelte.ts` (which imports `evaluateTable`/
// `exportTable`/`fetchScriptErrors` from this same module) never loads. If
// the `$lib/state` mock is ever switched to `importActual`, a wholesale
// replacement here would die at module-eval with "No 'evaluateTable' export
// is defined on the mock" — spreading the actual exports keeps this mock
// correct independent of that.
vi.mock('$lib/api/tables', async () => ({
	...(await vi.importActual('$lib/api/tables')),
	previewTableJson: vi.fn().mockResolvedValue({ sample: '[]', truncated: false })
}));
// The whole `$lib/state` barrel is mocked below (`downloadTable: vi.fn(...)`)
// — importing the name here resolves to that SAME mock instance, so calls
// made through TableView's onclick handlers show up on it.
import { downloadTable, saveAsTableDraft } from '$lib/state';
import TableView from '../TableView.svelte';

// Hoisted so the vi.mock factory (hoisted above imports) can reference it, and
// so each test can flip `editable` before mounting.
const h = vi.hoisted(() => ({
	editable: true,
	page: undefined as unknown,
	// Task 7: warnings are now structured (`ScriptWarning[]`, formatted via
	// `formatScriptWarning`), not the old joined-string strip.
	warnings: [] as ScriptWarning[],
	scriptStatus: null as unknown,
	scriptErrors: null as unknown,
	scriptErrorsPhase: 'idle' as 'idle' | 'loading' | 'error' | 'done',
	/** Mirrors the store's `_recapKeys.has(tab)`: is there a settled page state
	 * a recap could describe RIGHT NOW (false while a load is in flight). */
	canCheckScriptErrors: true,
	/** Task 10: non-null puts the tab in the lock-denied state. */
	lockHolder: null as string | null,
	/** Mirrors the store's evidence from the page on screen: why a script cell
	 * holds no value, or null when they all do. */
	uncomputedScriptCellReason: null as string | null,
	requestScriptErrors: vi.fn(),
	jump: vi.fn(),
	revertSuspendedTableEdits: vi.fn(),
	resumeTableEvaluation: vi.fn(),
	/** Mirrors `hasSuspendedTableEdits`: did the definition change since the
	 * settings dialog opened? Drives the discard-confirmation gate. */
	dirtySinceOpen: false,
	draft: {
		tabId: 'tbl:draft:1',
		name: 'My Table',
		dirty: false,
		artifactId: 'a1',
		definition: { row_source: { kind: 'scope', types: [], criteria: [] }, columns: [] }
	} as unknown
}));

// TableView (and, once opened via the Settings button or a header edit
// button, ColumnManager) import from the $lib/state barrel. Most tests below
// never open the dialog, but several now do — vi.mock replaces the WHOLE
// barrel, so every export ColumnManager (and its RowSourceEditor descendant)
// imports must be present too, or opening the dialog throws "No export is
// defined on the mock". TableGrid *is* always mounted (full-height grid below
// the chrome bar), so its $lib/state dependencies are stubbed unconditionally.
vi.mock('$lib/state', () => ({
	canEdit: () => h.editable,
	getMetamodel: () => null,
	ensureTableDraft: vi.fn(async () => {}),
	// ArtifactExportButton's dependencies — the toolbar mounts it unconditionally
	// now that the tab-strip export button is gone (Task 5). Mirrors h.draft's
	// static id/artifactId/name (typed `unknown` above, so restated as literals
	// rather than read off it).
	getDynamicTabs: () => [
		{ id: 'tbl:draft:1', kind: 'table' as const, artifactId: 'a1', title: 'My Table' }
	],
	openExportArtifacts: vi.fn(),
	getTableDraft: () => h.draft,
	getTableLockHolder: () => h.lockHolder,
	retryTableLock: vi.fn(),
	getTableWarnings: () => h.warnings,
	downloadTable: vi.fn(async () => {}),
	saveTableDraft: vi.fn(async () => {}),
	saveAsTableDraft: vi.fn(async () => {}),
	reloadTableDraft: vi.fn(),
	setTableName: vi.fn(),
	// Staged definition edits: the settings dialog suspends evaluation while
	// open and resumes (evaluating at most once) on close.
	suspendTableEvaluation: vi.fn(),
	resumeTableEvaluation: h.resumeTableEvaluation,
	revertSuspendedTableEdits: h.revertSuspendedTableEdits,
	hasSuspendedTableEdits: () => h.dirtySinceOpen,
	abandonTableEvaluationSuspension: vi.fn(),
	// TableGrid's dependencies (always mounted below the chrome bar).
	getTablePage: () => h.page,
	getTableLoading: () => false,
	getTableSort: () => undefined,
	getTableScriptStatus: () => h.scriptStatus,
	getScriptErrors: () => h.scriptErrors,
	getScriptErrorsPhase: () => h.scriptErrorsPhase,
	canRequestScriptErrors: () => h.canCheckScriptErrors,
	getUncomputedScriptCellReason: () => h.uncomputedScriptCellReason,
	requestScriptErrors: h.requestScriptErrors,
	requestScrollToCell: h.jump,
	consumeScrollRequest: () => null,
	getTableError: () => undefined,
	setTableSort: vi.fn(),
	updateTableDefinition: vi.fn(),
	ensureTableRange: vi.fn(),
	lockBadgeFor: () => ({ state: 'none' }),
	// ColumnManager's own reorder/clone dependencies — needed once a test opens
	// the dialog and ColumnManager mounts for real.
	remapTableSortForInsert: vi.fn(),
	remapTableSortForMove: vi.fn(),
	remapTableSortForRemove: vi.fn(),
	// RowSourceEditor's dependencies (mounted once the settings dialog opens
	// unfocused — the "shows every column" path renders it for real).
	closeDraft: vi.fn(),
	ensureEmbeddedDraft: vi.fn(),
	getArtifactHeaders: () => [],
	getDraft: () => undefined,
	// ExportDialog's transform picker (exporter-v2 phase 4 task 10) — mounted
	// unconditionally for a JSON-family export format, so its dependency must
	// be present even though these tests never pick a transform.
	referenceableArtifactHeaders: () => []
}));

function render(tabId: string) {
	const c = mount(TableView, { target: document.body, props: { tabId } });
	flushSync();
	return c;
}

/** Wait up to ms for predicate to be truthy, polling every 10 ms — bits-ui's
 * Dialog defers unmounting Content until its close "animation" resolves via
 * requestAnimationFrame, which flushSync() alone does not drive. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
		flushSync();
	}
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
	h.editable = true;
	h.warnings = [];
	h.scriptStatus = null;
	h.scriptErrors = null;
	h.scriptErrorsPhase = 'idle';
	h.canCheckScriptErrors = true;
	h.uncomputedScriptCellReason = null;
	h.lockHolder = null;
	h.requestScriptErrors.mockReset();
	h.jump.mockReset();
	h.revertSuspendedTableEdits.mockClear();
	h.resumeTableEvaluation.mockClear();
	h.dirtySinceOpen = false;
});

describe('TableView settings popup', () => {
	it('shows a Settings button and does not mount the column manager inline', () => {
		h.editable = true;
		const c = render('tbl:draft:1');
		try {
			expect(document.querySelector('[data-testid="table-settings-button"]')).not.toBeNull();
			// The definition editor is behind the popup — absent until opened.
			expect(document.querySelector('[data-testid="column-manager"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('hides the Settings button for read-only users', () => {
		h.editable = false;
		const c = render('tbl:draft:1');
		try {
			expect(document.querySelector('[data-testid="table-settings-button"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('Cancel reverts staged edits, then resumes evaluation', async () => {
		const c = render('tbl:draft:1');
		try {
			(document.querySelector('[data-testid="table-settings-button"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="settings-cancel"]'));
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(h.revertSuspendedTableEdits).toHaveBeenCalledWith('tbl:draft:1');
			// The entire contract of the staged-edit suspend/resume machinery:
			// exactly one resume per close, not zero (stuck suspended) and not
			// more than one (a double reload).
			expect(h.resumeTableEvaluation).toHaveBeenCalledTimes(1);
		} finally {
			unmount(c);
		}
	});

	it('Save keeps staged edits (no revert), then resumes evaluation', async () => {
		const c = render('tbl:draft:1');
		try {
			(document.querySelector('[data-testid="table-settings-button"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="settings-save"]'));
			(document.querySelector('[data-testid="settings-save"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
			expect(h.resumeTableEvaluation).toHaveBeenCalledTimes(1);
		} finally {
			unmount(c);
		}
	});

	// Regression: opening the dialog is a direct `settingsOpen = true`
	// assignment (never a `Dialog.Trigger`), so bits-ui's onOpenChange(true)
	// never fires for it — the flag Save sets must therefore be reset by
	// openSettings itself, not by that branch, or it would stick from one
	// open to the next and make a later Cancel wrongly keep the edits.
	it('Cancel still reverts after a prior Save earlier in the same mount', async () => {
		const c = render('tbl:draft:1');
		try {
			(document.querySelector('[data-testid="table-settings-button"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="settings-save"]'));
			(document.querySelector('[data-testid="settings-save"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			h.revertSuspendedTableEdits.mockClear();
			(document.querySelector('[data-testid="table-settings-button"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="settings-cancel"]'));
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(h.revertSuspendedTableEdits).toHaveBeenCalledWith('tbl:draft:1');
		} finally {
			unmount(c);
		}
	});

	it('closing via Escape behaves like Cancel', async () => {
		const c = render('tbl:draft:1');
		try {
			(document.querySelector('[data-testid="table-settings-button"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="table-settings-dialog"]'));
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(h.revertSuspendedTableEdits).toHaveBeenCalledWith('tbl:draft:1');
		} finally {
			unmount(c);
		}
	});
});

// The discard gate: staged definition edits are lost on Cancel/X/Escape/
// overlay, and a composed script column is expensive to lose. Nag only when
// there is something to lose — `hasSuspendedTableEdits` is the whole test.
describe('TableView settings discard confirmation', () => {
	async function openSettings(): Promise<void> {
		(document.querySelector('[data-testid="table-settings-button"]') as HTMLElement).click();
		flushSync();
		await waitFor(() => !!document.querySelector('[data-testid="table-settings-dialog"]'));
	}

	it('Cancel on a clean dialog closes with no confirmation', async () => {
		h.dirtySinceOpen = false;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
			expect(h.revertSuspendedTableEdits).toHaveBeenCalledWith('tbl:draft:1');
			expect(h.resumeTableEvaluation).toHaveBeenCalledTimes(1);
		} finally {
			unmount(c);
		}
	});

	it('Cancel on a dirty dialog asks first and keeps the dialog open', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			expect(document.querySelector('[data-testid="table-settings-dialog"]')).not.toBeNull();
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
			expect(h.resumeTableEvaluation).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('"Keep editing" dismisses only the confirmation', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			(document.querySelector('[data-testid="confirm-dialog-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="confirm-dialog"]'));
			expect(document.querySelector('[data-testid="table-settings-dialog"]')).not.toBeNull();
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('"Discard changes" reverts and closes, resuming exactly once', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			(document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(h.revertSuspendedTableEdits).toHaveBeenCalledWith('tbl:draft:1');
			// The suspend/resume contract: exactly one resume per close, not
			// zero (stuck suspended) and not two (a double reload).
			expect(h.resumeTableEvaluation).toHaveBeenCalledTimes(1);
		} finally {
			unmount(c);
		}
	});

	it('Escape on a dirty dialog is gated too', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			// `cancelable: true` matters here (unlike the ungated Escape test
			// above): bits-ui's escape-layer clones the native event via
			// `new KeyboardEvent(e.type, e)` before handing it to Content's
			// `onEscapeKeydown`, inheriting `cancelable` from the original — a
			// non-cancelable event makes our `preventDefault()` a silent no-op, so
			// bits-ui's own close would fire right alongside the confirmation,
			// same as it would for a keypress-derived event that had been
			// (incorrectly) built non-cancelable. A real Escape keypress is always
			// cancelable, so this matches production.
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			);
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			expect(document.querySelector('[data-testid="table-settings-dialog"]')).not.toBeNull();
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('the X is gated too', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-close"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			expect(document.querySelector('[data-testid="table-settings-dialog"]')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('Save is never gated, even when dirty', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-save"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="table-settings-dialog"]'));
			expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
			expect(h.resumeTableEvaluation).toHaveBeenCalledTimes(1);
		} finally {
			unmount(c);
		}
	});

	// The nested-dialog layer stack (confirmation-over-settings) is the one
	// part of this design that rests on bits-ui internals rather than our own
	// code: `EscapeLayerState`'s `isResponsibleEscapeLayer` (bits-ui's
	// escape-layer utility) walks its module-global layer registry and hands
	// Escape only to the LAST-registered "close"/"ignore" layer — every other
	// registered layer's keydown handler returns immediately, without even
	// calling `preventDefault()`. The confirmation opens after (and therefore
	// registers after) the settings dialog, so it alone is "responsible" and
	// the settings dialog's own escape handling never runs at all. Pinned
	// here rather than assumed, per the design spec.
	it('Escape inside the confirmation dismisses only the confirmation, leaving the settings dialog open with its staged edits intact', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			(document.querySelector('[data-testid="settings-cancel"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			);
			flushSync();
			await waitFor(() => !document.querySelector('[data-testid="confirm-dialog"]'));
			// The settings dialog is still here, and nothing was discarded.
			expect(document.querySelector('[data-testid="table-settings-dialog"]')).not.toBeNull();
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
			expect(h.resumeTableEvaluation).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	// A dirty overlay click must be gated exactly like Escape/Cancel/the X —
	// `onInteractOutside` on `Dialog.Content` preventDefault's it and opens the
	// confirmation instead of letting bits-ui close the settings dialog
	// straight through. Deleting that handler would leave the rest of this
	// suite green, since every other test closes via an explicit button or a
	// keyboard Escape.
	//
	// bits-ui's dismissable-layer drives `onInteractOutside` off a capture +
	// bubble `pointerdown` PAIR on `document` (see
	// node_modules/bits-ui/dist/bits/utilities/dismissible-layer/
	// use-dismissable-layer.svelte.js), not a `click` — dispatching one
	// `pointerdown` that bubbles through `document` fires both listeners in
	// one go, exactly like a real click's mousedown does. The event must also
	// pass `isClickTrulyOutside` (a `getBoundingClientRect` comparison
	// against the dialog content node): happy-dom's `getBoundingClientRect`
	// unconditionally returns a zero rect (`new DOMRect()` — see
	// node_modules/happy-dom/lib/nodes/element/Element.js), so any nonzero
	// `clientX`/`clientY` reads as "outside" regardless of the coordinates'
	// real relationship to the dialog; that's what `9999` buys here.
	it('a dirty overlay click is gated too, and does not close the settings dialog', async () => {
		h.dirtySinceOpen = true;
		const c = render('tbl:draft:1');
		try {
			await openSettings();
			const overlay = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement;
			expect(overlay).not.toBeNull();
			// bits-ui's dismissable-layer registers its document-level listeners
			// on a real (non-Svelte-scheduled) 1ms `setTimeout` after the layer
			// becomes enabled (`afterSleep(1, ...)` in
			// use-dismissable-layer.svelte.js) — unlike the escape-layer, which
			// attaches synchronously. `openSettings()`'s `waitFor` can return as
			// soon as the dialog testid appears, without ever yielding a real
			// timer tick, so the dismissable layer may not be registered yet;
			// give that 1ms timer room to fire before dispatching.
			await new Promise((r) => setTimeout(r, 20));
			overlay.dispatchEvent(
				new PointerEvent('pointerdown', {
					bubbles: true,
					cancelable: true,
					pointerId: 1,
					clientX: 9999,
					clientY: 9999
				})
			);
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			expect(document.querySelector('[data-testid="table-settings-dialog"]')).not.toBeNull();
			expect(h.revertSuspendedTableEdits).not.toHaveBeenCalled();
			expect(h.resumeTableEvaluation).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});
});

// Task 10 / cross-impl adoption: the sweep readout is FIXED chrome next to the
// conflict and warnings strips, NOT an in-flow element inside TableGrid's
// scroll container (where it would scroll away on a long table and offset the
// virtualizer's row math while `computing`). These two cases moved here from
// TableGrid.test.ts with the strip itself.
describe('TableView script-status strip', () => {
	it('shows a bare spinner while computing, with no progress text', () => {
		h.scriptStatus = { state: 'computing', done: 7, total: 42 };
		const c = render('tbl:draft:computing');
		try {
			const strip = document.querySelector('[data-testid="table-script-status"]');
			expect(strip).not.toBeNull();
			// The sweep's internal counters explained a mechanism nobody asked
			// about; only the spinner (and an sr-only label) survive.
			expect(strip?.textContent).not.toContain('Computing script columns 7/42');
			expect(strip?.textContent).not.toContain('values fill in');
			expect(strip?.querySelector('.animate-spin')).not.toBeNull();
			expect(strip?.getAttribute('role')).toBe('status');
			// It is chrome, not grid content: outside the scrolling body.
			expect(strip?.closest('[data-testid="table-header"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('surfaces a failed sweep message instead of the progress readout', () => {
		h.scriptStatus = { state: 'failed', done: 3, total: 42, message: 'sweep died' };
		const c = render('tbl:draft:failed');
		try {
			const strip = document.querySelector('[data-testid="table-script-status"]');
			expect(strip?.textContent).toContain('sweep died');
			expect(strip?.className).toContain('text-destructive');
		} finally {
			unmount(c);
		}
	});
});

// Task 6 + final review: the script-error recap, fetched ON DEMAND. A failing
// script cell can be anywhere in a virtualized table, so the badge → panel (the
// whole list) → jump (scroll the grid to it) chain is the only way to reach
// one. The recap comes from the store (whole-table `POST /tables/script-errors`,
// stubbed here), and that route re-renders the whole table cache-only — so it
// is NOT fetched when the table settles: the badge is a neutral "check for
// script errors" affordance and the click is what pays for the pass. The
// fetch/retry discipline is pinned in
// state/__tests__/table-editor-script-errors.test.ts.
describe('TableView script-error badge + panel', () => {
	const READY = { state: 'ready', done: 10, total: 10 };
	const RECAP = {
		state: 'ready',
		errors: [
			{
				row_index: 3,
				row_element_id: 't4',
				row_label: 'Pump A',
				column_index: 1,
				column_label: 'script',
				message: 'ZeroDivisionError: division by zero'
			}
		],
		total_errors: 1,
		truncated: false
	};

	it('shows no badge for a table with no script work', () => {
		h.scriptStatus = null;
		h.canCheckScriptErrors = false;
		const c = render('tbl:draft:1');
		try {
			expect(document.querySelector('[data-testid="script-errors-badge"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('shows no badge while the sweep is still computing', () => {
		// Row order is degraded (build order) until it settles, so a recap's row
		// indices would not address what the grid is showing.
		h.scriptStatus = { state: 'computing', done: 2, total: 42 };
		h.canCheckScriptErrors = false;
		const c = render('tbl:draft:1');
		try {
			expect(document.querySelector('[data-testid="script-errors-badge"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	// Re-review finding (MINOR): a badge that cannot be acted on. A sort or a
	// reload drops the store's page-state signature the instant the request goes
	// out, but the PREVIOUS page's `script_status` survives it — so a badge gated
	// on the status alone stayed lit, and clicking it did nothing at all
	// (`requestScriptErrors` no-ops, the panel opens and the effect shuts it in
	// the same flush). Gate on the store's askability instead.
	it('hides the badge while a re-evaluation is in flight', () => {
		h.scriptStatus = READY; // still the previous page's, and stale
		h.canCheckScriptErrors = false;
		const c = render('tbl:draft:1');
		try {
			expect(document.querySelector('[data-testid="script-errors-badge"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('offers a NEUTRAL check affordance once settled, and fetches only on click', () => {
		h.scriptStatus = READY;
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			expect(badge).not.toBeNull();
			expect(badge.textContent).toContain('Check for script errors');
			// Nothing is known yet, so nothing may be styled as a failure.
			expect(badge.className).not.toContain('destructive');
			// Rendering the badge must not have cost a whole-table pass.
			expect(h.requestScriptErrors).not.toHaveBeenCalled();

			badge.click();
			flushSync();
			expect(h.requestScriptErrors).toHaveBeenCalledTimes(1);
			expect(h.requestScriptErrors.mock.calls[0]).toEqual(['tbl:draft:1']);
			// ...and the panel opens, so the click has a visible answer.
			expect(document.querySelector('[data-testid="script-errors-panel"]')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('says so while the check is in flight', () => {
		h.scriptStatus = READY;
		h.scriptErrorsPhase = 'loading';
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			expect(badge.textContent).toContain('Checking');
			badge.click();
			flushSync();
			expect(document.querySelector('[data-testid="script-errors-panel"]')?.textContent).toContain(
				'Checking'
			);
		} finally {
			unmount(c);
		}
	});

	it('answers plainly when the fetched recap is empty', () => {
		h.scriptStatus = READY;
		h.scriptErrorsPhase = 'done';
		h.scriptErrors = { state: 'ready', errors: [], total_errors: 0, truncated: false };
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			expect(badge.textContent).toContain('No script errors');
			expect(badge.className).not.toContain('destructive');
			badge.click();
			flushSync();
			expect(document.querySelector('[data-testid="script-errors-panel"]')?.textContent).toContain(
				'No script errors'
			);
		} finally {
			unmount(c);
		}
	});

	// Re-review finding (IMPORTANT): with no script runner the recap route now
	// answers ZERO errors (the honest server-side answer — nothing ran, so
	// nothing is known to have failed), and the wire cannot carry the
	// distinction. Rendering that as "No script errors" puts a green tick
	// directly above a grid whose every script cell reads
	// `#ERROR: script runner unavailable`. The cells are the evidence, so the
	// client uses them.
	it('does not claim a clean table when script cells were never computed', () => {
		h.scriptStatus = READY; // the unsorted-collapse shape: no calls, so `ready`
		h.scriptErrorsPhase = 'done';
		h.scriptErrors = { state: 'ready', errors: [], total_errors: 0, truncated: false };
		h.uncomputedScriptCellReason = 'script runner unavailable';
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			expect(badge.textContent).not.toContain('No script errors');
			expect(badge.textContent).toContain('unknown');
			badge.click();
			flushSync();
			const panel = document.querySelector('[data-testid="script-errors-panel"]') as HTMLElement;
			expect(panel.textContent).not.toContain('No script errors in this table');
			// ...and it says WHY, which for the `ready` shape is the only place the
			// user is told anything at all (there is no failure strip above).
			expect(panel.textContent).toContain('script runner unavailable');
		} finally {
			unmount(c);
		}
	});

	it('still answers a plain "none" when the check really did cover the table', () => {
		// The guard must not become a shrug: a healthy runner that found nothing
		// is a useful answer, and the user asked for it.
		h.scriptStatus = { state: 'failed', done: 4, total: 10, message: 'sweep died' };
		h.scriptErrorsPhase = 'done';
		h.scriptErrors = { state: 'ready', errors: [], total_errors: 0, truncated: false };
		h.uncomputedScriptCellReason = null;
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			expect(badge.textContent).toContain('No script errors');
			badge.click();
			flushSync();
			expect(document.querySelector('[data-testid="script-errors-panel"]')?.textContent).toContain(
				'No script errors in this table'
			);
		} finally {
			unmount(c);
		}
	});

	it('leaves a real error count alone when cells are uncomputed too', () => {
		// A known count is a stronger statement than "unknown": never downgrade it.
		h.scriptStatus = READY;
		h.scriptErrorsPhase = 'done';
		h.scriptErrors = RECAP;
		h.uncomputedScriptCellReason = 'script runner unavailable';
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			expect(badge.textContent).toContain('1 script error');
		} finally {
			unmount(c);
		}
	});

	it('reports a failed check instead of pretending there are no errors', () => {
		h.scriptStatus = READY;
		h.scriptErrorsPhase = 'error';
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			badge.click();
			flushSync();
			const panel = document.querySelector('[data-testid="script-errors-panel"]') as HTMLElement;
			expect(panel.textContent).toContain('Could not check');
		} finally {
			unmount(c);
		}
	});

	it('badges the error count, opens the panel, and jumps to the cell on click', () => {
		h.scriptStatus = READY;
		h.scriptErrorsPhase = 'done';
		h.scriptErrors = RECAP;
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			expect(badge).not.toBeNull();
			expect(badge.textContent).toContain('1 script error');
			// A known failure count IS a failure: the destructive styling returns.
			expect(badge.className).toContain('destructive');
			// Closed until asked for — it overlays the grid.
			expect(document.querySelector('[data-testid="script-errors-panel"]')).toBeNull();

			badge.click();
			flushSync();
			const panel = document.querySelector('[data-testid="script-errors-panel"]') as HTMLElement;
			expect(panel).not.toBeNull();
			expect(panel.textContent).toContain('Pump A');
			expect(panel.textContent).toContain('script');
			expect(panel.textContent).toContain('ZeroDivisionError');

			const entry = panel.querySelector('[data-testid="script-error-entry"]') as HTMLElement;
			// The full message stays reachable even though the line is truncated.
			expect(entry.getAttribute('title')).toBe('ZeroDivisionError: division by zero');
			entry.click();
			flushSync();

			// The jump is recorded as a store request (the grid consumes it), and
			// the panel closes so it doesn't sit over the row it just jumped to.
			expect(h.jump).toHaveBeenCalledTimes(1);
			expect(h.jump.mock.calls[0]).toEqual(['tbl:draft:1', 3, 1]);
			expect(document.querySelector('[data-testid="script-errors-panel"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('wires the badge to the panel for assistive tech', () => {
		h.scriptStatus = READY;
		h.scriptErrorsPhase = 'done';
		h.scriptErrors = RECAP;
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			expect(badge.getAttribute('aria-expanded')).toBe('false');
			expect(badge.getAttribute('aria-haspopup')).toBe('dialog');
			badge.click();
			flushSync();
			const panel = document.querySelector('[data-testid="script-errors-panel"]') as HTMLElement;
			expect(badge.getAttribute('aria-expanded')).toBe('true');
			// The badge names the element it controls, and that element exists.
			expect(badge.getAttribute('aria-controls')).toBe(panel.id);
			expect(panel.id).not.toBe('');
			expect(panel.getAttribute('role')).toBe('dialog');
			expect(panel.getAttribute('aria-label')).toBeTruthy();
		} finally {
			unmount(c);
		}
	});

	// Escape must work from INSIDE the panel too, not just from the badge: once
	// the user tabs into the list there is otherwise no keyboard way out of it
	// (the panel deliberately does not trap focus, but it does overlay the grid).
	it('dismisses the panel on Escape from the badge and from an entry', () => {
		h.scriptStatus = READY;
		h.scriptErrorsPhase = 'done';
		h.scriptErrors = RECAP;
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			badge.click();
			flushSync();
			expect(document.querySelector('[data-testid="script-errors-panel"]')).not.toBeNull();

			badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			flushSync();
			expect(document.querySelector('[data-testid="script-errors-panel"]')).toBeNull();

			badge.click();
			flushSync();
			const entry = document.querySelector('[data-testid="script-error-entry"]') as HTMLElement;
			entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			flushSync();
			expect(document.querySelector('[data-testid="script-errors-panel"]')).toBeNull();
			// Dismissing is not jumping.
			expect(h.jump).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('leaves the panel open on any other key', () => {
		h.scriptStatus = READY;
		h.scriptErrorsPhase = 'done';
		h.scriptErrors = RECAP;
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			badge.click();
			flushSync();
			badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
			flushSync();
			expect(document.querySelector('[data-testid="script-errors-panel"]')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('says how many of the total are listed when the recap is truncated', () => {
		h.scriptStatus = READY;
		h.scriptErrorsPhase = 'done';
		h.scriptErrors = { ...RECAP, total_errors: 4021, truncated: true };
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="script-errors-badge"]') as HTMLElement;
			expect(badge.textContent).toContain('4021 script errors');
			badge.click();
			flushSync();
			const panel = document.querySelector('[data-testid="script-errors-panel"]');
			expect(panel?.textContent).toContain('showing first 1');
		} finally {
			unmount(c);
		}
	});
});

describe('TableView header edit / add-column focus', () => {
	afterEach(() => {
		h.page = undefined;
		(h.draft as { definition: { row_source: unknown; columns: unknown[] } }).definition = {
			row_source: { kind: 'scope', scope: {} },
			columns: []
		};
	});

	function seedTwoColumnPage(): void {
		h.page = {
			columns: [
				{ kind: 'element', header: 'Scope', width_px: null },
				{ kind: 'property', header: 'Mass', width_px: null }
			],
			rows: [],
			total: 0,
			truncated: false,
			offset: 0,
			model_rev: 1
		};
		(h.draft as { definition: { row_source: unknown; columns: unknown[] } }).definition = {
			// A real scope row source — the unfocused path renders RowSourceEditor
			// → ScopeEditor for real, which needs `types`/`criteria` present.
			row_source: { kind: 'scope', types: ['Block'], criteria: [] },
			columns: [
				{
					kind: 'element',
					source: { kind: 'row', chain_index: 0 },
					header: '',
					width_px: null,
					hidden: false
				},
				{
					kind: 'property',
					source: { kind: 'row', chain_index: 0 },
					name: 'mass',
					mode: 'collapse',
					keep_empty: true,
					header: '',
					width_px: null,
					hidden: false
				}
			]
		};
	}

	it('clicking a header edit button opens the dialog focused on just that column', () => {
		seedTwoColumnPage();
		const c = render('tbl:draft:1');
		try {
			const editBtn = document.querySelector('[data-testid="header-edit-1"]') as HTMLElement;
			expect(editBtn).not.toBeNull();
			editBtn.click();
			flushSync();
			const manager = document.querySelector('[data-testid="column-manager"]') as HTMLElement;
			expect(manager).not.toBeNull();
			expect(manager.querySelectorAll('[data-testid^="toggle-hidden-"]').length).toBe(1);
			expect(manager.querySelector('[data-testid="toggle-hidden-1"]')).not.toBeNull();
			expect(document.body.textContent).toContain('Column settings');
		} finally {
			unmount(c);
		}
	});

	it('the Settings button path still shows every column', () => {
		seedTwoColumnPage();
		const c = render('tbl:draft:1');
		try {
			const settingsBtn = document.querySelector(
				'[data-testid="table-settings-button"]'
			) as HTMLElement;
			settingsBtn.click();
			flushSync();
			const manager = document.querySelector('[data-testid="column-manager"]') as HTMLElement;
			expect(manager).not.toBeNull();
			expect(manager.querySelectorAll('[data-testid^="toggle-hidden-"]').length).toBe(2);
			expect(document.body.textContent).toContain('Table settings');
		} finally {
			unmount(c);
		}
	});

	it('resets the focused column back to null once the dialog closes and reopens via Settings', async () => {
		seedTwoColumnPage();
		const c = render('tbl:draft:1');
		try {
			const editBtn = document.querySelector('[data-testid="header-edit-1"]') as HTMLElement;
			editBtn.click();
			flushSync();
			// Close the dialog via the custom X button (Task 6: the primitive's
			// built-in X is gone — `showCloseButton={false}` — replaced by a plain
			// button with a stable testid so it no longer needs picking out of a
			// `data-slot="dialog-close"` list shared with Cancel/Save). Content
			// unmount is still deferred until bits-ui's close "animation" resolves,
			// since `requestClose()` (the X's click handler) closes by assigning
			// `settingsOpen` directly on this clean dialog, which the dialog's
			// presence still tracks.
			const closeBtn = document.querySelector('[data-testid="settings-close"]') as HTMLElement;
			expect(closeBtn).not.toBeNull();
			// The `sr-only` span is the only thing giving the icon-only button an
			// accessible name — assert it survives (see the earlier "the X is
			// gated too" test for the gated path; this one is the clean path).
			expect(closeBtn.textContent?.trim()).toBe('Close');
			closeBtn.click();
			flushSync();
			await waitFor(() => document.querySelector('[data-testid="column-manager"]') === null);
			const settingsBtn = document.querySelector(
				'[data-testid="table-settings-button"]'
			) as HTMLElement;
			settingsBtn.click();
			flushSync();
			const manager = document.querySelector('[data-testid="column-manager"]') as HTMLElement;
			expect(manager.querySelectorAll('[data-testid^="toggle-hidden-"]').length).toBe(2);
		} finally {
			unmount(c);
		}
	});
});

describe('TableView settings dialog sizing', () => {
	// Opening the dialog unfocused mounts RowSourceEditor -> ScopeEditor for
	// real (see seedTwoColumnPage above), which needs `types`/`criteria`
	// present on a scope row source.
	// dlgW/dlgH are seeded from window.innerWidth/innerHeight when TableView is
	// created, so the viewport must be sized before mount, not before the
	// click that opens the dialog.
	function renderWithSettingsOpen(tabId: string): ReturnType<typeof render> {
		window.innerWidth = 1920;
		window.innerHeight = 1080;
		(h.draft as { definition: { row_source: unknown; columns: unknown[] } }).definition = {
			row_source: { kind: 'scope', types: [], criteria: [] },
			columns: []
		};
		const c = render(tabId);
		const settingsBtn = document.querySelector(
			'[data-testid="table-settings-button"]'
		) as HTMLElement;
		settingsBtn.click();
		flushSync();
		return c;
	}

	// Use a roomy viewport so the max-width/max-height caps (98%/95% of the
	// viewport) don't clip the deltas this suite asserts on — the happy-dom
	// default (1024x768) leaves too little headroom above the capped initial
	// size (min(1280, 92vw) x 85vh).
	const origInnerWidth = window.innerWidth;
	const origInnerHeight = window.innerHeight;

	afterEach(() => {
		(h.draft as { definition: { row_source: unknown; columns: unknown[] } }).definition = {
			row_source: { kind: 'scope', scope: {} },
			columns: []
		};
		window.innerWidth = origInnerWidth;
		window.innerHeight = origInnerHeight;
	});

	it('opens with an inline width/height style and a resize handle on the dialog frame', () => {
		const c = renderWithSettingsOpen('tbl:draft:1');
		try {
			const dialog = document.querySelector('[data-testid="table-settings-dialog"]') as HTMLElement;
			expect(dialog).not.toBeNull();
			expect(dialog.style.width).not.toBe('');
			expect(dialog.style.height).not.toBe('');
			const handle = document.querySelector(
				'[data-testid="settings-resize-handle"]'
			) as HTMLElement;
			expect(handle).not.toBeNull();
			// The grip must sit on the dialog frame, not inside the scrollable
			// body — it's a sibling of the scroll container, not nested in it.
			expect(handle.closest('.overflow-y-auto')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('dragging the resize handle grows width/height by 2x the pointer delta', () => {
		const c = renderWithSettingsOpen('tbl:draft:1');
		try {
			const dialog = document.querySelector('[data-testid="table-settings-dialog"]') as HTMLElement;
			const handle = document.querySelector(
				'[data-testid="settings-resize-handle"]'
			) as HTMLElement;
			const startW = parseFloat(dialog.style.width);
			const startH = parseFloat(dialog.style.height);
			handle.dispatchEvent(
				new PointerEvent('pointerdown', {
					bubbles: true,
					button: 0,
					pointerId: 1,
					clientX: 0,
					clientY: 0
				})
			);
			flushSync();
			handle.dispatchEvent(
				new PointerEvent('pointermove', {
					bubbles: true,
					pointerId: 1,
					clientX: 50,
					clientY: 40
				})
			);
			flushSync();
			expect(parseFloat(dialog.style.width)).toBeCloseTo(startW + 100);
			expect(parseFloat(dialog.style.height)).toBeCloseTo(startH + 80);
			handle.dispatchEvent(
				new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 50, clientY: 40 })
			);
			flushSync();
		} finally {
			unmount(c);
		}
	});

	it('clamps the dialog to a minimum width/height', () => {
		const c = renderWithSettingsOpen('tbl:draft:1');
		try {
			const dialog = document.querySelector('[data-testid="table-settings-dialog"]') as HTMLElement;
			const handle = document.querySelector(
				'[data-testid="settings-resize-handle"]'
			) as HTMLElement;
			handle.dispatchEvent(
				new PointerEvent('pointerdown', {
					bubbles: true,
					button: 0,
					pointerId: 1,
					clientX: 0,
					clientY: 0
				})
			);
			flushSync();
			handle.dispatchEvent(
				new PointerEvent('pointermove', {
					bubbles: true,
					pointerId: 1,
					clientX: -5000,
					clientY: -5000
				})
			);
			flushSync();
			expect(parseFloat(dialog.style.width)).toBe(640);
			expect(parseFloat(dialog.style.height)).toBe(400);
		} finally {
			unmount(c);
		}
	});
});

// Task 7: the old strip joined raw backend prose with ' · ' behind
// `data-testid="table-warnings"`. It is now a COUNT plus a disclosure
// (`table-warnings-badge`) — the formatted prose lives behind a click, in
// `ScriptWarningsPanel`. Uses this file's own mount/flushSync/unmount
// convention, not the brief's literal `@testing-library/svelte`
// `render`/`screen`/`fireEvent` snippet — see the file header.
describe('TableView script-warnings badge + panel', () => {
	const WARNINGS: ScriptWarning[] = [
		{ code: 'nav_unknown_ids', occurrences: 17, total: 42, detail: null },
		{ code: 'sort_needs_script_nav', occurrences: 1, total: 0, detail: null }
	];

	it('hides the badge when getTableWarnings returns empty', () => {
		h.warnings = [];
		const c = render('tbl:draft:1');
		try {
			expect(document.querySelector('[data-testid="table-warnings-badge"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('summarises script warnings and opens the panel on demand', () => {
		h.warnings = WARNINGS;
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="table-warnings-badge"]') as HTMLElement;
			expect(badge).not.toBeNull();
			expect(badge.textContent).toContain('2 script warnings');
			expect(document.querySelector('[data-testid="script-warnings-panel"]')).toBeNull();

			badge.click();
			flushSync();
			expect(document.querySelector('[data-testid="script-warnings-panel"]')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('singularises a lone warning', () => {
		h.warnings = [WARNINGS[1]];
		const c = render('tbl:draft:1');
		try {
			const badge = document.querySelector('[data-testid="table-warnings-badge"]') as HTMLElement;
			expect(badge.textContent).toContain('1 script warning');
			expect(badge.textContent).not.toContain('1 script warnings');
		} finally {
			unmount(c);
		}
	});
});

describe('TableView row count', () => {
	afterEach(() => {
		h.page = undefined;
		(h.draft as { definition: { columns: unknown[] } }).definition.columns = [];
	});

	it('shows the total row count when no column splits rows', () => {
		h.page = {
			columns: [],
			rows: [],
			total: 12,
			base_total: 12,
			truncated: false,
			offset: 0,
			model_rev: 1
		};
		const c = render('tbl:draft:1');
		try {
			const count = document.querySelector('[data-testid="table-row-count"]');
			expect(count?.textContent).toContain('12 rows');
			expect(count?.textContent).not.toContain('→');
		} finally {
			unmount(c);
		}
	});

	it('shows the pre-split element count AND the row count when a column splits rows', () => {
		h.page = {
			columns: [],
			rows: [],
			total: 12,
			base_total: 5,
			truncated: false,
			offset: 0,
			model_rev: 1
		};
		(h.draft as { definition: { columns: unknown[] } }).definition.columns = [
			{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null },
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'mass',
				mode: 'expand',
				keep_empty: true,
				header: '',
				width_px: null
			}
		];
		const c = render('tbl:draft:1');
		try {
			const count = document.querySelector('[data-testid="table-row-count"]');
			expect(count?.textContent).toContain('5 elements');
			expect(count?.textContent).toContain('12 rows');
		} finally {
			unmount(c);
		}
	});

	it('marks a truncated row count', () => {
		h.page = {
			columns: [],
			rows: [],
			total: 50,
			base_total: 50,
			truncated: true,
			offset: 0,
			model_rev: 1
		};
		const c = render('tbl:draft:1');
		try {
			expect(document.querySelector('[data-testid="table-row-count"]')?.textContent).toContain(
				'50+'
			);
		} finally {
			unmount(c);
		}
	});
});

// Task 10: the Export button is now a dropdown trigger (bits-ui's
// DropdownMenu, not a Dialog) offering both file formats. Unlike the settings
// Dialog elsewhere in this file, DropdownMenu.Content is not gated behind a
// requestAnimationFrame-deferred close "animation" — PathCard's "Combine
// with… ▾" menu (path-card.test.ts) opens its items with a plain click +
// flushSync, no waitFor. `waitFor` is used below anyway, defensively, since a
// portal-based Content is still one more render pass than an inline element.
describe('TableView export format menu', () => {
	afterEach(() => {
		// downloadTable is a plain `vi.fn()` inside the vi.mock factory (not a
		// vi.spyOn target), so the file's blanket `vi.restoreAllMocks()` in its
		// own afterEach does not clear its call history — do it here so one
		// test's click can't be mistaken for another's.
		vi.mocked(downloadTable).mockClear();
	});

	/** Pick a format from the Export ▾ menu and wait for the dialog it opens. */
	async function chooseFormat(format: 'xlsx' | 'json'): Promise<void> {
		(document.querySelector('[data-testid="table-export-button"]') as HTMLElement).click();
		flushSync();
		await waitFor(() => !!document.querySelector(`[data-testid="table-export-${format}"]`));
		(document.querySelector(`[data-testid="table-export-${format}"]`) as HTMLElement).click();
		flushSync();
		await waitFor(() => !!document.querySelector('[data-testid="export-confirm"]'));
	}

	// Task 7: the menu items no longer download — they open the export settings
	// dialog on the chosen format, and the download happens on its Export
	// button. Asserting only "the dialog opened" would let a component that
	// downloaded anyway pass, so both halves are checked: nothing downloads on
	// the menu click, and the right format downloads on the confirm click.
	it('opens the export dialog on the chosen format rather than downloading', async () => {
		const c = render('tbl:draft:1');
		try {
			await chooseFormat('json');
			expect(document.querySelector('[data-testid="table-export-dialog"]')).not.toBeNull();
			expect(
				document.querySelector('[data-testid="export-format-json"]')?.getAttribute('aria-pressed')
			).toBe('true');
			expect(downloadTable).not.toHaveBeenCalled();

			(document.querySelector('[data-testid="export-confirm"]') as HTMLElement).click();
			flushSync();
			expect(downloadTable).toHaveBeenCalledWith(
				'tbl:draft:1',
				expect.objectContaining({ format: 'json' })
			);
		} finally {
			unmount(c);
		}
	});

	it('exports xlsx when that item is chosen', async () => {
		const c = render('tbl:draft:1');
		try {
			await chooseFormat('xlsx');
			(document.querySelector('[data-testid="export-confirm"]') as HTMLElement).click();
			flushSync();
			expect(downloadTable).toHaveBeenCalledWith(
				'tbl:draft:1',
				expect.objectContaining({ format: 'xlsx' })
			);
		} finally {
			unmount(c);
		}
	});
});

// Task 11 gave the settings dialog a second tab (JSON export options + a live
// preview); the export-settings task took it back out again — those options
// moved to the export dialog, beside the inclusion/order settings they share a
// file with. What is pinned here is that the settings dialog is a single body
// once more, with no tab strip to switch. Uses this file's own
// mount/flushSync/unmount + waitFor convention.
describe('TableView settings dialog body', () => {
	afterEach(() => {
		// Restore the hoisted default's VALID shape (matching `h`'s own
		// declaration above), not the `{kind:'scope', scope:{}}` sentinel other
		// describe blocks in this file leave behind — that shape is exactly what
		// crashes ScopeEditor (see the comment in the test below), and since this
		// describe is lexically last, restoring it here is what keeps the trap
		// from being re-armed for whichever describe block is appended next.
		(h.draft as { definition: { row_source: unknown; columns: unknown[] } }).definition = {
			row_source: { kind: 'scope', types: [], criteria: [] },
			columns: []
		};
	});

	it('shows the column editor with no tab strip over it', async () => {
		// A self-contained, valid scope row source: earlier describe blocks in
		// this file leave `h.draft` (shared hoisted state) in various shapes for
		// their own tests, and the unfocused settings path mounts RowSourceEditor
		// -> ScopeEditor for real, which needs `types`/`criteria` present (see
		// `seedTwoColumnPage` / `renderWithSettingsOpen` above for the same fix).
		(h.draft as { definition: { row_source: unknown; columns: unknown[] } }).definition = {
			row_source: { kind: 'scope', types: [], criteria: [] },
			columns: []
		};
		const c = render('tbl:draft:1');
		try {
			(document.querySelector('[data-testid="table-settings-button"]') as HTMLElement).click();
			flushSync();
			await waitFor(() => !!document.querySelector('[data-testid="column-manager"]'));
			expect(document.querySelector('[data-testid="settings-tab-columns"]')).toBeNull();
			expect(document.querySelector('[data-testid="settings-tab-json"]')).toBeNull();
			// The JSON export options are the export dialog's now, not this one's.
			expect(document.querySelector('[data-testid="json-snake-all"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});
});

// Task 10: a lock-denied table tab used to leave the grid's column-manager/
// edit-column/add-column chrome fully live — only the name input and Save/
// Save-as were disabled. This pins the fix: the grid host (and, inside the
// settings dialog, the column manager) goes `inert` while denied, and the
// banner gains a "Save as copy" escape hatch that reuses `saveAsTableDraft` —
// the same fork the (disabled-while-locked) toolbar "Save as…" button already
// used.
describe('TableView lock-denied banner', () => {
	afterEach(() => {
		vi.mocked(saveAsTableDraft).mockClear();
	});

	it('renders the grid host inert while denied', () => {
		h.lockHolder = 'peer@x';
		const c = render('tbl:draft:1');
		try {
			const host = document.querySelector('[data-testid="table-grid-host"]') as HTMLElement;
			expect(host).not.toBeNull();
			expect(host.inert).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('is not inert once the tab is no longer denied', () => {
		h.lockHolder = null;
		const c = render('tbl:draft:1');
		try {
			const host = document.querySelector('[data-testid="table-grid-host"]') as HTMLElement;
			expect(host.inert).toBe(false);
		} finally {
			unmount(c);
		}
	});

	it('the banner offers Save as copy, which forks via saveAsTableDraft', async () => {
		h.lockHolder = 'peer@x';
		vi.spyOn(window, 'prompt').mockReturnValue('Copy of table');
		const c = render('tbl:draft:1');
		try {
			const btn = document.querySelector('[data-testid="table-save-as-copy"]') as HTMLElement;
			expect(btn).not.toBeNull();
			btn.click();
			flushSync();
			await Promise.resolve();

			expect(window.prompt).toHaveBeenCalledWith('Save copy as', 'My Table (copy)');
			expect(saveAsTableDraft).toHaveBeenCalledWith('tbl:draft:1', 'Copy of table');
		} finally {
			unmount(c);
		}
	});
});
