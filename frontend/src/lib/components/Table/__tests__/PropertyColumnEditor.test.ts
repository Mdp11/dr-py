// The property-column editor: name (picker + free text), source, keep_empty —
// all editable after creation. Controlled component like
// NavigationColumnEditor; the metamodel store is mocked for picker scoping.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as metamodelState from '$lib/state/metamodel.svelte';
import type { Column, RowSource } from '$lib/api/types';
import PropertyColumnEditor from '../PropertyColumnEditor.svelte';

type PropColumn = Extract<Column, { kind: 'property' }>;

const MM = {
	name: 'mm',
	elements: [
		{
			name: 'Block',
			extends: null,
			abstract: false,
			properties: [{ name: 'mass', datatype: 'real' }],
			keys: []
		},
		{
			name: 'Other',
			extends: null,
			abstract: false,
			properties: [{ name: 'color', datatype: 'string' }],
			keys: []
		}
	],
	relationships: []
};

function propColumn(name = ''): PropColumn {
	return {
		kind: 'property',
		source: { kind: 'row', chain_index: 0 },
		name,
		mode: 'collapse',
		keep_empty: true,
		header: '',
		width_px: null
	};
}

function render(column: PropColumn, rowSource: RowSource, onChange: (n: PropColumn) => void) {
	const c = mount(PropertyColumnEditor, {
		target: document.body,
		props: { column, columnIndex: 1, columns: [column], rowSource, onChange }
	});
	flushSync();
	return c;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('PropertyColumnEditor', () => {
	it('edits the property name as free text', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(null);
		const onChange = vi.fn();
		const c = render(propColumn('old'), { kind: 'scope', types: [], criteria: [] }, onChange);
		try {
			const input = document.querySelector('input[aria-label="Property name"]') as HTMLInputElement;
			expect(input.value).toBe('old');
			input.value = 'mass';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: 'mass' }));
		} finally {
			unmount(c);
		}
	});

	it('scopes picker suggestions to the scope row types for a row-slot source', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(MM as never);
		const onChange = vi.fn();
		const c = render(propColumn(), { kind: 'scope', types: ['Block'], criteria: [] }, onChange);
		try {
			(document.querySelector('[data-testid="property-pick-trigger"]') as HTMLElement).click();
			flushSync();
			expect(document.body.textContent).toContain('mass');
			expect(document.body.textContent).not.toContain('color');
		} finally {
			unmount(c);
		}
	});

	it('falls back to all properties when the source types are unknowable', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(MM as never);
		const onChange = vi.fn();
		const c = render(propColumn(), { kind: 'chains', navigation: {} }, onChange);
		try {
			(document.querySelector('[data-testid="property-pick-trigger"]') as HTMLElement).click();
			flushSync();
			expect(document.body.textContent).toContain('mass');
			expect(document.body.textContent).toContain('color');
		} finally {
			unmount(c);
		}
	});

	it('toggles keep_empty', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(null);
		const onChange = vi.fn();
		const c = render(propColumn(), { kind: 'scope', types: [], criteria: [] }, onChange);
		try {
			const box = document.querySelector(
				'[data-testid="property-column-editor"] input[type="checkbox"]'
			) as HTMLInputElement;
			box.click();
			flushSync();
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ keep_empty: false }));
		} finally {
			unmount(c);
		}
	});
});
