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

/** User-discard path. The journal has no per-entry listeners to notify
 * (no editor holds a view op open); the caller (view.svelte.ts's
 * discardViewChanges) refetches GET /view and releases folder leases. */
export function discardStagedView(): void {
	_journal = [];
}

export function resetViewEdits(): void {
	_journal = [];
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
