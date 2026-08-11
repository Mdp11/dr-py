import { SvelteMap } from 'svelte/reactivity';

import type { ClientConfig } from '$lib/api/client';
import { getCurrentUserId } from '$lib/api/client';
import {
	acquireLocks,
	commitChanges,
	openProject,
	previewCommit,
	releaseLock,
	renewLock
} from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';
import type {
	CommitResponse,
	LeaseOut,
	LockIntent,
	LockTargetIn,
	PreviewResponse
} from '$lib/api/types';
import type { LeaseLite } from '$lib/api/feed';
import type { Op } from './ops';
import { artifactResource, folderResource, isArtifactResource, isTempId } from './ops';
import {
	applyDelta,
	clearStaged,
	getModelRev,
	getStagedOps,
	revertAllStaged,
	revertStagedFor,
	revertStagedForElement
} from './model.svelte';
import {
	clearStagedArtifacts,
	discardAllStagedArtifacts,
	getStagedArtifactOps,
	notifyArtifactCommit,
	revertStagedArtifact
} from './artifact-edits.svelte';
import {
	clearStagedView,
	discardStagedView,
	getStagedViewOps,
	notifyViewCommitted
} from './view-edits.svelte';
// workspace.svelte imports nothing from this module (or from any store) — no cycle.
import { getDynamicTabs } from './workspace.svelte';

/**
 * Checkout store (Spec B): the editing-session state layered over the model
 * store. Owns MY held locks (token-keyed; tokens are private to the acquirer
 * and never broadcast), the heartbeat (Task 6), and the preview/commit/discard
 * lifecycle (Task 7). Peer lock state (badges) comes from realtime.svelte.ts;
 * this store is the authoritative source for my own tokens.
 */

export type LockConflictLite = {
	resource_id: string;
	held_by: string;
	held_by_email?: string;
	held_mode: string;
};
export type CheckoutResult =
	| { ok: true }
	| { ok: false; reason: 'viewer' | 'conflict'; conflicts?: LockConflictLite[] };

interface HeldLease {
	token: string;
	mode: 'exclusive' | 'shared';
}

/** resource_id -> the lease I hold on it. Multiple resources can share a token
 * (e.g. a delete subtree); release-by-token drops them together. */
const _registry = new SvelteMap<string, HeldLease>();

/** Resources whose server-held lock expired while I held them. Their staged
 * edits are uncommittable until the user re-checks-out or discards. */
const _stale = new SvelteMap<string, true>();

let _role = $state('viewer');
let _lockTtlSeconds = 300;
let _strictMode = $state(false);
let _clientConfig: ClientConfig | undefined;

export function setCheckoutApiConfig(cfg: ClientConfig | undefined): void {
	_clientConfig = cfg;
}

export function setProjectInfo(info: {
	role: string;
	lockTtlSeconds: number;
	strictMode?: boolean;
}): void {
	_role = info.role;
	_lockTtlSeconds = info.lockTtlSeconds > 0 ? info.lockTtlSeconds : _lockTtlSeconds;
	if (info.strictMode !== undefined) _strictMode = info.strictMode;
}

export function getRole(): string {
	return _role;
}

export function getStrictMode(): boolean {
	return _strictMode;
}

/** Direct setter used by the owner Settings toggle (Task 8) after a successful
 * PATCH /settings, so the DiffDrawer gate reflects the new policy immediately. */
export function setStrictMode(v: boolean): void {
	_strictMode = v;
}

export function canEdit(): boolean {
	return _role === 'editor' || _role === 'owner';
}

export function getHeldToken(resourceId: string): string | undefined {
	return _registry.get(resourceId)?.token;
}

export function getHeldTokens(): string[] {
	// ephemeral dedup of token strings, not reactive state
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	return [...new Set([..._registry.values()].map((l) => l.token))];
}

export function isCheckedOutByMe(resourceId: string): boolean {
	return _registry.has(resourceId);
}

/** Internal: record granted leases under their token. Exported for Tasks 6-8. */
export function _recordLeases(leases: LeaseOut[]): void {
	for (const le of leases) {
		_registry.set(le.resource_id, {
			token: le.token,
			mode: le.mode === 'exclusive' ? 'exclusive' : 'shared'
		});
	}
}

