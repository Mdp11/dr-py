import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { CRITERION_LABELS, criteriaForKind, type AnyOfCriterion } from '$lib/search/types';
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

// The members menu is the SHARED AddCriterionMenu; what makes it a group menu
// is the type list it is handed. Nesting is forbidden structurally, so "Any of"
// must never appear among the alternatives.
it('the alternatives menu offers leaf types only — never a nested "Any of"', () => {
	mountRow({ type: 'any_of', criteria: [] });
	const trigger = [...document.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'alternative'
	);
	if (!trigger) throw new Error('"alternative" trigger not found');
	(trigger as HTMLButtonElement).click();
	flushSync();
	const labels = [...document.querySelectorAll('[role="menuitem"]')].map((i) =>
		i.textContent?.trim()
	);
	expect(labels).toEqual(
		criteriaForKind('element')
			.filter((t) => t !== 'any_of')
			.map((t) => CRITERION_LABELS[t])
	);
});

it('picking an alternative appends that criterion type to the group', () => {
	const { onChange } = mountRow({ type: 'any_of', criteria: [] });
	const trigger = [...document.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'alternative'
	);
	(trigger as HTMLButtonElement).click();
	flushSync();
	const item = [...document.querySelectorAll('[role="menuitem"]')].find(
		(i) => i.textContent?.trim() === CRITERION_LABELS.orphan
	);
	if (!item) throw new Error('"Is orphan" menu item not found');
	(item as HTMLElement).click();
	flushSync();
	expect(onChange).toHaveBeenCalledWith(3, { type: 'any_of', criteria: [{ type: 'orphan' }] });
});

it('the group remove button reports the group index', () => {
	const { onRemove } = mountRow({ type: 'any_of', criteria: [] });
	document.body.querySelector<HTMLButtonElement>('[aria-label="Remove group"]')!.click();
	flushSync();
	expect(onRemove).toHaveBeenCalledWith(3);
});
