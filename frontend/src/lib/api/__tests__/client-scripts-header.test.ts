import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ApiError, isScriptsNeedEngine } from '../errors';
import { apiFetch, apiUpload, SCRIPTS_ENGINE_ONLY, SCRIPTS_HEADER } from '../client';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('the engine-only scripts header', () => {
	it('names the header and its value', () => {
		expect(SCRIPTS_HEADER).toBe('X-Data-Rover-Scripts');
		expect(SCRIPTS_ENGINE_ONLY).toBe('engine-only');
	});

	it('is sent on a read and on a write', async () => {
		const seen: (string | null)[] = [];
		server.use(
			http.get(`${BASE}/ping`, ({ request }) => {
				seen.push(request.headers.get('x-data-rover-scripts'));
				return HttpResponse.json({});
			}),
			http.post(`${BASE}/ping`, ({ request }) => {
				seen.push(request.headers.get('x-data-rover-scripts'));
				return HttpResponse.json({});
			})
		);
		await apiFetch('/ping', {}, cfg);
		await apiFetch('/ping', { method: 'POST', body: {} }, cfg);
		expect(seen).toEqual(['engine-only', 'engine-only']);
	});

	it('is sent on an upload', async () => {
		let seen: string | null = null;
		server.use(
			http.post(`${BASE}/model/upload`, ({ request }) => {
				seen = request.headers.get('x-data-rover-scripts');
				return HttpResponse.json({});
			})
		);
		await apiUpload('/model/upload', { body: 'x' }, cfg);
		expect(seen).toBe('engine-only');
	});
});

describe('isScriptsNeedEngine', () => {
	it('is true for the 409 the server answers when scripts must run in the engine', () => {
		const detail = 'scripts need the engine';
		expect(isScriptsNeedEngine(new ApiError(409, { detail }, detail))).toBe(true);
	});

	it('is false for another 409, another status, or a non-error', () => {
		expect(isScriptsNeedEngine(new ApiError(409, { detail: 'stale' }, 'stale'))).toBe(false);
		expect(isScriptsNeedEngine(new ApiError(501, null, 'scripts need the engine'))).toBe(false);
		expect(isScriptsNeedEngine(new Error('scripts need the engine'))).toBe(false);
	});
});