/** Internal: drop every registry entry under `token`. */
export function _dropToken(token: string): void {
	for (const [rid, lease] of _registry) {
		if (lease.token === token) _registry.delete(rid);
	}
}

/**
 * The registry key for a lock TARGET. Targets are sent with a BARE id plus a
 * `type` discriminator; the server canonicalizes into its lock namespaces and
 * hands the leases back under the canonical resource id, which is what
 * {@link _recordLeases} stores. Without mirroring that mapping here, every
 * `ensureCheckout` on an artifact would miss the registry and acquire a
 * DUPLICATE lease on each editor re-open. Elements stay BARE (lock badges and
 * the whole element half of the registry key on the raw element id).
 */
function canonicalResource(t: LockTargetIn): string {
	if (t.type === 'artifact') return artifactResource(t.resource_id);
	if (t.type === 'folder') return folderResource(t.resource_id);
	if (t.type === 'metamodel') return 'mm';
	return t.resource_id;
}

/** True when the registry already covers (resource, mode): an exclusive hold
 * covers a shared requirement; a shared hold covers only shared. */
function alreadyHeld(t: LockTargetIn): boolean {
	const held = _registry.get(canonicalResource(t));
	if (held === undefined) return false;
	if (t.mode === 'shared') return true; // any hold covers a pin
	return held.mode === 'exclusive';
}

/**
 * Auto-acquire gate. Acquires the subset of `targets` not already held, under
 * `intent`, as ONE /locks call (one token). Idempotent: returns {ok:true}
 * synchronously when everything is held. Viewers are blocked before any
 * network call. A 409 returns {ok:false, reason:'conflict'} with details.
 */
export async function ensureCheckout(
	targets: LockTargetIn[],
	intent: LockIntent
): Promise<CheckoutResult> {
	if (!canEdit()) return { ok: false, reason: 'viewer' };
	const needed = targets.filter((t) => !alreadyHeld(t));
	if (needed.length === 0) return { ok: true };
	try {
		const res = await acquireLocks({ targets: needed, intent, steal: false }, _clientConfig);
		_recordLeases(res.leases);
		// Re-acquiring a resource that had gone stale (server-side TTL lapse)
		// makes its staged edits committable again — clear the stale mark so the
		// StatusBar warning is not sticky.
		for (const le of res.leases) _stale.delete(le.resource_id);
		_maybeStartHeartbeat(); // defined in Task 6
		return { ok: true };
	} catch (err) {
		if (err instanceof ConflictError) {
			const body = err.body as { conflicts?: LockConflictLite[] } | undefined;
			return { ok: false, reason: 'conflict', conflicts: body?.conflicts };
		}
		throw err;
	}
}

export function resetCheckout(): void {
	_registry.clear();
	_stale.clear();
	_role = 'viewer';
	_lockTtlSeconds = 300;
	_strictMode = false;
	_stopHeartbeat(); // defined in Task 6
}

// --- heartbeat -------------------------------------------------------------

let _heartbeat: ReturnType<typeof setInterval> | null = null;

function _maybeStartHeartbeat(): void {
	if (_heartbeat !== null) return;
	if (_registry.size === 0) return;
	const intervalMs = Math.max(1, Math.floor((_lockTtlSeconds / 2) * 1000));
	_heartbeat = setInterval(() => void _renewAll(), intervalMs);
}

function _stopHeartbeat(): void {
	if (_heartbeat !== null) {
		clearInterval(_heartbeat);
		_heartbeat = null;
	}
}

async function _renewAll(): Promise<void> {
	for (const token of getHeldTokens()) {
		try {
			const res = await renewLock(token, _clientConfig);
			if (!res.ok) {
				_dropToken(token);
				_onTokenExpired(token);
			}
		} catch {
			// transient renew failure: keep the token; next tick retries
		}
	}
	if (_registry.size === 0) _stopHeartbeat();
}

// --- project open + expiry (Task 8) ----------------------------------------

/** Fetch role + lock TTL from /open and adopt them. */
export async function loadProjectInfo(cfg?: ClientConfig): Promise<void> {
	const info = await openProject(cfg ?? _clientConfig);
	setProjectInfo({
		role: info.role,
		lockTtlSeconds: info.lock_ttl_seconds,
		strictMode: info.strict_mode
	});
}

