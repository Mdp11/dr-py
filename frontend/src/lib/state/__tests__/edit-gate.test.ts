import { describe, it, expect, beforeEach, vi } from 'vitest';
import { editLock, connectLock, deleteLock } from '../edit-gate';
import { setProjectInfo, resetCheckout } from '../index';
import * as api from '$lib/api/checkout';

beforeEach(() => {
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

describe('edit-gate', () => {
	it('editLock acquires exclusive edit and returns true', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't',
			leases: [
				{
					resource_id: 'e1',
					mode: 'exclusive',
					holder: 'default-user',
					token: 't',
					intent: 'edit',
					expires_at: 1
				}
			]
		});
		expect(await editLock('e1')).toBe(true);
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'e1', mode: 'exclusive' }],
			intent: 'edit'
		});
	});

	it('connectLock requests exclusive source + shared target with connect intent', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [] });
		await connectLock('s', 't');
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [
				{ resource_id: 's', mode: 'exclusive' },
				{ resource_id: 't', mode: 'shared' }
			],
			intent: 'connect'
		});
	});

	it('deleteLock requests exclusive delete', async () => {
		const spy = vi.spyOn(api, 'acquireLocks').mockResolvedValue({ token: 't', leases: [] });
		await deleteLock('e9');
		expect(spy.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'e9', mode: 'exclusive' }],
			intent: 'delete'
		});
	});

	it('returns false and posts a notice on conflict', async () => {
		const { ConflictError } = await import('$lib/api/errors');
		vi.spyOn(api, 'acquireLocks').mockRejectedValue(
			new ConflictError(
				409,
				{ conflicts: [{ resource_id: 'e1', held_by: 'bob', held_mode: 'exclusive' }] },
				'lock conflict'
			)
		);
		expect(await editLock('e1')).toBe(false);
	});
});
