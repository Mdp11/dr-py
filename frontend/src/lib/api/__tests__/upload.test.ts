import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

	// MSW cannot fire XHR 'abort'/'timeout' events, so these two use a minimal
	// stub: without listeners for them the returned promise would simply never
	// settle (the latent hang this guards against).
	class FakeXHR {
		static last: FakeXHR | null = null;
		upload = { addEventListener: (): void => {} };
		withCredentials = false;
		status = 0;
		responseText = '';
		private listeners = new Map<string, () => void>();
		constructor() {
			FakeXHR.last = this;
		}
		open(): void {}
		setRequestHeader(): void {}
		addEventListener(type: string, fn: () => void): void {
			this.listeners.set(type, fn);
		}
		send(): void {}
		fire(type: string): boolean {
			const fn = this.listeners.get(type);
			fn?.();
			return fn !== undefined;
		}
	}

	it('rejects when the upload is aborted', async () => {
		vi.stubGlobal('XMLHttpRequest', FakeXHR);
		try {
			const p = apiUpload('/model/upload', { body: 'x' }, cfg);
			expect(FakeXHR.last?.fire('abort')).toBe(true);
			await expect(p).rejects.toThrow(/aborted/i);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('rejects when the upload times out', async () => {
		vi.stubGlobal('XMLHttpRequest', FakeXHR);
		try {
			const p = apiUpload('/model/upload', { body: 'x' }, cfg);
			expect(FakeXHR.last?.fire('timeout')).toBe(true);
			await expect(p).rejects.toThrow(/timed out/i);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
