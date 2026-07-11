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

	it('adds an element column via updateTableDefinition', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
				{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null }
			])
		);
		const upd = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('t');
		try {
			click(document.querySelector('[data-testid="add-element-column"]'));
			expect(upd).toHaveBeenCalled();
			const defn = upd.mock.calls.at(-1)![1];
			expect(defn.columns.filter((col) => col.kind === 'element')).toHaveLength(2);
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
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			scopeDraft([
				{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null },
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
