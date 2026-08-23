/**
 * Per-tab code-snippet drafts, keyed by workspace tab id (`snip:draft:<n>` /
 * `snip:<artifactId>`) — the snippet sibling of navigation-editor.svelte.ts.
 * This module owns the draft + save lifecycle; lint and run state (debounced
 * /snippets/lint, run/stop phases, generation guards) live here too (added
 * with the console work). `entryPoints` mirrors the SERVER-derived value
 * (adopted from artifact responses and commit headers; a run's availability
 * gating uses the live lint response instead) — the client never sends it, so
 * a STAGED (uncommitted) snippet legitimately has none until its commit lands.
 *
 * Saving STAGES, it does not POST: `saveSnippetDraft` pushes a
 * `create_artifact`/`update_artifact` op onto the staged-artifact buffer
 * (`artifact-edits.svelte.ts`), and nothing reaches the server until the
 * DiffDrawer's Commit sends the batch. Opening a SAVED snippet first checks the
 * artifact out (`art:<id>` exclusive lease); a denial does not refuse the tab —
 * it opens UNSAVEABLE behind the holder banner (`_lockDenied`): Save is
 * disabled (this tab has no ordinary Save-as) and the CodeMirror document goes
 * `inert` too. `navigation-editor.svelte.ts`'s `ensureDraft` docstring is the
 * canonical statement of that scope. The escape hatch is `forkSnippetDraftAsCopy`
 * — "Save as copy" on the banner — which stages a fresh CREATE under a temp id
 * and opens it in a SEPARATE new tab, leaving this one exactly as it was. The
 * tab is deliberately
 * NOT re-keyed when a create is staged: the draft keeps living in its
 * `snip:draft:N` tab and is rebound to `snip:<id>` only when the commit's
 * `id_map` supplies a canonical id (see the module-scope listeners at the
 * bottom of this file).
 */
import { SvelteMap } from 'svelte/reactivity';
import * as artifactsApi from '$lib/api/artifacts';
import * as snippetsApi from '$lib/api/snippets';
import type { SnippetRunOut } from '$lib/api/snippets';
import type { SnippetDiagnostic } from '$lib/api/types';
import { ApiError } from '$lib/api/errors';
import { entryAvailable } from '$lib/snippet/entry-stubs';
import { assertNoNameClash } from './artifacts.svelte';
import {
	onArtifactCommit,
	onArtifactStageDiscarded,
	onArtifactStagedDelete,
	repointStagedArtifactSourceTab,
	stageArtifactCreate,
	stageArtifactUpdate
} from './artifact-edits.svelte';
import { releaseArtifactIfUnneeded } from './checkout.svelte';
import { acquireArtifactLease, lockHolderLabel } from './edit-gate';
import { isTempId } from './ops';
import {
	bindTabToArtifact,
	closeTab,
	openArtifactTab,
	repointTabArtifact,
	retitleTab
} from './workspace.svelte';

export interface SnippetDraft {
	name: string;
	artifactId: string | null;
	artifactRev: number | null;
	code: string;
	dirty: boolean;
	/** Server-derived (artifact responses and commit headers); `[]` until the
	 * draft is LOADED from a saved artifact or its staged save COMMITS — a
	 * staged-but-uncommitted snippet has none, because nothing has parsed its
	 * code yet. */
	entryPoints: string[];
}

// New drafts start EMPTY — the "explore via dr" guidance lives in the editor
// as CM placeholder ghost text (CodeEditor.svelte), not as document content
// the user has to delete.
const DEFAULT_CODE = '';

