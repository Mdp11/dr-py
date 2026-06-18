import { describe, it, expect, beforeEach } from 'vitest';
import { lockBadgeFor } from '../lock-badge';
import { handleFeedEvent, resetRealtime } from '../realtime.svelte';

beforeEach(() => resetRealtime());

describe('lockBadgeFor', () => {
	it('none when unlocked', () => {
		expect(lockBadgeFor('e1').state).toBe('none');
	});
	it('mine for my holder id', () => {
		handleFeedEvent({ type: 'lock', action: 'acquired', leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'default-user' }] });
		expect(lockBadgeFor('e1').state).toBe('mine');
	});
	it('theirs for another holder', () => {
		handleFeedEvent({ type: 'lock', action: 'acquired', leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'bob' }] });
		const b = lockBadgeFor('e1');
		expect(b.state).toBe('theirs');
		expect(b.holder).toBe('bob');
	});
});