export function getStaleResources(): string[] {
	return [..._stale.keys()];
}

export function clearStaleResource(id: string): void {
	_stale.delete(id);
}

/** Feed lock-event handler: if one of MY held resources is released/expired by
 * the server (TTL lapse), mark it stale (its staged edits are now
 * uncommittable) and drop my token for it. */
export function handleRemoteLockEvent(
	action: 'acquired' | 'released' | 'expired',
	leases: LeaseLite[]
): void {
	if (action === 'acquired') return;
	const me = getCurrentUserId();
	for (const le of leases) {
		if (le.holder_id !== me) continue;
		if (!_registry.has(le.resource_id)) continue;
		const token = _registry.get(le.resource_id)?.token;
		if (action === 'expired') _stale.set(le.resource_id, true);
		if (token) _dropToken(token);
	}
	if (_registry.size === 0) _stopHeartbeat();
}

/** Replace the Task 6 expiry stub: a renew-detected expiry also marks stale. */
function _onTokenExpired(token: string): void {
	// Caller (_renewAll / handleRemoteLockEvent) drops the token; this only stale-marks.
	for (const [rid, lease] of _registry) {
		if (lease.token === token) _stale.set(rid, true);
	}
}

// --- preview / commit / discard --------------------------------------------

/** Preview the staged batch at the live rev (kept current by the feed).
 * Model ops, then artifact ops, then view ops — VIEW LAST: a staged
 * `place_artifact` may reference an artifact still identified by a temp id
 * from the artifact half of this SAME batch, and the backend seeds the view
 * applier's id_map from the earlier two halves, so a view op naming a temp
 * id can only resolve if it comes after the create that mints it. One mixed
 * batch, exactly as it will be committed (the backend splits the union
 * itself). */
export function previewStaged(): Promise<PreviewResponse> {
	return previewCommit(
		getModelRev(),
		[...getStagedOps(), ...getStagedArtifactOps(), ...getStagedViewOps()],
		_clientConfig
	);
}

/**
 * Commit all staged edits — model ops, artifact ops, and view ops in ONE
 * batch (view LAST; see {@link previewStaged}). On success the server
 * releases every token it was SENT, so we apply the delta and drop those
 * tokens from the registry locally.
 */
