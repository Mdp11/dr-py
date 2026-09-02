import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../../api/__tests__/server';
import { setActiveBaseUrl } from '$lib/api/client';
import { isViewResolved, markViewUnresolved, refreshView } from '../view.svelte';
import { setActiveViewId } from '../active-view.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('view resolution gate', () => {
	beforeEach(() => {
		setActiveBaseUrl(BASE);
		setActiveViewId('v1');
		markViewUnresolved();
	});

	it('is unresolved until a delayed refreshView completes', async () => {
		server.use(
			http.get(`${BASE}/views/v1`, async () => {
				await delay(20);
				return HttpResponse.json({ view: null, warnings: [] });
			})
		);
		expect(isViewResolved()).toBe(false);
		const pending = refreshView();
		expect(isViewResolved()).toBe(false); // in flight: still unresolved
		await pending;
		expect(isViewResolved()).toBe(true);
	});

	it('resolves even when the view fetch fails', async () => {
		server.use(
			http.get(`${BASE}/views/v1`, () => HttpResponse.json({ error: 'x' }, { status: 500 }))
		);
		await refreshView();
		expect(isViewResolved()).toBe(true); // "no view" is an answer
	});
});
