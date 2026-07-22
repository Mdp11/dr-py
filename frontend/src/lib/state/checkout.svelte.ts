import { SvelteMap } from 'svelte/reactivity';

import type { ClientConfig } from '$lib/api/client';
import { getCurrentUserId } from '$lib/api/client';
import {
	acquireLocks,
	commitChanges,
	openProject,
	previewCommit,
	releaseLock,
	renewLock
} from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';
import type {
	CommitResponse,
	LeaseOut,
	LockIntent,
	LockTargetIn,
	PreviewResponse
} from '$lib/api/types';
import type { LeaseLite } from '$lib/api/feed';
import type { Op } from './ops';
import {
	applyDelta,
	clearStaged,
	getModelRev,
	getStagedOps,
	revertAllStaged,
	revertStagedFor,
	revertStagedForElement
} from './model.svelte';

/**
 * Checkout store (Spec B): the editing-session state layered over the model
 * store. Owns MY held locks (token-keyed; tokens are private to the acquirer
 * and never broadcast), the heartbeat (Task 6), and the preview/commit/discard
 * lifecycle (Task 7). Peer lock state (badges) comes from realtime.svelte.ts;
 * this store is the authoritative source for my own tokens.
 */

export type LockConflictLite = {
	resource_id: string;
	held_by: string;
	held_by_email?: string;
	held_mode: string;
};
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

/** Resources whose server-held lock expired while I held them. Their staged
 * edits are uncommittable until the user re-checks-out or discards. */
const _stale = new SvelteMap<string, true>();

let _role = $state('viewer');
let _lockTtlSeconds = 300;
let _strictMode = $state(false);
let _clientConfig: ClientConfig | undefined;

export function setCheckoutApiConfig(cfg: ClientConfig | undefined): void {
	_clientConfig = cfg;
}

export function setProjectInfo(info: {
	role: string;
	lockTtlSeconds: number;
	strictMode?: boolean;
}): void {
	_role = info.role;
	_lockTtlSeconds = info.lockTtlSeconds > 0 ? info.lockTtlSeconds : _lockTtlSeconds;
	if (info.strictMode !== undefined) _strictMode = info.strictMode;
}

export function getRole(): string {
	return _role;
}

export function getStrictMode(): boolean {
	return _strictMode;
}

/** Direct setter used by the owner Settings toggle (Task 8) after a successful
 * PATCH /settings, so the DiffDrawer gate reflects the new policy immediately. */
export function setStrictMode(v: boolean): void {
	_strictMode = v;
}

export function canEdit(): boolean {
	return _role === 'editor' || _role === 'owner';
}

export function getHeldToken(resourceId: string): string | undefined {
	return _registry.get(resourceId)?.token;
}

export function getHeldTokens(): string[] {
	// ephemeral dedup of token strings, not reactive state
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
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
		// Re-acquiring a resource that had gone stale (server-side TTL lapse)
		// makes its staged edits committable again — clear the stale mark so the
		// StatusBar warning is not sticky.
		for (const le of res.leases) _stale.delete(le.resource_id);
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
	_stale.clear();
	_role = 'viewer';
	_lockTtlSeconds = 300;
	_strictMode = false;
	_stopHeartbeat(); // defined in Task 6
}

// --- heartbeat -------------------------------------------------------------

let _heartbeat: ReturnType<typeof setInterval> | null = null;

function _maybeStartHeartbeat(): void {
	if (_heartbeat !== null) return;
	if (_registry.size === 0) return;
	const intervalMs = Math.max(1, Math.floor((_lockTtlSeconds / 2) * 1000));
	_heartbeat = setInterval(() => void _renewAll(), intervalMs);
}

function _stopHeartbeat(): void {
	if (_heartbeat !== null) {
		clearInterval(_heartbeat);
		_heartbeat = null;
	}
}

async function _renewAll(): Promise<void> {
	for (const token of getHeldTokens()) {
		try {
			const res = await renewLock(token, _clientConfig);
			if (!res.ok) {
				_dropToken(token);
				_onTokenExpired(token);
			}
		} catch {
			// transient renew failure: keep the token; next tick retries
		}
	}
	if (_registry.size === 0) _stopHeartbeat();
}

// --- project open + expiry (Task 8) ----------------------------------------

/** Fetch role + lock TTL from /open and adopt them. */
export async function loadProjectInfo(cfg?: ClientConfig): Promise<void> {
	const info = await openProject(cfg ?? _clientConfig);
	setProjectInfo({
		role: info.role,
		lockTtlSeconds: info.lock_ttl_seconds,
		strictMode: info.strict_mode
	});
}

export function getStaleResources(): string[] {
	return [..._stale.keys()];
}

export function clearStaleResource(id: string): void {
	_stale.delete(id);
}

/** Feed lock-event handler: if one of MY held resources is released/expired by
 * the server (TTL lapse), mark it stale (its staged edits are now
 * uncommittable) and drop my token for it. */
export function handleRemoteLockEvent(
	action: 'acquired' | 'released' | 'expired',
	leases: LeaseLite[]
): void {
	if (action === 'acquired') return;
	const me = getCurrentUserId();
	for (const le of leases) {
		if (le.holder_id !== me) continue;
		if (!_registry.has(le.resource_id)) continue;
		const token = _registry.get(le.resource_id)?.token;
		if (action === 'expired') _stale.set(le.resource_id, true);
		if (token) _dropToken(token);
	}
	if (_registry.size === 0) _stopHeartbeat();
}

