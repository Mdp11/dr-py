import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';

import type { Element, OpsResponse, Relationship } from '$lib/api/types';
import { server } from '../../api/__tests__/server';
import {
	applyDelta,
	emit,
	ensureElement,
	ensureRelationship,
	flushNow,
	getCachedElements,
	getCachedRelationships,
	getIssueCounts,
	getIssuesByOwner,
	getModelError,
	getModelRev,
	getModelSummary,
	getUndoDepth,
	hasPendingOps,
	loadSummary,
	refreshSummary,
	resetModelStore,
	setModelApiConfig,
	undo,
	validateAll
} from '../model.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setModelApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	vi.useRealTimers();
	server.resetHandlers();
});
afterAll(() => {
	setModelApiConfig(undefined);
	server.close();
});
beforeEach(() => {
	resetModelStore();
});

function el(id: string, props: Record<string, unknown> = {}, rev = 0): Element {
	return { id, type_name: 'Block', properties: props, rev };
}

function rel(id: string, source: string, target: string, rev = 0): Relationship {
	return { id, type_name: 'Link', source_id: source, target_id: target, properties: {}, rev };
}

function delta(partial: Partial<OpsResponse>): OpsResponse {
	return {
		model_rev: partial.model_rev ?? getModelRev() + 1,
		id_map: {},
		changed_elements: [],
		changed_relationships: [],
		deleted_element_ids: [],
		deleted_relationship_ids: [],
		issues_removed_owner_ids: [],
		issues_added: [],
		issue_counts: {},
		...partial
	};
}

const summary = {
	model_rev: 4,
	element_count: 10,
	relationship_count: 5,
	elements_by_type: { Block: 10 },
	issue_counts: { warning: 2 },
	undo_depth: 1
};

describe('applyDelta', () => {
	it('upserts changed entities, drops deleted ids, adopts rev + counts', () => {
		applyDelta(
			delta({
				model_rev: 3,
				changed_elements: [el('e1', { name: 'A' }, 1), el('e2')],
				changed_relationships: [rel('r1', 'e1', 'e2')],
				issue_counts: { error: 1 }
			})
		);
		expect(getCachedElements().get('e1')?.properties.name).toBe('A');
		expect(getCachedRelationships().has('r1')).toBe(true);
		expect(getModelRev()).toBe(3);
		expect(getIssueCounts()).toEqual({ error: 1 });

		applyDelta(
			delta({
				model_rev: 4,
				deleted_element_ids: ['e2'],
				deleted_relationship_ids: ['r1'],
				issue_counts: {}
			})
		);
		expect(getCachedElements().has('e2')).toBe(false);
		expect(getCachedRelationships().has('r1')).toBe(false);
		expect(getModelRev()).toBe(4);
	});

	it('remaps temp ids in cache keys, endpoints, and ref-shaped property values', () => {
		applyDelta(
			delta({
				model_rev: 1,
				changed_elements: [
					el('tmp_a', { name: 'New' }),
					el('e9', { ref: 'tmp_a', refs: ['tmp_a', 'e1'] })
				],
				changed_relationships: [rel('tmp_r', 'tmp_a', 'e9')]
			})
		);
		applyDelta(delta({ model_rev: 2, id_map: { tmp_a: 'E1', tmp_r: 'R1' } }));

		expect(getCachedElements().has('tmp_a')).toBe(false);
		expect(getCachedElements().get('E1')?.id).toBe('E1');
		expect(getCachedElements().get('e9')?.properties.ref).toBe('E1');
		expect(getCachedElements().get('e9')?.properties.refs).toEqual(['E1', 'e1']);
		expect(getCachedRelationships().has('tmp_r')).toBe(false);
		const r = getCachedRelationships().get('R1');
		expect(r?.source_id).toBe('E1');
		expect(r?.target_id).toBe('e9');
	});

	it('preserves object identity of cached entities untouched by an id_map remap', () => {
		applyDelta(
			delta({
				model_rev: 1,
				changed_elements: [
					el('tmp_a'),
					el('touched', { ref: 'tmp_a' }),
					el('untouched', { ref: 'e1', refs: ['e1', 'e2'] })
				],
				changed_relationships: [rel('r_untouched', 'untouched', 'e1')]
			})
		);
		const untouchedBefore = getCachedElements().get('untouched');
		const touchedBefore = getCachedElements().get('touched');
		const relBefore = getCachedRelationships().get('r_untouched');

		applyDelta(delta({ model_rev: 2, id_map: { tmp_a: 'E1' } }));

		// entities that referenced no temp id keep their exact object (no
		// subscription churn), while touched ones are rewritten
		expect(getCachedElements().get('untouched')).toBe(untouchedBefore);
		expect(getCachedRelationships().get('r_untouched')).toBe(relBefore);
		expect(getCachedElements().get('touched')).not.toBe(touchedBefore);
		expect(getCachedElements().get('touched')?.properties.ref).toBe('E1');
	});

	it('applies the issue-store delta keyed by owner (target_ids[0])', () => {
		applyDelta(
			delta({
				issues_added: [
					{ severity: 'error', message: 'broken', target_ids: ['e1'] },
					{ severity: 'warning', message: 'meh', target_ids: ['e1', 'e2'] },
					{ severity: 'warning', message: 'other', target_ids: ['e2'] }
				],
				issue_counts: { error: 1, warning: 2 }
			})
		);
		expect(getIssuesByOwner().get('e1')).toHaveLength(2);
		expect(getIssuesByOwner().get('e2')).toHaveLength(1);

		applyDelta(
			delta({
				issues_removed_owner_ids: ['e1'],
				issues_added: [{ severity: 'error', message: 'still broken', target_ids: ['e1'] }],
				issue_counts: { error: 1, warning: 1 }
			})
		);
		expect(getIssuesByOwner().get('e1')).toHaveLength(1);
		expect(getIssuesByOwner().get('e1')?.[0].message).toBe('still broken');
		expect(getIssuesByOwner().get('e2')).toHaveLength(1);
		expect(getIssueCounts()).toEqual({ error: 1, warning: 1 });
	});
});

