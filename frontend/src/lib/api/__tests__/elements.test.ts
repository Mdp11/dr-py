import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import {
	createElement,
	deleteElement,
	getElement,
	listElements,
	patchElement
} from '../elements';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const sampleElement = {
	id: 'e1',
	type_name: 'Block',
	properties: { name: 'A' },
	rev: 1
};

describe('elements client', () => {
	it('listElements forwards type filter as query param', async () => {
		let url = '';
		server.use(
			http.get(`${BASE}/model/elements`, ({ request }) => {
				url = request.url;
				return HttpResponse.json([sampleElement]);
			})
		);
		const result = await listElements({ type: 'Block' }, cfg);
		expect(url).toContain('type=Block');
		expect(result).toEqual([sampleElement]);
	});

	it('listElements without filters sends no query string', async () => {
		let url = '';
		server.use(
			http.get(`${BASE}/model/elements`, ({ request }) => {
				url = request.url;
				return HttpResponse.json([]);
			})
		);
		await listElements(undefined, cfg);
		expect(url).not.toContain('?');
	});

	it('createElement POSTs the payload and returns parsed Element', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/model/elements`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json(sampleElement, { status: 201 });
			})
		);
		const result = await createElement(
			{ type: 'Block', properties: { name: 'A' } },
			cfg
		);
		expect(body).toEqual({ type: 'Block', properties: { name: 'A' } });
		expect(result.id).toBe('e1');
	});

	it('getElement fetches by id', async () => {
		server.use(http.get(`${BASE}/model/elements/e1`, () => HttpResponse.json(sampleElement)));
		const result = await getElement('e1', cfg);
		expect(result.properties.name).toBe('A');
	});

	it('patchElement PATCHes properties', async () => {
		let method = '';
		let body: unknown;
		server.use(
			http.patch(`${BASE}/model/elements/e1`, async ({ request }) => {
				method = request.method;
				body = await request.json();
				return HttpResponse.json({
					...sampleElement,
					properties: { name: 'B' },
					rev: 2
				});
			})
		);
		const result = await patchElement('e1', { properties: { name: 'B' } }, cfg);
		expect(method).toBe('PATCH');
		expect(body).toEqual({ properties: { name: 'B' } });
		expect(result.rev).toBe(2);
	});

	it('deleteElement resolves on 204', async () => {
		server.use(
			http.delete(`${BASE}/model/elements/e1`, () => new HttpResponse(null, { status: 204 }))
		);
		await expect(deleteElement('e1', cfg)).resolves.toBeUndefined();
	});
});
