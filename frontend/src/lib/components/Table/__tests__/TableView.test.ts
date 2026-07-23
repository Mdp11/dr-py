// Behaviour test for the settings-popup refactor (Task 1): the definition
// editor (ColumnManager) no longer sits inline in the tab — it lives behind a
// ⚙ Settings button that opens a Dialog, and the button is editor-only. This
// covers the button's edit-gating and that the manager is not mounted until the
// popup opens; the full open→edit→grid-updates flow is covered by e2e
// (e2e/table.spec.ts). Uses the repo's mount/flushSync/unmount Svelte-5 render
// convention (see TableGrid.test.ts) rather than @testing-library/svelte.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import TableView from '../TableView.svelte';

// Hoisted so the vi.mock factory (hoisted above imports) can reference it, and
// so each test can flip `editable` before mounting.
const h = vi.hoisted(() => ({
	editable: true,
	page: undefined as unknown,
	warnings: [] as string[],
	scriptStatus: null as unknown,
	scriptErrors: null as unknown,
	scriptErrorsPhase: 'idle' as 'idle' | 'loading' | 'error' | 'done',
	/** Mirrors the store's `_recapKeys.has(tab)`: is there a settled page state
	 * a recap could describe RIGHT NOW (false while a load is in flight). */
	canCheckScriptErrors: true,
	/** Mirrors the store's evidence from the page on screen: why a script cell
	 * holds no value, or null when they all do. */
	uncomputedScriptCellReason: null as string | null,
	requestScriptErrors: vi.fn(),
	jump: vi.fn(),
	draft: {
		tabId: 'tbl:draft:1',
		name: 'My Table',
		dirty: false,
		artifactId: 'a1',
		definition: { row_source: { kind: 'scope', scope: {} }, columns: [] }
	} as unknown
}));

// TableView (and, when opened, ColumnManager) import from the $lib/state barrel.
// Only TableView's own functions are exercised here — the dialog stays closed,
// so ColumnManager is never mounted and its state functions are never called.
// TableGrid *is* always mounted (full-height grid below the chrome bar), so its
// $lib/state dependencies are stubbed too — vi.mock replaces the whole barrel,
// so any export TableGrid imports must be present or the mount throws.
vi.mock('$lib/state', () => ({
	canEdit: () => h.editable,
	getMetamodel: () => null,
	ensureTableDraft: vi.fn(async () => {}),
	getTableDraft: () => h.draft,
	getTableConflict: () => undefined,
	getTableWarnings: () => h.warnings,
	downloadTable: vi.fn(async () => {}),
	saveTableDraft: vi.fn(async () => {}),
	saveAsTableDraft: vi.fn(async () => {}),
	reloadTableDraft: vi.fn(),
	setTableName: vi.fn(),
	// Staged definition edits: the settings dialog suspends evaluation while
	// open and resumes (evaluating at most once) on close.
	suspendTableEvaluation: vi.fn(),
	resumeTableEvaluation: vi.fn(),
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
	// RowSourceEditor's dependencies (mounted once the settings dialog opens
	// unfocused — the "shows every column" path renders it for real).
	closeDraft: vi.fn(),
	ensureEmbeddedDraft: vi.fn(),
	getArtifactHeaders: () => [],
	getDraft: () => undefined
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
	h.requestScriptErrors.mockReset();
	h.jump.mockReset();
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
});

// Task 10 / cross-impl adoption: the sweep readout is FIXED chrome next to the
// conflict and warnings strips, NOT an in-flow element inside TableGrid's
// scroll container (where it would scroll away on a long table and offset the
// virtualizer's row math while `computing`). These two cases moved here from
// TableGrid.test.ts with the strip itself.
describe('TableView script-status strip', () => {
	it('shows the sweep progress readout while computing', () => {
		h.scriptStatus = { state: 'computing', done: 7, total: 42 };
		const c = render('tbl:draft:computing');
		try {
			const strip = document.querySelector('[data-testid="table-script-status"]');
			expect(strip?.textContent).toContain('Computing script columns 7/42');
			expect(strip?.getAttribute('aria-live')).toBe('polite');
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
			// Close the dialog via its built-in close button (bits-ui fires
			// onOpenChange(false), which is where the focus reset lives). Content
			// unmount is deferred until bits-ui's close "animation" resolves.
			const closeBtn = document.querySelector('[data-slot="dialog-close"]') as HTMLElement;
			expect(closeBtn).not.toBeNull();
			closeBtn.click();
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

describe('TableView warnings banner', () => {
	it('shows the banner with the joined warnings when getTableWarnings is non-empty', () => {
		h.warnings = ['column 1: script raised on 2 rows', 'column 3: truncated to 20 items'];
		const c = render('tbl:draft:1');
		try {
			const banner = document.querySelector('[data-testid="table-warnings"]');
			expect(banner).not.toBeNull();
			expect(banner?.textContent).toContain('column 1: script raised on 2 rows');
			expect(banner?.textContent).toContain('column 3: truncated to 20 items');
		} finally {
			unmount(c);
		}
	});

	it('hides the banner when getTableWarnings returns empty', () => {
		h.warnings = [];
		const c = render('tbl:draft:1');
		try {
			expect(document.querySelector('[data-testid="table-warnings"]')).toBeNull();
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
