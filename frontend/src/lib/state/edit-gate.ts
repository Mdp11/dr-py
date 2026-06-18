import { ensureCheckout } from './checkout.svelte';
import { setLockNotice } from './lock-notice.svelte';
import type { CheckoutResult } from './checkout.svelte';
import type { LockTargetIn, LockIntent } from '$lib/api/types';

function explain(res: Extract<CheckoutResult, { ok: false }>): string {
	if (res.reason === 'viewer') return 'You have view-only access to this project.';
	const c = res.conflicts?.[0];
	return c ? `Locked by ${c.held_by}.` : 'Could not acquire a lock (held by someone else).';
}

async function gate(targets: LockTargetIn[], intent: LockIntent): Promise<boolean> {
	const res = await ensureCheckout(targets, intent);
	if (res.ok) {
		setLockNotice(null);
		return true;
	}
	setLockNotice(explain(res));
	return false;
}

export function editLock(id: string): Promise<boolean> {
	return gate([{ resource_id: id, mode: 'exclusive' }], 'edit');
}

export function connectLock(sourceId: string, targetId: string): Promise<boolean> {
	return gate(
		[
			{ resource_id: sourceId, mode: 'exclusive' },
			{ resource_id: targetId, mode: 'shared' }
		],
		'connect'
	);
}

export function deleteLock(id: string): Promise<boolean> {
	return gate([{ resource_id: id, mode: 'exclusive' }], 'delete');
}
