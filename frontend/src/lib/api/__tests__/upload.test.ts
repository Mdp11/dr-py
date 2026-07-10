import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { apiUpload } from '../client';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('apiUpload', () => {
	it('POSTs the body with the CSRF header and parses via schema', async () => {
		let requestedWith: string | null = null;
		let received = '';
		server.use(
			http.post(`${BASE}/model/upload`, async ({ request }) => {
				requestedWith = request.headers.get('x-requested-with');
				received = await request.text();
				return HttpResponse.json({ ok: true });
			})
		);
		const out = await apiUpload(
			'/model/upload',
			{ body: '{"elements":[]}', schema: z.object({ ok: z.boolean() }) },
			cfg
		);
		expect(out).toEqual({ ok: true });
		expect(requestedWith).toBe('data-rover');
		expect(received).toBe('{"elements":[]}');
	});

	it('maps non-2xx to the shared typed errors', async () => {
		server.use(
			http.post(`${BASE}/model/upload`, () => HttpResponse.json({ error: 'boom' }, { status: 422 }))
		);
		await expect(apiUpload('/model/upload', { body: 'x' }, cfg)).rejects.toMatchObject({
			status: 422
		});
	});
});
