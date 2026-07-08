/**
 * Per-tab navigation drafts. Keyed by the workspace tab id so several
 * navigations can be open at once. Definitions are edited as plain JSON
 * objects (the backend's NAVIGATION_ADAPTER is the source of truth for
 * validity; the editor keeps them structurally correct by construction).
 * Editing invalidates the preview: chains shown always correspond to the
 * definition on screen.
 *
 * Per-node keying: a navigation is a TREE (a Path, or a set expression over
 * nested definitions). Preview/generation/error/expand state is keyed PER NODE
 * by `previewKey(tabId, path) = ${tabId}::${pathKey(path)}` (path === [] is the
 * ROOT node) so an expanded set-op operand can show its own chain preview
 * independently of the root. The draft and the save-conflict marker stay keyed
 * by `tabId` alone (there is one draft and one save per tab), but `_previews`,
 * `_evalErrors`, `_generations`, and `_debounceTimers` are all keyed by
 * previewKey, and `_expanded` maps a tabId to the set of expanded node
 * pathKeys. A node is only previewed while it is EXPANDED (collapsing drops
 * its preview); the root is expanded by default so a bare navigation still
 * shows results.
 *
 * Auto-run: there is no manual Run button. `updateDefinition` reschedules a
 * DEBOUNCED preview run (`AUTO_RUN_DEBOUNCE_MS`, per NODE — a newer edit resets
 * that node's timer) for every currently-expanded node, firing only when the
 * node addressed at fire time is `isRunnable`; an unrunnable node just leaves
 * its preview cleared. The debounce timer is separate from the preview
 * generation counter: `updateDefinition` already bumps each expanded node's
 * generation (so any in-flight evaluate response for it is stale) and the
 * debounce fire re-reads `nodeAt(_drafts.get(tabId).definition, path)` at fire
 * time rather than closing over the node at schedule time, so a second edit
 * inside the window both resets the timer AND supplies the node that is
 * actually sent. `closeDraft` and `resetNavigationEditors` cancel any pending
 * timers directly (the generation guard alone would stop a stale RESPONSE from
 * being applied, but would not stop the request from firing into a closed tab
 * in the first place). Opening a SAVED artifact expands the root and runs it
 * once immediately (no debounce) if its loaded definition is runnable, so a
 * saved navigation shows results without requiring an edit first.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import * as api from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import type { NavigationDefinition, TreeItem } from '$lib/api/types';
import { isRunnable, nodeAt, pathKey, type NodePath } from '$lib/navigation/tree';
import { loadArtifacts } from './artifacts.svelte';
import { bindTabToArtifact, retitleTab } from './workspace.svelte';

// `isRunnable` moved to lib/navigation/tree (it now understands the NavStepItem
// discriminated union); re-export so the barrel + existing consumers keep the
// same import surface.
export { isRunnable };

const PAGE = 100;
const AUTO_RUN_DEBOUNCE_MS = 400;

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
/** previewKey (`${tabId}::${pathKey(path)}`) -> the node's preview. */
const _previews = new SvelteMap<string, NavPreview>();
const _conflicts = new SvelteMap<string, number>(); // tabId -> server rev (per-draft)
/** tabId -> the set of expanded node pathKeys. A node is previewed only while
 * expanded; the root pathKey (`''`) is expanded by default. */
const _expanded = new SvelteMap<string, SvelteSet<string>>();

/**
 * NODES whose LAST evaluate attempt failed, keyed by previewKey. With no manual
 * Run button the auto-run callers are fire-and-forget (they swallow the
 * rejection), so this flag IS the surfacing: ChainPreview renders it as a muted
 * error line when the node is runnable but no preview exists. Set only when the
 * failure is still current (same `isCurrent` discipline as the preview catch
 * path); cleared by any edit to the node (`updateDefinition`), a new run
 * starting (`runPreview`), collapse (`toggleExpanded`), `closeDraft`,
 * `reloadDraft`, and reset — an error must never outlive the node it belongs to.
 */
