import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	commitStaged,
	isCheckedOutByMe,
	releaseMetamodelLease,
	resetCheckout,
	setProjectInfo
} from '../checkout.svelte';
import {
	acquireMetamodelLease,
	dropMetamodelLease,
	getMetamodelLockHolder
} from '../metamodel-lease.svelte';
import {
	clearStagedNodeMoves,
	getStagedMetamodelOps,
	getStagedNodeMoves,
	initMetamodelStage,
	onMetamodelCommitted,
	registerMetamodelDraftProvider,
	stageNodeMove
} from '../metamodel-stage.svelte';
import { getMetamodel as getActiveMetamodel, clearMetamodel } from '../metamodel.svelte';
import { resetModelStore } from '../model.svelte';
import * as api from '$lib/api/checkout';
import * as mmApi from '$lib/api/metamodel';
import { ConflictError } from '$lib/api/errors';
import type { CommitResponse, Metamodel } from '$lib/api/types';

/**
 * The `mm` lease lifecycle module (Task 6) and the metamodel half of the
 * commit batch (spec 2026-08-16). Mirrors checkout.ensure.test.ts's mocking
 * style: spy on `$lib/api/checkout`'s `acquireLocks`/`releaseLock` rather than
 * mocking the whole module.
 */

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
} {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	resetCheckout();
	resetModelStore();
	clearMetamodel();
	initMetamodelStage('p1');
	clearStagedNodeMoves();
	registerMetamodelDraftProvider(() => ({ dirty: false, blob: '' }));
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
});

const MM_LEASE = {
	token: 't-mm',
	leases: [
		{
			resource_id: 'mm',
			mode: 'exclusive' as const,
			holder: 'default-user',
			token: 't-mm',
			intent: 'edit' as const,
			expires_at: 1
		}
	]
};

function commitResponse(over: Partial<CommitResponse> = {}): CommitResponse {
	return {
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
		validation_error_count: 0,
		changed_artifacts: [],
		deleted_artifact_ids: [],
		...over
	};
}

describe('acquireMetamodelLease', () => {
	it('sends ONE /locks call for the mm target and returns true on grant', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't-mm',
			leases: [
				{
					resource_id: 'mm',
					mode: 'exclusive',
					holder: 'default-user',
					token: 't-mm',
					intent: 'edit',
					expires_at: 1
				}
			]
		});
		const ok = await acquireMetamodelLease();
		expect(ok).toBe(true);
		expect(spy).toHaveBeenCalledOnce();
		expect(spy).toHaveBeenCalledWith(
			{
				targets: [{ resource_id: 'mm', mode: 'exclusive', type: 'metamodel' }],
				intent: 'edit',
				steal: false
			},
			undefined
		);
		expect(isCheckedOutByMe('mm')).toBe(true);
	});

	it('returns false on a peer conflict and exposes the holder email', async () => {
		vi.spyOn(api, 'acquireLocks').mockRejectedValue(
			new ConflictError(
				409,
				{
					detail: 'lock conflict',
					conflicts: [
						{
							resource_id: 'mm',
							held_by: 'u2',
							held_by_email: 'peer@x.io',
							held_mode: 'exclusive'
						}
					]
				},
				'lock conflict'
			)
		);
		const ok = await acquireMetamodelLease();
		expect(ok).toBe(false);
		expect(getMetamodelLockHolder()).toBe('peer@x.io');
		expect(isCheckedOutByMe('mm')).toBe(false);
	});
});

describe('dropMetamodelLease', () => {
	it('releases the granted token, clears the registry entry, and resets the holder', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't-mm',
			leases: [
				{
					resource_id: 'mm',
					mode: 'exclusive',
					holder: 'default-user',
					token: 't-mm',
					intent: 'edit',
					expires_at: 1
				}
			]
		});
		const releaseSpy = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);
		await acquireMetamodelLease();
		expect(isCheckedOutByMe('mm')).toBe(true);

		await dropMetamodelLease();
		expect(releaseSpy).toHaveBeenCalledWith('t-mm', undefined);
		expect(isCheckedOutByMe('mm')).toBe(false);
		expect(getMetamodelLockHolder()).toBeNull();
	});

	it('is a no-op when no mm lease is held', async () => {
		const releaseSpy = vi.spyOn(api, 'releaseLock');
		await dropMetamodelLease();
		expect(releaseSpy).not.toHaveBeenCalled();
	});
});

describe('generation guard', () => {
	it('releases a late grant instead of recording it when dropped mid-acquire', async () => {
		const d = deferred<Awaited<ReturnType<typeof api.acquireLocks>>>();
		vi.spyOn(api, 'acquireLocks').mockImplementation(() => d.promise);
		const releaseSpy = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);

		const inflight = acquireMetamodelLease();
		// Surface closes while the acquire is still in flight.
		await dropMetamodelLease();

		d.resolve({
			token: 't-mm',
			leases: [
				{
					resource_id: 'mm',
					mode: 'exclusive',
					holder: 'default-user',
					token: 't-mm',
					intent: 'edit',
					expires_at: 1
				}
			]
		});
		const ok = await inflight;

		expect(ok).toBe(false);
		expect(releaseSpy).toHaveBeenCalledWith('t-mm', undefined);
		expect(isCheckedOutByMe('mm')).toBe(false);
	});
});

