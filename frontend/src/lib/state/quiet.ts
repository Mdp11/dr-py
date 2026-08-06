/**
 * The "quiet project" predicate: the ONE definition of when a whole-model
 * rewrite (history Revert, metamodel Swap) is safe to run.
 *
 * It lives in its own module because it is composed from three different
 * stores and is read by two components that must never disagree — they used to
 * spell the same three-term expression out verbatim, which is exactly how the
 * `art:`-lease regression got into both of them at once.
 */

import { getStagedDepth } from './model.svelte';
import { getStagedArtifactDepth } from './artifact-edits.svelte';
import { hasModelLocks } from './realtime.svelte';

/**
 * True when nothing uncommitted or checked-out stands in the way of rewriting
 * the model wholesale. Three terms, each for its own reason:
 *
 *  - **no staged MODEL ops** — a revert/rebind moves `model_rev` under them,
 *    so the next `POST /commits` would 409 on a stale `base_rev`.
 *  - **no staged ARTIFACT ops** — they ride the SAME commit batch (one mixed
 *    `POST /commits`), so they are invalidated by exactly the same rev bump.
 *    This term stays even though artifact CONTENT is untouched by a revert.
 *  - **no MODEL-scope lease anywhere in the project** — a peer mid-edit would
 *    have the ground moved under them. Deliberately {@link hasModelLocks} and
 *    not `getLockState().size`: an `art:` lease means some user has an artifact
 *    editor tab open, which is orthogonal to a model rewrite (the backend's
 *    `/commits/revert` refuses ranges containing artifact ops outright). Before
 *    artifact editing moved onto the lease flow those tabs took no lock at all,
 *    so counting them here would newly disable Revert and Swap project-wide for
 *    the full lock TTL every time anyone opened a table.
 */
export function isProjectQuiet(): boolean {
	return getStagedDepth() === 0 && getStagedArtifactDepth() === 0 && !hasModelLocks();
}
