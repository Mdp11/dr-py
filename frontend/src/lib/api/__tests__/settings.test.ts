import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { getSettings, updateSettings } from '../settings';
import { server } from './server';

const BASE = 'http://api.test/api/v1/projects/default';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('settings api', () => {
	it('getSettings parses strict_mode', async () => {
		server.use(http.get(`${BASE}/settings`, () => HttpResponse.json({ strict_mode: true })));
		expect((await getSettings(cfg)).strict_mode).toBe(true);
	});

	it('updateSettings PATCHes strict_mode', async () => {
		let body: unknown;
		server.use(
			http.patch(`${BASE}/settings`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json({ strict_mode: false });
			})
		);
		const res = await updateSettings(false, cfg);
		expect(body).toEqual({ strict_mode: false });
		expect(res.strict_mode).toBe(false);
	});
});