const _drafts = new SvelteMap<string, SnippetDraft>();
/**
 * tabId -> the peer holding the `art:` lease this tab was refused, as a display
 * label. Present == the tab is UNSAVEABLE AND READ-ONLY: the payload loaded (a
 * denial never refuses the tab), the name input and Save are disabled (this
 * tab has no ordinary Save-as), the CodeMirror document goes `inert`, and the
 * banner offers Retry plus "Save as copy" (`forkSnippetDraftAsCopy`) — see
 * `navigation-editor.svelte.ts`'s `ensureDraft` docstring for the canonical
 * statement of what a denial gates. The entry-hint bar's "Insert stub" button
 * is a second, separate code-mutating control — it sits above the editor as
 * chrome, not inside the `inert` CodeMirror host, so SnippetTab disables it
 * on `locked` explicitly rather than relying on the host's `inert` to catch
 * it too. Absent for a VIEWER too — the whole workspace is already read-only
 * for them, so a per-tab "checked out by…" line would be noise.
 */
const _lockDenied = new SvelteMap<string, string>();

export const LINT_DEBOUNCE_MS = 300;

export interface SnippetLintState {
	diagnostics: SnippetDiagnostic[];
	entryPoints: string[];
}

export type SnippetRunPhase = 'idle' | 'running' | 'stopping';

export interface SnippetBoundElement {
	id: string;
	label: string;
}

export interface SnippetRunState {
	phase: SnippetRunPhase;
	runId: string | null;
	result: SnippetRunOut | null;
	/** run_id of the last result whose ops were staged (disables re-staging). */
	stagedRunId: string | null;
	notice: string | null;
	entry: 'script' | 'value' | 'step';
	/** Bound context elements, in bind order — `value` receives all of them,
	 * `step` only ever holds one (add replaces, entry-switch truncates). */
	elements: SnippetBoundElement[];
}

const IDLE_RUN: SnippetRunState = {
	phase: 'idle',
	runId: null,
	result: null,
	stagedRunId: null,
	notice: null,
	entry: 'script',
	elements: []
};

const _lint = new SvelteMap<string, SnippetLintState>();
const _runs = new SvelteMap<string, SnippetRunState>();
// Control state — never read from templates.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _lintTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _lintGenerations = new Map<string, number>();
const _runGenerations = new Map<string, number>();

function bump(map: Map<string, number>, tabId: string): number {
	const next = (map.get(tabId) ?? 0) + 1;
	map.set(tabId, next);
	return next;
}

export function getSnippetLint(tabId: string): SnippetLintState | undefined {
	return _lint.get(tabId);
}
export function getSnippetRun(tabId: string): SnippetRunState {
	return _runs.get(tabId) ?? IDLE_RUN;
}
function setRun(tabId: string, patch: Partial<SnippetRunState>): void {
	_runs.set(tabId, { ...getSnippetRun(tabId), ...patch });
}
export function setSnippetEntry(tabId: string, entry: 'script' | 'value' | 'step'): void {
	const rs = getSnippetRun(tabId);
	// `step` binds a single element: switching there with several chips bound
	// keeps only the first so the row never shows an unrunnable step state.
	const elements = entry === 'step' ? rs.elements.slice(0, 1) : rs.elements;
	setRun(tabId, { entry, elements });
}
export function addSnippetElement(tabId: string, id: string, label: string): void {
	const rs = getSnippetRun(tabId);
	if (rs.entry === 'step') {
		setRun(tabId, { elements: [{ id, label }] }); // step: picking replaces
		return;
	}
	if (rs.elements.some((e) => e.id === id)) return; // duplicate — ignored
	setRun(tabId, { elements: [...rs.elements, { id, label }] });
}
export function removeSnippetElement(tabId: string, id: string): void {
	const rs = getSnippetRun(tabId);
	setRun(tabId, { elements: rs.elements.filter((e) => e.id !== id) });
}
export function clearSnippetElements(tabId: string): void {
	setRun(tabId, { elements: [] });
}
export function markRunStaged(tabId: string): void {
	const rs = getSnippetRun(tabId);
	if (rs.result) setRun(tabId, { stagedRunId: rs.result.run_id });
}

