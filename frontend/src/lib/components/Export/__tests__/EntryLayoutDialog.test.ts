// Render tests for the per-entry layout dialog. Mirrors
// `Table/__tests__/ExportDialog.test.ts`'s mount/unmount/flushSync
// convention. This dialog holds a LOCAL working copy (`effective`), never
// writing through `$lib/state` — so unlike ExportDialog's tests, nothing
// here drives a store; every assertion reads the mounted DOM and the
// `onSave` spy's call args directly.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as tablesApi from '$lib/api/tables';
import type { ExporterEntry, TableDefinition } from '$lib/api/types';
import EntryLayoutDialog from '../EntryLayoutDialog.svelte';

function baseDefinition(): TableDefinition {
	return {
		schema_version: 1,
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns: [
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'name',
				mode: 'collapse',
				keep_empty: true,
				header: 'Name',
				hidden: false
			},
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'mass',
				mode: 'collapse',
				keep_empty: true,
				header: 'Mass',
				hidden: false
			}
		],
		default_cell_mode: 'collapse',
		show_row_numbers: false,
		export_order: []
	} as TableDefinition;
}

function entryOverridingColumn1(): ExporterEntry {
	return {
		source: { ref: 'tbl-1' },
		name: 'My entry',
		format: 'xlsx',
		folder: '',
		columns: [{ index: 1, export: { include: false, header: '' }, json_export: null }],
		export_order: [],
		show_row_numbers: false,
		export_row_number: null,
		json_split: null
	};
}

let mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => {
	vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
});