export async function commitStaged(message: string, ackErrors: boolean): Promise<CommitResponse> {
	const ops: Op[] = [...getStagedOps(), ...getStagedArtifactOps(), ...getStagedViewOps()];
	if (ops.length === 0) {
		// Never send an empty commit: the backend's empty-batch early return
		// (routes/commits.py) skips its lock-release step, so lock_tokens sent
		// with one are orphaned until TTL. The DiffDrawer's total===0 gate makes
		// this unreachable from the UI; this guard keeps it unreachable, period.
		throw new Error('nothing staged to commit');
	}
	// Captured BEFORE any buffer is cleared below — the post-commit notify
	// gate needs to know whether THIS batch carried view ops, and clearStaged
	// happens before that notify fires.
	const hadViewOps = getStagedViewOps().length > 0;
	// Token partition: an artifact-editor lease whose artifact is NOT in this
	// batch belongs to a still-open editor and must survive the commit (the
	// server releases every token it is sent). Everything else — all element
	// tokens (commit ends the model editing session, as before), ALL folder
	// tokens (dialogs are transient; there is no open-editor concept for a
	// folder to protect — see {@link releaseFolderLeaseIfUnneeded}'s
	// docstring), and artifact tokens the batch needs (the server verifies +
	// releases them) — is sent. Folder tokens fall out of this partition for
	// free: `isArtifactResource` is false for every `folder:` resource, so
	// `artifactOnly` is false and the token lands in `sent` without any
	// folder-specific branch — deliberately; do not special-case it here.
	const needed = lockedResourcesNeededBy(ops);
	const sent: string[] = [];
	// ephemeral partition bookkeeping, not reactive state
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const kept = new Set<string>();
	for (const token of getHeldTokens()) {
		const resources = [..._registry].filter(([, l]) => l.token === token).map(([rid]) => rid);
		const artifactOnly = resources.every((rid) => isArtifactResource(rid));
		const unneeded = resources.every((rid) => !needed.has(rid));
		if (artifactOnly && unneeded) kept.add(token);
		else sent.push(token);
	}
	const res = await commitChanges(
		{ baseRev: getModelRev(), ops, message, lockTokens: sent, ackErrors },
		_clientConfig
	);
	// ORDERING, all of it load-bearing. The commit has LANDED durably by this
	// point, so everything below is local reconciliation that must not become
	// skippable by a failure further down.
	//
	// 1. Clear ALL THREE staged buffers first so applyDelta's hasQueuedOpFor
	//    guard does not skip the committed elements — the server's canonical
	//    rev is the truth. The artifact and view buffers are cleared silently
	//    (no discard listeners on either): the edits were saved, not undone;
	//    notifyArtifactCommit/notifyViewCommitted below are what tell
	//    listeners the authoritative outcome.
	// 2. Drop the surrendered tokens BEFORE anything that can run third-party
	//    code. The server released every token it was SENT, so a registry that
	//    still claims them makes the next commitStaged send dead tokens and 409
	//    — over a commit that already succeeded. `notifyArtifactCommit` fans out
	//    to editor-store callbacks it does not guard (a bare `for … cb(info)`),
	//    so one throwing listener used to strand exactly that state; applyDelta
	//    is ordered after for the same reason.
	clearStaged();
	clearStagedArtifacts();
	clearStagedView();
	for (const [rid, lease] of [..._registry]) {
		if (!kept.has(lease.token)) _registry.delete(rid);
	}
	if (_registry.size === 0) _stopHeartbeat();
	applyDelta(res);
	// Artifact half of the delta: header store + editors subscribe (listener
	// registry — a direct import here would cycle through the editor modules).
	notifyArtifactCommit({
		idMap: res.id_map,
		changed: res.changed_artifacts,
		deletedIds: res.deleted_artifact_ids
	});
	// View half: only when THIS batch actually carried view ops — a
	// model-only (or model+artifact-only) commit must not trigger a needless
	// GET /view refetch. Fired after notifyArtifactCommit for the same
	// listener-ordering reason as applyDelta above (view.svelte.ts's listener
	// is a plain callback too, not guarded here).
	if (hadViewOps) notifyViewCommitted();
	return res;
}

/**
 * Release my `art:<id>` lease on editor close / save-as rebind — UNLESS a
 * staged op (either buffer) still needs a resource that token covers: a
 * saved-but-uncommitted artifact edit must keep its lease or the commit would
 * 409 "required lock not held". Mirrors {@link _discardWith}'s release rule
 * without reverting anything. No-op when I hold no lease on `artifactId`.
 *
 * Does NOT apply {@link openArtifactResources}'s keep-what-is-open rule, and
 * must not: its callers ARE the close/rebind of the only tab that could have
 * been holding the lease open, so consulting the tab list would either be a
 * tautology (the tab is already gone) or refuse the very release it was called
 * to perform.
 */
export async function releaseArtifactIfUnneeded(artifactId: string): Promise<void> {
	const rid = artifactResource(artifactId);
	const token = _registry.get(rid)?.token;
	if (token === undefined) return;
	// The three-buffer union, not just the two model+artifact buffers: an
	// artifact lease and a folder lease can in principle share one token (a
	// single gesture that checks out both), and the honest "everything
	// staged" needed-set has to see a view op even though this function only
	// ever releases an `art:` resource itself.
	const stillNeeded = lockedResourcesNeededBy([
		...getStagedOps(),
		...getStagedArtifactOps(),
		...getStagedViewOps()
	]);
	const tokenResources = [..._registry].filter(([, l]) => l.token === token).map(([r]) => r);
	if (tokenResources.some((r) => stillNeeded.has(r))) return;
	_dropToken(token);
	await releaseLock(token, _clientConfig).catch(() => {});
	if (_registry.size === 0) _stopHeartbeat();
}

