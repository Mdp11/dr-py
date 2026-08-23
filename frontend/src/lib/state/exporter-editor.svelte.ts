/**
 * Per-tab exporter drafts, keyed by workspace tab id (`exp:draft:<n>` /
 * `exp:<artifactId>`) — the exporter sibling of snippet-editor.svelte.ts.
 * An exporter artifact bundles many tables' exports into one zip; each
 * `ExporterEntry` carries its own presentation overrides, copied (never
 * referenced) from the source table's definition at the moment it is added
 * (`addExporterEntry` -> `entryForTable`) — from that instant the
 * entry and the table are independent, so later edits to either do not
 * follow the other.
 *
 * Saving STAGES, it does not POST: `saveExporterDraft` pushes a
 * `create_artifact`/`update_artifact` op onto the staged-artifact buffer
 * (`artifact-edits.svelte.ts`), and nothing reaches the server until the
 * DiffDrawer's Commit sends the batch. Opening a SAVED exporter first
 * checks the artifact out (`art:<id>` exclusive lease); a denial does not
 * refuse the tab — it opens UNSAVEABLE behind the holder banner
 * (`_lockDenied`), mirroring every other artifact editor (see
 * `navigation-editor.svelte.ts`'s `ensureDraft` docstring for the canonical
 * statement of what a denial gates). The tab is deliberately NOT re-keyed
 * when a create is staged: the draft keeps living in its `exp:draft:N` tab
 * and is rebound to `exp:<id>` only when the commit's `id_map` supplies a
 * canonical id (see the module-scope listeners at the bottom of this file).
 */
import { SvelteMap } from 'svelte/reactivity';
import * as artifactsApi from '$lib/api/artifacts';
import {
	ExporterDefinitionSchema,
	OutputOptionsSchema,
	type ExporterEntry,
	type OutputOptions,
	type TableDefinition
} from '$lib/api/types';
import { entryForTable } from '$lib/table/exporter';
import { assertNoNameClash } from './artifacts.svelte';
import {
	onArtifactCommit,
	onArtifactStageDiscarded,
	onArtifactStagedDelete,
	stageArtifactCreate,
	stageArtifactUpdate
} from './artifact-edits.svelte';
import { releaseArtifactIfUnneeded } from './checkout.svelte';
import { acquireArtifactLease, lockHolderLabel } from './edit-gate';
import { isTempId } from './ops';
import { bindTabToArtifact, closeTab, repointTabArtifact, retitleTab } from './workspace.svelte';

export interface ExporterDraft {
	name: string;
	artifactId: string | null;
	artifactRev: number | null;
	output: OutputOptions;
	entries: ExporterEntry[];
	dirty: boolean;
}

const _drafts = new SvelteMap<string, ExporterDraft>();
/**
 * tabId -> the peer holding the `art:` lease this tab was refused, as a
 * display label. Present == the tab is UNSAVEABLE: the payload loaded (a
 * denial never refuses the tab), but the name field, entry list and Save are
 * disabled — see `_lockDenied`'s counterpart in `snippet-editor.svelte.ts`
 * for the full statement of what a denial gates.
 */
const _lockDenied = new SvelteMap<string, string>();

export function getExporterDraft(tabId: string): ExporterDraft | undefined {
	return _drafts.get(tabId);
}

/** The peer holding this tab's artifact, or undefined when the tab is
 * editable (lease granted, or the user is a viewer — see `_lockDenied`). */
export function getExporterLockHolder(tabId: string): string | undefined {
	return _lockDenied.get(tabId);
}

/** Banner "Retry": re-attempt the check-out the tab was refused. A draft that
 * has no server-side row yet (unsaved, or a staged create under a temp id) has
 * nothing to lock, so it is silently skipped. The `.catch` is load-bearing:
 * `ensureCheckout` RETHROWS anything that is not a lock conflict and the banner
 * calls this as `void retryExporterLock(tabId)`, so a 500 would otherwise
 * become an unhandled rejection. A failed retry just leaves the banner up.
 * Mirrors `retrySnippetLock`/`retryTableLock` exactly. */
export async function retryExporterLock(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft?.artifactId || isTempId(draft.artifactId)) return;
	const res = await acquireArtifactLease(draft.artifactId, 'edit').catch(() => null);
	if (res === null) return;
	if (res.ok) _lockDenied.delete(tabId);
	else if (res.reason === 'conflict') _lockDenied.set(tabId, lockHolderLabel(res));
}

/** Mark this tab lock-denied from OUTSIDE the editor — the only such writer is
 * the post-commit lease sweep (`reacquireOpenArtifactLeases`, dispatched by
 * `artifact-lock-denied.ts`). See `setSnippetLockDenied`'s docstring for the
 * full rationale. */
export function setExporterLockDenied(tabId: string, holder: string): void {
	_lockDenied.set(tabId, holder);
}

/** Mirrors hasDirtySnippetDrafts: only the `dirty` flag matters. */
export function hasDirtyExporterDrafts(): boolean {
	for (const d of _drafts.values()) if (d.dirty) return true;
	return false;
}

