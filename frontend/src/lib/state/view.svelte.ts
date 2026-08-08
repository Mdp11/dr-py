/**
 * View store (artefacts revamp Phase 2).
 *
 * `_view` is the LOCAL working copy: server truth as of the last
 * `refreshView()`, with every staged `view.*` op already applied optimistically
 * on top (the `stage*` mutators below apply-then-stage in that order — see each
 * mutator's docstring). There is no more direct PUT path: every structural
 * change to the view goes out as a `ViewOp` in the `view-edits.svelte.ts`
 * journal and reaches the server only via `POST /commits` (checkout.svelte.ts's
 * `commitStaged`). The pre-Phase-2 whole-snapshot PUT wrapper is GONE — see
 * git history if you're looking for it.
 *
 * Every mutator follows the same three-phase shape: GUARD (client-side
 * precondition checks — name clash, cycle, no-op — so we never acquire a lease
 * for a doomed gesture; these duplicate `applyViewOp`'s own checks on purpose,
 * because `applyViewOp` throwing is the "something drifted" signal, not the
 * expected refusal path), then GATE (acquire the `folder:` lease(s) the op
 * needs — a `folderEditLock`/`folderCreateLock`/`folderDeleteLock` call, which
 * is notice-based and returns `false` on refusal, having already shown the
 * user why), then EMIT+APPLY+STAGE (build the `ViewOp`, apply it to `_view` via
 * `applyViewOp` for the optimistic update, then `stageViewOp` to queue it for
 * commit). A mutator returns `Promise<boolean>`: `true` means staged (or a
 * legitimate no-op), `false` means the gate refused and nothing changed.
 */
import * as viewApi from '$lib/api/view';
import type { ArtifactRef, Folder, Issue, View } from '$lib/api/types';
import {
	applyViewOp,
	artifactPlacementFolderIds,
	elementHomeFolderId,
	findFolderById,
	findFolderContainer,
	folderSubtreeIds,
	isFolderIdAncestor
} from './view-ops';
import { createTempId, VIEW_ROOT_ID, type ViewOp } from './ops';
import { folderCreateLock, folderDeleteLock, folderEditLock } from './edit-gate';
import { releaseFolderLeaseIfUnneeded } from './checkout.svelte';
import {
	discardStagedView,
	getStagedViewOps,
	onViewCommitted,
	onViewDiscarded,
	resetViewEdits,
	stageViewOp
} from './view-edits.svelte';
import { setLockNotice } from './lock-notice.svelte';
import { onCommitEvent } from './realtime.svelte';
import { getCachedElements } from './model.svelte';
import { elementDisplayName } from '$lib/util/element-name';

export { cloneView } from './view-ops';

let _view: View | null = $state(null);
let _warnings: Issue[] = $state([]);

/**
 * Whether the active project's view question has been ANSWERED this session
 * (loaded, or confirmed absent/failed). The containment tree must not paint
 * its first rows until this is true — painting with view=null and collapsing
 * later is the "flash of all elements" bug. Reset via markViewUnresolved()
 * at the top of boot() on every project (re)entry.
 */
let _viewResolved = $state(false);

export function isViewResolved(): boolean {
	return _viewResolved;
}

export function markViewUnresolved(): void {
	_viewResolved = false;
}

export function getView(): View | null {
	return _view;
}

export function getViewWarnings(): readonly Issue[] {
	return _warnings;
}

function setState(view: View | null, warnings: Issue[]): void {
	_view = view;
	_warnings = warnings;
}

export function clearViewState(): void {
	setState(null, []);
	resetViewEdits();
}

