import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';

import type { WireStagedArtifact } from '$engine';
import { createArtifactFollower } from '$lib/engine/artifacts';
import { createRulesParser } from '$lib/engine/rules-parse';
import { fakeProject } from '$lib/engine/__tests__/support/project-server';
import {
	DE_ONLY,
	DE_OR_FR,
	NOT_DE,
	NOT_DE_OR_FR,
	parsed,
	ruleIssues,
	ruleSet,
	rulesPayload,
	UNREADABLE,
	yamlOf
} from '$lib/engine/__tests__/support/rules';
import { createShadow } from '$lib/engine/shadow';
import { previewCommit } from '../checkout';
import { parseRules } from '../rules';
import type { ArtifactPayload, RulesParseOut } from '../types';
import { getModelIssues, validateModel } from '../validation';
import {
	ALSO_TOO_LONG,
	commitNames,
	issuesEngine,
	rename,
	TOO_LONG,
	TOO_LONG_MESSAGE,
	uninstallIssuesEngine,
	unsupportedPatternDoc,
	type IssuesEngine
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

	describe('with rule sets', () => {
		const A = yamlOf(DE_ONLY);
		const B = yamlOf(DE_OR_FR);
		const DRIFTING = {
			name: 'drifting',
			applies_to: 'Organization',
			then: { property: 'nope', exists: true }
		};

		/**
		 * The shell's artifact follower over `engine`: the committed rule sets
		 * `committed`, the staged buffer `staged`, and `/rules/parse` on MSW
		 * answering from `parses` (a 422 for a text it lacks).
		 */
		async function followRules(
			engine: IssuesEngine,
			committed: ArtifactPayload[],
			parses: { [yaml: string]: RulesParseOut } = {}
		) {
			const base = engine.project.baseUrl;
			const asked: string[] = [];
			server.use(
				http.post(`${base}/rules/parse`, async ({ request }) => {
					const { yaml } = (await request.json()) as { yaml: string };
					asked.push(yaml);
					const answer = parses[yaml];
					return answer === undefined
						? HttpResponse.json({ detail: 'unparsed' }, { status: 422 })
						: HttpResponse.json(answer);
				})
			);
			let staged: WireStagedArtifact[] = [];
			const follower = createArtifactFollower({
				sync: engine.over.sync,
				payloads: (ids) =>
					Promise.resolve(committed.filter((a) => ids === undefined || ids.includes(a.id))),
				staged: () => staged,
				parser: createRulesParser((yaml) => parseRules(yaml, { baseUrl: base }))
			});
			made.push({ dispose: () => follower.stop() });
			follower.load();
			await follower.settled();
			return {
				asked,
				/** Stages `entries` as the buffer holds them, and waits for the engine to have them. */
				async stage(entries: WireStagedArtifact[]) {
					staged = entries;
					follower.stagedChanged();
					await follower.settled();
				}
			};
		}

		it("answers the engine's body with the rule issues and rules_status; MSW is never asked", async () => {
			const engine = await issuesEngine(made);
			await followRules(engine, [ruleSet('r1', 'Rules', A, parsed(DE_ONLY, DRIFTING))]);

			await expect(getModelIssues()).resolves.toEqual({
				model_rev: 0,
				issues: ruleIssues('de-only', NOT_DE, 'on_server'),
				counts: { error: 4 },
				truncated: false,
				rules_status: {
					total: 1,
					skipped: [
						{
							artifact_id: 'r1',
							set_name: 'Rules',
							rule: 'drifting',
							reason: "stereotype 'Organization' has no property 'nope'"
						}
					],
					eval_errors: {}
				}
			});
			expect(engine.requests).toEqual([]);
		});

		it("lists a rules update staged through the buffer 'uncommitted' once its parse lands", async () => {
			const engine = await issuesEngine(made);
			const rules = await followRules(engine, [ruleSet('r1', 'Rules', A, parsed(DE_ONLY))], {
				[B]: parsed(DE_OR_FR)
			});

			await rules.stage([{ op: 'update', id: 'r1', payload: rulesPayload(B) }]);

			expect(rules.asked).toEqual([B]);
			const list = await getModelIssues();
			expect(list.issues).toEqual(ruleIssues('de-or-fr', NOT_DE_OR_FR, 'uncommitted'));
			expect(list.rules_status).toEqual({ total: 1, skipped: [], eval_errors: {} });
			// Validate shows what the staged rule set resolves, too.
			const validated = await validateModel({ batchIds: [] });
			expect(validated.filter((issue) => issue.origin === 'resolved')).toEqual(
				ruleIssues('de-only', NOT_DE, 'resolved')
			);
			expect(validated.filter((issue) => issue.origin !== 'resolved')).toEqual(
				ruleIssues('de-or-fr', NOT_DE_OR_FR, 'uncommitted')
			);
			expect(engine.requests).toEqual([]);
		});

		it('a document the engine refuses sends all three to MSW, unmarked', async () => {
			const engine = await issuesEngine(made);
			await followRules(engine, [ruleSet('r1', 'Rules', A, UNREADABLE)]);
			const ops = [rename('e_000001', 'staged')];
			const batch = await engine.stage(ops);

			await expect(getModelIssues()).resolves.toEqual({
				model_rev: 0,
				issues: [],
				counts: {},
				truncated: false,
				rules_status: null
			});
			await validateModel({ ops, baseRev: 0, batchIds: [batch] });
			await previewCommit(0, ops, undefined, { strict: false, batchIds: [batch] });

			expect(engine.requests).toEqual([
				{ route: 'issues', body: null },
				{ route: 'validate', body: { ops, base_rev: 0 } },
				{ route: 'preview', body: { base_rev: 0, ops } }
			]);
		});

		it('validateModel with staged ops and a staged rule set is not shadowed; without the rule set it is', async () => {
			const shadow = vi.fn();
			const engine = await issuesEngine(made, { shadow });
			const ops = [rename('e_000001', TOO_LONG)];
			const batch = await engine.stage(ops);

			await validateModel({ ops, baseRev: 0, batchIds: [batch], rulesStaged: true });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(shadow).not.toHaveBeenCalled();

			await validateModel({ ops, baseRev: 0, batchIds: [batch] });
			await vi.waitFor(() => expect(shadow).toHaveBeenCalledOnce());
			expect(shadow.mock.calls[0]![0]).toMatchObject({
				method: 'validateModel',
				whileStaged: true
			});
		});
	});
});
