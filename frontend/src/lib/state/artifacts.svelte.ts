/**
 * Project-artifact library (saved navigations, tables and code snippets). Holds
 * HEADERS only — payloads are fetched by whichever editor opens the artifact.
 * Kept fresh by `artifact` feed events (peers' creates/renames/deletes) via a
 * plain refetch: the list is small and headers are cheap.
 *
 * `_items` is SERVER TRUTH — the committed library, exactly as the backend last
 * reported it. Nothing in this module writes to the server any more: renames and
 * deletes STAGE an artifact op (`artifact-edits.svelte.ts`) under a lease, and
 * reach the server only when the DiffDrawer's Commit runs `POST /commits`. The
 * committed list is reconciled from that commit's authoritative delta, in the
 * module-scope {@link onArtifactCommit} listener at the bottom of this file.
 *
 * Everything the UI RENDERS therefore goes through {@link getArtifactHeaders},
 * which projects the staged buffer over `_items` (renames show their staged
 * name, staged deletes are hidden, staged creates are appended). The two views
 * are deliberately separate functions rather than one flag: a caller that wants
 * committed truth ({@link getCommittedArtifactHeaders}) is making a claim about
 * the server, and that must not be a boolean argument away from a display list.
 */
import * as api from '$lib/api/artifacts';
import type { ArtifactHeader } from '$lib/api/types';
import type { ArtifactKind } from '$lib/artifacts/kinds';
import {
	onArtifactCommit,
	overlayArtifactHeaders,
	resetArtifactEdits,
	revertStagedArtifact,
	stageArtifactDelete,
	stageArtifactUpdate
} from './artifact-edits.svelte';
import { releaseArtifactIfUnneeded } from './checkout.svelte';
import { artifactDeleteLock, artifactEditLock, folderEditLock } from './edit-gate';
import { isTempId } from './ops';
import { artifactPlacementFolderIds } from './view-ops';
import { getView, stageRemoveArtifactRef } from './view.svelte';

let _items = $state<ArtifactHeader[]>([]);
let _loading = $state(false);

/** The library AS DISPLAYED: server truth with the staged buffer overlaid. See
 * the module docstring. Every renderer (sidebar sections, ref dropdowns, the
 * view tree's row resolution) reads through here. */
export function getArtifactHeaders(): ArtifactHeader[] {
	return overlayArtifactHeaders(_items);
}

/** Server-truth headers, no staged overlay — for the commit listener and
 * anything that must reason about committed state only. */
export function getCommittedArtifactHeaders(): ArtifactHeader[] {
	return _items;
}

export function getArtifactsLoading(): boolean {
	return _loading;
}

/** Overlay-aware single-header lookup: resolves a staged create's TEMP id and
 * reports a staged rename's new name, so an editor tab or sidebar row bound to
 * an uncommitted artifact still has a header to render. */
export function artifactHeaderById(id: string): ArtifactHeader | undefined {
	return getArtifactHeaders().find((a) => a.id === id);
}

/**
 * The headers of `kind` that may be REFERENCED BY ID from inside another
 * artifact's payload — every "pick a saved navigation / snippet" dropdown.
 *
 * A staged create sits in the overlay under a TEMP id, and a temp id must never
 * reach a payload — not because nothing would rewrite it, but because whether
 * anything does is out of this picker's hands.
 *
 * The backend DOES resolve temp ids nested inside a payload: `_resolve_json`
 * (`api/artifact_ops.py`) walks every create/update payload against the
 * batch's `id_map`, which accumulates `temp_id → real id` AS THE BATCH IS
 * APPLIED, op by op. So the rewrite only reaches a create that has ALREADY
 * been applied — a ref to a create ordered LATER in the batch resolves to
 * nothing, and an unknown string passes through as a tolerant dangler rather
 * than an error. Two things this dropdown cannot promise, then: that the
 * referenced create ships in the SAME batch AHEAD of the artifact referencing
 * it, and that the user does not revert it before committing. Either one
 * leaves a payload naming an artifact that will never exist, silently. The
 * filter refuses to depend on either.
 *
 * (Distinct from — and not to be conflated with — the rule that artifact-OP
 * ids are resolved literally: `update_artifact.id` / `delete_artifact.id` get
 * no `id_map` pass at all (`_check_update` looks the row up by `op.id`
 * directly), which is what makes `artifact-edits.svelte.ts`'s one-entry-per-id
 * coalescing a correctness invariant rather than tidiness.)
 *
 * Staged RENAMES stay, under their staged name: the id is real and persistable,
 * only the label changed. This is the payload-side half of the same rule the
 * sidebar's drag guard enforces for view placements — go through here rather
 * than filtering {@link getArtifactHeaders} by hand, so the next picker added
 * inherits it instead of re-discovering the hazard.
 */