/**
 * Load the active view from the backend (app boot, or the post-commit /
 * post-discard reconciliation step — see the module-scope subscriptions at the
 * bottom of this file) and REBUILD `_view` as `server truth + staged journal`.
 *
 * The re-apply is the point. `folder:` leases are PER FOLDER, so two users
 * editing different folders concurrently is an explicitly supported scenario:
 * a peer's `view` commit fires the realtime tap below and refetches, and a
 * plain `setState(res.view, …)` would snap the sidebar back to server truth
 * while THIS client's journal still held its own ops — the tree would disagree
 * with what the user is about to commit, and the next mutator's guards would
 * run against the reverted tree and emit an op the server 422s. Replaying the
 * journal on top of the fresh blob keeps the two in step: `_view` is once again
 * exactly "what the server has, plus what I have staged".
 *
 * When a replayed op THROWS, the peer's change genuinely conflicts with what we
 * staged (the folder we renamed is gone, the element we moved was moved out
 * from under us, …). We then drop the WHOLE journal, not the offending op:
 * this is an ORDERED journal — `create_folder` then `place_element` into it
 * then `rename_folder` — so plucking one op out of the middle is unsound, and a
 * partially-replayed prefix is not a state the user ever asked for. The drop is
 * announced through the global lock notice (see below) and the journal's folder
 * leases are handed back.
 *
 * Both no-journal paths stay free: the own-commit path clears the journal
 * BEFORE notifying (checkout's `clearStagedView()` precedes
 * `notifyViewCommitted()`), and `discardStagedView` empties it before the
 * discard listener fires — in both, `getStagedViewOps()` is already empty here
 * and this is a plain `setState`.
 */
export async function refreshView(): Promise<void> {
	try {
		const res = await viewApi.getView();
		const staged = getStagedViewOps();
		let next = res.view;
		// A null `res.view` (the project has no view at all) with a non-empty
		// journal is the degenerate conflict: there is nothing left to replay
		// onto, so the staged ops are unsalvageable by definition.
		let conflicted = staged.length > 0 && next === null;
		if (next !== null) {
			try {
				for (const op of staged) next = applyViewOp(next, op);
			} catch {
				// All-or-nothing: fall back to bare server truth and drop the journal.
				next = res.view;
				conflicted = true;
			}
		}
		setState(next, res.warnings);
		// Guarded on its own: a throw escaping here would land in the OUTER catch
		// below, which nulls `_view` — turning a recoverable journal conflict into
		// a blank sidebar. The unwind is best-effort by construction anyway (the
		// journal is already gone by its first await).
		if (conflicted) await dropConflictedJournal().catch(() => {});
	} catch {
		setState(null, []);
	} finally {
		_viewResolved = true;
	}
}

/**
 * The unwind half of {@link refreshView}'s conflict case: wipe the journal and
 * release the folder leases it was holding, then tell the user.
 *
 * Uses the SILENT `resetViewEdits()` rather than `discardStagedView()` on
 * purpose — we are already inside a refetch, and the notifying wipe would
 * re-enter `refreshView` from its own listener.
 *
 * The notice goes out through `setLockNotice`, the global notice channel these
 * stores already share (edit-gate routes every lease refusal to it, and the
 * StatusBar renders it in warning colour). It is the right SURFACE — this is
 * exactly the "someone else got there first" family of message — but it is a
 * TRANSIENT line: the next successful gate clears it (`noticed()` in
 * edit-gate). That is a knowingly thin channel for a destructive event; a
 * dismissable banner alongside the conflict/rebind ones in the project page
 * would be better, and is deliberately left as a follow-up rather than a new
 * notice mechanism smuggled into a fix wave.
 */
async function dropConflictedJournal(): Promise<void> {
	const rids = stagedFolderLeaseIds();
	resetViewEdits();
	for (const id of rids) await releaseFolderLeaseIfUnneeded(id);
	setLockNotice(
		'The view changed while you were editing it — your unsaved folder changes were discarded.'
	);
}

// ----- id-addressed helpers shared by the mutators below -----

/** `folderId`'s child-folder list, or `undefined` when `folderId` names no
 * live folder. `VIEW_ROOT_ID` resolves to the view's own top-level list. */
function folderChildren(view: View, folderId: string): Folder[] | undefined {
	if (folderId === VIEW_ROOT_ID) return view.folders;
	return findFolderById(view, folderId)?.folders;
}

/** `folderId`'s artifact-ref list, or `undefined` when `folderId` names no
 * live folder. `VIEW_ROOT_ID` resolves to the view's own root list. */
function folderArtifacts(view: View, folderId: string): ArtifactRef[] | undefined {
	if (folderId === VIEW_ROOT_ID) return view.artifacts;
	return findFolderById(view, folderId)?.artifacts;
}