/**
 * Release my `folder:<id>` lease on dialog cancel / discard — UNLESS a
 * staged view op still needs a resource that token covers (a
 * granted-then-cancelled rename must hand its lease back; a
 * granted-then-STAGED one must keep it or the commit would 409 "required
 * lock not held"). Token-granularity, exactly like {@link
 * releaseArtifactIfUnneeded}: a gesture token covering {source container,
 * destination} (see {@link lockedResourcesNeededBy}'s `move_folder` note) is
 * kept while ANY of its resources is still needed.
 *
 * Deliberately mirrors {@link releaseArtifactIfUnneeded}'s stance, not
 * {@link discardArtifact}'s: there is no `openArtifactResources`-style
 * open-tab rule for folders. A folder has no editor tab — the sidebar
 * dialogs that acquire a folder lease (rename/move/create-child) are
 * transient by construction, so "is it still open" is never a question this
 * function needs to ask; only "is it still staged" is.
 */
export async function releaseFolderLeaseIfUnneeded(folderId: string): Promise<void> {
	const rid = folderResource(folderId);
	const token = _registry.get(rid)?.token;
	if (token === undefined) return;
	const stillNeeded = lockedResourcesNeededBy([
		...getStagedOps(),
		...getStagedArtifactOps(),
		...getStagedViewOps()
	]);
	const tokenResources = [..._registry].filter(([, l]) => l.token === token).map(([r]) => r);
	if (tokenResources.some((r) => stillNeeded.has(r))) return;
	_dropToken(token);
	await releaseLock(token, _clientConfig).catch(() => {});
	if (_registry.size === 0) _stopHeartbeat();
}

/**
 * Release my `mm` lease (metamodel surface close). Best-effort like its
 * artifact/folder siblings ({@link releaseArtifactIfUnneeded},
 * {@link releaseFolderLeaseIfUnneeded}). Unlike them it needs no staged-ops
 * check: the `mm` lease is always acquired standalone by the metamodel
 * surface (its own `/locks` call, its own token — see
 * `metamodel-lease.svelte.ts`) and {@link lockedResourcesNeededBy} never
 * emits `mm`, so no staged op can require it.
 */
export async function releaseMetamodelLease(): Promise<void> {
	const token = _registry.get('mm')?.token;
	if (token === undefined) return;
	_dropToken(token);
	await releaseLock(token, _clientConfig).catch(() => {});
	if (_registry.size === 0) _stopHeartbeat();
}

/**
 * The canonical `art:` resource ids of every artifact currently open in an
 * editor tab — the "do not release this, the user can SEE it checked out" set.
 *
 * Extracted because two release surfaces must apply the identical rule:
 * {@link discardAll} and {@link discardArtifact}. (The third and fourth views
 * of the release rule, {@link _discardWith} and
 * {@link releaseArtifactIfUnneeded}, deliberately do NOT consult it — see their
 * docstrings.) Staged creates are excluded: a temp id names no server-side row,
 * so there is no lease on it to keep.
 *
 * A plain `Set`, not a `SvelteSet`: this is ephemeral partition bookkeeping
 * computed and thrown away inside one call, never held as reactive state.
 */
function openArtifactResources(): Set<string> {
	return new Set(
		getDynamicTabs()
			.filter((t) => t.artifactId !== null && !isTempId(t.artifactId))
			.map((t) => artifactResource(t.artifactId as string))
	);
}

