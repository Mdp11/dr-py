import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { NavScope } from '$lib/api/types';
import ScopeEditor from '../ScopeEditor.svelte';

let component: Record<string, unknown> | null = null;
afterEach(() => {
	if (component) unmount(component);
	component = null;
	document.body.innerHTML = '';
});

it('"+ OR group" appends an empty any_of criterion', () => {
	const onChange = vi.fn();
	const scope: NavScope = { kind: 'scope', types: [], criteria: [] };
	component = mount(ScopeEditor, { target: document.body, props: { scope, onChange } });
	flushSync();
	const btn = [...document.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === '+ OR group'
	);
	if (!btn) throw new Error('"+ OR group" button not found');
	btn.click();
	flushSync();
	expect(onChange).toHaveBeenCalledWith({
		kind: 'scope',
		types: [],
		criteria: [{ type: 'any_of', criteria: [] }]
	});
});

it('an any_of criterion renders as a group row, not a CriterionRow', () => {
	const scope: NavScope = {
		kind: 'scope',
		types: [],
		criteria: [{ type: 'any_of', criteria: [] }]
	};
	component = mount(ScopeEditor, {
		target: document.body,
		props: { scope, onChange: vi.fn() }
	});
	flushSync();
	expect(document.querySelector('[data-testid="criterion-group"]')).not.toBeNull();
});
