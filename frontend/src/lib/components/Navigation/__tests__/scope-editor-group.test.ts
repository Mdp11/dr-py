import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { NavScope } from '$lib/api/types';
import { CRITERION_LABELS, criteriaForKind } from '$lib/search/types';
import ScopeEditor from '../ScopeEditor.svelte';

let component: Record<string, unknown> | null = null;
afterEach(() => {
	if (component) unmount(component);
	component = null;
	document.body.innerHTML = '';
});

function mountScope(scope: NavScope = { kind: 'scope', types: [], criteria: [] }) {
	const onChange = vi.fn();
	component = mount(ScopeEditor, { target: document.body, props: { scope, onChange } });
	flushSync();
	return { onChange };
}

/** Opens the "+ condition" type menu and returns its item labels. */
function openConditionMenu(): string[] {
	const trigger = [...document.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === '+ condition'
	);
	if (!trigger) throw new Error('"+ condition" trigger not found');
	(trigger as HTMLButtonElement).click();
	flushSync();
	return [...document.querySelectorAll('[role="menuitem"]')].map(
		(i) => i.textContent?.trim() ?? ''
	);
}

function pickCondition(label: string): void {
	openConditionMenu();
	const item = [...document.querySelectorAll('[role="menuitem"]')].find(
		(i) => i.textContent?.trim() === label
	);
	if (!item) throw new Error(`condition menu item "${label}" not found`);
	(item as HTMLElement).click();
	flushSync();
}

it('"+ condition" offers every element criterion type, not just Property', () => {
	mountScope();
	expect(openConditionMenu()).toEqual(criteriaForKind('element').map((t) => CRITERION_LABELS[t]));
});

it('"+ condition" → "Has type" appends an entity_type criterion', () => {
	const { onChange } = mountScope();
	pickCondition(CRITERION_LABELS.entity_type);
	expect(onChange).toHaveBeenCalledWith({
		kind: 'scope',
		types: [],
		criteria: [{ type: 'entity_type', names: [] }]
	});
});

it('"+ condition" → "Any of" appends an empty any_of criterion', () => {
	const { onChange } = mountScope();
	pickCondition(CRITERION_LABELS.any_of);
	expect(onChange).toHaveBeenCalledWith({
		kind: 'scope',
		types: [],
		criteria: [{ type: 'any_of', criteria: [] }]
	});
});

it('the standalone "+ OR group" button is gone — the group lives in the menu', () => {
	mountScope();
	const stale = [...document.querySelectorAll('button')].some(
		(b) => b.textContent?.trim() === '+ OR group'
	);
	expect(stale).toBe(false);
});

it('an any_of criterion renders as a group row, not a CriterionRow', () => {
	mountScope({ kind: 'scope', types: [], criteria: [{ type: 'any_of', criteria: [] }] });
	expect(document.querySelector('[data-testid="criterion-group"]')).not.toBeNull();
});
