/**
 * Per-tab table drafts. Keyed by the workspace tab id so several table
 * editors can be open at once. This is the SIMPLER sibling of
 * `navigation-editor.svelte.ts`: a table has exactly ONE page per tab (no
 * per-node previews, no expand/collapse tree, no debounced auto-run), so all
 * state here is keyed by `tabId` alone.
 *
 * Definitions are edited as plain JSON objects (the backend's
 * `TableDefinitionSchema` is the source of truth for validity; `columns.ts`
 * keeps definitions structurally correct by construction). Editing invalidates
 * the loaded page: `updateTableDefinition` and `setTableSort` both reset to
 * offset 0 and re-request the page. There is no auto-run debounce — the caller
 * (the table editor UI) decides when to call `updateTableDefinition`.
 *
 * Staleness is guarded by a per-TAB generation counter (mirrors nav-editor's
 * `_generations`, just without the per-node keying): anything that makes an
 * in-flight `evaluateTable` response stale — a new `loadTablePage` call, a
 * reload, a close, a reset — bumps the tab's generation, and the async loader
 * drops the response on mismatch (or when the draft is gone).
 */
import { SvelteMap } from 'svelte/reactivity';
import * as api from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import { evaluateTable, exportTable } from '$lib/api/tables';
import {
	TableDefinitionSchema,
	type TableDefinition,
	type TablePage,
	type TableSort
} from '$lib/api/types';
import { loadArtifacts } from './artifacts.svelte';
import { bindTabToArtifact, retitleTab } from './workspace.svelte';

const PAGE = 100;

export interface TableDraft {
	name: string;
	artifactId: string | null;
	artifactRev: number | null;
	definition: TableDefinition;
	dirty: boolean;
}

function emptyDefinition(): TableDefinition {
	return {
		schema_version: 1,
		default_cell_mode: 'collapse',
		row_source: { kind: 'scope', types: [], criteria: [] },
		columns: [
			{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null }
		]
	};
}

const _drafts = new SvelteMap<string, TableDraft>();
/** tabId -> the one loaded page. */
const _pages = new SvelteMap<string, TablePage>();
/** tabId -> the active sort (undefined = no sort). */
const _sorts = new SvelteMap<string, TableSort>();
const _loading = new SvelteMap<string, boolean>();
/** tabId -> the last load's error message (422/500). */
const _errors = new SvelteMap<string, string>();
const _conflicts = new SvelteMap<string, number>(); // tabId -> server rev

/**
 * Per-TAB page-load generation. Control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _generations = new Map<string, number>();

function bumpGeneration(tabId: string): number {
	const next = (_generations.get(tabId) ?? 0) + 1;
	_generations.set(tabId, next);
	return next;
}

/** True while `gen` is still current for `tabId` and its draft exists. */
function isCurrent(tabId: string, gen: number): boolean {
	return _generations.get(tabId) === gen && _drafts.has(tabId);
}

/**
 * Move every per-tab entry (page, sort, loading, error, generation) from
 * `oldTab` to `newTab`. Used by the first-save path, where a `tbl:draft:*`
 * tab is rebound to `tbl:<id>`. The draft itself is moved separately by the
 * caller (it also gets new artifact fields, not a plain carry-over).
 */
function moveTabState(oldTab: string, newTab: string): void {
	const page = _pages.get(oldTab);
	_pages.delete(oldTab);
	if (page !== undefined) _pages.set(newTab, page);

	const sort = _sorts.get(oldTab);
	_sorts.delete(oldTab);
	if (sort !== undefined) _sorts.set(newTab, sort);

	const loading = _loading.get(oldTab);
	_loading.delete(oldTab);
	if (loading !== undefined) _loading.set(newTab, loading);

	const error = _errors.get(oldTab);
	_errors.delete(oldTab);
	if (error !== undefined) _errors.set(newTab, error);

	const gen = _generations.get(oldTab);
	_generations.delete(oldTab);
	if (gen !== undefined) _generations.set(newTab, gen);
}

export function getTableDraft(tabId: string): TableDraft | undefined {
	return _drafts.get(tabId);
}
export function getTablePage(tabId: string): TablePage | undefined {
	return _pages.get(tabId);
}
export function getTableSort(tabId: string): TableSort | undefined {
	return _sorts.get(tabId);
}
export function getTableLoading(tabId: string): boolean {
	return _loading.get(tabId) ?? false;
}
export function getTableError(tabId: string): string | undefined {
	return _errors.get(tabId);
}
export function getTableConflict(tabId: string): number | undefined {
	return _conflicts.get(tabId);
}

export async function ensureTableDraft(tabId: string): Promise<TableDraft> {
	const existing = _drafts.get(tabId);
	if (existing) return existing;
	if (tabId.startsWith('tbl:draft:')) {
		const draft: TableDraft = {
			name: 'New table',
			artifactId: null,
			artifactRev: null,
			definition: emptyDefinition(),
			dirty: false
		};
		_drafts.set(tabId, draft);
		return draft;
	}
	const id = tabId.slice('tbl:'.length);
	const artifact = await api.getArtifact(id);
	const draft: TableDraft = {
		name: artifact.name,
		artifactId: artifact.id,
		artifactRev: artifact.artifact_rev,
		definition: TableDefinitionSchema.parse(artifact.payload),
		dirty: false
	};
	_drafts.set(tabId, draft);
	await loadTablePage(tabId, 0);
	return draft;
}