async function lintNow(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const gen = bump(_lintGenerations, tabId);
	try {
		const out = await snippetsApi.lintSnippet(draft.code);
		if (_lintGenerations.get(tabId) !== gen || !_drafts.has(tabId)) return;
		_lint.set(tabId, { diagnostics: out.diagnostics, entryPoints: out.entry_points });
		// Deliberately KEEP the user's entry selection even when entry_points
		// doesn't (yet) include it: the SnippetTab hint bar uses that state to
		// explain the def value(elements):/step(el) contract while the user types it.
		// Sending a stale entry is prevented at the send site (runSnippetTab's
		// entryAvailable guard), not by yanking the selection out from under them.
	} catch {
		// Lint is advisory: a failed request just leaves the last diagnostics.
	}
}

function scheduleLint(tabId: string): void {
	const existing = _lintTimers.get(tabId);
	if (existing !== undefined) clearTimeout(existing);
	_lintTimers.set(
		tabId,
		setTimeout(() => {
			_lintTimers.delete(tabId);
			void lintNow(tabId);
		}, LINT_DEBOUNCE_MS)
	);
}

export async function runSnippetTab(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	const rs = getSnippetRun(tabId);
	if (!draft || rs.phase !== 'idle') return;
	if (rs.entry !== 'script' && rs.elements.length === 0) return; // UI disables Run too
	// Availability gate lives HERE, not as a lint-time entry reset: the UI's
	// Run button is disabled too, but Mod-Enter (CodeEditor keymap) calls this
	// directly, so the store must refuse to send an entry lint hasn't unlocked.
	if (!entryAvailable(rs.entry, getSnippetLint(tabId)?.entryPoints)) return;
	const runId = crypto.randomUUID();
	const gen = bump(_runGenerations, tabId);
	setRun(tabId, { phase: 'running', runId, notice: null });
	try {
		const out = await snippetsApi.runSnippet({
			run_id: runId,
			code: draft.code,
			entry: rs.entry,
			element_ids: rs.entry === 'script' ? undefined : rs.elements.map((e) => e.id)
		});
		if (_runGenerations.get(tabId) !== gen || !_drafts.has(tabId)) return; // stopped/closed/newer
		setRun(tabId, { phase: 'idle', runId: null, result: out });
	} catch (err) {
		if (_runGenerations.get(tabId) !== gen || !_drafts.has(tabId)) return;
		const notice =
			err instanceof ApiError && err.status === 429
				? 'Another run is already in progress — wait for it to finish.'
				: err instanceof ApiError && err.status === 503
					? 'Code execution is unavailable on this server.'
					: 'Run failed — check your connection and try again.';
		setRun(tabId, { phase: 'idle', runId: null, notice });
	}
}

/** Honest Stop (spec D3): the M1 abort is a no-op server-side — the run ends
 * only at wall_timeout_s. We cancel (deregisters + authorizes), orphan the
 * in-flight response via the generation bump, and say so. Until the server
 * slot frees, a new run may 429 (per-user cap) — that is honest too. */
export async function stopSnippetTab(tabId: string): Promise<void> {
	const rs = getSnippetRun(tabId);
	if (rs.phase !== 'running' || rs.runId === null) return;
	setRun(tabId, { phase: 'stopping' });
	bump(_runGenerations, tabId); // discard the eventual response
	try {
		await snippetsApi.cancelSnippet(rs.runId);
	} catch {
		// 404 = run already finished or not ours anymore — nothing to do.
	}
	// Mirrors runSnippetTab's own re-check: the draft (and its `_runs` entry)
	// may have been closed while `cancelSnippet` was in flight. Writing
	// unconditionally here would resurrect a `_runs` entry for a draft-less
	// tab id, which then surfaces a stale "Run stopped" notice if the same
	// artifact id is reopened later (tab ids are deterministic `snip:<id>`).
	if (!_drafts.has(tabId)) return;
	setRun(tabId, {
		phase: 'idle',
		runId: null,
		notice: 'Run stopped — the server ends it at the wall timeout.'
	});
}

export function getSnippetDraft(tabId: string): SnippetDraft | undefined {
	return _drafts.get(tabId);
}

