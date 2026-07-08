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
			// Stale rev — the backend's 409 body carries `current_rev` (see
			// routes/artifacts.py); remember it so the UI can offer reload-and-retry.
			const body = err.body as { current_rev?: number } | undefined;
			_conflicts.set(tabId, body?.current_rev ?? -1);
		}
		throw err;
	}
}

/** Discard the local draft and re-fetch the server copy (409 recovery). */
export async function reloadDraft(tabId: string): Promise<void> {
	_drafts.delete(tabId);
	_previews.delete(tabId);
	_conflicts.delete(tabId);
	await ensureDraft(tabId);
}

export async function runPreview(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
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
		_previews.set(tabId, {
			stepTypes: page.step_types,
			chains: page.chains,
			total: page.total,
			truncated: page.truncated,
			loading: false
		});
	} catch (err) {
		_previews.delete(tabId);
		throw err;
	}
}

export async function loadMorePreview(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	const preview = _previews.get(tabId);
	if (!draft || !preview || preview.loading) return;
	if (preview.chains.length >= preview.total) return;
	_previews.set(tabId, { ...preview, loading: true });
	const page = await api.evaluateNavigation({
		definition: draft.definition,
		limit: PAGE,
		offset: preview.chains.length
	});
	_previews.set(tabId, {
		...preview,
		chains: [...preview.chains, ...page.chains],
		total: page.total,
		truncated: page.truncated,
		loading: false
	});
}

export function closeDraft(tabId: string): void {
	_drafts.delete(tabId);
	_previews.delete(tabId);
	_conflicts.delete(tabId);
}

export function resetNavigationEditors(): void {
	_drafts.clear();
	_previews.clear();
	_conflicts.clear();
}
