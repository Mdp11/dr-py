import type { ArtifactRef, Element, Folder, View } from '$lib/api/types';
import { isFolderIdAncestor } from '../../state/view-ops';

const NUL = ' ';

/**
 * Stable key for a folder node in the unified tree. The leading NUL byte is
 * not a legal character in a JSON-derived element id, so element and folder
 * key spaces never collide (an id can never start with NUL either — this
 * holds for a folder's own uuid id just as much as it did for a name-path).
 *
 * Phase 2: keyed by the folder's stable `id`, not its name-path. This is the
 * whole point of the id-addressing migration — a folder's key no longer
 * changes when the folder (or an ancestor) is renamed, so collapse/expand
 * state, focus, and drag hover survive a rename untouched.
 */
export const FOLDER_KEY_PREFIX = NUL + 'F' + NUL;

export function folderKey(id: string): string {
	return FOLDER_KEY_PREFIX + id;
}

export function isFolderKey(key: string): boolean {
	return key.startsWith(FOLDER_KEY_PREFIX);
}

/**
 * Sentinel key for the "Not in view" excluded-pool section header. Starts with
 * NUL so it can never collide with an element id, and is distinct from any
 * folder key (which start with FOLDER_KEY_PREFIX) and from VIEW_ROOT_DROP_KEY.
 */
export const EXCLUDED_SECTION_KEY = NUL + 'X' + NUL;

export function isExcludedSectionKey(key: string): boolean {
	return key === EXCLUDED_SECTION_KEY;
}

/** Strip a folder node key back down to its bare folder id. Throws on a
 * non-folder key (mirrors the pre-Phase-2 path-keyed helper's contract). */
export function folderIdFromKey(key: string): string {
	if (!isFolderKey(key)) throw new Error(`Not a folder key: ${key}`);
	return key.slice(FOLDER_KEY_PREFIX.length);
}

/**
 * Stable key for an artifact node in the unified tree. Same NUL-fenced idiom as
 * `folderKey`: the prefix can never collide with an element id (elements never
 * start with NUL) or a folder key (distinct letter tag).
 */
export const ARTIFACT_KEY_PREFIX = NUL + 'A' + NUL;

export function artifactKey(id: string): string {
	return ARTIFACT_KEY_PREFIX + id;
}

export function isArtifactKey(key: string): boolean {
	return key.startsWith(ARTIFACT_KEY_PREFIX);
}

export function artifactIdFromKey(key: string): string {
	if (!isArtifactKey(key)) throw new Error(`Not an artifact key: ${key}`);
	return key.slice(ARTIFACT_KEY_PREFIX.length);
}

export type NodeKind = 'element' | 'folder' | 'artifact';

export interface UnifiedTree {
	/** Ordered list of root-level keys (top-level folder keys and unplaced root element ids). */
	roots: string[];
	/** Excluded-pool roots ("Not in view"): rendered in a separate panel, NOT in `roots`. */
	excludedRoots: string[];
	/** For each node key, the ordered list of child keys to render under it. */
	children: Map<string, string[]>;
	/** For each node key, whether it is an element, a folder, or an artifact. */
	kind: Map<string, NodeKind>;
	/** Display label for folder nodes (folders only; elements are looked up via element map). */
	folderName: Map<string, string>;
	/** For each folder node key, its full display path (ancestor names + own
	 * name) — PICKER LABELS ONLY. Never used for addressing: every mutation
	 * path goes through the folder's `id`, never through this. */
	folderPathNames: Map<string, string[]>;
	/** All element ids that are placed inside any folder. */
	placedElementIds: Set<string>;
	/** For each artifact node key, the placed ref (id + kind). */
	artifactRef: Map<string, ArtifactRef>;
}

