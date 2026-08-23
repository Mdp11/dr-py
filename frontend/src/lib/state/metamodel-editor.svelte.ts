import { diffMetamodel, getMetamodelRaw, lintMetamodel } from '$lib/api/metamodel';
import { ApiError } from '$lib/api/errors';
import type { MetamodelDiff, MetamodelLintError } from '$lib/api/types';
import {
	acquireMetamodelLease,
	dropMetamodelLease,
	getMetamodelLockHolder
} from './metamodel-lease.svelte';
import { getRole } from './checkout.svelte';
import {
	onMetamodelCommitted,
	onMetamodelDiscardAll,
	registerMetamodelDraftProvider
} from './metamodel-stage.svelte';

/**
 * The live metamodel editor's state — buffer, draft, lint,
 * preview. COMPOSES the `mm` lease module: the lease is acquired on
 * the first divergent keystroke and released on close/discard/committed rebind.
 * It is NOT the only acquirer — `metamodel-diagram.svelte.ts` takes the same
 * lease on the first node drag (layout moves are staged by editors, who never
 * pass this module's owner gate) and reports a peer conflict back here through
 * {@link noteMetamodelLockConflict}.
 * This module never re-implements lease logic and adds no competing guard
 * around lease calls (the lease module's generation guard is the only one
 * for that concern); `_gen` below guards only this module's OWN async
 * (init/lint/preview) against a closed surface.
 *
 * Draft safety: the dirty buffer mirrors to localStorage per project
 * (`ui.metamodel.draft.<projectId>`), debounced; it survives refreshes and
 * is cleared only by a committed rebind that adopted it, or an explicit
 * discard. The lease does NOT survive a refresh — it re-acquires on the next
 * edit, so a restored draft opens EDITABLE even under a peer's lease; the
 * first keystroke's acquire is what discovers the conflict, and only then
 * does the editor turn read-only (keeping the characters already typed).
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

/**
 * Whether the metamodel may be edited at all — BOTH the gate on a keystroke
 * that already happened and the SURFACE's read-only state (what the tab
 * renders and what CodeMirror enforces). One predicate for both: a rebind is
 * an op in the commit batch, and `commitStaged` neither blocks the buffer
 * nor needs it frozen — it captures the blob it SENDS, and the
 * {@link onMetamodelCommitted} listener adopts only that text as the new
 * baseline, so a straggler keystroke stays dirty local work rather than
 * being silently called saved.
 */
function isEditBlocked(): boolean {
	return _phase !== 'ready' || getRole() !== 'owner' || _lockedBy !== null;
}

