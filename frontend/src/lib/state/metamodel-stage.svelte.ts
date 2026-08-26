import { SvelteMap } from 'svelte/reactivity';

import type { MetamodelOp } from './ops';

/**
 * Staged-metamodel store — the FOURTH staged family, beside
 * the model, artifact and view journals. It holds the two things a metamodel
 * gesture can stage:
 *
 *   - the YAML DRAFT, which this module does not own. `metamodel-editor.svelte.ts`
 *     is still the single lifecycle owner of the buffer (lease, lint, draft
 *     mirroring, dirty flag); it registers a PROVIDER here and this module
 *     merely reads `{dirty, blob}` at batch-build time.
 *   - the diagram's NODE MOVES, coalesced per node id (the last position for a
 *     node is the only one that matters), `null` meaning "drop this layout key".
 *
 * **This module imports ONLY `./ops` and svelte/reactivity, and that is
 * load-bearing.** It is the shared dependency of three modules that already
 * depend on each other — `checkout.svelte.ts` (builds the commit batch),
 * `metamodel-editor.svelte.ts` (owns the buffer) and
 * `metamodel-diagram.svelte.ts` (owns the canvas) — so a direct
 * `checkout → editor` import would close the cycle
 * `checkout → stage → editor → checkout`. The editor/diagram compose it
 * through PROVIDER/LISTENER REGISTRATION instead, exactly like
 * `view-edits.svelte.ts`'s `onViewCommitted`. Do not "simplify" either seam
 * into a direct import.
 *
 * Moves mirror to localStorage under `ui.metamodel.layoutdraft.<projectId>`,
 * per project and namespaced by it, so switching projects can never
 * cross-contaminate staged positions. They belong to the same unsaved work as
 * the YAML draft next door (`ui.metamodel.draft.<projectId>`), which already
 * survives a refresh — a staged move that vanished on reload while the draft
 * it was made against survived would be the inconsistent half.
 */

export type NodePos = { x: number; y: number };

/** What a committed batch DID to the metamodel, as told to listeners. `blob`
 * is the rebind text that was actually SENT (null when the batch carried no
 * rebind), never whatever the buffer holds by the time this fires. */
export interface MetamodelCommitInfo {
	rebound: boolean;
	blob: string | null;
}

let _projectId: string | null = null;

/** node id -> its staged position, or null for "remove this key". Coalescing,
 * not a journal (contrast `view-edits.svelte.ts`): layout keys are
 * independent and order-free, so the last write per node is the whole truth. */
const _moves = new SvelteMap<string, NodePos | null>();

/** Registered by `metamodel-editor.svelte.ts` at module scope. Null before it
 * has loaded (or in a test that never imports it), which reads as "no draft,
 * nothing to rebind" — the safe direction. */
let _draftProvider: (() => { dirty: boolean; blob: string }) | null = null;

// --- localStorage ----------------------------------------------------------
// try/catch rather than a `browser` guard, matching metamodel-editor.svelte.ts's
// draft helpers (the vitest alias stubs `browser` to false).

function movesKey(projectId: string): string {
	return `ui.metamodel.layoutdraft.${projectId}`;
}

function writeMoves(): void {
	if (_projectId === null) return;
	try {
		if (_moves.size === 0) localStorage.removeItem(movesKey(_projectId));
		else localStorage.setItem(movesKey(_projectId), JSON.stringify([..._moves]));
	} catch {
		/* storage full/denied: the staged moves simply don't persist */
	}
}

function readMoves(projectId: string): string | null {
	try {
		return localStorage.getItem(movesKey(projectId));
	} catch {
		return null;
	}
}

function restoreMoves(projectId: string): void {
	const raw = readMoves(projectId);
	if (raw === null) return;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return;
		for (const entry of parsed) {
			if (!Array.isArray(entry) || entry.length !== 2) continue;
			const [node, pos]: unknown[] = entry;
			if (typeof node !== 'string') continue;
			if (pos === null) {
				_moves.set(node, null);
				continue;
			}
			if (typeof pos !== 'object') continue;
			const { x, y } = pos as { x?: unknown; y?: unknown };
			if (typeof x !== 'number' || typeof y !== 'number') continue;
			_moves.set(node, { x, y });
		}
	} catch {
		/* corrupt entry: the staged moves are simply lost */
	}
}

// --- lifecycle -------------------------------------------------------------

/** Open the stage for a project and restore whatever moves a previous session
 * staged. Idempotent: re-calling it for the same project re-reads storage, so
 * `initMetamodelStage` doubles as the "reload from disk" path. */
export function initMetamodelStage(projectId: string): void {
	_projectId = projectId;
	_moves.clear();
	restoreMoves(projectId);
}

/** Surface close / project teardown: drop the in-memory copy. The persisted
 * moves deliberately SURVIVE, exactly like the YAML draft next door — closing
 * a tab must not silently discard unsaved work. */
export function closeMetamodelStage(): void {
	_moves.clear();
	_projectId = null;
}

// --- staging ---------------------------------------------------------------

/** Stage `node`'s new position (or `null` to drop its layout key), replacing
 * any earlier staged position for the same node. The position is COPIED: the
 * caller's object is usually a live `$state` position that keeps moving. */
