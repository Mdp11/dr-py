import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../api/__tests__/server';
import { setActiveBaseUrl } from '$lib/api/client';
import { getActiveProgress, resetProgress } from '../progress.svelte';
import { trackOpenProgress } from '../open-progress.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('trackOpenProgress', () => {
	beforeEach(() => {
		resetProgress();
		setActiveBaseUrl(BASE);
	});

	it('shows validating progress then clears at ready and refreshes the summary', async () => {
		const statuses = [
			{ state: 'validating', model_rev: 1, validation: { running: true, done: 5, total: 10 } },
			{ state: 'ready', model_rev: 1 }
		];
		let summaryFetched = false;
		server.use(
			http.get(`${BASE}/model/status`, () => HttpResponse.json(statuses.shift())),
			http.get(`${BASE}/model/summary`, () => {
				summaryFetched = true;
				return HttpResponse.json({
					model_rev: 1,
					element_count: 0,
					relationship_count: 0,
					elements_by_type: {},
					issue_counts: {},
					undo_depth: 0
				});
			})
		);
		const done = trackOpenProgress(1);
		// after the first poll a determinate entry exists
		await new Promise((r) => setTimeout(r, 5));
		expect(getActiveProgress()).toMatchObject({ done: 5, total: 10 });
		await done;
		expect(getActiveProgress()).toBeNull();
		expect(summaryFetched).toBe(true);
	});

	it('never shows an overlay when the model is immediately ready', async () => {
		server.use(
			http.get(`${BASE}/model/status`, () => HttpResponse.json({ state: 'ready', model_rev: 0 }))
		);
		await trackOpenProgress(1);
		expect(getActiveProgress()).toBeNull();
	});
});
