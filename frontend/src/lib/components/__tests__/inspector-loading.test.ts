import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse, delay } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import type { Element } from '$lib/api/types';
import { server } from '../../api/__tests__/server';
import { resetModelStore, setModelApiConfig } from '../../state/model.svelte';
import { clearSelection, select } from '../../state/selection.svelte';
import Inspector from '../Inspector.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setModelApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	server.resetHandlers();
	clearSelection();
});
afterAll(() => {
	setModelApiConfig(undefined);
	server.close();
});
beforeEach(() => {
	resetModelStore();
	clearSelection();
});

function el(id: string): Element {
	return { id, type_name: 'Block', properties: { Name: 'Pump' }, rev: 1 };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

it('shows a loading skeleton (not "Selection not found") while the element fetch is in flight', async () => {
	server.use(
		http.get(`*/model/elements/:id`, async () => {
			await delay(15);
			return HttpResponse.json(el('e1'));
		}),
		http.get(`*/model/elements/:id/relationships`, () => HttpResponse.json({ items: [], total: 0 }))
	);

	select({ kind: 'element', id: 'e1' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		// while the fetch is pending: skeleton, and NO "not found" flash
		expect(document.querySelector('[data-testid="inspector-loading"]')).not.toBeNull();
		expect(document.body.textContent).not.toContain('Selection not found');

		await settle();
		flushSync();
		expect(document.querySelector('[data-testid="inspector-loading"]')).toBeNull();
		expect(document.body.textContent).toContain('Properties');
	} finally {
		unmount(component);
	}
});

it('shows "Selection not found" once the server confirms the id is missing', async () => {
	server.use(
		http.get(`*/model/elements/:id`, () => HttpResponse.json({ detail: 'nope' }, { status: 404 }))
	);

	select({ kind: 'element', id: 'ghost' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		expect(document.querySelector('[data-testid="inspector-loading"]')).not.toBeNull();

		await settle();
		flushSync();
		expect(document.querySelector('[data-testid="inspector-loading"]')).toBeNull();
		expect(document.body.textContent).toContain('Selection not found');
	} finally {
		unmount(component);
	}
});
