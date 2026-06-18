import { SvelteMap } from 'svelte/reactivity';

import type { ClientConfig } from '$lib/api/client';
import { getCurrentUserId } from '$lib/api/client';
import { acquireLocks, releaseLock } from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';
import type { LeaseOut, LockIntent, LockTargetIn } from '$lib/api/types';

/**
 * Checkout store (Spec B): the editing-session state layered over the model
 * store. Owns MY held locks (token-keyed; tokens are private to the acquirer
 * and never broadcast), the heartbeat (Task 6), and the preview/commit/discard
 * lifecycle (Task 7). Peer lock state (badges) comes from realtime.svelte.ts;
 * this store is the authoritative source for my own tokens.
 */

export type LockConflictLite = { resource_id: string; held_by: string; held_mode: string };
export type CheckoutResult =
	| { ok: true }
	| { ok: false; reason: 'viewer' | 'conflict'; conflicts?: LockConflictLite[] };

interface HeldLease {
	token: string;
	mode: 'exclusive' | 'shared';
}

/** resource_id -> the lease I hold on it. Multiple resources can share a token
 * (e.g. a delete subtree); release-by-token drops them together. */
const _registry = new SvelteMap<string, HeldLease>();

let _role = $state('viewer');
let _lockTtlSeconds = 300;
let _clientConfig: ClientConfig | undefined;

export function setCheckoutApiConfig(cfg: ClientConfig | undefined): void {
	_clientConfig = cfg;
}

export function setProjectInfo(info: { role: string; lockTtlSeconds: number }): void {
	_role = info.role;
	_lockTtlSeconds = info.lockTtlSeconds > 0 ? info.lockTtlSeconds : _lockTtlSeconds;
}

export function getRole(): string {
	return _role;
}

export function canEdit(): boolean {
	return _role === 'editor' || _role === 'owner';
}

export function getHeldToken(resourceId: string): string | undefined {
	return _registry.get(resourceId)?.token;
}

export function getHeldTokens(): string[] {
	return [...new Set([..._registry.values()].map((l) => l.token))];
}

export function isCheckedOutByMe(resourceId: string): boolean {
	return _registry.has(resourceId);
}

/** Internal: record granted leases under their token. Exported for Tasks 6-8. */
export function _recordLeases(leases: LeaseOut[]): void {
	for (const le of leases) {
		_registry.set(le.resource_id, {
			token: le.token,
			mode: le.mode === 'exclusive' ? 'exclusive' : 'shared'
		});
	}
}

/** Internal: drop every registry entry under `token`. */
export function _dropToken(token: string): void {
	for (const [rid, lease] of _registry) {
		if (lease.token === token) _registry.delete(rid);
	}
}

/** True when the registry already covers (resource, mode): an exclusive hold
 * covers a shared requirement; a shared hold covers only shared. */
function alreadyHeld(t: LockTargetIn): boolean {
	const held = _registry.get(t.resource_id);
	if (held === undefined) return false;
	if (t.mode === 'shared') return true; // any hold covers a pin
	return held.mode === 'exclusive';
}

/**
 * Auto-acquire gate. Acquires the subset of `targets` not already held, under
 * `intent`, as ONE /locks call (one token). Idempotent: returns {ok:true}
 * synchronously when everything is held. Viewers are blocked before any
 * network call. A 409 returns {ok:false, reason:'conflict'} with details.
 */
export async function ensureCheckout(
	targets: LockTargetIn[],
	intent: LockIntent
): Promise<CheckoutResult> {
	if (!canEdit()) return { ok: false, reason: 'viewer' };
	const needed = targets.filter((t) => !alreadyHeld(t));
	if (needed.length === 0) return { ok: true };
	try {
		const res = await acquireLocks({ targets: needed, intent, steal: false }, _clientConfig);
		_recordLeases(res.leases);
		_maybeStartHeartbeat(); // defined in Task 6
		return { ok: true };
	} catch (err) {
		if (err instanceof ConflictError) {
			const body = err.body as { conflicts?: LockConflictLite[] } | undefined;
			return { ok: false, reason: 'conflict', conflicts: body?.conflicts };
		}
		throw err;
	}
}

export function resetCheckout(): void {
	_registry.clear();
	_role = 'viewer';
	_lockTtlSeconds = 300;
	_stopHeartbeat(); // defined in Task 6
}

// --- heartbeat (Task 6) ----------------------------------------------------
// Stubs so this task compiles standalone; Task 6 fills them in.
function _maybeStartHeartbeat(): void {}
function _stopHeartbeat(): void {}
export const __ttlForTests = () => _lockTtlSeconds;
