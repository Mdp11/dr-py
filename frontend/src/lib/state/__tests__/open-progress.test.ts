import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../api/__tests__/server';
import { setActiveBaseUrl } from '$lib/api/client';
import { getActiveProgress, resetProgress } from '../progress.svelte';
import { MAX_COLD_POLLS, trackOpenProgress } from '../open-progress.svelte';

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
		// The second /model/status response is gated on `release` so the test
		// can assert the intermediate determinate entry deterministically
		// instead of racing a real timer against the MSW round-trip.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		let summaryFetched = false;
		server.use(
			http.get(`${BASE}/model/status`, async () => {
				calls++;
				if (calls === 1) {
					return HttpResponse.json({
						state: 'validating',
						model_rev: 1,
						validation: { running: true, done: 5, total: 10 }
					});
				}
				await gate;
				return HttpResponse.json({ state: 'ready', model_rev: 1 });
			}),
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
		// after the first poll a determinate entry exists; the second poll is
		// blocked on `gate`, so this is stable regardless of scheduling.
		await vi.waitFor(() => expect(getActiveProgress()).toMatchObject({ done: 5, total: 10 }));
		release();
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

	it('gives up after MAX_COLD_POLLS consecutive cold polls instead of hanging forever', async () => {
		let calls = 0;
		server.use(
			http.get(`${BASE}/model/status`, () => {
				calls++;
				return HttpResponse.json({ state: 'cold', model_rev: null });
			})
		);
		await trackOpenProgress(1);
		// gives up on the poll that EXCEEDS the cap, so exactly cap + 1 requests
		expect(calls).toBe(MAX_COLD_POLLS + 1);
		expect(getActiveProgress()).toBeNull();
	});
});