/** Display name for a lease-target/label: a real folder's name, or "the top
 * level" for `VIEW_ROOT_ID` (mirrors the tree's own "Move to top level"
 * copy — see ContainmentTree.svelte). Falls back to the raw id for a folder
 * that has already been popped out of `_view` by an earlier op in this same
 * mutator call (there is no live name left to show). */
function folderDisplayName(view: View, folderId: string): string {
	if (folderId === VIEW_ROOT_ID) return 'the top level';
	return findFolderById(view, folderId)?.name ?? folderId;
}

/** An element's display label for a staged-op entry: its `name` property when
 * the element is cached, else the raw id (uncached — the cache is populated
 * lazily by whatever view rendered it). */
function elLabel(id: string): string {
	const el = getCachedElements().get(id);
	return el ? elementDisplayName(el) : id;
}

/** Every element id placed anywhere within `folder`'s own subtree (itself plus
 * every descendant folder) — the excluded-pool injection payload for a staged
 * `delete_folder` (Task 1, artefacts-Phase-2 follow-ups). MUST be captured
 * from the live `_view` BEFORE the op pops the folder out: `applyViewOp`
 * detaches the folder (and its `elements`/`folders` lists with it) from the
 * tree, so this is unrecoverable afterwards — same shape as `label` capturing
 * a folder's prior name before a rename/delete. */
function subtreeElementIds(folder: Folder): string[] {
	const out: string[] = [...folder.elements];
	for (const sub of folder.folders) out.push(...subtreeElementIds(sub));
	return out;
}

// ----- STAGE mutators (artefacts revamp Phase 2) -----

export async function stageCreateFolder(parentId: string, name: string): Promise<boolean> {
	if (_view === null) throw new Error('No active view');
	const siblings = folderChildren(_view, parentId);
	if (siblings === undefined) throw new Error(`Folder not found: ${parentId}`);
	if (siblings.some((f) => f.name === name)) {
		throw new Error(`Folder "${name}" already exists at this level`);
	}
	if (!(await folderCreateLock(parentId))) return false; // gate showed the notice
	const tempId = createTempId();
	const label = `Created folder "${name}"`;
	const op: ViewOp = { kind: 'create_folder', temp_id: tempId, parent_id: parentId, name };
	_view = applyViewOp(_view, op); // optimistic; applyViewOp re-checks and throws on drift
	stageViewOp(op, label);
	return true;
}

export async function stageRenameFolder(id: string, name: string): Promise<boolean> {
	if (_view === null) throw new Error('No active view');
	const folder = findFolderById(_view, id);
	if (folder === null) throw new Error(`Folder not found: ${id}`);
	if (folder.name === name) return true; // no-op, stage nothing
	const container = findFolderContainer(_view, id);
	if (container?.siblings.some((f) => f.id !== id && f.name === name)) {
		throw new Error(`Folder "${name}" already exists at this level`);
	}
	if (!(await folderEditLock([id]))) return false; // gate showed the notice
	const label = `Renamed folder "${folder.name}" → "${name}"`;
	const op: ViewOp = { kind: 'rename_folder', id, name };
	_view = applyViewOp(_view, op); // optimistic; applyViewOp re-checks and throws on drift
	stageViewOp(op, label);
	return true;
}

export async function stageDeleteFolder(id: string): Promise<boolean> {
	if (_view === null) throw new Error('No active view');
	const folder = findFolderById(_view, id);
	if (folder === null) throw new Error(`Folder not found: ${id}`);
	const subtreeIds = folderSubtreeIds(_view, id);
	if (!(await folderDeleteLock(subtreeIds))) return false; // gate showed the notice
	const label = `Deleted folder "${folder.name}"`;
	const unplacedElementIds = subtreeElementIds(folder); // capture BEFORE the pop — see docstring
	const op: ViewOp = { kind: 'delete_folder', id };
	_view = applyViewOp(_view, op);
	stageViewOp(op, label, unplacedElementIds);
	return true;
}

/**
 * Reparent folder `id` under `toParentId` (`VIEW_ROOT_ID` for the top level).
 * Guards a cycle and a same-parent no-op BEFORE the destination name-clash
 * check (which needs `_view` as-is, not post-move). Locks the SOURCE
 * container and the destination as one gesture token — `folderEditLock`
 * dedups when they coincide.
 */
