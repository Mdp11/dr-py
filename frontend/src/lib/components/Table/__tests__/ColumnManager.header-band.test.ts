// The column card's identity row (kind badge + name input + actions) is a
// distinct header BAND, not a flat first line: with a script or navigation
// editor expanded below it, a flat row left the column's identity impossible
// to find. Structural assertions only — the exact tint is not unit-tested.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as tablesApi from '$lib/api/tables';
import * as artifactsApi from '$lib/api/artifacts';
import {
	ensureTableDraft,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	resetSnippetCollapse,
	resetTableEditors,
	setProjectInfo,
	updateTableDefinition
} from '$lib/state';
import type { Column, TableDefinition } from '$lib/api/types';
import ColumnManager from '../ColumnManager.svelte';

const TAB = 'tbl:draft:header-band';

const EMPTY_PAGE = {
	columns: [],
	rows: [],
	total: 0,
	truncated: false,
	offset: 0,
	model_rev: 1,
	warnings: []
};

function propertyColumn(header: string): Column {
	return {
		kind: 'property',
		source: { kind: 'row', chain_index: 0 },
		name: 'name',
		mode: 'collapse',
		keep_empty: true,
		header,
		width_px: null,
		hidden: false
	} as Column;
}

async function seed(columns: Column[]): Promise<void> {
	await ensureTableDraft(TAB);
	const defn: TableDefinition = {
		schema_version: 1,
		default_cell_mode: 'collapse',
		show_row_numbers: false,
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns
	};
	updateTableDefinition(TAB, defn);
	flushSync();
}

beforeEach(() => {
	resetTableEditors();
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	resetSnippetCollapse();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue({
		step_types: [],
		chains: [],
		total: 0,
		truncated: false,
		warnings: []
	});
});
afterEach(() => {
	resetTableEditors();
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	resetSnippetCollapse();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

it('puts the kind badge and the name input inside a header band', async () => {
	await seed([propertyColumn('Owner')]);
	const c = mount(ColumnManager, { target: document.body, props: { tabId: TAB } });
	flushSync();
	try {
		const band = document.querySelector('[data-testid="column-header-band-0"]');
		expect(band).not.toBeNull();
		expect(band?.textContent).toContain('Property');
		const input = band?.querySelector('input') as HTMLInputElement;
		expect(input.value).toBe('Owner');
		// The band is a visually distinct strip, not a bare flex row.
		expect(band?.className).toContain('border-b');
	} finally {
		unmount(c);
	}
});

it('tints the kind badge per column kind', async () => {
	await seed([propertyColumn('Owner')]);
	const c = mount(ColumnManager, { target: document.body, props: { tabId: TAB } });
	flushSync();
	try {
		const badge = [...document.querySelectorAll('[data-testid="column-header-band-0"] span')].find(
			(s) => s.textContent?.trim() === 'Property'
		);
		expect(badge?.className).toContain('text-info');
	} finally {
		unmount(c);
	}
});
