import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { validateModel } from '../validation';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('validateModel', () => {
	it('POSTs with inline body and parses Issue[]', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/models/m/validate`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json([
					{ severity: 'error', message: 'oops', target_ids: ['e1'] }
				]);
			})
		);
		const inline = {
			elements: [
				{ id: 'e1', type_name: 'Block', properties: {}, rev: 0 }
			],
			relationships: []
		};
		const result = await validateModel('m', { inline }, cfg);
		expect(body).toEqual({ inline, scope: undefined });
		expect(result).toEqual([
			{ severity: 'error', message: 'oops', target_ids: ['e1'] }
		]);
	});

	it('POSTs with scope only and parses warnings', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/models/m/validate`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json([
					{ severity: 'warning', message: 'hint', target_ids: [] }
				]);
			})
		);
		const result = await validateModel('m', { scope: ['e1', 'e2'] }, cfg);
		expect(body).toEqual({ inline: undefined, scope: ['e1', 'e2'] });
		expect(result[0].severity).toBe('warning');
	});

	it('POSTs with no body when no options provided', async () => {
		let contentLength: string | null = null;
		let text = '';
		server.use(
			http.post(`${BASE}/models/m/validate`, async ({ request }) => {
				contentLength = request.headers.get('content-length');
				text = await request.text();
				return HttpResponse.json([]);
			})
		);
		const result = await validateModel('m', undefined, cfg);
		expect(result).toEqual([]);
		// Either no content-length or "0", and body is empty.
		expect(text).toBe('');
		if (contentLength !== null) {
			expect(contentLength).toBe('0');
		}
	});
});