const _evalErrors = new SvelteMap<string, true>();

/**
 * Per-NODE preview generation, keyed by previewKey. Anything that makes an
 * in-flight evaluate response for a node stale — a definition edit touching it,
 * a newer runPreview, a collapse, closeDraft/reset — bumps the counter; the
 * async preview functions capture it before their await and drop the response
 * on mismatch (or when the draft is gone), so a slow round-trip can never
 * revive a cleared preview or clobber a fresher one. Plain Map: generations are
 * control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _generations = new Map<string, number>();

/** `${tabId}::${pathKey(path)}` — the per-node key everything is keyed by. */
function previewKey(tabId: string, path: NodePath): string {
	return `${tabId}::${pathKey(path)}`;
}

/** Reconstruct a NodePath from a stored pathKey (the inverse of `pathKey`).
 * `''` -> [] (root); otherwise dot-joined segments, each `'start'` or an index. */
function parsePathKey(pk: string): NodePath {
	if (pk === '') return [];
	return pk.split('.').map((seg) => (seg === 'start' ? 'start' : Number(seg)));
}

function bumpGeneration(key: string): number {
	const next = (_generations.get(key) ?? 0) + 1;
	_generations.set(key, next);
	return next;
}

/** True while `gen` is still current for the node `key` and its draft exists. */
function isCurrent(tabId: string, key: string, gen: number): boolean {
	return _generations.get(key) === gen && _drafts.has(tabId);
}

/**
 * Pending debounced auto-run timers, per NODE (previewKey). Control state (like
 * `_generations`), never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelAutoRun(key: string): void {
	const timer = _debounceTimers.get(key);
	if (timer !== undefined) {
		clearTimeout(timer);
		_debounceTimers.delete(key);
	}
}

/**
 * (Re)schedule the debounced auto-run for the node at `path` in `tabId`. Fires
 * `AUTO_RUN_DEBOUNCE_MS` after the LAST call for this NODE (each call cancels
 * the previous timer). Reads the node at fire time via
 * `nodeAt(currentDraft.definition, path)`, not at schedule time, so a later
 * edit inside the window both resets the delay and supplies the node sent; a
 * node that no longer exists (e.g. a removed operand, or a ref) is skipped.
 */
function scheduleAutoRun(tabId: string, path: NodePath): void {
	const key = previewKey(tabId, path);
	cancelAutoRun(key);
	const timer = setTimeout(() => {
		_debounceTimers.delete(key);
		const draft = _drafts.get(tabId);
		if (!draft) return;
		const node = nodeAt(draft.definition, path);
		if (node && isRunnable(node)) {
			void runPreview(tabId, path).catch(() => {
				// Auto-run is fire-and-forget: swallow the rethrow. runPreview's
				// own catch already cleared the preview AND set the per-node
				// eval-error flag (when still current) — that flag is what
				// ChainPreview surfaces to the user.
			});
		}
	}, AUTO_RUN_DEBOUNCE_MS);
	_debounceTimers.set(key, timer);
}

/** Ensure `tabId` has an expanded-set and mark `path` expanded (no run). */
function markExpanded(tabId: string, path: NodePath): void {
	let set = _expanded.get(tabId);
	if (!set) {
		set = new SvelteSet<string>();
		_expanded.set(tabId, set);
	}
	set.add(pathKey(path));
}

/**
 * Clear EVERY per-node key belonging to `tabId`: cancel its timers, delete its
 * previews + eval-errors, and bump its generations so any in-flight evaluate
 * response is orphaned. Iterates the expanded set PLUS any lingering keys still
 * present in the per-node maps (a run for a since-collapsed node, etc.) so
 * nothing leaks. Does NOT delete `_expanded[tabId]` — callers decide that.
 */
