// The "Return elements from step" field shared by NavigationColumnEditor and
// RowSourceEditor: a ChainStepSelect listing the navigation's steps by the
// numbers the editor rail badges (0 = the start), sourced either from an
// inline definition or (for a saved ref) a fetched artifact payload, plus the
// "End of chain" empty choice. Backend ground truth:
// core/table/evaluate.py::_check_step_index accepts 0..chain_len-1, so the
// last option is chainColumns(path).length - 1; a set_op definition is a
// single-element chain -> one option (0). With NO definition known the field
// degrades to a free numeric input.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as tableStore from '$lib/state/table-editor.svelte';
import { resetArtifacts, resetCheckout, resetNavigationEditors, setProjectInfo } from '$lib/state';
import type { Column, NavigationDefinition, TableDefinition } from '$lib/api/types';
import NavigationColumnEditor from '../NavigationColumnEditor.svelte';
import RowSourceEditor from '../RowSourceEditor.svelte';

type NavColumn = Extract<Column, { kind: 'navigation' }>;

const CHAIN_PAGE = { step_types: [], chains: [], total: 0, truncated: false, warnings: [] };

// An inline path with 2 chain-advancing steps: chainColumns = [Start, s1, s2]
// -> maxStepIndex = 2.
const TWO_STEP_PATH: NavigationDefinition = {
	kind: 'path',
	schema_version: 2,
	start: { kind: 'row' },
	steps: [
		{
			kind: 'relationship',
			relationship_type: 'Contains',
			direction: 'out',
			target_types: [],
			children: []
		},
		{
			kind: 'relationship',
			relationship_type: 'Owns',
			direction: 'out',
			target_types: [],
			children: []
		}
	],
	exclude_visited: true
};

// A single-step path: chainColumns = [Start, s1] -> maxStepIndex = 1.
const ONE_STEP_PATH: NavigationDefinition = {
	kind: 'path',
	schema_version: 2,
	start: { kind: 'scope', types: [], criteria: [] },
	steps: [
		{
			kind: 'relationship',
			relationship_type: 'Contains',
			direction: 'out',
			target_types: [],
			children: []
		}
	],
	exclude_visited: true
};

const SET_OP: NavigationDefinition = {
	kind: 'set_op',
	schema_version: 2,
	op: 'union',
	operands: [
		{ definition: ONE_STEP_PATH, step_index: null },
		{ definition: ONE_STEP_PATH, step_index: null }
	]
};

function navColumn(
	navigation: NavColumn['navigation'],
	stepIndex: number | null = null
): NavColumn {
	return {
		kind: 'navigation',
		source: { kind: 'row', chain_index: 0 },
		navigation,
		step_index: stepIndex,
		mode: 'collapse',
		keep_empty: true,
		sort_mode: 'value',
		cell_cap: 20,
		header: '',
		width_px: null,
		hidden: false
	};
}

const STEP_FIELD = '[aria-label="Return elements from step"]';

/** The picker, once a definition is known. */
function stepSelect(): HTMLSelectElement {
	const el = document.querySelector(`select${STEP_FIELD}`);
	if (!el) throw new Error('step-index select not found');
	return el as HTMLSelectElement;
}

/** The numeric fallback shown while the chain is unknown. */
function stepFallback(): HTMLInputElement {
	const el = document.querySelector(`input${STEP_FIELD}`);
	if (!el) throw new Error('step-index fallback input not found');
	return el as HTMLInputElement;
}

function stepOptionLabels(): string[] {
	return [...stepSelect().options].map((o) => o.textContent?.trim() ?? '');
}

function pick(select: HTMLSelectElement, value: string): void {
	select.value = value;
	select.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
}