interface ModelView {
	elementsById: Map<string, Element>;
	containmentChildren: Map<string, string[]>;
	containedIds: Set<string>;
	/** Ids the server has confirmed do not exist (omitted from a by-id batch
	 * fetch). Placements pointing at these are dropped; a merely-unfetched id is
	 * NOT in here and is kept as a skeleton row. */
	missingElementIds: ReadonlySet<string>;
	displayName: (el: Element) => string;
}

function ingestFolder(
	folder: Folder,
	parentNames: string[],
	mv: ModelView,
	out: UnifiedTree,
	seenSiblingNames: Set<string>,
	placementOwner: Map<string, string>
): string | null {
	if (seenSiblingNames.has(folder.name)) return null; // duplicate sibling — skip
	seenSiblingNames.add(folder.name);

	const names = [...parentNames, folder.name];
	const key = folderKey(folder.id);
	out.kind.set(key, 'folder');
	out.folderName.set(key, folder.name);
	out.folderPathNames.set(key, names);

	const childKeys: string[] = [];

	const subSeen = new Set<string>();
	const sortedSubfolders = [...folder.folders].sort((a, b) => a.name.localeCompare(b.name));
	for (const sub of sortedSubfolders) {
		const subKey = ingestFolder(sub, names, mv, out, subSeen, placementOwner);
		if (subKey !== null) childKeys.push(subKey);
	}

	const placedElements: string[] = [];
	for (const eid of folder.elements) {
		// NOTE: do NOT gate on `elementsById.has(eid)`. A placed id whose body is
		// not yet in the local cache is the common case (the cache holds only the
		// fetched subset of an ~80 MB model); skipping it made folder rows stream
		// in one-by-one as the global containment-roots page seeded their bodies in
		// display-name order, inserting elements mid-folder and across folders. We
		// instead emit every placement in `folder.elements` order; an uncached id
		// renders as a skeleton until the windowed body fetch hydrates it in place.
		if (mv.missingElementIds.has(eid)) continue; // server-confirmed missing — drop
		if (mv.containedIds.has(eid)) continue; // contained elsewhere — warning only
		if (placementOwner.has(eid)) continue; // multi-placement — first wins
		placementOwner.set(eid, key);
		placedElements.push(eid);
		out.placedElementIds.add(eid);
		// Register an unfetched placement as an empty element node so the windowed
		// renderer shows a skeleton row and computeVisibility treats it as a
		// tentatively-visible element (mirrors registerExcludedRoots). A later
		// build with the body cached overwrites kind/children from the seed loop.
		if (!out.kind.has(eid)) out.kind.set(eid, 'element');
		if (!out.children.has(eid)) out.children.set(eid, []);
	}
	childKeys.push(...placedElements); // user placement order — no name-sort

	// Artifact nodes: leaf rows (no expand caret, no further children), appended
	// after elements so a folder's row order is subfolders, then elements, then
	// artifacts. Dangling refs (unknown artifact id) are NOT filtered here — the
	// artifact library is reactive UI state, not part of the model/view topology
	// this pure builder consumes; the render layer skips the row instead.
	for (const ref of folder.artifacts) {
		const artKey = artifactKey(ref.id);
		childKeys.push(artKey);
		out.kind.set(artKey, 'artifact');
		out.artifactRef.set(artKey, ref);
	}

	out.children.set(key, childKeys);
	return key;
}

/**
 * Build a unified tree of folders and elements suitable for sidebar rendering.
 *
 * When `view` is null, the tree is just the containment hierarchy (today's
 * behaviour). When a view is supplied, the top level is the view's folders
 * only (curated scope): root-level elements not placed in a folder are NOT
 * interleaved here — they belong to the separate "excluded pool" section
 * rendered by ContainmentTree. `rootElements` is therefore used only by the
 * no-view branch.
 *
 * In-folder order follows `folder.elements` (the user's placement order) and is
 * not name-sorted; subfolders are name-sorted here. No-view roots are rendered
 * in the order given (the backend already emits them display-name sorted), so a
 * paged client never re-sorts an accumulated prefix.
 */
