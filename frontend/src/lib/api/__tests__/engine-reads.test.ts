import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
	drain,
	isSteps,
	READS,
	ViewPlacements,
	type ElementRec,
	type ReadParams,
	type Steps
} from '$engine';
import { FrameError } from '$lib/engine/frame';
import { createEngineSeam } from '$lib/engine/seam';
import { SURFACES } from '$lib/engine/surfaces';
import {
	fakeProject,
	syncOver,
	type FakeProject
} from '$lib/engine/__tests__/support/project-server';
import { setActiveBaseUrl } from '../client';
import { getElement } from '../elements';
import { installEngineSeam, type Side, type Surface } from '../engine-route';
import { NotFoundError, ValidationError } from '../errors';
import {
	getElementsBatch,
	getModelSummary,
	getTreeItemsBatch,
	listContainmentChildren,
	listContainmentRoots,
	listContainmentRootsPaged,
	listElementRelationships,
	listElementsPage,
	listExcludedRoots,
	listExcludedRootsPaged,
	READ_PAGE_LIMIT
} from '../model-read';
import {
	ElementListSchema,
	ElementPageSchema,
	ElementSchema,
	ModelSummarySchema,
	RelationshipPageSchema,
	TreeItemPageSchema
} from '../types';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const made: ReturnType<typeof syncOver>[] = [];

afterEach(() => {
	installEngineSeam(null);
	setActiveBaseUrl(null);
	for (const over of made.splice(0)) over.dispose();
	server.resetHandlers();
});

const sides = (side: Side, only?: Surface) =>
	Object.fromEntries(
		SURFACES.map((surface) => [surface, only === undefined || surface === only ? side : 'server'])
	) as Record<Surface, Side>;

const allEngine = sides('engine');

/**
 * A ready replica of `project` behind an installed seam whose surfaces are
 * `surfaces`; `call` is the seam's view of `sync.call`, spied on. MSW holds
 * the replica's own routes and no read route: a read that strays to the
 * server fails the test.
 */
