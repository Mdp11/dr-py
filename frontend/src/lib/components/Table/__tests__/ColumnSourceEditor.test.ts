// The shared column-source editor: kind select (Row / Earlier column),
// chain-step input for a `chains` row source, earlier-column select, and —
// only when the selected earlier column is itself a `navigation` column — a
// "Step to use" numeric input for ColumnRef.step_index. Mount-based, same
// convention as NavigationColumnEditor.test.ts / PropertyColumnEditor.test.ts.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import type { Column, ColumnSource, NavigationDefinition, RowSource } from '$lib/api/types';
import ColumnSourceEditor from '../ColumnSourceEditor.svelte';

// Exact literal from Task 3's navMaxStepIndex test (columns.test.ts): a
// 2-hop path (start + 2 relationship steps; a filter step doesn't advance
// the chain) → navMaxStepIndex === 2.
const TWO_HOP_PATH: NavigationDefinition = {
	kind: 'path',
	schema_version: 2,
	start: { kind: 'scope', types: [], criteria: [] },
	steps: [
		{
			kind: 'relationship',
			relationship_type: 'r',
			direction: 'out',
			target_types: [],
			children: []
		},
		{ kind: 'filter', criteria: [] },
		{
			kind: 'relationship',
			relationship_type: 's',
			direction: 'out',
			target_types: [],
			children: []
		}
	],
	exclude_visited: true
} as NavigationDefinition;

// A 1-hop path (start + 1 relationship step) → navMaxStepIndex === 1.
const ONE_HOP_PATH: NavigationDefinition = {
	kind: 'path',
	schema_version: 2,
	start: { kind: 'scope', types: [], criteria: [] },
	steps: [
		{
			kind: 'relationship',
			relationship_type: 'r',
			direction: 'out',
			target_types: [],
			children: []
		}
	],
	exclude_visited: true
} as NavigationDefinition;

function propColumn(): Column {
	return {
		kind: 'property',
		source: { kind: 'row', chain_index: 0 },
		name: 'p',
		mode: 'collapse',
		keep_empty: true,
		header: '',
		width_px: null,
		hidden: false
	};
}

function navColumn(navigation: Extract<Column, { kind: 'navigation' }>['navigation']): Column {
	return {
		kind: 'navigation',
		source: { kind: 'row', chain_index: 0 },
		navigation,
		step_index: null,
		mode: 'collapse',
		keep_empty: true,
		sort_mode: 'value',
		cell_cap: 20,
		header: '',
		width_px: null,
		hidden: false
	};
}

function render(props: {
	source: ColumnSource;
	columns: Column[];
	columnIndex: number;
	rowSource: RowSource | null;
	onSourceChange: (next: ColumnSource) => void;
}) {
	const c = mount(ColumnSourceEditor, { target: document.body, props });
	flushSync();
	return c;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('ColumnSourceEditor', () => {
	it('renders the kind select; Earlier column disabled when columnIndex === 0', () => {
		const c = render({
			source: { kind: 'row', chain_index: 0 },
			columns: [propColumn()],
			columnIndex: 0,
			rowSource: null,
			onSourceChange: vi.fn()
		});
		try {
			const select = document.querySelector(
				'select[aria-label="Column source kind"]'
			) as HTMLSelectElement;
			expect(select).not.toBeNull();
			const earlierOption = [...select.options].find((o) => o.value === 'column')!;
			expect(earlierOption.disabled).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('shows a step-index input (min 0, max 2, empty placeholder) for a prior inline navigation column', () => {
		const columns = [propColumn(), navColumn({ definition: TWO_HOP_PATH })];
		const c = render({
			source: { kind: 'column', index: 1 },
			columns,
			columnIndex: 2,
			rowSource: null,
			onSourceChange: vi.fn()
		});
		try {
			const input = document.querySelector(
				'input[data-testid="source-step-index"]'
			) as HTMLInputElement;
			expect(input).not.toBeNull();
			expect(input.min).toBe('0');
			expect(input.max).toBe('2');
			expect(input.placeholder).toBe("column's step");
			expect(input.value).toBe('');
		} finally {
			unmount(c);
		}
	});

	it('typing 5 clamps to step_index 2 (max); clearing sets step_index null', () => {
		const columns = [propColumn(), navColumn({ definition: TWO_HOP_PATH })];
		const onSourceChange = vi.fn();
		const c = render({
			source: { kind: 'column', index: 1 },
			columns,
			columnIndex: 2,
			rowSource: null,
			onSourceChange
		});
		try {
			const input = document.querySelector(
				'input[data-testid="source-step-index"]'
			) as HTMLInputElement;
			input.value = '5';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			expect(onSourceChange).toHaveBeenCalledWith({ kind: 'column', index: 1, step_index: 2 });

			input.value = '';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			expect(onSourceChange).toHaveBeenCalledWith({ kind: 'column', index: 1, step_index: null });
		} finally {
			unmount(c);
		}
	});

	it('no step input when the referenced prior column is a property column', () => {
		const columns = [propColumn(), propColumn()];
		const c = render({
			source: { kind: 'column', index: 1 },
			columns,
			columnIndex: 2,
			rowSource: null,
			onSourceChange: vi.fn()
		});
		try {
			expect(document.querySelector('input[data-testid="source-step-index"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('selecting a different earlier column resets step_index to null', () => {
		const columns = [propColumn(), navColumn({ definition: TWO_HOP_PATH })];
		const onSourceChange = vi.fn();
		const c = render({
			source: { kind: 'column', index: 1, step_index: 1 },
			columns,
			columnIndex: 2,
			rowSource: null,
			onSourceChange
		});
		try {
			const select = document.querySelector(
				'select[aria-label="Source column"]'
			) as HTMLSelectElement;
			select.value = '0';
			select.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			expect(onSourceChange).toHaveBeenCalledWith({ kind: 'column', index: 0, step_index: null });
		} finally {
			unmount(c);
		}
	});

	it('a saved-ref navigation fetches its max step via api.getArtifact', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'nav1',
			kind: 'navigation',
			name: 'Saved',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			entry_points: null,
			payload: ONE_HOP_PATH as unknown as Record<string, unknown>
		});
		const columns = [propColumn(), navColumn({ ref: 'nav1' })];
		const c = render({
			source: { kind: 'column', index: 1 },
			columns,
			columnIndex: 2,
			rowSource: null,
			onSourceChange: vi.fn()
		});
		try {
			await vi.waitFor(() => {
				const input = document.querySelector(
					'input[data-testid="source-step-index"]'
				) as HTMLInputElement;
				expect(input.max).toBe('1');
			});
		} finally {
			unmount(c);
		}
	});
});