function clearTabKeys(tabId: string): void {
	const prefix = `${tabId}::`;
	const keys = new Set<string>();
	const expanded = _expanded.get(tabId);
	if (expanded) for (const pk of expanded) keys.add(prefix + pk);
	for (const k of _previews.keys()) if (k.startsWith(prefix)) keys.add(k);
	for (const k of _evalErrors.keys()) if (k.startsWith(prefix)) keys.add(k);
	for (const k of _debounceTimers.keys()) if (k.startsWith(prefix)) keys.add(k);
	for (const k of _generations.keys()) if (k.startsWith(prefix)) keys.add(k);
	for (const key of keys) {
		cancelAutoRun(key);
		_previews.delete(key);
		_evalErrors.delete(key);
		bumpGeneration(key); // orphan any in-flight evaluate for this node
	}
}

/**
 * Move every per-node key (previews, eval-errors, generations, expanded set)
 * from `oldTab` to `newTab`, preserving each node's pathKey suffix. Used by the
 * first-save path, where a `nav:draft:*` tab is rebound to `nav:<id>` and its
 * previews must follow. Pending timers under the old tab are cancelled (they
 * would fire into the now-deleted old-tab draft and no-op anyway).
 */
function rekeyTab(oldTab: string, newTab: string): void {
	const oldPrefix = `${oldTab}::`;
	const move = <V>(m: Map<string, V> | SvelteMap<string, V>): void => {
		for (const [k, v] of [...m]) {
			if (k.startsWith(oldPrefix)) {
				m.delete(k);
				m.set(`${newTab}::${k.slice(oldPrefix.length)}`, v);
			}
		}
	};
	for (const [k, t] of [..._debounceTimers]) {
		if (k.startsWith(oldPrefix)) {
			clearTimeout(t);
			_debounceTimers.delete(k);
		}
	}
	move(_previews);
	move(_evalErrors);
	move(_generations);
	const set = _expanded.get(oldTab);
	if (set) {
		_expanded.delete(oldTab);
		_expanded.set(newTab, set);
	}
}

/** Legacy saved payloads predate `exclude_visited`; default matches the
 * backend's prior (and still-default) behavior so old payloads still load. */
function normalizeDefinition(defn: NavigationDefinition): NavigationDefinition {
	if (defn.kind === 'path' && typeof defn.exclude_visited !== 'boolean') {
		return { ...defn, exclude_visited: true };
	}
	return defn;
}

export function emptyPath(): NavigationDefinition {
	return {
		kind: 'path',
		schema_version: 1,
		start: { kind: 'scope', types: [], criteria: [] },
		steps: [],
		exclude_visited: true
	};
}

export function getDraft(tabId: string): NavDraft | undefined {
	return _drafts.get(tabId);
}
/** The preview for the node at `path` (defaults to the root node). */
export function getPreview(tabId: string, path: NodePath = []): NavPreview | undefined {
	return _previews.get(previewKey(tabId, path));
}
export function getSaveConflict(tabId: string): number | undefined {
	return _conflicts.get(tabId);
}
/** True when the node's last evaluate attempt failed (see `_evalErrors`). */
export function getEvalError(tabId: string, path: NodePath = []): boolean {
	return _evalErrors.has(previewKey(tabId, path));
}
/** True when the node at `path` is expanded (and thus previewed). */
export function isExpanded(tabId: string, path: NodePath = []): boolean {
	return _expanded.get(tabId)?.has(pathKey(path)) ?? false;
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
		_drafts.set(tabId, draft);
		markExpanded(tabId, []); // root expanded by default (empty draft: no run)
		return draft;
	} else {
		const id = tabId.slice('nav:'.length);
		const artifact = await api.getArtifact(id);
		draft = {
			name: artifact.name,
			artifactId: artifact.id,
			artifactRev: artifact.artifact_rev,
			definition: normalizeDefinition(artifact.payload as unknown as NavigationDefinition),
			dirty: false
		};
		_drafts.set(tabId, draft);
		markExpanded(tabId, []); // root expanded by default
		// Show results without requiring an edit first. Immediate (no
		// debounce — there's no rapid-fire editing to coalesce here), and
		// awaited so the preview is in place by the time the caller's
		// `ensureDraft` resolves. The rethrow is swallowed the same way the
		// debounced auto-run swallows it (see scheduleAutoRun) — a failure
		// is surfaced through the eval-error flag, not the promise.
		if (isRunnable(draft.definition)) {
			await runPreview(tabId, []).catch(() => {});
		}
		return draft;
	}
}

