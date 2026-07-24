// Regression for the saved <-> inline toggle corrupting the table definition
// with a Svelte $state PROXY. NavigationColumnEditor keeps the parked inline
// definition in `lastInline` while the column is in ref mode; when that was a
// deep `$state`, reading it back on the next switch-to-inline returned a
// PROXY, which got seeded into the embedded draft and mirrored into the table
// definition — after which every structuredClone-based edit of the table
// threw DataCloneError ("#<Object> could not be cloned") forever. Like
// ColumnManager.reorder.test.ts this drives the REAL table + navigation
// stores: the bug only manifests when the emitted column round-trips through
// updateTableDefinition back into the same editor instance's props.
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

const TAB = 'tbl:draft:inline-toggle-regression';

const EMPTY_PAGE = {
	columns: [],
	rows: [],
	total: 0,
	truncated: false,
	offset: 0,
	model_rev: 1,
	warnings: []
};
const CHAIN_PAGE = { step_types: [], chains: [], total: 0, truncated: false, warnings: [] };

const INLINE: NavigationDefinition = {
	kind: 'path',
	schema_version: 2,
	start: { kind: 'row' },
	steps: [],
	exclude_visited: true
};

function navColumn(navigation: NavColumn['navigation']): NavColumn {
	return {
		kind: 'navigation',
		source: { kind: 'row', chain_index: 0 },
		navigation,
		step_index: null,
		mode: 'collapse',
		keep_empty: true,
		sort_mode: 'value',
		cell_cap: 20,
		header: 'Nav',
		width_px: null,
		hidden: false
	};
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

describe('ColumnManager saved <-> inline toggle', () => {
	it('keeps the definition plain (cloneable) and editable after inline -> saved -> inline', async () => {
		await seed([navColumn({ definition: INLINE })]);
		const c = mount(ColumnManager, { target: document.body, props: { tabId: TAB } });
		flushSync();
		try {
			await vi.waitFor(() =>
				expect(document.querySelector('[data-testid="inline-nav-editor"]')).toBeTruthy()
			);

			// inline -> saved parks the definition in the editor's lastInline slot…
			click('[data-testid="nav-mode-ref"]');
			await vi.waitFor(() => {
				const col = getTableDraft(TAB)!.definition.columns[0] as NavColumn;
				expect(col.navigation.definition ?? null).toBeNull();
			});

			// …and saved -> inline re-seeds FROM that slot, round-tripping it into
			// the table definition.
			click('[data-testid="nav-mode-inline"]');
			await vi.waitFor(() => {
				const col = getTableDraft(TAB)!.definition.columns[0] as NavColumn;
				expect(col.navigation.definition).toMatchObject({ kind: 'path', start: { kind: 'row' } });
			});

			// The definition must have stayed a PLAIN object: a leaked $state
			// proxy would make this (and thus every later edit) throw
			// DataCloneError.
			expect(() => structuredClone(getTableDraft(TAB)!.definition)).not.toThrow();

			// And a follow-up edit through the panel still works. Renames commit on
			// `input`, undebounced — the settings dialog stages evaluation, so a
			// per-keystroke apply costs a draft object and nothing else.
			const rename = document.querySelector(
				'[data-testid="column-manager"] input[placeholder]'
			) as HTMLInputElement;
			rename.value = 'Renamed';
			rename.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			expect(getTableDraft(TAB)!.definition.columns[0].header).toBe('Renamed');
		} finally {
			unmount(c);
		}
	});
});
