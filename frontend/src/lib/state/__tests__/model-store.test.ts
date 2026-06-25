import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';

import type { Element, OpsResponse, Relationship } from '$lib/api/types';
import { server } from '../../api/__tests__/server';
import {
	applyDelta,
	emit,
	ensureElement,
	ensureElements,
	ensureRelationship,
	getCachedElements,
	getCachedRelationships,
	getIssueCounts,
	getIssuesByOwner,
	getMissingElementIds,
	getModelError,
	getModelRev,
	getModelSummary,
	getStructureRev,
	getStagedDepth,
	getStagedOps,
	hasStagedOps,
	loadSummary,
	popLastStaged,
	refreshSummary,
	resetModelStore,
	revertAllStaged,
	seedElements,
	setModelApiConfig,
	setModelError,
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

	it('does NOT bump structureRev for a property-only delta on cached elements', () => {
		// seed e1 into the cache (this first delta is structural: a never-seen
		// element counts as a creation)
		applyDelta(delta({ model_rev: 1, changed_elements: [el('e1', { name: 'A' }, 1)] }));
		const before = getStructureRev();

		// per-keystroke property ack: same element, new properties, no creates/
		// deletes/relationships — structural consumers must not refetch
		applyDelta(delta({ model_rev: 2, changed_elements: [el('e1', { name: 'AB' }, 2)] }));
		expect(getStructureRev()).toBe(before);
		expect(getModelRev()).toBe(2); // model_rev still advances per ack

		applyDelta(delta({ model_rev: 3, changed_elements: [el('e1', { name: 'ABC' }, 3)] }));
		expect(getStructureRev()).toBe(before);
	});

	it('bumps structureRev on create (id_map / unseen element), delete, and relationship change', () => {
		expect(getStructureRev()).toBe(0);

		// creation seen as a never-cached changed element (e.g. apply-cr delta)
		applyDelta(delta({ model_rev: 1, changed_elements: [el('e1', {}, 1)] }));
		expect(getStructureRev()).toBe(1);

		// acked create carrying a temp-id remap
		applyDelta(delta({ model_rev: 2, id_map: { tmp_a: 'E9' } }));
		expect(getStructureRev()).toBe(2);

		// relationship change
		applyDelta(delta({ model_rev: 3, changed_relationships: [rel('r1', 'e1', 'E9', 1)] }));
		expect(getStructureRev()).toBe(3);

		// deletions
		applyDelta(delta({ model_rev: 4, deleted_relationship_ids: ['r1'] }));
		expect(getStructureRev()).toBe(4);
		applyDelta(delta({ model_rev: 5, deleted_element_ids: ['e1'] }));
		expect(getStructureRev()).toBe(5);

		resetModelStore();
		expect(getStructureRev()).toBe(0);
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
					{ severity: 'error', message: 'broken', target_ids: ['e1'], origin: 'on_server' },
					{ severity: 'warning', message: 'meh', target_ids: ['e1', 'e2'], origin: 'on_server' },
					{ severity: 'warning', message: 'other', target_ids: ['e2'], origin: 'on_server' }
				],
				issue_counts: { error: 1, warning: 2 }
			})
		);
		expect(getIssuesByOwner().get('e1')).toHaveLength(2);
		expect(getIssuesByOwner().get('e2')).toHaveLength(1);

		applyDelta(
			delta({
				issues_removed_owner_ids: ['e1'],
				issues_added: [
					{ severity: 'error', message: 'still broken', target_ids: ['e1'], origin: 'on_server' }
				],
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
		expect(hasStagedOps()).toBe(true);

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

	// Converted from 'flushes structural ops immediately as one batch': Spec B
	// stages edits in the buffer with NO auto-flush. Assert both structural ops
	// are staged (queue depth 2, both visible in getStagedOps), caches reflect
	// them optimistically with their TEMP ids (no ack ⇒ no remap), and NO
	// network request is fired (onUnhandledRequest:'error' would throw if one
	// escaped — no handler is registered here).
	it('stages structural ops without flushing', async () => {
		vi.useFakeTimers();
		emit({ kind: 'create_element', temp_id: 'tmp_a', type_name: 'Block', properties: {} });
		emit({
			kind: 'create_relationship',
			temp_id: 'tmp_r',
			type_name: 'Link',
			source_id: 'tmp_a',
			target_id: 'e9',
			properties: {}
		});
		// both staged, no flush ever scheduled
		expect(getStagedDepth()).toBe(2);
		expect(getStagedOps()).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(50); // no timer fires a flush
		// caches hold the optimistic temp-id entries; never remapped (no ack)
		expect(getCachedElements().has('tmp_a')).toBe(true);
		expect(getCachedRelationships().get('tmp_r')?.source_id).toBe('tmp_a');
		expect(getModelRev()).toBe(0); // unchanged — nothing committed
		expect(hasStagedOps()).toBe(true); // staged edits still pending commit
	});

	// Converted from 'debounces property updates and coalesces patches...': the
	// coalescing logic is preserved but there is no debounce/flush. Assert two
	// successive patches to the same entity collapse into ONE staged op (later
	// keys win, nulls survive), the optimistic merge is visible immediately, and
	// no network request fires.
	it('coalesces property patches into one staged op without flushing', async () => {
		vi.useFakeTimers();
		applyDelta(delta({ model_rev: 2, changed_elements: [el('e1', { name: 'A' }, 1)] }));
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'B' } });
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'C', x: null } });
		// optimistic merge visible immediately
		expect(getCachedElements().get('e1')?.properties.name).toBe('C');

		await vi.advanceTimersByTimeAsync(400); // no debounce timer to fire
		const staged = getStagedOps();
		expect(staged).toHaveLength(1); // coalesced into one op
		expect(staged[0]).toEqual({
			kind: 'update_element',
			id: 'e1',
			properties_patch: { name: 'C', x: null } // later keys win, nulls survive
		});
		expect(getModelRev()).toBe(2); // unchanged — nothing committed
	});

	// Converted from 'serializes flushes (single in-flight batch) and remaps
	// queued temp ids': flush serialization no longer exists (no auto-flush, no
	// in-flight batch). The staging analogue: a create followed by an update of
	// the same temp id stays staged as two distinct ops (a create then a
	// property update — they do NOT coalesce, only updates of the same id do),
	// applied optimistically, with no network request.
	it('stages a create then an update of the same temp id (no flush)', async () => {
		emit({ kind: 'create_element', temp_id: 'tmp_a', type_name: 'Block', properties: {} });
		emit({ kind: 'update_element', id: 'tmp_a', properties_patch: { name: 'B' } });
		expect(hasStagedOps()).toBe(true);
		// no remap (no ack): the temp id is still the cache key
		expect(getCachedElements().get('tmp_a')?.properties.name).toBe('B');
		const staged = getStagedOps();
		expect(staged).toHaveLength(2);
		expect(staged[0].kind).toBe('create_element');
		expect(staged[1]).toEqual({
			kind: 'update_element',
			id: 'tmp_a',
			properties_patch: { name: 'B' }
		});
		expect(getStagedDepth()).toBe(2); // both ops remain staged until commit
	});

	// Converted from 'does not clobber a newer queued optimistic edit when an
	// in-flight batch acks': there is no in-flight batch anymore, but the
	// applyDelta queue-guard (hasQueuedOpFor) is preserved and still load-bearing
	// for peer deltas arriving over the realtime feed while the user has staged
	// edits. Assert an incoming delta carrying a stale value does NOT clobber a
	// staged optimistic edit for the same entity.
	it('applyDelta does not clobber a staged optimistic edit for the same entity', () => {
		applyDelta(delta({ model_rev: 1, changed_elements: [el('e1', { name: 'A' }, 1)] }));
		// user stages an edit -> optimistic 'C'
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'C' } });
		expect(getCachedElements().get('e1')?.properties.name).toBe('C');
		// a delta arrives carrying a stale 'B' for the same (still-staged) entity
		applyDelta(delta({ model_rev: 2, changed_elements: [el('e1', { name: 'B' }, 9)] }));
		// the staged optimistic value is preserved — no revert flicker
		expect(getCachedElements().get('e1')?.properties.name).toBe('C');
		expect(hasStagedOps()).toBe(true);
	});

	// Converted from 'enters conflict state on 409...': the 409/flush networking
	// path is gone (the conflict state is now driven by the realtime feed via
	// setModelError, not by a flush response). The load-bearing behavior that
	// survives is the emit conflict-DROP guard. Assert that, once conflicted,
	// emit drops ops entirely — not applied, not staged — so the staged buffer
	// cannot diverge while the model is known-stale.
	it('drops emit() entirely in conflict state: buffer stays empty, no apply', () => {
		applyDelta(delta({ model_rev: 0, changed_elements: [el('e1', { name: 'A' })] }));
		setModelError({ kind: 'conflict', message: 'rev conflict' });
		expect(getModelError()?.kind).toBe('conflict');

		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'B' } });
		expect(hasStagedOps()).toBe(false); // dropped, not staged
		// not even applied optimistically — the cache keeps its pre-conflict value
		expect(getCachedElements().get('e1')?.properties.name).toBe('A');

		emit({ kind: 'delete_element', id: 'e1' });
		expect(hasStagedOps()).toBe(false);
		expect(getCachedElements().has('e1')).toBe(true); // delete not applied either
	});

	// Converted from 'reverts optimistic state exactly on 422...': the 422/flush
	// rejection path is gone, but the journal-driven exact revert it exercised is
	// preserved and now surfaced as the client-side revertAllStaged (the
	// "discard all staged edits" action). Assert a mixed batch (update / create /
	// cascading delete) reverts the caches exactly to the pre-staging state.
	it('revertAllStaged restores the caches exactly across a mixed batch', () => {
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

		revertAllStaged();

		// everything restored to the pre-staging state
		expect(getCachedElements().get('e1')?.properties).toEqual({ name: 'A' });
		expect(getCachedElements().has('tmp_n')).toBe(false);
		expect(getCachedElements().has('e2')).toBe(true);
		expect(getCachedRelationships().get('r1')?.source_id).toBe('e1');
		expect(hasStagedOps()).toBe(false);
		expect(getModelRev()).toBe(1); // rev untouched — nothing committed
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

	it('refreshSummary adopts rev and issue counts; loadSummary memoizes', async () => {
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
		// Spec B: the staged buffer (not the server's undo_depth) drives Undo;
		// no edits staged here.
		expect(getStagedDepth()).toBe(0);
		expect(getIssueCounts()).toEqual({ warning: 2 });
		await loadSummary(); // already loaded
		expect(fetches).toBe(1);
		await refreshSummary();
		expect(fetches).toBe(2);
	});

	// Spec B client-side undo: popLastStaged reverts the LAST STAGED op (there is
	// no server-undo). Assert it reverts the staged create, drops it from the
	// buffer, and reports success; no network request is involved.
	it('popLastStaged reverts the last staged op client-side', () => {
		seedElements([el('e0', { name: 'kept' }, 1)]);
		emit({ kind: 'create_element', temp_id: 'e1', type_name: 'Block', properties: {} });
		expect(getCachedElements().has('e1')).toBe(true);
		expect(getStagedDepth()).toBe(1);

		expect(popLastStaged()).toBe(true);
		expect(getCachedElements().has('e1')).toBe(false); // staged create reverted
		expect(getCachedElements().has('e0')).toBe(true); // untouched
		expect(getStagedDepth()).toBe(0);
	});

	it('popLastStaged returns false when the staged buffer is empty', () => {
		expect(popLastStaged()).toBe(false);
		expect(getStagedDepth()).toBe(0);
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
				issues_added: [
					{ severity: 'error', message: 'stale', target_ids: ['gone'], origin: 'on_server' }
				],
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
				issues_added: [
					{ severity: 'error', message: 'x', target_ids: ['e1'], origin: 'on_server' }
				],
				issue_counts: { error: 1 }
			})
		);
		emit({ kind: 'delete_element', id: 'e1' });
		resetModelStore();
		expect(getCachedElements().size).toBe(0);
		expect(getCachedRelationships().size).toBe(0);
		expect(getIssuesByOwner().size).toBe(0);
		expect(getModelRev()).toBe(0);
		expect(getStagedDepth()).toBe(0);
		expect(getIssueCounts()).toBeNull();
		expect(getModelSummary()).toBeNull();
		expect(getModelError()).toBeNull();
		expect(hasStagedOps()).toBe(false);
		// the cancelled queue never reaches the server (an unhandled request
		// would surface here as a flush error)
		await vi.advanceTimersByTimeAsync(10);
		expect(getModelError()).toBeNull();
	});
});