export async function ensureExporterDraft(tabId: string): Promise<void> {
	if (_drafts.has(tabId)) return;
	let draft: ExporterDraft;
	const id = tabId.slice('exp:'.length);
	// An unsaved draft tab is the `exp:draft:N` a New-export click mints — or a
	// `exp:<tempId>` shape reachable in principle from a future save-as. A temp
	// id names nothing server-side, so it must never reach the lease/fetch
	// branch below: `getArtifact('tmp_…')` 404s and our only caller is a
	// fire-and-forget `$effect`, which would leave the tab on "Loading…" forever.
	if (tabId.startsWith('exp:draft:') || isTempId(id)) {
		draft = {
			name: 'New exporter',
			artifactId: null,
			artifactRev: null,
			output: OutputOptionsSchema.parse({}),
			entries: [],
			dirty: false
		};
	} else {
		// Check the artifact out on open, so the user learns who holds it BEFORE
		// investing work in a tab whose edits can never land. The `.catch` is
		// load-bearing, not defensive noise: `ensureCheckout` RETHROWS anything
		// that is not a lock conflict, and our only caller is a fire-and-forget
		// `$effect` — a 500 or a network blip from POST /locks would otherwise
		// reject before `getArtifact` runs and strand the tab on "Loading…"
		// forever. Fail OPEN with no banner: an infrastructure error is not a
		// peer holding the artifact.
		const res = await acquireArtifactLease(id, 'edit').catch(() => null);
		if (res !== null && !res.ok && res.reason === 'conflict') {
			_lockDenied.set(tabId, lockHolderLabel(res));
		} else {
			_lockDenied.delete(tabId);
		}
		const artifact = await artifactsApi.getArtifact(id);
		// The wire payload is never trusted as-is: parse it through the same
		// schema the server validates writes against. `safeParse`, not `parse` —
		// our only caller is a fire-and-forget `$effect` (see the lease comment
		// above), so a THROW here would strand the tab on "Loading…" forever
		// exactly like an unhandled lease/fetch rejection would. A malformed
		// payload therefore degrades to an EMPTY entry list rather than refusing
		// the tab: the draft still opens (name + rev intact), and re-saving from
		// there simply overwrites the corrupt payload with a valid one.
		const result = ExporterDefinitionSchema.safeParse(artifact.payload);
		draft = {
			name: artifact.name,
			artifactId: artifact.id,
			artifactRev: artifact.artifact_rev,
			output: result.success ? result.data.output : OutputOptionsSchema.parse({}),
			entries: result.success ? result.data.entries : [],
			dirty: false
		};
	}
	_drafts.set(tabId, draft);
}

export function setExporterName(tabId: string, name: string): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, name, dirty: true });
	retitleTab(tabId, name);
}

/** Append one table's export, COPYING its current settings — the
 * copy-at-add moment. From this instant the entry and the table are
 * independent: later edits to the table's definition must not follow the
 * entry, and later edits to the entry must not follow the table. */
export function addExporterEntry(
	tabId: string,
	tableId: string,
	tableName: string,
	defn: TableDefinition
): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const entry = entryForTable(tableId, defn, tableName);
	_drafts.set(tabId, { ...draft, entries: [...draft.entries, entry], dirty: true });
}

export function removeExporterEntry(tabId: string, index: number): void {
	const draft = _drafts.get(tabId);
	if (!draft || index < 0 || index >= draft.entries.length) return;
	_drafts.set(tabId, {
		...draft,
		entries: draft.entries.filter((_, i) => i !== index),
		dirty: true
	});
}

export function moveExporterEntryInList(tabId: string, from: number, to: number): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const n = draft.entries.length;
	if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;
	const entries = [...draft.entries];
	const [moved] = entries.splice(from, 1);
	entries.splice(to, 0, moved);
	_drafts.set(tabId, { ...draft, entries, dirty: true });
}

export function updateExporterEntry(
	tabId: string,
	index: number,
	patch: Partial<ExporterEntry>
): void {
	const draft = _drafts.get(tabId);
	if (!draft || index < 0 || index >= draft.entries.length) return;
	const entries = draft.entries.map((e, i) => (i === index ? { ...e, ...patch } : e));
	_drafts.set(tabId, { ...draft, entries, dirty: true });
}

/** Patches the zip-level output settings (mode/filename/manifest). Mirrors
 * `updateExporterEntry`: marks the draft dirty, no validation — strictness
 * (unknown tokens, bad paths, bare-mode-with-many-files) lives at export
 * time only (`POST /exports/run`), never here. */
export function updateExporterOutput(tabId: string, patch: Partial<OutputOptions>): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, output: { ...draft.output, ...patch }, dirty: true });
}

