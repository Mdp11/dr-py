/**
 * Per-tab navigation drafts. Keyed by the workspace tab id so several
 * navigations can be open at once. Definitions are edited as plain JSON
 * objects (the backend's NAVIGATION_ADAPTER is the source of truth for
 * validity; the editor keeps them structurally correct by construction).
 * Editing invalidates the preview: chains shown always correspond to the
 * definition on screen.
 */
import { SvelteMap } from 'svelte/reactivity';
import * as api from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import type { NavigationDefinition, TreeItem } from '$lib/api/types';
import { loadArtifacts } from './artifacts.svelte';
import { bindTabToArtifact, retitleTab } from './workspace.svelte';

const PAGE = 100;

export interface NavDraft {
	name: string;
	artifactId: string | null;
	artifactRev: number | null;
	definition: NavigationDefinition;
	dirty: boolean;
}

export interface NavPreview {
	stepTypes: string[];
	chains: TreeItem[][];
	total: number;
	truncated: boolean;
	loading: boolean;
}

const _drafts = new SvelteMap<string, NavDraft>();
const _previews = new SvelteMap<string, NavPreview>();
const _conflicts = new SvelteMap<string, number>(); // tabId -> server rev

/**
 * Per-tab preview generation. Anything that makes an in-flight evaluate
 * response stale — a definition edit, a newer runPreview, closeDraft/reset —
 * bumps the counter; the async preview functions capture it before their
 * await and drop the response on mismatch (or when the draft is gone), so a
 * slow round-trip can never revive a cleared preview or clobber a fresher
 * one. Plain Map: generations are control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _generations = new Map<string, number>();

function bumpGeneration(tabId: string): number {
	const next = (_generations.get(tabId) ?? 0) + 1;
	_generations.set(tabId, next);
	return next;
}

/** True while `gen` is still current for `tabId` and the draft still exists. */
function isCurrent(tabId: string, gen: number): boolean {
	return _generations.get(tabId) === gen && _drafts.has(tabId);
}

export function emptyPath(): NavigationDefinition {
	return {
		kind: 'path',
		schema_version: 1,
		start: { kind: 'scope', types: [], criteria: [] },
		steps: []
	};
}

export function getDraft(tabId: string): NavDraft | undefined {
	return _drafts.get(tabId);
}
export function getPreview(tabId: string): NavPreview | undefined {
	return _previews.get(tabId);
}
export function getSaveConflict(tabId: string): number | undefined {
	return _conflicts.get(tabId);
}

export async function ensureDraft(tabId: string): Promise<NavDraft> {
	const existing = _drafts.get(tabId);
	if (existing) return existing;
	let draft: NavDraft;
	if (tabId.startsWith('nav:draft:')) {
		draft = {
			name: 'New navigation',
			artifactId: null,
			artifactRev: null,
			definition: emptyPath(),
			dirty: false
		};
	} else {
		const id = tabId.slice('nav:'.length);
		const artifact = await api.getArtifact(id);
		draft = {
			name: artifact.name,
			artifactId: artifact.id,
			artifactRev: artifact.artifact_rev,
			definition: artifact.payload as unknown as NavigationDefinition,
			dirty: false
		};
	}
	_drafts.set(tabId, draft);
	return draft;
}

export function updateDefinition(tabId: string, defn: NavigationDefinition): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, definition: defn, dirty: true });
	_previews.delete(tabId); // stale: preview must match what's on screen
	bumpGeneration(tabId); // and any in-flight evaluate response is stale too
}

export function setDraftName(tabId: string, name: string): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, name, dirty: true });
	retitleTab(tabId, name);
}

