/**
 * Staged-artifact-ops store (artefacts revamp Phase 1, frontend rewire).
 *
 * The artifact sibling of `model.svelte.ts`'s staged-edits buffer: artifact
 * editors (navigations, tables, code snippets) "Save" by staging a
 * `create_artifact` / `update_artifact` / `delete_artifact` op HERE rather
 * than POSTing straight to the legacy `/artifacts` REST routes. The buffer is
 * reviewed and committed by `checkout.svelte.ts` (concatenated with the model
 * staged-ops buffer into one `POST /commits` batch) and cleared once the
 * server's canonical delta comes back.
 *
 * ONE STAGED ENTRY PER ARTIFACT ID — this is a correctness invariant, not
 * tidiness. The backend's artifact-op applier (`api/artifact_ops.py`)
 * resolves `update_artifact` / `delete_artifact` ids LITERALLY — unlike model
 * ops, it does NOT run them through the batch's `id_map` — so a batch
 * containing both `create_artifact{temp_id: tmp_x}` and a separate
 * `update_artifact{id: tmp_x}` is a hard 422 (the applier looks for an
 * existing row `tmp_x` and finds none). Every `stageArtifact*` call therefore
 * COALESCES into the artifact's single existing entry (if any) instead of
 * appending a second op, per the rules below:
 *   - update-over-create merges into the create (still unborn server-side).
 *   - update-over-update keeps whichever fields the later call omits.
 *   - delete-over-create drops both ops entirely (the artifact never existed
 *     server-side, so there is nothing to delete).
 *   - delete-over-update collapses to a bare delete (the update is moot).
 *
 * Two distinct "un-stage" paths, matching two distinct real-world triggers:
 *   - `clearStagedArtifacts` is the COMMIT-SUCCESS path: the server has just
 *     applied the batch and `notifyArtifactCommit` has already told every
 *     listener the authoritative outcome (id map, changed headers, deleted
 *     ids), so wiping the buffer here is silent BY DESIGN — firing discard
 *     listeners too would tell open editors "your edit was undone" when it
 *     was in fact just durably saved.
 *   - `discardAllStagedArtifacts` is the USER-DISCARD path (e.g. "Discard
 *     all" in the commit review): nothing was saved, so every listener needs
 *     to hear about every entry going away, to unwind editor drafts and
 *     release now-unneeded locks.
 */

import { SvelteMap } from 'svelte/reactivity';
import { createTempId } from './ops';
import type { ArtifactOp } from './ops';
import type { ArtifactHeader } from '$lib/api/types';

export type StagedArtifactEntry =
	| {
			kind: 'create';
			tempId: string;
			artifactKind: 'navigation' | 'table' | 'code_snippet';
			name: string;
			payload: Record<string, unknown>;
			sourceTabId: string | null;
	  }
	| {
			kind: 'update';
			id: string;
			name?: string;
			payload?: Record<string, unknown>;
			header: ArtifactHeader | null;
	  }
	| { kind: 'delete'; id: string; header: ArtifactHeader };

/** artifact id (temp or real) -> its ONE staged entry. See the module
 * docstring's "ONE STAGED ENTRY PER ARTIFACT ID" invariant. */
const _staged = new SvelteMap<string, StagedArtifactEntry>();

// ---------------------------------------------------------------------------
// Listener registries (plain arrays; onX returns an unsubscribe function)
// ---------------------------------------------------------------------------

export interface ArtifactCommitInfo {
	idMap: Record<string, string>;
	changed: ArtifactHeader[];
	deletedIds: string[];
}

const _commitListeners: ((info: ArtifactCommitInfo) => void)[] = [];

/** Fired by `notifyArtifactCommit` after a successful `POST /commits` that
 * carried artifact ops — the artifact analogue of the model store's delta
 * application. Registered listeners (editors, the sidebar library) reconcile
 * their own state from the authoritative id map / changed headers / deleted
 * ids rather than from the (now-discarded) staged entries. */
export function onArtifactCommit(cb: (info: ArtifactCommitInfo) => void): () => void {
	_commitListeners.push(cb);
	return () => {
		const i = _commitListeners.indexOf(cb);
		if (i !== -1) _commitListeners.splice(i, 1);
	};
}

/** Called by whoever drives the commit (checkout.svelte.ts) once the server
 * has acked the batch. Does NOT touch `_staged` itself — the caller clears
 * the buffer via `clearStagedArtifacts` separately. */
export function notifyArtifactCommit(info: ArtifactCommitInfo): void {
	for (const cb of [..._commitListeners]) cb(info);
}

const _discardListeners: ((id: string) => void)[] = [];

/** Fired once per id by `revertStagedArtifact` and `discardAllStagedArtifacts`
 * — "this staged edit was undone, nothing was saved". NOT fired by
 * `clearStagedArtifacts` (see module docstring). */
