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
	resetViewEdits,
	stageViewOp
} from './view-edits.svelte';
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

/** Load the active view from the backend (e.g. on app boot, or as the
 * post-commit/post-discard reconciliation step — see the module-scope
 * subscriptions at the bottom of this file). */
export async function refreshView(): Promise<void> {
	try {
		const res = await viewApi.getView();
		setState(res.view, res.warnings);
	} catch {
		setState(null, []);
	} finally {
		_viewResolved = true;
	}
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
	const op: ViewOp = { kind: 'delete_folder', id };
	_view = applyViewOp(_view, op);
	stageViewOp(op, label);
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
 * Decision 11 index math: one op is emitted PER ID, applied locally between
 * emissions via `applyViewOp`, so each successive op's `index` reflects the
 * state the server will see replaying the batch in order. A same-folder
 * reorder additionally needs the POST-POP position: if the id's current index
 * is BELOW the requested index, popping it first shifts everything after it
 * up by one, so the requested index must be decremented by one to land in the
 * same visual slot the user dropped on (`applyViewOp`'s own `clampIndex` is a
 * distinct, out-of-range safety net — it does not replace this translation).
 * Successive ids in the selection insert at `index`, `index + 1`, `index + 2`,
 * … (an id that is skipped or excluded does not consume a slot).
 *
 * Locking: ONE `folderEditLock` call up front, covering the destination (when
 * given) plus every DISTINCT home folder among the moving/excluded ids —
 * computed against `_view` as it stands before any op in this call applies.
 */
export async function stagePlaceElementsAt(
	folderId: string | null,
	ids: string[],
	index: number
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
	let at = index;
	for (const id of selection) {
		const home = homes.get(id) ?? null;
		if (folderId === null) {
			if (home === null) continue; // already unplaced: no-op for this id
			const op: ViewOp = { kind: 'remove_element', element_id: id, folder_id: home };
			const label = `Removed ${elLabel(id)} from "${folderDisplayName(_view, home)}"`;
			_view = applyViewOp(_view, op);
			stageViewOp(op, label);
			continue;
		}
		if (home === null) {
			const op: ViewOp = { kind: 'place_element', element_id: id, folder_id: folderId, index: at };
			_view = applyViewOp(_view, op);
			stageViewOp(op, `Placed ${elLabel(id)} in "${destName}"`);
		} else {
			let requestedIndex = at;
			if (home === folderId) {
				const oldIndex = findFolderById(_view, folderId)!.elements.indexOf(id);
				if (oldIndex !== -1 && oldIndex < at) requestedIndex = at - 1; // post-pop math
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
		at += 1;
	}
	return true;
}

/** Sugar for excluding one element from wherever it is placed. */
export async function stageRemoveElement(elementId: string): Promise<boolean> {
	return stagePlaceElementsAt(null, [elementId], 0);
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
		_view = applyViewOp(_view, op);
		stageViewOp(op, `Deleted folder "${f.name}"`);
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

/**
 * User-discard path: wipe the staged view-op journal, hand back every folder
 * lease it needed (that is no longer needed by anything else — model/artifact
 * staged ops never name a `folder:` resource, so this is unconditional in
 * practice), then refetch server truth. The optimistic applies are already
 * baked into `_view`, so `refreshView()` — not a local undo — is what restores
 * it.
 *
 * `rids` is captured BEFORE `discardStagedView()` empties the journal: once
 * empty, there is nothing left to walk for folder ids.
 */
export async function discardViewChanges(): Promise<void> {
	// ephemeral bookkeeping for this one call, not reactive state
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const rids = new Set<string>();
	for (const op of getStagedViewOps()) {
		for (const id of viewOpFolderIds(op)) rids.add(id);
	}
	discardStagedView();
	for (const id of rids) await releaseFolderLeaseIfUnneeded(id);
	await refreshView();
}

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
