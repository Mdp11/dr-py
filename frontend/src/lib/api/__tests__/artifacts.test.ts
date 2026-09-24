import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ArtifactSet, drain, EVALUATIONS, ViewPlacements, type ReadParams } from '$engine';
import { createEngineSeam } from '$lib/engine/seam';
import { SURFACES } from '$lib/engine/surfaces';
import {
	fakeProject,
	syncOver,
	type FakeProject
} from '$lib/engine/__tests__/support/project-server';
import { server } from './server';
import { evaluateNavigation, getArtifact, listArtifactPayloads, listArtifacts } from '../artifacts';
import { setActiveBaseUrl } from '../client';
import { installEngineSeam, type Side, type Surface } from '../engine-route';
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

	it('evaluates and parses a chain page', async () => {
		server.use(
			http.post(`${BASE}/navigations/evaluate`, () =>
				HttpResponse.json({
					step_types: ['Owns'],
					chains: [
						[
							{ id: 'b1', type_name: 'Building', display_name: 'Plant', child_count: 0 },
							{ id: 's1', type_name: 'Sensor', display_name: 'T-1', child_count: 0 }
						]
					],
					total: 1,
					truncated: false
				})
			)
		);
		const page = await evaluateNavigation({ artifact_id: 'a1' }, CFG);
		const node = page.chains[0][1];
		expect('kind' in node ? undefined : node.display_name).toBe('T-1');
		expect(page.total).toBe(1);
	});
});

describe('evaluateNavigation on the navigation surface', () => {
	const made: ReturnType<typeof syncOver>[] = [];

	afterEach(() => {
		installEngineSeam(null);
		setActiveBaseUrl(null);
		for (const over of made.splice(0)) over.dispose();
	});

	/**
	 * A ready replica of `project` behind a seam with `navigation` on `side`
	 * and every other surface on the server; the server's evaluate route
	 * answers `SERVED` and records each body it is sent.
	 */
	async function over(project: FakeProject, side: Side) {
		const bodies: unknown[] = [];
		server.use(
			...project.handlers(),
			http.post(`${project.baseUrl}/navigations/evaluate`, async ({ request }) => {
				bodies.push(await request.json());
				return HttpResponse.json(SERVED);
			})
		);
		const replica = syncOver(project);
		made.push(replica);
		replica.sync.open(project.projectId);
		await replica.sync.settled();
		expect(replica.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
		const call = vi.fn(
			(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> =>
				replica.sync.call(method, params, options)
		);
		const surfaces = Object.fromEntries(
			SURFACES.map((surface) => [surface, surface === 'navigation' ? side : 'server'])
		) as Record<Surface, Side>;
		installEngineSeam(
			createEngineSeam(
				{ status: () => replica.sync.status(), call: call as typeof replica.sync.call },
				surfaces
			)
		);
		setActiveBaseUrl(project.baseUrl);
		return { replica, call, bodies };
	}

	const SERVED = {
		step_types: [],
		chains: [[{ id: 'srv', type_name: 'Building', display_name: 'Served', child_count: 0 }]],
		total: 1,
		truncated: false,
		warnings: []
	};

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
			placements: new ViewPlacements()
		};
		return ChainPageSchema.parse(
			JSON.parse(JSON.stringify(drain(EVALUATIONS['evaluateNavigation']!(ctx, params))))
		);
	}

	it("on the engine, an inline definition is the engine's page and the server is never asked", async () => {
		const project = fakeProject();
		const { call, bodies } = await over(project, 'engine');
		const definition = scopeOf([project.model.getElement('e_000001').typeName]);

		const page = await evaluateNavigation({ definition, limit: 5, row_element_id: undefined });

		expect(page).toEqual(direct(project, { definition, limit: 5 }));
		expect(page.chains).toHaveLength(5);
		expect(page).not.toHaveProperty('fallback');
		expect(call).toHaveBeenCalledWith('evaluateNavigation', { definition, limit: 5 }, {});
		expect(bodies).toEqual([]);
	});

	it('on the engine, a definition held in a proxy is sent as the plain JSON the server is sent', async () => {
		const project = fakeProject();
		const { call, bodies } = await over(project, 'engine');
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
		expect(bodies).toEqual([]);
	});

	it('on the engine, an artifact id resolves through the artifacts the engine holds', async () => {
		const project = fakeProject();
		const { replica, bodies } = await over(project, 'engine');
		const definition = scopeOf([project.model.getElement('e_000001').typeName]);
		replica.sync.setArtifacts([
			{ id: 'n1', kind: 'navigation', name: 'N', artifact_rev: 1, payload: { ...definition } }
		]);

		const page = await evaluateNavigation({ artifact_id: 'n1', limit: 3 });

		expect(page).toEqual(direct(project, { definition, limit: 3 }));
		expect(bodies).toEqual([]);
	});

	it("on the engine, an inline script step is the server's page marked script", async () => {
		const project = fakeProject();
		const { call, bodies } = await over(project, 'engine');
		const definition: PathNavigation = {
			...scopeOf([]),
			steps: [{ kind: 'script', snippet: { ref: 'sn1' } }]
		};

		const page = await evaluateNavigation({ definition, limit: 10 });

		expect(page).toEqual({ ...ChainPageSchema.parse(SERVED), fallback: 'script' });
		expect(call).toHaveBeenCalledOnce();
		expect(bodies).toEqual([{ definition, limit: 10 }]);
	});

	it('on the server, both reach the server alone, unmarked', async () => {
		const project = fakeProject();
		const { call, bodies } = await over(project, 'server');
		const definition = scopeOf([]);
		const scripted: PathNavigation = {
			...definition,
			steps: [{ kind: 'script', snippet: { ref: 'sn1' } }]
		};

		expect(await evaluateNavigation({ definition })).toEqual(ChainPageSchema.parse(SERVED));
		expect(await evaluateNavigation({ definition: scripted })).toEqual(
			ChainPageSchema.parse(SERVED)
		);

		expect(call).not.toHaveBeenCalled();
		expect(bodies).toEqual([{ definition }, { definition: scripted }]);
	});
});
