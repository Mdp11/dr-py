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
import { newNavigationColumn, newScriptColumn } from '$lib/table/columns';
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

function elementColumn(header: string): Column {
	return {
		kind: 'element',
		source: { kind: 'row', chain_index: 0 },
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
		export_order: [],
		display_order: [],
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

// The column card must never carry `overflow-hidden`: it would turn the card
// into a clipping context that swallows every popup rendered inside it
// (PropertyColumnEditor's suggestion list, CodeMirror's completion/hover/lint
// tooltips). A CSS clip is invisible to happy-dom (no real layout/paint), so
// this asserts at the class level instead — the honest guard given the
// tooling, paired with the why-comment on the card in ColumnManager.svelte.
it('does not clip the column card (no overflow-hidden), so descendant popups can escape it', async () => {
	await seed([propertyColumn('Owner')]);
	const c = mount(ColumnManager, { target: document.body, props: { tabId: TAB } });
	flushSync();
	try {
		const card = document.querySelector('[data-col-drop="0"]');
		expect(card).not.toBeNull();
		expect(card?.className.split(/\s+/)).not.toContain('overflow-hidden');
		// The band still carries its own top rounding, so the tint stays flush
		// with the card's rounded corners without the card itself clipping.
		const band = document.querySelector('[data-testid="column-header-band-0"]');
		expect(band?.className).toContain('rounded-t');
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

// A single property-column fixture alone cannot catch kindBadgeClass
// collapsing every kind to the same tint (e.g. always returning 'text-info')
// — it would still pass the test above. Seed all four kinds and assert each
// gets its OWN tint class, distinct from every other kind's, which is the
// entire point of the badge.
it('gives each column kind its own, mutually distinct badge tint', async () => {
	await seed([
		elementColumn('Block'),
		propertyColumn('Owner'),
		newNavigationColumn(),
		newScriptColumn()
	]);
	const c = mount(ColumnManager, { target: document.body, props: { tabId: TAB } });
	flushSync();
	try {
		// Labels are `columnKindLabel`'s output, not the raw `kind` string —
		// element columns render as "Scope".
		const expected: Record<number, string> = {
			0: 'Scope',
			1: 'Property',
			2: 'Navigation',
			3: 'Script'
		};
		const tintOf: Record<number, string> = {};
		for (const [i, label] of Object.entries(expected)) {
			const band = document.querySelector(`[data-testid="column-header-band-${i}"]`);
			const badge = [...(band?.querySelectorAll('span') ?? [])].find(
				(s) => s.textContent?.trim() === label
			);
			expect(badge, `${label} badge`).toBeTruthy();
			// `text-[10px]` (the badge's font-size utility) also starts with
			// "text-", so pick out the COLOUR class specifically rather than
			// the first "text-"-prefixed token.
			const tintClass = badge?.className
				.split(/\s+/)
				.find((cls) => cls.startsWith('text-') && cls !== 'text-[10px]');
			expect(tintClass, `${label} tint class`).toBeTruthy();
			tintOf[Number(i)] = tintClass!;
		}
		const tints = Object.values(tintOf);
		expect(new Set(tints).size).toBe(tints.length);
	} finally {
		unmount(c);
	}
});
