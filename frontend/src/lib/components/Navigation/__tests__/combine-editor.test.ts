import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it } from 'vitest';

import type { SetExpression } from '$lib/api/types';
import {
	ensureDraft,
	getDraft,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	setProjectInfo,
	updateDefinition
} from '$lib/state';
import NavigationNode from '../NavigationNode.svelte';

beforeEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});
afterEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
});

/** A combine node whose N operands are inline bare paths, one per given start
 * type — distinguishable in the rendered operand label without needing a
 * saved-navigation ref. */
function combineOf(types: string[], op: SetExpression['op'] = 'union'): SetExpression {
	return {
		kind: 'set_op',
		schema_version: 2,
		op,
		operands: types.map((t) => ({
			definition: {
				kind: 'path',
				schema_version: 2,
				start: { kind: 'scope', types: [t], criteria: [] },
				steps: [],
				exclude_visited: true
			},
			step_index: null
		}))
	};
}

function render(tabId: string) {
	const component = mount(NavigationNode, { target: document.body, props: { tabId, path: [] } });
	flushSync();
	return component;
}

function buttonByText(text: string): HTMLButtonElement {
	const btn = [...document.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === text
	);
	if (!btn) throw new Error(`button "${text}" not found`);
	return btn as HTMLButtonElement;
}

function buttonsByLabel(label: string): HTMLButtonElement[] {
	return [...document.querySelectorAll(`button[aria-label="${label}"]`)] as HTMLButtonElement[];
}

async function seedCombine(tabId: string, types: string[], op: SetExpression['op'] = 'union') {
	await ensureDraft(tabId);
	updateDefinition(tabId, combineOf(types, op));
	flushSync();
}

it('insert navigation appends an operand', async () => {
	const tabId = 'nav:draft:insert';
	await seedCombine(tabId, ['A', 'B']);
	const c = render(tabId);
	try {
		const before = (getDraft(tabId)?.definition as SetExpression).operands.length;
		buttonByText('+ insert navigation').click();
		flushSync();
		const after = (getDraft(tabId)?.definition as SetExpression).operands.length;
		expect(after).toBe(before + 1);
	} finally {
		unmount(c);
	}
});

it('remove operand down to one auto-unwraps to a bare path', async () => {
	const tabId = 'nav:draft:remove';
	await seedCombine(tabId, ['A', 'B']);
	const c = render(tabId);
	try {
		buttonsByLabel('Remove operand')[0].click();
		flushSync();
		expect(getDraft(tabId)?.definition.kind).toBe('path');
	} finally {
		unmount(c);
	}
});

it('reorder moves an operand', async () => {
	const tabId = 'nav:draft:reorder';
	await seedCombine(tabId, ['A', 'B', 'C']);
	const c = render(tabId);
	try {
		const labelOf = (i: number) => {
			const defn = getDraft(tabId)?.definition as SetExpression;
			const op = defn.operands[i];
			return op.definition?.kind === 'path' && op.definition.start.kind === 'scope'
				? op.definition.start.types[0]
				: undefined;
		};
		expect(labelOf(0)).toBe('A');
		expect(labelOf(1)).toBe('B');

		buttonsByLabel('Move down')[0].click();
		flushSync();

		expect(labelOf(0)).toBe('B');
		expect(labelOf(1)).toBe('A');
		expect(labelOf(2)).toBe('C');
	} finally {
		unmount(c);
	}
});

it('difference node labels operand 0 as base', async () => {
	const tabId = 'nav:draft:difference';
	await seedCombine(tabId, ['A', 'B'], 'difference');
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('base');
		expect(document.body.textContent).toContain('subtracted');
	} finally {
		unmount(c);
	}
});
