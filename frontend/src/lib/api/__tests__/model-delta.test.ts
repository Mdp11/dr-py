import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import {
	applyCrSession,
	applyOps,
	loadModelFromPath,
	saveModelToPath,
	undoOps,
	uploadModelBody
} from '../model-ops';
import {
	downloadModel,
	getChanges,
	getChangesSummary,
	getModelSummary,
	getNeighborhood,
	listContainmentChildren,
	listContainmentRoots,
	listElementRelationships,
	listElementsPage
} from '../model-read';
import { ConflictError, NotFoundError } from '../errors';
import type { ChangeRequest } from '$lib/state/cr';
import type { Op } from '$lib/state/ops';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const element = { id: 'e1', type_name: 'Block', properties: { name: 'A' }, rev: 1 };
const relationship = {
	id: 'r1',
	type_name: 'Link',
	source_id: 'e1',
	target_id: 'e2',
	properties: {},
	rev: 0
};

const summary = {
	model_rev: 7,
	element_count: 2,
	relationship_count: 1,
	elements_by_type: { Block: 2 },
	issue_counts: { error: 1 },
	undo_depth: 3
};

describe('model-ops client', () => {
	it('applyOps POSTs {base_rev, ops} and parses the delta (defaults applied)', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/model/ops`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json({ model_rev: 5 });
			})
		);
		const ops: Op[] = [{ kind: 'delete_element', id: 'e1' }];
		const res = await applyOps(4, ops, cfg);
		expect(body).toEqual({ base_rev: 4, ops });
		expect(res.model_rev).toBe(5);
		expect(res.id_map).toEqual({});
		expect(res.changed_elements).toEqual([]);
		expect(res.issue_counts).toEqual({});
	});

	it('applyOps raises ConflictError carrying the server model_rev on 409', async () => {
		server.use(
			http.post(`${BASE}/model/ops`, () =>
				HttpResponse.json({ detail: 'base_rev 1 does not match', model_rev: 9 }, { status: 409 })
			)
		);
		const err = await applyOps(1, [], cfg).catch((e) => e);
		expect(err).toBeInstanceOf(ConflictError);
		expect((err.body as { model_rev: number }).model_rev).toBe(9);
	});

	it('undoOps POSTs /model/undo and parses the delta', async () => {
		server.use(
			http.post(`${BASE}/model/undo`, () =>
				HttpResponse.json({ model_rev: 3, deleted_element_ids: ['e9'] })
			)
		);
		const res = await undoOps(cfg);
		expect(res.model_rev).toBe(3);
		expect(res.deleted_element_ids).toEqual(['e9']);
	});

	it('applyCrSession sends {cr} WITHOUT a model field (session mode)', async () => {
		let body: Record<string, unknown> = {};
		server.use(
			http.post(`${BASE}/model/apply-cr`, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return HttpResponse.json({ model_rev: 8 });
			})
		);
		const cr: ChangeRequest = {
			format: 'datarover.cr/v1',
			createdAt: '2026-06-11T00:00:00.000Z',
			baseline: { filename: null, elementCount: 0, relationshipCount: 0 },
			ops: {
				elements: { added: [element], modified: [], deleted: [] },
				relationships: { added: [], modified: [], deleted: [] }
			}
		};
		const res = await applyCrSession(cr, cfg);
		expect('model' in body).toBe(false);
		expect(body.cr).toEqual(cr);
		expect(res.model_rev).toBe(8);
	});

	it('loadModelFromPath POSTs the path and parses a summary', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/model/load`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json(summary);
			})
		);
		const res = await loadModelFromPath('/tmp/model.json', cfg);
		expect(body).toEqual({ path: '/tmp/model.json' });
		expect(res).toEqual(summary);
	});

	it('uploadModelBody streams the raw body unmodified', async () => {
		let raw = '';
		server.use(
			http.post(`${BASE}/model/upload`, async ({ request }) => {
				raw = await request.text();
				return HttpResponse.json(summary);
			})
		);
		const payload = '{"elements": [], "relationships": []}';
		const res = await uploadModelBody(payload, cfg);
		expect(raw).toBe(payload);
		expect(res.model_rev).toBe(7);
	});

	it('saveModelToPath POSTs the path and parses the save response', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/model/save`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json({
					path: '/tmp/out.json',
					element_count: 2,
					relationship_count: 1,
					bytes_written: 123
				});
			})
		);
		const res = await saveModelToPath('/tmp/out.json', cfg);
		expect(body).toEqual({ path: '/tmp/out.json' });
		expect(res.bytes_written).toBe(123);
	});
});

describe('model-read client', () => {
	it('getModelSummary parses the summary (nullable issue_counts)', async () => {
		server.use(
			http.get(`${BASE}/model/summary`, () =>
				HttpResponse.json({ ...summary, issue_counts: null, undo_depth: 0 })
			)
		);
		const res = await getModelSummary(cfg);
		expect(res.issue_counts).toBeNull();
		expect(res.elements_by_type).toEqual({ Block: 2 });
	});

	it('listElementsPage forwards type/q/limit/offset and parses the page', async () => {
		let url = '';
		server.use(
			http.get(`${BASE}/model/elements`, ({ request }) => {
				url = request.url;
				return HttpResponse.json({ items: [element], total: 42 });
			})
		);
		const res = await listElementsPage({ type: 'Block', q: 'foo', limit: 10, offset: 20 }, cfg);
		expect(url).toContain('type=Block');
		expect(url).toContain('q=foo');
		expect(url).toContain('limit=10');
		expect(url).toContain('offset=20');
		expect(res.items).toEqual([element]);
		expect(res.total).toBe(42);
	});

	it('getNeighborhood forwards hops/cap and parses nodes/edges/hops_by_id', async () => {
		let url = '';
		server.use(
			http.get(`${BASE}/model/elements/e1/neighborhood`, ({ request }) => {
				url = request.url;
				return HttpResponse.json({
					nodes: [element],
					edges: [relationship],
					hops_by_id: { e1: 0 },
					truncated: true
				});
			})
		);
		const res = await getNeighborhood('e1', { hops: 3, cap: 50 }, cfg);
		expect(url).toContain('hops=3');
		expect(url).toContain('cap=50');
		expect(res.truncated).toBe(true);
		expect(res.hops_by_id).toEqual({ e1: 0 });
	});

	it('listElementRelationships forwards direction and parses the page', async () => {
		let url = '';
		server.use(
			http.get(`${BASE}/model/elements/e1/relationships`, ({ request }) => {
				url = request.url;
				return HttpResponse.json({ items: [relationship], total: 1 });
			})
		);
		const res = await listElementRelationships('e1', { direction: 'out' }, cfg);
		expect(url).toContain('direction=out');
		expect(res.items[0].id).toBe('r1');
	});

	it('listContainmentRoots and listContainmentChildren parse containment pages', async () => {
		server.use(
			http.get(`${BASE}/model/containment/roots`, () =>
				HttpResponse.json({ items: [{ element, child_count: 2 }], total: 1 })
			),
			http.get(`${BASE}/model/elements/e1/children`, () =>
				HttpResponse.json({ items: [], total: 0 })
			)
		);
		const roots = await listContainmentRoots(undefined, cfg);
		expect(roots.items[0].child_count).toBe(2);
		const children = await listContainmentChildren('e1', { limit: 5 }, cfg);
		expect(children.total).toBe(0);
	});

	it('getChanges parses the datarover.cr/v1 document + complete flag', async () => {
		server.use(
			http.get(`${BASE}/model/changes`, () =>
				HttpResponse.json({
					format: 'datarover.cr/v1',
					createdAt: '2026-06-11T00:00:00.000Z',
					baseline: { filename: null, elementCount: 1, relationshipCount: 0 },
					ops: {
						elements: { added: [element], modified: [], deleted: [] },
						relationships: { added: [], modified: [], deleted: [] }
					},
					complete: false
				})
			)
		);
		const doc = await getChanges(cfg);
		expect(doc.format).toBe('datarover.cr/v1');
		expect(doc.ops.elements.added).toEqual([element]);
		expect(doc.complete).toBe(false);
	});

	it('getChangesSummary parses the counts', async () => {
		server.use(
			http.get(`${BASE}/model/changes/summary`, () =>
				HttpResponse.json({ batches: 2, ops: 3, adds: 1, modifies: 1, deletes: 1, complete: true })
			)
		);
		const res = await getChangesSummary(cfg);
		expect(res).toEqual({ batches: 2, ops: 3, adds: 1, modifies: 1, deletes: 1, complete: true });
	});

	it('downloadModel returns the raw Response without parsing', async () => {
		server.use(
			http.get(`${BASE}/model/download`, () =>
				HttpResponse.text('{"elements": []}', {
					headers: { 'Content-Disposition': 'attachment; filename="model.json"' }
				})
			)
		);
		const res = await downloadModel(cfg);
		expect(res).toBeInstanceOf(Response);
		expect(await res.text()).toBe('{"elements": []}');
	});

	it('downloadModel raises typed errors on failure', async () => {
		server.use(
			http.get(`${BASE}/model/download`, () =>
				HttpResponse.json({ error: 'No model loaded' }, { status: 404 })
			)
		);
		await expect(downloadModel(cfg)).rejects.toBeInstanceOf(NotFoundError);
	});
});
