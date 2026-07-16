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
	ensureTableDraft: vi.fn(async () => {}),
	getTableDraft: () => h.draft,
	getTableConflict: () => undefined,
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
	lockBadgeFor: () => ({ state: 'none' })
}));

function render(tabId: string) {
	const c = mount(TableView, { target: document.body, props: { tabId } });
	flushSync();
	return c;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
	h.editable = true;
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