describe('emit', () => {
	it('applies ops optimistically and synchronously', () => {
		vi.useFakeTimers();
		emit({ kind: 'create_element', temp_id: 'tmp_a', type_name: 'Block', properties: { n: 1 } });
		expect(getCachedElements().get('tmp_a')?.properties.n).toBe(1);
		expect(hasPendingOps()).toBe(true);

		emit({ kind: 'update_element', id: 'tmp_a', properties_patch: { n: 2, gone: null } });
		expect(getCachedElements().get('tmp_a')?.properties.n).toBe(2);

		emit({ kind: 'delete_element', id: 'tmp_a' });
		expect(getCachedElements().has('tmp_a')).toBe(false);
	});

	it('cascades cached relationship deletion on optimistic delete_element', () => {
		vi.useFakeTimers();
		applyDelta(
			delta({
				changed_elements: [el('e1'), el('e2')],
				changed_relationships: [rel('r1', 'e1', 'e2'), rel('r2', 'e2', 'e1'), rel('r3', 'e2', 'e2')]
			})
		);
		emit({ kind: 'delete_element', id: 'e1' });
		expect(getCachedRelationships().has('r1')).toBe(false);
		expect(getCachedRelationships().has('r2')).toBe(false);
		expect(getCachedRelationships().has('r3')).toBe(true);
	});

	it('flushes structural ops immediately as one batch', async () => {
		vi.useFakeTimers();
		const bodies: Array<{ base_rev: number; ops: unknown[] }> = [];
		server.use(
			http.post(`${BASE}/model/ops`, async ({ request }) => {
				bodies.push((await request.json()) as (typeof bodies)[number]);
				return HttpResponse.json(
					delta({
						model_rev: 1,
						id_map: { tmp_a: 'E1', tmp_r: 'R1' },
						changed_elements: [el('E1', {}, 1)],
						changed_relationships: [rel('R1', 'E1', 'e9', 1)]
					})
				);
			})
		);
		emit({ kind: 'create_element', temp_id: 'tmp_a', type_name: 'Block', properties: {} });
		emit({
			kind: 'create_relationship',
			temp_id: 'tmp_r',
			type_name: 'Link',
			source_id: 'tmp_a',
			target_id: 'e9',
			properties: {}
		});
		expect(bodies).toHaveLength(0); // not sent synchronously
		await vi.advanceTimersByTimeAsync(0);
		await flushNow();
		expect(bodies).toHaveLength(1); // ONE batch with both ops
		expect(bodies[0].base_rev).toBe(0);
		expect(bodies[0].ops).toHaveLength(2);
		// temp ids remapped after ack
		expect(getCachedElements().has('tmp_a')).toBe(false);
		expect(getCachedElements().has('E1')).toBe(true);
		expect(getCachedRelationships().get('R1')?.source_id).toBe('E1');
		expect(getModelRev()).toBe(1);
		expect(getUndoDepth()).toBe(1);
		expect(hasPendingOps()).toBe(false);
	});

	it('debounces property updates and coalesces patches to the same entity', async () => {
		vi.useFakeTimers();
		applyDelta(delta({ model_rev: 2, changed_elements: [el('e1', { name: 'A' }, 1)] }));
		const bodies: Array<{ base_rev: number; ops: Array<Record<string, unknown>> }> = [];
		server.use(
			http.post(`${BASE}/model/ops`, async ({ request }) => {
				bodies.push((await request.json()) as (typeof bodies)[number]);
				return HttpResponse.json(
					delta({ model_rev: 3, changed_elements: [el('e1', { name: 'C' }, 2)] })
				);
			})
		);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'B' } });
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'C', x: null } });
		// optimistic merge visible immediately
		expect(getCachedElements().get('e1')?.properties.name).toBe('C');

		await vi.advanceTimersByTimeAsync(299);
		expect(bodies).toHaveLength(0); // still inside the debounce window
		await vi.advanceTimersByTimeAsync(2);
		await flushNow();
		expect(bodies).toHaveLength(1);
		expect(bodies[0].ops).toHaveLength(1); // coalesced into one op
		expect(bodies[0].ops[0]).toEqual({
			kind: 'update_element',
			id: 'e1',
			properties_patch: { name: 'C', x: null } // later keys win, nulls survive
		});
	});

	it('serializes flushes (single in-flight batch) and remaps queued temp ids', async () => {
		const bodies: Array<{ base_rev: number; ops: Array<Record<string, unknown>> }> = [];
		let active = 0;
		let maxActive = 0;
		const gates: Array<() => void> = [];
		server.use(
			http.post(`${BASE}/model/ops`, async ({ request }) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				const body = (await request.json()) as (typeof bodies)[number];
				bodies.push(body);
				await new Promise<void>((resolve) => gates.push(resolve));
				active -= 1;
				const isCreate = body.ops[0].kind === 'create_element';
				return HttpResponse.json(
					delta({
						model_rev: isCreate ? 1 : 2,
						id_map: isCreate ? { tmp_a: 'E1' } : {},
						changed_elements: isCreate ? [el('E1', {}, 1)] : [el('E1', { name: 'B' }, 2)]
					})
				);
			})
		);
		emit({ kind: 'create_element', temp_id: 'tmp_a', type_name: 'Block', properties: {} });
		const done = flushNow();
		await vi.waitFor(() => expect(gates).toHaveLength(1));
		// batch 1 is in flight; emit an op referencing its temp id
		emit({ kind: 'update_element', id: 'tmp_a', properties_patch: { name: 'B' } });
		expect(hasPendingOps()).toBe(true);
		gates[0]();
		await vi.waitFor(() => expect(gates).toHaveLength(2));
		gates[1]();
		await done;
		await flushNow();

		expect(maxActive).toBe(1); // never two concurrent batches
		expect(bodies).toHaveLength(2);
		expect(bodies[0].base_rev).toBe(0);
		expect(bodies[1].base_rev).toBe(1); // second batch built on the acked rev
		// the queued update was remapped tmp_a -> E1 before being sent
		expect(bodies[1].ops[0]).toEqual({
			kind: 'update_element',
			id: 'E1',
			properties_patch: { name: 'B' }
		});
		expect(getCachedElements().get('E1')?.properties.name).toBe('B');
		expect(hasPendingOps()).toBe(false);
	});

	it('enters conflict state on 409: error surfaced, summary refetched, flushing frozen', async () => {
		let opsRequests = 0;
		server.use(
			http.post(`${BASE}/model/ops`, () => {
				opsRequests += 1;
				return HttpResponse.json(
					{ detail: 'base_rev 0 does not match current model_rev 9', model_rev: 9 },
					{ status: 409 }
				);
			}),
			http.get(`${BASE}/model/summary`, () => HttpResponse.json({ ...summary, model_rev: 9 }))
		);
		applyDelta(delta({ model_rev: 0, changed_elements: [el('e1', { name: 'A' })] }));
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'B' } });
		await flushNow();

		expect(getModelError()?.kind).toBe('conflict');
		expect(getModelRev()).toBe(9); // resynced from the summary refetch
		expect(hasPendingOps()).toBe(false); // queue dropped
		// cache not corrupted by half-applied state: optimistic value retained,
		// caches are declared divergent until reload
		expect(getCachedElements().get('e1')?.properties.name).toBe('B');

		// further emits do not hit the server while conflicted
		emit({ kind: 'delete_element', id: 'e1' });
		await flushNow();
		expect(opsRequests).toBe(1);
	});

	it('drops emit() entirely in conflict state: queue stays empty, no request', async () => {
		let opsRequests = 0;
		server.use(
			http.post(`${BASE}/model/ops`, () => {
				opsRequests += 1;
				return HttpResponse.json({ detail: 'rev conflict', model_rev: 9 }, { status: 409 });
			}),
			http.get(`${BASE}/model/summary`, () => HttpResponse.json({ ...summary, model_rev: 9 }))
		);
		applyDelta(delta({ model_rev: 0, changed_elements: [el('e1', { name: 'A' })] }));
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'B' } });
		await flushNow();
		expect(getModelError()?.kind).toBe('conflict');
		expect(opsRequests).toBe(1);

		emit({ kind: 'delete_element', id: 'e1' });
		expect(hasPendingOps()).toBe(false); // dropped, not queued
		expect(getCachedElements().has('e1')).toBe(true); // not even applied optimistically
		await flushNow();
		expect(opsRequests).toBe(1); // never reached the server
	});

	it('reverts optimistic state exactly on 422 and surfaces a rejected error', async () => {
		server.use(
			http.post(`${BASE}/model/ops`, () =>
				HttpResponse.json({ detail: "'Block' has no property 'bogus'" }, { status: 422 })
			)
		);
		applyDelta(
			delta({
				model_rev: 1,
				changed_elements: [el('e1', { name: 'A' }, 1), el('e2')],
				changed_relationships: [rel('r1', 'e1', 'e2')]
			})
		);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { bogus: 'x' } });
		emit({ kind: 'create_element', temp_id: 'tmp_n', type_name: 'Block', properties: {} });
		emit({ kind: 'delete_element', id: 'e2' }); // cascades r1 optimistically
		expect(getCachedElements().get('e1')?.properties.bogus).toBe('x');
		expect(getCachedRelationships().has('r1')).toBe(false);
		await flushNow();

		expect(getModelError()?.kind).toBe('rejected');
		expect(getModelError()?.message).toContain('bogus');
		// everything restored to the pre-batch state
		expect(getCachedElements().get('e1')?.properties).toEqual({ name: 'A' });
		expect(getCachedElements().has('tmp_n')).toBe(false);
		expect(getCachedElements().has('e2')).toBe(true);
		expect(getCachedRelationships().get('r1')?.source_id).toBe('e1');
		expect(hasPendingOps()).toBe(false);
		expect(getModelRev()).toBe(1); // rev untouched — the batch never applied
	});
});

