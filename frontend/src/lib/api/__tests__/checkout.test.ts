import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { Op } from '$lib/state/ops';
import { acquireLocks, previewCommit, commitChanges, openProject } from '../checkout';
import { getCurrentUserId } from '../client';
import {
	issuesEngine,
	rename,
	TOO_LONG,
	TOO_LONG_MESSAGE,
	uninstallIssuesEngine
} from './issues-engine';
import { server } from './server';

function jsonFetch(captured: { path?: string; body?: unknown }, payload: unknown) {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		captured.path = String(input);
		captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	};
}

describe('checkout api', () => {
	it('POSTs /locks with targets+intent', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await acquireLocks(
			{ targets: [{ resource_id: 'e1', mode: 'exclusive' }], intent: 'edit', steal: false },
			{ fetch: jsonFetch(cap, { token: 't1', leases: [] }) }
		);
		expect(cap.path).toContain('/locks');
		expect((cap.body as { intent: string }).intent).toBe('edit');
		expect(res.token).toBe('t1');
	});

	it('previewCommit sends base_rev + ops', async () => {
		const cap: { path?: string; body?: unknown } = {};
		await previewCommit(7, [], {
			fetch: jsonFetch(cap, { conformance_error_count: 0, structural_blockers: [], issues: [] })
		});
		expect(cap.path).toContain('/commits/preview');
		expect((cap.body as { base_rev: number }).base_rev).toBe(7);
	});

	it('commitChanges maps camelCase to snake_case body', async () => {
		const cap: { path?: string; body?: unknown } = {};
		await commitChanges(
			{ baseRev: 7, ops: [], message: 'm', lockTokens: ['t1'], ackErrors: true },
			{
				fetch: jsonFetch(cap, {
					model_rev: 8,
					id_map: {},
					changed_elements: [],
					changed_relationships: [],
					deleted_element_ids: [],
					deleted_relationship_ids: [],
					issues_removed_owner_ids: [],
					issues_added: [],
					issue_counts: {},
					commit_id: 'c1',
					message: 'm',
					validation_error_count: 0
				})
			}
		);
		const body = cap.body as Record<string, unknown>;
		expect(body.base_rev).toBe(7);
		expect(body.lock_tokens).toEqual(['t1']);
		expect(body.ack_errors).toBe(true);
	});

	it('commitChanges hands onText the raw response body before it is parsed', async () => {
		const cap: { path?: string; body?: unknown } = {};
		let seenText: string | undefined;
		const res = await commitChanges(
			{ baseRev: 7, ops: [], message: 'm', lockTokens: ['t1'], ackErrors: true },
			{
				fetch: jsonFetch(cap, {
					model_rev: 8,
					prev_rev: 7,
					id_map: {},
					changed_elements: [],
					changed_relationships: [],
					deleted_element_ids: [],
					deleted_relationship_ids: [],
					issues_removed_owner_ids: [],
					issues_added: [],
					issue_counts: {},
					commit_id: 'c1',
					message: 'm',
					validation_error_count: 0
				})
			},
			(text) => {
				seenText = text;
			}
		);
		expect(seenText).toContain('"prev_rev":7');
		expect(res.prev_rev).toBe(7);
	});

	it.each([
		[3, 3],
		[null, null]
	])('commitChanges parses prev_rev: %s', async (sent, expected) => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await commitChanges(
			{ baseRev: 7, ops: [], message: 'm', lockTokens: ['t1'], ackErrors: true },
			{
				fetch: jsonFetch(cap, {
					model_rev: 8,
					prev_rev: sent,
					id_map: {},
					changed_elements: [],
					changed_relationships: [],
					deleted_element_ids: [],
					deleted_relationship_ids: [],
					issues_removed_owner_ids: [],
					issues_added: [],
					issue_counts: {},
					commit_id: 'c1',
					message: 'm',
					validation_error_count: 0
				})
			}
		);
		expect(res.prev_rev).toBe(expected);
	});

	it('commitChanges parses a response with prev_rev absent', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await commitChanges(
			{ baseRev: 7, ops: [], message: 'm', lockTokens: ['t1'], ackErrors: true },
			{
				fetch: jsonFetch(cap, {
					model_rev: 8,
					id_map: {},
					changed_elements: [],
					changed_relationships: [],
					deleted_element_ids: [],
					deleted_relationship_ids: [],
					issues_removed_owner_ids: [],
					issues_added: [],
					issue_counts: {},
					commit_id: 'c1',
					message: 'm',
					validation_error_count: 0
				})
			}
		);
		expect(res.prev_rev).toBeUndefined();
	});

	it('openProject GETs /open', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await openProject({
			fetch: jsonFetch(cap, {
				model_rev: 1,
				role: 'editor',
				element_count: 0,
				relationship_count: 0,
				issue_counts: {},
				lock_ttl_seconds: 300
			})
		});
		expect(cap.path).toContain('/open');
		expect(res.role).toBe('editor');
	});

	it('getCurrentUserId returns empty string until auth store sets it', () => {
		expect(getCurrentUserId()).toBe('');
	});
});

