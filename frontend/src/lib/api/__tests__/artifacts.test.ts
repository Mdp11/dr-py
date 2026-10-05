import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
	ArtifactSet,
	drain,
	EVALUATIONS,
	NO_SCRIPTS,
	ViewPlacements,
	type ReadParams
} from '$engine';
import { createEngineSeam } from '$lib/engine/seam';
import {
	fakeProject,
	ready,
	syncOver,
	type FakeProject
} from '$lib/engine/__tests__/support/project-server';
import { server } from './server';
import { evaluateNavigation, getArtifact, listArtifactPayloads, listArtifacts } from '../artifacts';
import { installEngineSeam } from '../engine-route';
import { ChainPageSchema, type PathNavigation } from '../types';

const BASE = 'http://api.test/api/v1/projects/p1';
const CFG = { baseUrl: BASE };

const HEADER = {
	id: 'a1',
	kind: 'navigation',
	name: 'Sensors',
	artifact_rev: 1,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: 'u1'
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Every case here is a READ. That is the whole surface: `../artifacts.ts` is
// read-only by design, because artifact writes go through `POST /commits` as
// staged ops. There is deliberately no PUT/POST/DELETE case to write.
describe('artifacts api', () => {
	it('lists headers with a kind filter', async () => {
		server.use(
			http.get(`${BASE}/artifacts`, ({ request }) => {
				expect(new URL(request.url).searchParams.get('kind')).toBe('navigation');
				return HttpResponse.json({ items: [HEADER] });
			})
		);
		const res = await listArtifacts('navigation', CFG);
		expect(res.items[0].name).toBe('Sensors');
	});

	it('fetches one artifact with its payload', async () => {
		server.use(
			http.get(`${BASE}/artifacts/a1`, () =>
				HttpResponse.json({
					...HEADER,
					payload: { kind: 'path', start: { kind: 'scope', types: [] }, steps: [] }
				})
			)
		);
		const res = await getArtifact('a1', CFG);
		expect(res.payload.kind).toBe('path');
	});

	it('lists payloads, every one or the ids named, each id its own parameter', async () => {
		const asked: string[][] = [];
		server.use(
			http.get(`${BASE}/artifacts/payloads`, ({ request }) => {
				asked.push(new URL(request.url).searchParams.getAll('id'));
				return HttpResponse.json({ items: [{ ...HEADER, payload: { kind: 'path' } }] });
			})
		);
		const all = await listArtifactPayloads(undefined, CFG);
		expect(all[0]!.payload).toEqual({ kind: 'path' });
		expect(all[0]!.entry_points).toBeNull();
		await listArtifactPayloads(['a1', 'a&b'], CFG);
		expect(await listArtifactPayloads([], CFG)).toEqual([]);
		expect(asked).toEqual([[], ['a1', 'a&b']]);
	});
});

describe('evaluateNavigation on the engine', () => {
	const made: ReturnType<typeof syncOver>[] = [];

	afterEach(() => {
		installEngineSeam(null);
		for (const over of made.splice(0)) over.dispose();
	});

	/**
	 * A ready replica of `project` behind an installed seam, whose `call` is
	 * spied on. MSW holds the replica's own routes and no evaluate route: a
	 * call that strays to the server fails the test.
	 */
	async function over(project: FakeProject) {
		server.use(...project.handlers());
		const replica = syncOver(project);
		made.push(replica);
		replica.sync.open(project.projectId);
		await replica.sync.settled();
		expect(replica.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
		const call = vi.fn(
			(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> =>
				replica.sync.call(method, params, options)
		);
		installEngineSeam(createEngineSeam({ call: call as typeof replica.sync.call }, ready));
		return { replica, call };
	}

	const scopeOf = (types: string[]): PathNavigation => ({
		kind: 'path',
		schema_version: 2,
		start: { kind: 'scope', types, criteria: [] },
		steps: [],
		exclude_visited: true
	});

	/** What the engine's evaluation answers over the fake's own model, with no artifacts. */
	function direct(project: FakeProject, params: ReadParams) {
		const ctx = {
			model: project.model,
			artifacts: new ArtifactSet(),
			placements: new ViewPlacements(),
			scripts: NO_SCRIPTS
		};
		return ChainPageSchema.parse(
			JSON.parse(JSON.stringify(drain(EVALUATIONS['evaluateNavigation']!(ctx, params))))
		);
	}

	it("an inline definition is the engine's page", async () => {
		const project = fakeProject();
		const { call } = await over(project);
		const definition = scopeOf([project.model.getElement('e_000001').typeName]);

		const page = await evaluateNavigation({ definition, limit: 5, row_element_id: undefined });

		expect(page).toEqual(direct(project, { definition, limit: 5 }));
		expect(page.chains).toHaveLength(5);
		expect(page).not.toHaveProperty('fallback');
		expect(call).toHaveBeenCalledWith('evaluateNavigation', { definition, limit: 5 }, {});
	});

	it('a definition held in a proxy is sent as plain JSON', async () => {
		const project = fakeProject();
		const { call } = await over(project);
		const definition = scopeOf([project.model.getElement('e_000001').typeName]);

		const page = await evaluateNavigation({
			definition: new Proxy(definition, {}),
			offset: 2,
			row_element_id: null
		});

		expect(page).toEqual(direct(project, { definition, offset: 2, row_element_id: null }));
		expect(call).toHaveBeenCalledWith(
			'evaluateNavigation',
			{ definition, offset: 2, row_element_id: null },
			{}
		);
	});

	it('an artifact id resolves through the artifacts the engine holds', async () => {
		const project = fakeProject();
		const { replica } = await over(project);
		const definition = scopeOf([project.model.getElement('e_000001').typeName]);
		replica.sync.setArtifacts([
			{ id: 'n1', kind: 'navigation', name: 'N', artifact_rev: 1, payload: { ...definition } }
		]);

		const page = await evaluateNavigation({ artifact_id: 'n1', limit: 3 });

		expect(page).toEqual(direct(project, { definition, limit: 3 }));
	});

	it('a pattern the engine cannot translate is a 422, not a page', async () => {
		const project = fakeProject();
		await over(project);
		const definition: PathNavigation = {
			...scopeOf([]),
			start: {
				kind: 'scope',
				types: [],
				criteria: [{ type: 'property', name: 'name', op: 'matches', value: '(?x)a' }]
			}
		};

		const refused = evaluateNavigation({ definition });

		await expect(refused).rejects.toMatchObject({ status: 422 });
		await expect(refused).rejects.toThrow(/inline flags/);
	});
});