/** The peer holding this tab's artifact, or null when the tab is editable
 * (lease granted, or the user is a viewer — see `_lockDenied`). */
export function getSnippetLockHolder(tabId: string): string | null {
	return _lockDenied.get(tabId) ?? null;
}

/** Banner "Retry": re-attempt the check-out the tab was refused. A draft that
 * has no server-side row yet (unsaved, or a staged create under a temp id) has
 * nothing to lock, so it is silently skipped. The `.catch` is load-bearing:
 * `ensureCheckout` RETHROWS anything that is not a lock conflict and the banner
 * calls this as `void retrySnippetLock(tabId)`, so a 500 would otherwise become
 * an unhandled rejection. A failed retry just leaves the banner up. */
export async function retrySnippetLock(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft?.artifactId || isTempId(draft.artifactId)) return;
	const res = await acquireArtifactLease(draft.artifactId, 'edit').catch(() => null);
	if (res === null) return;
	if (res.ok) _lockDenied.delete(tabId);
	else if (res.reason === 'conflict') _lockDenied.set(tabId, lockHolderLabel(res));
}

/** Mark this tab lock-denied from OUTSIDE the editor — the only such writer is
 * the post-commit lease sweep (`reacquireOpenArtifactLeases`, dispatched by
 * `artifact-lock-denied.ts`). `POST /commits` releases every token it is sent,
 * so a still-open tab whose artifact was in the batch loses its lease; the
 * sweep re-checks it out, and when a peer got there first this is how the tab
 * flips to UNSAVEABLE with the holder banner (and its Retry) instead of
 * silently accepting edits it could never commit. */
export function setSnippetLockDenied(tabId: string, holder: string): void {
	_lockDenied.set(tabId, holder);
}

/** Mirrors hasDirtyNavDrafts/hasDirtyTableDrafts: only the `dirty` flag
 * matters. A never-saved draft (`artifactId === null`) with untouched code is
 * empty (DEFAULT_CODE is ''), so there is no content to lose — the old rule
 * that counted every never-saved draft guarded the starter comment, which is
 * now placeholder text outside the document. */
export function hasDirtySnippetDrafts(): boolean {
	for (const d of _drafts.values()) if (d.dirty) return true;
	return false;
}

function payloadEntryPoints(payload: Record<string, unknown>): string[] {
	const raw = payload['entry_points'];
	return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
}

export async function ensureSnippetDraft(tabId: string): Promise<SnippetDraft> {
	const existing = _drafts.get(tabId);
	if (existing) return existing;
	let draft: SnippetDraft;
	const id = tabId.slice('snip:'.length);
	// An unsaved draft tab is the `snip:draft:N` a New-snippet click mints — or,
	// in the sibling editors (which have a save-as this one does not), a
	// `<prefix>:<tempId>` fork. A temp id names nothing server-side, so it must
	// never reach the lease/fetch branch below: `getArtifact('tmp_…')` 404s and
	// our only caller is a fire-and-forget `$effect`, which would leave the tab
	// on "Loading…" forever. The prefix test alone does not catch that shape.
	if (tabId.startsWith('snip:draft:') || isTempId(id)) {
		draft = {
			name: 'New snippet',
			artifactId: null,
			artifactRev: null,
			code: DEFAULT_CODE,
			dirty: false,
			entryPoints: []
		};
	} else {
		// Check the artifact out on open, so the user learns who holds it BEFORE
		// investing work in a tab whose edits can never land. A denial does NOT
		// refuse the tab — the payload still loads and the tab opens UNSAVEABLE
		// behind the holder banner (a viewer gets no banner: see `_lockDenied`).
		// Unsaveable AND read-only: SnippetTab wraps the CodeMirror host in
		// `inert` while denied — `navigation-editor.svelte.ts`'s `ensureDraft`
		// docstring is the canonical statement of what is gated.
		//
		// The `.catch` is load-bearing, not defensive noise: `ensureCheckout`
		// RETHROWS anything that is not a lock conflict, and our only caller is a
		// fire-and-forget `$effect` — a 500 or a network blip from POST /locks
		// would otherwise reject before `getArtifact` runs and strand the tab on
		// "Loading…" forever. Fail OPEN with no banner: an infrastructure error is
		// not a peer holding the artifact.
		const res = await acquireArtifactLease(id, 'edit').catch(() => null);
		if (res !== null && !res.ok && res.reason === 'conflict') {
			_lockDenied.set(tabId, lockHolderLabel(res));
		} else {
			_lockDenied.delete(tabId);
		}
		const artifact = await artifactsApi.getArtifact(id);
		const payload = artifact.payload as Record<string, unknown>;
		draft = {
			name: artifact.name,
			artifactId: artifact.id,
			artifactRev: artifact.artifact_rev,
			code: typeof payload['code'] === 'string' ? payload['code'] : '',
			dirty: false,
			entryPoints: artifact.entry_points ?? payloadEntryPoints(payload)
		};
	}
	_drafts.set(tabId, draft);
	void lintNow(tabId); // immediate — gutter + entry availability without an edit
	return draft;
}

