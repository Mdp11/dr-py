/**
 * Per-tab code-snippet drafts, keyed by workspace tab id (`snip:draft:<n>` /
 * `snip:<artifactId>`) — the snippet sibling of navigation-editor.svelte.ts.
 * This module owns the draft + save lifecycle; lint and run state (debounced
 * /snippets/lint, run/stop phases, generation guards) live here too (added
 * with the console work). `entryPoints` mirrors the SERVER-derived value
 * (adopted from artifact responses; a run's availability gating uses the
 * live lint response instead) — the client never sends it.
 */
import { SvelteMap } from 'svelte/reactivity';
import * as artifactsApi from '$lib/api/artifacts';
import * as snippetsApi from '$lib/api/snippets';
import type { SnippetRunOut } from '$lib/api/snippets';
import type { SnippetDiagnostic } from '$lib/api/types';
import { ApiError, ConflictError } from '$lib/api/errors';
import { entryAvailable } from '$lib/snippet/entry-stubs';
import { createCodeSnippetArtifact, loadArtifacts } from './artifacts.svelte';
import { bindTabToArtifact, retitleTab } from './workspace.svelte';

export interface SnippetDraft {
	name: string;
	artifactId: string | null;
	artifactRev: number | null;
	code: string;
	dirty: boolean;
	/** Server-derived (artifact responses); [] until first save/load. */
	entryPoints: string[];
}

// New drafts start EMPTY — the "explore via dr" guidance lives in the editor
// as CM placeholder ghost text (CodeEditor.svelte), not as document content
// the user has to delete.
const DEFAULT_CODE = '';

const _drafts = new SvelteMap<string, SnippetDraft>();
const _conflicts = new SvelteMap<string, number>(); // tabId -> server rev

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
		// explain the def value(el)/step(el) contract while the user types it.
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

export function getSnippetSaveConflict(tabId: string): number | undefined {
	return _conflicts.get(tabId);
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
	if (tabId.startsWith('snip:draft:')) {
		draft = {
			name: 'New snippet',
			artifactId: null,
			artifactRev: null,
			code: DEFAULT_CODE,
			dirty: false,
			entryPoints: []
		};
	} else {
		const artifact = await artifactsApi.getArtifact(tabId.slice('snip:'.length));
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

/** Move per-tab state from a draft tab id to its post-save artifact id,
 * including lint/run state. A pending debounced lint is cancelled under the
 * old id and rescheduled under the new one (mirrors
 * navigation-editor.rekeyTab's reschedule discipline); the old id's
 * generations are bumped so any in-flight lint/run response for it is
 * orphaned rather than landing on a tab id nobody reads anymore. */
function rekeySnippetTab(oldTab: string, newTab: string): void {
	const conflict = _conflicts.get(oldTab);
	if (conflict !== undefined) {
		_conflicts.delete(oldTab);
		_conflicts.set(newTab, conflict);
	}
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
						notice: 'Run discarded — the snippet was saved while it was running. Re-run.'
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

export async function saveSnippetDraft(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = { schema_version: 1, language: 'python' as const, code: draft.code };
	try {
		if (draft.artifactId === null) {
			const created = await createCodeSnippetArtifact(draft.name, payload);
			bindTabToArtifact(tabId, created.id);
			const newTab = `snip:${created.id}`;
			_drafts.delete(tabId);
			_drafts.set(newTab, {
				...draft,
				artifactId: created.id,
				artifactRev: created.artifact_rev,
				dirty: false,
				entryPoints:
					created.entry_points ?? payloadEntryPoints(created.payload as Record<string, unknown>)
			});
			rekeySnippetTab(tabId, newTab);
		} else {
			const updated = await artifactsApi.updateArtifact(draft.artifactId, {
				artifact_rev: draft.artifactRev ?? 1,
				name: draft.name,
				payload
			});
			_drafts.set(tabId, {
				...draft,
				artifactRev: updated.artifact_rev,
				dirty: false,
				entryPoints:
					updated.entry_points ?? payloadEntryPoints(updated.payload as Record<string, unknown>)
			});
			_conflicts.delete(tabId);
			await loadArtifacts().catch(() => {});
		}
	} catch (err) {
		// Same structural 409 discrimination as navigation-editor.saveDraft:
		// only an object detail carrying a numeric current_rev is a REV
		// conflict; the create/rename name-clash 409 has a string detail and
		// must NOT enter conflict state (its recovery would wipe the draft).
		if (err instanceof ConflictError) {
			const detail = (err.body as { detail?: unknown } | undefined)?.detail;
			if (
				detail !== null &&
				typeof detail === 'object' &&
				typeof (detail as { current_rev?: unknown }).current_rev === 'number'
			) {
				_conflicts.set(tabId, (detail as { current_rev: number }).current_rev);
			}
		}
		throw err;
	}
}

/** Discard the local draft and re-fetch the server copy (409 recovery). */
export async function reloadSnippetDraft(tabId: string): Promise<void> {
	_drafts.delete(tabId);
	_conflicts.delete(tabId);
	await ensureSnippetDraft(tabId);
}

export function closeSnippetDraft(tabId: string): void {
	_drafts.delete(tabId);
	_conflicts.delete(tabId);
	const timer = _lintTimers.get(tabId);
	if (timer !== undefined) {
		clearTimeout(timer);
		_lintTimers.delete(tabId);
	}
	_lint.delete(tabId);
	_runs.delete(tabId);
	bump(_lintGenerations, tabId);
	bump(_runGenerations, tabId);
}

export function resetSnippetEditors(): void {
	for (const timer of _lintTimers.values()) clearTimeout(timer);
	_lintTimers.clear();
	_drafts.clear();
	_conflicts.clear();
	_lint.clear();
	_runs.clear();
	// Bump (not clear) — mirrors navigation-editor.resetNavigationEditors: an
	// in-flight response from before the reset must stay stale even if the
	// same tab id is immediately re-created (a cleared counter restarting at 1
	// could collide with a low gen the stale response already captured).
	for (const tabId of _lintGenerations.keys()) bump(_lintGenerations, tabId);
	for (const tabId of _runGenerations.keys()) bump(_runGenerations, tabId);
}
