/**
 * The ONE definition of "put this artifact tab into lock-denied (unsaveable)
 * mode", dispatching on the workspace tab-id prefix to whichever editor store
 * owns the tab.
 *
 * Why a dispatcher at all: the three artifact editors each keep their own
 * private `_lockDenied` map (tabId -> holder label), because the banner, its
 * Retry and the save gating all live inside that editor. Their WRITERS are
 * normally internal (the open path and the banner's Retry). The one external
 * writer is the post-commit lease sweep: `POST /commits` releases every lock
 * token it is sent, so any still-open editor whose artifact was in the batch
 * loses its lease server-side, and `reacquireOpenArtifactLeases` re-checks each
 * one out. It reports a refusal as `(tabId, holder)` — a workspace tab id, not
 * an artifact id and not a kind — so exactly one place needs to know how a tab
 * id maps to an editor store. That place is here rather than in the DiffDrawer,
 * so any future commit surface inherits it.
 *
 * A tab id that names no artifact editor (a builtin tab, or a prefix added
 * later without a matching setter) is IGNORED rather than throwing: this runs
 * from a best-effort, fire-and-forget sweep after a commit that already
 * SUCCEEDED, and an unknown tab must not turn that into a visible failure.
 */
import { setNavLockDenied } from './navigation-editor.svelte';
import { setSnippetLockDenied } from './snippet-editor.svelte';
import { setTableLockDenied } from './table-editor.svelte';

export function markEditorLockDenied(tabId: string, holder: string): void {
	if (tabId.startsWith('nav:')) setNavLockDenied(tabId, holder);
	else if (tabId.startsWith('tbl:')) setTableLockDenied(tabId, holder);
	else if (tabId.startsWith('snip:')) setSnippetLockDenied(tabId, holder);
}
