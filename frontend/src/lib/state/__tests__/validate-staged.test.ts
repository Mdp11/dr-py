import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '$lib/api/__tests__/server';
import * as validationApi from '$lib/api/validation';
import { PAGE_ORIGIN } from '$lib/engine/__tests__/support/project-server';
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
import { clearOverlay, getLastError, getOverlay } from '../validation.svelte';
import { runValidation } from '../validate-action';
import { engineStore, rename, type EngineStore } from './support/engine-store';

const BASE = 'http://api.test/api/v1';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
	server.resetHandlers();
	resetModelStore();
	clearOverlay();
});
afterAll(() => server.close());

describe('validateAll with staged ops', () => {
	it('sends staged ops + base_rev to /model/validate', async () => {
		setModelApiConfig({ baseUrl: BASE });
		adoptSummary({
			model_rev: 4,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: {},
			undo_depth: 0
		});
		emit({ kind: 'create_element', temp_id: 'tmp1', type_name: 'Block', properties: {} });

		let body: { ops?: unknown[]; base_rev?: number } | undefined;
		server.use(
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				body = (await request.json()) as typeof body;
				return HttpResponse.json([
					{ severity: 'error', message: 'e', target_ids: ['tmp1'], origin: 'uncommitted' }
				]);
			})
		);

		const issues = await validateAll();
		expect(body?.base_rev).toBe(4);
		expect(body?.ops).toHaveLength(1);
		expect(issues[0].origin).toBe('uncommitted');
	});
});

describe('runValidation stores the origin-tagged run as the overlay, not the live map', () => {
	it('setOverlay (via runValidation) does not touch issuesByOwner/counts', async () => {
		setModelApiConfig({ baseUrl: BASE });
		adoptSummary({
			model_rev: 1,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: { error: 1 },
			undo_depth: 0
		});
		emit({ kind: 'create_element', temp_id: 'tmp3', type_name: 'Block', properties: {} });

		server.use(
			http.post(`${BASE}/model/validate`, () =>
				HttpResponse.json([
					{
						severity: 'error',
						message: 'staged issue',
						target_ids: ['tmp3'],
						origin: 'uncommitted'
					}
				])
			)
		);

		await runValidation();

		// The overlay carries the origin-tagged run result...
		expect(getOverlay()?.map((i) => i.message)).toEqual(['staged issue']);
		expect(getOverlay()?.[0].origin).toBe('uncommitted');
		// ...while the live committed map/counts are untouched (validateAll is a
		// pure fetch; StatusBar keeps reading committed truth throughout).
		expect(getIssuesByOwner().size).toBe(0);
		expect(getIssueCounts()).toEqual({ error: 1 });
	});
});

describe('runValidation — 409 conflict path', () => {
	it('sets conflict model error and lastError when /model/validate returns 409', async () => {
		setModelApiConfig({ baseUrl: BASE });
		adoptSummary({
			model_rev: 9,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: {},
			undo_depth: 0
		});
		emit({ kind: 'create_element', temp_id: 'tmp2', type_name: 'Block', properties: {} });

		server.use(
			http.post(
				`${BASE}/model/validate`,
				() =>
					new HttpResponse(JSON.stringify({ detail: 'stale base_rev', model_rev: 9 }), {
						status: 409,
						headers: { 'content-type': 'application/json' }
					})
			)
		);

		// runValidation swallows the error — it must resolve (not reject)
		await expect(runValidation()).resolves.toBeUndefined();

		expect(getModelError()?.kind).toBe('conflict');
		expect(getLastError()).not.toBeNull();
	});
});

describe('validateAll on the engine side', () => {
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
	async function open(surfaces: { [surface: string]: string } = {}) {
		// The suites above name their server; these reach the active project's.
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
		store = await engineStore({ surfaces });
		await ensureElements(['e_000001']);
		return { s: store, bodies };
	}

	it('names the batches it sends; with the issues on the engine, the engine validates them', async () => {
		const { s, bodies } = await open({ issues: 'engine' });
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
		const { s, bodies } = await open({ issues: 'engine' });
		if (!s.sync.status().seeded) await s.until((status) => status.seeded);
		const spy = vi.spyOn(validationApi, 'validateModel');

		await expect(validateAll()).resolves.toEqual([]);

		expect(spy).toHaveBeenCalledWith({ batchIds: [] }, undefined);
		expect(bodies).toEqual([]);
	});

	it('with the issues on the server, the server is sent the ops', async () => {
		const { bodies } = await open({ issues: 'server' });
		const op = rename('e_000001', 'x'.repeat(201));
		emit(op);
		await stagedSettled();

		await validateAll();

		expect(bodies).toEqual([{ ops: [op], base_rev: 0 }]);
	});
});
