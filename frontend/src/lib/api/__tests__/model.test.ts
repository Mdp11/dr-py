import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { getModel } from '../model';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const sampleModel = {
	elements: [{ id: 'e1', type_name: 'Block', properties: { x: 1 }, rev: 1 }],
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
};

describe('model client', () => {
	it('getModel parses ModelOut with elements/relationships', async () => {
		server.use(http.get(`${BASE}/model`, () => HttpResponse.json(sampleModel)));
		const result = await getModel(cfg);
		expect(result.elements).toHaveLength(1);
		expect(result.relationships[0].source_id).toBe('e1');
	});

	it('getModel rejects on a schema mismatch', async () => {
		server.use(http.get(`${BASE}/model`, () => HttpResponse.json({ elements: 'nope' })));
		await expect(getModel(cfg)).rejects.toThrow();
	});
});
