import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { previewCommit } from '../checkout';
import { ConflictError } from '../errors';
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

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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

	it("getModelIssues answers the engine's list, a staged violation uncommitted", async () => {
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

	it('getModelIssues waits while the gate is closed, and answers from the engine once it opens', async () => {
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const engine = await issuesEngine(made, { whenReady: () => gate });
		await engine.stage([rename('e_000001', TOO_LONG)]);
		const calls = () => engine.over.methods().filter((method) => method === 'getModelIssues');

		const pending = getModelIssues();
		for (let turn = 0; turn < 20; turn++) await Promise.resolve();
		expect(calls()).toHaveLength(0);

		open();
		await expect(pending).resolves.toMatchObject({ issues: [tooLong('uncommitted')] });
		expect(calls()).toHaveLength(1);
		expect(engine.requests).toEqual([]);
	});

	it("validateModel with the staged batches answers the engine's list, a fixed issue resolved", async () => {
		const project = fakeProject();
		commitNames(project, { e_000001: TOO_LONG, e_000002: ALSO_TOO_LONG });
		const engine = await issuesEngine(made, { project });
		const ops = [rename('e_000001', 'fixed')];
		const batch = await engine.stage(ops);

		const issues = await validateModel({ batchIds: [batch] });

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

	it('a nothing-staged validateModel names every element of a containment cycle, as the engine does', async () => {
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
		await issuesEngine(made, { project });

		const issues = await validateModel();

		expect(issues.some((issue) => issue.message.startsWith('Containment cycle'))).toBe(true);
	});

	it('a batch the engine does not stage is its 409, after one more try', async () => {
		const engine = await issuesEngine(made);
		const ops = [rename('e_000001', TOO_LONG)];
		const batch = await engine.stage(ops);

		const stale = validateModel({ batchIds: [batch + 1] });

		await expect(stale).rejects.toBeInstanceOf(ConflictError);
		await expect(stale).rejects.toMatchObject({ status: 409, message: 'stale staged batches' });
		expect(engine.over.methods().filter((method) => method === 'validateModel')).toHaveLength(2);
		expect(engine.requests).toEqual([]);
	});

	it('a facet pattern the engine cannot translate is an issue per value, and the engine still answers all three', async () => {
		const project = fakeProject();
		project.rebind('mm-2', unsupportedPatternDoc(project.doc));
		const engine = await issuesEngine(made, { project });
		const ops = [rename('e_000001', 'staged')];
		const batch = await engine.stage(ops);
		const local = { strict: false, batchIds: [batch] };

		const list = await getModelIssues();
		const validated = await validateModel({ batchIds: [batch] });
		const preview = await previewCommit(project.rev, ops, undefined, local);

		for (const issues of [list.issues, validated, preview.issues]) {
			expect(issues.some((issue) => issue.message.includes('cannot be checked'))).toBe(true);
		}
		expect(engine.over.sync.status()).toMatchObject({ phase: 'ready', seeded: true });
		expect(engine.requests).toEqual([]);
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

		it('a rule set the engine cannot read is skipped with its reason, and the engine answers all three', async () => {
			const engine = await issuesEngine(made);
			await followRules(engine, [ruleSet('r1', 'Rules', A, UNREADABLE)]);
			const ops = [rename('e_000001', 'staged')];
			const batch = await engine.stage(ops);

			const list = await getModelIssues();
			await validateModel({ batchIds: [batch] });
			await previewCommit(0, ops, undefined, { strict: false, batchIds: [batch] });

			expect(list.rules_status?.skipped).toMatchObject([{ artifact_id: 'r1', set_name: 'Rules' }]);
			expect(list.rules_status?.skipped[0]!.reason).not.toBe('');
			expect(engine.requests).toEqual([]);
		});
	});
});
