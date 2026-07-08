import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as artifactsApi from '$lib/api/artifacts';
import {
	ensureDraft,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	setProjectInfo,
	toggleExpanded,
	updateDefinition
} from '$lib/state';
import ChainPreview from '../ChainPreview.svelte';

const CHAIN_PAGE = {
	step_types: ['Uses'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 1,
	truncated: false
};

/** A runnable path node: a start type plus one complete relationship step
 * (mirrors the fixture in navigation-editor.test.ts). */
function runnablePath(startType = 'Component') {
	return {
		kind: 'path' as const,
		schema_version: 1,
		start: { kind: 'scope' as const, types: [startType], criteria: [] },
		steps: [
			{
				kind: 'relationship' as const,
				relationship_type: 'Uses',
				direction: 'out' as const,
				target_types: [],
				children: []
			}
		],
		exclude_visited: true
	};
}

/** A relationship step followed by a filter step: step_types only reports
 * the relationship hop, so the preview table must gain exactly one extra
 * column (the filter step contributes no column of its own). */
function filterNarrowedPath(startType = 'Component') {
	return {
		kind: 'path' as const,
		schema_version: 1,
		start: { kind: 'scope' as const, types: [startType], criteria: [] },
		steps: [
			{
				kind: 'relationship' as const,
				relationship_type: 'Uses',
				direction: 'out' as const,
				target_types: [],
				children: []
			},
			{
				kind: 'filter' as const,
				criteria: []
			}
		],
		exclude_visited: true
	};
}

/** Flush the microtask/macrotask that a fire-and-forget preview run (via
 * `toggleExpanded`) needs to settle its mocked evaluate (mirrors
 * navigation-editor.test.ts's flushEvaluate). */
const flushEvaluate = () => new Promise<void>((r) => setTimeout(r, 0));

function render(tabId: string) {
	const component = mount(ChainPreview, { target: document.body, props: { tabId, path: [] } });
	flushSync();
	return component;
}

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
	vi.restoreAllMocks();
});

it('shows the node preview table when expanded and evaluated', async () => {
	const tabId = 'nav:draft:table';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
	updateDefinition(tabId, runnablePath());
	// root is expanded by default: collapse + re-expand to force an immediate run.
	toggleExpanded(tabId, []);
	toggleExpanded(tabId, []);
	await flushEvaluate();
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('1 of 1 chains');
		const rows = [...document.querySelectorAll('tbody tr')];
		expect(rows).toHaveLength(1);
		const chip = [...document.querySelectorAll('tbody button')].find(
			(b) => b.textContent?.trim() === 'b1'
		);
		expect(chip).toBeTruthy();
	} finally {
		unmount(c);
	}
});

it('shows an error line when the node evaluate failed', async () => {
	const tabId = 'nav:draft:error';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockRejectedValue(new Error('boom'));
	updateDefinition(tabId, runnablePath());
	toggleExpanded(tabId, []);
	toggleExpanded(tabId, []);
	await flushEvaluate();
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain(
			'Evaluation failed — edit the definition to retry'
		);
	} finally {
		unmount(c);
	}
});

it('renders no column for a filter-only narrowing (columns = rel steps)', async () => {
	const tabId = 'nav:draft:filter';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
	updateDefinition(tabId, filterNarrowedPath());
	toggleExpanded(tabId, []);
	toggleExpanded(tabId, []);
	await flushEvaluate();
	const c = render(tabId);
	try {
		const headers = [...document.querySelectorAll('thead th')];
		// "Start" + one relationship-step header ("Uses →") — the filter step
		// (step_types = ['Uses'], no filter entry) adds no extra column.
		expect(headers).toHaveLength(2);
		expect(headers[1].textContent).toContain('Uses');
	} finally {
		unmount(c);
	}
});
