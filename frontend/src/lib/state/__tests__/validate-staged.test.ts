import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '$lib/api/__tests__/server';
import * as validationApi from '$lib/api/validation';
import { fakeProject, PAGE_ORIGIN } from '$lib/engine/__tests__/support/project-server';
import {
	DE_ONLY,
	DE_OR_FR,
	NOT_DE_OR_FR,
	parsed,
	ruleIssues,
	ruleSet,
	rulesPayload,
	yamlOf
} from '$lib/engine/__tests__/support/rules';
import { resetArtifactEdits, stageArtifactUpdate } from '../artifact-edits.svelte';
import { cancelIssuesRefetch, emit, ensureElements, stagedSettled } from '../model.svelte';
import {
	validateAll,
	resetModelStore,
	adoptSummary,
	setModelApiConfig,
	getModelError,
	getIssuesByOwner,
	getIssueCounts
} from '../model.svelte';
import { ConflictError } from '$lib/api/errors';
import { clearOverlay, getLastError, getOverlay } from '../validation.svelte';
import { runValidation } from '../validate-action';
import { engineStore, rename, type EngineStore } from './support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
	server.resetHandlers();
	resetModelStore();
	clearOverlay();
});
afterAll(() => server.close());

describe('validateAll', () => {
	const API = `${PAGE_ORIGIN}/api/v1/projects/p`;
	let store: EngineStore | null = null;

	afterEach(() => {
		store?.dispose();
		store = null;
		// The gate's opening scheduled one: it must not outlive the store.
		cancelIssuesRefetch();
		vi.restoreAllMocks();
	});

	/** The engine store; `/model/validate` records what it is sent and answers nothing. */
	async function open(project = fakeProject()) {
		setModelApiConfig(undefined);
		const bodies: unknown[] = [];
		server.use(
			http.post(`${API}/model/validate`, async ({ request }) => {
				const text = await request.text();
				bodies.push(text === '' ? null : JSON.parse(text));
				return HttpResponse.json([]);
			}),
			http.get(`${API}/model/issues`, () => HttpResponse.json({ model_rev: 0, issues: [] }))
		);
		store = await engineStore({ project });
		await ensureElements(['e_000001']);
		return { s: store, bodies };
	}

	it('names the batches it sends, and the engine validates them', async () => {
		const { s, bodies } = await open();
		if (!s.sync.status().seeded) await s.until((status) => status.seeded);
		const spy = vi.spyOn(validationApi, 'validateModel');
		const op = rename('e_000001', 'x'.repeat(201));
		emit(op);
		await stagedSettled();

		const issues = await validateAll();

		expect(spy).toHaveBeenCalledWith({ ops: [op], baseRev: 0, batchIds: [1] }, undefined);
		expect(issues).toEqual([
			{
				severity: 'error',
				message: 'name: length 201 exceeds max_length 200',
				target_ids: ['e_000001'],
				check: 'facets',
				origin: 'uncommitted'
			}
		]);
		expect(bodies).toEqual([]);
	});

	it('with nothing staged, names no batch', async () => {
		const { s, bodies } = await open();
		if (!s.sync.status().seeded) await s.until((status) => status.seeded);
		const spy = vi.spyOn(validationApi, 'validateModel');

		await expect(validateAll()).resolves.toEqual([]);

		expect(spy).toHaveBeenCalledWith({ batchIds: [] }, undefined);
		expect(bodies).toEqual([]);
	});

	it('with a rule set staged, the engine validates the staged rules', async () => {
		const project = fakeProject();
		const A = yamlOf(DE_ONLY);
		const B = yamlOf(DE_OR_FR);
		project.artifacts.set('r1', ruleSet('r1', 'Rules', A, parsed(DE_ONLY)));
		project.rulesParses.set(B, parsed(DE_OR_FR));
		const { s, bodies } = await open(project);
		if (!s.sync.status().seeded) await s.until((status) => status.seeded);

		try {
			stageArtifactUpdate('r1', { payload: rulesPayload(B) });
			await vi.waitFor(async () =>
				expect((await validationApi.getModelIssues()).issues).toEqual(
					ruleIssues('de-or-fr', NOT_DE_OR_FR, 'uncommitted')
				)
			);
			expect(project.rulesParsed).toEqual([B]);
			const spy = vi.spyOn(validationApi, 'validateModel');
			const issues = await validateAll();

			expect(spy).toHaveBeenCalledWith({ batchIds: [] }, undefined);
			expect(issues.filter((issue) => issue.origin === 'uncommitted')).toEqual(
				ruleIssues('de-or-fr', NOT_DE_OR_FR, 'uncommitted')
			);
			expect(bodies).toEqual([]);
		} finally {
			resetArtifactEdits();
		}
	});

	it('runValidation stores the origin-tagged run as the overlay, not the live map', async () => {
		const { s } = await open();
		if (!s.sync.status().seeded) await s.until((status) => status.seeded);
		adoptSummary({
			model_rev: 0,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: { error: 1 },
			undo_depth: 0
		});
		emit(rename('e_000001', 'x'.repeat(201)));
		await stagedSettled();

		await runValidation();

		// The overlay carries the origin-tagged run result...
		expect(getOverlay()?.map((i) => i.message)).toEqual([
			'name: length 201 exceeds max_length 200'
		]);
		expect(getOverlay()?.[0]?.origin).toBe('uncommitted');
		// ...while the live committed map/counts are untouched (validateAll is a
		// pure fetch; StatusBar keeps reading committed truth throughout).
		expect(getIssuesByOwner().size).toBe(0);
		expect(getIssueCounts()).toEqual({ error: 1 });
	});

	it('a 409 marks the store conflicted and sets lastError; runValidation still resolves', async () => {
		const { s } = await open();
		if (!s.sync.status().seeded) await s.until((status) => status.seeded);
		adoptSummary({
			model_rev: 0,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: {},
			undo_depth: 0
		});
		vi.spyOn(validationApi, 'validateModel').mockRejectedValue(
			new ConflictError(409, { detail: 'stale base_rev', model_rev: 9 }, 'stale base_rev')
		);

		await expect(runValidation()).resolves.toBeUndefined();

		expect(getModelError()?.kind).toBe('conflict');
		expect(getLastError()).not.toBeNull();
	});
});
