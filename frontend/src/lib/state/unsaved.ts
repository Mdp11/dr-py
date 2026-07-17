import { getDraft, hasDirtyNavDrafts } from './navigation-editor.svelte';
import { getSnippetDraft, hasDirtySnippetDrafts } from './snippet-editor.svelte';
import { getTableDraft, hasDirtyTableDrafts } from './table-editor.svelte';
import { hasStagedOps } from './model.svelte';

/**
 * True when leaving the workspace would lose work the server has not seen:
 * staged (uncommitted) model edits, or an unsaved table / navigation /
 * snippet draft. Drives the workspace unload guard (`beforeNavigate` in the
 * project page).
 */
export function hasUnsavedWork(): boolean {
	return hasStagedOps() || hasDirtyTableDrafts() || hasDirtyNavDrafts() || hasDirtySnippetDrafts();
}

/**
 * True when the workspace tab `tabId` holds work the server has not seen: an
 * edited draft (`dirty`) or a draft that was never saved at all (artifactId
 * null). Drives the unsaved `*` marker on tab labels.
 */
export function isTabDirty(kind: 'navigation' | 'table' | 'snippet', tabId: string): boolean {
	const draft =
		kind === 'table'
			? getTableDraft(tabId)
			: kind === 'snippet'
				? getSnippetDraft(tabId)
				: getDraft(tabId);
	if (!draft) return false;
	return draft.dirty || draft.artifactId === null;
}

/**
 * `isTabDirty` addressed by artifact id — sidebar rows only know the artifact.
 * A saved artifact's tab id is deterministic (`tbl:<id>` / `nav:<id>` /
 * `snip:<id>`), and only an OPEN artifact has a draft, so a closed artifact is
 * never dirty.
 */
export function isArtifactDirty(
	kind: 'navigation' | 'table' | 'code_snippet',
	artifactId: string
): boolean {
	if (kind === 'code_snippet') return isTabDirty('snippet', `snip:${artifactId}`);
	return isTabDirty(kind, `${kind === 'table' ? 'tbl' : 'nav'}:${artifactId}`);
}
