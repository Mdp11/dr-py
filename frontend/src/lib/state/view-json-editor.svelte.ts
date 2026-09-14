import * as viewsApi from '$lib/api/views';
import { ApiError, ConflictError, NotFoundError } from '$lib/api/errors';
import type { MetamodelLintError } from '$lib/api/types';
import { adoptSavedView } from './view.svelte';
import { getStagedViewOps } from './view-edits.svelte';

/**
 * The view JSON editor — the metamodel editor's buffer/baseline/draft shape
 * applied to ONE named view's document, with an explicit Save instead of a
 * staged op: `PUT /views/{id}` replaces the document directly (never
 * journaled), so edits are invisible to the sidebar until Save lands.
 *
 * A singleton bound to one view at a time (`_viewId`). No lease: the server
 * honors peer `view:`/`folder:` leases on save, and `base_view_rev` makes a
 * document that moved since load a 409 instead of a silent overwrite.
 *
 * Draft safety mirrors the metamodel editor: a dirty buffer is mirrored to
 * localStorage (`ui.view.draft.<projectId>.<viewId>`), debounced, and cleared
 * only by a successful save or an explicit discard.
 */

export const VIEW_JSON_PARSE_DEBOUNCE_MS = 300;
export const VIEW_JSON_DRAFT_DEBOUNCE_MS = 500;

type Phase = 'idle' | 'loading' | 'ready' | 'error';

export interface ViewJsonEditorView {
	phase: Phase;
	viewId: string | null;
	loadError: string | null;
	buffer: string;
	dirty: boolean;
	draftRestored: boolean;
	parseErrors: MetamodelLintError[];
	saving: boolean;
	saveError: string | null;
	/** The server document moved since load (a peer save or a folder commit). */
	stale: boolean;
}

let _gen = 0;
let _projectId: string | null = null;
let _viewId = $state<string | null>(null);
let _phase = $state<Phase>('idle');
let _loadError = $state<string | null>(null);
let _baseline = $state('');
let _baseRev = $state<number | null>(null);
let _buffer = $state('');
let _draftRestored = $state(false);
let _parseErrors = $state<MetamodelLintError[]>([]);
let _saving = $state(false);
let _saveError = $state<string | null>(null);
let _stale = $state(false);
let _parseTimer: ReturnType<typeof setTimeout> | null = null;
let _draftTimer: ReturnType<typeof setTimeout> | null = null;

function draftKey(projectId: string, viewId: string): string {
	return `ui.view.draft.${projectId}.${viewId}`;
}

function readDraft(projectId: string, viewId: string): string | null {
	try {
		return localStorage.getItem(draftKey(projectId, viewId));
	} catch {
		return null;
	}
}

function writeDraftNow(): void {
	if (_projectId === null || _viewId === null) return;
	try {
		const key = draftKey(_projectId, _viewId);
		if (_buffer === _baseline) localStorage.removeItem(key);
		else localStorage.setItem(key, _buffer);
	} catch {
		/* storage full/denied: the draft simply doesn't persist */
	}
}

function clearDraftStorage(): void {
	if (_projectId === null || _viewId === null) return;
	try {
		localStorage.removeItem(draftKey(_projectId, _viewId));
	} catch {
		/* ignore */
	}
}

function clearTimers(): void {
	if (_parseTimer !== null) clearTimeout(_parseTimer);
	if (_draftTimer !== null) clearTimeout(_draftTimer);
	_parseTimer = null;
	_draftTimer = null;
}

export function pretty(doc: unknown): string {
	return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * Parse `text` as a view document. Returns the object, or an error anchored
 * to a line/column when the engine's message carries a position (V8 reports
 * `at position N`, sometimes with `(line L column C)`).
 */
export function parseViewJson(
	text: string
): { ok: true; doc: Record<string, unknown> } | { ok: false; error: MetamodelLintError } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const lc = /line (\d+) column (\d+)/.exec(message);
		if (lc) {
			return { ok: false, error: { message, line: Number(lc[1]), column: Number(lc[2]) } };
		}
		const pos = /position (\d+)/.exec(message);
		if (pos) {
			const before = text.slice(0, Number(pos[1]));
			const line = before.split('\n').length;
			const column = before.length - before.lastIndexOf('\n');
			return { ok: false, error: { message, line, column } };
		}
		return { ok: false, error: { message, line: null, column: null } };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {
			ok: false,
			error: { message: 'A view document must be a JSON object.', line: null, column: null }
		};
	}
	return { ok: true, doc: parsed as Record<string, unknown> };
}

export function isViewJsonEditorDirty(): boolean {
	return _phase === 'ready' && _buffer !== _baseline;
}

export function getViewJsonEditorViewId(): string | null {
	return _viewId;
}

export function getViewJsonEditor(): ViewJsonEditorView {
	return {
		phase: _phase,
		viewId: _viewId,
		loadError: _loadError,
		buffer: _buffer,
		dirty: isViewJsonEditorDirty(),
		draftRestored: _draftRestored,
		parseErrors: _parseErrors,
		saving: _saving,
		saveError: _saveError,
		stale: _stale
	};
}

