import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as artifactsApi from '$lib/api/artifacts';
import type { PathNavigation, SetExpression } from '$lib/api/types';
import {
	ensureDraft,
	getSelectedPath,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	runPreview,
	selectNode,
	setProjectInfo,
	updateDefinition
} from '$lib/state';
import { emptyPath } from '$lib/navigation/tree';
import ResultsDock from '../ResultsDock.svelte';

const CHAIN_PAGE = {
	step_types: ['Uses'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 1,
	truncated: false,
	warnings: []
};

const PAGE_1 = {
	step_types: ['Uses'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 2,
	truncated: false,
	warnings: []
};

const PAGE_2 = {
	step_types: ['Uses'],
	chains: [[{ id: 'b2', type_name: 'B', display_name: 'b2', child_count: 0 }]],
	total: 2,
	truncated: false,
	warnings: []
};

/** A runnable path node: a start type plus one complete relationship step
 * (mirrors the fixture in navigation-editor.test.ts). */
function runnablePath(startType = 'Component'): PathNavigation {
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
function filterNarrowedPath(startType = 'Component'): PathNavigation {
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

/** A combine node whose operands are the given definitions (in order). */
function combineOf(
	operands: ReadonlyArray<PathNavigation>,
	op: SetExpression['op'] = 'union'
): SetExpression {
	return {
		kind: 'set_op',
		schema_version: 2,
		op,
		operands: operands.map((definition) => ({ definition, step_index: null }))
	};
}

/** Flush the microtask/macrotask that a fire-and-forget preview run (via
 * `runPreview`) needs to settle its mocked evaluate (mirrors
 * navigation-editor.test.ts's flushEvaluate). */
const flushEvaluate = () => new Promise<void>((r) => setTimeout(r, 0));

function render(tabId: string) {
	const component = mount(ResultsDock, { target: document.body, props: { tabId } });
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
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

it('renders a value terminal (scalar property step) as plain text, not an element chip', async () => {
	const tabId = 'nav:draft:value-terminal';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue({
		step_types: ['priority'],
		chains: [
			[
				{ id: 'r1', type_name: 'Requirement', display_name: 'R1', child_count: 0 },
				{ kind: 'value', value: 3 }
			]
		],
		total: 1,
		truncated: false,
		warnings: []
	});
	updateDefinition(tabId, {
		kind: 'path',
		schema_version: 1,
		start: { kind: 'scope', types: ['Requirement'], criteria: [] },
		steps: [{ kind: 'property', property_name: 'priority' }],
		exclude_visited: true
	} as PathNavigation);
	await runPreview(tabId, []).catch(() => {});
	await flushEvaluate();
	const c = render(tabId);
	try {
		const status = document.querySelector('[data-testid="results-status"]');
		expect(status?.textContent).toContain('✓ 1 chains');
		const cells = [...document.querySelectorAll('tbody td')];
		expect(cells).toHaveLength(2);
		// the element node stays a clickable chip; the value node is plain text
		expect(cells[0].querySelector('button')?.textContent?.trim()).toBe('R1');
		expect(cells[1].querySelector('button')).toBeNull();
		expect(cells[1].textContent?.trim()).toBe('3');
	} finally {
		unmount(c);
	}
});

it('renders the selected node’s chains with rail-numbered column headers', async () => {
	const tabId = 'nav:draft:table';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
	updateDefinition(tabId, runnablePath());
	await runPreview(tabId, []).catch(() => {});
	await flushEvaluate();
	const c = render(tabId);
	try {
		const headers = [...document.querySelectorAll('thead th')];
		expect(headers).toHaveLength(2);
		expect(headers[0].querySelector('[data-testid="chain-badge"]')?.textContent).toBe('0');
		expect(headers[0].textContent).toContain('Start');
		expect(headers[1].querySelector('[data-testid="chain-badge"]')?.textContent).toBe('1');
		expect(headers[1].textContent).toContain('Uses');
		const status = document.querySelector('[data-testid="results-status"]');
		expect(status?.textContent).toContain('auto-runs as you edit');
		expect(status?.textContent).toContain('✓ 1 chains');
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

it('a filter step adds no column', async () => {
	const tabId = 'nav:draft:filter';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
	updateDefinition(tabId, filterNarrowedPath());
	await runPreview(tabId, []).catch(() => {});
	await flushEvaluate();
	const c = render(tabId);
	try {
		const headers = [...document.querySelectorAll('thead th')];
		expect(headers).toHaveLength(2);
	} finally {
		unmount(c);
	}
});

it('shows the evaluation error line when the last run failed', async () => {
	const tabId = 'nav:draft:error';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockRejectedValue(new Error('boom'));
	updateDefinition(tabId, runnablePath());
	await runPreview(tabId, []).catch(() => {});
	await flushEvaluate();
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('Evaluation failed — edit the definition to retry');
	} finally {
		unmount(c);
	}
});

it('a pristine draft shows the fresh-draft empty state', async () => {
	const tabId = 'nav:draft:pristine';
	await ensureDraft(tabId);
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain(
			'Pick what to start from — results appear here automatically as you build.'
		);
		const status = document.querySelector('[data-testid="results-status"]');
		expect(status?.textContent).toContain('waiting for a runnable path');
	} finally {
		unmount(c);
	}
});

it('an incomplete non-root node names itself in the empty state', async () => {
	const tabId = 'nav:draft:named-empty';
	await ensureDraft(tabId);
	updateDefinition(tabId, combineOf([runnablePath('A'), emptyPath()]));
	selectNode(tabId, [1]);
	flushSync();
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain(
			'Nothing to run yet — pick what Path B starts from, or add a step.'
		);
	} finally {
		unmount(c);
	}
});

it('a combination node shows one Combined elements column with the operator note', async () => {
	const tabId = 'nav:draft:combined';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
	updateDefinition(tabId, combineOf([runnablePath('A'), runnablePath('B')]));
	await runPreview(tabId, []).catch(() => {});
	await flushEvaluate();
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('Combined elements');
		expect(document.body.textContent).toContain("(union of the parts' fed steps)");
	} finally {
		unmount(c);
	}
});

it('the node picker lists the tree and selecting an entry moves the dock', async () => {
	const tabId = 'nav:draft:picker';
	await ensureDraft(tabId);
	updateDefinition(tabId, combineOf([runnablePath('A'), runnablePath('B')]));
	flushSync();
	const c = render(tabId);
	try {
		const select = document.querySelector('[data-testid="node-picker"]') as HTMLSelectElement;
		const options = [...select.options].map((o) => o.textContent?.trim());
		expect(options).toEqual(['Path A', 'Path B', 'Whole combination']);
		select.value = '1';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(getSelectedPath(tabId)).toEqual([1]);
	} finally {
		unmount(c);
	}
});

it('a selected ref node shows the linked empty state', async () => {
	const tabId = 'nav:draft:ref-empty';
	await ensureDraft(tabId);
	updateDefinition(tabId, {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: runnablePath('A'), step_index: null },
			{ ref: 'nav-1', step_index: null }
		]
	});
	selectNode(tabId, [1]);
	flushSync();
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain(
			'Linked saved navigation — open it in its own tab to see its results.'
		);
	} finally {
		unmount(c);
	}
});

it('renders the script-warnings chip when the preview carries warnings', async () => {
	const tabId = 'nav:draft:warnings';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue({
		...CHAIN_PAGE,
		warnings: ['step 2: divide by zero']
	});
	updateDefinition(tabId, runnablePath());
	await runPreview(tabId, []).catch(() => {});
	await flushEvaluate();
	const c = render(tabId);
	try {
		const chip = document.querySelector('[data-testid="nav-warnings"]');
		expect(chip).toBeTruthy();
		expect(chip?.textContent).toContain('1 script warning');
	} finally {
		unmount(c);
	}
});

it('renders the plural script-warnings chip for more than one warning', async () => {
	const tabId = 'nav:draft:warnings-plural';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue({
		...CHAIN_PAGE,
		warnings: ['warning one', 'warning two']
	});
	updateDefinition(tabId, runnablePath());
	await runPreview(tabId, []).catch(() => {});
	await flushEvaluate();
	const c = render(tabId);
	try {
		const chip = document.querySelector('[data-testid="nav-warnings"]');
		expect(chip?.textContent).toContain('2 script warnings');
	} finally {
		unmount(c);
	}
});

it('does not render the warnings chip when the preview has no warnings', async () => {
	const tabId = 'nav:draft:no-warnings';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
	updateDefinition(tabId, runnablePath());
	await runPreview(tabId, []).catch(() => {});
	await flushEvaluate();
	const c = render(tabId);
	try {
		expect(document.querySelector('[data-testid="nav-warnings"]')).toBeNull();
	} finally {
		unmount(c);
	}
});

it('Load more pages the selected node’s chains', async () => {
	const tabId = 'nav:draft:load-more';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation')
		.mockResolvedValueOnce(PAGE_1)
		.mockResolvedValueOnce(PAGE_2);
	updateDefinition(tabId, runnablePath());
	await runPreview(tabId, []).catch(() => {});
	await flushEvaluate();
	const c = render(tabId);
	try {
		expect([...document.querySelectorAll('tbody tr')]).toHaveLength(1);
		const loadMore = [...document.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Load more'
		) as HTMLButtonElement;
		expect(loadMore).toBeTruthy();
		loadMore.click();
		flushSync();
		await flushEvaluate();
		flushSync();
		expect([...document.querySelectorAll('tbody tr')]).toHaveLength(2);
	} finally {
		unmount(c);
	}
});
