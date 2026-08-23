import type { ArtifactRef, Folder, View } from '$lib/api/types';
import { VIEW_ROOT_ID, type ViewOp } from './ops';

// ----- pure view-structure helpers -----
//
// These live in a plain `.ts` module (no Svelte runes) so they can be unit
// tested directly. The `view.svelte.ts` mutators are thin wrappers that clone,
// apply one of these transforms, and push the result to the backend.
//
// MIRROR FIDELITY: `applyViewOp` below is the client
// twin of the backend's `apply_view_ops` (`api/view_ops.py`, ~:198-470). The
// backend session is the source of truth (CLAUDE.md), but the client stages
// ops optimistically before a commit round-trips, so `applyViewOp` must
// compute EXACTLY what the server will compute replaying the same op —
// same branch order, same index-clamping arithmetic, same error conditions —
// or optimistic local state and server state permanently disagree after a
// commit. Every branch below cites the backend lines it mirrors; when the
// backend applier changes, this module (and its tests) must change with it.
// Two backend behaviors worth flagging up front because they are easy to
// get backwards: (1) `move_element`/`move_folder` resolve/pop the SOURCE
// first, then clamp the destination index against the POST-POP length — a
// same-container reorder clamps against `length - 1` slots, not `length`;
// (2) restore-mode tolerance (duplicate-placement checks skipped during
// undo replay) is a SERVER-ONLY concept — the client never applies in
// restore mode, so every `applyViewOp` branch enforces the strict
// (non-restore) checks unconditionally.

export function cloneFolder(f: Folder): Folder {
	return {
		id: f.id,
		name: f.name,
		folders: f.folders.map(cloneFolder),
		elements: [...f.elements],
		artifacts: f.artifacts.map((a) => ({ ...a }))
	};
}

export function cloneView(v: View): View {
	return {
		name: v.name,
		folders: v.folders.map(cloneFolder),
		// `?? []` guards a snapshot that lacks the field (the zod
		// default already fills it on parse, but this keeps the clone safe even
		// for a hand-built object bypassing the schema).
		artifacts: (v.artifacts ?? []).map((a) => ({ ...a }))
	};
}

// ----- id-addressed helpers -----
//
// Folders carry a stable uuid id (`Folder.id`, healed server-side by
// `core/view/ids.ensure_folder_ids`); these helpers address by id instead of
// by name-path, mirroring `core/view/ids.py`'s `find_folder`/`locate_folder`/
// `folder_subtree`. `view.svelte.ts` and the containment tree address folders
// through these.

/** Depth-first search for the folder with `id`, or `null` if unknown. Client
 * twin of `core/view/ids.find_folder`. */
export function findFolderById(view: View, id: string): Folder | null {
	const walk = (folders: Folder[]): Folder | null => {
		for (const f of folders) {
			if (f.id === id) return f;
			const hit = walk(f.folders);
			if (hit !== null) return hit;
		}
		return null;
	};
	return walk(view.folders);
}

/**
 * The sibling list holding `id` plus its parent's id (`VIEW_ROOT_ID` for a
 * top-level folder). `null` when `id` is unknown or IS the root sentinel —
 * the root is not a folder and has no container. Client twin of
 * `core/view/ids.locate_folder`.
 */
export function findFolderContainer(
	view: View,
	id: string
): { siblings: Folder[]; parentId: string } | null {
	const walk = (
		siblings: Folder[],
		parentId: string
	): { siblings: Folder[]; parentId: string } | null => {
		for (const f of siblings) {
			if (f.id === id) return { siblings, parentId };
			const hit = walk(f.folders, f.id);
			if (hit !== null) return hit;
		}
		return null;
	};
	return walk(view.folders, VIEW_ROOT_ID);
}

/** `id` followed by every descendant folder id, depth-first. Empty when `id`
 * is unknown. Client twin of `core/view/ids.folder_subtree`. */
export function folderSubtreeIds(view: View, id: string): string[] {
	const root = findFolderById(view, id);
	if (root === null) return [];
	const out: string[] = [];
	const walk = (f: Folder): void => {
		out.push(f.id);
		for (const c of f.folders) walk(c);
	};
	walk(root);
	return out;
}

/** True when `folderId` is `ancestorId` itself or sits anywhere below it in
 * the folder tree — the move-cycle check (client twin of the backend's
 * `_subtree_ids` membership test in `move_folder`, ~view_ops.py:280). */
export function isFolderIdAncestor(view: View, ancestorId: string, folderId: string): boolean {
	return folderSubtreeIds(view, ancestorId).includes(folderId);
}

/** The folder holding `elementId`'s placement, or `null` if unplaced
 * (single-folder rule: an element sits in at most one folder). Client twin
 * of `_element_home` (view_ops.py:148). */
