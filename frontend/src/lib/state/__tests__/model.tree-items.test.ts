import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '../../api/__tests__/server';
import {
	ensureTreeItems,
	getCachedTreeItems,
	seedTreeItems,
	seedElements,
	resetModelStore,
	getMissingElementIds,
	setModelApiConfig
} from '../model.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setModelApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	server.resetHandlers();
});
afterAll(() => {
	setModelApiConfig(undefined);
	server.close();
});
beforeEach(() => {
	resetModelStore();
});

describe('tree-items cache', () => {
	it('seedTreeItems upserts and clears missing', () => {
		seedTreeItems([{ id: 'a', type_name: 'T', display_name: 'A', child_count: 0 }]);
		expect(getCachedTreeItems().get('a')?.display_name).toBe('A');
	});

	it('ensureTreeItems fetches uncached ids and records omitted as missing', async () => {
		const bodies: string[][] = [];
		server.use(
			http.post(`${BASE}/model/elements/tree-items`, async ({ request }) => {
				const { ids } = (await request.json()) as { ids: string[] };
				bodies.push(ids);
				// omit 'gone' -> server drops it (does not exist)
				return HttpResponse.json({
					items: ids
						.filter((id) => id !== 'gone')
						.map((id) => ({ id, type_name: 'T', display_name: id.toUpperCase(), child_count: 0 }))
				});
			})
		);

		await ensureTreeItems(['a', 'gone']);

		expect(getCachedTreeItems().has('a')).toBe(true);
		expect(getCachedTreeItems().get('a')?.display_name).toBe('A');
		expect(getMissingElementIds().has('gone')).toBe(true);

		// a second pass must not re-request the known-missing id or the cached one
		await ensureTreeItems(['a', 'gone', 'b']);
		expect(bodies).toEqual([['a', 'gone'], ['b']]);
	});

	it('skips ids already in the full _elements cache', async () => {
		let requested: string[] = [];
		server.use(
			http.post(`${BASE}/model/elements/tree-items`, async ({ request }) => {
				const { ids } = (await request.json()) as { ids: string[] };
				requested = ids;
				return HttpResponse.json({
					items: ids.map((id) => ({ id, type_name: 'T', display_name: id, child_count: 0 }))
				});
			})
		);

		seedElements([{ id: 'full', type_name: 'U', properties: {}, rev: 1 }]);

		await ensureTreeItems(['full', 'x']);

		expect(requested).toEqual(['x']);
		expect(getCachedTreeItems().has('full')).toBe(false);
	});
});
