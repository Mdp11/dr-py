import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fakeProject } from '$lib/engine/__tests__/support/project-server';
import type { ModelOp, Op } from '$lib/state/ops';
import { acquireLocks, previewCommit, commitChanges, openProject } from '../checkout';
import { getCurrentUserId } from '../client';
import { ConflictError, ValidationError } from '../errors';
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
			{
				baseRev: 7,
				ops: [],
				message: 'm',
				lockTokens: ['t1'],
				ackErrors: true,
				validationErrorCount: 2,
				issues: []
			},
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
		expect(body.validation_error_count).toBe(2);
		expect(body.issues).toEqual([]);
	});

	it('commitChanges hands onText the raw response body before it is parsed', async () => {
		const cap: { path?: string; body?: unknown } = {};
		let seenText: string | undefined;
		const res = await commitChanges(
			{
				baseRev: 7,
				ops: [],
				message: 'm',
				lockTokens: ['t1'],
				ackErrors: true,
				validationErrorCount: 2,
				issues: []
			},
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
			{
				baseRev: 7,
				ops: [],
				message: 'm',
				lockTokens: ['t1'],
				ackErrors: true,
				validationErrorCount: 2,
				issues: []
			},
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
			{
				baseRev: 7,
				ops: [],
				message: 'm',
				lockTokens: ['t1'],
				ackErrors: true,
				validationErrorCount: 2,
				issues: []
			},
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

	describe('with a rebind', () => {
		const rebind: Op = { kind: 'metamodel.rebind', blob: '# candidate\n' };
		const moveNode: Op = { kind: 'metamodel.move_node', node: 'Organization', pos: { x: 1, y: 2 } };

		it('previews locally under the linted document, the move_node rest merged from the server', async () => {
			const project = fakeProject();
			const engine = await issuesEngine(made, {
				project,
				lint: () => ({ ok: true, errors: [], document: project.doc })
			});
			const { ops, batchIds } = await staged(engine);
			const bodies: unknown[] = [];
			server.use(
				http.post(`${project.baseUrl}/commits/preview`, async ({ request }) => {
					bodies.push(await request.json());
					return HttpResponse.json({
						conformance_error_count: 2,
						structural_blockers: [blocker],
						issues: [blocker],
						would_block: true
					});
				})
			);

			const preview = await previewCommit(0, [rebind, ...ops, moveNode], undefined, {
				strict: true,
				batchIds
			});

			expect(
				engine.over.calls.filter((call) => call.method === 'previewCommit').map((c) => c.params)
			).toEqual([
				{ base_rev: 0, batch_ids: batchIds, strict: true, rebind: { metamodel: project.doc } }
			]);
			expect(bodies).toEqual([{ base_rev: 0, ops: [moveNode] }]);
			expect(engine.requests).toEqual([{ route: 'lint', body: rebind.blob }]);
			expect(preview).toEqual({
				conformance_error_count: 3,
				structural_blockers: [blocker],
				issues: [tooLong, blocker],
				would_block: true
			});
		});

		it("the candidate is the lint's document", async () => {
			const engine = await issuesEngine(made);
			const { ops, batchIds } = await staged(engine);

			const preview = await previewCommit(0, [rebind, ...ops], undefined, {
				strict: false,
				batchIds
			});

			expect(preview.issues).not.toContainEqual(tooLong);
			expect(preview.would_block).toBe(false);
			expect(engine.requests).toEqual([{ route: 'lint', body: rebind.blob }]);
		});

		it("without the staged batches named it is the server's whole", async () => {
			const engine = await issuesEngine(made);
			const { ops } = await staged(engine);
			const all = [rebind, ...ops, moveNode];

			await previewCommit(0, all);

			expect(engine.requests).toEqual([{ route: 'preview', body: { base_rev: 0, ops: all } }]);
			expect(engine.over.methods()).not.toContain('previewCommit');
		});

		it("an invalid blob answers the server's 422", async () => {
			const engine = await issuesEngine(made, {
				lint: () => ({ ok: false, errors: [{ message: 'bad', line: 1, column: 1 }] })
			});
			const { ops, batchIds } = await staged(engine);
			const all = [rebind, ...ops];
			server.use(
				http.post(`${engine.project.baseUrl}/commits/preview`, () =>
					HttpResponse.json({ detail: 'metamodel: bad at line 1' }, { status: 422 })
				)
			);

			const failure = await previewCommit(0, all, undefined, { strict: false, batchIds }).catch(
				(error: unknown) => error
			);

			expect(failure).toBeInstanceOf(ValidationError);
			expect(failure).toMatchObject({ status: 422, message: 'metamodel: bad at line 1' });
			expect(engine.over.methods()).not.toContain('previewCommit');
		});

		it("staged ops the candidate refuses are the engine's 422, and the server is not asked", async () => {
			const project = fakeProject();
			// The candidate drops `name`, which the staged rename sets.
			const candidate = JSON.parse(JSON.stringify(project.doc)) as {
				elements: { name: string; properties: { name: string }[] }[];
			};
			const named = candidate.elements.find((element) => element.name === 'NamedElement')!;
			named.properties = named.properties.filter((property) => property.name !== 'name');
			const engine = await issuesEngine(made, {
				project,
				lint: () => ({ ok: true, errors: [], document: candidate })
			});
			const { ops, batchIds } = await staged(engine);
			const all = [rebind, ...ops, moveNode];

			const failure = await previewCommit(0, all, undefined, { strict: false, batchIds }).catch(
				(error: unknown) => error
			);

			expect(failure).toBeInstanceOf(ValidationError);
			expect(failure).toMatchObject({ status: 422 });
			expect((failure as ValidationError).message).toContain("has no property 'name'");
			expect(engine.over.methods().filter((method) => method === 'previewCommit')).toHaveLength(1);
			expect(engine.requests.map((request) => request.route)).toEqual(['lint']);
		});

		it('a staged create beside it is previewed locally, its temp id named', async () => {
			const project = fakeProject();
			const engine = await issuesEngine(made, {
				project,
				lint: () => ({ ok: true, errors: [], document: project.doc })
			});
			const create: ModelOp = {
				kind: 'create_element',
				temp_id: 'tmp_new',
				type_name: 'Organization',
				properties: { name: TOO_LONG }
			};
			const batchIds = [await engine.stage([create])];

			const preview = await previewCommit(0, [rebind, create], undefined, {
				strict: false,
				batchIds
			});

			expect(engine.over.methods()).toContain('previewCommit');
			expect(engine.requests.map((request) => request.route)).toEqual(['lint']);
			expect(preview.issues).toContainEqual(expect.objectContaining({ message: TOO_LONG_MESSAGE }));
			expect(
				preview.issues.find((issue) => issue.message === TOO_LONG_MESSAGE)!.target_ids[0]
			).toMatch(/^tmp_/);
		});
	});

	it('without the staged batches named, the server previews every op', async () => {
		const engine = await issuesEngine(made);
		const { ops } = await staged(engine);

		await previewCommit(0, ops);

		expect(engine.requests).toEqual([{ route: 'preview', body: { base_rev: 0, ops } }]);
	});

	it("stale staged batches, or a stale base_rev, are the engine's 409 after one more try", async () => {
		const engine = await issuesEngine(made);
		const { ops, batchIds } = await staged(engine);
		const all = [...ops, artifactOp];

		const batches = previewCommit(0, all, undefined, {
			strict: false,
			batchIds: [batchIds[0]! + 1]
		});
		await expect(batches).rejects.toBeInstanceOf(ConflictError);
		await expect(batches).rejects.toMatchObject({ status: 409, message: 'stale staged batches' });
		expect(engine.over.methods().filter((method) => method === 'previewCommit')).toHaveLength(2);

		const base = previewCommit(1, all, undefined, { strict: false, batchIds });
		await expect(base).rejects.toMatchObject({ status: 409, message: 'stale base_rev' });
		expect(engine.over.methods().filter((method) => method === 'previewCommit')).toHaveLength(4);
		expect(engine.requests).toEqual([]);
	});
});