/** Load `viewId`'s current document as the baseline, restoring a stored draft. */
export async function initViewJsonEditor(projectId: string, viewId: string): Promise<void> {
	const gen = ++_gen;
	clearTimers();
	_projectId = projectId;
	_viewId = viewId;
	_phase = 'loading';
	_loadError = null;
	_saveError = null;
	_stale = false;
	_parseErrors = [];
	try {
		const res = await viewsApi.getView(viewId);
		if (gen !== _gen) return;
		_baseline = pretty(res.view);
		_baseRev = res.view_rev;
		const draft = readDraft(projectId, viewId);
		if (draft !== null && draft !== _baseline) {
			_buffer = draft;
			_draftRestored = true;
			reparse();
		} else {
			if (draft !== null) clearDraftStorage();
			_buffer = _baseline;
			_draftRestored = false;
		}
		_phase = 'ready';
	} catch (e) {
		if (gen !== _gen) return;
		_loadError =
			e instanceof NotFoundError
				? 'This view no longer exists.'
				: e instanceof Error
					? e.message
					: String(e);
		_phase = 'error';
	}
}

function reparse(): void {
	const res = parseViewJson(_buffer);
	_parseErrors = res.ok ? [] : [res.error];
}

export function editViewJsonBuffer(code: string): void {
	if (_phase !== 'ready') return;
	_buffer = code;
	_saveError = null;
	if (_parseTimer !== null) clearTimeout(_parseTimer);
	const gen = _gen;
	_parseTimer = setTimeout(() => {
		_parseTimer = null;
		if (gen === _gen) reparse();
	}, VIEW_JSON_PARSE_DEBOUNCE_MS);
	if (_draftTimer !== null) clearTimeout(_draftTimer);
	_draftTimer = setTimeout(() => {
		_draftTimer = null;
		if (gen === _gen) writeDraftNow();
	}, VIEW_JSON_DRAFT_DEBOUNCE_MS);
}

/**
 * `PUT /views/{id}` with the buffer. Refused client-side while folder edits
 * against this view are staged: those ops name folders by id, and replacing
 * the document under them would drop the journal at the next refetch.
 */
export async function saveViewJson(): Promise<boolean> {
	if (_phase !== 'ready' || _saving || _viewId === null) return false;
	const viewId = _viewId;
	if (getStagedViewOps().some((op) => op.view_id === viewId)) {
		_saveError = 'Commit or discard your staged folder changes to this view before saving.';
		return false;
	}
	const parsed = parseViewJson(_buffer);
	if (!parsed.ok) {
		_parseErrors = [parsed.error];
		_saveError = 'Fix the JSON syntax error before saving.';
		return false;
	}
	const gen = _gen;
	const sent = _buffer;
	_saving = true;
	_saveError = null;
	try {
		await viewsApi.updateView(viewId, { view: parsed.doc, base_view_rev: _baseRev });
		if (gen !== _gen) return true;
		// Adopt the server's canonical form (healed folder ids, trimmed name).
		const res = await viewsApi.getView(viewId);
		if (gen !== _gen) return true;
		_baseline = pretty(res.view);
		_baseRev = res.view_rev;
		_stale = false;
		_draftRestored = false;
		if (_buffer === sent) {
			_buffer = _baseline;
			clearDraftStorage();
		} else {
			// typed during the round-trip: keep those characters as a draft
			writeDraftNow();
		}
		await adoptSavedView(viewId);
		return true;
	} catch (e) {
		if (gen !== _gen) return false;
		_saveError = e instanceof ApiError ? e.message : 'Save failed; try again.';
		if (e instanceof ConflictError) void checkStale(gen);
		return false;
	} finally {
		if (gen === _gen) _saving = false;
	}
}

/** Abandon the draft and reload the server's current document. */
export async function discardViewJsonDraft(): Promise<void> {
	if (_projectId === null || _viewId === null) return;
	clearDraftStorage();
	_buffer = _baseline;
	await initViewJsonEditor(_projectId, _viewId);
}

/**
 * The server document changed under the editor (a feed `view` update or a
 * `view`-scoped commit). A clean editor silently adopts it; a dirty one keeps
 * the buffer and flags `stale`, so Save's 409 is expected rather than a surprise.
 */
export function noteViewJsonServerChanged(viewId: string | null): void {
	if (_phase !== 'ready' || _viewId === null || _saving) return;
	if (viewId !== null && viewId !== _viewId) return;
	void checkStale(_gen);
}

/** Refetch the document; when its rev moved, adopt it under a clean buffer
 * (in place — no loading phase, so the editor never remounts) or flag
 * `stale` under a dirty one. Its own save's feed echo finds the rev unmoved. */
async function checkStale(gen: number): Promise<void> {
	if (_viewId === null) return;
	let res: Awaited<ReturnType<typeof viewsApi.getView>>;
	try {
		res = await viewsApi.getView(_viewId);
	} catch {
		return;
	}
	if (gen !== _gen || _phase !== 'ready' || _saving || res.view_rev === _baseRev) return;
	const next = pretty(res.view);
	if (isViewJsonEditorDirty()) {
		_stale = true;
		return;
	}
	_baseline = next;
	_buffer = next;
	_baseRev = res.view_rev;
	_stale = false;
}

/** Tab close / unmount: flush the pending draft write and go idle. */
export function closeViewJsonEditor(): void {
	if (_phase === 'ready') writeDraftNow();
	resetViewJsonEditor();
}

/** Full in-memory reset (project re-entry, tests); drafts stay in storage. */
export function resetViewJsonEditor(): void {
	_gen++;
	clearTimers();
	_projectId = null;
	_viewId = null;
	_phase = 'idle';
	_loadError = null;
	_baseline = '';
	_baseRev = null;
	_buffer = '';
	_draftRestored = false;
	_parseErrors = [];
	_saving = false;
	_saveError = null;
	_stale = false;
}
