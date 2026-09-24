import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';

import { fakeProject } from '$lib/engine/__tests__/support/project-server';
import { createShadow } from '$lib/engine/shadow';
import { previewCommit } from '../checkout';
import { getModelIssues, validateModel } from '../validation';
import {
	ALSO_TOO_LONG,
	commitNames,
	issuesEngine,
	rename,
	TOO_LONG,
	TOO_LONG_MESSAGE,
	uninstallIssuesEngine,
	unsupportedPatternDoc
} from './issues-engine';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('validateModel', () => {
	it('POSTs with inline body and parses Issue[]', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json([{ severity: 'error', message: 'oops', target_ids: ['e1'] }]);
			})
		);
		const inline = {
			elements: [{ id: 'e1', type_name: 'Block', properties: {}, rev: 0 }],
			relationships: []
		};
		const result = await validateModel({ inline }, cfg);
		expect(body).toEqual({ inline, scope: undefined });
		expect(result).toEqual([
			{ severity: 'error', message: 'oops', target_ids: ['e1'], check: '', origin: 'on_server' }
		]);
	});

	it('POSTs with scope only and parses warnings', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json([{ severity: 'warning', message: 'hint', target_ids: [] }]);
			})
		);
		const result = await validateModel({ scope: ['e1', 'e2'] }, cfg);
		expect(body).toEqual({ inline: undefined, scope: ['e1', 'e2'] });
		expect(result[0].severity).toBe('warning');
	});

	it('POSTs with no body when no options provided', async () => {
		let contentLength: string | null = null;
		let text = '';
		server.use(
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				contentLength = request.headers.get('content-length');
				text = await request.text();
				return HttpResponse.json([]);
			})
		);
		const result = await validateModel(undefined, cfg);
		expect(result).toEqual([]);
		expect(text).toBe('');
		if (contentLength !== null) {
			expect(contentLength).toBe('0');
		}
	});

	it('POSTs staged ops with base_rev when ops are present', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json([
					{ severity: 'error', message: 'bad', target_ids: ['e1'], origin: 'uncommitted' }
				]);
			})
		);
		const ops = [{ kind: 'update_element', id: 'e1', properties_patch: { p: 1 } }] as const;
		const result = await validateModel({ ops: [...ops], baseRev: 7 }, cfg);
		expect(body).toEqual({ ops: [...ops], base_rev: 7 });
		expect(result[0].origin).toBe('uncommitted');
	});

	it('defaults origin to on_server when the server omits it', async () => {
		server.use(
			http.post(`${BASE}/model/validate`, async () =>
				HttpResponse.json([{ severity: 'warning', message: 'x', target_ids: ['e1'] }])
			)
		);
		const result = await validateModel(undefined, cfg);
		expect(result[0].origin).toBe('on_server');
	});
});