export function elementHomeFolderId(view: View, elementId: string): string | null {
	const walk = (folders: Folder[]): string | null => {
		for (const f of folders) {
			if (f.elements.includes(elementId)) return f.id;
			const hit = walk(f.folders);
			if (hit !== null) return hit;
		}
		return null;
	};
	return walk(view.folders);
}

/** Every folder id (plus `VIEW_ROOT_ID` when the root artifact list holds
 * it) that places `artifactId` — an artifact may sit in several locations at
 * once, unlike an element. */
export function artifactPlacementFolderIds(view: View, artifactId: string): string[] {
	const out: string[] = [];
	if (view.artifacts.some((a) => a.id === artifactId)) out.push(VIEW_ROOT_ID);
	const walk = (folders: Folder[]): void => {
		for (const f of folders) {
			if (f.artifacts.some((a) => a.id === artifactId)) out.push(f.id);
			walk(f.folders);
		}
	};
	walk(view.folders);
	return out;
}

/** The `{folders, artifacts}` lists addressed by a folder id, with
 * `VIEW_ROOT_ID` resolving to the view's own root lists — the client twin of
 * `api/view_ops.py`'s `_container`. Throws (mirroring the backend's 422)
 * when the id names no live folder. */
function containerOf(
	next: View,
	folderId: string
): { folders: Folder[]; artifacts: ArtifactRef[] } {
	if (folderId === VIEW_ROOT_ID) return { folders: next.folders, artifacts: next.artifacts };
	const f = findFolderById(next, folderId);
	if (f === null) throw new Error(`Folder not found: ${folderId}`);
	return f;
}

/** `op.index ?? length`, clamped to `[0, length]` — client twin of
 * `api/view_ops.py`'s `_clamped`. */
function clampIndex(index: number | undefined, length: number): number {
	if (index === undefined) return length;
	return Math.max(0, Math.min(index, length));
}

/**
 * Apply one `ViewOp` to `view`, returning a new `View` (clone-and-apply; the
 * input is never mutated — every branch operates on a fresh `cloneView`, and
 * a thrown branch simply discards that scratch clone). Throws `Error` for
 * every condition the backend's `apply_view_ops` 422s on (see this module's
 * header docstring for the mirror-fidelity contract, and each branch below
 * for the specific backend lines it reproduces).
 *
 * The client never operates in the backend's "restore" mode (that only
 * happens during server-side undo replay), so every branch enforces the
 * strict, non-restore checks unconditionally.
 */
