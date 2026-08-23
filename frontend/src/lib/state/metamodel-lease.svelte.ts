import { ensureCheckout, lockHolderLabel, releaseMetamodelLease } from './checkout.svelte';

/**
 * The `mm` lease lifecycle, keyed to whichever surface is editing the
 * metamodel — the metamodel editor tab today. Lives OUTSIDE that surface,
 * deliberately: nothing here may import anything surface-specific.
 *
 * Generation-guarded (house async-dialog rule): a surface that closes while
 * an acquire is in flight bumps the generation, and the late grant — if one
 * lands — is released instead of recorded as held-by-nobody.
 *
 * TWO surfaces compose it: the editor's first
 * divergent keystroke and the diagram's first node drag. That makes concurrent
 * acquires an ordinary path rather than a rare race — one diagram RENAME
 * reaches both, staging a layout key migration and writing the buffer in the
 * same gesture — which is why {@link acquireMetamodelLease} coalesces.
 */

let _generation = 0;
let _holder = $state<string | null>(null);
/** The acquire currently in flight, shared by every caller that asks while it
 * is running; null when nothing is pending. */
let _inflight: Promise<boolean> | null = null;

/** Email (or id, if no email) of the peer the last acquire attempt was
 * refused over; null after a successful acquire, a drop, or before any
 * attempt. */
export function getMetamodelLockHolder(): string | null {
	return _holder;
}

/**
 * Acquire the EXCLUSIVE `mm` lease. True on grant. On a peer conflict, false
 * with the holder's label readable via {@link getMetamodelLockHolder}.
 *
 * COALESCED: a call made while another is still in flight gets that same
 * promise instead of a second `POST /locks`. Two concurrent acquires would
 * otherwise each bump `_generation`, so the first grant would see a mismatch
 * and hand itself back — and both would have already reached the server, which
 * grants the same holder a SECOND lease under a different token. One of the two
 * tokens then never lands in the checkout registry: unreleasable, holding `mm`
 * against every peer for its full TTL. Per-FLIGHT, not a latch — the next
 * acquire after this one settles goes to the server as normal, which is what
 * makes a lease surrendered by a commit/discard/close re-acquirable.
 */
export function acquireMetamodelLease(): Promise<boolean> {
	if (_inflight !== null) return _inflight;
	const flight = _acquire().finally(() => {
		// Identity-checked so a stale flight can never clear a newer one.
		if (_inflight === flight) _inflight = null;
	});
	_inflight = flight;
	return flight;
}

async function _acquire(): Promise<boolean> {
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
