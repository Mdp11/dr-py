// Regression tests for the CRITICAL reorder/remove corruption of INLINE
// navigation columns (whole-branch review blocker). ColumnManager keys its
// columns each-block by INDEX, so Svelte reuses NavigationColumnEditor
// instances by screen position on a reorder/remove rather than remounting
// them. Before the direction-aware mirror fix, a reused instance's stale
// embedded draft clobbered the definition of whatever column now sits at its
// position — scrambling header<->definition pairings (reorder) or dropping the
// survivor's own definition (remove-first).
//
// Unlike the sibling ColumnManager.test.ts (which spies the table-editor
// store), these drive the REAL table + navigation stores end-to-end: a real
// reorder must actually flow through updateTableDefinition and re-render the
// index-keyed each so the reused editors fire their mirror effect. That is the
// only surface where the bug manifests.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as tablesApi from '$lib/api/tables';
import * as artifactsApi from '$lib/api/artifacts';
import {
	ensureTableDraft,
	getTableDraft,
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

const TAB = 'tbl:draft:reorder-regression';

const EMPTY_PAGE = {
	columns: [],
	rows: [],
	total: 0,
	truncated: false,
	offset: 0,
	model_rev: 1
};
const CHAIN_PAGE = { step_types: [], chains: [], total: 0, truncated: false };

// Two DISTINCT inline definitions, told apart by `exclude_visited`. Both carry
// the flag (a boolean), so normalizeDefinition returns them by identity — the
// reseed path is reference-preserving, exactly as in production.
function navDef(exclude_visited: boolean): NavigationDefinition {
	return { kind: 'path', schema_version: 2, start: { kind: 'row' }, steps: [], exclude_visited };
}

function navColumn(header: string, definition: NavigationDefinition): NavColumn {
	return {
		kind: 'navigation',
		source: { kind: 'row', chain_index: 0 },
		navigation: { definition },
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

/** The surviving discriminator of a navigation column's definition. */
function excl(col: Column): boolean {
	if (col.kind !== 'navigation') throw new Error('expected a navigation column');
	const d = col.navigation.definition;
	if (!d || d.kind !== 'path') throw new Error('expected an inline path definition');
	return d.exclude_visited;
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

describe('ColumnManager inline-navigation reorder/remove', () => {
	it('reorder keeps each column paired with its OWN definition', async () => {
		await seed([navColumn('A', navDef(true)), navColumn('B', navDef(false))]);
		const c = mount(ColumnManager, { target: document.body, props: { tabId: TAB } });
		flushSync();
		try {
			// Both inline editors mounted their embedded drafts.
			await vi.waitFor(() =>
				expect(document.querySelectorAll('[data-testid="inline-nav-editor"]').length).toBe(2)
			);

			// Move column B (index 1) up to position 0.
			click('[data-testid="move-up-1"]');

			const cols = getTableDraft(TAB)!.definition.columns;
			expect(cols.map((col) => col.header)).toEqual(['B', 'A']);
			// The definitions must have travelled WITH their headers, not been
			// left behind by screen position.
			expect(excl(cols[0])).toBe(false); // B's own definition
			expect(excl(cols[1])).toBe(true); // A's own definition
		} finally {
			unmount(c);
		}
	});

	it('remove-first-of-two keeps the SURVIVOR own definition', async () => {
		await seed([navColumn('A', navDef(true)), navColumn('B', navDef(false))]);
		const c = mount(ColumnManager, { target: document.body, props: { tabId: TAB } });
		flushSync();
		try {
			await vi.waitFor(() =>
				expect(document.querySelectorAll('[data-testid="inline-nav-editor"]').length).toBe(2)
			);

			// Remove column A (index 0); B must survive intact.
			click('[data-testid="remove-column-0"]');

			const cols = getTableDraft(TAB)!.definition.columns;
			expect(cols).toHaveLength(1);
			expect(cols[0].header).toBe('B');
			expect(excl(cols[0])).toBe(false); // B's own definition, not A's (true)
		} finally {
			unmount(c);
		}
	});
});
