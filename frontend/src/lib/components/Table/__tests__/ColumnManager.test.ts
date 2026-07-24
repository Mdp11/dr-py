// Render tests for the definition-editing panel (Task 7). Follows the repo's
// established Svelte-5 render convention (mount/unmount/flushSync) used by
// `Table/__tests__/TableGrid.test.ts` rather than the brief's literal
// `@testing-library/svelte` snippet — that package is not a project
// dependency.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as tablesApi from '$lib/api/tables';
import type { Column, TableDefinition } from '$lib/api/types';
import {
	ensureTableDraft,
	getTableDraft,
	getTableSort,
	setTableSort,
	updateTableDefinition
} from '$lib/state';
import * as store from '$lib/state/table-editor.svelte';
import ColumnManager from '../ColumnManager.svelte';

const CLONE_TAB = 'tbl:draft:clone-test';

const EMPTY_PAGE = {
	columns: [],
	rows: [],
	total: 0,
	truncated: false,
	offset: 0,
	model_rev: 1,
	warnings: []
};

// Drives the REAL table store (not the getTableDraft/updateTableDefinition
// spies the other tests in this file use) so the clone handler's paired
// mutator+remap can be observed end to end. Defined at module scope because a
// later task's sibling `it(...)` in this file reuses this seed.
// `updateTableDefinition` fire-and-forgets a page reload (`loadTablePage`), so
// `evaluateTable` is stubbed here — same as `ColumnManager.collapse.test.ts`
// and `table-editor.test.ts` — to keep the run free of a real, unmocked
// network call against the (absent) dev backend.
// `extraColumns` defaults to none, so the original 2-column (element, Mass)
// shape is unchanged for the existing callers below. C5's sort-remap test
// passes a third column so a post-clone sort index (>= the clone's
// insertion point) is still IN RANGE — `_sortFor` clears any sort pointing
// past the last column, which would silently launder a missing remap call.
async function seedForClone(extraColumns: Column[] = []): Promise<void> {
	vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
	await ensureTableDraft(CLONE_TAB);
	const defn: TableDefinition = {
		schema_version: 1,
		default_cell_mode: 'collapse',
		show_row_numbers: false,
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns: [
			{
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: 'Block',
				width_px: null,
				hidden: false
			},
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'mass',
				mode: 'collapse',
				keep_empty: true,
				header: 'Mass',
				width_px: null,
				hidden: false
			},
			...extraColumns
		]
	};
	updateTableDefinition(CLONE_TAB, defn);
	flushSync();
}

function scopeDraft(columns: TableDefinition['columns']) {
	return {
		name: '',
		artifactId: null,
		artifactRev: null,
		dirty: false,
		definition: {
			schema_version: 1,
			default_cell_mode: 'collapse' as const,
			show_row_numbers: false,
			row_source: { kind: 'scope' as const, types: ['Block'], criteria: [] },
			columns
		}
	};
}

function render(tabId: string) {
	const component = mount(ColumnManager, { target: document.body, props: { tabId } });
	flushSync();
	return component;
}

