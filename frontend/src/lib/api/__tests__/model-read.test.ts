import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { getElementsBatch, listExcludedRoots, listExcludedRootsPaged } from '../model-read';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('getElementsBatch', () => {
	it('posts ids and returns the parsed items array', async () => {
		let received: unknown;
		server.use(
			http.post(`${BASE}/model/elements/batch`, async ({ request }) => {
				received = await request.json();
				return HttpResponse.json({
					items: [
						{ id: 'a', type_name: 'Block', properties: {}, rev: 1 },
						{ id: 'b', type_name: 'Block', properties: {}, rev: 1 }
					]
				});
			})
		);
		const out = await getElementsBatch(['a', 'b'], cfg);
		expect(received).toEqual({ ids: ['a', 'b'] });
		expect(out.map((e) => e.id)).toEqual(['a', 'b']);
	});

	it('rejects on a schema mismatch', async () => {
		server.use(
			http.post(`${BASE}/model/elements/batch`, () => HttpResponse.json({ items: 'nope' }))
		);
		await expect(getElementsBatch(['a'], cfg)).rejects.toThrow();
	});
});

function item(id: string) {
	return { element: { id, type_name: 'Block', properties: {}, rev: 1 }, child_count: 0 };
}

describe('listExcludedRoots', () => {
	it('passes limit/offset and parses the page', async () => {
		let url: URL | undefined;
		server.use(
			http.get(`${BASE}/model/containment/roots/excluded`, ({ request }) => {
				url = new URL(request.url);
				return HttpResponse.json({ items: [item('a')], total: 3 });
			})
		);
		const page = await listExcludedRoots({ limit: 1, offset: 0 }, cfg);
		expect(url?.searchParams.get('limit')).toBe('1');
		expect(page.total).toBe(3);
		expect(page.items[0].element.id).toBe('a');
	});

	it('listExcludedRootsPaged assembles multiple pages up to the limit', async () => {
		const all = ['a', 'b', 'c'];
		server.use(
			http.get(`${BASE}/model/containment/roots/excluded`, ({ request }) => {
				const u = new URL(request.url);
				const offset = Number(u.searchParams.get('offset') ?? '0');
				const limit = Number(u.searchParams.get('limit') ?? '500');
				return HttpResponse.json({
					items: all.slice(offset, offset + limit).map(item),
					total: all.length
				});
			})
		);
		const page = await listExcludedRootsPaged(3, cfg);
		expect(page.items.map((i) => i.element.id)).toEqual(['a', 'b', 'c']);
		expect(page.total).toBe(3);
	});
});