/** Replace the Task 6 expiry stub: a renew-detected expiry also marks stale. */
function _onTokenExpired(token: string): void {
	// Caller (_renewAll / handleRemoteLockEvent) drops the token; this only stale-marks.
	for (const [rid, lease] of _registry) {
		if (lease.token === token) _stale.set(rid, true);
	}
}

// --- preview / commit / discard --------------------------------------------

/** Preview the staged batch at the live rev (kept current by the feed). */
export function previewStaged(): Promise<PreviewResponse> {
	return previewCommit(getModelRev(), getStagedOps(), _clientConfig);
}

/** Commit all staged edits. On success the server releases the passed tokens,
 * so we apply the delta and clear the buffer + registry locally. */
export async function commitStaged(message: string, ackErrors: boolean): Promise<CommitResponse> {
	const res = await commitChanges(
		{
			baseRev: getModelRev(),
			ops: getStagedOps(),
			message,
			lockTokens: getHeldTokens(),
			ackErrors
		},
		_clientConfig
	);
	// Clear the staged buffer first so applyDelta's hasQueuedOpFor guard does
	// not skip the committed elements — the server's canonical rev is the truth.
	clearStaged();
	applyDelta(res);
	_registry.clear();
	_stopHeartbeat();
	return res;
}

/**
 * The set of resource_ids that `ops` need a lock on at commit time:
 *   - update/delete element|relationship -> the op's `id`
 *   - create_relationship -> its `source_id` AND `target_id`
 *   - create_element -> its `temp_id`
 * Used by {@link discardElement} to avoid releasing a token that a REMAINING
 * staged op still depends on (e.g. a connect's create_relationship needs the
 * source's exclusive lock even after the source's own property edit is
 * discarded).
 */
function lockedResourcesNeededBy(ops: Op[]): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const needed = new Set<string>();
	for (const op of ops) {
		switch (op.kind) {
			case 'create_element':
				needed.add(op.temp_id);
				break;
			case 'create_relationship':
				needed.add(op.source_id);
				needed.add(op.target_id);
				break;
			case 'update_element':
			case 'delete_element':
			case 'update_relationship':
			case 'delete_relationship':
				needed.add(op.id);
				break;
		}
	}
	return needed;
}

/**
 * Shared body of the per-element abandon surfaces: run `revert` over `id`'s
 * staged ops, then release `id`'s lock token IFF no REMAINING staged op still
 * needs a lock on any resource that token covers (a connect holds the source
 * under one token but stages a create_relationship that still needs that
 * source lock to commit; releasing it here would orphan that op into a 409 at
 * commit). When a remaining op still needs it, the token and its registry
 * entries are kept intact so the lock stays reported-held and is sent at
 * commit. Either way the resource stops being stale-blocked (its staged edits
 * are gone) and an emptied registry stops the heartbeat.
 *
 * Only `id`'s OWN token is a release candidate. A cascade can additionally
 * strand a co-endpoint's token (the far end of a discarded staged
 * relationship), which is deliberately left held: that lease was acquired for
 * an explicit user intent and expires on its own TTL, whereas eagerly
 * releasing every now-unneeded token would silently drop check-outs the user
 * still believes they hold.
 */
async function _discardWith(id: string, revert: (id: string) => void): Promise<void> {
	const token = getHeldToken(id);
	revert(id);
	if (token !== undefined) {
		const stillNeeded = lockedResourcesNeededBy(getStagedOps());
		const tokenResources = [..._registry].filter(([, l]) => l.token === token).map(([rid]) => rid);
		const tokenStillNeeded = tokenResources.some((rid) => stillNeeded.has(rid));
		if (!tokenStillNeeded) {
			// No remaining staged op needs any resource this token covers — safe to
			// release the whole token (frees co-acquired resources, e.g. a subtree).
			_dropToken(token);
			await releaseLock(token, _clientConfig);
		}
		// else: a remaining op still needs a resource this token covers — keep the
		// lease and its registry entries so the lock stays held and is sent at commit.
	}
	// Its staged edits were abandoned; the resource is no longer stale-blocked.
	_stale.delete(id);
	if (_registry.size === 0) _stopHeartbeat();
}

/** Per-element abandon: revert the element's OWN staged ops (ops whose target
 * is `id`) and release its token when nothing staged still needs it. Used by
 * the diff drawer and the inspector's lock control, where a co-acquired
 * relationship op must survive the discard (see {@link _discardWith}). */
export function discardElement(id: string): Promise<void> {
	return _discardWith(id, revertStagedFor);
}

/** Cascading per-element abandon: like {@link discardElement} but also reverts
 * every staged relationship op incident to `id` ({@link revertStagedForElement}).
 * This is the "Staged elements" sidebar's revert: that section is the only way
 * to reach a temp element, and leaving a staged rel pointing at a reverted temp
 * id would 422 the commit — so the surface that un-creates the element must take
 * its incident rel ops with it. Because the cascade removes the very ops that
 * would otherwise keep `id`'s token needed, this reliably releases the lease
 * instead of leaking it for the full TTL. */
export function discardElementCascade(id: string): Promise<void> {
	return _discardWith(id, revertStagedForElement);
}

/** Abandon everything: revert all staged edits and release every token. */
export async function discardAll(): Promise<void> {
	revertAllStaged();
	const tokens = getHeldTokens();
	_registry.clear();
	_stale.clear();
	_stopHeartbeat();
	await Promise.all(tokens.map((t) => releaseLock(t, _clientConfig).catch(() => {})));
}

export const __ttlForTests = () => _lockTtlSeconds;
