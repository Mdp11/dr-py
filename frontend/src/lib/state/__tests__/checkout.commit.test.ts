import { afterAll, afterEach, beforeAll, describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
	ensureCheckout,
	setProjectInfo,
	resetCheckout,
	commitStaged,
	previewStaged,
	discardElement,
	discardElementCascade,
	getHeldTokens,
	getStagedOps,
	isCheckedOutByMe,
	emit,
	seedElements,
	resetModelStore,
	getCachedElements,
	hasStagedOps
} from '../index';
import * as api from '$lib/api/checkout';
import * as mmApi from '$lib/api/metamodel';
import * as modelReadApi from '$lib/api/model-read';
import * as validationApi from '$lib/api/validation';
import { server } from '$lib/api/__tests__/server';
import { ConflictError } from '$lib/api/errors';
import type { Metamodel } from '$lib/api/types';
import { OFF, type CommitAnswer, type ReplicaSync } from '$lib/engine/sync';
import { setCheckoutApiConfig } from '../checkout.svelte';
import { getMetamodel as getActiveMetamodel, clearMetamodel } from '../metamodel.svelte';
import { getModelRev } from '../model.svelte';
import { configureReplica, resetReplica } from '../replica.svelte';

beforeEach(() => {
	resetModelStore();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

async function checkoutAndEdit() {
	vi.spyOn(api, 'acquireLocks').mockResolvedValue({
		token: 't1',
		leases: [
			{
				resource_id: 'e1',
				mode: 'exclusive',
				holder: 'default-user',
				token: 't1',
				intent: 'edit',
				expires_at: 1
			}
		]
	});
	seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
	await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
	emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
}

describe('commit lifecycle', () => {
	it('previewStaged sends the live rev + staged ops', async () => {
		await checkoutAndEdit();
		const spy = vi.spyOn(api, 'previewCommit').mockResolvedValue({
			conformance_error_count: 0,
			structural_blockers: [],
			issues: [],
			would_block: false
		});
		await previewStaged();
		expect(spy).toHaveBeenCalledOnce();
		const [rev, ops] = spy.mock.calls[0];
		expect(rev).toBe(0); // getModelRev after seed (no acked deltas)
		expect(ops).toHaveLength(1);
	});

	it('commitStaged applies the delta, clears the buffer + registry', async () => {
		await checkoutAndEdit();
		vi.spyOn(api, 'commitChanges').mockResolvedValue({
			model_rev: 1,
			id_map: {},
			changed_elements: [{ id: 'e1', type_name: 'T', properties: { name: 'b' }, rev: 2 }],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			issues_removed_owner_ids: [],
			issues_added: [],
			issue_counts: {},
			commit_id: 'c1',
			message: 'm',
			validation_error_count: 0,
			changed_artifacts: [],
			deleted_artifact_ids: []
		});
		await commitStaged('m', false);
		expect(hasStagedOps()).toBe(false);
		expect(getHeldTokens()).toEqual([]);
		expect(isCheckedOutByMe('e1')).toBe(false);
		expect(getCachedElements().get('e1')?.rev).toBe(2);
	});

	it('commitStaged passes all held tokens + ack_errors', async () => {
		await checkoutAndEdit();
		const spy = vi.spyOn(api, 'commitChanges').mockResolvedValue({
			model_rev: 1,
			id_map: {},
			changed_elements: [],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			issues_removed_owner_ids: [],
			issues_added: [],
			issue_counts: {},
			commit_id: 'c1',
			message: 'm',
			validation_error_count: 3,
			changed_artifacts: [],
			deleted_artifact_ids: []
		});
		await commitStaged('m', true);
		expect(spy.mock.calls[0][0]).toMatchObject({
			message: 'm',
			lockTokens: ['t1'],
			ackErrors: true
		});
	});

	it('discardElement reverts that element and releases its token', async () => {
		await checkoutAndEdit();
		const rel = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);
		await discardElement('e1');
		expect(rel).toHaveBeenCalledWith('t1', undefined);
		expect(getCachedElements().get('e1')?.properties.name).toBe('a'); // reverted
		expect(isCheckedOutByMe('e1')).toBe(false);
		expect(hasStagedOps()).toBe(false);
	});

	it('discardElement keeps a lock a remaining co-acquired staged op still needs', async () => {
		// Scenario: edit-lock source (token T1), then connect source->target. The
		// connect's ensureCheckout is idempotent — source is already held under T1,
		// so it only acquires the target (token T2). It stages a create_relationship
		// keyed by its temp_id whose commit needs the SOURCE's exclusive lock.
		// Discarding the source must NOT release T1, or the relationship op would
		// be orphaned into a 409 "missing lock" at commit.
		vi.spyOn(api, 'acquireLocks').mockImplementation(async (req) => {
			// return one lease per requested target, token by source membership
			const token = req.targets.some((t) => t.resource_id === 'src') ? 't_src' : 't_tgt';
			return {
				token,
				leases: req.targets.map((t) => ({
					resource_id: t.resource_id,
					mode: t.mode,
					holder: 'default-user',
					token,
					intent: req.intent,
					expires_at: 1
				}))
			};
		});
		const rel = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		seedElements([
			{ id: 'src', type_name: 'T', properties: { name: 'a' }, rev: 1 },
			{ id: 'tgt', type_name: 'T', properties: { name: 'b' }, rev: 1 }
		]);

		// 1. edit-lock the source and stage a property edit on it (token t_src)
		await ensureCheckout([{ resource_id: 'src', mode: 'exclusive' }], 'edit');
		emit({ kind: 'update_element', id: 'src', properties_patch: { name: 'a2' } });

		// 2. connect source->target: source already held (idempotent), so this only
		//    acquires the target under t_tgt, and stages a create_relationship.
		await ensureCheckout(
			[
				{ resource_id: 'src', mode: 'exclusive' },
				{ resource_id: 'tgt', mode: 'shared' }
			],
			'edit'
		);
		emit({
			kind: 'create_relationship',
			temp_id: 'tmp_rel1',
			type_name: 'R',
			source_id: 'src',
			target_id: 'tgt',
			properties: {}
		});

		expect(getHeldTokens().sort()).toEqual(['t_src', 't_tgt']);

		// 3. discard the source: its property edit reverts, but the source token
		//    (t_src) is the lock the staged create_relationship still needs.
		await discardElement('src');

		// t_src is NOT released (the relationship op still needs the source lock)
		expect(rel).not.toHaveBeenCalledWith('t_src', undefined);
		// the relationship op is still staged
		expect(getStagedOps()).toEqual([
			expect.objectContaining({ kind: 'create_relationship', temp_id: 'tmp_rel1' })
		]);
		// the source's own property edit was reverted
		expect(getCachedElements().get('src')?.properties.name).toBe('a');
		// invariant: a lock a remaining staged op needs is still held
		expect(getHeldTokens()).toContain('t_src');
	});

	it('discardElementCascade also drops incident rel ops and releases the token', async () => {
		// Same shape as the test above, but through the sidebar's CASCADE revert:
		// it takes the create_relationship with it, so nothing staged still needs
		// the source lock and t_src must be released instead of leaking for the
		// full TTL (the sidebar is the only surface that can un-create a temp
		// element, and nothing else releases its lease when the buffer empties).
		vi.spyOn(api, 'acquireLocks').mockImplementation(async (req) => {
			const token = req.targets.some((t) => t.resource_id === 'src') ? 't_src' : 't_tgt';
			return {
				token,
				leases: req.targets.map((t) => ({
					resource_id: t.resource_id,
					mode: t.mode,
					holder: 'default-user',
					token,
					intent: req.intent,
					expires_at: 1
				}))
			};
		});
		const rel = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		seedElements([
			{ id: 'src', type_name: 'T', properties: { name: 'a' }, rev: 1 },
			{ id: 'tgt', type_name: 'T', properties: { name: 'b' }, rev: 1 }
		]);
		await ensureCheckout([{ resource_id: 'src', mode: 'exclusive' }], 'edit');
		emit({ kind: 'update_element', id: 'src', properties_patch: { name: 'a2' } });
		await ensureCheckout(
			[
				{ resource_id: 'src', mode: 'exclusive' },
				{ resource_id: 'tgt', mode: 'shared' }
			],
			'edit'
		);
		emit({
			kind: 'create_relationship',
			temp_id: 'tmp_rel1',
			type_name: 'R',
			source_id: 'src',
			target_id: 'tgt',
			properties: {}
		});

		await discardElementCascade('src');

		expect(getStagedOps()).toEqual([]); // the incident rel op went too
		expect(rel).toHaveBeenCalledWith('t_src', undefined);
		// Only the target element's OWN token is a release candidate (parity with
		// discardElement): the far endpoint's shared pin survives the cascade and
		// expires with its TTL. Pinned so the asymmetry stays a decision, not drift.
		expect(getHeldTokens()).toEqual(['t_tgt']);
		expect(isCheckedOutByMe('src')).toBe(false);
		expect(getCachedElements().get('src')?.properties.name).toBe('a');
	});

	it('discardElementCascade keeps a token a remaining staged op still needs', async () => {
		// One token co-acquires src + sibling (a subtree lease). Cascading src's
		// discard leaves the sibling's own edit staged, and that op still needs a
		// resource this token covers — so the whole token stays held.
		vi.spyOn(api, 'acquireLocks').mockImplementation(async (req) => ({
			token: 't_sub',
			leases: req.targets.map((t) => ({
				resource_id: t.resource_id,
				mode: t.mode,
				holder: 'default-user',
				token: 't_sub',
				intent: req.intent,
				expires_at: 1
			}))
		}));
		const rel = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		seedElements([
			{ id: 'src', type_name: 'T', properties: { name: 'a' }, rev: 1 },
			{ id: 'sib', type_name: 'T', properties: { name: 'b' }, rev: 1 }
		]);
		await ensureCheckout(
			[
				{ resource_id: 'src', mode: 'exclusive' },
				{ resource_id: 'sib', mode: 'exclusive' }
			],
			'edit'
		);
		emit({ kind: 'update_element', id: 'src', properties_patch: { name: 'a2' } });
		emit({ kind: 'update_element', id: 'sib', properties_patch: { name: 'b2' } });

		await discardElementCascade('src');

		expect(rel).not.toHaveBeenCalled();
		expect(getHeldTokens()).toEqual(['t_sub']);
		expect(getStagedOps()).toEqual([
			expect.objectContaining({ kind: 'update_element', id: 'sib' })
		]);
		expect(getCachedElements().get('src')?.properties.name).toBe('a');
		expect(getCachedElements().get('sib')?.properties.name).toBe('b2');
	});
});

describe("the replica's flight", () => {
	const BASE = 'http://api.test/api/v1/projects/p';
	// Written by hand, as a server would: `1.0` and the spacing are what a
	// re-serialized body would lose.
	const bodyText = (over: string) =>
		'{"model_rev": 1, "prev_rev": 0, "state_digest": "00000000000000ab", ' +
		'"id_map": {"tmp_1": "srv-1"}, ' +
		'"changed_elements": [{"id": "e1", "type_name": "T", "properties": {"name": "b", "weight": 1.0}, "rev": 2}], ' +
		'"changed_relationships": [], "deleted_element_ids": [], "deleted_relationship_ids": [], ' +
		'"issues_removed_owner_ids": [], "issues_added": [], "issue_counts": {}, ' +
		`"commit_id": "c1", "message": "m", "validation_error_count": 0${over}}`;

	/**
	 * A sync whose flight records each call with what the model store showed
	 * at that moment; `log` interleaves it with the request leaving.
	 */
	function flightSync(log: string[]) {
		const settled: { answer: CommitAnswer; modelRev: number; e1Rev: number | undefined }[] = [];
		const sync: ReplicaSync = {
			open: vi.fn(),
			stop: vi.fn(),
			status: () => OFF,
			settled: () => Promise.resolve(),
			feedCommit: vi.fn(),
			feedRebind: vi.fn(),
			feedSnapshot: vi.fn(),
			beginCommit: () => {
				log.push('begin');
				return {
					settle: (answer) => {
						log.push('settle');
						settled.push({
							answer,
							modelRev: getModelRev(),
							e1Rev: getCachedElements().get('e1')?.rev
						});
					},
					abandon: () => void log.push('abandon')
				};
			},
			metamodelAdopted: vi.fn(() => {
				log.push(`adopted ${(getActiveMetamodel() as { name?: string } | null)?.name}`);
			})
		};
		return { sync, settled };
	}

	beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
	afterAll(() => server.close());
	beforeEach(() => {
		vi.restoreAllMocks();
		clearMetamodel();
		setCheckoutApiConfig({ baseUrl: BASE });
	});
	afterEach(() => {
		setCheckoutApiConfig(undefined);
		resetReplica();
		server.resetHandlers();
		vi.restoreAllMocks();
	});

	it("the replica's flight brackets the POST", async () => {
		const log: string[] = [];
		const { sync, settled } = flightSync(log);
		configureReplica({ sync });
		const text = bodyText('');
		server.use(
			http.post(`${BASE}/commits`, () => {
				log.push('request');
				return new HttpResponse(text, { headers: { 'Content-Type': 'application/json' } });
			})
		);
		await checkoutAndEdit();

		await commitStaged('m', false);

		expect(log).toEqual(['begin', 'request', 'settle']);
		expect(settled).toEqual([
			{
				answer: { text, rev: 1, applied: true, rebound: false, idMap: { tmp_1: 'srv-1' } },
				modelRev: 0,
				e1Rev: 1
			}
		]);
		expect(getModelRev()).toBe(1);
		expect(getCachedElements().get('e1')?.rev).toBe(2);
	});

	it('a response that applied nothing is settled as such', async () => {
		const log: string[] = [];
		const { sync, settled } = flightSync(log);
		configureReplica({ sync });
		const text = bodyText('').replace('"prev_rev": 0', '"prev_rev": null');
		server.use(
			http.post(
				`${BASE}/commits`,
				() => new HttpResponse(text, { headers: { 'Content-Type': 'application/json' } })
			)
		);
		await checkoutAndEdit();

		await commitStaged('m', false);

		expect(settled.map((s) => s.answer)).toEqual([
			{ text, rev: 1, applied: false, rebound: false, idMap: { tmp_1: 'srv-1' } }
		]);
	});

	it('a refused commit abandons the flight and still reaches the caller', async () => {
		const log: string[] = [];
		const { sync, settled } = flightSync(log);
		configureReplica({ sync });
		server.use(
			http.post(`${BASE}/commits`, () => {
				log.push('request');
				return HttpResponse.json({ detail: 'stale' }, { status: 409 });
			})
		);
		await checkoutAndEdit();

		await expect(commitStaged('m', false)).rejects.toBeInstanceOf(ConflictError);

		expect(log).toEqual(['begin', 'request', 'abandon']);
		expect(settled).toEqual([]);
		expect(hasStagedOps()).toBe(true);
	});

	it('a rebound commit tells the replica twice', async () => {
		const log: string[] = [];
		const { sync, settled } = flightSync(log);
		configureReplica({ sync });
		server.use(
			http.post(
				`${BASE}/commits`,
				() =>
					new HttpResponse(bodyText(', "rebound": true, "to_metamodel_id": "mm-2"'), {
						headers: { 'Content-Type': 'application/json' }
					})
			)
		);
		const MM = { name: 'after', elements: [], relationships: [] } as unknown as Metamodel;
		vi.spyOn(mmApi, 'getMetamodel').mockImplementation(async () => {
			log.push('refetch');
			return MM;
		});
		vi.spyOn(validationApi, 'getModelIssues').mockResolvedValue({
			model_rev: 1,
			issues: [],
			counts: {},
			truncated: false,
			rules_status: null
		});
		vi.spyOn(modelReadApi, 'getModelSummary').mockResolvedValue({
			model_rev: 1,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: null,
			undo_depth: 0
		});
		await checkoutAndEdit();

		await commitStaged('m', false);
		await vi.waitFor(() => expect(sync.metamodelAdopted).toHaveBeenCalledOnce());

		expect(settled.map((s) => s.answer.rebound)).toEqual([true]);
		expect(log).toEqual(['begin', 'settle', 'refetch', 'adopted after']);
	});
});
