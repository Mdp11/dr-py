import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import {
	getElementsBatch,
	getTreeItemsBatch,
	listContainmentRootsPaged,
	listExcludedRoots,
	listExcludedRootsPaged
} from '../model-read';
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

describe('getTreeItemsBatch', () => {
	it('posts ids and returns lite items', async () => {
		let received: unknown;
		server.use(
			http.post(`${BASE}/model/elements/tree-items`, async ({ request }) => {
				received = await request.json();
				return HttpResponse.json({
					items: [
						{ id: 'a', type_name: 'T', display_name: 'A', child_count: 0 },
						{ id: 'b', type_name: 'T', display_name: 'B', child_count: 2 }
					]
				});
			})
		);
		const items = await getTreeItemsBatch(['a', 'b'], cfg);
		expect(received).toEqual({ ids: ['a', 'b'] });
		expect(items.map((i) => i.id)).toEqual(['a', 'b']);
		expect(items[0]).toMatchObject({ display_name: 'A', child_count: 0 });
	});
});

function item(id: string) {
	return { id, type_name: 'Block', display_name: id, child_count: 0 };
}

describe('listContainmentRootsPaged', () => {
	it('assembles pages starting at the given offset and stops at the server total', async () => {
		const all = Array.from({ length: 600 }, (_, i) => `r${i}`);
		const offsets: number[] = [];
		server.use(
			http.get(`${BASE}/model/containment/roots`, ({ request }) => {
				const u = new URL(request.url);
				const offset = Number(u.searchParams.get('offset') ?? '0');
				const limit = Number(u.searchParams.get('limit') ?? '500');
				offsets.push(offset);
				return HttpResponse.json({
					items: all.slice(offset, offset + limit).map(item),
					total: all.length
				});
			})
		);
		const page = await listContainmentRootsPaged(500, cfg, 400);
		expect(offsets).toEqual([400]);
		expect(page.items.map((i) => i.id)).toEqual(all.slice(400, 600));
		expect(page.total).toBe(600);
	});

	it('defaults to offset 0 (full prefix assembly)', async () => {
		const all = ['a', 'b', 'c'];
		server.use(
			http.get(`${BASE}/model/containment/roots`, ({ request }) => {
				const u = new URL(request.url);
				const offset = Number(u.searchParams.get('offset') ?? '0');
				const limit = Number(u.searchParams.get('limit') ?? '500');
				return HttpResponse.json({
					items: all.slice(offset, offset + limit).map(item),
					total: all.length
				});
			})
		);
		const page = await listContainmentRootsPaged(3, cfg);
		expect(page.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
		expect(page.total).toBe(3);
	});
});

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
		expect(page.items[0].id).toBe('a');
	});

	it('listExcludedRootsPaged fetches only the tail pages when given a start offset', async () => {
		// Scroll auto-load growth appends: growing an N-item list by one page must
		// request just the missing tail, not re-download offsets 0..N (that
		// refetch-from-zero pattern made growth O(n²) in requests on large models).
		const all = Array.from({ length: 1200 }, (_, i) => `e${i}`);
		const offsets: number[] = [];
		server.use(
			http.get(`${BASE}/model/containment/roots/excluded`, ({ request }) => {
				const u = new URL(request.url);
				const offset = Number(u.searchParams.get('offset') ?? '0');
				const limit = Number(u.searchParams.get('limit') ?? '500');
				offsets.push(offset);
				return HttpResponse.json({
					items: all.slice(offset, offset + limit).map(item),
					total: all.length
				});
			})
		);
		const page = await listExcludedRootsPaged(700, cfg, 500);
		expect(offsets).toEqual([500, 1000]);
		expect(page.items.map((i) => i.id)).toEqual(all.slice(500, 1200));
		expect(page.total).toBe(1200);
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
		expect(page.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
		expect(page.total).toBe(3);
	});
});
