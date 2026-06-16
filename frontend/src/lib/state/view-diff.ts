import type { Folder, View } from '$lib/api/types';

// ----- pure view diff -----
//
// Folders have NO stable id (identified only by name + nesting), so a folder
// rename/move surfaces as a folder-removed + folder-added pair rather than a
// "renamed" line. Element moves ARE keyed by stable element id. See the design
// doc (2026-06-16-view-change-tracking-and-save-tabs-design.md) for the
// rationale and the folder-identity caveat.

export type ViewChange =
	| { kind: 'element-added'; id: string; to: string[] }
	| { kind: 'element-removed'; id: string; from: string[] }
	| { kind: 'element-moved'; id: string; from: string[]; to: string[] }
	| { kind: 'folder-added'; path: string[] }
	| { kind: 'folder-removed'; path: string[] };

/** Map every placed element id to the path (array of folder names) holding it. */
function elementPaths(view: View | null): Map<string, string[]> {
	const out = new Map<string, string[]>();
	if (view === null) return out;
	const walk = (folders: Folder[], prefix: string[]): void => {
		for (const folder of folders) {
			const path = [...prefix, folder.name];
			for (const id of folder.elements) out.set(id, path);
			walk(folder.folders, path);
		}
	};
	walk(view.folders, []);
	return out;
}

/** All folder paths, keyed by a join (space) for set ops, mapped to the path array. */
function folderPaths(view: View | null): Map<string, string[]> {
	const out = new Map<string, string[]>();
	if (view === null) return out;
	const walk = (folders: Folder[], prefix: string[]): void => {
		for (const folder of folders) {
			const path = [...prefix, folder.name];
			out.set(path.join(' '), path);
			walk(folder.folders, path);
		}
	};
	walk(view.folders, []);
	return out;
}

/** True when `path`'s immediate parent is itself in `keys` (so `path` is implied). */
function parentIn(path: string[], keys: Set<string>): boolean {
	if (path.length <= 1) return false;
	return keys.has(path.slice(0, -1).join(' '));
}

export function diffViews(baseline: View | null, current: View | null): ViewChange[] {
	const changes: ViewChange[] = [];

	// Folder structure: shallowest-path added/removed.
	const baseFolders = folderPaths(baseline);
	const curFolders = folderPaths(current);
	const removedKeys = new Set([...baseFolders.keys()].filter((k) => !curFolders.has(k)));
	const addedKeys = new Set([...curFolders.keys()].filter((k) => !baseFolders.has(k)));
	for (const [key, path] of baseFolders) {
		if (removedKeys.has(key) && !parentIn(path, removedKeys)) {
			changes.push({ kind: 'folder-removed', path });
		}
	}
	for (const [key, path] of curFolders) {
		if (addedKeys.has(key) && !parentIn(path, addedKeys)) {
			changes.push({ kind: 'folder-added', path });
		}
	}

	// Element placement.
	const basePlace = elementPaths(baseline);
	const curPlace = elementPaths(current);
	const ids = new Set<string>([...basePlace.keys(), ...curPlace.keys()]);
	for (const id of ids) {
		const from = basePlace.get(id);
		const to = curPlace.get(id);
		if (from && to) {
			if (from.join(' ') !== to.join(' ')) {
				changes.push({ kind: 'element-moved', id, from, to });
			}
		} else if (to) {
			changes.push({ kind: 'element-added', id, to });
		} else if (from) {
			changes.push({ kind: 'element-removed', id, from });
		}
	}

	return changes;
}