describe('reads and lifecycle', () => {
	it('ensureElement: cache hit does not fetch; miss fetches and caches; 404 -> null', async () => {
		let fetches = 0;
		server.use(
			http.get(`${BASE}/model/elements/:id`, ({ params }) => {
				fetches += 1;
				if (params.id === 'missing') {
					return HttpResponse.json({ error: 'No element' }, { status: 404 });
				}
				return HttpResponse.json(el(String(params.id), { name: 'fetched' }, 1));
			})
		);
		applyDelta(delta({ changed_elements: [el('e1', { name: 'cached' })] }));

		expect((await ensureElement('e1'))?.properties.name).toBe('cached');
		expect(fetches).toBe(0);

		expect((await ensureElement('e2'))?.properties.name).toBe('fetched');
		expect(fetches).toBe(1);
		expect(getCachedElements().has('e2')).toBe(true);
		await ensureElement('e2'); // now cached
		expect(fetches).toBe(1);

		expect(await ensureElement('missing')).toBeNull();
		expect(await ensureElement('tmp_unknown')).toBeNull(); // no server round-trip
		expect(fetches).toBe(2);
	});

	it('ensureElement dedups concurrent fetches of the same id onto one request', async () => {
		let fetches = 0;
		const gates: Array<() => void> = [];
		server.use(
			http.get(`${BASE}/model/elements/:id`, async ({ params }) => {
				fetches += 1;
				await new Promise<void>((resolve) => gates.push(resolve));
				return HttpResponse.json(el(String(params.id), { name: 'fetched' }, 1));
			})
		);
		const p1 = ensureElement('e1');
		const p2 = ensureElement('e1');
		await vi.waitFor(() => expect(gates).toHaveLength(1));
		gates[0]();
		const [a, b] = await Promise.all([p1, p2]);
		expect(fetches).toBe(1); // one request shared by both callers
		expect(a).toBe(b);
		expect(a?.properties.name).toBe('fetched');

		// pending entry cleared on settle: a fresh (uncached) lookup fetches again
		resetModelStore();
		const p3 = ensureElement('e1');
		await vi.waitFor(() => expect(gates).toHaveLength(2));
		gates[1]();
		expect((await p3)?.properties.name).toBe('fetched');
		expect(fetches).toBe(2);
	});

	it('ensureRelationship is cache-only (no single-relationship endpoint)', async () => {
		applyDelta(delta({ changed_relationships: [rel('r1', 'a', 'b')] }));
		expect((await ensureRelationship('r1'))?.id).toBe('r1');
		expect(await ensureRelationship('nope')).toBeNull();
	});

	it('refreshSummary adopts rev, undo depth, and issue counts; loadSummary memoizes', async () => {
		let fetches = 0;
		server.use(
			http.get(`${BASE}/model/summary`, () => {
				fetches += 1;
				return HttpResponse.json(summary);
			})
		);
		expect(getModelSummary()).toBeNull();
		await loadSummary();
		expect(getModelSummary()?.element_count).toBe(10);
		expect(getModelRev()).toBe(4);
		expect(getUndoDepth()).toBe(1);
		expect(getIssueCounts()).toEqual({ warning: 2 });
		await loadSummary(); // already loaded
		expect(fetches).toBe(1);
		await refreshSummary();
		expect(fetches).toBe(2);
	});

	it('undo applies the inverse delta and decrements undo depth', async () => {
		server.use(
			http.get(`${BASE}/model/summary`, () => HttpResponse.json(summary)),
			http.post(`${BASE}/model/undo`, () =>
				HttpResponse.json(
					delta({
						model_rev: 5,
						deleted_element_ids: ['e1'],
						issue_counts: {}
					})
				)
			)
		);
		await refreshSummary(); // undo_depth = 1
		applyDelta(delta({ model_rev: 4, changed_elements: [el('e1')] }));

		expect(await undo()).toBe(true);
		expect(getCachedElements().has('e1')).toBe(false);
		expect(getModelRev()).toBe(5);
		expect(getUndoDepth()).toBe(0);
	});

	it('undo resolves false when the history is empty (409)', async () => {
		server.use(
			http.post(`${BASE}/model/undo`, () =>
				HttpResponse.json({ detail: 'Nothing to undo', model_rev: 4 }, { status: 409 })
			),
			http.get(`${BASE}/model/summary`, () => HttpResponse.json({ ...summary, undo_depth: 0 }))
		);
		expect(await undo()).toBe(false);
		expect(getUndoDepth()).toBe(0);
	});

	it('validateAll resets issuesByOwner and counts from the full run', async () => {
		server.use(
			http.post(`${BASE}/model/validate`, () =>
				HttpResponse.json([
					{ severity: 'error', message: 'a', target_ids: ['e1'] },
					{ severity: 'warning', message: 'b', target_ids: ['e1'] },
					{ severity: 'warning', message: 'c', target_ids: ['e2'] }
				])
			)
		);
		applyDelta(
			delta({
				issues_added: [{ severity: 'error', message: 'stale', target_ids: ['gone'] }],
				issue_counts: { error: 1 }
			})
		);
		const issues = await validateAll();
		expect(issues).toHaveLength(3);
		expect(getIssuesByOwner().has('gone')).toBe(false);
		expect(getIssuesByOwner().get('e1')).toHaveLength(2);
		expect(getIssuesByOwner().get('e2')).toHaveLength(1);
		expect(getIssueCounts()).toEqual({ error: 1, warning: 2 });
	});

	it('resetModelStore clears caches, counters, queue, and errors', async () => {
		vi.useFakeTimers();
		applyDelta(
			delta({
				model_rev: 3,
				changed_elements: [el('e1')],
				changed_relationships: [rel('r1', 'e1', 'e1')],
				issues_added: [{ severity: 'error', message: 'x', target_ids: ['e1'] }],
				issue_counts: { error: 1 }
			})
		);
		emit({ kind: 'delete_element', id: 'e1' });
		resetModelStore();
		expect(getCachedElements().size).toBe(0);
		expect(getCachedRelationships().size).toBe(0);
		expect(getIssuesByOwner().size).toBe(0);
		expect(getModelRev()).toBe(0);
		expect(getUndoDepth()).toBe(0);
		expect(getIssueCounts()).toBeNull();
		expect(getModelSummary()).toBeNull();
		expect(getModelError()).toBeNull();
		expect(hasPendingOps()).toBe(false);
		// the cancelled queue never reaches the server (an unhandled request
		// would surface here as a flush error)
		await vi.advanceTimersByTimeAsync(10);
		expect(getModelError()).toBeNull();
	});
});
