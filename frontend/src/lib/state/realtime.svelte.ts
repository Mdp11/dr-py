/**
 * Realtime feed store (Phase 5, Spec A — thin). Subscribes to the project feed
 * and reduces its events into reactive state: connection status, the set of
 * connected users (presence), and the live lock table (resource_id -> lease).
 * Commit deltas from OTHER clients are applied into the existing model cache
 * via `applyDelta`. This store does NOT change the editing path; lock-badge
 * RENDERING and the lock->edit->commit UI land in Spec B.
 */

import { SvelteMap } from 'svelte/reactivity';
import {
	connectFeed,
	type FeedConfig,
	type FeedConnection,
	type FeedEvent,
	type LeaseLite
} from '$lib/api/feed';
import { applyDelta, getIssueCounts, getModelRev, refreshSummary } from './model.svelte';
import type { OpsResponse } from '$lib/api/types';

let _connected = $state(false);
let _presence = $state<string[]>([]);
const _lockState = new SvelteMap<string, LeaseLite>();
let _conn: FeedConnection | null = null;
let _pendingRebind = $state<{ rev: number; count: number } | null>(null);

type LockTap = (action: 'acquired' | 'released' | 'expired', leases: LeaseLite[]) => void;
// subscriber registry, iterated to fire taps — never read reactively
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _lockTaps = new Set<LockTap>();

/** Register a tap fired on every lock feed event (the checkout store uses this
 * to detect expiry of its OWN locks). Returns an unsubscribe fn. */
export function onLockEvent(cb: LockTap): () => void {
	_lockTaps.add(cb);
	return () => _lockTaps.delete(cb);
}

// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _commitTaps = new Set<() => void>();

/** Register a tap fired after every commit/rebind feed event (the history
 * drawer uses this to refetch the first page while open). Returns unsubscribe. */
export function onCommitEvent(cb: () => void): () => void {
	_commitTaps.add(cb);
	return () => _commitTaps.delete(cb);
}

export function getFeedConnected(): boolean {
	return _connected;
}

export function getPresence(): string[] {
	return _presence;
}

export function getLockState(): SvelteMap<string, LeaseLite> {
	return _lockState;
}

export function getLockFor(id: string): LeaseLite | undefined {
	return _lockState.get(id);
}

export function getPendingRebind(): { rev: number; count: number } | null {
	return _pendingRebind;
}

export function clearPendingRebind(): void {
	_pendingRebind = null;
}

function setLeases(leases: LeaseLite[]): void {
	for (const le of leases) _lockState.set(le.resource_id, le);
}

function clearLeases(leases: LeaseLite[]): void {
	for (const le of leases) _lockState.delete(le.resource_id);
}

/** Exported for unit tests; also the single dispatch point for `connectFeed`. */
export function handleFeedEvent(e: FeedEvent): void {
	switch (e.type) {
		case 'snapshot': {
			_presence = e.connected;
			_lockState.clear();
			for (const le of e.locks) _lockState.set(le.resource_id, le);
			// If we are behind the server's rev, our cached subset may be stale.
			// Spec A keeps this light: refresh the model-wide summary counters.
			// (Spec B wires a full reload of the affected subset.)
			if (e.model_rev > getModelRev()) refreshSummary().catch(() => {});
			break;
		}
		case 'presence':
			_presence = e.connected;
			break;
		case 'lock':
			if (e.action === 'acquired') setLeases(e.leases);
			else clearLeases(e.leases);
			for (const tap of _lockTaps) tap(e.action, e.leases);
			break;
		case 'commit': {
			const delta: OpsResponse = {
				model_rev: e.rev,
				id_map: {},
				changed_elements: e.changed_elements as OpsResponse['changed_elements'],
				changed_relationships: e.changed_relationships as OpsResponse['changed_relationships'],
				deleted_element_ids: e.deleted_element_ids,
				deleted_relationship_ids: e.deleted_relationship_ids,
				issues_removed_owner_ids: [],
				issues_added: [],
				issue_counts: getIssueCounts() ?? {}
			};
			applyDelta(delta);
			for (const tap of _commitTaps) tap();
			break;
		}
		case 'rebind':
			_pendingRebind = { rev: e.rev, count: e.validation_error_count };
			for (const tap of _commitTaps) tap();
			break;
	}
}

export function startRealtime(config?: Partial<FeedConfig>): void {
	if (_conn) return;
	_conn = connectFeed({
		onEvent: handleFeedEvent,
		onStatus: (c) => {
			_connected = c;
		},
		...config
	});
}

export function stopRealtime(): void {
	_conn?.close();
	_conn = null;
	_connected = false;
}

/** Test isolation. */
export function resetRealtime(): void {
	stopRealtime();
	_presence = [];
	_lockState.clear();
	_lockTaps.clear();
	_commitTaps.clear();
	_pendingRebind = null;
}
