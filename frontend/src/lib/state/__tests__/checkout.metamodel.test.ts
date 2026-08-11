import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isCheckedOutByMe, resetCheckout, setProjectInfo } from '../checkout.svelte';
import {
	acquireMetamodelLease,
	dropMetamodelLease,
	getMetamodelLockHolder
} from '../metamodel-lease.svelte';
import * as api from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';

/**
 * The `mm` lease lifecycle module (Task 6). Mirrors checkout.ensure.test.ts's
 * mocking style: spy on `$lib/api/checkout`'s `acquireLocks`/`releaseLock`
 * rather than mocking the whole module.
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
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
});

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
