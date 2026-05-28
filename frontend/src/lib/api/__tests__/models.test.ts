import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import {
	createModel,
	deleteModel,
	getModel,
	listModels,
	snapshotModel
} from '../models';
import { ConflictError } from '../errors';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('models client', () => {
	it('listModels returns ModelRef[]', async () => {
		server.use(
			http.get(`${BASE}/models`, () =>
				HttpResponse.json([
					{ name: 'm1', metamodel: 'mm1' },
					{ name: 'm2', metamodel: 'mm2' }
				])
			)
		);
		const result = await listModels(cfg);
		expect(result).toEqual([
			{ name: 'm1', metamodel: 'mm1' },
			{ name: 'm2', metamodel: 'mm2' }
		]);
	});

	it('createModel POSTs JSON body and parses ModelOut', async () => {
		let receivedBody: unknown;
		server.use(
			http.post(`${BASE}/models`, async ({ request }) => {
				receivedBody = await request.json();
				return HttpResponse.json(
					{
						name: 'foo',
						metamodel: 'mm',
						rev: 0,
						elements: [],
						relationships: []
					},
					{ status: 201 }
				);
			})
		);
		const result = await createModel({ name: 'foo', metamodel: 'mm' }, cfg);
		expect(receivedBody).toEqual({ name: 'foo', metamodel: 'mm' });
		expect(result.name).toBe('foo');
		expect(result.rev).toBe(0);
	});

	it('getModel parses ModelOut with elements/relationships', async () => {
		server.use(
			http.get(`${BASE}/models/foo`, () =>
				HttpResponse.json({
					name: 'foo',
					metamodel: 'mm',
					rev: 3,
					elements: [
						{ id: 'e1', type_name: 'Block', properties: { x: 1 }, rev: 1 }
					],
					relationships: [
						{
							id: 'r1',
							type_name: 'Conn',
							source_id: 'e1',
							target_id: 'e1',
							properties: {},
							rev: 1
						}
					]
				})
			)
		);
		const result = await getModel('foo', cfg);
		expect(result.rev).toBe(3);
		expect(result.elements).toHaveLength(1);
		expect(result.relationships[0].source_id).toBe('e1');
	});

	it('deleteModel resolves on 204', async () => {
		server.use(
			http.delete(`${BASE}/models/foo`, () => new HttpResponse(null, { status: 204 }))
		);
		await expect(deleteModel('foo', cfg)).resolves.toBeUndefined();
	});

	it('snapshotModel returns new rev on success', async () => {
		let receivedBody: unknown;
		server.use(
			http.put(`${BASE}/models/foo/snapshot`, async ({ request }) => {
				receivedBody = await request.json();
				return HttpResponse.json({ rev: 5 });
			})
		);
		const result = await snapshotModel(
			'foo',
			{ rev: 4, elements: [], relationships: [] },
			cfg
		);
		expect(receivedBody).toEqual({ rev: 4, elements: [], relationships: [] });
		expect(result).toEqual({ rev: 5 });
	});

	it('snapshotModel throws ConflictError on 409 preserving server envelope', async () => {
		const conflictBody = { error: 'rev mismatch: expected 7, got 4' };
		server.use(
			http.put(`${BASE}/models/foo/snapshot`, () =>
				HttpResponse.json(conflictBody, { status: 409 })
			)
		);
		try {
			await snapshotModel(
				'foo',
				{ rev: 4, elements: [], relationships: [] },
				cfg
			);
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(ConflictError);
			const e = err as ConflictError;
			expect(e.status).toBe(409);
			expect(e.body).toEqual(conflictBody);
			expect(e.message).toBe(conflictBody.error);
		}
	});
});
