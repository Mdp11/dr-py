import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Element, OpsResponse, Relationship } from '$lib/api/types';
import { stubEngine } from '../../api/__tests__/engine-stub';
import { installEngineSeam } from '$lib/api/engine-route';
import { NotFoundError } from '$lib/api/errors';
import { getVisitStack, resetInspectionHistory } from '../inspection-history.svelte';
import { select } from '../selection.svelte';
import {
	adoptIssues,
	applyDelta,
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
	hasStagedOps,
	loadSummary,
	refreshSummary,
	resetModelStore,
	seedElements,
	setModelApiConfig,
	validateAll
} from '../model.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	setModelApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	vi.useRealTimers();
	installEngineSeam(null);
});
afterAll(() => {
	setModelApiConfig(undefined);
});
beforeEach(() => {
	resetModelStore();
	resetInspectionHistory();
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

	it('remaps the inspection-history visit stack through a commit id_map BEFORE the selection re-point', () => {
		// Guards the wiring at model.svelte.ts's applyDelta: remapVisitIds(d.id_map)
		// must run before the selection re-point below it, or a created-then-
		// committed element leaves a dead temp-id entry in the user's back stack.
		select({ kind: 'element', id: 'tmp_a' });
		applyDelta(delta({ model_rev: 2, id_map: { tmp_a: 'E1' } }));
		expect(getVisitStack().map((e) => e.id)).toEqual(['E1']);
	});

	it('applies the issue-store delta keyed by owner (target_ids[0])', () => {
		applyDelta(
			delta({
				issues_added: [
					{
						severity: 'error',
						message: 'broken',
						target_ids: ['e1'],
						check: '',
						origin: 'on_server'
					},
					{
						severity: 'warning',
						message: 'meh',
						target_ids: ['e1', 'e2'],
						check: '',
						origin: 'on_server'
					},
					{
						severity: 'warning',
						message: 'other',
						target_ids: ['e2'],
						check: '',
						origin: 'on_server'
					}
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
					{
						severity: 'error',
						message: 'still broken',
						target_ids: ['e1'],
						check: '',
						origin: 'on_server'
					}
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

describe('reads and lifecycle', () => {
	it('ensureElement: cache hit does not fetch; miss fetches and caches; 404 -> null', async () => {
		let fetches = 0;
		stubEngine({
			getElement: ({ id }: { id: string }) => {
				fetches += 1;
				if (id === 'missing') throw new NotFoundError(404, { error: 'No element' }, 'No element');
				return el(id, { name: 'fetched' }, 1);
			}
		});
		applyDelta(delta({ changed_elements: [el('e1', { name: 'cached' })] }));

		expect((await ensureElement('e1'))?.properties.name).toBe('cached');
		expect(fetches).toBe(0);

		expect((await ensureElement('e2'))?.properties.name).toBe('fetched');
		expect(fetches).toBe(1);
		expect(getCachedElements().has('e2')).toBe(true);
		await ensureElement('e2'); // now cached
		expect(fetches).toBe(1);

		expect(await ensureElement('missing')).toBeNull();
		expect(fetches).toBe(2);
	});

	it('ensureElement dedups concurrent fetches of the same id onto one request', async () => {
		let fetches = 0;
		const gates: Array<() => void> = [];
		stubEngine({
			getElement: async ({ id }: { id: string }) => {
				fetches += 1;
				await new Promise<void>((resolve) => gates.push(resolve));
				return el(id, { name: 'fetched' }, 1);
			}
		});
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

	it('refreshSummary adopts the rev; loadSummary memoizes', async () => {
		let fetches = 0;
		stubEngine({
			getModelSummary: () => {
				fetches += 1;
				return { ...summary, issue_counts: null };
			},
			getModelIssues: () => ({ model_rev: 4, issues: [], counts: {}, truncated: false })
		});
		expect(getModelSummary()).toBeNull();
		await loadSummary();
		expect(getModelSummary()?.element_count).toBe(10);
		expect(getModelRev()).toBe(4);
		// The staged buffer drives Undo; no edits staged here.
		expect(getStagedDepth()).toBe(0);
		await loadSummary(); // already loaded
		expect(fetches).toBe(1);
		await refreshSummary();
		expect(fetches).toBe(2);
	});

	it('validateAll is a pure fetch — the live issuesByOwner/counts are untouched', async () => {
		stubEngine({
			validateModel: () => [
				{ severity: 'error', message: 'a', target_ids: ['e1'] },
				{ severity: 'warning', message: 'b', target_ids: ['e1'] },
				{ severity: 'warning', message: 'c', target_ids: ['e2'] }
			]
		});
		applyDelta(
			delta({
				issues_added: [
					{
						severity: 'error',
						message: 'stale',
						target_ids: ['gone'],
						check: '',
						origin: 'on_server'
					}
				],
				issue_counts: { error: 1 }
			})
		);
		const issues = await validateAll();
		// The returned array is the origin-tagged result of the run — callers
		// (runValidation) store it as the Validate overlay via setOverlay.
		expect(issues).toHaveLength(3);
		// The LIVE committed map is untouched by validateAll: it still reflects
		// applyDelta's committed truth, not the (possibly staged) validate run.
		expect(getIssuesByOwner().has('gone')).toBe(true);
		expect(getIssuesByOwner().has('e1')).toBe(false);
		expect(getIssuesByOwner().has('e2')).toBe(false);
		expect(getIssueCounts()).toEqual({ error: 1 });
	});

	it('resetModelStore clears caches, counters, and errors', () => {
		applyDelta(
			delta({
				model_rev: 3,
				changed_elements: [el('e1')],
				changed_relationships: [rel('r1', 'e1', 'e1')],
				issues_added: [
					{ severity: 'error', message: 'x', target_ids: ['e1'], check: '', origin: 'on_server' }
				],
				issue_counts: { error: 1 }
			})
		);
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
	});
});

describe('ensureElements (batched)', () => {
	it('fetches only uncached ids in one batch and seeds the cache', async () => {
		seedElements([el('a', { name: 'cached' })]);
		const bodies: string[][] = [];
		stubEngine({
			getElementsBatch: ({ ids }: { ids: string[] }) => {
				bodies.push(ids);
				return { items: ids.map((id) => el(id, { name: id })) };
			}
		});

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
		stubEngine({
			getElementsBatch: async ({ ids }: { ids: string[] }) => {
				bodies.push(ids);
				await gate; // hold both requests open until released
				return { items: ids.map((id) => el(id, { name: id })) };
			}
		});

		// B starts while A is still in flight and shares b,c — B should only fetch d.
		const a = ensureElements(['b', 'c']);
		const b = ensureElements(['c', 'd']);
		resolveFirst!();
		await Promise.all([a, b]);

		expect(bodies).toEqual([['b', 'c'], ['d']]);
	});

	it('is a no-op when every id is cached', async () => {
		seedElements([el('a')]);
		stubEngine({
			getElementsBatch: () => {
				throw new Error('should not fetch');
			}
		});
		await expect(ensureElements(['a'])).resolves.toBeUndefined();
	});

	it('records ids the engine omits as confirmed-missing and never re-requests them', async () => {
		const bodies: string[][] = [];
		stubEngine({
			getElementsBatch: ({ ids }: { ids: string[] }) => {
				bodies.push(ids);
				// 'gone' does not exist -> the engine omits it from the answer.
				return { items: ids.filter((id) => id !== 'gone').map((id) => el(id)) };
			}
		});

		await ensureElements(['a', 'gone']);
		expect([...getMissingElementIds()]).toEqual(['gone']);
		expect(getCachedElements().has('a')).toBe(true);

		// A second pass must NOT re-request the known-missing id (only the still-
		// uncached 'b' goes out).
		await ensureElements(['gone', 'b']);
		expect(bodies).toEqual([['a', 'gone'], ['b']]);
	});

	it('un-marks a missing id once it reappears via a delta (restore/create)', async () => {
		stubEngine({
			getElementsBatch: ({ ids }: { ids: string[] }) => ({
				items: ids.filter((id) => id !== 'gone').map((id) => el(id))
			})
		});
		await ensureElements(['gone']);
		expect(getMissingElementIds().has('gone')).toBe(true);

		applyDelta(delta({ model_rev: 1, changed_elements: [el('gone')] }));
		expect(getMissingElementIds().has('gone')).toBe(false);
	});
});

describe('the summary from the engine', () => {
	const engineSummary = { ...summary, model_rev: 6, issue_counts: null, undo_depth: 0 };

	let issueRequests = 0;
	/** Holds the issues answer until released, so what the refresh itself left is seen first. */
	let release: () => void = () => {};

	beforeEach(() => {
		issueRequests = 0;
		const held = new Promise<void>((resolve) => (release = resolve));
		stubEngine({
			getModelSummary: () => engineSummary,
			getModelIssues: async () => {
				issueRequests += 1;
				await held;
				return {
					model_rev: 6,
					issues: [],
					counts: { error: 1 },
					truncated: false,
					rules_status: null
				};
			}
		});
	});

	it('the issue counts survive a refresh, and the issues are asked for', async () => {
		adoptIssues([], { warning: 3 }, 0);

		await refreshSummary();

		expect(getIssueCounts()).toEqual({ warning: 3 });
		expect(getModelSummary()).toMatchObject({
			model_rev: 6,
			element_count: 10,
			issue_counts: { warning: 3 }
		});
		expect(getModelRev()).toBe(6);
		await vi.waitFor(() => expect(issueRequests).toBe(1));
		expect(getIssueCounts()).toEqual({ warning: 3 });
		release();
		await vi.waitFor(() => expect(getIssueCounts()).toEqual({ error: 1 }));
	});

	it('a summary without counts leaves the store with none', async () => {
		await refreshSummary();

		expect(getIssueCounts()).toBeNull();
		expect(getModelSummary()?.issue_counts).toBeNull();
	});
});
