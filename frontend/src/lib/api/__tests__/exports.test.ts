import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { runExporter, runExporterDraft } from '../exports';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('runExporter', () => {
	it('returns a preparing result on a 202 (script-cache sweep still running)', async () => {
		server.use(
			http.post(`${BASE}/exports/run`, () =>
				HttpResponse.json(
					{ state: 'computing', done: 1, total: 4 },
					{ status: 202, headers: { 'Retry-After': '1' } }
				)
			)
		);
		const result = await runExporter('a1', cfg);
		expect(result).toEqual({ kind: 'preparing', done: 1, total: 4 });
	});

	it('returns a ready result with the blob + filename on 200', async () => {
		server.use(
			http.post(`${BASE}/exports/run`, () =>
				HttpResponse.arrayBuffer(new TextEncoder().encode('zip-bytes').buffer, {
					headers: { 'content-disposition': 'attachment; filename="drop.zip"' }
				})
			)
		);
		const result = await runExporter('a1', cfg);
		expect(result.kind).toBe('ready');
		expect(result.kind === 'ready' && result.filename).toBe('drop.zip');
	});

	it('sends the artifact id in the request body, not the path', async () => {
		let seen: unknown = null;
		server.use(
			http.post(`${BASE}/exports/run`, async ({ request }) => {
				seen = await request.json();
				return new HttpResponse('zip', {
					headers: { 'content-disposition': 'attachment; filename="drop.zip"' }
				});
			})
		);
		await runExporter('art-42', cfg);
		expect(seen).toEqual({ artifact_id: 'art-42' });
	});

	it('falls back to export.zip when content-disposition is missing', async () => {
		server.use(http.post(`${BASE}/exports/run`, () => new HttpResponse('zip')));
		const result = await runExporter('a1', cfg);
		expect(result.kind === 'ready' && result.filename).toBe('export.zip');
	});
});

describe('runExporterDraft', () => {
	it('sends {definition, name} in the request body, with no artifact_id key', async () => {
		let seen: unknown = null;
		server.use(
			http.post(`${BASE}/exports/run`, async ({ request }) => {
				seen = await request.json();
				return new HttpResponse('zip', {
					headers: { 'content-disposition': 'attachment; filename="drop.zip"' }
				});
			})
		);
		const definition = {
			schema_version: 1 as const,
			output: { mode: 'zip' as const, filename: '', manifest: true },
			entries: []
		};
		await runExporterDraft(definition, 'x', cfg);
		expect(seen).toEqual({ definition, name: 'x' });
		expect(seen).not.toHaveProperty('artifact_id');
	});
});