export function referenceableArtifactHeaders(kind: ArtifactKind): ArtifactHeader[] {
	return getArtifactHeaders().filter((h) => h.kind === kind && !isTempId(h.id));
}

/**
 * Best-effort client-side name-clash check — the ONE definition, shared by all
 * three artifact editors' save paths (navigation, table, code snippet).
 *
 * The SERVER's uniqueness check is authoritative and, now that saves stage an
 * artifact op instead of POSTing, surfaces as a 422 at preview/commit. This
 * only preserves today's at-SAVE feedback: the user learns about a collision
 * when they press Save, not when they commit a whole batch. It lives here (and
 * not next to a single editor) because it needs the header list.
 *
 * Reads through {@link getArtifactHeaders}, i.e. the STAGED OVERLAY: a name
 * taken by a staged-but-uncommitted create clashes too, and a name freed by a
 * staged delete does not. `excludeId` is the artifact being saved (null for a
 * brand-new one), so re-saving one under its own name is fine.
 */
// Lowercase noun for the error sentence below ("a code snippet named…", "an
// exporter named…") — a Record so the type checker (not a ternary
// fallback that would silently print the raw kind string, e.g.
// "exporter") forces this to grow with ArtifactKind.
const NAME_CLASH_LABEL: Record<ArtifactKind, string> = {
	navigation: 'navigation',
	table: 'table',
	code_snippet: 'code snippet',
	exporter: 'exporter'
};

export function assertNoNameClash(
	kind: ArtifactKind,
	name: string,
	excludeId: string | null
): void {
	const clash = getArtifactHeaders().find(
		(h) => h.kind === kind && h.name === name && h.id !== excludeId
	);
	if (clash) {
		throw new Error(`a ${NAME_CLASH_LABEL[kind]} named "${name}" already exists`);
	}
}

export async function loadArtifacts(): Promise<void> {
	_loading = true;
	try {
		_items = (await api.listArtifacts()).items;
	} finally {
		_loading = false;
	}
}

/**
 * Stage a rename. Nothing is sent: the name change lands with the next commit.
 *
 * A TEMP id is a staged create that does not exist server-side, so there is
 * nothing to lock and the patch simply folds into the create. A real id needs
 * my `art:<id>` lease first — staging an update I cannot commit would leave the
 * user with a permanently-red batch — and a refusal reports through the global
 * lock notice ({@link artifactEditLock}) and stages nothing.
 *
 * The lease taken here is deliberately NOT released on any path: unlike
 * {@link removeArtifact}'s, it is a plain (non-DELETE) exclusive, and every path
 * past the acquire stages an op that needs it at commit time. A staged-deleted
 * artifact is hidden by the overlay, so the one `stageArtifactUpdate` no-op
 * (update-over-delete) is unreachable — the header lookup throws first.
 */
export async function renameArtifact(id: string, name: string): Promise<void> {
	const header = artifactHeaderById(id);
	if (!header) throw new Error(`Unknown artifact ${id}`);
	if (isTempId(id)) {
		stageArtifactUpdate(id, { name });
		return;
	}
	if (!(await artifactEditLock(id))) return;
	stageArtifactUpdate(id, { name });
}

