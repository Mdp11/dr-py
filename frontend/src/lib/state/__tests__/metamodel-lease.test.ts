import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as lockApi from '$lib/api/checkout';
import type { LockResponse } from '$lib/api/types';
import { isCheckedOutByMe, resetCheckout, setProjectInfo } from '../checkout.svelte';
import { acquireMetamodelLease } from '../metamodel-lease.svelte';

/**
 * The surface-agnostic `mm` lease module. It has TWO callers now
 * (final-review Finding 1): `metamodel-editor.svelte.ts` on a keystroke and
 * `metamodel-diagram.svelte.ts` on a node drag — and one gesture reaches both,
 * because a diagram rename stages a layout key migration AND writes the buffer.
 * So concurrent acquires are a normal path, not a rare race, and this file pins
 * the coalescing that makes them safe.
 */

const LEASE: LockResponse = {
	token: 't-mm',
	leases: [
		{
			resource_id: 'mm',
			mode: 'exclusive',
			holder: 'default-user',
			holder_email: 'default@example.com',
			token: 't-mm',
			intent: 'edit',
			expires_at: 1
		}
	]
};

beforeEach(() => {
	resetCheckout();
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
});

afterEach(() => {
	resetCheckout();
	vi.restoreAllMocks();
});

describe('acquireMetamodelLease', () => {
	it('coalesces concurrent acquires into ONE /locks call, granted to both callers', async () => {
		const acquire = vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);

		const [a, b] = await Promise.all([acquireMetamodelLease(), acquireMetamodelLease()]);

		// Without coalescing the second call bumps the module generation, so the
		// FIRST grant sees a mismatch and hands itself back — while both requests
		// have already reached the server, leaving one token in the registry and
		// one stranded on `mm` for its whole TTL with nobody able to release it.
		expect(a).toBe(true);
		expect(b).toBe(true);
		expect(acquire).toHaveBeenCalledOnce();
		expect(isCheckedOutByMe('mm')).toBe(true);
	});

	it('still issues a fresh call once the previous one has settled', async () => {
		const acquire = vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);

		expect(await acquireMetamodelLease()).toBe(true);
		resetCheckout(); // the lease was surrendered (commit / discard / close)
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		expect(await acquireMetamodelLease()).toBe(true);

		// Coalescing is per FLIGHT, not a latch: a settled acquire must not make
		// the next one a no-op.
		expect(acquire).toHaveBeenCalledTimes(2);
	});
});
