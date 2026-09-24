import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { ModelOp } from '$engine';
import { createEngineSeam } from '$lib/engine/seam';
import { SURFACES } from '$lib/engine/surfaces';
import {
	fakeProject,
	syncOver,
	type FakeProject
} from '$lib/engine/__tests__/support/project-server';
import type { AdvancedQuery } from '$lib/search/types';
import { setActiveBaseUrl } from '../client';
import { installEngineSeam, type Side, type Surface } from '../engine-route';
import {
	getElementsBatch,
	getTreeItemsBatch,
	listContainmentRootsPaged,
	listExcludedRoots,
	listExcludedRootsPaged,
	searchModel
} from '../model-read';
import { SearchResultPageSchema } from '../types';
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
		const page = await listExcludedRoots({ limit: 1, offset: 0, viewId: 'v1' }, cfg);
		expect(url?.searchParams.get('limit')).toBe('1');
		expect(url?.searchParams.get('view_id')).toBe('v1');
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

describe('searchModel on the criteria surface', () => {
	const made: ReturnType<typeof syncOver>[] = [];

	afterEach(() => {
		installEngineSeam(null);
		setActiveBaseUrl(null);
		for (const over of made.splice(0)) over.dispose();
	});

	const SERVED = {
		target: 'element',
		elements: [{ id: 'srv', type_name: 'Building', properties: {}, rev: 1 }],
		relationships: [],
		total: 1
	};

	/**
	 * A ready replica of `project` behind a seam with `criteria` on `side` and
	 * every other surface on the server; the server's search route answers
	 * `SERVED` and records each body it is sent.
	 */
	async function over(project: FakeProject, side: Side) {
		const bodies: unknown[] = [];
		server.use(
			...project.handlers(),
			http.post(`${project.baseUrl}/model/search`, async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(SERVED);
			})
		);
		const replica = syncOver(project);
		made.push(replica);
		replica.sync.open(project.projectId);
		await replica.sync.settled();
		expect(replica.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
		const call = vi.fn(
			(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> =>
				replica.sync.call(method, params, options)
		);
		const surfaces = Object.fromEntries(
			SURFACES.map((surface) => [surface, surface === 'criteria' ? side : 'server'])
		) as Record<Surface, Side>;
		installEngineSeam(
			createEngineSeam(
				{ status: () => replica.sync.status(), call: call as typeof replica.sync.call },
				surfaces
			)
		);
		setActiveBaseUrl(project.baseUrl);
		return { replica, call, bodies };
	}

	const stage = (replica: ReturnType<typeof syncOver>, ops: ModelOp[]) =>
		replica.sync.call('stage', { ops }, { transition: true });

	const named = (value: string): AdvancedQuery => ({
		target: 'element',
		criteria: [{ type: 'property', name: 'name', op: 'equals', value }]
	});

	it('on the engine, a staged property edit is found and the server is never asked', async () => {
		const project = fakeProject();
		const { replica, call, bodies } = await over(project, 'engine');
		await stage(replica, [
			{ kind: 'update_element', id: 'e_000001', properties_patch: { name: 'Staged only' } }
		]);

		const page = await searchModel(named('Staged only'), { limit: 10 });

		expect(page.total).toBe(1);
		expect(page.elements.map((element) => element.id)).toEqual(['e_000001']);
		expect(page.elements[0]!.properties['name']).toBe('Staged only');
		expect(call).toHaveBeenLastCalledWith(
			'searchModel',
			{ ...named('Staged only'), limit: 10 },
			{}
		);
		expect(bodies).toEqual([]);
	});

	it('on the engine, criteria held in a proxy are sent as the plain JSON the server is sent', async () => {
		const project = fakeProject();
		const { call, bodies } = await over(project, 'engine');
		const query = named(String(project.model.getElement('e_000001').props['name']));

		const page = await searchModel({ target: 'element', criteria: new Proxy(query.criteria, {}) });

		expect(page.elements.map((element) => element.id)).toContain('e_000001');
		expect(call).toHaveBeenLastCalledWith('searchModel', query, {});
		expect(bodies).toEqual([]);
	});

	it("on the engine, a pattern the engine cannot vouch for is the server's page", async () => {
		const project = fakeProject();
		const { call, bodies } = await over(project, 'engine');
		const query: AdvancedQuery = {
			target: 'element',
			criteria: [{ type: 'property', name: 'name', op: 'matches', value: '(?x)a' }]
		};

		const page = await searchModel(query, { offset: 0 });

		expect(page).toEqual(SearchResultPageSchema.parse(SERVED));
		expect(call).toHaveBeenCalledOnce();
		expect(bodies).toEqual([{ ...query, offset: 0 }]);
	});

	it('on the server, both reach the server alone', async () => {
		const project = fakeProject();
		const { replica, call, bodies } = await over(project, 'server');
		await stage(replica, [
			{ kind: 'update_element', id: 'e_000001', properties_patch: { name: 'Staged only' } }
		]);
		const pattern: AdvancedQuery = {
			target: 'element',
			criteria: [{ type: 'property', name: 'name', op: 'matches', value: '(?x)a' }]
		};

		expect(await searchModel(named('Staged only'))).toEqual(SearchResultPageSchema.parse(SERVED));
		expect(await searchModel(pattern)).toEqual(SearchResultPageSchema.parse(SERVED));

		expect(call).not.toHaveBeenCalled();
		expect(bodies).toEqual([named('Staged only'), pattern]);
	});
});