export function updateDefinition(tabId: string, defn: NavigationDefinition): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, definition: defn, dirty: true });
	const expanded = _expanded.get(tabId);
	if (!expanded) return;
	// Every expanded node's preview must match what's on screen. For each one:
	// if its node still exists, invalidate + reschedule its debounced run; if
	// the edit removed it (a deleted operand, or it became a ref), drop it from
	// the expanded set and clear its keys.
	for (const pk of [...expanded]) {
		const path = parsePathKey(pk);
		const key = `${tabId}::${pk}`;
		const node = nodeAt(defn, path);
		bumpGeneration(key); // any in-flight evaluate for this node is now stale
		_previews.delete(key); // stale: preview must match what's on screen
		_evalErrors.delete(key); // an old failure belongs to an old definition
		if (node) {
			scheduleAutoRun(tabId, path);
		} else {
			expanded.delete(pk); // node no longer exists — stop tracking it
			cancelAutoRun(key);
		}
	}
}

/**
 * Expand/collapse the node at `path`. On EXPAND, mark it and — if the node is
 * runnable — kick off an immediate preview run (fire-and-forget, like the
 * saved-artifact open). On COLLAPSE, cancel its pending timer, delete its
 * preview + eval-error, and bump its generation so any in-flight response is
 * orphaned (a collapsed node shows nothing).
 */
export function toggleExpanded(tabId: string, path: NodePath): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const pk = pathKey(path);
	const key = previewKey(tabId, path);
	let set = _expanded.get(tabId);
	if (!set) {
		set = new SvelteSet<string>();
		_expanded.set(tabId, set);
	}
	if (set.has(pk)) {
		set.delete(pk);
		cancelAutoRun(key);
		_previews.delete(key);
		_evalErrors.delete(key);
		bumpGeneration(key); // orphan any in-flight evaluate for the collapsed node
	} else {
		set.add(pk);
		const node = nodeAt(draft.definition, path);
		if (node && isRunnable(node)) {
			void runPreview(tabId, path).catch(() => {});
		}
	}
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
			const newTab = `nav:${created.id}`;
			_drafts.delete(tabId);
			_drafts.set(newTab, {
				...draft,
				artifactId: created.id,
				artifactRev: created.artifact_rev,
				dirty: false
			});
			// The draft tab's node previews (root + any expanded operands) must
			// follow the rebound tab id so the just-saved navigation keeps
			// showing results.
			rekeyTab(tabId, newTab);
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

/**
 * Fork the current draft into a NEW library artifact under `name`, rebind
 * `tabId` to the copy, and leave any original artifact completely untouched
 * (no update/delete call against it — this is always a create, never a
 * rename-in-place). Mirrors `saveDraft`'s create branch: the tab is re-keyed
 * from its old id to `nav:<created.id>` via `bindTabToArtifact` +
 * `rekeyTab`, carrying the tab's per-node preview/expanded state across so
 * nothing leaks or is orphaned.
 *
 * A name-clash 409 here is always the create-path shape (a plain string
 * `detail`, never `{message, current_rev}` — there is no update branch to
 * produce the rev-conflict shape), so it is left to propagate as a plain
 * error for the caller to catch, exactly like `saveDraft`'s create branch.
 * Entering conflict state would be wrong here regardless: it would point the
 * "Reload their version" recovery at the still-open ORIGINAL draft, wiping
 * unrelated unsaved edits.
 */
