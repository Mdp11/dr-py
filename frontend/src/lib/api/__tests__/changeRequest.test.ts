import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { compareModel, proposeCr } from '../changeRequest';
import { server } from './server';
import type { ChangeRequest } from '$lib/state/cr';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const emptyCr: ChangeRequest = {
	format: 'datarover.cr/v1',
	createdAt: '2026-01-01T00:00:00.000Z',
	baseline: { filename: null, elementCount: 0, relationshipCount: 0 },
	ops: {
		elements: { added: [], modified: [], deleted: [] },
		relationships: { added: [], modified: [], deleted: [] }
	}
};

const crDoc = {
	...emptyCr,
	ops: {
		elements: {
			added: [{ id: 'n1', type_name: 'Item', properties: { name: 'N' }, rev: 0 }],
			modified: [],
			deleted: []
		},
		relationships: { added: [], modified: [], deleted: [] }
	}
};

describe('proposeCr', () => {
	it('posts the ordered list and returns ok with cr + ops', async () => {
		let sent: unknown = null;
		server.use(
			http.post(`${BASE}/model/apply-cr`, async ({ request }) => {
				sent = await request.json();
				return HttpResponse.json({
					model_rev: 4,
					cr: crDoc,
					ops: [
						{
							kind: 'create_element',
							temp_id: 'tmp_1',
							id: 'n1',
							type_name: 'Item',
							properties: { name: 'N' }
						}
					]
				});
			})
		);
		const res = await proposeCr([emptyCr, crDoc], cfg);
		expect(sent).toEqual({ crs: [emptyCr, crDoc] });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.modelRev).toBe(4);
		expect(res.cr.ops.elements.added[0].id).toBe('n1');
		expect(res.ops[0]).toMatchObject({ kind: 'create_element', id: 'n1' });
	});

	it('409 → ok:false with crIndex and conflicts', async () => {
		server.use(
			http.post(`${BASE}/model/apply-cr`, () =>
				HttpResponse.json(
					{
						cr_index: 1,
						model_rev: 4,
						conflicts: [{ kind: 'missing', entity: 'element', id: 'zzz', reason: 'gone' }]
					},
					{ status: 409 }
				)
			)
		);
		const res = await proposeCr([emptyCr, emptyCr], cfg);
		expect(res).toEqual({
			ok: false,
			modelRev: 4,
			crIndex: 1,
			conflicts: [{ kind: 'missing', entity: 'element', id: 'zzz', reason: 'gone' }]
		});
	});

	it('422 propagates as an error', async () => {
		server.use(
			http.post(`${BASE}/model/apply-cr`, () =>
				HttpResponse.json({ detail: 'Unknown element type' }, { status: 422 })
			)
		);
		await expect(proposeCr([emptyCr], cfg)).rejects.toThrow(/Unknown element type/);
	});
});

describe('compareModel', () => {
	it('streams the file as the raw body and parses the response', async () => {
		let bodyText = '';
		server.use(
			http.post(`${BASE}/model/compare`, async ({ request }) => {
				bodyText = await request.text();
				return HttpResponse.json({
					model_rev: 2,
					cr: crDoc,
					other_element_count: 3,
					other_relationship_count: 1
				});
			})
		);
		const file = new Blob(['{"elements":[],"relationships":[]}'], { type: 'application/json' });
		const res = await compareModel(file, cfg);
		expect(bodyText).toBe('{"elements":[],"relationships":[]}');
		expect(res.other_element_count).toBe(3);
		expect(res.cr.ops.elements.added[0].id).toBe('n1');
	});
});
