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
import { ConflictError } from '$lib/api/errors';
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

const DEFAULT_CODE =
	'# Explore the model through the `dr` facade, e.g.:\n' +
	'# for el in dr.elements():\n' +
	'#     print(el.type, el.name)\n';

const _drafts = new SvelteMap<string, SnippetDraft>();
const _conflicts = new SvelteMap<string, number>(); // tabId -> server rev

export function getSnippetDraft(tabId: string): SnippetDraft | undefined {
	return _drafts.get(tabId);
}

export function getSnippetSaveConflict(tabId: string): number | undefined {
	return _conflicts.get(tabId);
}

/** Unlike `hasDirtyNavDrafts`/`hasDirtyTableDrafts` (which only look at the
 * `dirty` flag — those tabs' default definitions are structurally trivial), a
 * never-saved snippet draft (`artifactId === null`) counts too: its starting
 * `DEFAULT_CODE` is real explanatory content the user would lose, matching
 * `isTabDirty`'s `draft.artifactId === null` rule. */
export function hasDirtySnippetDrafts(): boolean {
	for (const d of _drafts.values()) if (d.dirty || d.artifactId === null) return true;
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
	return draft;
}

export function updateSnippetCode(tabId: string, code: string): void {
	const draft = _drafts.get(tabId);
	if (!draft || draft.code === code) return;
	_drafts.set(tabId, { ...draft, code, dirty: true });
}

export function setSnippetName(tabId: string, name: string): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, name, dirty: true });
	retitleTab(tabId, name);
}

/** Move per-tab state from a draft tab id to its post-save artifact id.
 * Task 4 extends this to carry lint/run state + timers/generations. */
function rekeySnippetTab(oldTab: string, newTab: string): void {
	const conflict = _conflicts.get(oldTab);
	if (conflict !== undefined) {
		_conflicts.delete(oldTab);
		_conflicts.set(newTab, conflict);
	}
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
}

export function resetSnippetEditors(): void {
	_drafts.clear();
	_conflicts.clear();
}