export function buildUnifiedTree(
	view: View | null,
	rootElements: string[],
	elementsById: Map<string, Element>,
	containmentChildren: Map<string, string[]>,
	containedIds: Set<string>,
	displayName: (el: Element) => string,
	missingElementIds: ReadonlySet<string> = new Set()
): UnifiedTree {
	const out: UnifiedTree = {
		roots: [],
		excludedRoots: [],
		children: new Map(),
		kind: new Map(),
		folderName: new Map(),
		folderPathNames: new Map(),
		placedElementIds: new Set(),
		artifactRef: new Map()
	};

	// Element nodes: their children are always their containment subtree.
	for (const [eid, kids] of containmentChildren) {
		out.children.set(eid, [...kids]);
		out.kind.set(eid, 'element');
	}
	for (const eid of elementsById.keys()) {
		if (!out.kind.has(eid)) out.kind.set(eid, 'element');
		if (!out.children.has(eid)) out.children.set(eid, []);
	}

	const mv: ModelView = {
		elementsById,
		containmentChildren,
		containedIds,
		missingElementIds,
		displayName
	};

	if (view !== null) {
		const placementOwner = new Map<string, string>();
		const topSeen = new Set<string>();
		const topFolderKeys: string[] = [];
		const sortedTop = [...view.folders].sort((a, b) => a.name.localeCompare(b.name));
		for (const f of sortedTop) {
			const fkey = ingestFolder(f, [], mv, out, topSeen, placementOwner);
			if (fkey !== null) topFolderKeys.push(fkey);
		}
		// Root-level artifacts sit alongside the top-level folders. Mirrors the
		// `folder.artifacts` handling in `ingestFolder` above; `?? []` guards a
		// pre-Task-10 view snapshot that lacks the field.
		const rootArtifactKeys: string[] = [];
		for (const ref of view.artifacts ?? []) {
			const artKey = artifactKey(ref.id);
			rootArtifactKeys.push(artKey);
			out.kind.set(artKey, 'artifact');
			out.artifactRef.set(artKey, ref);
		}
		// Curated scope: the in-view region is folders (then root artifacts) only.
		// Model roots that are not placed in a folder belong to the excluded pool,
		// which is rendered as a separate section (see ContainmentTree), not
		// interleaved here.
		out.roots = [...topFolderKeys, ...rootArtifactKeys];
	} else {
		// Roots already arrive in display-name order from the backend
		// (list_containment_roots); render them as-is rather than re-sorting the
		// accumulated prefix, so scroll auto-load only ever APPENDS the next page
		// and rows above the viewport never reshuffle (no visible jump).
		out.roots = [...rootElements];
	}

	return out;
}