describe('ensureElements (batched)', () => {
	it('fetches only uncached ids in one batch and seeds the cache', async () => {
		seedElements([el('a', { name: 'cached' })]);
		const bodies: string[][] = [];
		server.use(
			http.post(`${BASE}/model/elements/batch`, async ({ request }) => {
				const { ids } = (await request.json()) as { ids: string[] };
				bodies.push(ids);
				return HttpResponse.json({ items: ids.map((id) => el(id, { name: id })) });
			})
		);

		await ensureElements(['a', 'b', 'c']);

		// 'a' was cached, so only b,c are requested, in one batch
		expect(bodies).toEqual([['b', 'c']]);
		const cache = getCachedElements();
		expect(cache.get('b')?.properties.name).toBe('b');
		expect(cache.get('c')?.properties.name).toBe('c');
		// the pre-cached element is left untouched (not clobbered by the batch)
		expect(cache.get('a')?.properties.name).toBe('cached');
	});

	it('dedups overlapping concurrent calls onto a single fetch per id', async () => {
		const bodies: string[][] = [];
		let resolveFirst: (() => void) | undefined;
		const gate = new Promise<void>((r) => (resolveFirst = r));
		server.use(
			http.post(`${BASE}/model/elements/batch`, async ({ request }) => {
				const { ids } = (await request.json()) as { ids: string[] };
				bodies.push(ids);
				await gate; // hold both requests open until released
				return HttpResponse.json({ items: ids.map((id) => el(id, { name: id })) });
			})
		);

		// B starts while A is still in flight and shares b,c — B should only fetch d.
		const a = ensureElements(['b', 'c']);
		const b = ensureElements(['c', 'd']);
		resolveFirst!();
		await Promise.all([a, b]);

		expect(bodies).toEqual([['b', 'c'], ['d']]);
	});

	it('is a no-op when every id is cached or a temp id', async () => {
		seedElements([el('a')]);
		server.use(
			http.post(`${BASE}/model/elements/batch`, () => {
				throw new Error('should not fetch');
			})
		);
		await expect(ensureElements(['a', 'tmp_1'])).resolves.toBeUndefined();
	});

	it('records ids the server omits as confirmed-missing and never re-requests them', async () => {
		const bodies: string[][] = [];
		server.use(
			http.post(`${BASE}/model/elements/batch`, async ({ request }) => {
				const { ids } = (await request.json()) as { ids: string[] };
				bodies.push(ids);
				// 'gone' does not exist -> server omits it from the response.
				return HttpResponse.json({ items: ids.filter((id) => id !== 'gone').map((id) => el(id)) });
			})
		);

		await ensureElements(['a', 'gone']);
		expect([...getMissingElementIds()]).toEqual(['gone']);
		expect(getCachedElements().has('a')).toBe(true);

		// A second pass must NOT re-request the known-missing id (only the still-
		// uncached 'b' goes out).
		await ensureElements(['gone', 'b']);
		expect(bodies).toEqual([['a', 'gone'], ['b']]);
	});

	it('un-marks a missing id once it reappears via a delta (restore/create)', async () => {
		server.use(
			http.post(`${BASE}/model/elements/batch`, async ({ request }) => {
				const { ids } = (await request.json()) as { ids: string[] };
				return HttpResponse.json({ items: ids.filter((id) => id !== 'gone').map((id) => el(id)) });
			})
		);
		await ensureElements(['gone']);
		expect(getMissingElementIds().has('gone')).toBe(true);

		applyDelta(delta({ model_rev: 1, changed_elements: [el('gone')] }));
		expect(getMissingElementIds().has('gone')).toBe(false);
	});
});
