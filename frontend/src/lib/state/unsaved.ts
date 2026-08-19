import type { ArtifactKind } from '$lib/artifacts/kinds';
import { getExporterDraft, hasDirtyExporterDrafts } from './exporter-editor.svelte';
import { getDraft, hasDirtyNavDrafts } from './navigation-editor.svelte';
import { getSnippetDraft, hasDirtySnippetDrafts } from './snippet-editor.svelte';
import { isMetamodelEditorDirty } from './metamodel-editor.svelte';
import { getTableDraft, hasDirtyTableDrafts } from './table-editor.svelte';
import { hasStagedOps } from './model.svelte';
import { getStagedArtifactDepth } from './artifact-edits.svelte';
import { getStagedViewDepth } from './view-edits.svelte';
import { getStagedMetamodelDepth } from './metamodel-stage.svelte';

/**
 * True when leaving the workspace would lose work the server has not seen:
 * staged (uncommitted) model edits, staged (uncommitted) ARTIFACT ops, staged
 * (uncommitted) VIEW ops, staged (uncommitted) METAMODEL ops, or an unsaved
 * table / navigation / snippet draft.
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
 * The metamodel term is NEW (spec 2026-08-16) and reverses the note that used
 * to stand here ("deliberately NO metamodel-editor term: the draft mirrors to
 * localStorage, so navigating away loses nothing"). Both halves of that family
 * — the YAML buffer and the diagram's staged node moves — are commit CONTENT
 * now: they ride the next `POST /commits` batch exactly like a staged model,
 * artifact or view op. They do still restore from localStorage, but so would a
 * table draft; what the guard is really about is that leaving the workspace
 * abandons an uncommitted batch, and answering differently for one of the four
 * families is the inconsistency, not the prompt.
 */
export function hasUnsavedWork(): boolean {
	return (
		hasStagedOps() ||
		getStagedArtifactDepth() > 0 ||
		getStagedViewDepth() > 0 ||
		getStagedMetamodelDepth() > 0 ||
		hasDirtyTableDrafts() ||
		hasDirtyNavDrafts() ||
		hasDirtySnippetDrafts() ||
		hasDirtyExporterDrafts()
	);
}

/**
 * True when the workspace tab `tabId` holds work the server has not seen: an
 * edited draft (`dirty`) or a draft that was never saved at all (artifactId
 * null). Drives the unsaved `*` marker on tab labels.
 *
 * The metamodel tab is the one kind with no per-tab draft record — it is a
 * singleton editor with module-level state — so it answers from its own
 * buffer-vs-baseline check instead of the draft lookup below, PLUS the staged
 * depth: a user who only dragged diagram nodes has uncommitted metamodel work
 * that the buffer check alone reports as clean (the moves live in
 * `metamodel-stage.svelte.ts`, not in the editor's buffer).
 */
export function isTabDirty(
	kind: 'navigation' | 'table' | 'snippet' | 'metamodel' | 'exporter',
	tabId: string
): boolean {
	if (kind === 'metamodel') return isMetamodelEditorDirty() || getStagedMetamodelDepth() > 0;
	const draft =
		kind === 'table'
			? getTableDraft(tabId)
			: kind === 'snippet'
				? getSnippetDraft(tabId)
				: kind === 'exporter'
					? getExporterDraft(tabId)
					: getDraft(tabId);
	if (!draft) return false;
	return draft.dirty || draft.artifactId === null;
}

/**
 * `isTabDirty` addressed by artifact id — sidebar rows only know the artifact.
 * A saved artifact's tab id is deterministic (`tbl:<id>` / `nav:<id>` /
 * `snip:<id>` / `exp:<id>`), and only an OPEN artifact has a draft, so a
 * closed artifact is never dirty.
 */
export function isArtifactDirty(kind: ArtifactKind, artifactId: string): boolean {
	if (kind === 'code_snippet') return isTabDirty('snippet', `snip:${artifactId}`);
	if (kind === 'exporter') return isTabDirty('exporter', `exp:${artifactId}`);
	return isTabDirty(kind, `${kind === 'table' ? 'tbl' : 'nav'}:${artifactId}`);
}
