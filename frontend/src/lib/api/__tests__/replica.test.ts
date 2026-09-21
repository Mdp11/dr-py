import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse, delay } from 'msw';

import {
	fetchMetamodelDocument,
	fetchSnapshot,
	fetchTail,
	getSnapshotDescriptor
} from '../replica';
import { ApiError } from '../errors';
import { server } from './server';

const BASE = 'http://api.test/api/v1/projects/p1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const descriptorBody = {
	rev: 7,
	metamodel_id: 'mm-1',
	state_digest: 'abc123',
	elements: 10,
	relationships: 3,
	url: '/api/v1/projects/p1/replica/snapshots/7'
};

describe('getSnapshotDescriptor', () => {
	it('parses the descriptor', async () => {
		server.use(http.get(`${BASE}/replica/snapshot`, () => HttpResponse.json(descriptorBody)));
		const descriptor = await getSnapshotDescriptor(cfg);
		expect(descriptor).toEqual(descriptorBody);
	});

	it('is null on a 404 ("No model loaded")', async () => {
		server.use(
			http.get(`${BASE}/replica/snapshot`, () =>
				HttpResponse.json({ detail: 'No model loaded' }, { status: 404 })
			)
		);
		const descriptor = await getSnapshotDescriptor(cfg);
		expect(descriptor).toBeNull();
	});

	it('throws an ApiError on a 503 (store unavailable)', async () => {
		server.use(
			http.get(`${BASE}/replica/snapshot`, () =>
				HttpResponse.json({ detail: 'snapshot store unavailable' }, { status: 503 })
			)
		);
		const err = await getSnapshotDescriptor(cfg).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(503);
	});
});

describe('fetchSnapshot', () => {
	// happy-dom's default location is http://localhost:3000/, so a relative
	// path (the descriptor's `url`, a whole path) resolves against THAT origin
	// when called with baseUrl: '' — the handler is registered there.
	const PAGE_ORIGIN = 'http://localhost:3000';

	it('requests exactly the descriptor path on the page origin, streaming the body', async () => {
		const path = '/api/v1/projects/p1/replica/snapshots/7';
		let requestedUrl = '';
		server.use(
			http.get(`${PAGE_ORIGIN}${path}`, ({ request }) => {
				requestedUrl = request.url;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array([1, 2, 3]));
						controller.enqueue(new Uint8Array([4, 5]));
						controller.close();
					}
				});
				return new HttpResponse(stream, { headers: { 'Content-Length': '5' } });
			})
		);
		const response = await fetchSnapshot(path);
		expect(requestedUrl).toBe(`${PAGE_ORIGIN}${path}`);
		expect(response.headers.get('Content-Length')).toBe('5');
		const reader = response.body!.getReader();
		const chunks: number[][] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(Array.from(value));
		}
		expect(chunks).toEqual([
			[1, 2, 3],
			[4, 5]
		]);
	});

	it('rejects with AbortError when the signal is already aborted', async () => {
		const path = '/api/v1/projects/p1/replica/snapshots/7';
		server.use(
			http.get(`${PAGE_ORIGIN}${path}`, async () => {
				await delay(50);
				return new HttpResponse(new Uint8Array([1]));
			})
		);
		const controller = new AbortController();
		controller.abort();
		await expect(fetchSnapshot(path, controller.signal)).rejects.toMatchObject({
			name: 'AbortError'
		});
	});
});

describe('fetchTail', () => {
	it('sends from_rev and returns the text untouched alongside the envelope (complete)', async () => {
		let requestedUrl = '';
		const bodyText =
			'{"from_rev":5,"head_rev":6,"complete":true,"deltas":[{"rev":6,"changed_elements":[{"id":"a","type_name":"T","properties":{"x":1.0},"rev":1}]}]}';
		server.use(
			http.get(`${BASE}/replica/tail`, ({ request }) => {
				requestedUrl = request.url;
				return HttpResponse.text(bodyText, {
					headers: { 'content-type': 'application/json' }
				});
			})
		);
		const tail = await fetchTail(5, cfg);
		expect(requestedUrl).toContain('from_rev=5');
		expect(tail.text).toBe(bodyText);
		expect(tail.text).toContain('"x":1.0');
		expect(tail.fromRev).toBe(5);
		expect(tail.headRev).toBe(6);
		expect(tail.complete).toBe(true);
	});

	it('returns the envelope for an incomplete tail', async () => {
		const bodyText = '{"from_rev":5,"head_rev":2005,"complete":false,"deltas":[]}';
		server.use(
			http.get(`${BASE}/replica/tail`, () =>
				HttpResponse.text(bodyText, { headers: { 'content-type': 'application/json' } })
			)
		);
		const tail = await fetchTail(5, cfg);
		expect(tail.text).toBe(bodyText);
		expect(tail.complete).toBe(false);
		expect(tail.headRev).toBe(2005);
	});
});

describe('fetchMetamodelDocument', () => {
	it('returns the header id and the document as JSON.parse gives it', async () => {
		const doc = { element_types: [{ name: 'Block', unknownToZod: true }], extraTopLevel: 1 };
		server.use(
			http.get(`${BASE}/metamodel`, () =>
				HttpResponse.json(doc, { headers: { 'X-Metamodel-Id': 'mm-9' } })
			)
		);
		const result = await fetchMetamodelDocument(cfg);
		expect(result.metamodelId).toBe('mm-9');
		expect(result.doc).toEqual(doc);
	});

	it('is "" without the header', async () => {
		const doc = { element_types: [] };
		server.use(http.get(`${BASE}/metamodel`, () => HttpResponse.json(doc)));
		const result = await fetchMetamodelDocument(cfg);
		expect(result.metamodelId).toBe('');
	});
});