export function updateSnippetCode(tabId: string, code: string): void {
	const draft = _drafts.get(tabId);
	if (!draft || draft.code === code) return;
	_drafts.set(tabId, { ...draft, code, dirty: true });
	scheduleLint(tabId);
}

export function setSnippetName(tabId: string, name: string): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, name, dirty: true });
	retitleTab(tabId, name);
}

/** Move per-tab state from a draft tab id to the canonical artifact id its
 * staged create was minted at commit, including lint/run state. A pending
 * debounced lint is cancelled under the old id and rescheduled under the new
 * one (mirrors navigation-editor.rekeyTab's reschedule discipline); the old
 * id's generations are bumped so any in-flight lint/run response for it is
 * orphaned rather than landing on a tab id nobody reads anymore.
 *
 * `_lockDenied` is deliberately NOT carried: the only caller is the commit
 * rebind, whose destination is an artifact we just created and nobody has ever
 * refused us — it deletes the (impossible) entry explicitly instead. */
function rekeySnippetTab(oldTab: string, newTab: string): void {
	const lint = _lint.get(oldTab);
	if (lint !== undefined) {
		_lint.delete(oldTab);
		_lint.set(newTab, lint);
	}
	const run = _runs.get(oldTab);
	if (run !== undefined) {
		_runs.delete(oldTab);
		// A running/stopping run cannot follow a rekey: runSnippetTab/
		// stopSnippetTab's in-flight closure is bound to oldTab and its
		// response is about to be orphaned by the generation bump below, so no
		// code path will ever flip the moved entry back to idle. Normalize it
		// here instead of carrying a permanently-stuck phase to the new tab.
		_runs.set(
			newTab,
			run.phase === 'idle'
				? run
				: {
						...run,
						phase: 'idle',
						runId: null,
						notice: 'Run discarded — the snippet was committed while it was running. Re-run.'
					}
		);
	}
	const timer = _lintTimers.get(oldTab);
	if (timer !== undefined) {
		clearTimeout(timer);
		_lintTimers.delete(oldTab);
		scheduleLint(newTab);
	}
	bump(_lintGenerations, oldTab);
	bump(_runGenerations, oldTab);
}

/**
 * "Save" = STAGE an artifact op. Nothing is sent here; the op joins the staged
 * batch that the DiffDrawer's Commit posts to `/commits`.
 *
 * An unsaved draft stages a `create_artifact` and adopts its TEMP id, but the
 * TAB IS NOT RE-KEYED — a temp id is not an artifact id, and re-keying now
 * would strand the tab (and every per-tab key hanging off it) on an id the
 * server may never mint if the batch is discarded. The rebind to `snip:<id>`
 * happens in the commit listener at the bottom of this file, driven by the
 * commit's `id_map`.
 *
 * A saved draft stages a FULL-payload `update_artifact` (name + code);
 * re-saving coalesces into that same entry (see `stageArtifactUpdate`). No
 * `artifact_rev` is sent with either op: the `art:` lease taken at open time is
 * the concurrency control, not OCC.
 *
 * `entryPoints` is untouched here on purpose — it is SERVER-derived (from the
 * code's AST), so a staged snippet has none until its commit header supplies
 * them.
 */