/**
 * "Save" = STAGE an artifact op. Nothing is sent here; the op joins the
 * staged batch that the DiffDrawer's Commit posts to `/commits`.
 *
 * An unsaved draft stages a `create_artifact` and adopts its TEMP id, but the
 * TAB IS NOT RE-KEYED — the rebind to `exp:<id>` happens in the commit
 * listener at the bottom of this file, driven by the commit's `id_map`. A
 * saved draft stages a FULL-payload `update_artifact` (name + entries);
 * re-saving coalesces into that same entry (see `stageArtifactUpdate`). No
 * `artifact_rev` is sent with either op: the `art:` lease taken at open time
 * is the concurrency control, not OCC.
 */
export function saveExporterDraft(tabId: string): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = { schema_version: 1, output: draft.output, entries: draft.entries };
	// Best-effort: the server's uniqueness check is authoritative and fires at
	// preview/commit. Throws, and the caller's Save handler renders it as an error.
	assertNoNameClash('exporter', draft.name, draft.artifactId);
	if (draft.artifactId === null) {
		const tempId = stageArtifactCreate('exporter', draft.name, payload, tabId);
		_drafts.set(tabId, { ...draft, artifactId: tempId, dirty: false });
		repointTabArtifact(tabId, tempId); // tab RECORD follows the draft; tab KEY does not
	} else {
		stageArtifactUpdate(draft.artifactId, { name: draft.name, payload });
		_drafts.set(tabId, { ...draft, dirty: false });
	}
}

export function closeExporterDraft(tabId: string): void {
	const draft = _drafts.get(tabId); // read BEFORE the delete: it owns the lease
	_drafts.delete(tabId);
	_lockDenied.delete(tabId);
	// Give the check-out back: no editor is behind this lease. A NO-OP
	// when a staged op still needs it (a saved-but-uncommitted edit must keep
	// its lease or the commit 409s "required lock not held") — that is
	// `releaseArtifactIfUnneeded`'s whole job. A temp id has no server-side row
	// and therefore no lease.
	if (draft?.artifactId && !isTempId(draft.artifactId)) {
		void releaseArtifactIfUnneeded(draft.artifactId).catch(() => {});
	}
}

export function resetExporterEditors(): void {
	_drafts.clear();
	_lockDenied.clear();
}

// ---------------------------------------------------------------------------
// Staged-artifact listeners (module scope: registered once for the app's life)
// ---------------------------------------------------------------------------

/**
 * The commit landed. Two things follow from the server's authoritative delta:
 *
 *  - a draft whose artifact was DELETED in the batch loses its tab — there is
 *    nothing left to edit. A delete staged from the sidebar already closed the
 *    tab eagerly (see the staged-delete listener below); this is the
 *    authoritative backstop for any path that reaches commit without it;
 *  - a draft still on a TEMP id is rebound to the canonical id the `id_map`
 *    minted: the workspace tab is re-keyed (`bindTabToArtifact`) and the
 *    draft moves from its old `_drafts` key to `exp:<id>`.
 *
 * Either way the draft adopts the header's `artifact_rev` (display-only now
 * that no save sends it back as an OCC precondition).
 */
onArtifactCommit(({ idMap, changed, deletedIds }) => {
	for (const [tabId, draft] of [..._drafts]) {
		if (draft.artifactId === null) continue; // unsaved: nothing committed
		if (deletedIds.includes(draft.artifactId)) {
			closeExporterDraft(tabId);
			closeTab(tabId);
			continue;
		}
		if (isTempId(draft.artifactId)) {
			const realId = idMap[draft.artifactId];
			if (realId === undefined) continue; // not part of this batch
			const artHeader = changed.find((h) => h.id === realId);
			bindTabToArtifact(tabId, realId);
			const newTab = `exp:${realId}`;
			_drafts.delete(tabId);
			_drafts.set(newTab, {
				...draft,
				artifactId: realId,
				artifactRev: artHeader?.artifact_rev ?? null
			});
			_lockDenied.delete(tabId);
		} else {
			const artHeader = changed.find((h) => h.id === draft.artifactId);
			if (artHeader) {
				_drafts.set(tabId, { ...draft, artifactRev: artHeader.artifact_rev });
			}
		}
	}
});

/**
 * A staged op was DISCARDED — nothing was saved, so the draft goes back to
 * holding unsaved work. A discarded CREATE additionally un-binds: its temp id
 * will never exist, so the draft becomes the unsaved draft it was before Save.
 */
onArtifactStageDiscarded((id) => {
	for (const [tabId, draft] of [..._drafts]) {
		if (draft.artifactId !== id) continue;
		if (isTempId(id)) {
			_drafts.set(tabId, { ...draft, artifactId: null, artifactRev: null, dirty: true });
			repointTabArtifact(tabId, null); // the record tracks the draft, both ways
		} else {
			_drafts.set(tabId, { ...draft, dirty: true });
		}
	}
});

/** A delete was STAGED (from the sidebar). Close the tab right away rather than
 * leaving an editor open on an artifact the pending batch removes — the user
 * has already decided it is going. */
onArtifactStagedDelete((id) => {
	for (const [tabId, draft] of [..._drafts]) {
		if (draft.artifactId === id) {
			closeExporterDraft(tabId);
			closeTab(tabId);
		}
	}
});
