/**
 * Staged-view-ops store (artefacts revamp Phase 2, frontend rewire).
 *
 * An ORDERED JOURNAL of `ViewOp`s queued for commit, NOT a coalescing
 * per-id map (contrast: `artifact-edits.svelte.ts` holds ONE ENTRY PER
 * ARTIFACT ID). View ops are ORDER-DEPENDENT — create_folder followed by
 * place_element into that folder, then rename_folder — so plucking an op
 * from the middle of the sequence is unsound. There is no per-entry revert;
 * the only unwind is an all-or-nothing `discardStagedView`.
 *
 * `label` is captured AT STAGE TIME: after the optimistic local apply
 * (which mutations `_view` immediately), a deleted or renamed folder's
 * prior name is unrecoverable from the blob — the label records what the
 * user just did, for undo history display and the DiffDrawer.
 */

import type { ViewOp } from './ops';

export interface StagedViewEntry {
	op: ViewOp;
	label: string;
}

let _journal = $state<StagedViewEntry[]>([]);

export function stageViewOp(op: ViewOp, label: string): void {
	_journal = [..._journal, { op, label }];
}

export function getStagedViewOps(): ViewOp[] {
	return _journal.map((e) => e.op);
}

export function getStagedViewEntries(): StagedViewEntry[] {
	return [..._journal];
}

export function getStagedViewDepth(): number {
	return _journal.length;
}

/** Commit-success path: wipe SILENTLY — the edits were saved, not undone
 * (mirrors clearStagedArtifacts; notifyViewCommitted is the authoritative
 * "it landed" signal, fired separately by checkout). */
export function clearStagedView(): void {
	_journal = [];
}

/**
 * User-discard path — the ONE wipe that also RECONCILES `_view`.
 *
 * The view store's optimistic applies are BAKED INTO its `_view` (see
 * view.svelte.ts's header): dropping the journal without refetching leaves the
 * sidebar showing folders/renames/placements that exist nowhere and are no
 * longer staged, and the next gesture computes its guards and indices against
 * that phantom tree — staging an op naming a folder id the server never saw,
 * which 422s at commit long after the user was told the gesture succeeded.
 *
 * So the refetch is enforced HERE, in the store, not at the call sites: every
 * discard surface (view.svelte.ts's `discardViewChanges`, checkout's
 * `discardAll`, and any future third one) goes through this function and gets
 * the reconciliation for free. Awaiting the listeners — rather than firing and
 * forgetting — is what lets a caller `await discardStagedView()` and know the
 * tree is server-truth again before it does anything else.
 */
export async function discardStagedView(): Promise<void> {
	_journal = [];
	for (const cb of [..._discardListeners]) await cb();
}

/** SILENT wipe: no discard listeners, no refetch. Only for callers that own
 * the `_view` reconciliation themselves — project teardown (`clearViewState`,
 * which nulls `_view` outright) and `refreshView`'s conflict-drop (already
 * inside a refetch; notifying there would re-enter it). Every other discard
 * surface wants {@link discardStagedView}. */
export function resetViewEdits(): void {
	_journal = [];
}

const _discardListeners: (() => void | Promise<void>)[] = [];

/** Subscribe to {@link discardStagedView}. view.svelte.ts registers
 * `refreshView` here (EAGERLY, at module scope — unlike the realtime tap it
 * sits beside, this module has no back-edge into view.svelte.ts, so there is
 * no cycle to defer past). Mirrors {@link onViewCommitted}'s shape; lives here
 * for the same reason — checkout must never import the view store. */
export function onViewDiscarded(cb: () => void | Promise<void>): () => void {
	_discardListeners.push(cb);
	return () => {
		const i = _discardListeners.indexOf(cb);
		if (i !== -1) _discardListeners.splice(i, 1);
	};
}

const _commitListeners: (() => void)[] = [];

/** Fired by checkout.svelte.ts after a successful POST /commits whose batch
 * carried view ops — view.svelte.ts subscribes to refetch GET /view (server
 * truth; concretizes tmp_ folder ids). Lives HERE, not in view.svelte.ts,
 * so checkout never imports the view store (no cycle: view.svelte.ts →
 * edit-gate → checkout → view-edits). */
export function onViewCommitted(cb: () => void): () => void {
	_commitListeners.push(cb);
	return () => {
		const i = _commitListeners.indexOf(cb);
		if (i !== -1) _commitListeners.splice(i, 1);
	};
}

export function notifyViewCommitted(): void {
	for (const cb of [..._commitListeners]) cb();
}