export async function saveSnippetDraft(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = { schema_version: 1, language: 'python', code: draft.code };
	// Best-effort: the server's uniqueness check is authoritative and fires at
	// preview/commit. Throws, and SnippetTab renders it as `saveError`.
	assertNoNameClash('code_snippet', draft.name, draft.artifactId);
	if (draft.artifactId === null) {
		const tempId = stageArtifactCreate('code_snippet', draft.name, payload, tabId);
		_drafts.set(tabId, { ...draft, artifactId: tempId, dirty: false });
		repointTabArtifact(tabId, tempId); // tab RECORD follows the draft; tab KEY does not
	} else {
		stageArtifactUpdate(draft.artifactId, { name: draft.name, payload });
		_drafts.set(tabId, { ...draft, dirty: false });
	}
}

/**
 * Fork a (typically lock-denied) tab's draft into a staged CREATE under a
 * fresh temp id and open it in a new tab — snippet's "Save as copy", the
 * banner's escape hatch for a tab that can never save. Mirrors
 * `saveAsDraft`/`saveAsTableDraft`'s stage-first-then-move-tab ordering
 * (`navigation-editor.svelte.ts:844` — the new tab key is `snip:<tempId>`, so
 * it cannot exist until the temp id does, hence `repointStagedArtifactSourceTab`
 * running AFTER `openArtifactTab` mints it; see that function's docstring) with
 * one deliberate difference: those two REKEY the source tab in place (the fork
 * replaces what was open there), but this snippet had no Save-as to begin
 * with, and the source tab may currently be READ-ONLY (a denied tab's whole
 * editing surface goes `inert` — see `_lockDenied`'s docstring above), so
 * retiring it out from under the user mid-denial would be a surprise, not a
 * convenience. The source tab therefore keeps its draft, its denial state,
 * and its artifact binding exactly as they were — "Save as copy" must NEVER
 * mutate what the peer holds — and the fork opens as a SEPARATE tab instead.
 * No lease is taken: a temp id names no server row, so there is nothing to
 * check out.
 */
export async function forkSnippetDraftAsCopy(tabId: string, name: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = { schema_version: 1, language: 'python', code: draft.code };
	// A fork is always a brand-new artifact, so nothing is excluded from the
	// clash check — not even the original it was forked from.
	assertNoNameClash('code_snippet', name, null);
	const tempId = stageArtifactCreate('code_snippet', name, payload, null);
	// Also mints the tab (id `snip:${tempId}`, per PREFIX in workspace.svelte.ts)
	// and activates it — the same helper every "open this artifact" call site uses.
	const newTabId = openArtifactTab('snippet', { artifactId: tempId, title: name });
	_drafts.set(newTabId, { ...draft, name, artifactId: tempId, artifactRev: null, dirty: false });
	repointStagedArtifactSourceTab(tempId, newTabId);
}

/** Discard the local draft and re-fetch the server copy — the recovery path for
 * a tab showing a stale payload (e.g. one opened lock-denied while a peer was
 * editing). Re-runs `ensureSnippetDraft`, so it re-attempts the check-out too. */
export async function reloadSnippetDraft(tabId: string): Promise<void> {
	_drafts.delete(tabId);
	await ensureSnippetDraft(tabId);
}