export async function saveAsDraft(tabId: string, name: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const payload = draft.definition as unknown as Record<string, unknown>;
	const created = await api.createArtifact({ kind: 'navigation', name, payload });
	bindTabToArtifact(tabId, created.id);
	const newTab = `nav:${created.id}`;
	_drafts.delete(tabId);
	_conflicts.delete(tabId);
	_drafts.set(newTab, {
		...draft,
		name,
		artifactId: created.id,
		artifactRev: created.artifact_rev,
		dirty: false
	});
	// Carry the tab's per-node previews/expanded set to the new tab key, same
	// as saveDraft's first-save path.
	rekeyTab(tabId, newTab);
	await loadArtifacts().catch(() => {});
}

/** Discard the local draft and re-fetch the server copy (409 recovery). */
export async function reloadDraft(tabId: string): Promise<void> {
	clearTabKeys(tabId); // the definition is about to change: orphan in-flight runs
	_drafts.delete(tabId);
	_conflicts.delete(tabId);
	_expanded.delete(tabId);
	await ensureDraft(tabId);
}

export async function runPreview(tabId: string, path: NodePath = []): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	// Evaluate the addressed node (path === [] is the whole definition). `nodeAt`
	// returns null for a ref operand / out-of-range path — refs get no per-node
	// preview this iteration, so guard and skip.
	const node = nodeAt(draft.definition, path);
	if (!node) return;
	const key = previewKey(tabId, path);
	const gen = bumpGeneration(key); // supersede any older in-flight evaluate
	_evalErrors.delete(key); // a fresh attempt starts clean
	_previews.set(key, {
		stepTypes: [],
		chains: [],
		total: 0,
		truncated: false,
		loading: true
	});
	try {
		const page = await api.evaluateNavigation({
			definition: node,
			limit: PAGE,
			offset: 0
		});
		if (!isCurrent(tabId, key, gen)) return; // stale: edited/collapsed/closed mid-flight
		_previews.set(key, {
			stepTypes: page.step_types,
			chains: page.chains,
			total: page.total,
			truncated: page.truncated,
			loading: false
		});
	} catch (err) {
		if (isCurrent(tabId, key, gen)) {
			_previews.delete(key);
			// Surface the failure (the auto-run callers swallow the rethrow):
			// only for a CURRENT failure — a stale one belongs to a node that is
			// no longer on screen and must not tag the newer one.
			_evalErrors.set(key, true);
		}
		throw err;
	}
}

export async function loadMorePreview(tabId: string, path: NodePath = []): Promise<void> {
	const draft = _drafts.get(tabId);
	const key = previewKey(tabId, path);
	const preview = _previews.get(key);
	if (!draft || !preview || preview.loading) return;
	if (preview.chains.length >= preview.total) return;
	const node = nodeAt(draft.definition, path);
	if (!node) return;
	const gen = _generations.get(key) ?? 0; // extend the CURRENT preview only
	_previews.set(key, { ...preview, loading: true });
	try {
		const page = await api.evaluateNavigation({
			definition: node,
			limit: PAGE,
			offset: preview.chains.length
		});
		if (!isCurrent(tabId, key, gen)) return; // stale: edited/re-run/collapsed/closed mid-flight
		_previews.set(key, {
			...preview,
			chains: [...preview.chains, ...page.chains],
			total: page.total,
			truncated: page.truncated,
			loading: false
		});
	} catch {
		// Swallow: the caller fires this with `void` (no catch), and losing one
		// page is recoverable — restore loading so Load more can be retried.
		if (isCurrent(tabId, key, gen)) _previews.set(key, { ...preview, loading: false });
	}
}

export function closeDraft(tabId: string): void {
	clearTabKeys(tabId); // cancel timers, drop previews/errors, orphan in-flight runs
	_drafts.delete(tabId);
	_conflicts.delete(tabId);
	_expanded.delete(tabId);
}

export function resetNavigationEditors(): void {
	for (const timer of _debounceTimers.values()) clearTimeout(timer);
	_debounceTimers.clear();
	_drafts.clear();
	_previews.clear();
	_conflicts.clear();
	_evalErrors.clear();
	_expanded.clear();
	// Bump (not clear) so in-flight responses from before the reset stay stale
	// even if the same node key is immediately re-created.
	for (const key of _generations.keys()) bumpGeneration(key);
}