/**
 * Register the "Not in view" excluded-pool roots on a built tree. `excludedRootIds`
 * are the loaded complement roots (backend order, COMMITTED truth only — see
 * `GET /model/containment/roots/excluded`). Ids already placed in a folder
 * are dropped (defensive — the complement endpoint already excludes them). Unloaded
 * ids are registered as empty element nodes so the windowed renderer can show
 * skeleton rows until `ensureElements` fills the body. The pool is exposed as
 * `tree.excludedRoots` (a SEPARATE region) and is deliberately NOT added to
 * `tree.roots`, so it renders in its own panel rather than inside the tree.
 * Mutates `tree` in place (consistent with how buildUnifiedTree seeds).
 *
 * Excluded-pool injection (Task 1, artefacts-Phase-2 follow-ups): `excludedRootIds`
 * reflects the last COMMITTED view only, so an element the staged journal has
 * since unplaced (a `remove_element` op, or a placement whose containing folder
 * was staged-deleted) sits in NEITHER region until commit/discard — the committed
 * endpoint doesn't know about it yet, and it's no longer in any folder of the
 * (already-staged) `view` fed to `buildUnifiedTree` either. That reads as data
 * loss, so `stagedRemovedIds` (the caller's collected staged-unplace payload —
 * see `view-edits.svelte.ts`'s `StagedViewEntry.unplacedElementIds`) is mirrored
 * into the pool here, subject to the SAME two membership rules the committed
 * endpoint itself enforces:
 *  - still unplaced: `tree.placedElementIds` reflects the CURRENT staged view,
 *    so an id staging re-placed elsewhere afterwards is already excluded by
 *    that check — no separate "was it re-placed" bookkeeping needed.
 *  - containment ROOT only (mirrors the endpoint's `idx.iter_roots()` filter):
 *    `containedIds` is the same "known to be a containment child" set already
 *    threaded through `buildUnifiedTree`; an id in it must never mint a bogus
 *    pool root, even though staging unplaced it (the "contained elsewhere"
 *    case `ingestFolder` already treats as a warning, not a hard error). Like
 *    the rest of this module's containment knowledge, this is best-effort over
 *    the currently-FETCHED subset, not a full-model guarantee — consistent
 *    with `computeVisibility`'s "unloaded body -> tentatively visible" stance.
 * A `stagedRemovedIds` entry already present via `excludedRootIds` is not
 * duplicated.
 */
export function registerExcludedRoots(
	tree: UnifiedTree,
	excludedRootIds: string[],
	stagedRemovedIds: Iterable<string> = [],
	containedIds: ReadonlySet<string> = new Set()
): void {
	const kids = excludedRootIds.filter((id) => !tree.placedElementIds.has(id));
	const seen = new Set(kids);
	for (const id of stagedRemovedIds) {
		if (seen.has(id)) continue; // already surfaced via the committed pool
		if (tree.placedElementIds.has(id)) continue; // re-placed elsewhere: not injected
		if (containedIds.has(id)) continue; // non-root: never a pool row
		seen.add(id);
		kids.push(id);
	}
	for (const id of kids) {
		if (!tree.kind.has(id)) tree.kind.set(id, 'element');
		if (!tree.children.has(id)) tree.children.set(id, []);
	}
	tree.excludedRoots = kids;
}

export type Visibility = 'full' | 'stub' | 'hidden';

/**
 * Compute visibility per node given the active element type filter.
 *
 * Rules (mirrors the view-filter decision):
 * - element node: `full` if it (or any containment descendant) matches; else `hidden`
 * - folder node: `full` if any descendant matches; else `stub` (folders are
 *   never hidden — empty branches collapse to an empty leaf, even at top level)
 *
 * The set of "matching" element types is given by `typeFilter`. An empty
 * filter hides all elements (today's behaviour).
 */
export function computeVisibility(
	tree: UnifiedTree,
	elementsById: Map<string, Element>,
	typeFilter: ReadonlySet<string>
): Map<string, Visibility> {
	const subtreeMatches = new Map<string, boolean>();

	const visit = (key: string): boolean => {
		const cached = subtreeMatches.get(key);
		if (cached !== undefined) return cached;
		const kind = tree.kind.get(key);
		const kids = tree.children.get(key) ?? [];
		let any = false;
		if (kind === 'element') {
			const el = elementsById.get(key);
			// Body not loaded yet (windowed fetch pending) -> tentatively visible
			// so the row renders as a skeleton instead of vanishing; re-evaluated
			// once the body arrives.
			if (el === undefined) any = true;
			else if (typeFilter.has(el.type_name)) any = true;
		} else if (kind === 'artifact') {
			// Artifacts aren't elements, so the element-type filter doesn't gate
			// them — always a match, which also keeps their parent folder 'full'
			// (not collapsed to a stub) while the artifact is placed there.
			any = true;
		}
		for (const c of kids) {
			if (visit(c)) any = true;
		}
		subtreeMatches.set(key, any);
		return any;
	};

	const allRoots = [...tree.roots, ...tree.excludedRoots];
	for (const r of allRoots) visit(r);

	const out = new Map<string, Visibility>();
	const decide = (key: string): void => {
		const kind = tree.kind.get(key);
		const matches = subtreeMatches.get(key) ?? false;
		if (kind === 'folder') {
			out.set(key, matches ? 'full' : 'stub');
		} else {
			out.set(key, matches ? 'full' : 'hidden');
		}
		if (out.get(key) === 'full') {
			for (const c of tree.children.get(key) ?? []) decide(c);
		}
	};
	for (const r of allRoots) decide(r);
	return out;
}

