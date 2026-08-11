import {
	diffMetamodel,
	getMetamodelRaw,
	lintMetamodel,
	rebindMetamodel as rebindMetamodelApi
} from '$lib/api/metamodel';
import { ApiError } from '$lib/api/errors';
import type { MetamodelDiff, MetamodelLintError, Rebind } from '$lib/api/types';
import {
	acquireMetamodelLease,
	dropMetamodelLease,
	getMetamodelLockHolder
} from './metamodel-lease.svelte';
import { getRole } from './checkout.svelte';
import { getModelRev } from './model.svelte';
import { isProjectQuiet } from './quiet';

/**
 * The live metamodel editor's state (Phase 5) — buffer, draft, lint,
 * preview, rebind. COMPOSES the `mm` lease module: the lease is acquired on
 * the first divergent edit and released on close/discard/successful rebind.
 * This module never re-implements lease logic and adds no competing guard
 * around lease calls (the lease module's generation guard is the only one
 * for that concern); `_gen` below guards only this module's OWN async
 * (init/lint/preview/rebind) against a closed surface.
 *
 * Draft safety: the dirty buffer mirrors to localStorage per project
 * (`ui.metamodel.draft.<projectId>`), debounced; it survives refreshes and
 * is cleared only by a successful rebind or an explicit discard. The lease
 * does NOT survive a refresh — it re-acquires on the next edit, so a
 * restored draft under a peer's lease opens read-only instead of fighting.
 */

export const METAMODEL_LINT_DEBOUNCE_MS = 500;
export const METAMODEL_DRAFT_DEBOUNCE_MS = 500;

type Phase = 'idle' | 'loading' | 'ready' | 'error';

export interface MetamodelEditorView {
	phase: Phase;
	loadError: string | null;
	source: 'stored' | 'serialized';
	buffer: string;
	dirty: boolean;
	readOnly: boolean;
	lockedBy: string | null;
	draftRestored: boolean;
	lintErrors: MetamodelLintError[];
	preview: MetamodelDiff | null;
	previewCurrent: boolean;
	previewing: boolean;
	previewError: string | null;
	rebinding: boolean;
	rebindError: string | null;
}

let _gen = 0;
let _projectId: string | null = null;
let _phase = $state<Phase>('idle');
let _loadError = $state<string | null>(null);
let _source = $state<'stored' | 'serialized'>('stored');
let _baseline = $state('');
let _buffer = $state('');
let _draftRestored = $state(false);
let _lintErrors = $state<MetamodelLintError[]>([]);
let _preview = $state<MetamodelDiff | null>(null);
let _previewFor = $state<string | null>(null);
let _previewing = $state(false);
let _previewError = $state<string | null>(null);
let _rebinding = $state(false);
let _rebindError = $state<string | null>(null);
let _lockedBy = $state<string | null>(null);
let _leaseHeld = false;
let _acquiring = false;
let _lintTimer: ReturnType<typeof setTimeout> | null = null;
let _draftTimer: ReturnType<typeof setTimeout> | null = null;

function draftKey(projectId: string): string {
	return `ui.metamodel.draft.${projectId}`;
}

// try/catch instead of a `browser` guard — the vitest alias stubs `browser`
// to false; `editor-size.ts` / `workspace.svelte.ts` set the precedent.
function readDraft(projectId: string): string | null {
	try {
		return localStorage.getItem(draftKey(projectId));
	} catch {
		return null;
	}
}

function writeDraftNow(): void {
	if (_projectId === null) return;
	try {
		if (_buffer === _baseline) localStorage.removeItem(draftKey(_projectId));
		else localStorage.setItem(draftKey(_projectId), _buffer);
	} catch {
		/* storage full/denied: the draft simply doesn't persist */
	}
}

function clearDraftStorage(): void {
	if (_projectId === null) return;
	try {
		localStorage.removeItem(draftKey(_projectId));
	} catch {
		/* ignore */
	}
}

