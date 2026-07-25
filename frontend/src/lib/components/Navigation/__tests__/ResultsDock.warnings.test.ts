import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as artifactsApi from '$lib/api/artifacts';
import type { PathNavigation, ScriptWarning } from '$lib/api/types';
import {
	ensureDraft,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	runPreview,
	setProjectInfo,
	updateDefinition
} from '$lib/state';
import ResultsDock from '../ResultsDock.svelte';

const CHAIN_PAGE = {
	step_types: ['Uses'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 1,
	truncated: false,
	warnings: []
};

/** A runnable path node (mirrors the fixture in results-dock.test.ts). */
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

/** Flush the microtask/macrotask that a fire-and-forget preview run (via
 * `runPreview`) needs to settle its mocked evaluate (mirrors
 * results-dock.test.ts's flushEvaluate). */
const flushEvaluate = () => new Promise<void>((r) => setTimeout(r, 0));

function render(tabId: string) {
	const component = mount(ResultsDock, { target: document.body, props: { tabId } });
	flushSync();
	return component;
}

/** Seeds a runnable path whose evaluate resolves with the given structured
 * warnings, then mounts and returns the dock. */
async function renderDockWithWarnings(warnings: ScriptWarning[]) {
	const tabId = `nav:draft:warnings-tooltip-${warnings.map((w) => w.code).join('-')}`;
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue({ ...CHAIN_PAGE, warnings });
	updateDefinition(tabId, runnablePath());
	await runPreview(tabId, []).catch(() => {});
	await flushEvaluate();
	return render(tabId);
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

it('counts distinct kinds and formats the tooltip via the shared formatter', async () => {
	// The count used to be the number of distinct backend STRINGS, which
	// inflated whenever the same kind fired with different numbers. Now it's
	// the number of structured warnings the backend already aggregated by
	// (code, detail), and the tooltip is built from `formatScriptWarning`
	// rather than stringifying the objects with `.join`.
	const c = await renderDockWithWarnings([
		{ code: 'nav_unknown_ids', occurrences: 17, total: 42, detail: null },
		{ code: 'nav_step_failed', occurrences: 2, total: 0, detail: 'boom' }
	]);
	try {
		const badge = document.querySelector('[data-testid="nav-warnings"]');
		expect(badge?.textContent).toContain('2 script warnings');
		expect(badge?.getAttribute('title')).toBe(
			'Navigation script returned 42 unknown element ids across 17 calls — dropped.\n' +
				'Navigation script step failed (2×): boom'
		);
	} finally {
		unmount(c);
	}
});

it('singularises one warning', async () => {
	const c = await renderDockWithWarnings([
		{ code: 'sort_needs_script_nav', occurrences: 1, total: 0, detail: null }
	]);
	try {
		const badge = document.querySelector('[data-testid="nav-warnings"]');
		expect(badge?.textContent).toContain('1 script warning');
		expect(badge?.textContent).not.toContain('1 script warnings');
	} finally {
		unmount(c);
	}
});
