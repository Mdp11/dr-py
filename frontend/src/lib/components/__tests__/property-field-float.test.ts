import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Metamodel, PropertyDef } from '$lib/api/types';
import { clearMetamodel, setMetamodel } from '../../state/metamodel.svelte';
import PropertyField from '../Inspector/PropertyField.svelte';

const MM: Metamodel = { enums: {}, elements: [], relationships: [] };

function def(multiplicity: string): PropertyDef {
	return {
		name: 'mass',
		datatype: 'float',
		multiplicity,
		min: null,
		max: null,
		pattern: null,
		max_length: null
	};
}

beforeEach(() => setMetamodel(MM));
afterEach(() => clearMetamodel());

function render(propDef: PropertyDef, value: unknown, onChange: (next: unknown) => void) {
	const c = mount(PropertyField, { target: document.body, props: { propDef, value, onChange } });
	flushSync();
	return c;
}

function inputs(): HTMLInputElement[] {
	return Array.from(document.body.querySelectorAll('input'));
}

function type(node: HTMLInputElement, text: string): void {
	node.value = text;
	node.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

it('shows an infinity token as text and emits the token when typed', () => {
	const onChange = vi.fn();
	const c = render(def('0..1'), 'Infinity', onChange);
	try {
		const [node] = inputs();
		expect(node.value).toBe('Infinity');
		type(node, '-inf');
		expect(onChange).toHaveBeenLastCalledWith('-Infinity');
		type(node, '2.5');
		expect(onChange).toHaveBeenLastCalledWith(2.5);
		type(node, '');
		expect(onChange).toHaveBeenLastCalledWith(null);
	} finally {
		unmount(c);
	}
});

it('keeps the last value and warns on text that is not a float', () => {
	const onChange = vi.fn();
	const c = render(def('0..1'), 1.5, onChange);
	try {
		const [node] = inputs();
		expect(node.value).toBe('1.5');
		type(node, '1.5x');
		expect(onChange).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain('not a float');
		type(node, '1.75');
		expect(onChange).toHaveBeenLastCalledWith(1.75);
		expect(document.body.textContent).not.toContain('not a float');
	} finally {
		unmount(c);
	}
});

it('handles tokens per item in a multi-valued field', () => {
	const onChange = vi.fn();
	const c = render(def('0..*'), [1, 'Infinity'], onChange);
	try {
		const nodes = inputs();
		expect(nodes.map((n) => n.value)).toEqual(['1', 'Infinity']);
		type(nodes[0], 'inf');
		expect(onChange).toHaveBeenLastCalledWith(['Infinity', 'Infinity']);
	} finally {
		unmount(c);
	}
});