afterEach(() => {
	for (const m of mounted) unmount(m);
	mounted = [];
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

function render(props: {
	tableDefinition: TableDefinition;
	entry: ExporterEntry;
	onSave: (patch: Partial<ExporterEntry>) => void;
	onClose: () => void;
}): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const component = mount(EntryLayoutDialog, { target, props: { open: true, ...props } });
	mounted.push(component);
	flushSync();
	return target;
}

/** The export-list position of a definition column index — the panel's
 *  testids are keyed by output POSITION, not definition index (see
 *  ExportSettingsPanel), and with no reorder the two coincide for a
 *  two-column, no-row-number definition. */
function posOf(index: number): number {
	return index;
}

describe('EntryLayoutDialog', () => {
	it('reflects the EFFECTIVE definition: an override wins over the table default', () => {
		render({
			tableDefinition: baseDefinition(),
			entry: entryOverridingColumn1(),
			onSave: () => {},
			onClose: () => {}
		});
		// The table itself has column 1 included (not hidden, no export options) —
		// only the entry's override excludes it.
		const include = document.querySelector<HTMLButtonElement>(
			`[data-testid="export-include-${posOf(1)}"]`
		)!;
		expect(include).not.toBeNull();
		expect(include.getAttribute('aria-label')).toBe('Include in export');
	});

	it('Save emits {format, ...overridesFromDefinition(editedCopy)} — toggling both the format and the include state', () => {
		const onSave = vi.fn();
		render({
			tableDefinition: baseDefinition(),
			entry: entryOverridingColumn1(),
			onSave,
			onClose: () => {}
		});
		// Exercise the format toggle too — a hard-coded 'xlsx' in the emitted
		// patch would otherwise pass unnoticed, since the entry's own starting
		// format ('xlsx') matches it by coincidence.
		document.querySelector<HTMLButtonElement>('[data-testid="entry-layout-format-json"]')!.click();
		document
			.querySelector<HTMLButtonElement>(`[data-testid="export-include-${posOf(1)}"]`)!
			.click();
		flushSync();
		document.querySelector<HTMLButtonElement>('[data-testid="entry-layout-save"]')!.click();
		flushSync();

		expect(onSave).toHaveBeenCalledTimes(1);
		const patch = onSave.mock.calls[0][0] as Partial<ExporterEntry>;
		expect(patch.format).toBe('json');
		// Positive form: column 1's override now says INCLUDED (true), not
		// merely "not excluded" — `.some(... include === false)` toBe(false)
		// would also pass if overridesFromDefinition had been handed the
		// UNEDITED `tableDefinition` (columns: [], no override at all).
		expect(patch.columns).toEqual([
			{ index: 1, export: { include: true, header: '' }, json_export: null }
		]);
	});

	it('warns under a tokenless json_split template and clears once ${name} is typed, without ever disabling Save', async () => {
		const entry: ExporterEntry = {
			source: { ref: 'tbl-1' },
			name: 'Split entry',
			format: 'json',
			folder: '',
			columns: [],
			export_order: [],
			show_row_numbers: false,
			export_row_number: null,
			json_split: { enabled: true, filename_template: 'static' }
		};
		render({ tableDefinition: baseDefinition(), entry, onSave: () => {}, onClose: () => {} });

		const save = document.querySelector<HTMLButtonElement>('[data-testid="entry-layout-save"]')!;
		expect(save.disabled).toBe(false);
		expect(document.querySelector('[data-testid="entry-split-template-warning"]')).not.toBeNull();

		const template = document.querySelector<HTMLInputElement>(
			'[data-testid="json-split-template"]'
		)!;
		template.value = 'DataFor${name}';
		template.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		expect(save.disabled).toBe(false);
		expect(document.querySelector('[data-testid="entry-split-template-warning"]')).toBeNull();
	});

	it('saves even while the split filename template is invalid', () => {
		const onSave = vi.fn();
		const entry: ExporterEntry = {
			source: { ref: 'tbl-1' },
			name: 'Split entry',
			format: 'json',
			folder: '',
			columns: [],
			export_order: [],
			show_row_numbers: false,
			export_row_number: null,
			json_split: { enabled: true, filename_template: 'static' }
		};
		render({ tableDefinition: baseDefinition(), entry, onSave, onClose: () => {} });

		expect(document.querySelector('[data-testid="entry-split-template-warning"]')).not.toBeNull();
		const save = document.querySelector<HTMLButtonElement>('[data-testid="entry-layout-save"]')!;
		expect(save.disabled).toBe(false);
		save.click();
		flushSync();

		// The invalid template is PERSISTED (never-block-Save): the patch
		// carries json_split with the tokenless template.
		expect(onSave).toHaveBeenCalledTimes(1);
		const patch = onSave.mock.calls[0][0] as Partial<ExporterEntry>;
		expect(patch.json_split?.filename_template).not.toContain('${name}');
	});

	it('shows no split-template warning when the template is valid', () => {
		const entry: ExporterEntry = {
			source: { ref: 'tbl-1' },
			name: 'Split entry',
			format: 'json',
			folder: '',
			columns: [],
			export_order: [],
			show_row_numbers: false,
			export_row_number: null,
			json_split: { enabled: true, filename_template: 'DataFor${name}' }
		};
		render({ tableDefinition: baseDefinition(), entry, onSave: () => {}, onClose: () => {} });

		expect(document.querySelector('[data-testid="entry-split-template-warning"]')).toBeNull();
	});

	it('offers four formats and saves json_doc for the object shape', () => {
		const onSave = vi.fn();
		render({
			tableDefinition: baseDefinition(),
			entry: { ...entryOverridingColumn1(), format: 'json' },
			onSave,
			onClose: () => {}
		});

		for (const fmt of ['xlsx', 'json', 'csv', 'jsonl']) {
			expect(document.querySelector(`[data-testid="entry-layout-format-${fmt}"]`)).not.toBeNull();
		}

		document.querySelector<HTMLButtonElement>('[data-testid="entry-layout-format-jsonl"]')!.click();
		flushSync();
		document.querySelector<HTMLButtonElement>('[data-testid="entry-layout-format-json"]')!.click();
		flushSync();

		const shapeSelect = document.querySelector<HTMLSelectElement>(
			'[data-testid="entry-json-doc-shape"]'
		)!;
		shapeSelect.value = 'object';
		shapeSelect.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		const keyColumnSelect = document.querySelector<HTMLSelectElement>(
			'[data-testid="entry-json-doc-key-column"]'
		)!;
		keyColumnSelect.value = '0';
		keyColumnSelect.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		document.querySelector<HTMLButtonElement>('[data-testid="entry-layout-save"]')!.click();
		flushSync();

		expect(onSave).toHaveBeenCalledTimes(1);
		const patch = onSave.mock.calls[0][0] as Partial<ExporterEntry>;
		expect(patch.format).toBe('json');
		expect(patch.json_doc).toMatchObject({ shape: 'object', key_column: 0 });
	});

	it('shows only the on-error control for jsonl', () => {
		render({
			tableDefinition: baseDefinition(),
			entry: { ...entryOverridingColumn1(), format: 'json' },
			onSave: () => {},
			onClose: () => {}
		});

		document.querySelector<HTMLButtonElement>('[data-testid="entry-layout-format-jsonl"]')!.click();
		flushSync();

		expect(document.querySelector('[data-testid="entry-json-doc-shape"]')).toBeNull();
		expect(document.querySelector('[data-testid="entry-json-doc-on-error"]')).not.toBeNull();
	});
});
