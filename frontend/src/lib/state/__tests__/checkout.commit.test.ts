import { afterAll, afterEach, beforeAll, describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setProjectInfo, resetCheckout, commitStaged, emit, resetModelStore } from '../index';
import { server } from '$lib/api/__tests__/server';
import type { ModelOp as EngineOp } from '$engine';
import { PAGE_ORIGIN } from '$lib/engine/__tests__/support/project-server';
import { commitApplied } from '../checkout.svelte';
import {
	cancelIssuesRefetch,
	ensureElements,
	getCachedElements,
	getLiveIssues,
	getModelRev,
	stagedSettled
} from '../model.svelte';
import { engineStore, type EngineStore } from './support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

beforeEach(() => {
	resetModelStore();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

describe('the issues on the engine across an own commit', () => {
	const API = `${PAGE_ORIGIN}/api/v1/projects/p`;
	const TOO_LONG = 'x'.repeat(201);
	const issue = (origin: string, check = 'facets', owner = 'e_000001') => ({
		severity: 'error',
		message: 'name: length 201 exceeds max_length 200',
		target_ids: [owner],
		check,
		origin
	});
	let store: EngineStore | null = null;

	afterEach(() => {
		store?.dispose();
		store = null;
		cancelIssuesRefetch();
		resetCheckout();
		vi.restoreAllMocks();
	});

	/**
	 * The locks and commit routes of `s.project`: a commit lands its ops and
	 * answers with the server's issue delta over the entity it created, else
	 * `e_000001`, whose issue carries `check` `'delta'` so a list spliced from
	 * it can be told from the engine's.
	 */
	function routes(s: EngineStore): { issuesAsked: number } {
		const counts = { issuesAsked: 0 };
		server.use(
			http.post(`${API}/locks`, async ({ request }) => {
				const body = (await request.json()) as { targets: { resource_id: string }[] };
				return HttpResponse.json({
					token: 't1',
					leases: body.targets.map((target) => ({
						resource_id: target.resource_id,
						mode: 'exclusive',
						holder: 'u-1',
						token: 't1',
						intent: 'edit',
						expires_at: 1
					}))
				});
			}),
			http.post(`${API}/locks/release`, () => new HttpResponse(null, { status: 204 })),
			http.post(`${API}/commits`, async ({ request }) => {
				const body = (await request.json()) as { ops: EngineOp[] };
				const committed = s.project.commit(body.ops);
				const { id_map } = JSON.parse(committed.responseText) as {
					id_map: Record<string, string>;
				};
				const owner = Object.values(id_map)[0] ?? 'e_000001';
				const delta = {
					issues_removed_owner_ids: [owner],
					issues_added: [issue('on_server', 'delta', owner)],
					issue_counts: { error: 1 },
					commit_id: `c-${s.project.rev}`,
					message: 'm'
				};
				const text = committed.responseText.slice(0, -1) + ',' + JSON.stringify(delta).slice(1);
				return new HttpResponse(text, { headers: { 'Content-Type': 'application/json' } });
			}),
			http.get(`${API}/model/issues`, () => {
				counts.issuesAsked += 1;
				return HttpResponse.json({ model_rev: s.project.rev, issues: [], counts: {} });
			})
		);
		return counts;
	}

	it("the panel's list after the refetch is the engine's, each issue once and on_server", async () => {
		store = await engineStore();
		const s = store;
		const counts = routes(s);
		if (!s.sync.status().seeded) await s.until((status) => status.seeded);
		await ensureElements(['e_000001']);
		emit({ kind: 'update_element', id: 'e_000001', properties_patch: { name: TOO_LONG } });
		await stagedSettled();
		await vi.waitFor(() => expect(getLiveIssues()).toEqual([issue('uncommitted')]));

		await commitStaged('m', false);
		// The server's delta is spliced in at once: a transient.
		expect(getLiveIssues()).toEqual([issue('on_server', 'delta')]);
		await commitApplied();

		await vi.waitFor(() => expect(getLiveIssues()).toEqual([issue('on_server')]));
		expect(getModelRev()).toBe(1);
		expect(counts.issuesAsked).toBe(0);
	});

	it("a created entity's issue is never listed twice, under its temp id and its minted one", async () => {
		store = await engineStore();
		const s = store;
		const counts = routes(s);
		if (!s.sync.status().seeded) await s.until((status) => status.seeded);
		// An organization like e_000001 in all but its name, which is too long.
		await ensureElements(['e_000001']);
		const like = getCachedElements().get('e_000001');
		const lists: ReturnType<typeof getLiveIssues>[] = [];
		const sample = setInterval(() => lists.push(getLiveIssues()), 1);
		try {
			emit({
				kind: 'create_element',
				temp_id: 'tmp_x',
				type_name: like!.type_name,
				properties: { ...like!.properties, name: TOO_LONG }
			});
			await stagedSettled();
			await vi.waitFor(() =>
				expect(getLiveIssues()).toEqual([issue('uncommitted', 'facets', 'tmp_x')])
			);

			await commitStaged('m', false);
			lists.push(getLiveIssues());
			expect(getLiveIssues()).toEqual([issue('on_server', 'delta', 'srv-1')]);
			await commitApplied();
			lists.push(getLiveIssues());

			await vi.waitFor(() =>
				expect(getLiveIssues()).toEqual([issue('on_server', 'facets', 'srv-1')])
			);
		} finally {
			clearInterval(sample);
		}
		for (const list of lists) expect(list.length).toBeLessThanOrEqual(1);
		expect(getModelRev()).toBe(1);
		expect(counts.issuesAsked).toBe(0);
	});
});
