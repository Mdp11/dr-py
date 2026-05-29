import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { applyCr } from '../changeRequest';
import { server } from './server';
import type { ChangeRequest } from '$lib/state/cr';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const minimalCr: ChangeRequest = {
	format: 'datarover.cr/v1',
	createdAt: '2026-01-01T00:00:00.000Z',
	baseline: { filename: null, elementCount: 0, relationshipCount: 0 },
	ops: {
		elements: { added: [], modified: [], deleted: [] },
		relationships: { added: [], modified: [], deleted: [] }
	}
};

const minimalModel = { elements: [], relationships: [] };

describe('applyCr API client', () => {
	it('200 → returns ok:true with parsed model and issues', async () => {
		server.use(
			http.post(`${BASE}/model/apply-cr`, () =>
				HttpResponse.json({
					model: {
						elements: [{ id: 'e1', type_name: 'Block', properties: {}, rev: 1 }],
						relationships: []
					},
					issues: [{ severity: 'warning', message: 'heads up', target_ids: ['e1'] }]
				})
			)
		);

		const res = await applyCr(minimalModel, minimalCr, cfg);

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.model.elements[0].id).toBe('e1');
		expect(res.issues[0].message).toBe('heads up');
	});

	it('409 → returns ok:false with conflicts array', async () => {
		server.use(
			http.post(`${BASE}/model/apply-cr`, () =>
				HttpResponse.json(
					{ conflicts: [{ kind: 'id_exists', entity: 'element', id: 'e1', reason: 'dup' }] },
					{ status: 409 }
				)
			)
		);

		const res = await applyCr(minimalModel, minimalCr, cfg);

		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.conflicts[0].kind).toBe('id_exists');
	});
});