export interface FlatRow {
	key: string;
	parent: string | null;
	depth: number;
}

/**
 * Pre-order flatten of the visible rows with depth, mirroring the recursion the
 * windowed renderer would otherwise do inline. Hidden rows are skipped; `stub`
 * folders and collapsed nodes are emitted but not descended into.
 */
export function flattenVisibleRows(
	tree: UnifiedTree,
	visibility: Map<string, Visibility>,
	collapsed: ReadonlySet<string>,
	roots: string[] = tree.roots
): FlatRow[] {
	const out: FlatRow[] = [];
	const walk = (key: string, parent: string | null, depth: number): void => {
		const vis = visibility.get(key);
		if (vis === 'hidden' || vis === undefined) return;
		out.push({ key, parent, depth });
		if (vis === 'stub') return;
		if (collapsed.has(key)) return;
		for (const c of tree.children.get(key) ?? []) walk(c, key, depth + 1);
	};
	for (const r of roots) walk(r, null, 0);
	return out;
}

// ----- drag-and-drop helpers -----

/** dataTransfer MIME types for the two draggable row kinds. */
export const ELEMENT_MIME = 'application/x-element-id';
export const FOLDER_MIME = 'application/x-folder-id';

/**
 * Sentinel key for the "view root" dropzone (move back to unplaced top level).
 * Starts with NUL so it can never collide with an element id, and is distinct
 * from any folder key.
 */
export const VIEW_ROOT_DROP_KEY = NUL + 'R' + NUL;

/**
 * Payloads are JSON arrays so they survive folder names containing the NUL
 * join char (an element payload carries a multi-selection unchanged; a folder
 * payload is wrapped in a single-element array for the same wire shape, so
 * both sides decode through the one `decodeStringArray` helper).
 */
export function encodeElementPayload(ids: string[]): string {
	return JSON.stringify(ids);
}

export function encodeFolderPayload(folderId: string): string {
	return JSON.stringify([folderId]);
}

function decodeStringArray(s: string): string[] | null {
	try {
		const v = JSON.parse(s);
		if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
		return null;
	} catch {
		return null;
	}
}

export const decodeElementPayload = decodeStringArray;
export const decodeFolderPayload = decodeStringArray;

/** Element ids that may be dragged: unplaced roots plus any placed element. */
export function movableElementIds(tree: UnifiedTree): Set<string> {
	const out = new Set<string>(tree.placedElementIds);
	for (const key of tree.roots) {
		// The excluded-pool sentinel is no longer a tree root (it lives in
		// `tree.excludedRoots`), so only folder keys need filtering here.
		if (!isFolderKey(key)) out.add(key);
	}
	// excluded-pool roots are draggable: dragging one into a folder includes it.
	for (const id of tree.excludedRoots) out.add(id);
	return out;
}

/**
 * Pointer-based drag context threaded down through the recursive TreeNode.
 * Bundled into one object so the recursion forwards a single prop.
 *
 * We use Pointer Events rather than the native HTML5 drag-and-drop API: native
 * DnD depends on the OS-level drag loop, which fails to initiate in some
 * Chromium environments (drag never starts in Chrome/Edge while Firefox works).
 * Pointer events are driven by the browser's input pipeline directly, so they
 * behave consistently across browsers and also support touch/pen.
 *
 * Drop targets advertise themselves in the DOM via `data-drop-key` /
 * `data-drop-folder-id` attributes; the controller hit-tests them with
 * `elementFromPoint`, so the recursion only needs to forward `onPointerDown`.
 */
