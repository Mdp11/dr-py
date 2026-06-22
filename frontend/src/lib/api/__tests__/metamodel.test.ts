import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { clearMetamodel, diffMetamodel, getMetamodel, rebindMetamodel, uploadMetamodel } from '../metamodel';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const samplePayload = {
	enums: { Status: ['Draft', 'Approved'] },
	elements: [
		{
			name: 'Block',
			properties: [{ name: 'mass', datatype: 'float' }]
		}
	],
	relationships: [
		{
			name: 'BlockHasPart',
			containment: true,
			source: 'Block',
			target: 'Block'
		}
	]
};

describe('metamodel client', () => {
	it('getMetamodel parses a Metamodel payload', async () => {
		server.use(http.get(`${BASE}/metamodel`, () => HttpResponse.json(samplePayload)));
		const result = await getMetamodel(cfg);
		expect(result.elements[0].name).toBe('Block');
		expect(result.elements[0].abstract).toBe(false);
		expect(result.elements[0].properties[0].multiplicity).toBe('0..1');
		expect(result.relationships[0].containment).toBe(true);
		expect(result.enums.Status).toEqual(['Draft', 'Approved']);
	});

	it('getMetamodel parses relationship mappings', async () => {
		const payload = {
			elements: [{ name: 'Block' }, { name: 'System' }, { name: 'Doc' }],
			relationships: [
				{
					name: 'Refers',
					source: 'Block',
					target: 'Doc',
					mappings: [
						{ source: 'Block', target: 'Doc' },
						{ source: 'System', target: 'Doc' }
					]
				}
			]
		};
		server.use(http.get(`${BASE}/metamodel`, () => HttpResponse.json(payload)));
		const result = await getMetamodel(cfg);
		expect(result.relationships[0].mappings).toEqual([
			{ source: 'Block', target: 'Doc' },
			{ source: 'System', target: 'Doc' }
		]);
	});

	it('uploadMetamodel with object body sends application/json', async () => {
		let receivedContentType: string | null = null;
		let receivedBody: unknown;
		server.use(
			http.post(`${BASE}/metamodel`, async ({ request }) => {
				receivedContentType = request.headers.get('content-type');
				receivedBody = await request.json();
				return HttpResponse.json(samplePayload);
			})
		);
		const result = await uploadMetamodel({ elements: [], relationships: [] }, cfg);
		expect(receivedContentType).toContain('application/json');
		expect(receivedBody).toEqual({ elements: [], relationships: [] });
		expect(result.elements[0].name).toBe('Block');
	});

	it('uploadMetamodel with string body sends YAML content-type', async () => {
		let receivedContentType: string | null = null;
		let receivedText = '';
		server.use(
			http.post(`${BASE}/metamodel`, async ({ request }) => {
				receivedContentType = request.headers.get('content-type');
				receivedText = await request.text();
				return HttpResponse.json(samplePayload);
			})
		);
		await uploadMetamodel('elements: []\nrelationships: []\n', cfg);
		expect(receivedContentType).toContain('yaml');
		expect(receivedText).toBe('elements: []\nrelationships: []\n');
	});

	it('clearMetamodel issues DELETE and resolves on 204', async () => {
		let called = false;
		server.use(
			http.delete(`${BASE}/metamodel`, () => {
				called = true;
				return new HttpResponse(null, { status: 204 });
			})
		);
		const result = await clearMetamodel(cfg);
		expect(called).toBe(true);
		expect(result).toBeUndefined();
	});
});

const diffPayload = {
	now_failing: [{ severity: 'error', message: 'x is an instance of unknown type', target_ids: ['x'], category: 'conformance' }],
	now_passing: [],
	unchanged_count: 3,
	current_error_count: 3,
	candidate_error_count: 4
};

const rebindPayload = {
	model_rev: 8,
	metamodel_id: 'mm-2',
	validation_error_count: 1,
	issue_counts: { conformance: 1 },
	issues: [{ severity: 'error', message: 'x is an instance of unknown type', target_ids: ['x'], category: 'conformance' }]
};

describe('metamodel swap client', () => {
	it('diffMetamodel posts the blob as YAML and parses the diff', async () => {
		let ct: string | null = null;
		let text = '';
		server.use(
			http.post(`${BASE}/metamodel/diff`, async ({ request }) => {
				ct = request.headers.get('content-type');
				text = await request.text();
				return HttpResponse.json(diffPayload);
			})
		);
		const result = await diffMetamodel('elements: []\n', cfg);
		expect(ct).toContain('yaml');
		expect(text).toBe('elements: []\n');
		expect(result.now_failing[0].target_ids).toEqual(['x']);
		expect(result.unchanged_count).toBe(3);
		expect(result.candidate_error_count).toBe(4);
	});

	it('rebindMetamodel sends base_rev + message as query params', async () => {
		let url: URL | null = null;
		let text = '';
		server.use(
			http.post(`${BASE}/metamodel/rebind`, async ({ request }) => {
				url = new URL(request.url);
				text = await request.text();
				return HttpResponse.json(rebindPayload);
			})
		);
		const result = await rebindMetamodel('elements: []\n', { baseRev: 7, message: 'swap' }, cfg);
		expect(url!.searchParams.get('base_rev')).toBe('7');
		expect(url!.searchParams.get('message')).toBe('swap');
		expect(text).toBe('elements: []\n');
		expect(result.model_rev).toBe(8);
		expect(result.metamodel_id).toBe('mm-2');
		expect(result.issues[0].category).toBe('conformance');
	});
});
