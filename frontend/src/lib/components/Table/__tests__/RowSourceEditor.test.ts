// Inline-mode tests for the row-source editor. RowSourceEditor is NOT a
// controlled component — it calls updateTableDefinition directly — so these
// spy on the table-editor store like ColumnManager.test.ts does, while the
// navigation-editor store runs for real (embedded drafts).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as tableStore from '$lib/state/table-editor.svelte';
import { resetArtifacts, resetCheckout, resetNavigationEditors, setProjectInfo } from '$lib/state';
import type { TableDefinition } from '$lib/api/types';
import RowSourceEditor from '../RowSourceEditor.svelte';

const CHAIN_PAGE = { step_types: [], chains: [], total: 0, truncated: false, warnings: [] };

function defnWith(rowSource: TableDefinition['row_source']): TableDefinition {
	return {
		schema_version: 1,
		default_cell_mode: 'collapse',
		row_source: rowSource,
		columns: [
			{
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: '',
				width_px: null,
				hidden: false
			}
		]
	};
}

function render(defn: TableDefinition) {
	const c = mount(RowSourceEditor, { target: document.body, props: { tabId: 't', defn } });
	flushSync();
	return c;
}

function click(el: Element | null): void {
	if (!el) throw new Error('element not found');
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

beforeEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
});
afterEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('RowSourceEditor inline mode', () => {
	it('switching a navigation row source to inline seeds a scope-started path', async () => {
		const upd = vi.spyOn(tableStore, 'updateTableDefinition').mockImplementation(() => {});
		const c = render(defnWith({ kind: 'navigation', navigation: {}, step_index: null }));
		try {
			click(document.querySelector('[data-testid="rowsource-mode-inline"]'));
			await vi.waitFor(() => expect(upd).toHaveBeenCalled());
			const defn = upd.mock.calls.at(-1)![1] as TableDefinition;
			expect(defn.row_source).toMatchObject({
				kind: 'navigation',
				navigation: { definition: { kind: 'path', start: { kind: 'scope' } } }
			});
		} finally {
			unmount(c);
		}
	});

	it('renders the embedded builder for an inline row source', async () => {
		vi.spyOn(tableStore, 'updateTableDefinition').mockImplementation(() => {});
		const inline = {
			kind: 'path' as const,
			schema_version: 2,
			start: { kind: 'scope' as const, types: ['System'], criteria: [] },
			steps: [],
			exclude_visited: true
		};
		const c = render(defnWith({ kind: 'chains', navigation: { definition: inline } }));
		try {
			await vi.waitFor(() =>
				expect(document.querySelector('[data-testid="inline-rowsource-editor"]')).toBeTruthy()
			);
			// Embedded PathCards default COLLAPSED (table-settings readability) —
			// expand it to reach the start-mode select.
			click(document.querySelector('[data-testid="path-collapse-toggle"]'));
			// No row context: the start-mode select must NOT offer the row option.
			const select = document.querySelector('select[aria-label="Start mode"]')!;
			expect([...select.querySelectorAll('option')].map((o) => o.value)).not.toContain('row');
		} finally {
			unmount(c);
		}
	});

	it('switching back to saved clears the inline definition', async () => {
		const upd = vi.spyOn(tableStore, 'updateTableDefinition').mockImplementation(() => {});
		const inline = {
			kind: 'path' as const,
			schema_version: 2,
			start: { kind: 'scope' as const, types: [], criteria: [] },
			steps: [],
			exclude_visited: true
		};
		const c = render(
			defnWith({ kind: 'navigation', navigation: { definition: inline }, step_index: null })
		);
		try {
			await vi.waitFor(() =>
				expect(document.querySelector('[data-testid="inline-rowsource-editor"]')).toBeTruthy()
			);
			click(document.querySelector('[data-testid="rowsource-mode-ref"]'));
			const defn = upd.mock.calls.at(-1)![1] as TableDefinition;
			expect(defn.row_source).toMatchObject({ kind: 'navigation', navigation: {} });
		} finally {
			unmount(c);
		}
	});
});