export type DndContext = {
	/** Begin a potential drag from a row (threshold-gated; a tap still selects).
	 * `folderId` is the row's OWN id for a folder-kind press (the folder being
	 * dragged), the CONTAINING folder id (or `VIEW_ROOT_ID`) for an artifact-kind
	 * press picked up from inside the tree, and unused (`null`) for an element. */
	onPointerDown: (e: PointerEvent, key: string, kind: NodeKind, folderId: string | null) => void;
	/** Key of the row currently under the drag, or null. */
	hoverKey: string | null;
	/** Whether a drop on `hoverKey` would be accepted (drives green vs red). */
	hoverValid: boolean;
};

export type DropCheck = { ok: true } | { ok: false; reason: string };

/**
 * An element drop is legal when the selection is non-empty and every dragged id
 * is both known in the current tree (not from outside the view) and movable
 * (not held by a containment parent). Destination is irrelevant — placing a
 * movable element into any folder, or back to the top level, is always allowed.
 */
export function canDropElement(args: {
	elementIds: string[];
	movableIds: ReadonlySet<string>;
	knownIds: ReadonlySet<string>;
}): DropCheck {
	const { elementIds, movableIds, knownIds } = args;
	if (elementIds.length === 0) return { ok: false, reason: 'Nothing to move' };
	for (const id of elementIds) {
		if (!knownIds.has(id)) return { ok: false, reason: 'Element is not in this view' };
		if (!movableIds.has(id)) return { ok: false, reason: 'Element cannot be moved' };
	}
	return { ok: true };
}

/** A folder drop is legal unless the destination parent sits inside the
 * dragged folder's own subtree (cycle). Root (null destParent) is always a
 * legal parent. Takes the live view because ancestry is an id walk now, not
 * a path-prefix check. */
export function canDropFolder(args: {
	view: View;
	sourceId: string;
	destParentId: string | null;
}): DropCheck {
	const { view, sourceId, destParentId } = args;
	if (destParentId !== null && isFolderIdAncestor(view, sourceId, destParentId)) {
		return { ok: false, reason: 'Cannot move a folder into itself or a descendant' };
	}
	return { ok: true };
}

/**
 * An artifact drop is legal only onto a folder row — not the excluded pool,
 * not the "move to top level" root sentinel, and not an element row. Unlike
 * elements, an artifact carries no source/known-id constraints here: the
 * payload itself (its id) is all a placement needs.
 */
export function canDropArtifact(dropTargetKind: 'folder' | 'element' | 'section'): boolean {
	return dropTargetKind === 'folder';
}

export type ElementDropResolution = { folderId: string | null; index: number };

/**
 * Resolve where a dragged element selection should land, given the row under
 * the pointer. Folder header -> append (index = folderLen). Excluded section or
 * a row in the pool (`folderId === null`) -> exclude (`folderId: null`). Element
 * row inside a folder -> insert before/after the hovered sibling by pointer half.
 */
export function resolveElementDrop(args: {
	targetKind: 'folder' | 'element' | 'section';
	folderId?: string | null;
	folderLen?: number;
	siblingIndex?: number;
	half?: 'top' | 'bottom';
}): ElementDropResolution {
	const { targetKind, folderId, folderLen, siblingIndex, half } = args;
	if (targetKind === 'section') return { folderId: null, index: 0 };
	if (targetKind === 'folder') return { folderId: folderId ?? null, index: folderLen ?? 0 };
	// element row
	if (folderId == null) return { folderId: null, index: 0 }; // pool row -> exclude
	const base = siblingIndex ?? 0;
	return { folderId, index: half === 'bottom' ? base + 1 : base };
}
