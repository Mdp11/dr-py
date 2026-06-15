import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { searchModel } from '../model-read';
import { server } from './server';
import type { AdvancedQuery } from '$lib/search/types';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('searchModel', () => {
	it('POSTs the query plus paging and parses an element result page', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/model/search`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json({
					target: 'element',
					elements: [{ id: 'e1', type_name: 'Person', properties: { name: 'Ann' }, rev: 1 }],
					relationships: [],
					total: 1
				});
			})
		);
		const query: AdvancedQuery = {
			target: 'element',
			criteria: [{ type: 'entity_type', names: ['Person'] }]
		};
		const page = await searchModel(query, { limit: 50, offset: 0 }, cfg);

		expect(body).toEqual({
			target: 'element',
			criteria: [{ type: 'entity_type', names: ['Person'] }],
			limit: 50,
			offset: 0
		});
		expect(page.target).toBe('element');
		expect(page.elements.map((e) => e.id)).toEqual(['e1']);
		expect(page.total).toBe(1);
	});

	it('parses a relationship result page', async () => {
		server.use(
			http.post(`${BASE}/model/search`, () =>
				HttpResponse.json({
					target: 'relationship',
					elements: [],
					relationships: [
						{
							id: 'r1',
							type_name: 'WorksAt',
							source_id: 'p1',
							target_id: 'c1',
							properties: {},
							rev: 1
						}
					],
					total: 1
				})
			)
		);
		const page = await searchModel({ target: 'relationship', criteria: [] }, undefined, cfg);
		expect(page.target).toBe('relationship');
		expect(page.relationships.map((r) => r.id)).toEqual(['r1']);
	});
});
