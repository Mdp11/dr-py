import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { lockBadgeFor } from '../lock-badge';
import { handleFeedEvent, resetRealtime } from '../realtime.svelte';
import { setCurrentUserId } from '$lib/api/identity';

beforeEach(() => resetRealtime());
afterEach(() => setCurrentUserId(''));

describe('lockBadgeFor', () => {
	it('none when unlocked', () => {
		expect(lockBadgeFor('e1').state).toBe('none');
	});
	it('mine for my holder id', () => {
		setCurrentUserId('default-user');
		handleFeedEvent({
			type: 'lock',
			action: 'acquired',
			leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'default-user' }]
		});
		expect(lockBadgeFor('e1').state).toBe('mine');
	});
	it('theirs for another holder, falling back to id when no email', () => {
		handleFeedEvent({
			type: 'lock',
			action: 'acquired',
			leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'bob' }]
		});
		const b = lockBadgeFor('e1');
		expect(b.state).toBe('theirs');
		expect(b.holder).toBe('bob');
	});
	it('prefers the holder email over the opaque id', () => {
		handleFeedEvent({
			type: 'lock',
			action: 'acquired',
			leases: [
				{ resource_id: 'e1', mode: 'exclusive', holder_id: 'bob-uuid', holder_email: 'bob@x.io' }
			]
		});
		expect(lockBadgeFor('e1').holder).toBe('bob@x.io');
	});
});