export function applyViewOp(view: View, op: ViewOp): View {
	const next = cloneView(view);
	switch (op.kind) {
		case 'create_folder': {
			// mirrors view_ops.py:236-264 (temp_id kept literally — no
			// client-side uuid minting; the commit response's id_map carries
			// the canonical id, applied by a later remap pass, not here).
			const container = containerOf(next, op.parent_id).folders;
			if (container.some((f) => f.name === op.name)) {
				throw new Error(`Folder "${op.name}" already exists at this level`);
			}
			const index = clampIndex(op.index, container.length);
			container.splice(index, 0, {
				id: op.temp_id,
				name: op.name,
				folders: [],
				elements: [],
				artifacts: []
			});
			break;
		}
		case 'rename_folder': {
			// mirrors view_ops.py:265-271, plus a sibling name-clash guard the
			// backend's applier doesn't (yet) enforce — see this module's
			// header docstring / task report for the discrepancy.
			const located = findFolderContainer(next, op.id);
			if (located === null) throw new Error(`Folder not found: ${op.id}`);
			if (located.siblings.some((f) => f.id !== op.id && f.name === op.name)) {
				throw new Error(`Folder "${op.name}" already exists at this level`);
			}
			const folder = located.siblings.find((f) => f.id === op.id)!;
			folder.name = op.name;
			break;
		}
		case 'move_folder': {
			// mirrors view_ops.py:272-307's locate -> cycle-check -> pop ->
			// resolve-dest -> clamp -> insert order (plus the same sibling
			// name-clash guard added above).
			const folder = findFolderById(next, op.id);
			if (folder === null) throw new Error(`Folder not found: ${op.id}`);
			if (isFolderIdAncestor(next, op.id, op.to_parent_id)) {
				throw new Error('Cannot move a folder into itself or a descendant');
			}
			const located = findFolderContainer(next, op.id)!;
			const oldIndex = located.siblings.findIndex((f) => f.id === op.id);
			located.siblings.splice(oldIndex, 1);
			const dest = containerOf(next, op.to_parent_id).folders;
			if (dest.some((f) => f.name === folder.name)) {
				throw new Error(`Folder "${folder.name}" already exists at this level`);
			}
			const index = clampIndex(op.index, dest.length);
			dest.splice(index, 0, folder);
			break;
		}
		case 'delete_folder': {
			// mirrors view_ops.py:308-319 — the whole subtree goes with it,
			// since it's still attached to the popped folder object.
			const located = findFolderContainer(next, op.id);
			if (located === null) throw new Error(`Folder not found: ${op.id}`);
			const index = located.siblings.findIndex((f) => f.id === op.id);
			located.siblings.splice(index, 1);
			break;
		}
		case 'place_element': {
			// mirrors view_ops.py:320-355.
			if (op.folder_id === VIEW_ROOT_ID) {
				throw new Error(
					'cannot place an element at the view root; an unplaced element already renders there (use remove_element)'
				);
			}
			const folder = findFolderById(next, op.folder_id);
			if (folder === null) throw new Error(`Folder not found: ${op.folder_id}`);
			const home = elementHomeFolderId(next, op.element_id);
			if (home !== null) {
				throw new Error(
					`element ${op.element_id} is already placed in folder ${home} (use move_element)`
				);
			}
			const index = clampIndex(op.index, folder.elements.length);
			folder.elements.splice(index, 0, op.element_id);
			break;
		}
		case 'remove_element': {
			// mirrors view_ops.py:356-377.
			const folder = findFolderById(next, op.folder_id);
			if (folder === null) throw new Error(`Folder not found: ${op.folder_id}`);
			if (!folder.elements.includes(op.element_id)) {
				throw new Error(`element ${op.element_id} is not placed in folder ${folder.id}`);
			}
			folder.elements = folder.elements.filter((e) => e !== op.element_id);
			break;
		}
		case 'move_element': {
			// mirrors view_ops.py:378-408: pop from source THEN clamp against
			// the post-pop destination length (from===to is a legal reorder —
			// src and dst alias the same array in that case, so the pop is
			// already reflected in the clamp).
			const src = findFolderById(next, op.from_folder_id);
			if (src === null) throw new Error(`Folder not found: ${op.from_folder_id}`);
			const dst = findFolderById(next, op.to_folder_id);
			if (dst === null) throw new Error(`Folder not found: ${op.to_folder_id}`);
			const oldIndex = src.elements.indexOf(op.element_id);
			if (oldIndex < 0) {
				throw new Error(`element ${op.element_id} is not placed in folder ${src.id}`);
			}
			src.elements.splice(oldIndex, 1);
			const index = clampIndex(op.index, dst.elements.length);
			dst.elements.splice(index, 0, op.element_id);
			break;
		}
		case 'place_artifact': {
			// mirrors view_ops.py:409-438 (container may be root).
			const container = containerOf(next, op.folder_id);
			if (container.artifacts.some((a) => a.id === op.artifact_id)) {
				throw new Error(`artifact ${op.artifact_id} is already placed in ${op.folder_id}`);
			}
			const index = clampIndex(op.index, container.artifacts.length);
			container.artifacts.splice(index, 0, { id: op.artifact_id, kind: op.artifact_kind });
			break;
		}
		case 'remove_artifact': {
			// mirrors view_ops.py:439-470.
			const container = containerOf(next, op.folder_id);
			const index = container.artifacts.findIndex((a) => a.id === op.artifact_id);
			if (index < 0) {
				throw new Error(`artifact ${op.artifact_id} is not placed in ${op.folder_id}`);
			}
			container.artifacts.splice(index, 1);
			break;
		}
		case 'move_artifact': {
			// mirrors view_ops.py:471-515.
			const srcContainer = containerOf(next, op.from_folder_id);
			const dstContainer = containerOf(next, op.to_folder_id);
			const pos = srcContainer.artifacts.findIndex((a) => a.id === op.artifact_id);
			if (pos < 0) {
				throw new Error(`artifact ${op.artifact_id} is not placed in ${op.from_folder_id}`);
			}
			// Same-container detection must compare the underlying `artifacts`
			// ARRAY reference, not the `containerOf` wrapper object: for a root
			// target `containerOf` allocates a fresh `{folders, artifacts}`
			// literal on every call (it has no folder object to return), so two
			// root resolutions are `!==` as wrappers even though both point at
			// the SAME `next.artifacts` array. A folder target returns the
			// folder object itself, so its identity (and its `.artifacts`
			// array's identity) is already stable across calls. Comparing
			// `.artifacts` arrays is therefore the one check that holds for
			// both cases and faithfully mirrors the backend's `src_c is not
			// dst_c` (view_ops.py:485), where `_container` returns the literal
			// `View` object both times for root.
			if (
				srcContainer.artifacts !== dstContainer.artifacts &&
				dstContainer.artifacts.some((a) => a.id === op.artifact_id)
			) {
				throw new Error(`artifact ${op.artifact_id} is already placed in ${op.to_folder_id}`);
			}
			const [ref] = srcContainer.artifacts.splice(pos, 1);
			const index = clampIndex(op.index, dstContainer.artifacts.length);
			dstContainer.artifacts.splice(index, 0, ref);
			break;
		}
		default: {
			const exhaustive: never = op;
			throw new Error(`Unknown view op: ${JSON.stringify(exhaustive)}`);
		}
	}
	return next;
}
