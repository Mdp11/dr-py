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
	defaultFeedUrl,
	type FeedConfig,
	type FeedConnection,
	type FeedEvent,
	type LeaseLite
} from '$lib/api/feed';
import { getActiveProjectId } from '$lib/state/active-project.svelte';
import { applyDelta, getIssueCounts, getModelRev, refreshSummary } from './model.svelte';
import { handleArtifactFeedEvent } from './artifacts.svelte';
import { isArtifactResource, isFolderResource } from './ops';
import type { OpsResponse } from '$lib/api/types';

let _connected = $state(false);
let _presence = $state<string[]>([]);
const _lockState = new SvelteMap<string, LeaseLite>();
let _conn: FeedConnection | null = null;
let _pendingRebind = $state<{ rev: number; count: number } | null>(null);
// Terminal feed close (4401/4403/4404, or 4408 after repeated failed retries).
// Reactive so the workspace can render a context-appropriate banner; the feed
// transport itself stays pure and only signals via the onTerminal callback.
let _feedTermination = $state<{ code: number } | null>(null);

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

/** What a commit tap is told about the commit that fired it. `scope` lists the
 * content families the commit touched ("model" and/or "artifact"), so a
 * subscriber whose work only matters for one of them can opt out of the other.
 * It is NEVER empty: an event that arrives without a scope (older server, test
 * fixture) is reported as `['model']`, the conservative reading. */
type CommitTap = (info: { scope: string[] }) => void;

// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _commitTaps = new Set<CommitTap>();

/** Register a tap fired after every commit/rebind feed event (the history
 * drawer uses this to refetch the first page while open). Returns unsubscribe. */
export function onCommitEvent(cb: CommitTap): () => void {
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

/**
 * True while ANY project-wide lease covers a MODEL-scope resource (elements,
 * relationships) — i.e. `getLockState()` minus the `art:`, `folder:`, and
 * `mm` namespaces.
 *
 * The distinction is load-bearing, not cosmetic. `getLockState()` is the whole
 * project's lease table, and since artifact editing moved onto the
 * lock→edit→commit flow EVERY open navigation/table/snippet tab holds an
 * `art:` lease (taken on open, re-taken after each commit). Gating a
 * model-scope operation on the raw map size would let one user's open editor
 * tab disable that operation for EVERYONE for the full lock TTL. Model revert
 * and metamodel rebind are model-scope by construction — the backend's
 * `/commits/revert` 409s on any range containing artifact OR view ops anyway
 * — so an `art:`/`folder:` lease is orthogonal to them and must not count.
 * A `folder:` lease is VIEW-scope for the identical reason `art:` is
 * artifact-scope: every sidebar drag/rename/create-child gesture takes one,
 * so counting it would let one user's sidebar drag disable model revert for
 * everyone. `mm` is excluded too — see the comment on its check below.
 *
 * Reactive: iterating a `SvelteMap`'s keys subscribes to it, so a `$derived`
 * reading this re-runs on every lock feed event.
 */
export function hasModelLocks(): boolean {
	for (const rid of _lockState.keys()) {
		// `mm` mirrors the backend's `is_model_resource` (locking.py): the
		// metamodel lease is NOT a model-scope lease there either. Rebind's own
		// quiescence check ignores it server-side (a peer holding `mm` gets its
		// own 409-with-email from the metamodel writer, independent of this
		// predicate), and counting it here would make the metamodel editor's
		// own `mm` lease disable its own Rebind button the moment it opens.
		if (rid !== 'mm' && !isArtifactResource(rid) && !isFolderResource(rid)) return true;
	}
	return false;
}

export function getLockFor(id: string): LeaseLite | undefined {
	return _lockState.get(id);
}

export function getPendingRebind(): { rev: number; count: number } | null {
	return _pendingRebind;
}

/** The terminal close code that ended the feed (and stopped reconnection), or
 * null while the feed is healthy/reconnecting. */
export function getFeedTermination(): { code: number } | null {
	return _feedTermination;
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
			// Absent scope => model-scoped. The transport does no validation, and a
			// commit that we wrongly took for artifact-only would leave the model
			// cache stale, so the defensive default is the one that does MORE work.
			const scope = e.scope ?? ['model'];
			// The delta synthesis + applyDelta below stay UNCONDITIONAL even for an
			// artifact-only commit: `previewStaged`/`commitStaged` send our
			// `model_rev` as `base_rev` and the backend's preview path compares it
			// with STRICT equality, so a peer that declined to adopt artifact-only
			// revs would 409 on its next preview. Only the taps get the scope.
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
			for (const tap of _commitTaps) tap({ scope });
			break;
		}
		case 'rebind':
			_pendingRebind = { rev: e.rev, count: e.validation_error_count };
			// A metamodel swap rewrites model content wholesale; artifacts are
			// untouched by it, so this is model-scoped by construction.
			for (const tap of _commitTaps) tap({ scope: ['model'] });
			break;
		case 'artifact':
			handleArtifactFeedEvent();
			break;
	}
}

export function startRealtime(config?: Partial<FeedConfig>): void {
	if (_conn) return;
	const pid = getActiveProjectId();
	if (!pid) return; // no active project ⇒ no feed
	_conn = connectFeed({
		...config,
		url: config?.url ?? defaultFeedUrl(pid),
		// handlers are intentionally set after the spread so store logic is always authoritative
		onEvent: handleFeedEvent,
		onStatus: (c) => {
			_connected = c;
		},
		onTerminal: (code) => {
			_feedTermination = { code };
		}
	});
}

export function stopRealtime(): void {
	_conn?.close();
	_conn = null;
	_connected = false;
	_feedTermination = null;
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
