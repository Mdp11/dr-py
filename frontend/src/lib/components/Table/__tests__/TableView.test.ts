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
	// TableGrid's dependencies (always mounted below the chrome bar).
	getTablePage: () => h.page,
	getTableLoading: () => false,
	getTableSort: () => undefined,
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