export async function stageMoveFolder(id: string, toParentId: string): Promise<boolean> {
	if (_view === null) throw new Error('No active view');
	const folder = findFolderById(_view, id);
	if (folder === null) throw new Error(`Folder not found: ${id}`);
	if (isFolderIdAncestor(_view, id, toParentId)) {
		throw new Error('Cannot move a folder into itself or a descendant');
	}
	const located = findFolderContainer(_view, id);
	if (located === null) throw new Error(`Folder not found: ${id}`);
	if (located.parentId === toParentId) return true; // no-op: already there, stage nothing
	const destSiblings = folderChildren(_view, toParentId);
	if (destSiblings === undefined) throw new Error(`Folder not found: ${toParentId}`);
	if (destSiblings.some((f) => f.name === folder.name)) {
		throw new Error(`Folder "${folder.name}" already exists at this level`);
	}
	if (!(await folderEditLock([located.parentId, toParentId]))) return false; // gate showed the notice
	const label = `Moved folder "${folder.name}" to "${folderDisplayName(_view, toParentId)}"`;
	const op: ViewOp = { kind: 'move_folder', id, to_parent_id: toParentId };
	_view = applyViewOp(_view, op);
	stageViewOp(op, label);
	return true;
}

/**
 * Batch element placement (drag-and-drop, multi-select include/exclude): move
 * every id in `ids` to `folderId` at `index`, or (`folderId === null`) exclude
 * every PLACED id (an already-unplaced id is skipped — nothing to exclude).
 *
 * `index` is where the FIRST id lands; omit it to APPEND (the `ViewOp`-level
 * sentinel — `applyViewOp`'s `clampIndex` reads `undefined` as "end of list",
 * mirroring `api/view_ops.py`'s `_clamped`, and an omitted key is what goes out
 * in the commit JSON). Never spell append as a huge literal index: the server
 * would clamp it, but the raw number would be journaled forever.
 *
 * Decision 11 index math: one op is emitted PER ID, applied locally between
 * emissions via `applyViewOp`, so each successive op's `index` reflects the
 * state the server will see replaying the batch in order. Two corrections ride
 * on a SAME-FOLDER reorder, and they are two halves of one fact:
 *
 *  - POST-POP position. If the id's current index is BELOW the cursor, popping
 *    it first shifts everything after it up by one, so the emitted index is
 *    `at - 1` to land in the visual slot the user dropped on. (`clampIndex` is
 *    a distinct out-of-range safety net — it does not replace this.)
 *  - CURSOR HOLD. That same pop already advanced the cursor for us: the slot
 *    the next id should take is still numbered `at`, so `at` must NOT be
 *    incremented after such an op. Incrementing unconditionally is an
 *    off-by-one that silently drops later ids of a multi-select one slot short
 *    — folder `[a,b,c,d]`, select `[a,d]`, drop at 2 yields `[b,a,c,d]` (d
 *    never moves) instead of `[b,a,d,c]`. Note the client mirror computes the
 *    same wrong answer as the server would, so the commit SUCCEEDS: the only
 *    symptom is a wrong result the user sees.
 *
 * Every other emission (a `place_element`, or a `move_element` from another
 * folder / from below the cursor) does consume a slot, so `at` advances by one.
 * An id that is skipped or excluded consumes nothing.
 *
 * Locking: ONE `folderEditLock` call up front, covering the destination (when
 * given) plus every DISTINCT home folder among the moving/excluded ids —
 * computed against `_view` as it stands before any op in this call applies.
 */
