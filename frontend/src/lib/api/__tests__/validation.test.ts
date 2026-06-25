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
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json([{ severity: 'error', message: 'oops', target_ids: ['e1'] }]);
			})
		);
		const inline = {
			elements: [{ id: 'e1', type_name: 'Block', properties: {}, rev: 0 }],
			relationships: []
		};
		const result = await validateModel({ inline }, cfg);
		expect(body).toEqual({ inline, scope: undefined });
		expect(result).toEqual([{ severity: 'error', message: 'oops', target_ids: ['e1'], origin: 'on_server' }]);
	});

	it('POSTs with scope only and parses warnings', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json([{ severity: 'warning', message: 'hint', target_ids: [] }]);
			})
		);
		const result = await validateModel({ scope: ['e1', 'e2'] }, cfg);
		expect(body).toEqual({ inline: undefined, scope: ['e1', 'e2'] });
		expect(result[0].severity).toBe('warning');
	});

	it('POSTs with no body when no options provided', async () => {
		let contentLength: string | null = null;
		let text = '';
		server.use(
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				contentLength = request.headers.get('content-length');
				text = await request.text();
				return HttpResponse.json([]);
			})
		);
		const result = await validateModel(undefined, cfg);
		expect(result).toEqual([]);
		expect(text).toBe('');
		if (contentLength !== null) {
			expect(contentLength).toBe('0');
		}
	});

	it('POSTs staged ops with base_rev when ops are present', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json([
					{ severity: 'error', message: 'bad', target_ids: ['e1'], origin: 'uncommitted' }
				]);
			})
		);
		const ops = [{ kind: 'update_element', id: 'e1', properties_patch: { p: 1 } }] as const;
		const result = await validateModel({ ops: [...ops], baseRev: 7 }, cfg);
		expect(body).toEqual({ ops: [...ops], base_rev: 7 });
		expect(result[0].origin).toBe('uncommitted');
	});

	it('defaults origin to on_server when the server omits it', async () => {
		server.use(
			http.post(`${BASE}/model/validate`, async () =>
				HttpResponse.json([{ severity: 'warning', message: 'x', target_ids: ['e1'] }])
			)
		);
		const result = await validateModel(undefined, cfg);
		expect(result[0].origin).toBe('on_server');
	});
});