/**
 * Per-artifact abandon: drop `id`'s ONE staged artifact entry and release its
 * lease when nothing is left that needs it. The artifact sibling of
 * {@link discardElement}, and the ONLY discard surface the commit review's
 * per-artifact-row button may call — reverting the staged entry directly
 * (`revertStagedArtifact`) strands the lease for the full TTL.
 *
 * That leak is worst for the sidebar's Delete, which takes a DELETE-intent
 * exclusive: it conflicts with ANY peer lease, shared pins included, so a
 * stranded one blocks every other user from even OPENING the artifact. There is
 * no editor tab to release it on close and `commitStaged` never sees the token
 * (its op is gone), so nothing else would ever clean it up.
 *
 * Two keep conditions, not one — this is where it differs from
 * {@link _discardWith}:
 *   - a REMAINING staged op still needs a resource the token covers (the
 *     element rule; a token can cover a whole delete subtree), and
 *   - an artifact the token covers is still OPEN in an editor tab. This draws
 *     on the same protected-resource SET as {@link discardAll}
 *     ({@link openArtifactResources}) — but NOT the same rule: discardAll
 *     keeps a token only if EVERY resource it covers is protected (release is
 *     by token, so a mixed token must still be released), while this function
 *     keeps a token if ANY resource it covers is protected, because a per-row
 *     discard must never yank a still-open editor's check-out out from under
 *     it. Both predicates are individually correct for their own caller; do
 *     not "unify" them on the strength of the shared set.
 *     Elements need no such term: they have no per-tab check-out.
 *
 * The release is best-effort (`.catch`), matching its artifact siblings
 * {@link releaseArtifactIfUnneeded} and {@link discardAll}: the local buffer
 * edit has already happened, and the caller is a fire-and-forget click handler
 * that must not surface an unhandled rejection over a lease that will TTL out
 * anyway.
 *
 * ACCEPTED WRINKLE (Decision 7): `removeArtifact` (artifacts.svelte.ts) stages
 * the artifact's `remove_artifact` view-placement scrub ops ALONGSIDE its
 * `delete_artifact` entry, but as separate entries in a separate journal
 * (`view-edits.svelte.ts`). This function only reverts the ONE artifact entry
 * — undoing a delete this way does NOT retract its scrub ops, so they would
 * still commit even though the artifact they name no longer would. This is
 * left as-is rather than threading a second discard through here: the scrub
 * rows are visible and labelled (`Removed placement of "<name>"`, not a raw
 * id), so a user who un-deletes an artifact can see and discard them
 * individually via the same view-row discard the DiffDrawer already offers.
 */
export async function discardArtifact(id: string): Promise<void> {
	const rid = artifactResource(id);
	const token = _registry.get(rid)?.token;
	revertStagedArtifact(id);
	if (token !== undefined) {
		// Three-buffer union — see {@link releaseArtifactIfUnneeded}'s comment.
		const stillNeeded = lockedResourcesNeededBy([
			...getStagedOps(),
			...getStagedArtifactOps(),
			...getStagedViewOps()
		]);
		const keepOpen = openArtifactResources();
		const tokenResources = [..._registry].filter(([, l]) => l.token === token).map(([r]) => r);
		if (!tokenResources.some((r) => stillNeeded.has(r) || keepOpen.has(r))) {
			_dropToken(token);
			await releaseLock(token, _clientConfig).catch(() => {});
		}
	}
	// Its staged edit was abandoned; the resource is no longer stale-blocked.
	_stale.delete(rid);
	if (_registry.size === 0) _stopHeartbeat();
}

/**
 * Re-check-out every artifact whose editor tab is still open but whose lease
 * the last commit surrendered (the batch needed it, so it was sent and the
 * server released it). Best-effort and sequential: a peer may have grabbed the
 * artifact in between, in which case `onDenied(tabId, holder)` lets the caller
 * put that tab into lock-denied (unsaveable) mode instead of failing the whole
 * sweep.
 * Draft tabs (no artifact id) and staged creates (temp id — no server-side row
 * to lock yet) are skipped.
 */
export async function reacquireOpenArtifactLeases(
	onDenied: (tabId: string, holder: string) => void
): Promise<void> {
	if (!canEdit()) return;
	for (const tab of getDynamicTabs()) {
		if (tab.artifactId === null || isTempId(tab.artifactId)) continue;
		if (_registry.has(artifactResource(tab.artifactId))) continue;
		const res = await ensureCheckout(
			[{ resource_id: tab.artifactId, mode: 'exclusive', type: 'artifact' }],
			'edit'
		);
		if (!res.ok && res.reason === 'conflict') onDenied(tab.id, lockHolderLabel(res));
	}
}

/**
 * The display name of whoever holds the lock a {@link CheckoutResult} was
 * refused over. Defined HERE rather than next to `edit-gate.ts`'s `explain`
 * (which it resembles) because {@link reacquireOpenArtifactLeases} needs it and
 * edit-gate imports this module — one definition, re-exported from edit-gate.
 */
export function lockHolderLabel(res: Extract<CheckoutResult, { ok: false }>): string {
	const c = res.conflicts?.[0];
	if (!c) return 'someone else';
	return c.held_by_email || c.held_by;
}

