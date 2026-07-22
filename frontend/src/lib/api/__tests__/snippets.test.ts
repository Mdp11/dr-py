import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { cancelSnippet, lintSnippet, runSnippet } from '../snippets';

const BASE = 'http://api.test/api/v1/projects/p1';
const CFG = { baseUrl: BASE };

const RUN_OUT = {
	run_id: 'r-1',
	stdout: 'hello\n',
	result_repr: "'x'",
	ops: [
		{ kind: 'create_element', temp_id: 'tmp_1', type_name: 'Building', properties: { name: 'B' } }
	],
	error: null,
	duration_ms: 12,
	model_rev: 7,
	stale: false,
	truncated: false
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('snippets api', () => {
	it('runs inline code and parses the full response', async () => {
		server.use(
			http.post(`${BASE}/snippets/run`, async ({ request }) => {
				const body = (await request.json()) as Record<string, unknown>;
				expect(body.run_id).toBe('r-1');
				expect(body.code).toBe('print(1)');
				expect(body.entry).toBe('script');
				return HttpResponse.json(RUN_OUT);
			})
		);
		const res = await runSnippet({ run_id: 'r-1', code: 'print(1)', entry: 'script' }, CFG);
		expect(res.stdout).toBe('hello\n');
		expect(res.ops[0].kind).toBe('create_element');
		expect(res.error).toBeNull();
	});

	it('parses an error result', async () => {
		server.use(
			http.post(`${BASE}/snippets/run`, () =>
				HttpResponse.json({
					...RUN_OUT,
					ops: [],
					result_repr: null,
					error: { kind: 'timeout', message: 'wall timeout', traceback: null }
				})
			)
		);
		const res = await runSnippet({ run_id: 'r-1', code: 'while 1: pass' }, CFG);
		expect(res.error?.kind).toBe('timeout');
	});

	it('lints code', async () => {
		server.use(
			http.post(`${BASE}/snippets/lint`, () =>
				HttpResponse.json({
					diagnostics: [
						{
							line: 1,
							col: 0,
							severity: 'warning',
							message: "'os' is not available in the sandbox"
						}
					],
					entry_points: ['script', 'value']
				})
			)
		);
		const res = await lintSnippet('import os', CFG);
		expect(res.diagnostics[0].severity).toBe('warning');
		expect(res.entry_points).toContain('value');
	});

	it('cancels by run id', async () => {
		server.use(
			http.post(`${BASE}/snippets/cancel`, async ({ request }) => {
				const body = (await request.json()) as Record<string, unknown>;
				expect(body.run_id).toBe('r-9');
				return new HttpResponse(null, { status: 204 });
			})
		);
		await cancelSnippet('r-9', CFG);
	});

	it('parses entry_points on artifact headers', async () => {
		const { listArtifacts } = await import('../artifacts');
		server.use(
			http.get(`${BASE}/artifacts`, () =>
				HttpResponse.json({
					items: [
						{
							id: 'a1',
							kind: 'code_snippet',
							name: 's',
							artifact_rev: 1,
							updated_at: '2026-07-17T00:00:00Z',
							updated_by: null,
							entry_points: ['script']
						},
						{
							id: 'a2',
							kind: 'navigation',
							name: 'n',
							artifact_rev: 1,
							updated_at: '2026-07-17T00:00:00Z',
							updated_by: null
						}
					]
				})
			)
		);
		const res = await listArtifacts(undefined, CFG);
		expect(res.items[0].entry_points).toEqual(['script']);
		expect(res.items[1].entry_points).toBeNull();
	});
});

const DOCS_FIXTURE = {
	facade: [
		{
			name: 'dr.create',
			kind: 'function',
			signature: 'dr.create(stereotype, properties=None) -> str (temp id)',
			doc: 'Record a dry-run element create.',
			example: 'tid = dr.create("Building", {"name": "HQ"})'
		},
		{
			name: 'Element.delete',
			kind: 'method',
			signature: 'Element.delete()',
			doc: 'Record a dry-run delete.',
			example: null
		}
	],
	limits: {
		wall_timeout_s: 10,
		memory_bytes: 268435456,
		stdout_bytes: 262144,
		result_repr_bytes: 65536,
		max_ops: 1000,
		max_op_bytes: 1048576,
		page_limit: 500
	},
	notes: ['Runs are dry-run.']
};

describe('getSnippetDocs', () => {
	it('fetches and validates the docs payload', async () => {
		const { getSnippetDocs } = await import('../snippets');
		server.use(http.get(`${BASE}/snippets/docs`, () => HttpResponse.json(DOCS_FIXTURE)));
		const docs = await getSnippetDocs(CFG);
		expect(docs.facade).toHaveLength(2);
		expect(docs.facade[1].example).toBeNull();
		expect(docs.limits.page_limit).toBe(500);
	});
});