function clearTimers(): void {
	if (_lintTimer !== null) clearTimeout(_lintTimer);
	if (_draftTimer !== null) clearTimeout(_draftTimer);
	_lintTimer = null;
	_draftTimer = null;
}

export function isMetamodelEditorDirty(): boolean {
	return _phase === 'ready' && _buffer !== _baseline;
}

function isReadOnly(): boolean {
	return _phase !== 'ready' || getRole() !== 'owner' || _lockedBy !== null;
}

export function getMetamodelEditor(): MetamodelEditorView {
	return {
		phase: _phase,
		loadError: _loadError,
		source: _source,
		buffer: _buffer,
		dirty: isMetamodelEditorDirty(),
		readOnly: isReadOnly(),
		lockedBy: _lockedBy,
		draftRestored: _draftRestored,
		lintErrors: _lintErrors,
		preview: _preview,
		previewCurrent: _preview !== null && _previewFor === _buffer,
		previewing: _previewing,
		previewError: _previewError,
		rebinding: _rebinding,
		rebindError: _rebindError
	};
}

export async function initMetamodelEditor(projectId: string): Promise<void> {
	const gen = ++_gen;
	_projectId = projectId;
	_phase = 'loading';
	_loadError = null;
	try {
		const raw = await getMetamodelRaw();
		if (gen !== _gen) return;
		_baseline = raw.blob;
		_source = raw.source;
		const draft = readDraft(projectId);
		if (draft !== null && draft !== raw.blob) {
			_buffer = draft;
			_draftRestored = true;
		} else {
			if (draft !== null) clearDraftStorage(); // stale: equals baseline
			_buffer = raw.blob;
			_draftRestored = false;
		}
		_phase = 'ready';
	} catch (e) {
		if (gen !== _gen) return;
		_loadError = e instanceof Error ? e.message : String(e);
		_phase = 'error';
	}
}

function maybeAcquireLease(): void {
	if (_leaseHeld || _acquiring || _buffer === _baseline) return;
	_acquiring = true;
	const gen = _gen;
	void acquireMetamodelLease().then((ok) => {
		_acquiring = false;
		if (gen !== _gen) return;
		if (ok) {
			_leaseHeld = true;
			_lockedBy = null;
		} else {
			// Conflict → read-only with the holder's label. A NON-conflict
			// refusal (transient network, etc.) leaves the editor editable:
			// the server honors the lease as backstop, and the next
			// keystroke retries the acquire.
			const holder = getMetamodelLockHolder();
			if (holder !== null) _lockedBy = holder;
		}
	});
}

function scheduleLint(): void {
	if (_lintTimer !== null) clearTimeout(_lintTimer);
	const gen = _gen;
	_lintTimer = setTimeout(() => {
		_lintTimer = null;
		lintMetamodel(_buffer).then(
			(res) => {
				if (gen !== _gen) return;
				_lintErrors = res.ok ? [] : res.errors;
			},
			() => {
				// Advisory: a failed lint call clears the gutter, never blocks.
				if (gen !== _gen) return;
				_lintErrors = [];
			}
		);
	}, METAMODEL_LINT_DEBOUNCE_MS);
}

function scheduleDraftWrite(): void {
	if (_draftTimer !== null) clearTimeout(_draftTimer);
	const gen = _gen;
	_draftTimer = setTimeout(() => {
		_draftTimer = null;
		if (gen !== _gen) return;
		writeDraftNow();
	}, METAMODEL_DRAFT_DEBOUNCE_MS);
}

export function editMetamodelBuffer(code: string): void {
	if (isReadOnly()) return;
	_buffer = code;
	_rebindError = null;
	scheduleDraftWrite();
	scheduleLint();
	maybeAcquireLease();
}

export function retryMetamodelLease(): void {
	_lockedBy = null;
	maybeAcquireLease();
}