export function stageNodeMove(node: string, pos: NodePos | null): void {
	_moves.set(node, pos === null ? null : { x: pos.x, y: pos.y });
	writeMoves();
}

export function getStagedNodeMoves(): ReadonlyMap<string, NodePos | null> {
	return _moves;
}

/** Register the YAML buffer's provider. ONE slot, not a list: there is exactly
 * one metamodel draft, and a second registration REPLACES the first (the
 * editor module registers once, at module scope; tests re-register per case). */
export function registerMetamodelDraftProvider(p: () => { dirty: boolean; blob: string }): void {
	_draftProvider = p;
}

/**
 * The staged metamodel batch, REBIND FIRST. The server hoists the rebind
 * regardless of client order, so this ordering is for the human reading the
 * commit drawer — schema first, then the positions expressed in its names.
 * At most one rebind: the draft is a single buffer, so it can never produce
 * the 422 the backend raises for a second one.
 */
export function getStagedMetamodelOps(): MetamodelOp[] {
	const ops: MetamodelOp[] = [];
	const draft = _draftProvider?.();
	if (draft !== undefined && draft.dirty) ops.push({ kind: 'metamodel.rebind', blob: draft.blob });
	for (const [node, pos] of _moves) ops.push({ kind: 'metamodel.move_node', node, pos });
	return ops;
}

/** How many rows this family contributes to the commit drawer's total: the
 * dirty draft counts as one, plus one per moved node. Cheaper than building
 * the op array, and the only thing the drawer/quiet/unsaved gates need. */
export function getStagedMetamodelDepth(): number {
	const draft = _draftProvider?.();
	return (draft !== undefined && draft.dirty ? 1 : 0) + _moves.size;
}

/**
 * Commit-success path: wipe SILENTLY — the moves were saved, not undone
 * (mirrors `clearStagedView`; {@link notifyMetamodelCommitted} is the
 * authoritative "it landed" signal, fired separately by checkout).
 *
 * Storage is cleared too, and must be: the persisted copy exists to survive a
 * refresh, and a move that has already landed durably would otherwise be
 * restored on the next open and re-staged into the NEXT commit.
 */
export function clearStagedNodeMoves(): void {
	_moves.clear();
	writeMoves();
}

const _movesDiscardListeners: (() => void)[] = [];

/** User-discard path: same wipe, different meaning — the moves are abandoned,
 * so the canvas must re-derive `_positions` from the server baseline, which
 * is what {@link onStagedMovesDiscarded} tells it. Kept separate from
 * {@link clearStagedNodeMoves} so the two intents stay distinguishable at the
 * call sites and the listener never fires on a commit. */
export function discardStagedNodeMoves(): void {
	_moves.clear();
	writeMoves();
	for (const cb of [..._movesDiscardListeners]) cb();
}

/**
 * Subscribe to "the user discarded the staged node moves" — the commit
 * drawer's per-family discard or Discard all. Same registration shape and
 * same cycle reason as {@link onMetamodelCommitted}: the diagram module
 * imports this one, so this one cannot import the diagram.
 */
export function onStagedMovesDiscarded(cb: () => void): () => void {
	_movesDiscardListeners.push(cb);
	return () => {
		const i = _movesDiscardListeners.indexOf(cb);
		if (i !== -1) _movesDiscardListeners.splice(i, 1);
	};
}

// --- committed listeners ---------------------------------------------------

const _commitListeners: ((info: MetamodelCommitInfo) => void)[] = [];

/**
 * Subscribe to "a commit carrying metamodel ops landed". Fired by
 * `checkout.svelte.ts` after a successful POST /commits. Lives HERE, not in
 * the editor, so checkout never imports the editor (see the module docstring's
 * cycle note); the editor subscribes to adopt the sent blob as its new
 * baseline, the diagram to re-derive its positions.
 */
export function onMetamodelCommitted(cb: (info: MetamodelCommitInfo) => void): () => void {
	_commitListeners.push(cb);
	return () => {
		const i = _commitListeners.indexOf(cb);
		if (i !== -1) _commitListeners.splice(i, 1);
	};
}

export function notifyMetamodelCommitted(info: MetamodelCommitInfo): void {
	for (const cb of [..._commitListeners]) cb(info);
}

// --- discard-all listeners --------------------------------------------------

const _discardListeners: (() => void)[] = [];

/**
 * Subscribe to "the user discarded EVERYTHING staged" (the commit drawer's
 * Discard all, i.e. `checkout.svelte.ts`'s `discardAll`). Same registration
 * shape, and same reason, as {@link onMetamodelCommitted}: the YAML draft is
 * owned by `metamodel-editor.svelte.ts`, which imports checkout, so checkout
 * calling `discardMetamodelDraft()` directly would close the cycle
 * `checkout → stage → editor → checkout`. The editor registers its own discard
 * here instead; the MOVES half `discardAll` wipes directly, since it lives in
 * this module.
 */
export function onMetamodelDiscardAll(cb: () => void): () => void {
	_discardListeners.push(cb);
	return () => {
		const i = _discardListeners.indexOf(cb);
		if (i !== -1) _discardListeners.splice(i, 1);
	};
}

export function notifyMetamodelDiscardAll(): void {
	for (const cb of [..._discardListeners]) cb();
}