/**
 * (Re)fetch the table's page at `offset`, guarded by the per-tab generation
 * counter. A fresh call always clears any stale error first — the error slot
 * must match what's on screen, same rule as nav-editor's eval-error flag.
 */
export async function loadTablePage(tabId: string, offset: number): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const gen = bumpGeneration(tabId); // supersede any older in-flight load
	_errors.delete(tabId);
	_loading.set(tabId, true);
	const sort = _sorts.get(tabId);
	const args =
		draft.artifactId === null
			? { definition: draft.definition, offset, limit: PAGE, sort }
			: { artifactId: draft.artifactId, offset, limit: PAGE, sort };
	try {
		const page = await evaluateTable(args);
		if (!isCurrent(tabId, gen)) return; // stale: edited/reloaded/closed mid-flight
		_pages.set(tabId, page);
		_loading.set(tabId, false);
	} catch (err) {
		if (isCurrent(tabId, gen)) {
			_errors.set(tabId, err instanceof Error ? err.message : String(err));
			_loading.set(tabId, false);
		}
	}
}

export function updateTableDefinition(tabId: string, defn: TableDefinition): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, definition: defn, dirty: true });
	void loadTablePage(tabId, 0);
}

export function setTableSort(tabId: string, sort: TableSort | undefined): void {
	if (sort === undefined) _sorts.delete(tabId);
	else _sorts.set(tabId, sort);
	void loadTablePage(tabId, 0);
}

export function setTableName(tabId: string, name: string): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, name, dirty: true });
	retitleTab(tabId, name);
}

export async function saveTableDraft(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = draft.definition as unknown as Record<string, unknown>;
	try {
		if (draft.artifactId === null) {
			const created = await api.createArtifact({ kind: 'table', name: draft.name, payload });
			bindTabToArtifact(tabId, created.id);
			const newTab = `tbl:${created.id}`;
			_drafts.delete(tabId);
			_drafts.set(newTab, {
				...draft,
				artifactId: created.id,
				artifactRev: created.artifact_rev,
				dirty: false
			});
			moveTabState(tabId, newTab);
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
			// STRING detail. Only the former is a rev conflict — see the identical
			// discrimination in navigation-editor.svelte.ts's saveDraft.
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

/**
 * Fork the current draft into a NEW library artifact under `name`, rebind
 * `tabId` to the copy, and leave any original artifact untouched. Mirrors
 * `navigation-editor.svelte.ts`'s `saveAsDraft`.
 */
export async function saveAsTableDraft(tabId: string, name: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = draft.definition as unknown as Record<string, unknown>;
	const created = await api.createArtifact({ kind: 'table', name, payload });
	bindTabToArtifact(tabId, created.id);
	const newTab = `tbl:${created.id}`;
	retitleTab(newTab, name);
	_drafts.delete(tabId);
	_conflicts.delete(tabId);
	_drafts.set(newTab, {
		...draft,
		name,
		artifactId: created.id,
		artifactRev: created.artifact_rev,
		dirty: false
	});
	moveTabState(tabId, newTab);
	await loadArtifacts().catch(() => {});
}

/** Discard the local draft and re-fetch the server copy (409 recovery). */
export async function reloadTableDraft(tabId: string): Promise<void> {
	_drafts.delete(tabId);
	_pages.delete(tabId);
	_sorts.delete(tabId);
	_loading.delete(tabId);
	_errors.delete(tabId);
	_conflicts.delete(tabId);
	bumpGeneration(tabId); // orphan any in-flight load for the old draft
	await ensureTableDraft(tabId);
}

export function closeTableDraft(tabId: string): void {
	_drafts.delete(tabId);
	_pages.delete(tabId);
	_sorts.delete(tabId);
	_loading.delete(tabId);
	_errors.delete(tabId);
	_conflicts.delete(tabId);
	bumpGeneration(tabId); // orphan any in-flight load
}

/** Export the current definition (or saved artifact) as an .xlsx and trigger
 * a browser download via a synthetic anchor click. */
export async function downloadTable(tabId: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const sort = _sorts.get(tabId);
	const args =
		draft.artifactId === null
			? { definition: draft.definition, sort }
			: { artifactId: draft.artifactId, sort };
	const { blob, filename } = await exportTable(args);
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

export function resetTableEditors(): void {
	_drafts.clear();
	_pages.clear();
	_sorts.clear();
	_loading.clear();
	_errors.clear();
	_conflicts.clear();
	// Bump (not clear) so in-flight responses from before the reset stay stale
	// even if the same tab id is immediately re-created.
	for (const key of _generations.keys()) bumpGeneration(key);
}
