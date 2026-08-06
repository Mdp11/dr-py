import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { evaluateNavigation, getArtifact, listArtifacts } from '../artifacts';

const BASE = 'http://api.test/api/v1/projects/p1';
const CFG = { baseUrl: BASE };

const HEADER = {
	id: 'a1',
	kind: 'navigation',
	name: 'Sensors',
	artifact_rev: 1,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: 'u1'
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('artifacts api', () => {
	it('lists headers with a kind filter', async () => {
		server.use(
			http.get(`${BASE}/artifacts`, ({ request }) => {
				expect(new URL(request.url).searchParams.get('kind')).toBe('navigation');
				return HttpResponse.json({ items: [HEADER] });
			})
		);
		const res = await listArtifacts('navigation', CFG);
		expect(res.items[0].name).toBe('Sensors');
	});

	it('fetches one artifact with its payload', async () => {
		server.use(
			http.get(`${BASE}/artifacts/a1`, () =>
				HttpResponse.json({
					...HEADER,
					payload: { kind: 'path', start: { kind: 'scope', types: [] }, steps: [] }
				})
			)
		);
		const res = await getArtifact('a1', CFG);
		expect(res.payload.kind).toBe('path');
	});

	// This module is READ-ONLY by design: writes go through `POST /commits` as
	// staged artifact ops, so there is nothing here to test a PUT/POST/DELETE
	// against. See the comment in `../artifacts.ts`.

	it('evaluates and parses a chain page', async () => {
		server.use(
			http.post(`${BASE}/navigations/evaluate`, () =>
				HttpResponse.json({
					step_types: ['Owns'],
					chains: [
						[
							{ id: 'b1', type_name: 'Building', display_name: 'Plant', child_count: 0 },
							{ id: 's1', type_name: 'Sensor', display_name: 'T-1', child_count: 0 }
						]
					],
					total: 1,
					truncated: false
				})
			)
		);
		const page = await evaluateNavigation({ artifact_id: 'a1' }, CFG);
		const node = page.chains[0][1];
		expect('kind' in node ? undefined : node.display_name).toBe('T-1');
		expect(page.total).toBe(1);
	});
});
