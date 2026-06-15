import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { getElementsBatch } from '../model-read';
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
			http.post(`${BASE}/model/elements/batch`, () =>
				HttpResponse.json({ items: 'nope' })
			)
		);
		await expect(getElementsBatch(['a'], cfg)).rejects.toThrow();
	});
});
