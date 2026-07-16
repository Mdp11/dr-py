import { hasDirtyNavDrafts } from './navigation-editor.svelte';
import { hasDirtyTableDrafts } from './table-editor.svelte';
import { hasStagedOps } from './model.svelte';

/**
 * True when leaving the workspace would lose work the server has not seen:
 * staged (uncommitted) model edits, or an unsaved table / navigation draft.
 * Drives the workspace unload guard (`beforeNavigate` in the project page).
 */
export function hasUnsavedWork(): boolean {
	return hasStagedOps() || hasDirtyTableDrafts() || hasDirtyNavDrafts();
}
