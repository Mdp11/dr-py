import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import {
	deleteMetamodel,
	getMetamodel,
	listMetamodels,
	putMetamodel
} from '../metamodels';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('metamodels client', () => {
	it('listMetamodels parses string-array response', async () => {
		server.use(
			http.get(`${BASE}/metamodels`, () =>
				HttpResponse.json(['alpha', 'beta'])
			)
		);
		const result = await listMetamodels(cfg);
		expect(result).toEqual(['alpha', 'beta']);
	});

	it('getMetamodel hits the right URL and returns the raw body', async () => {
		let path = '';
		server.use(
			http.get(`${BASE}/metamodels/foo`, ({ request }) => {
				path = new URL(request.url).pathname;
				return HttpResponse.json({ name: 'foo', types: {} });
			})
		);
		const result = await getMetamodel('foo', cfg);
		expect(path).toBe('/api/v1/metamodels/foo');
		expect(result).toEqual({ name: 'foo', types: {} });
	});

	it('putMetamodel with object body sends application/json', async () => {
		let receivedContentType: string | null = null;
		let receivedBody: unknown;
		server.use(
			http.put(`${BASE}/metamodels/foo`, async ({ request }) => {
				receivedContentType = request.headers.get('content-type');
				receivedBody = await request.json();
				return HttpResponse.json({ ok: true });
			})
		);
		const result = await putMetamodel('foo', { types: { A: {} } }, cfg);
		expect(receivedContentType).toContain('application/json');
		expect(receivedBody).toEqual({ types: { A: {} } });
		expect(result).toEqual({ ok: true });
	});

	it('putMetamodel with string body sends YAML content-type', async () => {
		let receivedContentType: string | null = null;
		let receivedText = '';
		server.use(
			http.put(`${BASE}/metamodels/foo`, async ({ request }) => {
				receivedContentType = request.headers.get('content-type');
				receivedText = await request.text();
				return HttpResponse.json({ ok: true });
			})
		);
		await putMetamodel('foo', 'types:\n  A: {}\n', cfg);
		expect(receivedContentType).toContain('yaml');
		expect(receivedText).toBe('types:\n  A: {}\n');
	});

	it('deleteMetamodel issues DELETE and resolves on 204', async () => {
		let called = false;
		server.use(
			http.delete(`${BASE}/metamodels/foo`, () => {
				called = true;
				return new HttpResponse(null, { status: 204 });
			})
		);
		const result = await deleteMetamodel('foo', cfg);
		expect(called).toBe(true);
		expect(result).toBeUndefined();
	});

	it('encodeURIComponent escapes path params', async () => {
		let path = '';
		server.use(
			http.get(`${BASE}/metamodels/:name`, ({ request }) => {
				path = new URL(request.url).pathname;
				return HttpResponse.json({});
			})
		);
		await getMetamodel('a/b name', cfg);
		expect(path).toBe('/api/v1/metamodels/a%2Fb%20name');
	});
});
