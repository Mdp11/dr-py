import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import {
	ensureDraft,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	runPreview,
	setProjectInfo,
	updateDefinition
} from '$lib/state';
import StatusChip from '../StatusChip.svelte';

const CHAIN_PAGE = {
	step_types: ['Uses'],
	chains: [[{ id: 'b1', type_name: 'B', display_name: 'b1', child_count: 0 }]],
	total: 1,
	truncated: false
};

function runnablePath(startType = 'Component') {
	return {
		kind: 'path' as const,
		schema_version: 2,
		start: { kind: 'scope' as const, types: [startType], criteria: [] },
		steps: [],
		exclude_visited: true
	};
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

function render(tabId: string, kind: 'node' | 'ref' = 'node') {
	const c = mount(StatusChip, { target: document.body, props: { tabId, path: [], kind } });
	flushSync();
	return c;
}

it('shows the chain count after a successful run', async () => {
	const tabId = 'nav:draft:chip-ok';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
	updateDefinition(tabId, runnablePath());
	await runPreview(tabId, []);
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('✓ 1 chains');
	} finally {
		unmount(c);
	}
});

it('shows the incomplete hint for a pristine draft', async () => {
	const tabId = 'nav:draft:chip-incomplete';
	await ensureDraft(tabId);
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('incomplete — pick a start or add a step');
	} finally {
		unmount(c);
	}
});

it('shows the failure marker when the last evaluate failed', async () => {
	const tabId = 'nav:draft:chip-failed';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockRejectedValue(new Error('boom'));
	updateDefinition(tabId, runnablePath());
	await runPreview(tabId, []).catch(() => {});
	const c = render(tabId);
	try {
		expect(document.body.textContent).toContain('⚠ failed');
	} finally {
		unmount(c);
	}
});

it('does not blank the chip while an evaluate is in flight', async () => {
	const tabId = 'nav:draft:chip-loading';
	await ensureDraft(tabId);
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockImplementation(() => new Promise(() => {}));
	updateDefinition(tabId, runnablePath());
	void runPreview(tabId, []).catch(() => {});
	const c = render(tabId);
	try {
		expect(document.querySelector('[data-testid="status-chip"]')?.textContent?.trim()).toBe('…');
	} finally {
		unmount(c);
	}
});

it('a ref node shows the muted linked marker', async () => {
	const tabId = 'nav:draft:chip-ref';
	await ensureDraft(tabId);
	const c = render(tabId, 'ref');
	try {
		expect(document.body.textContent).toContain('linked');
	} finally {
		unmount(c);
	}
});
