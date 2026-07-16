import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import type { PathNavigation, SetExpression } from '$lib/api/types';
import {
	ensureDraft,
	ensureEmbeddedDraft,
	getDraft,
	getSelectedPath,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	setProjectInfo,
	updateDefinition
} from '$lib/state';
import { emptyRowPath, pathKey } from '$lib/navigation/tree';
import NavigationNode from '../NavigationNode.svelte';
import PathCard from '../PathCard.svelte';

const CHAIN_PAGE = {
	step_types: ['Uses'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 1,
	truncated: false
};

beforeEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue({
		step_types: [],
		chains: [],
		total: 0,
		truncated: false
	});
});
afterEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

function render(tabId: string) {
	const c = mount(NavigationNode, { target: document.body, props: { tabId, path: [] } });
	flushSync();
	return c;
}
function buttonByText(text: string): HTMLButtonElement {
	const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
	if (!b) throw new Error(`button "${text}" not found`);
	return b as HTMLButtonElement;
}
function pathWith(steps: PathNavigation['steps'] = []): PathNavigation {
	return {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'scope', types: ['A'], criteria: [] },
		steps,
		exclude_visited: true
	};
}
async function seed(tabId: string, defn: PathNavigation) {
	await ensureDraft(tabId);
	updateDefinition(tabId, defn);
	flushSync();
}

it('a bare root path is titled "Path" and shows the numbered rail', async () => {
	const tabId = 'nav:draft:pc-title';
	await seed(
		tabId,
		pathWith([
			{
				kind: 'relationship',
				relationship_type: 'Uses',
				direction: 'out',
				target_types: [],
				children: []
			},
			{ kind: 'filter', criteria: [] }
		])
	);
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('Path');
		expect(document.body.textContent).toContain('Start from');
		expect(document.body.textContent).toContain('Follow');
		expect(document.body.textContent).toContain('Keep only');
		// Column badges: 0 (start), 1 (the hop), and the filter's ghost dot.
		const badges = [...document.querySelectorAll('[data-testid="chain-badge"]')].map(
			(b) => b.textContent?.trim() ?? ''
		);
		expect(badges.slice(0, 3)).toEqual(['0', '1', '·']);
	} finally {
		unmount(c);
	}
});

it('clicking the card selects its node; inner controls do not', async () => {
	const tabId = 'nav:draft:pc-select';
	await seed(tabId, pathWith());
	updateDefinition(tabId, {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: pathWith(), step_index: null },
			{ definition: pathWith(), step_index: null }
		]
	} as SetExpression);
	const c = render(tabId);
	flushSync();
	try {
		const cards = [...document.querySelectorAll('[data-testid="path-card"]')] as HTMLElement[];
		expect(cards).toHaveLength(2);
		cards[1].click();
		flushSync();
		expect(pathKey(getSelectedPath(tabId))).toBe('1');
		// An inner control click must NOT change the selection.
		const addBtn = cards[0].querySelector('button')!;
		addBtn.click();
		flushSync();
		expect(pathKey(getSelectedPath(tabId))).toBe('1');
	} finally {
		unmount(c);
	}
});

it('"Combine with… → A new path" auto-wraps the bare path into a union', async () => {
	const tabId = 'nav:draft:pc-wrap';
	await seed(tabId, pathWith());
	const c = render(tabId);
	try {
		buttonByText('Combine with… ▾').click();
		flushSync();
		buttonByText('A new path').click();
		flushSync();
		const defn = getDraft(tabId)!.definition as SetExpression;
		expect(defn.kind).toBe('set_op');
		expect(defn.op).toBe('union');
		expect(defn.operands).toHaveLength(2);
		// The built path travelled to operand 0 and the selection followed it.
		expect(pathKey(getSelectedPath(tabId))).toBe('0');
	} finally {
		unmount(c);
	}
});

it('the Options expander toggles exclude_visited', async () => {
	const tabId = 'nav:draft:pc-options';
	await seed(tabId, pathWith());
	const c = render(tabId);
	try {
		const cb = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(cb.checked).toBe(true);
		cb.click();
		flushSync();
		expect((getDraft(tabId)!.definition as PathNavigation).exclude_visited).toBe(false);
	} finally {
		unmount(c);
	}
});

it('the collapse toggle hides the editing body but keeps the header', async () => {
	const tabId = 'nav:draft:pc-collapse';
	await seed(tabId, pathWith());
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('Start from');
		(document.querySelector('[data-testid="path-collapse-toggle"]') as HTMLElement).click();
		flushSync();
		expect(document.body.textContent).not.toContain('Start from');
		expect(document.body.textContent).not.toContain('Combine with');
		// the header (title + collapsed one-line summary) stays
		expect(document.body.textContent).toContain('Path');
		expect(document.body.textContent).toContain('A'); // nodeLabel: start types
		(document.querySelector('[data-testid="path-collapse-toggle"]') as HTMLElement).click();
		flushSync();
		expect(document.body.textContent).toContain('Start from');
	} finally {
		unmount(c);
	}
});

