// Render tests for the definition-editing panel (Task 7). Follows the repo's
// established Svelte-5 render convention (mount/unmount/flushSync) used by
// `Table/__tests__/TableGrid.test.ts` rather than the brief's literal
// `@testing-library/svelte` snippet — that package is not a project
// dependency.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TableDefinition } from '$lib/api/types';
import * as store from '$lib/state/table-editor.svelte';
import ColumnManager from '../ColumnManager.svelte';

function scopeDraft(columns: TableDefinition['columns']) {
	return {
		name: '',
		artifactId: null,
		artifactRev: null,
		dirty: false,
		definition: {
			schema_version: 1,
			default_cell_mode: 'collapse' as const,
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
				{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null }
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
				{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null }
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
				{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null },
				{
					kind: 'property',
					source: { kind: 'row', chain_index: 0 },
					name: 'mass',
					mode: 'collapse',
					keep_empty: true,
					header: '',
					width_px: null
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
				{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null },
				{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null }
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

	it('adds a navigation column via updateTableDefinition', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
				{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null }
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

	it('catches ColumnInUseError on remove and shows a message without calling updateTableDefinition', () => {
		// Two element columns so column 0's remove button is ENABLED (the
		// sole-scope-column guard doesn't apply) and the error path is what's
		// exercised.
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
				{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null },
				{ kind: 'element', source: { kind: 'column', index: 0 }, header: '', width_px: null },
				{
					kind: 'navigation',
					source: { kind: 'column', index: 0 },
					mode: 'collapse',
					keep_empty: true,
					sort_mode: 'value',
					cell_cap: 20,
					header: '',
					width_px: null,
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
});
