import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './server';
import { lintSnippet, runSnippet } from '../snippets';
import { ApiError } from '../errors';
import type { ReplicaSync } from '$lib/engine/sync';
import { configureReplica, resetReplica } from '$lib/state/replica.svelte';

const BASE = 'http://api.test/api/v1/projects/p1';
const CFG = { baseUrl: BASE };

const RUN_OUT = {
	stdout: 'hello\n',
	result_repr: "'x'",
	ops: [
		{ kind: 'create_element', temp_id: 'tmp_1', type_name: 'Building', properties: { name: 'B' } }
	],
	error: null,
	truncated: false,
	duration_ms: 12,
	stamp: { rev: 7, staged: 1 }
};

/** The engine boundary: a sync whose `call` answers `answer`. */
function engineAnswering(answer: () => Promise<unknown>) {
	const call = vi.fn<(method: string, params?: unknown, options?: unknown) => Promise<unknown>>(
		() => answer()
	);
	configureReplica({ sync: { call, stop() {} } as unknown as ReplicaSync });
	return call;
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
	server.resetHandlers();
	resetReplica();
});
afterAll(() => server.close());

describe('snippets api', () => {
	it("runs inline code on the engine with the run's signal", async () => {
		const call = engineAnswering(() => Promise.resolve(RUN_OUT));
		const controller = new AbortController();
		const res = await runSnippet(
			{ code: 'print(1)', entry: 'value', element_ids: ['e1'] },
			{ signal: controller.signal }
		);
		expect(call).toHaveBeenCalledWith(
			'runSnippet',
			{ code: 'print(1)', entry: 'value', element_ids: ['e1'] },
			{ signal: controller.signal }
		);
		expect(res.stdout).toBe('hello\n');
		expect(res.stamp).toEqual({ rev: 7, staged: 1 });
		expect(res.ops[0].kind).toBe('create_element');
	});

	it('defaults to the script entry over no elements', async () => {
		const call = engineAnswering(() => Promise.resolve(RUN_OUT));
		await runSnippet({ artifact_id: 'a1' });
		expect(call.mock.calls[0]?.[1]).toEqual({
			artifact_id: 'a1',
			entry: 'script',
			element_ids: []
		});
	});

	it('rejects when the engine refuses the call', async () => {
		engineAnswering(() => Promise.reject(new ApiError(422, { detail: 'bad' }, 'bad')));
		await expect(runSnippet({ code: 'x' })).rejects.toMatchObject({ status: 422 });
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
		stdout_chars: 262144,
		result_repr_chars: 65536,
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
