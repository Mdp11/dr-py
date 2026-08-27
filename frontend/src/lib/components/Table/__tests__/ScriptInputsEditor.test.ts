import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Column, ScriptInput } from '$lib/api/types';
import ScriptInputsEditor from '../ScriptInputsEditor.svelte';

const columns: Column[] = [
	{
		kind: 'element',
		source: { kind: 'row', chain_index: 0 },
		header: 'Self',
		width_px: null,
		hidden: false
	},
	{
		kind: 'property',
		source: { kind: 'row', chain_index: 0 },
		name: 'name',
		mode: 'collapse',
		keep_empty: true,
		header: '',
		width_px: null,
		hidden: false
	},
	{
		kind: 'script',
		source: { kind: 'row', chain_index: 0 },
		snippet: {},
		inputs: [],
		mode: 'collapse',
		keep_empty: true,
		header: '',
		width_px: null,
		hidden: false
	}
];

function render(inputs: ScriptInput[], onChange: (next: ScriptInput[]) => void) {
	const c = mount(ScriptInputsEditor, {
		target: document.body,
		props: {
			inputs,
			columns,
			columnIndex: 2,
			rowSource: { kind: 'scope', types: [], criteria: [] },
			onChange
		}
	});
	flushSync();
	return c;
}

let mounted: ReturnType<typeof render> | null = null;
afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = null;
	document.body.innerHTML = '';
});

describe('ScriptInputsEditor', () => {
	it('adds an input pointing at the latest earlier column', () => {
		const onChange = vi.fn();
		mounted = render([], onChange);
		(document.querySelector('[aria-label="Add input"]') as HTMLButtonElement).click();
		flushSync();
		expect(onChange).toHaveBeenCalledWith([
			{ name: 'input1', ref: { kind: 'column', index: 1, step_index: null } }
		]);
	});

	it('renames, retargets and removes an input', () => {
		const onChange = vi.fn();
		mounted = render(
			[{ name: 'a', ref: { kind: 'column', index: 1, step_index: null } }],
			onChange
		);
		const name = document.querySelector('[aria-label="Input name"]') as HTMLInputElement;
		name.value = 'nm';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(onChange).toHaveBeenLastCalledWith([
			{ name: 'nm', ref: { kind: 'column', index: 1, step_index: null } }
		]);
		const sel = document.querySelector('[aria-label="Source column"]') as HTMLSelectElement;
		sel.value = '0';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(onChange).toHaveBeenLastCalledWith([
			{ name: 'a', ref: { kind: 'column', index: 0, step_index: null } }
		]);
		(document.querySelector('[aria-label="Remove input"]') as HTMLButtonElement).click();
		flushSync();
		expect(onChange).toHaveBeenLastCalledWith([]);
	});

	it('flags invalid and duplicate names', () => {
		const onChange = vi.fn();
		mounted = render(
			[
				{ name: 'class', ref: { kind: 'column', index: 0, step_index: null } },
				{ name: 'x', ref: { kind: 'column', index: 0, step_index: null } },
				{ name: 'x', ref: { kind: 'column', index: 1, step_index: null } }
			],
			onChange
		);
		expect(document.querySelectorAll('[data-testid="input-name-error"]').length).toBe(3);
	});

	it('does not offer a Row source', () => {
		mounted = render([{ name: 'a', ref: { kind: 'column', index: 1, step_index: null } }], vi.fn());
		expect(document.querySelector('[aria-label="Column source kind"]')).toBeNull();
	});
});