export function onArtifactStageDiscarded(cb: (id: string) => void): () => void {
	_discardListeners.push(cb);
	return () => {
		const i = _discardListeners.indexOf(cb);
		if (i !== -1) _discardListeners.splice(i, 1);
	};
}

const _stagedDeleteListeners: ((id: string) => void)[] = [];

/** Fired by every `stageArtifactDelete` call (whatever the coalescing
 * outcome — fresh delete, collapse-from-update, or drop-both-from-create) so
 * open editors can close any tab still bound to the artifact right away,
 * without waiting for the commit round-trip. */
export function onArtifactStagedDelete(cb: (id: string) => void): () => void {
	_stagedDeleteListeners.push(cb);
	return () => {
		const i = _stagedDeleteListeners.indexOf(cb);
		if (i !== -1) _stagedDeleteListeners.splice(i, 1);
	};
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/** Stage a new artifact. Always creates a fresh entry (a create can never
 * coalesce with anything preceding it — there is no prior entry to coalesce
 * into, since the temp id is minted here). Returns the temp id so the caller
 * can bind its editor tab to it. */
export function stageArtifactCreate(
	kind: 'navigation' | 'table' | 'code_snippet',
	name: string,
	payload: Record<string, unknown>,
	sourceTabId: string | null
): string {
	const tempId = createTempId();
	_staged.set(tempId, { kind: 'create', tempId, artifactKind: kind, name, payload, sourceTabId });
	return tempId;
}

/**
 * Re-point a staged create's `sourceTabId` after its editor re-keyed the tab it
 * was staged from.
 *
 * The save-as forks (`saveAsDraft` / `saveAsTableDraft`) have to stage FIRST —
 * the new tab key is `<prefix>:<tempId>`, so it does not exist until the temp
 * id does — and then move the tab. Without this the entry would record a tab id
 * that no longer exists and, once the original artifact is reopened, names a
 * DIFFERENT tab entirely. No-op unless a CREATE is staged under `tempId`.
 */
export function repointStagedArtifactSourceTab(tempId: string, sourceTabId: string | null): void {
	const existing = _staged.get(tempId);
	if (existing?.kind !== 'create') return;
	_staged.set(tempId, { ...existing, sourceTabId });
}

/**
 * Stage a name and/or payload change. Coalesces into whatever is already
 * staged for `id` (see module docstring):
 *   - staged create -> merge the patch into the create's name/payload.
 *   - staged update -> merge the patch, keeping fields the new patch omits.
 *   - nothing staged -> a fresh update entry (`header: null` — the DiffDrawer
 *     resolves a display name via `artifactHeaderById` instead; see the task
 *     brief's reasoning for keeping this signature two-arg).
 *   - staged delete -> a programming error (the UI hides deleted artifacts,
 *     so nothing should be able to reach an update on one): warn and ignore
 *     rather than resurrecting the entry or throwing.
 */
export function stageArtifactUpdate(
	id: string,
	patch: { name?: string; payload?: Record<string, unknown> }
): void {
	const existing = _staged.get(id);
	if (existing?.kind === 'delete') {
		console.warn(`stageArtifactUpdate: ${id} is already staged for deletion; ignoring`);
		return;
	}
	if (existing?.kind === 'create') {
		_staged.set(id, {
			...existing,
			name: patch.name ?? existing.name,
			payload: patch.payload ?? existing.payload
		});
		return;
	}
	_staged.set(id, {
		kind: 'update',
		id,
		name: patch.name ?? existing?.name,
		payload: patch.payload ?? existing?.payload,
		header: existing?.header ?? null
	});
}

/**
 * Stage a delete. Coalesces:
 *   - staged create -> drop the entry entirely (delete-over-create: the
 *     artifact never existed server-side, so create+delete would 422 AND
 *     there is nothing to tell the server to delete).
 *   - staged update / nothing staged / staged delete -> a delete entry,
 *     recording `header` (the pre-delete display header, for the DiffDrawer
 *     and for the overlay to hide the row without a lookup).
 * Always notifies `onArtifactStagedDelete` listeners with `id` — including
 * the drop-both case, since an editor tab may still be open on that temp id.
 */
export function stageArtifactDelete(id: string, header: ArtifactHeader): void {
	const existing = _staged.get(id);
	if (existing?.kind === 'create') {
		_staged.delete(id);
	} else {
		_staged.set(id, { kind: 'delete', id, header });
	}
	for (const cb of [..._stagedDeleteListeners]) cb(id);
}

// ---------------------------------------------------------------------------
// Un-staging
// ---------------------------------------------------------------------------

/** Revert the single staged entry for `id` (whatever its kind) and notify
 * discard listeners. No-op (and no notification) if nothing is staged. */
export function revertStagedArtifact(id: string): void {
	if (!_staged.delete(id)) return;
	for (const cb of [..._discardListeners]) cb(id);
}

/** Commit-success path: wipe the buffer SILENTLY. See module docstring for
 * why this must not fire discard listeners. */
export function clearStagedArtifacts(): void {
	_staged.clear();
}

/** User-discard path: wipe the buffer, notifying discard listeners once per
 * entry that was staged. See module docstring. */
export function discardAllStagedArtifacts(): void {
	const ids = [..._staged.keys()];
	_staged.clear();
	const listeners = [..._discardListeners];
	for (const id of ids) {
		for (const cb of listeners) cb(id);
	}
}

/** Test/dev reset: clears staged state only. Listener registries are NOT
 * touched — module-scope `onArtifactCommit`/`onArtifactStageDiscarded`/
 * `onArtifactStagedDelete` subscriptions registered by other stores are
 * permanent for the life of the app (vitest isolates modules per test file,
 * so this never leaks subscriptions across suites either). */
export function resetArtifactEdits(): void {
	_staged.clear();
}

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

export function getStagedArtifactEntries(): StagedArtifactEntry[] {
	return [..._staged.values()];
}

export function getStagedArtifactDepth(): number {
	return _staged.size;
}

export function hasStagedArtifactOp(id: string): boolean {
	return _staged.has(id);
}

/**
 * Project staged entries to the wire `ArtifactOp` union, in insertion order.
 * `update_artifact.name`/`.payload` are OMITTED (not sent as `undefined`)
 * when unset: the backend treats an absent key as "unchanged", so a
 * name-only rename must not blank the payload by sending `payload: undefined`
 * (which — despite `JSON.stringify` dropping it — is exactly the bug class
 * this guards against if the wire encoding ever changes).
 */
export function getStagedArtifactOps(): ArtifactOp[] {
	return [..._staged.values()].map((e): ArtifactOp => {
		switch (e.kind) {
			case 'create':
				return {
					kind: 'create_artifact',
					temp_id: e.tempId,
					artifact_kind: e.artifactKind,
					name: e.name,
					payload: e.payload
				};
			case 'update':
				return {
					kind: 'update_artifact',
					id: e.id,
					...(e.name !== undefined ? { name: e.name } : {}),
					...(e.payload !== undefined ? { payload: e.payload } : {})
				};
			case 'delete':
				return { kind: 'delete_artifact', id: e.id };
		}
	});
}

/**
 * Merge the staged buffer into a server-fetched header list for display:
 * renamed entries show their staged name, deleted entries are hidden, and
 * staged creates are synthesized and appended (in staging order).
 *
 * `entry_points: null` on a synthesized create header is DELIBERATE, not a
 * placeholder omission: `entry_points` is server-derived (the backend AST-
 * derives it from the snippet's code on create/update — see
 * `routes/artifacts.py`'s `_apply_derived_metadata`), so the client cannot
 * honestly claim a value for a staged-but-uncommitted snippet. Leaving it
 * null keeps the staged snippet invisible to the ref dropdowns'
 * `entryAvailable` filter until it is actually committed — the same
 * treatment an unsaved draft gets today.
 */
export function overlayArtifactHeaders(items: ArtifactHeader[]): ArtifactHeader[] {
	const out: ArtifactHeader[] = [];
	for (const item of items) {
		const entry = _staged.get(item.id);
		if (entry?.kind === 'delete') continue; // hidden until commit/discard
		if (entry?.kind === 'update' && entry.name !== undefined) {
			out.push({ ...item, name: entry.name });
		} else {
			out.push(item);
		}
	}
	for (const entry of _staged.values()) {
		if (entry.kind !== 'create') continue;
		out.push({
			id: entry.tempId,
			kind: entry.artifactKind,
			name: entry.name,
			artifact_rev: 0,
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- one-shot timestamp string, not a held reactive value
			updated_at: new Date().toISOString(),
			updated_by: null,
			entry_points: null
		});
	}
	return out;
}

/** `'new'` (staged create) / `'edited'` (staged update) / `'deleted'` (staged
 * delete) / `null` (nothing staged) for badge rendering. */
export function stagedArtifactState(id: string): 'new' | 'edited' | 'deleted' | null {
	const entry = _staged.get(id);
	if (!entry) return null;
	switch (entry.kind) {
		case 'create':
			return 'new';
		case 'update':
			return 'edited';
		case 'delete':
			return 'deleted';
	}
}

/** The tab a staged create originated from (for the sidebar's "focus the
 * originating tab" click handler), or null for a non-create / unknown id. */
export function stagedCreateSourceTab(tempId: string): string | null {
	const entry = _staged.get(tempId);
	return entry?.kind === 'create' ? entry.sourceTabId : null;
}