function typeValue(input: HTMLInputElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('NavigationColumnEditor step-index field', () => {
	function render(column: NavColumn, onChange: (next: NavColumn) => void) {
		const c = mount(NavigationColumnEditor, {
			target: document.body,
			props: { column, columnIndex: 1, columns: [column], sampleRowElementId: 'row-el-1', onChange }
		});
		flushSync();
		return c;
	}

	it('degrades to the numeric fallback (label, End of chain placeholder, min 0) with no navigation selected', () => {
		const c = render(navColumn({}), vi.fn());
		try {
			const input = stepFallback();
			expect(input.closest('label')?.textContent?.trim()).toBe('Return elements from step');
			expect(input.min).toBe('0');
			expect(input.placeholder).toBe('End of chain');
			expect(document.querySelector(`select${STEP_FIELD}`)).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('the numeric fallback still emits what you type while the chain is unknown', () => {
		const onChange = vi.fn();
		const c = render(navColumn({}), onChange);
		try {
			typeValue(stepFallback(), '3');
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ step_index: 3 }));
		} finally {
			unmount(c);
		}
	});

	it('lists the chain steps of an inline definition, badge numbering and all (2 steps -> 0..2)', () => {
		const c = render(navColumn({ definition: TWO_STEP_PATH }), vi.fn());
		try {
			expect(stepOptionLabels()).toEqual([
				'End of chain',
				'0: Start (row element)',
				'1: Contains',
				'2: Owns'
			]);
			expect(stepSelect().value).toBe(''); // step_index null
		} finally {
			unmount(c);
		}
	});

	it('offers only step 0 for a set_op definition (single-element chain)', () => {
		const c = render(navColumn({ definition: SET_OP }), vi.fn());
		try {
			expect(stepOptionLabels()).toEqual(['End of chain', '0: Combined elements']);
		} finally {
			unmount(c);
		}
	});

	it('picking a step emits its index', () => {
		const onChange = vi.fn();
		const c = render(navColumn({ definition: TWO_STEP_PATH }), onChange);
		try {
			pick(stepSelect(), '2');
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ step_index: 2 }));
		} finally {
			unmount(c);
		}
	});

	it('picking End of chain emits null', () => {
		const onChange = vi.fn();
		const c = render(navColumn({ definition: TWO_STEP_PATH }, 1), onChange);
		try {
			expect(stepSelect().value).toBe('1');
			pick(stepSelect(), '');
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ step_index: null }));
		} finally {
			unmount(c);
		}
	});

	it('fills the options from a saved-ref navigation once the fetched artifact resolves', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'navigation',
			name: 'Saved',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			entry_points: null,
			payload: ONE_STEP_PATH as unknown as Record<string, unknown>
		});
		const c = render(navColumn({ ref: 'a1' }), vi.fn());
		try {
			await vi.waitFor(() =>
				expect(stepOptionLabels()).toEqual(['End of chain', '0: Start', '1: Contains'])
			);
		} finally {
			unmount(c);
		}
	});

	it('re-clamps a stored step_index that exceeds the rendered chain length, showing it meanwhile', () => {
		const onChange = vi.fn();
		// step_index 5 stored, but this definition's chain only supports 0..1
		// (e.g. after a reorder swapped in a shorter definition, or an edit
		// removed steps) -> the mount-time re-clamp effect must fire. onChange is
		// a spy here, so the prop keeps 5 and the orphan option stays rendered.
		const c = render(navColumn({ definition: ONE_STEP_PATH }, 5), onChange);
		try {
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
			expect(stepOptionLabels()).toContain('5: (no such step)');
			expect(stepSelect().value).toBe('5');
		} finally {
			unmount(c);
		}
	});
});

describe('RowSourceEditor step-index field', () => {
	function defnWith(rowSource: TableDefinition['row_source']): TableDefinition {
		return {
			schema_version: 1,
			default_cell_mode: 'collapse',
			show_row_numbers: false,
			export_order: [],
			display_order: [],
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

	it('degrades to the numeric fallback (label, End of chain placeholder, min 0) with no navigation selected', () => {
		const c = render(defnWith({ kind: 'navigation', navigation: {}, step_index: null }));
		try {
			const input = stepFallback();
			expect(input.closest('label')?.textContent?.trim()).toBe('Return elements from step');
			expect(input.min).toBe('0');
			expect(input.placeholder).toBe('End of chain');
			expect(document.querySelector(`select${STEP_FIELD}`)).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('lists the chain steps of an inline definition, badge numbering and all (2 steps -> 0..2)', () => {
		const c = render(
			defnWith({
				kind: 'navigation',
				navigation: { definition: TWO_STEP_PATH },
				step_index: null
			})
		);
		try {
			expect(stepOptionLabels()).toEqual([
				'End of chain',
				'0: Start (row element)',
				'1: Contains',
				'2: Owns'
			]);
		} finally {
			unmount(c);
		}
	});

	it('picking a step emits its index', () => {
		const upd = vi.spyOn(tableStore, 'updateTableDefinition').mockImplementation(() => {});
		const c = render(
			defnWith({
				kind: 'navigation',
				navigation: { definition: TWO_STEP_PATH },
				step_index: null
			})
		);
		try {
			pick(stepSelect(), '2');
			const defn = upd.mock.calls.at(-1)![1] as TableDefinition;
			expect(defn.row_source).toMatchObject({ step_index: 2 });
		} finally {
			unmount(c);
		}
	});

	it('picking End of chain emits null', () => {
		const upd = vi.spyOn(tableStore, 'updateTableDefinition').mockImplementation(() => {});
		const c = render(
			defnWith({ kind: 'navigation', navigation: { definition: TWO_STEP_PATH }, step_index: 1 })
		);
		try {
			pick(stepSelect(), '');
			const defn = upd.mock.calls.at(-1)![1] as TableDefinition;
			expect(defn.row_source).toMatchObject({ step_index: null });
		} finally {
			unmount(c);
		}
	});

	it('fills the options from a saved-ref navigation once the fetched artifact resolves', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'navigation',
			name: 'Saved',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			entry_points: null,
			payload: ONE_STEP_PATH as unknown as Record<string, unknown>
		});
		const c = render(defnWith({ kind: 'navigation', navigation: { ref: 'a1' }, step_index: null }));
		try {
			await vi.waitFor(() =>
				expect(stepOptionLabels()).toEqual(['End of chain', '0: Start', '1: Contains'])
			);
		} finally {
			unmount(c);
		}
	});

	it('re-clamps a stored step_index that exceeds the rendered chain length', () => {
		const upd = vi.spyOn(tableStore, 'updateTableDefinition').mockImplementation(() => {});
		const c = render(
			defnWith({ kind: 'navigation', navigation: { definition: ONE_STEP_PATH }, step_index: 5 })
		);
		try {
			flushSync();
			const defn = upd.mock.calls.at(-1)![1] as TableDefinition;
			expect(defn.row_source).toMatchObject({ step_index: 1 });
		} finally {
			unmount(c);
		}
	});
});
