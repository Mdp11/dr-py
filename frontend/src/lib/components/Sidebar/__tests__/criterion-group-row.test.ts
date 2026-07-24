import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { AnyOfCriterion } from '$lib/search/types';
import CriterionGroupRow from '../CriterionGroupRow.svelte';

let component: Record<string, unknown> | null = null;
afterEach(() => {
	if (component) unmount(component);
	component = null;
	document.body.innerHTML = '';
});

function mountRow(criterion: AnyOfCriterion) {
	const onChange = vi.fn();
	const onRemove = vi.fn();
	component = mount(CriterionGroupRow, {
		target: document.body,
		props: { criterion, index: 3, target: 'element' as const, onChange, onRemove }
	});
	flushSync();
	return { onChange, onRemove };
}

it('renders the header, the empty hint, and no member rows when empty', () => {
	mountRow({ type: 'any_of', criteria: [] });
	expect(document.body.textContent).toContain('Any of');
	expect(document.body.textContent).toContain('filters nothing');
	expect(document.querySelectorAll('[aria-label="Remove criterion"]').length).toBe(0);
});

it('renders one member row per member', () => {
	mountRow({
		type: 'any_of',
		criteria: [
			{ type: 'property', name: 'a', op: 'equals', value: '1' },
			{ type: 'name_id', field: 'name', op: 'contains', value: 'x' }
		]
	});
	expect(document.querySelectorAll('[aria-label="Remove criterion"]').length).toBe(2);
});

it('removing a member patches the group in place', () => {
	const { onChange } = mountRow({
		type: 'any_of',
		criteria: [
			{ type: 'property', name: 'a', op: 'equals', value: '1' },
			{ type: 'property', name: 'b', op: 'equals', value: '2' }
		]
	});
	const removes = document.querySelectorAll<HTMLButtonElement>('[aria-label="Remove criterion"]');
	removes[0].click();
	flushSync();
	expect(onChange).toHaveBeenCalledWith(3, {
		type: 'any_of',
		criteria: [{ type: 'property', name: 'b', op: 'equals', value: '2' }]
	});
});

it('the group remove button reports the group index', () => {
	const { onRemove } = mountRow({ type: 'any_of', criteria: [] });
	document.body.querySelector<HTMLButtonElement>('[aria-label="Remove group"]')!.click();
	flushSync();
	expect(onRemove).toHaveBeenCalledWith(3);
});
