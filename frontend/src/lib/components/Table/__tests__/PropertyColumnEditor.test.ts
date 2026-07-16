// The property-column editor: name (a single combobox — free text whose
// focus/typing opens a filtered suggestion list), source, split-into-rows,
// keep_empty — all editable after creation. Controlled component like
// NavigationColumnEditor; the metamodel store is mocked for suggestion scoping.
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
			properties: [
				// zod-parsed metamodels always carry multiplicity (default '0..1')
				{ name: 'mass', datatype: 'real', multiplicity: '0..1' },
				{ name: 'tags', datatype: 'string', multiplicity: '0..*' }
			],
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

	function focusNameInput(): HTMLInputElement {
		const input = document.querySelector('[data-testid="property-name-input"]') as HTMLInputElement;
		input.dispatchEvent(new FocusEvent('focus'));
		flushSync();
		return input;
	}

	it('focusing the name input opens suggestions scoped to the scope row types', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(MM as never);
		const onChange = vi.fn();
		const c = render(propColumn(), { kind: 'scope', types: ['Block'], criteria: [] }, onChange);
		try {
			expect(document.querySelector('[data-testid="property-suggestions"]')).toBeNull();
			focusNameInput();
			const list = document.querySelector('[data-testid="property-suggestions"]');
			expect(list?.textContent).toContain('mass');
			expect(list?.textContent).not.toContain('color');
		} finally {
			unmount(c);
		}
	});

	it('falls back to all properties when the source types are unknowable', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(MM as never);
		const onChange = vi.fn();
		const c = render(propColumn(), { kind: 'chains', navigation: {} }, onChange);
		try {
			focusNameInput();
			const list = document.querySelector('[data-testid="property-suggestions"]');
			expect(list?.textContent).toContain('mass');
			expect(list?.textContent).toContain('color');
		} finally {
			unmount(c);
		}
	});

	it('typed text filters the suggestions; picking one sets the name', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(MM as never);
		const onChange = vi.fn();
		// name 'col' filters the union down to 'color'
		const c = render(propColumn('col'), { kind: 'chains', navigation: {} }, onChange);
		try {
			focusNameInput();
			const list = document.querySelector('[data-testid="property-suggestions"]');
			expect(list?.textContent).toContain('color');
			expect(list?.textContent).not.toContain('mass');
			(list?.querySelector('button') as HTMLElement).click();
			flushSync();
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: 'color' }));
		} finally {
			unmount(c);
		}
	});

	it('toggles mode via the split checkbox; keep_empty is available in BOTH modes', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(null);
		const onChange = vi.fn();
		const c = render(propColumn(), { kind: 'scope', types: [], criteria: [] }, onChange);
		try {
			// collapse mode: keep_empty stays available (unchecked drops rows whose
			// cell is empty, without splitting anything)
			const keep = document.querySelector(
				'input[aria-label="Keep rows with no value"]'
			) as HTMLInputElement;
			expect(keep).not.toBeNull();
			expect(keep.checked).toBe(true);
			keep.click();
			flushSync();
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ keep_empty: false }));
			const split = document.querySelector(
				'input[aria-label="Split multiple values in multiple rows"]'
			) as HTMLInputElement;
			expect(split.checked).toBe(false);
			split.click();
			flushSync();
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'expand' }));
		} finally {
			unmount(c);
		}
	});

	function splitCheckbox(): HTMLInputElement {
		return document.querySelector(
			'input[aria-label="Split multiple values in multiple rows"]'
		) as HTMLInputElement;
	}

	it('disables the split toggle when every scoped type declares the property single-valued', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(MM as never);
		const c = render(
			propColumn('mass'),
			{ kind: 'scope', types: ['Block'], criteria: [] },
			vi.fn()
		);
		try {
			expect(splitCheckbox().disabled).toBe(true);
			expect(splitCheckbox().closest('label')?.title).toContain('single-valued');
		} finally {
			unmount(c);
		}
	});

	it('keeps the split toggle enabled for a multi-valued property', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(MM as never);
		const c = render(
			propColumn('tags'),
			{ kind: 'scope', types: ['Block'], criteria: [] },
			vi.fn()
		);
		try {
			expect(splitCheckbox().disabled).toBe(false);
		} finally {
			unmount(c);
		}
	});

	it('keeps the split toggle enabled when the source types are unknowable or the property is undeclared', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(MM as never);
		// chains row source: any element type can arrive → cannot prove single
		const c1 = render(propColumn('mass'), { kind: 'chains', navigation: {} }, vi.fn());
		try {
			expect(splitCheckbox().disabled).toBe(false);
		} finally {
			unmount(c1);
		}
		document.body.innerHTML = '';
		// undeclared property: instance data may still hold lists
		const c2 = render(
			propColumn('freeform'),
			{ kind: 'scope', types: ['Block'], criteria: [] },
			vi.fn()
		);
		try {
			expect(splitCheckbox().disabled).toBe(false);
		} finally {
			unmount(c2);
		}
	});

	it('an already-splitting single-valued column stays uncheckable (not locked on)', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(MM as never);
		const onChange = vi.fn();
		const c = render(
			{ ...propColumn('mass'), mode: 'expand' },
			{ kind: 'scope', types: ['Block'], criteria: [] },
			onChange
		);
		try {
			expect(splitCheckbox().disabled).toBe(false);
			splitCheckbox().click();
			flushSync();
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'collapse' }));
		} finally {
			unmount(c);
		}
	});

	it('toggles keep_empty for a splitting column', () => {
		vi.spyOn(metamodelState, 'getMetamodel').mockReturnValue(null);
		const onChange = vi.fn();
		const c = render(
			{ ...propColumn('mass'), mode: 'expand' },
			{ kind: 'scope', types: [], criteria: [] },
			onChange
		);
		try {
			const box = document.querySelector(
				'input[aria-label="Keep rows with no value"]'
			) as HTMLInputElement;
			expect(box.checked).toBe(true);
			box.click();
			flushSync();
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ keep_empty: false }));
		} finally {
			unmount(c);
		}
	});
});
