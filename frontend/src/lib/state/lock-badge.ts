import { getLockFor } from './realtime.svelte';
import { getCurrentUserId } from '$lib/api/client';

export type LockBadge = 'none' | 'mine' | 'theirs';

export function lockBadgeFor(resourceId: string): { state: LockBadge; holder?: string } {
	const lease = getLockFor(resourceId);
	if (lease === undefined) return { state: 'none' };
	if (lease.holder_id === getCurrentUserId()) return { state: 'mine' };
	return { state: 'theirs', holder: lease.holder_id };
}
