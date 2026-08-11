import { getDraft, hasDirtyNavDrafts } from './navigation-editor.svelte';
import { getSnippetDraft, hasDirtySnippetDrafts } from './snippet-editor.svelte';
import { isMetamodelEditorDirty } from './metamodel-editor.svelte';
import { getTableDraft, hasDirtyTableDrafts } from './table-editor.svelte';
import { hasStagedOps } from './model.svelte';
import { getStagedArtifactDepth } from './artifact-edits.svelte';
import { getStagedViewDepth } from './view-edits.svelte';

/**
 * True when leaving the workspace would lose work the server has not seen:
 * staged (uncommitted) model edits, staged (uncommitted) ARTIFACT ops, staged
 * (uncommitted) VIEW ops, or an unsaved table / navigation / snippet draft.
 * Drives the workspace unload guard (`beforeNavigate` in the project page).
 *
 * The artifact term is not redundant with the draft terms: saving an artifact
 * editor CLEARS its draft's `dirty` flag and hands the work to the staged
 * artifact buffer, so a saved-but-uncommitted artifact is invisible to
 * `hasDirty*Drafts()` and would otherwise walk out the door unguarded.
 *
 * The view term has no draft counterpart AT ALL — folder renames/moves/
 * placements go straight from the gesture into the journal, with no editor in
 * between — so without it a view-ONLY batch (rename a folder, close the tab)
 * walks out unguarded while the equivalent model or artifact batch is caught.
 *
 * There is deliberately NO metamodel-editor term: that draft mirrors to
 * localStorage and is restored on the next open, so navigating away loses
 * nothing and prompting for it would be a false alarm.
 */
export function hasUnsavedWork(): boolean {
	return (
		hasStagedOps() ||
		getStagedArtifactDepth() > 0 ||
		getStagedViewDepth() > 0 ||
		hasDirtyTableDrafts() ||
		hasDirtyNavDrafts() ||
		hasDirtySnippetDrafts()
	);
}

/**
 * True when the workspace tab `tabId` holds work the server has not seen: an
 * edited draft (`dirty`) or a draft that was never saved at all (artifactId
 * null). Drives the unsaved `*` marker on tab labels.
 *
 * The metamodel tab is the one kind with no per-tab draft record — it is a
 * singleton editor with module-level state — so it answers from its own
 * buffer-vs-baseline check instead of the draft lookup below.
 */
export function isTabDirty(
	kind: 'navigation' | 'table' | 'snippet' | 'metamodel',
	tabId: string
): boolean {
	if (kind === 'metamodel') return isMetamodelEditorDirty();
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