describe('previewCommit on the engine', () => {
	const made: { dispose(): void }[] = [];

	beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
	afterEach(() => {
		uninstallIssuesEngine();
		for (const over of made.splice(0)) over.dispose();
		server.resetHandlers();
		vi.restoreAllMocks();
	});
	afterAll(() => server.close());

	const blocker = {
		severity: 'error',
		message: 'Element e_000003 has 2 containment parents (must have at most one)',
		target_ids: ['e_000003'],
		category: 'structural',
		origin: 'on_server'
	};
	const tooLong = {
		severity: 'error',
		message: TOO_LONG_MESSAGE,
		target_ids: ['e_000001'],
		category: 'conformance',
		origin: 'on_server'
	};
	const artifactOp: Op = {
		kind: 'create_artifact',
		temp_id: 'tmp_a',
		artifact_kind: 'navigation',
		name: 'n',
		payload: {}
	};

	/** A staged violation in the replica: its ops and the batch they are. */
	async function staged(engine: Awaited<ReturnType<typeof issuesEngine>>) {
		const ops = [rename('e_000001', TOO_LONG)];
		return { ops, batchIds: [await engine.stage(ops)] };
	}

	it("model ops alone are the engine's answer", async () => {
		const engine = await issuesEngine(made);
		const { ops, batchIds } = await staged(engine);

		await expect(previewCommit(0, ops, undefined, { strict: false, batchIds })).resolves.toEqual({
			conformance_error_count: 1,
			structural_blockers: [],
			issues: [tooLong],
			would_block: false
		});
		expect(engine.requests).toEqual([]);
	});

	it('strict reaches the engine', async () => {
		const engine = await issuesEngine(made);
		const { ops, batchIds } = await staged(engine);

		const preview = await previewCommit(0, ops, undefined, { strict: true, batchIds });

		expect(preview.would_block).toBe(true);
		expect(
			engine.over.calls.filter((call) => call.method === 'previewCommit').map((c) => c.params)
		).toEqual([{ base_rev: 0, batch_ids: batchIds, strict: true }]);
		expect(engine.requests).toEqual([]);
	});

	it('with an artifact op the server previews that op alone, and the halves are summed', async () => {
		const engine = await issuesEngine(made);
		const { ops, batchIds } = await staged(engine);
		const bodies: unknown[] = [];
		server.use(
			http.post(`${engine.project.baseUrl}/commits/preview`, async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json({
					conformance_error_count: 2,
					structural_blockers: [blocker],
					issues: [blocker],
					would_block: true
				});
			})
		);

		const preview = await previewCommit(0, [...ops, artifactOp], undefined, {
			strict: false,
			batchIds
		});

		expect(bodies).toEqual([{ base_rev: 0, ops: [artifactOp] }]);
		expect(preview).toEqual({
			conformance_error_count: 3,
			structural_blockers: [blocker],
			issues: [tooLong, blocker],
			would_block: true
		});
	});

	it('a rebind sends every op to the server', async () => {
		const engine = await issuesEngine(made);
		const { ops, batchIds } = await staged(engine);
		const all: Op[] = [{ kind: 'metamodel.rebind', blob: 'x' }, ...ops, artifactOp];

		await previewCommit(0, all, undefined, { strict: false, batchIds });

		expect(engine.requests).toEqual([{ route: 'preview', body: { base_rev: 0, ops: all } }]);
	});

	it('without the staged batches named, the server previews every op', async () => {
		const engine = await issuesEngine(made);
		const { ops } = await staged(engine);

		await previewCommit(0, ops);

		expect(engine.requests).toEqual([{ route: 'preview', body: { base_rev: 0, ops } }]);
	});

	it('stale staged batches, or a stale base_rev, send every op to the server', async () => {
		const engine = await issuesEngine(made);
		const { ops, batchIds } = await staged(engine);
		const all = [...ops, artifactOp];

		await previewCommit(0, all, undefined, { strict: false, batchIds: [batchIds[0]! + 1] });
		await previewCommit(1, all, undefined, { strict: false, batchIds });

		expect(engine.requests).toEqual([
			{ route: 'preview', body: { base_rev: 0, ops: all } },
			{ route: 'preview', body: { base_rev: 1, ops: all } }
		]);
	});
});
