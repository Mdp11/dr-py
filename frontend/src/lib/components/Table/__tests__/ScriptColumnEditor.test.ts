// Render tests for the per-column editor of a `script`-kind column (Task
// F4). Follows the repo's Svelte-5 mount/flushSync/unmount convention (see
// Table/__tests__/ColumnManager.test.ts) rather than @testing-library/svelte
// (not a project dependency). The column starts in ref mode (`snippet: {}`)
// so SnippetSourceEditor never needs the `/snippets/lint` MSW handler — this
// test is scoped to ScriptColumnEditor's own wiring (source/snippet/mode/
// keep_empty), not SnippetSourceEditor's internals (covered by its own
// suite).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Column } from '$lib/api/types';
import ScriptColumnEditor from '../ScriptColumnEditor.svelte';

type ScriptColumn = Extract<Column, { kind: 'script' }>;

function scriptColumn(overrides: Partial<ScriptColumn> = {}): ScriptColumn {
	return {
		kind: 'script',
		source: { kind: 'row', chain_index: 0 },
		snippet: {},
		mode: 'collapse',
		keep_empty: true,
		header: '',
		width_px: null,
		hidden: false,
		...overrides
	};
}

function render(column: ScriptColumn, onChange: (next: ScriptColumn) => void) {
	const component = mount(ScriptColumnEditor, {
		target: document.body,
		props: {
			column,
			columnIndex: 1,
			columns: [
				{
					kind: 'element',
					source: { kind: 'row', chain_index: 0 },
					header: '',
					width_px: null,
					hidden: false
				},
				column
			],
			rowSource: { kind: 'scope', types: ['Block'], criteria: [] },
			onChange
		}
	});
	flushSync();
	return component;
}

function click(el: Element | null): void {
	if (!el) throw new Error('element not found');
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('ScriptColumnEditor', () => {
	it('renders the source editor and the snippet source editor', () => {
		const c = render(scriptColumn(), vi.fn());
		try {
			expect(document.querySelector('[data-testid="script-column-editor"]')).not.toBeNull();
			expect(document.querySelector('[aria-label="Column source kind"]')).not.toBeNull();
			expect(document.querySelector('[data-testid="snippet-source-editor"]')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('wires the snippet editor onChange to a whole-column patch, preserving other fields', () => {
		const onChange = vi.fn();
		const original = scriptColumn();
		const c = render(original, onChange);
		try {
			click(document.querySelector('[data-testid="snippet-mode-inline"]'));
			expect(onChange).toHaveBeenCalledTimes(1);
			const next = onChange.mock.calls[0][0] as ScriptColumn;
			expect(next).not.toBe(original);
			expect(next.snippet.definition).toBeDefined();
			expect(next.mode).toBe(original.mode);
			expect(next.keep_empty).toBe(original.keep_empty);
			expect(next.source).toBe(original.source);
			// original is untouched
			expect(original.snippet).toEqual({});
		} finally {
			unmount(c);
		}
	});

	it('toggling split emits a whole-column patch with mode flipped, leaving the original untouched', () => {
		const onChange = vi.fn();
		const original = scriptColumn({ mode: 'collapse' });
		const c = render(original, onChange);
		try {
			const checkbox = document.querySelector(
				'[aria-label="Split multiple values in multiple rows"]'
			) as HTMLInputElement;
			expect(checkbox.checked).toBe(false);
			checkbox.checked = true;
			checkbox.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			expect(onChange).toHaveBeenCalledTimes(1);
			const next = onChange.mock.calls[0][0] as ScriptColumn;
			expect(next).not.toBe(original);
			expect(next.mode).toBe('expand');
			expect(next.keep_empty).toBe(original.keep_empty);
			expect(next.snippet).toBe(original.snippet);
			expect(original.mode).toBe('collapse');
		} finally {
			unmount(c);
		}
	});

	it('toggling keep_empty emits a whole-column patch with keep_empty flipped, leaving the original untouched', () => {
		const onChange = vi.fn();
		const original = scriptColumn({ keep_empty: true });
		const c = render(original, onChange);
		try {
			const checkbox = document.querySelector(
				'[aria-label="Keep rows with no value"]'
			) as HTMLInputElement;
			expect(checkbox.checked).toBe(true);
			checkbox.checked = false;
			checkbox.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			expect(onChange).toHaveBeenCalledTimes(1);
			const next = onChange.mock.calls[0][0] as ScriptColumn;
			expect(next).not.toBe(original);
			expect(next.keep_empty).toBe(false);
			expect(next.mode).toBe(original.mode);
			expect(original.keep_empty).toBe(true);
		} finally {
			unmount(c);
		}
	});
});
