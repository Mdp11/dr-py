import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { server } from '../../../api/__tests__/server';
import { setActiveBaseUrl } from '$lib/api/client';
import { elementStartScope, readElementStart } from '$lib/navigation/tree';
import type { PathNavigation } from '$lib/api/types';
import {
	ensureDraft,
	getDraft,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	setProjectInfo
} from '$lib/state';
import NavigationNode from '../NavigationNode.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setActiveBaseUrl(BASE);
});
afterEach(() => {
	server.resetHandlers();
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
});
afterAll(() => {
	setActiveBaseUrl(null);
	server.close();
});
beforeEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

it('picking an element writes an id-equals name_id criterion', () => {
	const scope = elementStartScope('el-42');
	expect(readElementStart(scope)).toBe('el-42');
});

it('a plain type scope reads back as Filter mode (null element)', () => {
	expect(readElementStart({ kind: 'scope', types: ['Component'], criteria: [] })).toBeNull();
});

function render(tabId: string) {
	const component = mount(NavigationNode, { target: document.body, props: { tabId, path: [] } });
	flushSync();
	return component;
}

function selectByLabel(label: string): HTMLSelectElement {
	const el = document.querySelector(`select[aria-label="${label}"]`);
	if (!el) throw new Error(`select "${label}" not found`);
	return el as HTMLSelectElement;
}

const SENSOR = { id: 'el-7', type_name: 'Sensor', properties: { name: 'Sensor Seven' }, rev: 1 };

// The picker's search debounces 250ms on a real timer; wait it out rather
// than mocking fake timers (this test exercises the real MSW round trip).
function waitForDebounce(): Promise<void> {
	return new Promise((r) => setTimeout(r, 350));
}

it('switching to Element mode and picking a result writes elementStartScope(id)', async () => {
	server.use(
		http.get(`${BASE}/model/elements`, ({ request }) => {
			const url = new URL(request.url);
			expect(url.searchParams.get('q')).toBe('sen');
			return HttpResponse.json({ items: [SENSOR], total: 1 });
		}),
		// The chip resolve fetch, fired once an id is picked.
		http.post(`${BASE}/model/elements/batch`, () => HttpResponse.json({ items: [SENSOR] }))
	);

	const tabId = 'nav:draft:element-start';
	await ensureDraft(tabId);
	const c = render(tabId);
	try {
		// Filter mode by default: the ScopeEditor's type picker is present, the
		// element typeahead is not.
		expect(document.querySelector('input[placeholder="Search elements…"]')).toBeNull();

		const mode = selectByLabel('Start mode');
		mode.value = 'element';
		mode.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect((getDraft(tabId)?.definition as PathNavigation).start).toEqual(elementStartScope(''));

		const input = document.querySelector('input[placeholder="Search elements…"]');
		if (!input) throw new Error('typeahead input not found');
		(input as HTMLInputElement).value = 'sen';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		await waitForDebounce();
		flushSync();

		const resultButton = [...document.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Sensor Seven')
		);
		if (!resultButton) throw new Error('result button not found');
		(resultButton as HTMLButtonElement).click();
		flushSync();

		expect((getDraft(tabId)?.definition as PathNavigation).start).toEqual(elementStartScope('el-7'));

		// The chip resolves the display name via getElementsBatch.
		await waitForDebounce();
		flushSync();
		expect(document.body.textContent).toContain('Sensor Seven');

		// Switching back to Filter clears the element criterion entirely.
		mode.value = 'scope';
		mode.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect((getDraft(tabId)?.definition as PathNavigation).start).toEqual({
			kind: 'scope',
			types: [],
			criteria: []
		});
	} finally {
		unmount(c);
	}
});
