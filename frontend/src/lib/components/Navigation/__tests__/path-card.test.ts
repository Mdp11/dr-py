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
