import { getLockFor } from './realtime.svelte';
import { getCurrentUserId } from '$lib/api/client';

export type LockBadge = 'none' | 'mine' | 'theirs';

export function lockBadgeFor(resourceId: string): { state: LockBadge; holder?: string } {
	const lease = getLockFor(resourceId);
	if (lease === undefined) return { state: 'none' };
	if (lease.holder_id === getCurrentUserId()) return { state: 'mine' };
	// Prefer the human-readable email; fall back to the opaque id if the feed
	// payload predates holder_email (or it is somehow blank).
	return { state: 'theirs', holder: lease.holder_email || lease.holder_id };
}
