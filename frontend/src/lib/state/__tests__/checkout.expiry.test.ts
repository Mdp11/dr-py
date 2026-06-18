import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	ensureCheckout, setProjectInfo, resetCheckout, loadProjectInfo,
	handleRemoteLockEvent, getStaleResources, isCheckedOutByMe, getRole, canEdit
} from '../index';
import * as api from '$lib/api/checkout';

beforeEach(() => {
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

describe('project open + own-lock expiry', () => {
	it('loadProjectInfo adopts role + ttl from /open', async () => {
		vi.spyOn(api, 'openProject').mockResolvedValue({
			model_rev: 5, role: 'owner', element_count: 0, relationship_count: 0, issue_counts: {}, lock_ttl_seconds: 120
		});
		await loadProjectInfo();
		expect(getRole()).toBe('owner');
		expect(canEdit()).toBe(true); // owner can edit
	});

	it('marks my resource stale on a remote expired event for my holder id', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't1', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't1', intent: 'edit', expires_at: 1 }]
		});
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		handleRemoteLockEvent('expired', [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'default-user' }]);
		expect(getStaleResources()).toContain('e1');
		expect(isCheckedOutByMe('e1')).toBe(false); // token dropped
	});

	it('ignores expiry events for other users', async () => {
		vi.spyOn(api, 'acquireLocks').mockResolvedValue({
			token: 't1', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't1', intent: 'edit', expires_at: 1 }]
		});
		await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
		handleRemoteLockEvent('expired', [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'someone-else' }]);
		expect(getStaleResources()).not.toContain('e1');
		expect(isCheckedOutByMe('e1')).toBe(true);
	});
});