describe('the metamodel half of the commit batch', () => {
	it('sends staged metamodel ops FIRST, with the mm token', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue(MM_LEASE);
		const commit = vi.spyOn(api, 'commitChanges').mockResolvedValue(commitResponse());
		await acquireMetamodelLease();
		registerMetamodelDraftProvider(() => ({ dirty: true, blob: 'elements: []\n' }));
		stageNodeMove('el:A', { x: 1, y: 2 });

		await commitStaged('m', false);

		const req = commit.mock.calls[0][0];
		expect(req.ops).toEqual([
			{ kind: 'metamodel.rebind', blob: 'elements: []\n' },
			{ kind: 'metamodel.move_node', node: 'el:A', pos: { x: 1, y: 2 } }
		]);
		// The `mm` lease is hard-verified by the server for a rebind batch, so
		// the token has to ride along (and comes back released).
		expect(req.lockTokens).toContain('t-mm');
		expect(isCheckedOutByMe('mm')).toBe(false);
		// Committed moves must not survive into the NEXT batch.
		expect(getStagedNodeMoves().size).toBe(0);
	});

	it('notifies committed listeners with the blob that was SENT, not the live buffer', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue(MM_LEASE);
		let resolveCommit!: (r: CommitResponse) => void;
		vi.spyOn(api, 'commitChanges').mockImplementation(
			() =>
				new Promise<CommitResponse>((res) => {
					resolveCommit = res;
				})
		);
		await acquireMetamodelLease();
		// A LIVE buffer: the provider reads whatever the editor holds right now.
		let buffer = 'sent: true\n';
		registerMetamodelDraftProvider(() => ({ dirty: true, blob: buffer }));
		const seen: { rebound: boolean; blob: string | null }[] = [];
		const off = onMetamodelCommitted((info) => seen.push(info));

		const inflight = commitStaged('m', false);
		// A straggler keystroke lands while the request is in flight.
		buffer = 'typed: after\n';
		resolveCommit(commitResponse({ rebound: true }));
		await inflight;
		off();

		expect(seen).toEqual([{ rebound: true, blob: 'sent: true\n' }]);
	});

	it('a failed commit adopts nothing and keeps the staged moves', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue(MM_LEASE);
		vi.spyOn(api, 'commitChanges').mockRejectedValue(new Error('boom'));
		await acquireMetamodelLease();
		const seen: unknown[] = [];
		const off = onMetamodelCommitted((info) => seen.push(info));
		stageNodeMove('el:A', { x: 1, y: 2 });

		await expect(commitStaged('m', false)).rejects.toThrow('boom');
		off();

		expect(seen).toEqual([]);
		expect(getStagedMetamodelOps()).toHaveLength(1);
	});

	it('refetches the metamodel in place when the commit rebound', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue(MM_LEASE);
		vi.spyOn(api, 'commitChanges').mockResolvedValue(commitResponse({ rebound: true }));
		const MM = { name: 'after', elements: [], relationships: [] } as unknown as Metamodel;
		const fetchMm = vi.spyOn(mmApi, 'getMetamodel').mockResolvedValue(MM);
		await acquireMetamodelLease();
		registerMetamodelDraftProvider(() => ({ dirty: true, blob: 'elements: []\n' }));

		await commitStaged('m', false);

		// toStrictEqual, not toBe: `setMetamodel` parks it in `$state`, which
		// hands back a reactive proxy rather than the identical object.
		await vi.waitFor(() => expect(getActiveMetamodel()).toStrictEqual(MM));
		expect(fetchMm).toHaveBeenCalled();
	});

	it('does NOT refetch the metamodel for a layout-only commit', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue(MM_LEASE);
		vi.spyOn(api, 'commitChanges').mockResolvedValue(commitResponse());
		const fetchMm = vi.spyOn(mmApi, 'getMetamodel');
		await acquireMetamodelLease();
		stageNodeMove('el:A', null);

		await commitStaged('m', false);

		expect(fetchMm).not.toHaveBeenCalled();
		expect(getActiveMetamodel()).toBeNull();
	});
});

describe('releaseMetamodelLease', () => {
	it('keeps the lease while metamodel work is staged', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue(MM_LEASE);
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);
		await acquireMetamodelLease();
		stageNodeMove('el:A', { x: 1, y: 2 });

		await releaseMetamodelLease();

		// Handing it back here would turn the next commit into a 409
		// "required lock not held" over work the user can still see staged.
		expect(release).not.toHaveBeenCalled();
		expect(isCheckedOutByMe('mm')).toBe(true);
	});

	it('releases once nothing metamodel-shaped is staged any more', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue(MM_LEASE);
		const release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);
		await acquireMetamodelLease();
		stageNodeMove('el:A', { x: 1, y: 2 });
		clearStagedNodeMoves();

		await releaseMetamodelLease();

		expect(release).toHaveBeenCalledWith('t-mm', undefined);
		expect(isCheckedOutByMe('mm')).toBe(false);
	});
});
