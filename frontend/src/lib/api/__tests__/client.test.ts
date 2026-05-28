import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';

import { apiFetch } from '../client';
import {
	ApiError,
	ConflictError,
	NotFoundError,
	ValidationError
} from '../errors';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('apiFetch', () => {
	it('parses and validates a successful JSON response via zod schema', async () => {
		const schema = z.object({ ok: z.boolean(), n: z.number() });
		server.use(
			http.get(`${BASE}/thing`, () => HttpResponse.json({ ok: true, n: 7 }))
		);
		const result = await apiFetch('/thing', { method: 'GET', schema }, cfg);
		expect(result).toEqual({ ok: true, n: 7 });
	});

	it('JSON-stringifies object bodies and sets Content-Type', async () => {
		let receivedBody: unknown;
		let receivedContentType: string | null = null;
		server.use(
			http.post(`${BASE}/echo`, async ({ request }) => {
				receivedContentType = request.headers.get('content-type');
				receivedBody = await request.json();
				return HttpResponse.json({ echoed: receivedBody });
			})
		);
		await apiFetch(
			'/echo',
			{ method: 'POST', body: { hello: 'world' } as unknown as BodyInit },
			cfg
		);
		expect(receivedBody).toEqual({ hello: 'world' });
		expect(receivedContentType).toContain('application/json');
	});

	it('returns undefined for 204 No Content', async () => {
		server.use(
			http.delete(`${BASE}/x`, () => new HttpResponse(null, { status: 204 }))
		);
		const result = await apiFetch<void>('/x', { method: 'DELETE' }, cfg);
		expect(result).toBeUndefined();
	});

	it('throws NotFoundError on 404 with parsed error body', async () => {
		server.use(
			http.get(`${BASE}/missing`, () =>
				HttpResponse.json({ error: 'No model named foo' }, { status: 404 })
			)
		);
		await expect(apiFetch('/missing', { method: 'GET' }, cfg)).rejects.toMatchObject(
			{
				name: 'NotFoundError',
				status: 404,
				message: 'No model named foo',
				body: { error: 'No model named foo' }
			}
		);
		await expect(apiFetch('/missing', { method: 'GET' }, cfg)).rejects.toBeInstanceOf(
			NotFoundError
		);
	});

	it('throws ConflictError on 409 preserving the body envelope', async () => {
		const conflictBody = { error: 'rev mismatch: expected 2, got 1' };
		server.use(
			http.put(`${BASE}/c`, () => HttpResponse.json(conflictBody, { status: 409 }))
		);
		try {
			await apiFetch('/c', { method: 'PUT' }, cfg);
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(ConflictError);
			const e = err as ConflictError;
			expect(e.status).toBe(409);
			expect(e.body).toEqual(conflictBody);
			expect(e.message).toBe(conflictBody.error);
		}
	});

	it('throws ValidationError on 422', async () => {
		server.use(
			http.post(`${BASE}/v`, () =>
				HttpResponse.json({ error: 'bad input' }, { status: 422 })
			)
		);
		await expect(apiFetch('/v', { method: 'POST' }, cfg)).rejects.toBeInstanceOf(
			ValidationError
		);
	});

	it('throws plain ApiError on 500', async () => {
		server.use(
			http.get(`${BASE}/boom`, () =>
				HttpResponse.json({ message: 'kaboom' }, { status: 500 })
			)
		);
		try {
			await apiFetch('/boom', { method: 'GET' }, cfg);
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			const e = err as ApiError;
			expect(e.status).toBe(500);
			expect(e.message).toBe('kaboom');
		}
	});

	it('falls back to "HTTP {status}" when body has no message keys', async () => {
		server.use(
			http.get(`${BASE}/bare`, () => new HttpResponse('', { status: 503 }))
		);
		try {
			await apiFetch('/bare', { method: 'GET' }, cfg);
			throw new Error('expected throw');
		} catch (err) {
			expect((err as ApiError).message).toBe('HTTP 503');
		}
	});

	it('builds query string from query option and omits undefined values', async () => {
		let receivedUrl = '';
		server.use(
			http.get(`${BASE}/q`, ({ request }) => {
				receivedUrl = request.url;
				return HttpResponse.json([]);
			})
		);
		await apiFetch(
			'/q',
			{
				method: 'GET',
				query: { type: 'Block', source_id: undefined, target_id: 'x' }
			},
			cfg
		);
		expect(receivedUrl).toContain('type=Block');
		expect(receivedUrl).toContain('target_id=x');
		expect(receivedUrl).not.toContain('source_id');
	});
});