export async function saveDraft(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = draft.definition as unknown as Record<string, unknown>;
	try {
		if (draft.artifactId === null) {
			const created = await api.createArtifact({
				kind: 'navigation',
				name: draft.name,
				payload
			});
			bindTabToArtifact(tabId, created.id);
			_drafts.delete(tabId);
			_drafts.set(`nav:${created.id}`, {
				...draft,
				artifactId: created.id,
				artifactRev: created.artifact_rev,
				dirty: false
			});
			const preview = _previews.get(tabId);
			_previews.delete(tabId);
			if (preview) _previews.set(`nav:${created.id}`, preview);
		} else {
			const updated = await api.updateArtifact(draft.artifactId, {
				artifact_rev: draft.artifactRev ?? 1,
				name: draft.name,
				payload
			});
			_drafts.set(tabId, { ...draft, artifactRev: updated.artifact_rev, dirty: false });
			_conflicts.delete(tabId);
		}
		await loadArtifacts().catch(() => {});
	} catch (err) {
		if (err instanceof ConflictError) {
			// Two distinct 409 shapes share this status code (routes/artifacts.py):
			// the update-path rev conflict raises detail={message, current_rev: N}
			// (an OBJECT), while the create/rename-path name clash raises a plain
			// STRING detail. Only the former is a rev conflict — entering conflict
			// state for a name clash would route the user to "Reload their
			// version" (NavigationBuilder.svelte), which on a draft tab
			// (ensureDraft on a nav:draft:* id) fabricates a fresh empty
			// definition and wipes their unsaved work, and on a saved tab
			// discards local edits over what is really just a name collision.
			// Detect it structurally: only enter conflict state when detail is an
			// object carrying a numeric current_rev. Anything else (including the
			// string-detail name clash) is left to the generic saveError path in
			// NavigationBuilder.svelte, whose message text (via messageFromBody)
			// is already the correct, user-facing one.
			const body = err.body as { detail?: unknown } | undefined;
			const detail = body?.detail;
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
export async function reloadDraft(tabId: string): Promise<void> {
	_drafts.delete(tabId);
	_previews.delete(tabId);
	_conflicts.delete(tabId);
	bumpGeneration(tabId); // the definition is about to change
	await ensureDraft(tabId);
}

export async function runPreview(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const gen = bumpGeneration(tabId); // supersede any older in-flight evaluate
	_previews.set(tabId, {
		stepTypes: [],
		chains: [],
		total: 0,
		truncated: false,
		loading: true
	});
	try {
		const page = await api.evaluateNavigation({
			definition: draft.definition,
			limit: PAGE,
			offset: 0
		});
		if (!isCurrent(tabId, gen)) return; // stale: edited/closed mid-flight
		_previews.set(tabId, {
			stepTypes: page.step_types,
			chains: page.chains,
			total: page.total,
			truncated: page.truncated,
			loading: false
		});
	} catch (err) {
		if (isCurrent(tabId, gen)) _previews.delete(tabId);
		throw err;
	}
}

export async function loadMorePreview(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	const preview = _previews.get(tabId);
	if (!draft || !preview || preview.loading) return;
	if (preview.chains.length >= preview.total) return;
	const gen = _generations.get(tabId) ?? 0; // extend the CURRENT preview only
	_previews.set(tabId, { ...preview, loading: true });
	try {
		const page = await api.evaluateNavigation({
			definition: draft.definition,
			limit: PAGE,
			offset: preview.chains.length
		});
		if (!isCurrent(tabId, gen)) return; // stale: edited/re-run/closed mid-flight
		_previews.set(tabId, {
			...preview,
			chains: [...preview.chains, ...page.chains],
			total: page.total,
			truncated: page.truncated,
			loading: false
		});
	} catch {
		// Swallow: the caller fires this with `void` (no catch), and losing one
		// page is recoverable — restore loading so Load more can be retried.
		if (isCurrent(tabId, gen)) _previews.set(tabId, { ...preview, loading: false });
	}
}

export function closeDraft(tabId: string): void {
	_drafts.delete(tabId);
	_previews.delete(tabId);
	_conflicts.delete(tabId);
	bumpGeneration(tabId); // orphan any in-flight evaluate for this tab
}

export function resetNavigationEditors(): void {
	_drafts.clear();
	_previews.clear();
	_conflicts.clear();
	// Bump (not clear) so in-flight responses from before the reset stay stale
	// even if the same tab id is immediately re-opened.
	for (const tabId of _generations.keys()) bumpGeneration(tabId);
}