export function getMetamodelEditor(): MetamodelEditorView {
	return {
		phase: _phase,
		loadError: _loadError,
		source: _source,
		buffer: _buffer,
		dirty: isMetamodelEditorDirty(),
		readOnly: isEditBlocked(),
		lockedBy: _lockedBy,
		draftRestored: _draftRestored,
		lintErrors: _lintErrors,
		preview: _preview,
		previewCurrent: _preview !== null && _previewFor === _buffer,
		previewing: _previewing,
		previewError: _previewError
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
	if (isEditBlocked()) return;
	_buffer = code;
	scheduleDraftWrite();
	scheduleLint();
	maybeAcquireLease();
}

/**
 * "A peer holds the `mm` lease" — reported by a surface OTHER than this buffer.
 * The DIAGRAM's layout acquire is the only caller: layout moves are staged
 * by EDITORS too, so the canvas acquires the same
 * singleton lease and can be the first to learn it is taken.
 *
 * The holder lives here, and is not duplicated in the diagram module, because
 * `_lockedBy` is ONE fact about the metamodel rather than a per-surface one:
 * it is what {@link isEditBlocked} reads, what the tab's "locked by" strip
 * renders, and — decisively — what {@link retryMetamodelLease} clears. A second
 * copy next door would keep the canvas refusing to stage after a Retry that
 * this module already considers resolved.
 */
export function noteMetamodelLockConflict(holder: string): void {
	_lockedBy = holder;
	// Provably not held by us: `ensureCheckout` answers a held resource from the
	// registry without a request, so only a session holding nothing can be
	// refused. Clearing the flag keeps the next edit's `maybeAcquireLease` (and
	// `retryMetamodelLease`) able to re-attempt.
	_leaseHeld = false;
}

export function retryMetamodelLease(): void {
	_lockedBy = null;
	maybeAcquireLease();
}

export async function previewMetamodelChanges(): Promise<void> {
	// `_previewing`: one preview at a time. A rebind is an op in the commit
	// batch, so there is no window in which a preview could compute against a
	// metamodel that is mid-swap.
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

/**
 * Abandon the draft: adopt the baseline, drop the stored copy, hand the lease
 * back. Called from the metamodel tab's "Discard changes" (paired there with
 * `discardStagedNodeMoves`, the moves half of the same family) and, through
 * the {@link onMetamodelDiscardAll} registration at the bottom of this module,
 * from the commit drawer's Discard-all and its Metamodel section's button.
 */
export function discardMetamodelDraft(): void {
	_buffer = _baseline;
	_draftRestored = false;
	_lintErrors = [];
	_preview = null;
	_previewFor = null;
	clearDraftStorage();
	// UNCONDITIONAL, not `if (_leaseHeld)` — see closeMetamodelEditor.
	_leaseHeld = false;
	void dropMetamodelLease();
}

/** Tab close / unmount: flush the pending draft write, release the lease,
 * reset to idle. The DRAFT deliberately survives (localStorage). */
export function closeMetamodelEditor(): void {
	// Flush ONLY from `ready`. In `loading`/`error` the baseline is still ''
	// and equals the buffer, which sends writeDraftNow down its removeItem
	// branch — deleting a draft the user neither rebound nor discarded, just
	// because they closed a tab whose load was slow or failed.
	if (_phase === 'ready') writeDraftNow();
	_gen++;
	clearTimers();
	// BEFORE the lease drop, and that ordering is load-bearing:
	// `releaseMetamodelLease` refuses to release while
	// `getStagedMetamodelDepth() > 0`, and this module's contribution to that
	// depth is `isMetamodelEditorDirty()`, which is false outside `ready`. A
	// CLOSED tab therefore stages no rebind op — so it must not keep the `mm`
	// lease either, or a close over a dirty draft strands a lease nothing
	// staged needs, with the checkout heartbeat renewing it for the rest of
	// the session and every peer locked out (the exact leak the comment below
	// exists to prevent). Staged NODE MOVES still hold it, correctly: they
	// outlive the tab and do stage ops.
	_phase = 'idle';
	// UNCONDITIONAL, not `if (_leaseHeld)`: an acquire IN FLIGHT is exactly
	// the window this exists for, and `_leaseHeld` is false throughout it.
	// `dropMetamodelLease` is what bumps the lease module's generation, and
	// that bump is the only thing that makes a late grant hand itself back.
	// Skip it and the grant lands in the checkout registry with nobody left
	// to release it — and it is NOT bounded by the server TTL, because a
	// non-empty registry keeps the checkout heartbeat renewing it for the
	// rest of the session, locking every peer out of the metamodel.
	_leaseHeld = false;
	void dropMetamodelLease();
	_loadError = null;
	_lockedBy = null;
	_draftRestored = false;
	_preview = null;
	_previewFor = null;
	// The preview's async `finally` is generation-guarded, so a close mid-flight
	// never runs it: reset here or the flag latches true and every later preview
	// early-returns for the rest of the session.
	_previewing = false;
	_previewError = null;
	_lintErrors = [];
	_acquiring = false;
}

// --- commit-flow seam --------------------------------------------------------
//
// The buffer is staged commit CONTENT now: a dirty draft becomes a
// `metamodel.rebind` op in the next `POST /commits` batch. All three halves
// are REGISTRATIONS on `metamodel-stage.svelte.ts` rather than direct calls,
// because checkout is what builds and lands that batch and it must never
// import this module (`checkout → stage → editor → checkout`). Module scope,
// not `initMetamodelEditor`: the stage may be asked for the batch before —
// or after — any particular tab mount, and the provider's own `_phase` guard
// (via {@link isMetamodelEditorDirty}) already answers "nothing staged" for
// every non-`ready` state.

registerMetamodelDraftProvider(() => ({
	dirty: isMetamodelEditorDirty(),
	blob: _buffer
}));

onMetamodelCommitted(({ rebound, blob }) => {
	// Mirrors the server's rebind-success body: it has adopted `blob`,
	// whatever the buffer holds now.
	if (blob === null || _phase !== 'ready') return;
	_baseline = blob;
	// A rebind always stores a blob, so a session that loaded through the
	// degraded "serialized" fallback is no longer looking at one.
	_source = 'stored';
	// The preview described `blob` against the PREVIOUS metamodel — spent.
	_preview = null;
	_previewFor = null;
	// Any remaining divergence was typed in THIS session, not restored.
	_draftRestored = false;
	if (_buffer === blob) clearDraftStorage();
	// The buffer moved mid-flight: those characters are unreviewed local changes
	// ON TOP of the freshly bound metamodel, so the editor stays dirty and keeps
	// its draft. Flushed NOW rather than on the debounce — a mid-flight Discard
	// actively removed the key, and a close before the timer fires would
	// otherwise take the work with it.
	else writeDraftNow();
	_leaseHeld = false; // the commit surrendered the mm token server-side
	void rebound; // metamodel/issue refetch is checkout's adoptReboundMetamodel
});

// Discard-all (the commit drawer's button, via `checkout.svelte.ts`'s
// `discardAll`). The moves half is wiped by checkout directly — it lives in the
// stage module — and this listener is how the DRAFT half is reached without
// checkout importing this module. Same call the tab's own Discard makes, so
// the two surfaces cannot drift.
onMetamodelDiscardAll(() => discardMetamodelDraft());

/**
 * Full reset: forget the buffer, the baseline, the project and the phase.
 *
 * Two callers. Tests use it for isolation, and PROJECT (RE)ENTRY uses it —
 * `p/[projectId]/+page.svelte`'s `boot()`, right beside `closeMetamodelStage()`
 * — because this module is a singleton whose text belongs to ONE project: a tab
 * that survives an in-SPA switch would otherwise keep contributing project A's
 * YAML through {@link registerMetamodelDraftProvider} to project B's commit
 * batch.
 *
 * Does NOT touch the checkout registry, and does not flush: the draft's
 * localStorage mirror is written by the edit debounce and by
 * {@link closeMetamodelEditor} on the tab's own unmount, so the persisted copy
 * survives this and a return to A restores it.
 */
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
	_lockedBy = null;
	_leaseHeld = false;
	_acquiring = false;
}