/**
 * Stage a delete (or un-stage a create). Nothing is sent: the row disappears
 * from the overlay immediately and the artifact is destroyed at commit.
 *
 * The DELETE-intent exclusive conflicts with ANY peer lease, shared pins
 * included, so this refuses while anyone else has the artifact open — and, by
 * the same token, a lease acquired here and never used would block EVERY other
 * user from opening the artifact for the full TTL. `commitStaged` only releases
 * tokens the batch actually needed, so nothing else would ever clean it up:
 * every path that acquires without staging must release it explicitly.
 *
 * Decision 7 — the delete's commit carries its own scrub: rather than reacting
 * to a completed commit (the old, now-deleted `onArtifactCommit` scrub call —
 * see git history), this STAGES a `remove_artifact` view op per placement in
 * the SAME batch as the `delete_artifact`, so the commit that destroys the
 * artifact leaves no dangling refs behind at all — there is no longer a window
 * where the view still names an artifact the server has already dropped.
 *
 * Folder EDIT leases are acquired as a SECOND step, after the `art:` delete
 * lease — a peer's folder lock blocks the delete because the delete edits
 * that folder's contents, so it needs the same lease any other placement
 * change would. A single combined call is not an option: it would need ONE
 * intent for every target, and giving the folders `delete` intent (the
 * artifact's own intent) would subtree-expand each of them server-side
 * (`expand_targets`) — locking every element and sub-folder underneath, far
 * beyond what a placement-scrub actually touches. Denial of the folder step
 * rolls the already-acquired `art:` lease back via
 * {@link releaseArtifactIfUnneeded}, exactly like the raced-row case below.
 */
export async function removeArtifact(id: string): Promise<void> {
	if (isTempId(id)) {
		revertStagedArtifact(id);
		return;
	}
	if (!(await artifactDeleteLock(id))) return;
	// COMMITTED header, not the overlay's: `stageArtifactDelete` records this as
	// the DiffDrawer's display source, and deleting an artifact you also staged a
	// rename for must show the user the name the server actually holds — not one
	// that only ever existed in this client's buffer.
	const header = getCommittedArtifactHeaders().find((a) => a.id === id);
	if (!header) {
		// Raced: the row was stale (a peer's delete landed, or a refetch dropped
		// it) and there is nothing to stage. Hand the lease straight back — see
		// the docstring. `releaseArtifactIfUnneeded` keeps it if some other staged
		// op still depends on the token.
		await releaseArtifactIfUnneeded(id);
		return;
	}
	const view = getView();
	const placements = view ? artifactPlacementFolderIds(view, id) : [];
	if (placements.length > 0) {
		if (!(await folderEditLock(placements))) {
			await releaseArtifactIfUnneeded(id);
			return;
		}
		for (const folderId of placements) {
			await stageRemoveArtifactRef(folderId, id, header.name);
		}
	}
	stageArtifactDelete(id, header);
}

/** Feed reducer hook: an `artifact` event means the library changed somewhere. */
export function handleArtifactFeedEvent(): void {
	void loadArtifacts().catch(() => {});
}

export function resetArtifacts(): void {
	_items = [];
	_loading = false;
	// The staged buffer is a projection over `_items`; leaving entries behind
	// after a project close would overlay a stale library onto the next one.
	resetArtifactEdits();
}

/**
 * Commit reconciliation — a MODULE-SCOPE subscription, never torn down (the
 * store is a singleton for the life of the app, and vitest isolates modules per
 * test file, so this leaks nothing across suites).
 *
 * `changed` carries full server headers for every artifact the batch created or
 * updated (a create's header under its REAL id — the temp id only survives in
 * `idMap`, which the editors use to rebind their tabs), so upsert-by-id is the
 * whole reconciliation: no refetch, no rev arithmetic.
 *
 * The upsert is IN PLACE — a committed rename keeps its slot, and only genuinely
 * new ids append. Rebuilding the list as "survivors then everything changed"
 * would make a renamed artifact jump to the bottom of its sidebar section until
 * the next `artifact` feed event happened to refetch and reorder it.
 *
 * There is no view scrub here any more (Task 9): `removeArtifact` now stages
 * every placement's `remove_artifact` op IN THE SAME BATCH as the
 * `delete_artifact`, so by the time this listener sees `deletedIds` the view
 * has already been scrubbed server-side, as part of the very commit that
 * dropped the artifact — see `removeArtifact`'s docstring (Decision 7).
 */
onArtifactCommit(({ changed, deletedIds }) => {
	const kept = _items
		.filter((a) => !deletedIds.includes(a.id))
		.map((a) => changed.find((h) => h.id === a.id) ?? a);
	_items = [...kept, ...changed.filter((h) => !kept.some((a) => a.id === h.id))];
});