/**
 * The set of resource_ids that `ops` need a lock on at commit time:
 *   - update/delete element|relationship -> the op's `id`
 *   - create_relationship -> its `source_id` AND `target_id`
 *   - create_element -> its `temp_id`
 *   - any artifact op -> its id/temp_id under the CANONICAL `art:` key, so the
 *     result can be compared against registry keys directly. (A create needs no
 *     server-side lock — nothing exists to lock — but naming its temp id keeps
 *     an over-eager release from dropping a token the batch is about to use.)
 *   - any view op -> the CANONICAL `folder:` key(s) of its CONTAINING
 *     folder(s), same reasoning as the artifact `art:` key: a view op locks
 *     its folder, not the element/artifact/folder it places or renames.
 *     `create_folder` names its PARENT (the new folder itself has no lease —
 *     nothing exists to lock, same as `create_artifact`'s temp id — and
 *     nothing else needs one either, since the batch's own later ops can
 *     reference the `temp_id` without a lock, exactly like a staged
 *     `create_element`'s id). `move_folder` names only its DESTINATION
 *     parent: the SOURCE container is never in the op payload at all (the
 *     backend derives it from the current view state), so its lease is not,
 *     and cannot be, tracked here — it rides the same gesture TOKEN as the
 *     destination, and token-granularity keep/release (this function is
 *     always consulted per-TOKEN, never per-resource in isolation) is what
 *     keeps it held or lets it go, not this set.
 * Used by {@link discardElement} to avoid releasing a token that a REMAINING
 * staged op still depends on (e.g. a connect's create_relationship needs the
 * source's exclusive lock even after the source's own property edit is
 * discarded), by {@link commitStaged}'s token partition, and by
 * {@link releaseFolderLeaseIfUnneeded}/{@link releaseArtifactIfUnneeded}.
 */
function lockedResourcesNeededBy(ops: Op[]): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const needed = new Set<string>();
	for (const op of ops) {
		switch (op.kind) {
			case 'create_element':
				needed.add(op.temp_id);
				break;
			case 'create_relationship':
				needed.add(op.source_id);
				needed.add(op.target_id);
				break;
			case 'update_element':
			case 'delete_element':
			case 'update_relationship':
			case 'delete_relationship':
				needed.add(op.id);
				break;
			case 'create_artifact':
				needed.add(artifactResource(op.temp_id));
				break;
			case 'update_artifact':
			case 'delete_artifact':
				needed.add(artifactResource(op.id));
				break;
			case 'create_folder':
				needed.add(folderResource(op.parent_id));
				break;
			case 'rename_folder':
			case 'delete_folder':
				needed.add(folderResource(op.id));
				break;
			case 'move_folder':
				needed.add(folderResource(op.to_parent_id));
				break;
			case 'place_element':
			case 'remove_element':
				needed.add(folderResource(op.folder_id));
				break;
			case 'move_element':
				needed.add(folderResource(op.from_folder_id));
				needed.add(folderResource(op.to_folder_id));
				break;
			case 'place_artifact':
			case 'remove_artifact':
				needed.add(folderResource(op.folder_id));
				break;
			case 'move_artifact':
				needed.add(folderResource(op.from_folder_id));
				needed.add(folderResource(op.to_folder_id));
				break;
		}
	}
	return needed;
}

/**
 * Shared body of the per-element abandon surfaces: run `revert` over `id`'s
 * staged ops, then release `id`'s lock token IFF no REMAINING staged op still
 * needs a lock on any resource that token covers (a connect holds the source
 * under one token but stages a create_relationship that still needs that
 * source lock to commit; releasing it here would orphan that op into a 409 at
 * commit). When a remaining op still needs it, the token and its registry
 * entries are kept intact so the lock stays reported-held and is sent at
 * commit. Either way the resource stops being stale-blocked (its staged edits
 * are gone) and an emptied registry stops the heartbeat.
 *
 * Only `id`'s OWN token is a release candidate. A cascade can additionally
 * strand a co-endpoint's token (the far end of a discarded staged
 * relationship), which is deliberately left held: that lease was acquired for
 * an explicit user intent and expires on its own TTL, whereas eagerly
 * releasing every now-unneeded token would silently drop check-outs the user
 * still believes they hold.
 */
