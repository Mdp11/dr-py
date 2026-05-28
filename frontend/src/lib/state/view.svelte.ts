import * as viewApi from '$lib/api/view';
import type { Issue, View } from '$lib/api/types';
import { cloneView, findFolderByPath, moveFolderInView, placeElementsInView } from './view-ops';

export { cloneView } from './view-ops';

let _view: View | null = $state(null);
let _warnings: Issue[] = $state([]);

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
}

/**
 * Push the given view to the backend. Returns the validated state (the view
 * the backend stored plus any warnings). Throws on a transport / 4xx / 5xx
 * failure; warnings are not errors.
 */
export async function pushView(view: View): Promise<{ view: View; warnings: Issue[] }> {
	const res = await viewApi.putViewSnapshot(view);
	setState(res.view, res.warnings);
	return { view: res.view, warnings: res.warnings };
}

/** Load the active view from the backend (e.g. on app boot). */
export async function refreshView(): Promise<void> {
	try {
		const res = await viewApi.getView();
		setState(res.view, res.warnings);
	} catch {
		setState(null, []);
	}
}

/** Drop the active view server-side and clear local state. */
export async function dropView(): Promise<void> {
	try {
		await viewApi.clearView();
	} finally {
		clearViewState();
	}
}

// ----- CRUD mutators -----

/**
 * Add a new empty folder under the folder at `parentPath` (empty path = top
 * level). Throws if a sibling with the same name already exists.
 */
export async function createFolder(parentPath: string[], name: string): Promise<void> {
	if (_view === null) throw new Error('No active view');
	const next = cloneView(_view);
	const target = findFolderByPath(next, parentPath);
	if (target === null) throw new Error(`Folder not found: ${parentPath.join('/')}`);
	const collection = parentPath.length === 0 ? next.folders : target.folders;
	if (collection.some((f) => f.name === name)) {
		throw new Error(`Folder "${name}" already exists at this level`);
	}
	collection.push({ name, folders: [], elements: [] });
	await pushView(next);
}

export async function renameFolder(path: string[], newName: string): Promise<void> {
	if (_view === null) throw new Error('No active view');
	if (path.length === 0) throw new Error('Cannot rename the view root');
	const next = cloneView(_view);
	const parentPath = path.slice(0, -1);
	const oldName = path[path.length - 1];
	const parent = findFolderByPath(next, parentPath);
	const siblings = parentPath.length === 0 ? next.folders : parent?.folders;
	if (!siblings) throw new Error(`Folder not found: ${path.join('/')}`);
	const idx = siblings.findIndex((f) => f.name === oldName);
	if (idx < 0) throw new Error(`Folder not found: ${path.join('/')}`);
	if (newName !== oldName && siblings.some((f) => f.name === newName)) {
		throw new Error(`Folder "${newName}" already exists at this level`);
	}
	siblings[idx] = { ...siblings[idx], name: newName };
	await pushView(next);
}

/**
 * Delete the folder at `path`. Any elements placed inside it (and any nested
 * folders) are removed from the view; the elements themselves reappear at the
 * top-level "unplaced" area on next render.
 */
export async function deleteFolder(path: string[]): Promise<void> {
	if (_view === null) throw new Error('No active view');
	if (path.length === 0) throw new Error('Cannot delete the view root');
	const next = cloneView(_view);
	const parentPath = path.slice(0, -1);
	const name = path[path.length - 1];
	const parent = findFolderByPath(next, parentPath);
	const siblings = parentPath.length === 0 ? next.folders : parent?.folders;
	if (!siblings) throw new Error(`Folder not found: ${path.join('/')}`);
	const idx = siblings.findIndex((f) => f.name === name);
	if (idx < 0) throw new Error(`Folder not found: ${path.join('/')}`);
	siblings.splice(idx, 1);
	await pushView(next);
}

/**
 * Move an element into the folder at `path`. Removes the element from any
 * other folder that currently holds it (single-folder rule). Empty path means
 * "remove from any folder" — the element returns to the unplaced top level.
 */
export async function placeElement(path: string[], elementId: string): Promise<void> {
	return placeElements(path, [elementId]);
}

/**
 * Batch variant of {@link placeElement}: move every id in `ids` into the folder
 * at `path` in a single snapshot push (used by multi-select drag-and-drop so a
 * multi-move is one round-trip instead of N).
 */
export async function placeElements(path: string[], ids: string[]): Promise<void> {
	if (_view === null) throw new Error('No active view');
	await pushView(placeElementsInView(_view, path, ids));
}

export async function removeElement(elementId: string): Promise<void> {
	return placeElement([], elementId);
}

/**
 * Reparent the folder at `sourcePath` under `destParentPath` (empty array = top
 * level). Throws on a cycle (destination is the source or a descendant of it),
 * a missing source/destination, or a name clash at the destination.
 */
export async function moveFolder(sourcePath: string[], destParentPath: string[]): Promise<void> {
	if (_view === null) throw new Error('No active view');
	await pushView(moveFolderInView(_view, sourcePath, destParentPath));
}
