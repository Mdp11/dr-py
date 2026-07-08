import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { createArtifact, evaluateNavigation, listArtifacts, updateArtifact } from '../artifacts';
import { ConflictError } from '../errors';

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

	it('creates and returns the full artifact', async () => {
		server.use(
			http.post(`${BASE}/artifacts`, async ({ request }) => {
				const body = (await request.json()) as Record<string, unknown>;
				expect(body.kind).toBe('navigation');
				return HttpResponse.json({ ...HEADER, payload: body.payload }, { status: 201 });
			})
		);
		const res = await createArtifact(
			{
				kind: 'navigation',
				name: 'Sensors',
				payload: { kind: 'path', start: { kind: 'scope', types: [] }, steps: [] }
			},
			CFG
		);
		expect(res.payload.kind).toBe('path');
	});

	it('surfaces a stale-rev PUT as ConflictError', async () => {
		server.use(
			http.put(`${BASE}/artifacts/a1`, () =>
				HttpResponse.json({ detail: { message: 'stale', current_rev: 3 } }, { status: 409 })
			)
		);
		await expect(updateArtifact('a1', { artifact_rev: 1, name: 'x' }, CFG)).rejects.toBeInstanceOf(
			ConflictError
		);
	});

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
		expect(page.chains[0][1].display_name).toBe('T-1');
		expect(page.total).toBe(1);
	});
});