async function _discardWith(id: string, revert: (id: string) => void): Promise<void> {
	const token = getHeldToken(id);
	revert(id);
	if (token !== undefined) {
		const stillNeeded = lockedResourcesNeededBy(getStagedOps());
		const tokenResources = [..._registry].filter(([, l]) => l.token === token).map(([rid]) => rid);
		const tokenStillNeeded = tokenResources.some((rid) => stillNeeded.has(rid));
		if (!tokenStillNeeded) {
			// No remaining staged op needs any resource this token covers — safe to
			// release the whole token (frees co-acquired resources, e.g. a subtree).
			_dropToken(token);
			await releaseLock(token, _clientConfig);
		}
		// else: a remaining op still needs a resource this token covers — keep the
		// lease and its registry entries so the lock stays held and is sent at commit.
	}
	// Its staged edits were abandoned; the resource is no longer stale-blocked.
	_stale.delete(id);
	if (_registry.size === 0) _stopHeartbeat();
}

/** Per-element abandon: revert the element's OWN staged ops (ops whose target
 * is `id`) and release its token when nothing staged still needs it. Used by
 * the diff drawer and the inspector's lock control, where a co-acquired
 * relationship op must survive the discard (see {@link _discardWith}). */
export function discardElement(id: string): Promise<void> {
	return _discardWith(id, revertStagedFor);
}

/** Cascading per-element abandon: like {@link discardElement} but also reverts
 * every staged relationship op incident to `id` ({@link revertStagedForElement}).
 * This is the "Staged elements" sidebar's revert: that section is the only way
 * to reach a temp element, and leaving a staged rel pointing at a reverted temp
 * id would 422 the commit — so the surface that un-creates the element must take
 * its incident rel ops with it. Because the cascade removes the very ops that
 * would otherwise keep `id`'s token needed, this reliably releases the lease
 * instead of leaking it for the full TTL. */
export function discardElementCascade(id: string): Promise<void> {
	return _discardWith(id, revertStagedForElement);
}

/**
 * Abandon everything: revert all staged edits (all three buffers — the view
 * journal is wiped too, via {@link discardStagedView}, alongside the model
 * and artifact buffers) and release every token EXCEPT the leases of
 * artifacts still open in an editor tab — "discard" abandons EDITS, not
 * check-outs the user can see as open editors. A kept token must cover ONLY
 * kept resources; a token that also covers something being released is
 * sent, since release is by token, not by resource.
 *
 * Folder leases are NEVER kept open: {@link openArtifactResources} (this
 * function's keep-set) only ever names `art:` resources, so every `folder:`
 * token this function holds is, by construction, not in `keepTokens` and
 * gets released — dialogs are transient, unlike an artifact editor tab, so
 * there is no folder-side "still open, still visible to the user" case to
 * protect. No folder-specific branch is needed here for the same reason the
 * commit-time token partition needs none (see {@link commitStaged}).
 */
export async function discardAll(): Promise<void> {
	revertAllStaged();
	discardAllStagedArtifacts(); // fires per-entry discard listeners (drafts re-dirty)
	// AWAITED: the view journal's optimistic applies are baked into the view
	// store's `_view`, so wiping the journal without refetching would leave the
	// sidebar showing a tree that exists nowhere. `discardStagedView` fires the
	// view store's discard listener (a GET /view) to reconcile — that is why it
	// is async and why this must not be a bare fire-and-forget call.
	await discardStagedView();
	const keepResources = openArtifactResources();
	// ephemeral partition bookkeeping, not reactive state
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const keepTokens = new Set(
		[..._registry].filter(([rid]) => keepResources.has(rid)).map(([, l]) => l.token)
	);
	for (const token of [...keepTokens]) {
		const resources = [..._registry].filter(([, l]) => l.token === token).map(([rid]) => rid);
		if (!resources.every((rid) => keepResources.has(rid))) keepTokens.delete(token);
	}
	const tokens = getHeldTokens().filter((t) => !keepTokens.has(t));
	for (const [rid, lease] of [..._registry]) {
		if (!keepTokens.has(lease.token)) _registry.delete(rid);
	}
	_stale.clear();
	if (_registry.size === 0) _stopHeartbeat();
	await Promise.all(tokens.map((t) => releaseLock(t, _clientConfig).catch(() => {})));
}

export const __ttlForTests = () => _lockTtlSeconds;
