// Regression test for Task 6: PathCard's expand/collapse disclosure must live
// in the navigation-editor store (not component-local $state), defaulting to
// COLLAPSED for embedded (table-settings) drafts so a settings dialog full of
// inline navigation builders is readable, and surviving whatever remount an
// unrelated structural edit (like adding a sibling column) triggers. Modeled
// on ColumnManager.reorder.test.ts: drives the REAL table + navigation stores
// end-to-end rather than mocking them.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as tablesApi from '$lib/api/tables';
import * as artifactsApi from '$lib/api/artifacts';
import {
	ensureTableDraft,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	resetTableEditors,
	setProjectInfo,
	updateTableDefinition
} from '$lib/state';
import type { Column, NavigationDefinition, TableDefinition } from '$lib/api/types';
import ColumnManager from '../ColumnManager.svelte';

type NavColumn = Extract<Column, { kind: 'navigation' }>;

const TAB = 'tbl:draft:collapse-regression';

const EMPTY_PAGE = {
	columns: [],
	rows: [],
	total: 0,
	truncated: false,
	offset: 0,
	model_rev: 1
};
const CHAIN_PAGE = { step_types: [], chains: [], total: 0, truncated: false };

function navDef(): NavigationDefinition {
	return {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'row' },
		steps: [],
		exclude_visited: true
	};
}

function navColumn(header: string): NavColumn {
	return {
		kind: 'navigation',
		source: { kind: 'row', chain_index: 0 },
		navigation: { definition: navDef() },
		step_index: null,
		mode: 'collapse',
		keep_empty: true,
		sort_mode: 'value',
		cell_cap: 20,
		header,
		width_px: null,
		hidden: false
	};
}

async function seed(columns: NavColumn[]): Promise<void> {
	await ensureTableDraft(TAB);
	const defn: TableDefinition = {
		schema_version: 1,
		default_cell_mode: 'collapse',
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns
	};
	updateTableDefinition(TAB, defn);
	flushSync();
}

function click(sel: string): void {
	const el = document.querySelector(sel);
	if (!el) throw new Error(`element not found: ${sel}`);
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

beforeEach(() => {
	resetTableEditors();
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
});
afterEach(() => {
	resetTableEditors();
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('ColumnManager PathCard collapse (durable across edits)', () => {
	it('a PathCard expanded by the user stays expanded when a column is added', async () => {
		await seed([navColumn('A')]);
		const root = document.body;
		const c = mount(ColumnManager, { target: root, props: { tabId: TAB } });
		flushSync();
		try {
			await vi.waitFor(() =>
				expect(root.querySelector('[data-testid="inline-nav-editor"]')).toBeTruthy()
			);

			const toggle = root.querySelector(
				'[data-testid="path-collapse-toggle"]'
			) as HTMLButtonElement;
			expect(toggle.getAttribute('aria-expanded')).toBe('false'); // default collapsed in table settings
			toggle.click();
			flushSync();
			expect(toggle.getAttribute('aria-expanded')).toBe('true');

			click('[data-testid="add-property-column"]');
			await Promise.resolve();
			flushSync();

			const t2 = root.querySelector('[data-testid="path-collapse-toggle"]') as HTMLButtonElement;
			expect(t2.getAttribute('aria-expanded')).toBe('true'); // state preserved
		} finally {
			unmount(c);
		}
	});
});