export async function previewMetamodelChanges(): Promise<void> {
	if (_phase !== 'ready' || _previewing) return;
	const gen = _gen;
	const buf = _buffer;
	_previewing = true;
	_previewError = null;
	try {
		const diff = await diffMetamodel(buf);
		if (gen !== _gen) return;
		_preview = diff;
		_previewFor = buf;
	} catch (e) {
		if (gen !== _gen) return;
		_previewError =
			e instanceof ApiError && e.status === 422
				? 'The candidate metamodel is invalid.'
				: 'Preview failed; try again.';
	} finally {
		if (gen === _gen) _previewing = false;
	}
}

function rebindErrorMessage(e: unknown): string {
	// Ported verbatim from SwapMetamodelDrawer: three distinct 409 refusals
	// share one status, so branch on the exact structured detail.
	if (e instanceof ApiError && e.status === 409) {
		const body = (typeof e.body === 'object' && e.body ? e.body : {}) as {
			detail?: unknown;
			holder_email?: unknown;
		};
		const detail = typeof body.detail === 'string' ? body.detail : '';
		if (detail === 'metamodel locked') {
			const who =
				typeof body.holder_email === 'string' && body.holder_email
					? body.holder_email
					: 'another user';
			return `Metamodel locked by ${who}. Try again when they finish.`;
		}
		if (detail.startsWith('active locks')) {
			return 'The project is not quiet (a lock is active). Try again once edits are committed.';
		}
		return 'The model changed since you previewed — re-run the preview and try again.';
	}
	if (e instanceof ApiError && e.status === 422) return 'The candidate metamodel is invalid.';
	return 'Rebind failed; no changes were applied.';
}

export async function commitMetamodelRebind(message: string): Promise<Rebind | null> {
	const view = getMetamodelEditor();
	if (getRole() !== 'owner' || !isProjectQuiet() || !view.previewCurrent || _rebinding) {
		return null;
	}
	const gen = _gen;
	_rebinding = true;
	_rebindError = null;
	try {
		const res = await rebindMetamodelApi(_buffer, { baseRev: getModelRev(), message });
		if (gen !== _gen) return null;
		_baseline = _buffer;
		_preview = null;
		_previewFor = null;
		_draftRestored = false;
		clearDraftStorage();
		_leaseHeld = false;
		void dropMetamodelLease();
		return res;
	} catch (e) {
		if (gen !== _gen) return null;
		_rebindError = rebindErrorMessage(e);
		return null;
	} finally {
		if (gen === _gen) _rebinding = false;
	}
}

export function discardMetamodelDraft(): void {
	_buffer = _baseline;
	_draftRestored = false;
	_lintErrors = [];
	_preview = null;
	_previewFor = null;
	_rebindError = null;
	clearDraftStorage();
	if (_leaseHeld) {
		_leaseHeld = false;
		void dropMetamodelLease();
	}
}

/** Tab close / unmount: flush the pending draft write, release the lease,
 * reset to idle. The DRAFT deliberately survives (localStorage). */
export function closeMetamodelEditor(): void {
	writeDraftNow();
	_gen++;
	clearTimers();
	if (_leaseHeld) {
		_leaseHeld = false;
		void dropMetamodelLease();
	}
	_phase = 'idle';
	_lockedBy = null;
	_draftRestored = false;
	_preview = null;
	_previewFor = null;
	_previewError = null;
	_rebindError = null;
	_lintErrors = [];
	_acquiring = false;
}

/** Full reset for tests (does NOT touch the checkout registry). */
export function resetMetamodelEditor(): void {
	_gen++;
	clearTimers();
	_projectId = null;
	_phase = 'idle';
	_loadError = null;
	_source = 'stored';
	_baseline = '';
	_buffer = '';
	_draftRestored = false;
	_lintErrors = [];
	_preview = null;
	_previewFor = null;
	_previewing = false;
	_previewError = null;
	_rebinding = false;
	_rebindError = null;
	_lockedBy = null;
	_leaseHeld = false;
	_acquiring = false;
}