export async function stagePlaceElementsAt(
	folderId: string | null,
	ids: string[],
	index?: number
): Promise<boolean> {
	if (_view === null) throw new Error('No active view');
	// preserve given order, drop duplicates within the incoming selection
	const selection = ids.filter((id, i) => ids.indexOf(id) === i);
	// ephemeral bookkeeping for this one call, not reactive state
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const homes = new Map(selection.map((id) => [id, elementHomeFolderId(_view as View, id)]));
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const targets = new Set<string>();
	if (folderId !== null) targets.add(folderId);
	for (const home of homes.values()) if (home !== null) targets.add(home);
	if (folderId === null && targets.size === 0) return true; // nothing placed to remove
	if (!(await folderEditLock([...targets]))) return false; // gate showed the notice

	const destName = folderId === null ? null : folderDisplayName(_view, folderId);
	let at = index; // undefined = append; stays undefined for the whole batch
	for (const id of selection) {
		const home = homes.get(id) ?? null;
		// True when this id's op popped it from BEFORE the cursor in the SAME
		// folder — that pop already advanced the cursor, so `at` must hold.
		let cursorHeld = false;
		if (folderId === null) {
			if (home === null) continue; // already unplaced: no-op for this id
			const op: ViewOp = { kind: 'remove_element', element_id: id, folder_id: home };
			const label = `Removed ${elLabel(id)} from "${folderDisplayName(_view, home)}"`;
			_view = applyViewOp(_view, op);
			stageViewOp(op, label, [id]); // excluded-pool injection payload (Task 1)
			continue;
		}
		if (home === null) {
			const op: ViewOp = { kind: 'place_element', element_id: id, folder_id: folderId, index: at };
			_view = applyViewOp(_view, op);
			stageViewOp(op, `Placed ${elLabel(id)} in "${destName}"`);
		} else {
			let requestedIndex = at;
			if (home === folderId && at !== undefined) {
				const oldIndex = findFolderById(_view, folderId)!.elements.indexOf(id);
				if (oldIndex !== -1 && oldIndex < at) {
					requestedIndex = at - 1; // post-pop math
					cursorHeld = true; // …and the pop already advanced the cursor
				}
			}
			const op: ViewOp = {
				kind: 'move_element',
				element_id: id,
				from_folder_id: home,
				to_folder_id: folderId,
				index: requestedIndex
			};
			_view = applyViewOp(_view, op);
			stageViewOp(op, `Moved ${elLabel(id)} to "${destName}"`);
		}
		if (at !== undefined && !cursorHeld) at += 1;
	}
	return true;
}

/** Sugar for excluding one element from wherever it is placed. */
export async function stageRemoveElement(elementId: string): Promise<boolean> {
	return stagePlaceElementsAt(null, [elementId]);
}

/**
 * Place `ref` into `folderId` (`VIEW_ROOT_ID` legal — an artifact may sit at
 * the view root alongside top-level folders). A no-op if that folder already
 * holds it — an artifact may sit in several locations at once (unlike an
 * element).
 */
export async function stagePlaceArtifact(folderId: string, ref: ArtifactRef): Promise<boolean> {
	if (_view === null) throw new Error('No active view');
	if (artifactPlacementFolderIds(_view, ref.id).includes(folderId)) return true; // no-op: already there
	if (folderArtifacts(_view, folderId) === undefined) {
		throw new Error(`Folder not found: ${folderId}`);
	}
	if (!(await folderEditLock([folderId]))) return false; // gate showed the notice
	const label = `Placed artifact "${ref.id}" in "${folderDisplayName(_view, folderId)}"`;
	const op: ViewOp = {
		kind: 'place_artifact',
		artifact_id: ref.id,
		artifact_kind: ref.kind,
		folder_id: folderId
	};
	_view = applyViewOp(_view, op);
	stageViewOp(op, label);
	return true;
}

/**
 * Move an artifact from `fromFolderId` to `toFolderId` (removes only from the
 * source, not every location that holds it). A no-op when source and
 * destination are the same location.
 */
export async function stageMoveArtifact(
	fromFolderId: string,
	toFolderId: string,
	ref: ArtifactRef
): Promise<boolean> {
	if (_view === null) throw new Error('No active view');
	if (fromFolderId === toFolderId) return true; // no-op, stage nothing
	if (!(await folderEditLock([fromFolderId, toFolderId]))) return false; // gate showed the notice
	const label = `Moved artifact "${ref.id}" to "${folderDisplayName(_view, toFolderId)}"`;
	const op: ViewOp = {
		kind: 'move_artifact',
		artifact_id: ref.id,
		from_folder_id: fromFolderId,
		to_folder_id: toFolderId
	};
	_view = applyViewOp(_view, op);
	stageViewOp(op, label);
	return true;
}