async function engineOver(project: FakeProject, surfaces = allEngine) {
	server.use(...project.handlers());
	const over = syncOver(project);
	made.push(over);
	over.sync.open(project.projectId);
	await over.sync.settled();
	expect(over.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
	const call = vi.fn(
		(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> =>
			over.sync.call(method, params, options)
	);
	const sync = { status: () => over.sync.status(), call: call as typeof over.sync.call };
	installEngineSeam(createEngineSeam(sync, surfaces));
	return { over, call };
}

/** What the engine's read answers over the fake's own model, as plain JSON. */
function direct(
	project: FakeProject,
	method: string,
	params: ReadParams,
	placements?: ViewPlacements
) {
	const result = READS[method]!(project.model, placements ?? new ViewPlacements(), params);
	const value = isSteps(result) ? drain(result as Steps<unknown>) : result;
	return JSON.parse(JSON.stringify(value)) as unknown;
}

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);
const elements = (project: FakeProject): ElementRec[] => [...project.model.elements()];
const roots = (project: FakeProject) =>
	elements(project).filter((element) => project.model.containerOf(element.id) === null);
const childrenOf = (project: FakeProject, id: string) =>
	elements(project).filter((element) => project.model.containerOf(element.id) === id);

describe('the model reads on the engine', () => {
	it('getElement', async () => {
		const project = fakeProject();
		const { call } = await engineOver(project);
		const record = project.model.getElement('e_000001');

		const element = await getElement('e_000001');
		expect(element).toEqual(ElementSchema.parse(direct(project, 'getElement', { id: 'e_000001' })));
		expect(element).toMatchObject({ id: 'e_000001', type_name: record.typeName, rev: record.rev });
		expect(element.properties['name']).toBe(record.props['name']);
		expect(call).toHaveBeenCalledWith('getElement', { id: 'e_000001' }, {});

		const ghost = getElement('ghost');
		await expect(ghost).rejects.toBeInstanceOf(NotFoundError);
		await expect(ghost).rejects.toThrow("No element with id 'ghost");
	});

	it('getElementsBatch', async () => {
		const project = fakeProject();
		const { call } = await engineOver(project);

		const items = await getElementsBatch(['e_000003', 'ghost', 'e_000001']);
		expect(ids(items)).toEqual(['e_000003', 'e_000001']);
		expect(items).toEqual(
			ElementListSchema.parse(
				direct(project, 'getElementsBatch', { ids: ['e_000003', 'ghost', 'e_000001'] })
			).items
		);
		expect(call).toHaveBeenCalledWith(
			'getElementsBatch',
			{ ids: ['e_000003', 'ghost', 'e_000001'] },
			{}
		);

		const tooMany = getElementsBatch(Array.from({ length: 501 }, (_, i) => `e_${i}`));
		await expect(tooMany).rejects.toBeInstanceOf(ValidationError);
		await expect(tooMany).rejects.toThrow('too many ids: 501 (max 500)');
	});

	it('getTreeItemsBatch', async () => {
		const project = fakeProject();
		const { call } = await engineOver(project);
		const parent = roots(project).find((root) => childrenOf(project, root.id).length > 0)!;

		const items = await getTreeItemsBatch([parent.id, 'ghost', 'e_000002']);
		expect(ids(items)).toEqual([parent.id, 'e_000002']);
		expect(items[0]!.child_count).toBe(childrenOf(project, parent.id).length);
		expect(items).toEqual(
			TreeItemPageSchema.parse(
				direct(project, 'getTreeItemsBatch', { ids: [parent.id, 'ghost', 'e_000002'] })
			).items
		);
		expect(call).toHaveBeenCalledWith(
			'getTreeItemsBatch',
			{ ids: [parent.id, 'ghost', 'e_000002'] },
			{}
		);
	});

	it('listElementsPage without a query', async () => {
		const project = fakeProject();
		const { call } = await engineOver(project);
		const all = elements(project);

		const page = await listElementsPage({ offset: 5, limit: 7 });
		expect(page.total).toBe(project.model.elementCount);
		expect(ids(page.items)).toEqual(ids(all.slice(5, 12)));
		expect(page).toEqual(
			ElementPageSchema.parse(direct(project, 'listElementsPage', { limit: 7, offset: 5 }))
		);
		expect(call).toHaveBeenLastCalledWith('listElementsPage', { limit: 7, offset: 5 }, {});

		const people = await listElementsPage({ type: 'Person' });
		const persons = all.filter((element) => element.typeName === 'Person');
		expect(people.total).toBe(persons.length);
		expect(ids(people.items)).toEqual(ids(persons.slice(0, 100)));
		expect(call).toHaveBeenLastCalledWith('listElementsPage', { type: 'Person' }, {});

		const none = await listElementsPage();
		expect(none.total).toBe(project.model.elementCount);
		expect(call).toHaveBeenLastCalledWith('listElementsPage', {}, {});
	});

	it('listElementsPage with a query is a search', async () => {
		const project = fakeProject();
		const { call } = await engineOver(project);

		const page = await listElementsPage({ q: 'sta', limit: 20 });
		expect(page.total).toBeGreaterThan(0);
		expect(page).toEqual(
			ElementPageSchema.parse(direct(project, 'listElementsPage', { q: 'sta', limit: 20 }))
		);
		expect(call).toHaveBeenLastCalledWith('listElementsPage', { q: 'sta', limit: 20 }, {});
	});

	it('listElementRelationships', async () => {
		const project = fakeProject();
		const { call } = await engineOver(project);
		const record = project.model.getElement('e_000001');
		const incident = new Set([...record.out, ...record.in].map((rel) => rel.id));
		expect(incident.size).toBeGreaterThan(1);

		const page = await listElementRelationships('e_000001');
		expect(page.total).toBe(incident.size);
		expect(new Set(ids(page.items))).toEqual(incident);
		expect(page).toEqual(
			RelationshipPageSchema.parse(direct(project, 'listElementRelationships', { id: 'e_000001' }))
		);
		expect(call).toHaveBeenLastCalledWith('listElementRelationships', { id: 'e_000001' }, {});

		const out = await listElementRelationships('e_000001', {
			direction: 'out',
			limit: 1,
			offset: 0
		});
		expect(out.total).toBe(record.out.length);
		expect(out.items).toHaveLength(Math.min(1, record.out.length));
		expect(call).toHaveBeenLastCalledWith(
			'listElementRelationships',
			{ id: 'e_000001', direction: 'out', limit: 1, offset: 0 },
			{}
		);
	});

	it('getModelSummary', async () => {
		const project = fakeProject({ rev: 3 });
		const { call } = await engineOver(project);

		const summary = await getModelSummary();
		expect(summary).toEqual(
			ModelSummarySchema.parse(direct(project, 'getModelSummary', { model_rev: 3 }))
		);
		expect(summary).toMatchObject({
			model_rev: 3,
			element_count: project.model.elementCount,
			relationship_count: project.model.relationshipCount,
			issue_counts: null,
			undo_depth: 0
		});
		expect(summary.elements_by_type['Person']).toBe(160);
		expect(call).toHaveBeenCalledWith('getModelSummary', {}, {});
	});

	it('listContainmentRoots', async () => {
		const project = fakeProject();
		const { call } = await engineOver(project);
		const expected = roots(project);

		const page = await listContainmentRoots({ limit: 10, offset: 2 });
		expect(page.total).toBe(expected.length);
		expect(page.items).toHaveLength(10);
		for (const item of page.items) expect(project.model.containerOf(item.id)).toBeNull();
		expect(page).toEqual(
			TreeItemPageSchema.parse(direct(project, 'listContainmentRoots', { limit: 10, offset: 2 }))
		);
		expect(call).toHaveBeenLastCalledWith('listContainmentRoots', { limit: 10, offset: 2 }, {});

		await listContainmentRoots();
		expect(call).toHaveBeenLastCalledWith('listContainmentRoots', {}, {});
	});

	it('listExcludedRoots', async () => {
		const project = fakeProject();
		const { over, call } = await engineOver(project);
		const all = roots(project);
		const placed = [all[0]!.id, all[3]!.id, 'not-a-root'];
		over.sync.setViewPlacement('v-1', placed);

		const page = await listExcludedRoots({ viewId: 'v-1', limit: 500 });
		expect(page.total).toBe(all.length - 2);
		expect(ids(page.items)).not.toContain(all[0]!.id);
		expect(ids(page.items)).not.toContain(all[3]!.id);
		const placements = new ViewPlacements();
		placements.set('v-1', placed);
		expect(page).toEqual(
			TreeItemPageSchema.parse(
				direct(project, 'listExcludedRoots', { view_id: 'v-1', limit: 500 }, placements)
			)
		);
		expect(call).toHaveBeenLastCalledWith('listExcludedRoots', { limit: 500, view_id: 'v-1' }, {});

		const unscoped = await listExcludedRoots({ offset: 1 });
		expect(unscoped.total).toBe(all.length);
		expect(call).toHaveBeenLastCalledWith('listExcludedRoots', { offset: 1 }, {});
	});

	it('listContainmentChildren', async () => {
		const project = fakeProject();
		const { call } = await engineOver(project);
		const parent = roots(project).find((root) => childrenOf(project, root.id).length > 1)!;
		const children = childrenOf(project, parent.id);

		const page = await listContainmentChildren(parent.id, { limit: 1 });
		expect(page.total).toBe(children.length);
		expect(page.items).toHaveLength(1);
		expect(ids(children)).toContain(page.items[0]!.id);
		expect(page).toEqual(
			TreeItemPageSchema.parse(
				direct(project, 'listContainmentChildren', { id: parent.id, limit: 1 })
			)
		);
		expect(call).toHaveBeenLastCalledWith(
			'listContainmentChildren',
			{ id: parent.id, limit: 1 },
			{}
		);

		await expect(listContainmentChildren('ghost')).rejects.toBeInstanceOf(NotFoundError);
	});

	it('the two paged wrappers walk their pages through the engine', async () => {
		const project = fakeProject();
		const { call } = await engineOver(project);
		const all = roots(project);

		expect(all.length).toBeGreaterThan(READ_PAGE_LIMIT);
		const pages = Math.ceil(all.length / READ_PAGE_LIMIT);

		const rootsPage = await listContainmentRootsPaged(all.length + 10);
		expect(rootsPage.total).toBe(all.length);
		const expected = Array.from(
			{ length: pages },
			(_, page) =>
				TreeItemPageSchema.parse(
					direct(project, 'listContainmentRoots', {
						limit: READ_PAGE_LIMIT,
						offset: page * READ_PAGE_LIMIT
					})
				).items
		).flat();
		expect(rootsPage.items).toEqual(expected);
		expect(new Set(ids(rootsPage.items))).toEqual(new Set(ids(all)));
		const rootCalls = call.mock.calls.filter(([method]) => method === 'listContainmentRoots');
		expect(rootCalls.map(([, params]) => params)).toEqual(
			Array.from({ length: pages }, (_, page) => ({
				limit: Math.min(READ_PAGE_LIMIT, all.length + 10 - page * READ_PAGE_LIMIT),
				offset: page * READ_PAGE_LIMIT
			}))
		);

		const excluded = await listExcludedRootsPaged(3, undefined, 2, 'v-none');
		expect(ids(excluded.items)).toEqual(ids(rootsPage.items.slice(2, 5)));
		expect(call).toHaveBeenLastCalledWith(
			'listExcludedRoots',
			{ limit: 3, offset: 2, view_id: 'v-none' },
			{}
		);
	});
});

describe('the surfaces', () => {
	it('a query that is not blank goes to search, anything else to elements', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const onSearch = await engineOver(project, sides('engine', 'search'));
		const routes: string[] = [];
		server.use(
			http.get(`${project.baseUrl}/model/elements`, ({ request }) => {
				routes.push(new URL(request.url).search);
				return HttpResponse.json({ items: [], total: 0 });
			})
		);
		setActiveBaseUrl(project.baseUrl);

		await listElementsPage({ q: 'sta' });
		expect(onSearch.call).toHaveBeenCalledTimes(1);
		await listElementsPage({ q: '  ' });
		await listElementsPage({ type: 'Person' });
		expect(onSearch.call).toHaveBeenCalledTimes(1);
		expect(routes).toEqual(['?q=++', '?type=Person']);

		const onElements = await engineOver(project, sides('engine', 'elements'));
		routes.length = 0;
		await listElementsPage({ q: '  ' });
		await listElementsPage();
		expect(onElements.call).toHaveBeenCalledTimes(2);
		await listElementsPage({ q: 'sta' });
		expect(onElements.call).toHaveBeenCalledTimes(2);
		expect(routes).toEqual(['?q=sta']);
	});

	it('a signal reaches the engine: a search aborted mid-scan rejects with an AbortError', async () => {
		const project = fakeProject();
		const { over, call } = await engineOver(project);
		const controller = new AbortController();

		const search = listElementsPage({ q: 'a', limit: 500, signal: controller.signal });
		controller.abort();
		await expect(search).rejects.toMatchObject({ name: 'AbortError' });
		expect(call).toHaveBeenLastCalledWith(
			'listElementsPage',
			{ q: 'a', limit: 500 },
			{ signal: controller.signal }
		);
		expect(over.calls.at(-1)).toMatchObject({
			method: 'listElementsPage',
			signal: controller.signal
		});

		// The engine is still there for the next read.
		await expect(listElementsPage({ q: 'sta' })).resolves.toMatchObject({
			total: expect.any(Number)
		});
	});

	it("on the server a signal is the fetch's, never a query parameter", async () => {
		const inits: { url: string; signal: AbortSignal | null | undefined }[] = [];
		const fetchSpy = ((url: string, init: RequestInit) => {
			inits.push({ url, signal: init.signal });
			return Promise.resolve(
				new Response(JSON.stringify({ items: [], total: 0 }), {
					headers: { 'Content-Type': 'application/json' }
				})
			);
		}) as unknown as typeof fetch;
		const cfg = { baseUrl: 'http://api.test/api/v1/projects/p', fetch: fetchSpy };
		const signal = new AbortController().signal;

		await listElementsPage({ q: 'sta', signal }, cfg);
		await listElementRelationships('e_1', { direction: 'in', signal }, cfg);
		await listContainmentRoots({ limit: 5, signal }, cfg);
		await listExcludedRoots({ viewId: 'v', signal }, cfg);
		await listContainmentChildren('e_1', { offset: 1, signal }, cfg);

		expect(inits.map((init) => init.signal)).toEqual([signal, signal, signal, signal, signal]);
		for (const init of inits) expect(init.url).not.toContain('signal');
		expect(inits.map((init) => new URL(init.url).search)).toEqual([
			'?q=sta',
			'?direction=in',
			'?limit=5',
			'?view_id=v',
			'?offset=1'
		]);
	});

	it('with the replica on the server side every read goes to the server', async () => {
		const project = fakeProject();
		const over = syncOver(project, {
			connect: () => Promise.reject(new FrameError('same-host', 'no frame here'))
		});
		made.push(over);
		server.use(...project.handlers());
		over.sync.open(project.projectId);
		await over.sync.settled();
		expect(over.sync.status().phase).toBe('server');
		const call = vi.fn(
			(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown> =>
				over.sync.call(method, params, options)
		);
		installEngineSeam(
			createEngineSeam(
				{ status: () => over.sync.status(), call: call as typeof over.sync.call },
				allEngine
			)
		);

		const hit: string[] = [];
		const base = project.baseUrl;
		const element = { id: 'e_000001', type_name: 'Organization', properties: {}, rev: 0 };
		const tree = { items: [], total: 0 };
		server.use(
			http.get(`${base}/model/elements/:id/relationships`, () => {
				hit.push('relationships');
				return HttpResponse.json({ items: [], total: 0 });
			}),
			http.get(`${base}/model/elements/:id/children`, () => {
				hit.push('children');
				return HttpResponse.json(tree);
			}),
			http.post(`${base}/model/elements/batch`, () => {
				hit.push('batch');
				return HttpResponse.json({ items: [element] });
			}),
			http.post(`${base}/model/elements/tree-items`, () => {
				hit.push('tree-items');
				return HttpResponse.json({ items: [] });
			}),
			http.get(`${base}/model/elements/:id`, () => {
				hit.push('element');
				return HttpResponse.json(element);
			}),
			http.get(`${base}/model/elements`, () => {
				hit.push('page');
				return HttpResponse.json({ items: [], total: 0 });
			}),
			http.get(`${base}/model/summary`, () => {
				hit.push('summary');
				return HttpResponse.json({ model_rev: 9, element_count: 0, relationship_count: 0 });
			}),
			http.get(`${base}/model/containment/roots/excluded`, () => {
				hit.push('excluded');
				return HttpResponse.json(tree);
			}),
			http.get(`${base}/model/containment/roots`, () => {
				hit.push('roots');
				return HttpResponse.json(tree);
			})
		);
		setActiveBaseUrl(base);

		await getElement('e_000001');
		await getElementsBatch(['e_000001']);
		await getTreeItemsBatch(['e_000001']);
		await listElementsPage();
		await listElementsPage({ q: 'sta' });
		await listElementRelationships('e_000001');
		await expect(getModelSummary()).resolves.toMatchObject({ model_rev: 9 });
		await listContainmentRoots();
		await listExcludedRoots({ viewId: 'v-1' });
		await listContainmentChildren('e_000001');

		expect(hit).toEqual([
			'element',
			'batch',
			'tree-items',
			'page',
			'page',
			'relationships',
			'summary',
			'roots',
			'excluded',
			'children'
		]);
		expect(call).not.toHaveBeenCalled();
	});
});