function click(el: Element | null): void {
	if (!el) throw new Error('element not found');
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('ColumnManager', () => {
	it('adds a property column via updateTableDefinition', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
				{
					kind: 'element',
					source: { kind: 'row', chain_index: 0 },
					header: '',
					width_px: null,
					hidden: false
				}
			])
		);
		const upd = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('t');
		try {
			click(document.querySelector('[data-testid="add-property-column"]'));
			expect(upd).toHaveBeenCalled();
			const defn = upd.mock.calls.at(-1)![1];
			expect(defn.columns.some((col) => col.kind === 'property')).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('offers no "+ Element column" button (the scope column is the only element column)', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
				{
					kind: 'element',
					source: { kind: 'row', chain_index: 0 },
					header: '',
					width_px: null,
					hidden: false
				}
			])
		);
		const c = render('t');
		try {
			expect(document.querySelector('[data-testid="add-element-column"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('labels the element column "Scope" and disables removing the last one', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
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
			])
		);
		const upd = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('t');
		try {
			expect(document.querySelector('[data-testid="column-manager"]')?.textContent).toContain(
				'Scope'
			);
			const removeScope = document.querySelector(
				'[data-testid="remove-column-0"]'
			) as HTMLButtonElement;
			expect(removeScope.disabled).toBe(true);
			click(removeScope);
			expect(upd).not.toHaveBeenCalled();
			// Non-element columns stay removable.
			const removeProp = document.querySelector(
				'[data-testid="remove-column-1"]'
			) as HTMLButtonElement;
			expect(removeProp.disabled).toBe(false);
		} finally {
			unmount(c);
		}
	});

	it('keeps extra element columns removable (chains-derived tables)', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
				{
					kind: 'element',
					source: { kind: 'row', chain_index: 0 },
					header: '',
					width_px: null,
					hidden: false
				},
				{
					kind: 'element',
					source: { kind: 'row', chain_index: 0 },
					header: '',
					width_px: null,
					hidden: false
				}
			])
		);
		const upd = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('t');
		try {
			const remove = document.querySelector('[data-testid="remove-column-1"]') as HTMLButtonElement;
			expect(remove.disabled).toBe(false);
			click(remove);
			expect(upd).toHaveBeenCalled();
			const defn = upd.mock.calls.at(-1)![1];
			expect(defn.columns).toHaveLength(1);
		} finally {
			unmount(c);
		}
	});

	it('adds a script column via updateTableDefinition', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
				{
					kind: 'element',
					source: { kind: 'row', chain_index: 0 },
					header: '',
					width_px: null,
					hidden: false
				}
			])
		);
		const upd = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('t');
		try {
			click(document.querySelector('[data-testid="add-script-column"]'));
			expect(upd).toHaveBeenCalled();
			const defn = upd.mock.calls.at(-1)![1];
			expect(defn.columns.some((col) => col.kind === 'script')).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('adds a navigation column via updateTableDefinition', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
				{
					kind: 'element',
					source: { kind: 'row', chain_index: 0 },
					header: '',
					width_px: null,
					hidden: false
				}
			])
		);
		const upd = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('t');
		try {
			click(document.querySelector('[data-testid="add-navigation-column"]'));
			expect(upd).toHaveBeenCalled();
			const defn = upd.mock.calls.at(-1)![1];
			expect(defn.columns.some((col) => col.kind === 'navigation')).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it("toggles a column's hidden flag via the eye button, flipping aria-label and icon", () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
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
			])
		);
		const upd = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('t');
		try {
			const toggle = document.querySelector('[data-testid="toggle-hidden-1"]') as HTMLButtonElement;
			expect(toggle.getAttribute('aria-label')).toBe('Hide column');
			expect(toggle.querySelector('[data-testid="eye-off-icon"]')).toBeNull();

			click(toggle);
			expect(upd).toHaveBeenCalledTimes(1);
			const defn = upd.mock.calls.at(-1)![1];
			expect(defn.columns[1].hidden).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('shows "Show column" and the eye-off icon once a column is hidden', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
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
					hidden: true
				}
			])
		);
		const c = render('t');
		try {
			const toggle = document.querySelector('[data-testid="toggle-hidden-1"]') as HTMLButtonElement;
			expect(toggle.getAttribute('aria-label')).toBe('Show column');
			expect(toggle.querySelector('[data-testid="eye-off-icon"]')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('focusIndex renders only that column: no row source, no add buttons, no move/remove — rename, eye and kind editor stay', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
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
			])
		);
		const component = mount(ColumnManager, {
			target: document.body,
			props: { tabId: 't', focusIndex: 1 }
		});
		flushSync();
		try {
			expect(document.querySelector('[data-testid="row-source-editor"]')).toBeNull();
			expect(document.querySelector('[data-testid="add-property-column"]')).toBeNull();
			expect(document.querySelector('[data-testid="add-navigation-column"]')).toBeNull();
			expect(document.querySelector('[data-testid="move-up-1"]')).toBeNull();
			expect(document.querySelector('[data-testid="move-down-1"]')).toBeNull();
			expect(document.querySelector('[data-testid="remove-column-1"]')).toBeNull();
			// column 0 is not the focused index — its card does not render at all.
			expect(document.querySelector('[data-testid="toggle-hidden-0"]')).toBeNull();
			// column 1 is focused — rename input, eye toggle and kind editor stay.
			expect(document.querySelector('[data-testid="toggle-hidden-1"]')).not.toBeNull();
			const manager = document.querySelector('[data-testid="column-manager"]') as HTMLElement;
			// The rename input (placeholder falls back to columnLabel — the
			// column's name, "mass") stays…
			expect(manager.querySelector('input[placeholder="mass"]')).not.toBeNull();
			// …and so does the kind editor (PropertyColumnEditor's own field).
			expect(manager.querySelector('input[placeholder="property name"]')).not.toBeNull();
		} finally {
			unmount(component);
		}
	});

	it('catches ColumnInUseError on remove and shows a message without calling updateTableDefinition', () => {
		// Two element columns so column 0's remove button is ENABLED (the
		// sole-scope-column guard doesn't apply) and the error path is what's
		// exercised.
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
				{
					kind: 'element',
					source: { kind: 'row', chain_index: 0 },
					header: '',
					width_px: null,
					hidden: false
				},
				{
					kind: 'element',
					source: { kind: 'column', index: 0 },
					header: '',
					width_px: null,
					hidden: false
				},
				{
					kind: 'navigation',
					source: { kind: 'column', index: 0 },
					mode: 'collapse',
					keep_empty: true,
					sort_mode: 'value',
					cell_cap: 20,
					header: '',
					width_px: null,
					hidden: false,
					navigation: {}
				}
			])
		);
		const upd = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('t');
		try {
			click(document.querySelector('[data-testid="remove-column-0"]'));
			expect(upd).not.toHaveBeenCalled();
			const msg = document.querySelector('[data-testid="column-manager-error"]');
			expect(msg?.textContent).toContain('column 1 sources column 0');
		} finally {
			unmount(c);
		}
	});

	it('clone button inserts a "(copy)" duplicate right below the original', async () => {
		await seedForClone();
		const c = mount(ColumnManager, { target: document.body, props: { tabId: CLONE_TAB } });
		flushSync();
		try {
			const clone = document.querySelector('[data-testid="clone-column-1"]') as HTMLButtonElement;
			expect(clone).toBeTruthy();
			clone.click();
			flushSync();
			const defn = getTableDraft(CLONE_TAB)!.definition;
			expect(defn.columns).toHaveLength(3);
			expect(defn.columns[2].header).toBe('Mass (copy)');
			expect(defn.columns[2].kind).toBe('property');
		} finally {
			unmount(c);
		}
	});

	it('shifts a sort at/after the clone insertion point so it keeps naming the same column', async () => {
		// C5 regression pin: onClone pairs cloneColumn with
		// remapTableSortForInsert(tabId, index + 1) in the SAME breath, mirroring
		// onRemove/onMove. A third column (index 2) sits after the clone target
		// (index 1, "Mass"), so the insertion at index 2 must shift the sort's
		// column from 2 to 3 to keep pointing at the same underlying column.
		await seedForClone([
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'name',
				mode: 'collapse',
				keep_empty: true,
				header: 'Name',
				width_px: null,
				hidden: false
			}
		]);
		const c = mount(ColumnManager, { target: document.body, props: { tabId: CLONE_TAB } });
		flushSync();
		try {
			setTableSort(CLONE_TAB, { column: 2, direction: 'asc' });
			flushSync();
			expect(getTableSort(CLONE_TAB)).toEqual({ column: 2, direction: 'asc' });

			const clone = document.querySelector('[data-testid="clone-column-1"]') as HTMLButtonElement;
			expect(clone).toBeTruthy();
			clone.click();
			flushSync();

			const defn = getTableDraft(CLONE_TAB)!.definition;
			expect(defn.columns).toHaveLength(4);
			// The original column 2 ("Name") is now at index 3.
			expect(defn.columns[3].header).toBe('Name');
			// ...and the sort followed it there, rather than staying at 2 (which
			// after the insert names the CLONE, not "Name").
			expect(getTableSort(CLONE_TAB)).toEqual({ column: 3, direction: 'asc' });
		} finally {
			unmount(c);
		}
	});

	it('the row-numbers toggle flips show_row_numbers on the definition', async () => {
		await seedForClone(); // Task 4's seed helper in this same file
		const c = mount(ColumnManager, { target: document.body, props: { tabId: CLONE_TAB } });
		flushSync();
		try {
			const box = document.querySelector('[data-testid="toggle-row-numbers"]') as HTMLInputElement;
			expect(box).toBeTruthy();
			expect(box.checked).toBe(false);
			box.click();
			flushSync();
			expect(getTableDraft(CLONE_TAB)!.definition.show_row_numbers).toBe(true);
		} finally {
			unmount(c);
		}
	});
});
