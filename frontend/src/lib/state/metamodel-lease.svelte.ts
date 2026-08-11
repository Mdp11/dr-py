import { ensureCheckout, lockHolderLabel, releaseMetamodelLease } from './checkout.svelte';

/**
 * The `mm` lease lifecycle, keyed to whichever surface is editing the
 * metamodel — the metamodel editor tab today. Lives OUTSIDE that surface,
 * deliberately, so it outlived the swap drawer it was first written for:
 * nothing here may import anything surface-specific.
 *
 * Generation-guarded (house async-dialog rule): a surface that closes while
 * an acquire is in flight bumps the generation, and the late grant — if one
 * lands — is released instead of recorded as held-by-nobody.
 */

let _generation = 0;
let _holder = $state<string | null>(null);

/** Email (or id, if no email) of the peer the last acquire attempt was
 * refused over; null after a successful acquire, a drop, or before any
 * attempt. */
export function getMetamodelLockHolder(): string | null {
	return _holder;
}

/**
 * Acquire the EXCLUSIVE `mm` lease. True on grant. On a peer conflict, false
 * with the holder's label readable via {@link getMetamodelLockHolder}.
 */
export async function acquireMetamodelLease(): Promise<boolean> {
	const gen = ++_generation;
	_holder = null;
	const res = await ensureCheckout(
		[{ resource_id: 'mm', mode: 'exclusive', type: 'metamodel' }],
		'edit'
	);
	if (gen !== _generation) {
		// Surface closed mid-acquire: a late grant is handed straight back
		// rather than recorded as held by a surface that no longer exists.
		if (res.ok) void releaseMetamodelLease();
		return false;
	}
	if (res.ok) return true;
	if (res.reason === 'conflict') _holder = lockHolderLabel(res);
	return false;
}

/** Release the lease and reset holder state (surface close/cancel/success). */
export async function dropMetamodelLease(): Promise<void> {
	_generation++;
	_holder = null;
	await releaseMetamodelLease();
}
