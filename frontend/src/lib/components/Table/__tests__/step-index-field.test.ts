// The "Return elements from step" field shared by NavigationColumnEditor and
// RowSourceEditor: renamed label, "End of chain" placeholder, and a max bound
// derived from the navigation's actual chain length (chainColumns), sourced
// either from an inline definition or (for a saved ref) a fetched artifact
// payload. Backend ground truth: core/table/evaluate.py::_check_step_index
// accepts 0..chain_len-1, so maxStepIndex = chainColumns(path).length - 1; a
// set_op definition is a single-element chain -> max 0.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as tableStore from '$lib/state/table-editor.svelte';
import { resetArtifacts, resetCheckout, resetNavigationEditors, setProjectInfo } from '$lib/state';
import type { Column, NavigationDefinition, TableDefinition } from '$lib/api/types';
import NavigationColumnEditor from '../NavigationColumnEditor.svelte';
import RowSourceEditor from '../RowSourceEditor.svelte';

type NavColumn = Extract<Column, { kind: 'navigation' }>;

const CHAIN_PAGE = { step_types: [], chains: [], total: 0, truncated: false };

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

function stepInput(): HTMLInputElement {
	const input = document.querySelector('input[placeholder="End of chain"]');
	if (!input) throw new Error('step-index input not found');
	return input as HTMLInputElement;
}

function stepLabel(): string {
	return stepInput().closest('label')?.textContent?.trim() ?? '';
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

	it('renders the renamed label, End of chain placeholder, and min 0; unconstrained with no navigation selected', () => {
		const c = render(navColumn({}), vi.fn());
		try {
			expect(stepLabel()).toBe('Return elements from step');
			const input = stepInput();
			expect(input.min).toBe('0');
			expect(input.max).toBe('');
		} finally {
			unmount(c);
		}
	});

	it('constrains max to chainColumns(path).length - 1 for an inline definition (2 steps -> max 2)', () => {
		const c = render(navColumn({ definition: TWO_STEP_PATH }), vi.fn());
		try {
			expect(stepInput().max).toBe('2');
		} finally {
			unmount(c);
		}
	});

	it('constrains max to 0 for a set_op definition (single-element chain)', () => {
		const c = render(navColumn({ definition: SET_OP }), vi.fn());
		try {
			expect(stepInput().max).toBe('0');
		} finally {
			unmount(c);
		}
	});

	it('typing a value beyond max clamps the emitted step_index', () => {
		const onChange = vi.fn();
		const c = render(navColumn({ definition: TWO_STEP_PATH }), onChange);
		try {
			typeValue(stepInput(), '9');
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ step_index: 2 }));
		} finally {
			unmount(c);
		}
	});

	it('clearing the input emits null (end of chain)', () => {
		const onChange = vi.fn();
		const c = render(navColumn({ definition: TWO_STEP_PATH }, 1), onChange);
		try {
			typeValue(stepInput(), '');
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ step_index: null }));
		} finally {
			unmount(c);
		}
	});

	it('sizes max from a saved-ref navigation once the fetched artifact resolves', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'navigation',
			name: 'Saved',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			payload: ONE_STEP_PATH as unknown as Record<string, unknown>
		});
		const c = render(navColumn({ ref: 'a1' }), vi.fn());
		try {
			await vi.waitFor(() => expect(stepInput().max).toBe('1'));
		} finally {
			unmount(c);
		}
	});

	it('re-clamps a stored step_index that exceeds the rendered chain length', () => {
		const onChange = vi.fn();
		// step_index 5 stored, but this definition's chain only supports 0..1
		// (e.g. after a reorder swapped in a shorter definition, or an edit
		// removed steps) -> the mount-time re-clamp effect must fire.
		const c = render(navColumn({ definition: ONE_STEP_PATH }, 5), onChange);
		try {
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ step_index: 1 }));
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

	it('renders the renamed label, End of chain placeholder, and min 0; unconstrained with no navigation selected', () => {
		const c = render(defnWith({ kind: 'navigation', navigation: {}, step_index: null }));
		try {
			expect(stepLabel()).toBe('Return elements from step');
			const input = stepInput();
			expect(input.min).toBe('0');
			expect(input.max).toBe('');
		} finally {
			unmount(c);
		}
	});

	it('constrains max to chainColumns(path).length - 1 for an inline definition (2 steps -> max 2)', () => {
		const c = render(
			defnWith({
				kind: 'navigation',
				navigation: { definition: TWO_STEP_PATH },
				step_index: null
			})
		);
		try {
			expect(stepInput().max).toBe('2');
		} finally {
			unmount(c);
		}
	});

	it('typing a value beyond max clamps the emitted step_index', () => {
		const upd = vi.spyOn(tableStore, 'updateTableDefinition').mockImplementation(() => {});
		const c = render(
			defnWith({
				kind: 'navigation',
				navigation: { definition: TWO_STEP_PATH },
				step_index: null
			})
		);
		try {
			typeValue(stepInput(), '9');
			const defn = upd.mock.calls.at(-1)![1] as TableDefinition;
			expect(defn.row_source).toMatchObject({ step_index: 2 });
		} finally {
			unmount(c);
		}
	});

	it('clearing the input emits null (end of chain)', () => {
		const upd = vi.spyOn(tableStore, 'updateTableDefinition').mockImplementation(() => {});
		const c = render(
			defnWith({ kind: 'navigation', navigation: { definition: TWO_STEP_PATH }, step_index: 1 })
		);
		try {
			typeValue(stepInput(), '');
			const defn = upd.mock.calls.at(-1)![1] as TableDefinition;
			expect(defn.row_source).toMatchObject({ step_index: null });
		} finally {
			unmount(c);
		}
	});

	it('sizes max from a saved-ref navigation once the fetched artifact resolves', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'navigation',
			name: 'Saved',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			payload: ONE_STEP_PATH as unknown as Record<string, unknown>
		});
		const c = render(defnWith({ kind: 'navigation', navigation: { ref: 'a1' }, step_index: null }));
		try {
			await vi.waitFor(() => expect(stepInput().max).toBe('1'));
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