/**
 * Remove an artifact from a single folder (unlike `removeArtifact` in
 * `artifacts.svelte.ts`, which deletes the artifact itself — this name stays
 * deliberately distinct to avoid colliding with that existing export).
 *
 * `displayName`, when given, labels the staged entry by name instead of the
 * raw id: `Removed placement of "<name>"` rather than `"<id>"`. The delete's
 * in-batch scrub (`removeArtifact`, Decision 7) passes the artifact's
 * COMMITTED header name, since it already looked one up to build the delete
 * entry itself. Every other caller — the sidebar row's own "remove from
 * folder" action — has no header handy and omits it, falling back to the id.
 */
export async function stageRemoveArtifactRef(
	folderId: string,
	artifactId: string,
	displayName?: string
): Promise<boolean> {
	if (_view === null) throw new Error('No active view');
	const container = folderArtifacts(_view, folderId);
	if (container === undefined) throw new Error(`Folder not found: ${folderId}`);
	if (!container.some((a) => a.id === artifactId)) {
		throw new Error(`artifact ${artifactId} is not placed in ${folderId}`);
	}
	if (!(await folderEditLock([folderId]))) return false; // gate showed the notice
	const label = `Removed placement of "${displayName ?? artifactId}" from "${folderDisplayName(_view, folderId)}"`;
	const op: ViewOp = { kind: 'remove_artifact', artifact_id: artifactId, folder_id: folderId };
	_view = applyViewOp(_view, op);
	stageViewOp(op, label);
	return true;
}

/**
 * Decision 3's delete-all batch: stage a `delete_folder` per top-level folder
 * (each cascades its own subtree — see `applyViewOp`) plus a `remove_artifact`
 * per root-level artifact ref. An empty view is a no-op — never stage an empty
 * batch's worth of nothing. ONE `folderDeleteLock` call covering every folder
 * id in the view (all subtrees) plus `VIEW_ROOT_ID`.
 */
export async function stageClearView(): Promise<boolean> {
	if (_view === null) throw new Error('No active view');
	if (_view.folders.length === 0 && _view.artifacts.length === 0) return true; // nothing to clear
	const allIds: string[] = [VIEW_ROOT_ID];
	for (const f of _view.folders) allIds.push(...folderSubtreeIds(_view, f.id));
	if (!(await folderDeleteLock(allIds))) return false; // gate showed the notice
	for (const f of [..._view.folders]) {
		const op: ViewOp = { kind: 'delete_folder', id: f.id };
		const unplacedElementIds = subtreeElementIds(f); // capture BEFORE the pop
		_view = applyViewOp(_view, op);
		stageViewOp(op, `Deleted folder "${f.name}"`, unplacedElementIds);
	}
	for (const ref of [..._view.artifacts]) {
		const op: ViewOp = { kind: 'remove_artifact', artifact_id: ref.id, folder_id: VIEW_ROOT_ID };
		_view = applyViewOp(_view, op);
		stageViewOp(op, `Removed artifact "${ref.id}" from "the top level"`);
	}
	return true;
}

/** Every folder id a `ViewOp` names as a LOCK TARGET (mirrors each `stage*`
 * mutator's own `folder*Lock` call sites above) — used by
 * {@link discardViewChanges} to know which leases to hand back. `move_folder`
 * contributes only `to_parent_id`: its SOURCE container shares the same
 * gesture token (see `checkout.svelte.ts`'s `lockedResourcesNeededBy`
 * docstring), so releasing the token via the destination id releases the
 * source with it — the moved folder's OWN id is never a lock target. */
function viewOpFolderIds(op: ViewOp): string[] {
	switch (op.kind) {
		case 'create_folder':
			return [op.parent_id];
		case 'rename_folder':
		case 'delete_folder':
			return [op.id];
		case 'move_folder':
			return [op.to_parent_id];
		case 'place_element':
		case 'remove_element':
		case 'place_artifact':
		case 'remove_artifact':
			return [op.folder_id];
		case 'move_element':
		case 'move_artifact':
			return [op.from_folder_id, op.to_folder_id];
	}
}

/** Every DISTINCT folder id the CURRENT journal holds a lease for — the set to
 * hand back when the journal goes away. Must be read BEFORE the journal is
 * wiped: once empty there is nothing left to walk. */
function stagedFolderLeaseIds(): Set<string> {
	// ephemeral bookkeeping for one call, not reactive state
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const rids = new Set<string>();
	for (const op of getStagedViewOps()) {
		for (const id of viewOpFolderIds(op)) rids.add(id);
	}
	return rids;
}

