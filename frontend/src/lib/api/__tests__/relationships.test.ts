import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import {
	createRelationship,
	deleteRelationship,
	listRelationships
} from '../relationships';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const sampleRel = {
	id: 'r1',
	type_name: 'Conn',
	source_id: 's1',
	target_id: 't1',
	properties: {},
	rev: 1
};

describe('relationships client', () => {
	it('listRelationships passes multiple filters as query params', async () => {
		let url = '';
		server.use(
			http.get(`${BASE}/models/m/relationships`, ({ request }) => {
				url = request.url;
				return HttpResponse.json([sampleRel]);
			})
		);
		const result = await listRelationships(
			'm',
			{ type: 'Conn', source_id: 's1', target_id: 't1' },
			cfg
		);
		expect(url).toContain('type=Conn');
		expect(url).toContain('source_id=s1');
		expect(url).toContain('target_id=t1');
		expect(result).toEqual([sampleRel]);
	});

	it('listRelationships omits undefined filters from the query string', async () => {
		let url = '';
		server.use(
			http.get(`${BASE}/models/m/relationships`, ({ request }) => {
				url = request.url;
				return HttpResponse.json([]);
			})
		);
		await listRelationships('m', { source_id: 's1' }, cfg);
		expect(url).toContain('source_id=s1');
		expect(url).not.toContain('type=');
		expect(url).not.toContain('target_id=');
	});

	it('createRelationship POSTs payload and parses Relationship', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/models/m/relationships`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json(sampleRel, { status: 201 });
			})
		);
		const result = await createRelationship(
			'm',
			{ type: 'Conn', source_id: 's1', target_id: 't1' },
			cfg
		);
		expect(body).toEqual({ type: 'Conn', source_id: 's1', target_id: 't1' });
		expect(result.id).toBe('r1');
	});

	it('deleteRelationship issues DELETE and resolves on 204', async () => {
		let called = false;
		server.use(
			http.delete(`${BASE}/models/m/relationships/r1`, () => {
				called = true;
				return new HttpResponse(null, { status: 204 });
			})
		);
		await expect(deleteRelationship('m', 'r1', cfg)).resolves.toBeUndefined();
		expect(called).toBe(true);
	});
});