export function closeSnippetDraft(tabId: string): void {
	const draft = _drafts.get(tabId); // read BEFORE the delete: it owns the lease
	_drafts.delete(tabId);
	_lockDenied.delete(tabId);
	const timer = _lintTimers.get(tabId);
	if (timer !== undefined) {
		clearTimeout(timer);
		_lintTimers.delete(tabId);
	}
	_lint.delete(tabId);
	_runs.delete(tabId);
	bump(_lintGenerations, tabId);
	bump(_runGenerations, tabId);
	// Give the check-out back: no editor is behind this lease. A NO-OP
	// when a staged op still needs it (a saved-but-uncommitted edit must keep its
	// lease or the commit 409s "required lock not held") — that is
	// `releaseArtifactIfUnneeded`'s whole job. A temp id has no server-side row
	// and therefore no lease.
	if (draft?.artifactId && !isTempId(draft.artifactId)) {
		void releaseArtifactIfUnneeded(draft.artifactId).catch(() => {});
	}
}

export function resetSnippetEditors(): void {
	for (const timer of _lintTimers.values()) clearTimeout(timer);
	_lintTimers.clear();
	_drafts.clear();
	_lockDenied.clear();
	_lint.clear();
	_runs.clear();
	// Bump (not clear) — mirrors navigation-editor.resetNavigationEditors: an
	// in-flight response from before the reset must stay stale even if the
	// same tab id is immediately re-created (a cleared counter restarting at 1
	// could collide with a low gen the stale response already captured).
	for (const tabId of _lintGenerations.keys()) bump(_lintGenerations, tabId);
	for (const tabId of _runGenerations.keys()) bump(_runGenerations, tabId);
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
 *    minted: the workspace tab is re-keyed (`bindTabToArtifact`) and every
 *    per-tab key — lint state, run state, pending timers, generations — is
 *    carried across by `rekeySnippetTab`, which is why the new draft must be in
 *    `_drafts` before it is called.
 *
 * Either way the draft adopts the header's `artifact_rev` (display-only now
 * that no save sends it back as an OCC precondition) AND its `entry_points` —
 * which are SERVER-DERIVED from the code's AST, so the commit response is the
 * first time a staged snippet learns them. A header carrying none leaves what
 * the draft already knows in place rather than blanking it.
 */
onArtifactCommit(({ idMap, changed, deletedIds }) => {
	for (const [tabId, draft] of [..._drafts]) {
		if (draft.artifactId === null) continue; // unsaved: nothing committed
		if (deletedIds.includes(draft.artifactId)) {
			closeSnippetDraft(tabId);
			closeTab(tabId);
			continue;
		}
		if (isTempId(draft.artifactId)) {
			const realId = idMap[draft.artifactId];
			if (realId === undefined) continue; // not part of this batch
			const artHeader = changed.find((h) => h.id === realId);
			bindTabToArtifact(tabId, realId);
			const newTab = `snip:${realId}`;
			_drafts.delete(tabId);
			_drafts.set(newTab, {
				...draft,
				artifactId: realId,
				artifactRev: artHeader?.artifact_rev ?? null,
				entryPoints: artHeader?.entry_points ?? draft.entryPoints
			});
			rekeySnippetTab(tabId, newTab);
			_lockDenied.delete(tabId);
		} else {
			const artHeader = changed.find((h) => h.id === draft.artifactId);
			if (artHeader) {
				_drafts.set(tabId, {
					...draft,
					artifactRev: artHeader.artifact_rev,
					entryPoints: artHeader.entry_points ?? draft.entryPoints
				});
			}
		}
	}
});

/**
 * A staged op was DISCARDED — nothing was saved, so the draft goes back to
 * holding unsaved work. A discarded CREATE additionally un-binds: its temp id
 * will never exist, so the draft becomes the unsaved draft it was before Save.
 *
 * The tab KEY is deliberately left alone: a create staged from a draft tab is
 * still sitting in `snip:draft:N`, which names no artifact and therefore cannot
 * collide with the deterministic `snip:<id>` a sidebar reopen would mint.
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
			closeSnippetDraft(tabId);
			closeTab(tabId);
		}
	}
});