/**
 * User-discard path: wipe the staged view-op journal, hand back every folder
 * lease it needed (that is no longer needed by anything else — model/artifact
 * staged ops never name a `folder:` resource, so this is unconditional in
 * practice), and refetch server truth. The optimistic applies are already
 * baked into `_view`, so a refetch — not a local undo — is what restores it.
 *
 * That refetch is NOT issued here: `discardStagedView()` fires the discard
 * listener this module registers below, which is `refreshView`. Enforcing it
 * in the journal store rather than at this one call site is what stops the
 * OTHER discard surface (checkout's `discardAll`) from silently skipping it —
 * see `discardStagedView`'s docstring.
 */
export async function discardViewChanges(): Promise<void> {
	const rids = stagedFolderLeaseIds();
	await discardStagedView(); // empties the journal, then refetches via onViewDiscarded
	for (const id of rids) await releaseFolderLeaseIfUnneeded(id);
}

// Post-DISCARD reconciliation: registered EAGERLY, at module scope, unlike the
// two commit taps below. Those are deferred past a macrotask because they touch
// realtime.svelte.ts, which sits in a real import cycle with this module (see
// the long comment below); view-edits.svelte.ts imports nothing from here — it
// imports only the `ViewOp` TYPE from ops.ts — so it is fully evaluated before
// this module's body runs and there is no TDZ hazard to defer past. Eager also
// matters for correctness: `discardStagedView()` may be called synchronously in
// the same tick as module load (a test, or a discard on a freshly-booted page),
// and a listener still sitting in a pending setTimeout would miss it, silently
// reinstating the very bug this registration exists to prevent.
onViewDiscarded(() => refreshView());

// Post-commit reconciliation (spec Decision 6): a commit that carried view
// ops refetches server truth ONCE (concretizes tmp_ folder ids — no client
// id_map remap). Two subscriptions, both cheap:
//  - our own commit: view-edits' listener registry (fired by commitStaged);
//  - a peer's commit: the realtime tap, scope-gated.
// An own-commit may fire both (feed echo) — two GET /view of a small blob.
//
// Registered at MODULE SCOPE (the table-editor.svelte.ts:1689 precedent) but
// DEFERRED past a macrotask boundary, unlike that precedent — this module
// sits in a REAL three-hop cycle (view.svelte.ts -> realtime.svelte.ts ->
// artifacts.svelte.ts -> view.svelte.ts). Task 9 deleted the OLD last edge
// (`scrubArtifactFromView`, imported by artifacts.svelte.ts) but immediately
// recreated the SAME edge: `removeArtifact`'s in-batch delete scrub
// (Decision 7) imports `getView`/`stageRemoveArtifactRef` straight from THIS
// module. The cycle is therefore unchanged in shape — only which names cross
// the back-edge changed — so the deferral below still has to stay.
// table-editor's tap, by contrast, has no back-edge into realtime.svelte.ts
// at all. A hoisted FUNCTION declaration (`onCommitEvent` itself) is safely
// callable at any point in a cycle, but `realtime.svelte.ts`'s
// `const _commitTaps` it reads is not hoisted — if some OTHER import graph
// happens to reach realtime.svelte.ts first (before view.svelte.ts), resolving
// that cycle re-enters this module's top level from INSIDE realtime's own
// import of artifacts.svelte, i.e. before realtime's
// `const _commitTaps = new Set()` line has run,
// throwing a TDZ ReferenceError (reproduced by edit-gate.test.ts, whose
// import graph happens to hit that ordering). `queueMicrotask` alone is NOT
// enough — a dynamic `import()` elsewhere in the same worker (vitest module
// caching) can still interleave the cycle's remaining evaluation across a
// microtask boundary, reproducing the same TDZ inside the deferred callback.
// `setTimeout(…, 0)` waits for a macrotask instead, by which point the
// entire synchronous+microtask module-evaluation graph — cycle included —
// has unconditionally settled. Nothing can fire a real commit event within
// the first tick of module load, so the delay is free in practice.
setTimeout(() => {
	onViewCommitted(() => void refreshView());
	onCommitEvent(({ scope }) => {
		if (scope.includes('view')) void refreshView();
	});
}, 0);