describe('the issues on the engine', () => {
	const made: { dispose(): void }[] = [];

	afterEach(() => {
		uninstallIssuesEngine();
		for (const over of made.splice(0)) over.dispose();
	});

	const tooLong = (origin: string) => ({
		severity: 'error',
		message: TOO_LONG_MESSAGE,
		target_ids: ['e_000001'],
		check: 'facets',
		origin
	});

	it("getModelIssues answers the engine's list, a staged violation uncommitted; the server is never asked", async () => {
		const engine = await issuesEngine(made);
		await expect(getModelIssues()).resolves.toEqual({
			model_rev: 0,
			issues: [],
			counts: {},
			truncated: false,
			rules_status: { total: 0, skipped: [], eval_errors: {} }
		});

		await engine.stage([rename('e_000001', TOO_LONG)]);
		const list = await getModelIssues();

		expect(list.issues).toEqual([tooLong('uncommitted')]);
		expect(list.counts).toEqual({ error: 1 });
		expect(engine.requests).toEqual([]);
	});

	it('getModelIssues goes to the server while the replica is not seeded', async () => {
		const engine = await issuesEngine(made, { seeded: () => false });
		await engine.stage([rename('e_000001', TOO_LONG)]);

		await expect(getModelIssues()).resolves.toMatchObject({ issues: [] });
		expect(engine.requests.map((request) => request.route)).toEqual(['issues']);
	});

	it("validateModel with the staged batches answers the engine's list, a fixed issue resolved", async () => {
		const project = fakeProject();
		commitNames(project, { e_000001: TOO_LONG, e_000002: ALSO_TOO_LONG });
		const engine = await issuesEngine(made, { project });
		const ops = [rename('e_000001', 'fixed')];
		const batch = await engine.stage(ops);

		const issues = await validateModel({ ops, baseRev: project.rev, batchIds: [batch] });

		expect(issues).toEqual([
			{ ...tooLong('on_server'), target_ids: ['e_000002'] },
			tooLong('resolved')
		]);
		expect(engine.requests).toEqual([]);
	});

	it("validateModel with nothing staged is the engine's too", async () => {
		const project = fakeProject();
		commitNames(project, { e_000002: TOO_LONG });
		const engine = await issuesEngine(made, { project });

		await expect(validateModel()).resolves.toEqual([
			{ ...tooLong('on_server'), target_ids: ['e_000002'] }
		]);
		expect(engine.requests).toEqual([]);
	});

	it('a nothing-staged validateModel over a containment cycle logs no shadow line', async () => {
		const project = fakeProject();
		// e_000001 owns e_000006 already: the reverse closes a cycle.
		project.commit([
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Owns',
				source_id: 'e_000006',
				target_id: 'e_000001',
				properties: {}
			}
		]);
		const report = vi.fn();
		const shadow = createShadow({
			rev: () => project.rev,
			quiet: () => Promise.resolve(),
			staged: () => false,
			report
		});
		await issuesEngine(made, { project, shadow });

		const issues = await validateModel();
		expect(issues.some((issue) => issue.message.startsWith('Containment cycle'))).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(report).not.toHaveBeenCalled();

		// The shadow is live: the unstaged list is compared, and differs from MSW's empty one.
		await getModelIssues();
		await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
		expect(report.mock.calls[0]![0]).toMatch(/^\[shadow\] issues getModelIssues /);
	});

	it('an inline model or a scope, and ops no batch names, go to the server', async () => {
		const engine = await issuesEngine(made);
		const inline = { elements: [], relationships: [] };
		const ops = [rename('e_000001', TOO_LONG)];

		await validateModel({ inline });
		await validateModel({ scope: ['e_000001'] });
		await validateModel({ ops, baseRev: 0 });

		expect(engine.requests).toEqual([
			{ route: 'validate', body: { inline } },
			{ route: 'validate', body: { scope: ['e_000001'] } },
			{ route: 'validate', body: { ops, base_rev: 0 } }
		]);
	});

	it('a batch the engine does not stage sends validateModel to the server whole', async () => {
		const engine = await issuesEngine(made);
		const ops = [rename('e_000001', TOO_LONG)];
		const batch = await engine.stage(ops);

		await validateModel({ ops, baseRev: 0, batchIds: [batch + 1] });

		expect(engine.requests).toEqual([{ route: 'validate', body: { ops, base_rev: 0 } }]);
	});

	it('an engine whose metamodel holds a pattern it cannot vouch for never seeds', async () => {
		const project = fakeProject();
		project.rebind('mm-2', unsupportedPatternDoc(project.doc));
		const engine = await issuesEngine(made, { project, seeded: () => false });
		await engine.over.link!.client.call('validateModel', { batch_ids: [] }).catch(() => null);

		expect(engine.over.sync.status()).toMatchObject({ phase: 'ready', seeded: false });
	});

	it('an engine whose metamodel holds a pattern it cannot vouch for sends all three to the server', async () => {
		const project = fakeProject();
		project.rebind('mm-2', unsupportedPatternDoc(project.doc));
		// The gate held open: the engine's own refusal is what sends them.
		const engine = await issuesEngine(made, { project, seeded: () => true });
		const ops = [rename('e_000001', 'staged')];
		const batch = await engine.stage(ops);
		const local = { strict: false, batchIds: [batch] };

		await getModelIssues();
		await validateModel({ ops, baseRev: project.rev, batchIds: [batch] });
		await previewCommit(project.rev, ops, undefined, local);

		expect(engine.requests).toEqual([
			{ route: 'issues', body: null },
			{ route: 'validate', body: { ops, base_rev: project.rev } },
			{ route: 'preview', body: { base_rev: project.rev, ops } }
		]);
	});
});
