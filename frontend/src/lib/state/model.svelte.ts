import type { Issue } from '$lib/api/types';
import { validateModel } from '../api/validation';
import * as engine from './model-engine.svelte';
import { resetSharedStore } from './model-shared.svelte';
import type { ModelOp } from './ops';

/**
 * The model store: `model-shared.svelte.ts` (re-exported below) holds the
 * counters and issue state, `model-engine.svelte.ts` the entity half, a view
 * over the replica, which holds the staged edits. This file re-exports the
 * entity half and adds what spans both: `captureStaged`, `validateAll`,
 * `resetModelStore` and `reloadModelStore`.
 */

export * from './model-shared.svelte';
export type { StagedConflict } from './model-engine.svelte';
export {
	StagedUnreadableError,
	applyDelta,
	clearStaged,
	dropTreeItems,
	emit,
	emitMany,
	ensureElement,
	ensureElements,
	ensureRelationship,
	ensureTreeItems,
	getCachedElements,
	getCachedRelationships,
	getCachedTreeItems,
	getMissingElementIds,
	getStagedBatchIds,
	getStagedChangeCount,
	getStagedConflicts,
	getStagedDepth,
	getStagedDiff,
	getStagedNameOverride,
	getStagedOps,
	getStagedOpsFor,
	getTreeElements,
	hasStagedOps,
	isStagedDeleted,
	popLastStaged,
	revertAllStaged,
	revertConflict,
	revertStagedFor,
	revertStagedForElement,
	seedElements,
	seedRelationships,
	seedTreeItems,
	setModelApiConfig,
	stagedSettled,
	dropBatches as dropStagedBatches,
	markLanded as markStagedLanded
} from './model-engine.svelte';

/**
 * The staged model ops a batch sends, and the ids of the engine batches
 * holding exactly them — read together from the mirror's batches, so an edit
 * not yet in them is neither sent nor named. Exact once `stagedSettled()`
 * has resolved.
 */
export function captureStaged(): { ops: ModelOp[]; batchIds: number[] } {
	const batches = engine.getStagedBatches();
	return { ops: batches.flatMap((batch) => batch.ops), batchIds: batches.map((batch) => batch.id) };
}

/**
 * Full validation run that INCLUDES staged (uncommitted) edits: the engine's
 * staged batches, once every edit has reached them, named by their ids; the
 * engine validates those batches itself. Rejects with `StagedUnreadableError`,
 * posting nothing, while they cannot be read.
 *
 * A pure fetch: it does NOT mutate the live issue map (see `adoptIssues`/
 * `applyDelta`). The caller (`validate-action.ts`'s `runValidation`) stores
 * the origin-tagged result as the Validate OVERLAY via `setOverlay`; that
 * overlay, not this function, is what lets resolved/uncommitted issues
 * surface in the panel.
 */
export async function validateAll(): Promise<Issue[]> {
	await engine.stagedSettled();
	return validateModel({ batchIds: captureStaged().batchIds });
}

/** Drop every cache, counter, queue, and error — for tests and for replacing the model (load/upload flows call this, then refreshSummary()). */
export function resetModelStore(): void {
	engine.resetEngineStore();
	resetSharedStore();
}

/**
 * The model store's share of reloading the model: every staged model edit is
 * dropped with the caches, as the lock registry is — the replica's staged and
 * parked batches are unstaged first, awaited, since the replica would keep
 * them and their leases are gone.
 */
export async function reloadModelStore(): Promise<void> {
	await engine.discardAllStaged();
	resetModelStore();
}
