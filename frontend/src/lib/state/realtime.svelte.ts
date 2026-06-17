/**
 * Realtime feed store (Phase 5, Spec A — thin). Subscribes to the project feed
 * and reduces its events into reactive state: connection status, the set of
 * connected users (presence), and the live lock table (resource_id -> lease).
 * Commit deltas from OTHER clients are applied into the existing model cache
 * via `applyDelta`. This store does NOT change the editing path; lock-badge
 * RENDERING and the lock->edit->commit UI land in Spec B.
 */

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
let _lockState = $state<Map<string, LeaseLite>>(new Map());
let _conn: FeedConnection | null = null;

export function getFeedConnected(): boolean {
	return _connected;
}

export function getPresence(): string[] {
	return _presence;
}

export function getLockState(): Map<string, LeaseLite> {
	return _lockState;
}

export function getLockFor(id: string): LeaseLite | undefined {
	return _lockState.get(id);
}

function setLeases(leases: LeaseLite[]): void {
	const next = new Map(_lockState);
	for (const le of leases) next.set(le.resource_id, le);
	_lockState = next;
}

function clearLeases(leases: LeaseLite[]): void {
	const next = new Map(_lockState);
	for (const le of leases) next.delete(le.resource_id);
	_lockState = next;
}

/** Exported for unit tests; also the single dispatch point for `connectFeed`. */
export function handleFeedEvent(e: FeedEvent): void {
	switch (e.type) {
		case 'snapshot': {
			_presence = e.connected;
			_lockState = new Map(e.locks.map((le) => [le.resource_id, le] as const));
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
			break;
		}
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
	_lockState = new Map();
}
