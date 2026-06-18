import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ensureCheckout, setProjectInfo, resetCheckout, getHeldTokens } from '../index';
import * as api from '$lib/api/checkout';

beforeEach(() => {
	vi.useFakeTimers();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 100 }); // renew @ 50s
});
afterEach(() => vi.useRealTimers());

describe('heartbeat', () => {
	it('renews held tokens every ttl/2', async () => {
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
		const renew = vi.spyOn(api, 'renewLock').mockResolvedValue({ ok: true });
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		await vi.advanceTimersByTimeAsync(50_000);
		expect(renew).toHaveBeenCalledWith('t1', undefined);
		await vi.advanceTimersByTimeAsync(50_000);
		expect(renew).toHaveBeenCalledTimes(2);
	});

	it('drops a token whose renew returns ok:false', async () => {
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
		vi.spyOn(api, 'renewLock').mockResolvedValue({ ok: false });
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		await vi.advanceTimersByTimeAsync(50_000);
		expect(getHeldTokens()).toEqual([]);
	});
});
