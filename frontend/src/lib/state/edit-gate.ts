import { ensureCheckout, lockHolderLabel } from './checkout.svelte';
import { setLockNotice } from './lock-notice.svelte';
import type { CheckoutResult } from './checkout.svelte';
import type { LockTargetIn, LockIntent } from '$lib/api/types';

/** Re-exported from checkout.svelte.ts, which owns the single definition
 * (`reacquireOpenArtifactLeases` needs it, and importing it from here would
 * cycle). This module is the edit-gate surface editors import from. */
export { lockHolderLabel };

function explain(res: Extract<CheckoutResult, { ok: false }>): string {
	if (res.reason === 'viewer') return 'You have view-only access to this project.';
	const c = res.conflicts?.[0];
	if (!c) return 'Could not acquire a lock (held by someone else).';
	return `Locked by ${c.held_by_email || c.held_by}.`;
}

/** Reduce a {@link CheckoutResult} to a boolean, routing the refusal (if any)
 * to the GLOBAL lock notice. The shared tail of every notice-based gate in this
 * module — the element gates below and the two sidebar artifact gates, which
 * would otherwise each hand-roll `setLockNotice(explain(res))`. */
function noticed(res: CheckoutResult): boolean {
	if (res.ok) {
		setLockNotice(null);
		return true;
	}
	setLockNotice(explain(res));
	return false;
}

export async function acquireLocks(targets: LockTargetIn[], intent: LockIntent): Promise<boolean> {
	return noticed(await ensureCheckout(targets, intent));
}

export function editLock(id: string): Promise<boolean> {
	return acquireLocks([{ resource_id: id, mode: 'exclusive' }], 'edit');
}

export function connectLock(sourceId: string, targetId: string): Promise<boolean> {
	return acquireLocks(
		[
			{ resource_id: sourceId, mode: 'exclusive' },
			{ resource_id: targetId, mode: 'shared' }
		],
		'connect'
	);
}

export function deleteLock(id: string): Promise<boolean> {
	return acquireLocks([{ resource_id: id, mode: 'exclusive' }], 'delete');
}

/**
 * Artifact check-out: EXCLUSIVE on the BARE id under `type: "artifact"` (the
 * backend canonicalizes it to `art:<id>`, and the checkout registry stores that
 * canonical form). Returns the full {@link CheckoutResult} rather than a
 * boolean so editor UIs can render the holder inline — an artifact editor is a
 * whole workspace tab, where the transient global lock notice reads as noise —
 * see {@link lockHolderLabel}.
 */
export function acquireArtifactLease(
	artifactId: string,
	intent: 'edit' | 'delete' = 'edit'
): Promise<CheckoutResult> {
	return ensureCheckout([{ resource_id: artifactId, mode: 'exclusive', type: 'artifact' }], intent);
}

/**
 * Sidebar artifact-RENAME gate: notice-based like {@link editLock} (the sidebar
 * row has no inline place to render a holder — that is the editor tab's job,
 * which is why {@link acquireArtifactLease} returns the raw result instead).
 * Sibling of {@link artifactDeleteLock}: the sidebar's two write surfaces report
 * refusals through the SAME channel, so a user never gets an inline holder for
 * one and a global toast for the other.
 */
export async function artifactEditLock(artifactId: string): Promise<boolean> {
	return noticed(await acquireArtifactLease(artifactId, 'edit'));
}

/** Sidebar artifact-delete gate: notice-based like {@link editLock} /
 * {@link deleteLock} (the sidebar has no inline place to show a holder).
 * DELETE-intent exclusives conflict with ANY peer lease, shared pins included,
 * so this refuses while anyone else has the artifact open. */
export async function artifactDeleteLock(artifactId: string): Promise<boolean> {
	return noticed(await acquireArtifactLease(artifactId, 'delete'));
}
