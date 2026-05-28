import type { Folder, View } from '$lib/api/types';

// ----- pure view-structure helpers -----
//
// These live in a plain `.ts` module (no Svelte runes) so they can be unit
// tested directly. The `view.svelte.ts` mutators are thin wrappers that clone,
// apply one of these transforms, and push the result to the backend.

export function cloneFolder(f: Folder): Folder {
	return {
		name: f.name,
		folders: f.folders.map(cloneFolder),
		elements: [...f.elements]
	};
}

export function cloneView(v: View): View {
	return { name: v.name, folders: v.folders.map(cloneFolder) };
}

/**
 * Locate a folder by its path (array of names). Returns the folder reference
 * inside `view` (after mutation, the caller is responsible for pushing the
 * snapshot). An empty path resolves to the view "root" — a virtual folder
 * whose `folders` is `view.folders`.
 */
export function findFolderByPath(view: View, path: string[]): Folder | null {
	if (path.length === 0) {
		// virtual root — we wrap it inline; mutate via separate branch
		return { name: '', folders: view.folders, elements: [] };
	}
	let folders = view.folders;
	let found: Folder | null = null;
	for (const name of path) {
		found = folders.find((f) => f.name === name) ?? null;
		if (found === null) return null;
		folders = found.folders;
	}
	return found;
}

/**
 * True when `descendant` is `ancestor` itself or sits below it — i.e. when
 * `ancestor` is a path prefix of `descendant`. Used to reject moving a folder
 * into itself or one of its own descendants (a cycle).
 */
export function isFolderPathAncestor(ancestor: string[], descendant: string[]): boolean {
	if (ancestor.length > descendant.length) return false;
	for (let i = 0; i < ancestor.length; i++) {
		if (ancestor[i] !== descendant[i]) return false;
	}
	return true;
}

/**
 * Return a new view with every id in `ids` placed into the folder at `path`
 * (empty path = unplaced top level). Each id is first stripped from any folder
 * that currently holds it (single-folder rule), matching `placeElement`.
 */
export function placeElementsInView(view: View, path: string[], ids: string[]): View {
	const next = cloneView(view);
	const idSet = new Set(ids);

	const stripFrom = (folder: Folder): void => {
		folder.elements = folder.elements.filter((e) => !idSet.has(e));
		for (const child of folder.folders) stripFrom(child);
	};
	for (const f of next.folders) stripFrom(f);

	if (path.length > 0) {
		const target = findFolderByPath(next, path);
		if (target === null) throw new Error(`Folder not found: ${path.join('/')}`);
		for (const id of ids) {
			if (!target.elements.includes(id)) target.elements.push(id);
		}
	}
	return next;
}

/**
 * Return a new view with the folder at `sourcePath` reparented under
 * `destParentPath` (empty array = top level). The folder keeps its subtree and
 * elements; sibling order is irrelevant (folders render alphabetically), so
 * this is always a reparent, never a reorder.
 *
 * Throws if the source is the root, if the destination is the source or one of
 * its descendants (cycle), if either location is missing, or if a sibling with
 * the same name already exists at the destination.
 */
export function moveFolderInView(view: View, sourcePath: string[], destParentPath: string[]): View {
	if (sourcePath.length === 0) throw new Error('Cannot move the view root');
	if (isFolderPathAncestor(sourcePath, destParentPath)) {
		throw new Error('Cannot move a folder into itself or a descendant');
	}
	const srcParentPath = sourcePath.slice(0, -1);
	// No-op: already a direct child of the destination.
	if (
		srcParentPath.length === destParentPath.length &&
		srcParentPath.every((n, i) => n === destParentPath[i])
	) {
		return cloneView(view);
	}

	const next = cloneView(view);
	const name = sourcePath[sourcePath.length - 1];

	const srcParent = findFolderByPath(next, srcParentPath);
	const srcSiblings = srcParentPath.length === 0 ? next.folders : srcParent?.folders;
	if (!srcSiblings) throw new Error(`Folder not found: ${sourcePath.join('/')}`);
	const idx = srcSiblings.findIndex((f) => f.name === name);
	if (idx < 0) throw new Error(`Folder not found: ${sourcePath.join('/')}`);
	const [moved] = srcSiblings.splice(idx, 1);

	const destParent = findFolderByPath(next, destParentPath);
	const destSiblings = destParentPath.length === 0 ? next.folders : destParent?.folders;
	if (!destSiblings) throw new Error(`Folder not found: ${destParentPath.join('/')}`);
	if (destSiblings.some((f) => f.name === moved.name)) {
		throw new Error(`Folder "${moved.name}" already exists at this level`);
	}
	destSiblings.push(moved);
	return next;
}
