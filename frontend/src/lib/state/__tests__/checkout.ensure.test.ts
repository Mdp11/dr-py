import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	ensureCheckout,
	setProjectInfo,
	resetCheckout,
	isCheckedOutByMe,
	getHeldTokens,
	canEdit
} from '../index';
import * as api from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';

beforeEach(() => {
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

describe('ensureCheckout', () => {
	it('acquires an exclusive edit lock on first call and records it', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({
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
		const res = await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		expect(res.ok).toBe(true);
		expect(isCheckedOutByMe('e1')).toBe(true);
		expect(getHeldTokens()).toEqual(['t1']);
		expect(spy).toHaveBeenCalledOnce();
	});

	it('is idempotent: a second edit on a held element does not re-acquire', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({
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
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		const res = await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		expect(res.ok).toBe(true);
		expect(spy).toHaveBeenCalledOnce(); // still once
	});

	it('returns {ok:false, reason:conflict} on 409', async () => {
		vi.spyOn(api, 'acquireLocks').mockRejectedValue(
			new ConflictError(
				409,
				{
					detail: 'lock conflict',
					conflicts: [{ resource_id: 'e1', held_by: 'bob', held_mode: 'exclusive' }]
				},
				'lock conflict'
			)
		);
		const res = await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.reason).toBe('conflict');
			expect(res.conflicts?.[0].held_by).toBe('bob');
		}
		expect(isCheckedOutByMe('e1')).toBe(false);
	});

	it('blocks viewers without any network call', async () => {
		setProjectInfo({ role: 'viewer', lockTtlSeconds: 300 });
		const spy = vi.spyOn(api, 'acquireLocks');
		const res = await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe('viewer');
		expect(canEdit()).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});

	it('acquires only the not-already-held targets (connect: source held, pin target)', async () => {
		vi.spyOn(api, 'acquireLocks')
			.mockResolvedValueOnce({
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
			})
			.mockResolvedValueOnce({
				token: 't2',
				leases: [
					{
						resource_id: 'e2',
						mode: 'shared',
						holder: 'default-user',
						token: 't2',
						intent: 'connect',
						expires_at: 1
					}
				]
			});
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		const res = await ensureCheckout(
			[
				{ resource_id: 'e1', mode: 'exclusive' },
				{ resource_id: 'e2', mode: 'shared' }
			],
			'connect'
		);
		expect(res.ok).toBe(true);
		// second call only requested e2 (e1 exclusive already covers it)
		expect(
			(api.acquireLocks as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0]
		).toEqual({
			targets: [{ resource_id: 'e2', mode: 'shared' }],
			intent: 'connect',
			steal: false
		});
		expect(getHeldTokens().sort()).toEqual(['t1', 't2']);
	});
});
