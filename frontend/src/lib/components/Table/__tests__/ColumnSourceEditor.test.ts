// The shared column-source editor: kind select (Row / Earlier column),
// chain-step picker for a `chains` row source, earlier-column select, and —
// only when the selected earlier column is itself a `navigation` column — a
// "Step to use" picker for ColumnRef.step_index. Both step fields are
// ChainStepSelects listing the steps by the numbers the navigation editor
// badges (0 = the start), degrading to a numeric input while the referenced
// chain is unknown. Mount-based, same convention as
// NavigationColumnEditor.test.ts / PropertyColumnEditor.test.ts.
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

function optionLabels(testId: string): string[] {
	const select = document.querySelector(`select[data-testid="${testId}"]`) as HTMLSelectElement;
	if (!select) throw new Error(`${testId} select not found`);
	return [...select.options].map((o) => o.textContent?.trim() ?? '');
}

function pick(testId: string, value: string): void {
	const select = document.querySelector(`select[data-testid="${testId}"]`) as HTMLSelectElement;
	select.value = value;
	select.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
}

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

	it("lists the prior inline navigation's steps, with column's step as the empty choice", () => {
		const columns = [propColumn(), navColumn({ definition: TWO_HOP_PATH })];
		const c = render({
			source: { kind: 'column', index: 1 },
			columns,
			columnIndex: 2,
			rowSource: null,
			onSourceChange: vi.fn()
		});
		try {
			// The filter step advances nothing, so it gets no number — exactly as
			// in the editor rail.
			expect(optionLabels('source-step-index')).toEqual([
				"column's step",
				'0: Start',
				'1: r',
				'2: s'
			]);
			const select = document.querySelector(
				'select[data-testid="source-step-index"]'
			) as HTMLSelectElement;
			expect(select.value).toBe(''); // step_index null
		} finally {
			unmount(c);
		}
	});

	it("picking a step emits its index; picking column's step emits null", () => {
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
			pick('source-step-index', '2');
			expect(onSourceChange).toHaveBeenCalledWith({ kind: 'column', index: 1, step_index: 2 });

			pick('source-step-index', '');
			expect(onSourceChange).toHaveBeenCalledWith({ kind: 'column', index: 1, step_index: null });
		} finally {
			unmount(c);
		}
	});

	it('degrades to a numeric input while the referenced chain is unknown', () => {
		const columns = [propColumn(), navColumn({})]; // navigation neither inline nor ref
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
			expect(input).not.toBeNull();
			expect(input.min).toBe('0');
			expect(input.placeholder).toBe("column's step");
			input.value = '5';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			expect(onSourceChange).toHaveBeenCalledWith({ kind: 'column', index: 1, step_index: 5 });
		} finally {
			unmount(c);
		}
	});

	it('re-clamps a stored step_index the referenced chain no longer has', () => {
		const columns = [propColumn(), navColumn({ definition: ONE_HOP_PATH })];
		const onSourceChange = vi.fn();
		const c = render({
			source: { kind: 'column', index: 1, step_index: 5 },
			columns,
			columnIndex: 2,
			rowSource: null,
			onSourceChange
		});
		try {
			expect(onSourceChange).toHaveBeenCalledWith({ kind: 'column', index: 1, step_index: 1 });
			// onSourceChange is a spy, so the prop keeps 5: the orphan option keeps
			// the select honest until the parent applies the clamp.
			expect(optionLabels('source-step-index')).toContain('5: (no such step)');
		} finally {
			unmount(c);
		}
	});

	it("lists the ROW SOURCE's chain steps in the chain-step field (no empty choice)", () => {
		const onSourceChange = vi.fn();
		const c = render({
			source: { kind: 'row', chain_index: 0 },
			columns: [propColumn()],
			columnIndex: 1,
			rowSource: { kind: 'chains', navigation: { definition: ONE_HOP_PATH } },
			onSourceChange
		});
		try {
			expect(optionLabels('source-chain-index')).toEqual(['0: Start', '1: r']);
			pick('source-chain-index', '1');
			expect(onSourceChange).toHaveBeenCalledWith({ kind: 'row', chain_index: 1 });
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
			expect(document.querySelector('[data-testid="source-step-index"]')).toBeNull();
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

	it('a saved-ref navigation fetches its steps via api.getArtifact', async () => {
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
			await vi.waitFor(() =>
				expect(optionLabels('source-step-index')).toEqual(["column's step", '0: Start', '1: r'])
			);
		} finally {
			unmount(c);
		}
	});
});
