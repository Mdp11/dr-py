import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../api/__tests__/server';
import { setActiveBaseUrl } from '$lib/api/client';
import { getActiveProgress, resetProgress } from '../progress.svelte';
import { beginJourney, resetJourney } from '../open-journey';
import { MAX_COLD_POLLS, trackOpenProgress } from '../open-progress.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('trackOpenProgress feeds the journey', () => {
	beforeEach(() => {
		resetProgress();
		resetJourney();
		setActiveBaseUrl(BASE);
	});
	afterEach(() => resetJourney());

	it('advances the journey bar toward the validate slice, then refreshes the summary at ready', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let calls = 0;
		let summaryFetched = false;
		server.use(
			http.get(`${BASE}/model/status`, async () => {
				calls++;
				if (calls === 1)
					return HttpResponse.json({
						state: 'validating',
						model_rev: 1,
						validation: { running: true, done: 5, total: 10 }
					});
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
		beginJourney('open'); // boot() owns beginJourney in production; the loop only feeds it
		const done = trackOpenProgress(1);
		// validate slice is [72,95]; 5/10 → 72 + 0.5*(95-72) = 83.5 → the bar should be past 72
		await vi.waitFor(() => expect(getActiveProgress()?.done ?? 0).toBeGreaterThanOrEqual(72));
		release();
		await done;
		expect(summaryFetched).toBe(true);
	});

	it('never starts a bar when no journey is active (loop is a silent feeder)', async () => {
		server.use(
			http.get(`${BASE}/model/status`, () =>
				HttpResponse.json({ state: 'hydrating', hydration: { phase: 'build', done: 1, total: 4 } })
			)
		);
		// no beginJourney → journeyStatus no-ops; one poll then cancel
		const p = trackOpenProgress(1);
		await vi.waitFor(() => expect(getActiveProgress()).toBeNull());
		// stop the loop
		const { cancelOpenProgress } = await import('../open-progress.svelte');
		cancelOpenProgress();
		await p;
	});

	it('gives up after MAX_COLD_POLLS consecutive cold polls', async () => {
		let calls = 0;
		server.use(
			http.get(`${BASE}/model/status`, () => {
				calls++;
				return HttpResponse.json({ state: 'cold', model_rev: null });
			})
		);
		beginJourney('open');
		await trackOpenProgress(1);
		expect(calls).toBe(MAX_COLD_POLLS + 1);
	});
});
