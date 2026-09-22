/** A view folder as far as placements go: structural, so any view document fits. */
export type FolderLike = { elements: readonly string[]; folders: readonly FolderLike[] };

/**
 * Every element id a view's folders place, at any depth, each once in
 * first-seen order — what the server's excluded-roots route leaves out. Ids
 * are not checked against the model and artifacts do not count.
 */
export function placedElementIds(view: { folders: readonly FolderLike[] }): string[] {
	const seen = new Set<string>();
	const walk = (folders: readonly FolderLike[]) => {
		for (const folder of folders) {
			for (const id of folder.elements) seen.add(id);
			walk(folder.folders);
		}
	};
	walk(view.folders);
	return [...seen];
}