it('renaming a path writes `name` into the definition; clearing restores the auto title', async () => {
	const tabId = 'nav:draft:pc-rename';
	await seed(tabId, pathWith());
	const c = render(tabId);
	try {
		(document.querySelector('[data-testid="path-rename-button"]') as HTMLElement).click();
		flushSync();
		const input = document.querySelector('[data-testid="path-name-input"]') as HTMLInputElement;
		input.value = 'Buildings sweep';
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		expect((getDraft(tabId)!.definition as PathNavigation).name).toBe('Buildings sweep');
		expect(document.body.textContent).toContain('Buildings sweep');

		// clearing the name restores the automatic title
		(document.querySelector('[data-testid="path-rename-button"]') as HTMLElement).click();
		flushSync();
		const again = document.querySelector('[data-testid="path-name-input"]') as HTMLInputElement;
		again.value = '';
		again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		expect((getDraft(tabId)!.definition as PathNavigation).name).toBeNull();
		expect(document.body.textContent).toContain('Path');
	} finally {
		unmount(c);
	}
});

it('a step note can be added, is displayed, and lands in the definition', async () => {
	const tabId = 'nav:draft:pc-comment';
	await seed(
		tabId,
		pathWith([
			{
				kind: 'relationship',
				relationship_type: 'Uses',
				direction: 'out',
				target_types: [],
				children: []
			}
		])
	);
	const c = render(tabId);
	try {
		(document.querySelector('button[aria-label="Add step note"]') as HTMLElement).click();
		flushSync();
		const input = document.querySelector('[data-testid="step-comment-input"]') as HTMLInputElement;
		input.value = 'hop to the systems this block uses';
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		const defn = getDraft(tabId)!.definition as PathNavigation;
		expect(
			(defn.steps[0] as Extract<(typeof defn.steps)[0], { kind: 'relationship' }>).comment
		).toBe('hop to the systems this block uses');
		expect(document.querySelector('[data-testid="step-comment"]')?.textContent).toContain(
			'hop to the systems this block uses'
		);
	} finally {
		unmount(c);
	}
});

it('offers the row start mode only on a row-context embedded draft', async () => {
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
	ensureEmbeddedDraft('navemb:pc1', emptyRowPath(), { rowContext: true, rowElementId: null });
	const node = getDraft('navemb:pc1')!.definition;
	const c = mount(PathCard, {
		target: document.body,
		props: { tabId: 'navemb:pc1', path: [], node: node as PathNavigation }
	});
	flushSync();
	try {
		// Embedded drafts default COLLAPSED (table-settings readability) — expand
		// the card to reach the start-mode select.
		(document.querySelector('[data-testid="path-collapse-toggle"]') as HTMLElement).click();
		flushSync();
		const select = document.querySelector('select[aria-label="Start mode"]')!;
		expect([...select.querySelectorAll('option')].map((o) => o.value)).toContain('row');
		expect((select as HTMLSelectElement).value).toBe('row');
		expect(document.body.textContent).toContain("each row's element");
	} finally {
		unmount(c);
	}
});

it('does not offer the row start mode on an ordinary tab draft', async () => {
	const tabId = 'nav:draft:pc2';
	await ensureDraft(tabId);
	const node = getDraft(tabId)!.definition;
	const c = mount(PathCard, {
		target: document.body,
		props: { tabId, path: [], node: node as PathNavigation }
	});
	flushSync();
	try {
		const select = document.querySelector('select[aria-label="Start mode"]')!;
		expect([...select.querySelectorAll('option')].map((o) => o.value)).not.toContain('row');
	} finally {
		unmount(c);
	}
});

it('inserting a step between existing steps splices it at that position', async () => {
	const tabId = 'nav:draft:pc-insert';
	await seed(
		tabId,
		pathWith([
			{
				kind: 'relationship',
				relationship_type: 'Uses',
				direction: 'out',
				target_types: [],
				children: []
			},
			{
				kind: 'relationship',
				relationship_type: 'Owns',
				direction: 'out',
				target_types: [],
				children: []
			}
		])
	);
	const c = render(tabId);
	try {
		// one insert zone per existing step (insert BEFORE step i); appending
		// stays covered by the existing "+ Follow a relationship" buttons.
		const zones = [...document.querySelectorAll('[data-testid="insert-step-zone"]')];
		expect(zones).toHaveLength(2);
		// insert a filter between the two hops (zone index 1 = before step 1)
		const addFilter = zones[1].querySelector('button[aria-label="Insert condition step here"]');
		if (!addFilter) throw new Error('insert condition button not found');
		(addFilter as HTMLButtonElement).click();
		flushSync();
		let steps = (getDraft(tabId)!.definition as PathNavigation).steps;
		expect(steps.map((s) => s.kind)).toEqual(['relationship', 'filter', 'relationship']);
		// insert a relationship at the very top (zone 0 = before step 0)
		const zonesAfter = [...document.querySelectorAll('[data-testid="insert-step-zone"]')];
		expect(zonesAfter).toHaveLength(3);
		const addRel = zonesAfter[0].querySelector(
			'button[aria-label="Insert relationship step here"]'
		);
		if (!addRel) throw new Error('insert relationship button not found');
		(addRel as HTMLButtonElement).click();
		flushSync();
		steps = (getDraft(tabId)!.definition as PathNavigation).steps;
		expect(steps.map((s) => s.kind)).toEqual([
			'relationship',
			'relationship',
			'filter',
			'relationship'
		]);
		expect((steps[0] as { relationship_type: string }).relationship_type).toBe('');
		expect((steps[1] as { relationship_type: string }).relationship_type).toBe('Uses');
	} finally {
		unmount(c);
	}
});
