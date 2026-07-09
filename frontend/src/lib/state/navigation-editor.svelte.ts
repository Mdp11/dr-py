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
 * pathKeys. A node is previewed while it is VISIBLE — card components
 * register/unregister it on mount/unmount, and `ensureDraft` pins the root —
 * there is no user-facing collapse toggle. `_selected` maps a tabId to the
 * one selected node's pathKey; the dock renders it and structural edits
 * remap it.
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
import {
	emptyPath,
	isRunnable,
	nodeAt,
	nodeExistsAt,
	pathKey,
	type NodePath,
	type StructuralEdit
} from '$lib/navigation/tree';
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

/** tabId -> the pathKey of the ONE selected node (`''` = root). The dock
 * renders this node's chains; a card click sets it. Selection is per-node
 * state like previews, so `applyStructuralEdit` remaps it and `rekeyTab`
 * carries it. */
const _selected = new SvelteMap<string, string>();

/**
 * previewKey -> how many live references hold this node visible. Card
 * components register on mount and unregister on unmount; `ensureDraft` pins
 * the ROOT with one reference for the lifetime of the draft. Refcounted
 * because Svelte gives no ordering guarantee between the unmount of a card
 * and the mount of its replacement at the same path (a Path auto-wrapping
 * into a Combination swaps components at path `[]`): a plain add/delete pair
 * would let the late unregister tear down a node that is on screen, cancelling
 * its debounce timer and silently killing auto-run. Control state, never read
 * from templates. Counts are POSITION-anchored and deliberately NOT remapped
 * by `applyStructuralEdit` — only `_expanded` keys are remapped; card
 * `$effect`s re-register on path change and the root pin is anchored at `''`,
 * so remapping counts would break the root pin.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _visibleCounts = new Map<string, number>();

/**
 * NODES whose LAST evaluate attempt failed, keyed by previewKey. With no manual
 * Run button the auto-run callers are fire-and-forget (they swallow the
 * rejection), so this flag IS the surfacing: StatusChip and ResultsDock render
 * it as a muted error line when the node is runnable but no preview exists.
 * Set only when the failure is still current (same `isCurrent` discipline as the preview catch
 * path); cleared by any edit to the node (`updateDefinition`), a new run
 * starting (`runPreview`), the last visible reference going away
 * (`unregisterVisibleNode`), `closeDraft`, `reloadDraft`, and reset — an error
 * must never outlive the node it belongs to.
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
				// ResultsDock surfaces to the user.
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

/** Pin the ROOT node visible for the draft's lifetime. The root is always
 * rendered, and the pin keeps its preview alive across the PathCard ->
 * CombineFrame component swap that an auto-wrap performs at path `[]`.
 * Released only by closeDraft/reloadDraft/reset. Also seeds the tab's
 * selection at the root (unless one is already present) so a structural edit
 * fired before the user ever clicks a card still has a selection to carry
 * through `remapPath` — mirroring the expanded-set seed above. */
function pinRoot(tabId: string): void {
	markExpanded(tabId, []);
	const key = previewKey(tabId, []);
	_visibleCounts.set(key, (_visibleCounts.get(key) ?? 0) + 1);
	if (!_selected.has(tabId)) _selected.set(tabId, '');
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
	// Ephemeral scratch set: built and drained within this function call —
	// never stored or read reactively.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const keys = new Set<string>();
	const expanded = _expanded.get(tabId);
	if (expanded) for (const pk of expanded) keys.add(prefix + pk);
	for (const k of _previews.keys()) if (k.startsWith(prefix)) keys.add(k);
	for (const k of _evalErrors.keys()) if (k.startsWith(prefix)) keys.add(k);
	for (const k of _debounceTimers.keys()) if (k.startsWith(prefix)) keys.add(k);
	for (const k of _generations.keys()) if (k.startsWith(prefix)) keys.add(k);
	for (const k of _visibleCounts.keys()) if (k.startsWith(prefix)) keys.add(k);
	for (const key of keys) {
		cancelAutoRun(key);
		_previews.delete(key);
		_evalErrors.delete(key);
		_visibleCounts.delete(key);
		bumpGeneration(key); // orphan any in-flight evaluate for this node
	}
}

/**
 * Move every per-node key (previews, eval-errors, generations, expanded set)
 * from `oldTab` to `newTab`, preserving each node's pathKey suffix. Used by the
 * first-save path, where a `nav:draft:*` tab is rebound to `nav:<id>` and its
 * previews must follow.
 *
 * Auto-run must SURVIVE the rebind, not just its results: a save landing
 * inside the debounce window would otherwise silently swallow the pending run
 * (the edit already cleared the node's preview, so the node would sit blank —
 * runnable, no error, no run coming — until the next edit), and an evaluate
 * still in flight would have its response orphaned (its generation entry moved
 * to the new key, so the old-key `isCurrent` check fails) leaving the moved
 * preview stuck on `loading: true`. So: pending timers are rescheduled under
 * the new tab id, and moved previews still marked loading are re-issued
 * immediately. Callers must have `_drafts.set(newTab, ...)` in place first —
 * both re-runs read the draft under the NEW id.
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
	const pendingPks: string[] = [];
	for (const [k, t] of [..._debounceTimers]) {
		if (k.startsWith(oldPrefix)) {
			clearTimeout(t);
			_debounceTimers.delete(k);
			pendingPks.push(k.slice(oldPrefix.length));
		}
	}
	move(_previews);
	move(_evalErrors);
	move(_generations);
	move(_visibleCounts);
	const set = _expanded.get(oldTab);
	if (set) {
		_expanded.delete(oldTab);
		_expanded.set(newTab, set);
	}
	const sel = _selected.get(oldTab);
	if (sel !== undefined) {
		_selected.delete(oldTab);
		_selected.set(newTab, sel);
	}
	for (const pk of pendingPks) scheduleAutoRun(newTab, parsePathKey(pk));
	const newPrefix = `${newTab}::`;
	for (const [k, preview] of [..._previews]) {
		if (k.startsWith(newPrefix) && preview.loading && !_debounceTimers.has(k)) {
			void runPreview(newTab, parsePathKey(k.slice(newPrefix.length))).catch(() => {});
		}
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
/** True when the node at `path` is rendered somewhere (and thus previewed). */
export function isNodeVisible(tabId: string, path: NodePath = []): boolean {
	return _expanded.get(tabId)?.has(pathKey(path)) ?? false;
}

/**
 * Take a reference on the node at `path`: it becomes VISIBLE (its preview
 * auto-runs on every edit, keeping its status chip live). Called by each card
 * component on mount, and once by `ensureDraft` to pin the always-rendered
 * root. Only the 0 -> 1 transition may kick a run, and only when nothing is
 * already pending for the node — an `applyStructuralEdit` that has just
 * scheduled the debounced run must not be double-fired. Fire-and-forget, like
 * the saved-artifact open: the eval-error flag is the failure surface.
 */
export function registerVisibleNode(tabId: string, path: NodePath): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const key = previewKey(tabId, path);
	const next = (_visibleCounts.get(key) ?? 0) + 1;
	_visibleCounts.set(key, next);
	markExpanded(tabId, path);
	if (next > 1) return;
	if (_previews.has(key) || _debounceTimers.has(key)) return;
	const node = nodeAt(draft.definition, path);
	if (node && isRunnable(node)) void runPreview(tabId, path).catch(() => {});
}

/**
 * Release a reference. On the LAST one the node stops being visible: cancel
 * its pending timer, delete its preview + eval-error, and bump its generation
 * so any in-flight evaluate response is orphaned (exactly what collapsing used
 * to do). Earlier references keep it alive.
 */
export function unregisterVisibleNode(tabId: string, path: NodePath): void {
	const key = previewKey(tabId, path);
	const next = (_visibleCounts.get(key) ?? 0) - 1;
	if (next > 0) {
		_visibleCounts.set(key, next);
		return;
	}
	_visibleCounts.delete(key);
	_expanded.get(tabId)?.delete(pathKey(path));
	cancelAutoRun(key);
	_previews.delete(key);
	_evalErrors.delete(key);
	bumpGeneration(key);
}

/** The tab's selected node path (`[]` = root, the default). */
export function getSelectedPath(tabId: string): NodePath {
	return parsePathKey(_selected.get(tabId) ?? '');
}

/** Select the node the results dock shows. Exactly one per tab. */
export function selectNode(tabId: string, path: NodePath): void {
	_selected.set(tabId, pathKey(path));
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
		pinRoot(tabId); // root pinned visible by default (empty draft: no run)
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
		pinRoot(tabId); // root pinned visible by default
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
	if (expanded) {
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
	// A field edit can delete the selected node (e.g. replacing a combination
	// start with a plain scope). Selection must never dangle: fall back to the
	// root, which always exists.
	const selPk = _selected.get(tabId);
	if (selPk !== undefined && selPk !== '' && !nodeExistsAt(defn, parsePathKey(selPk))) {
		_selected.set(tabId, '');
	}
}

/**
 * Apply a STRUCTURAL edit (auto-wrap insert, operand removal, reorder) and
 * carry each expanded node's key to the node's NEW position via the edit's
 * `remapPath` before the ordinary `updateDefinition` invalidation runs.
 * Without this, per-node state keyed by the old position silently detaches
 * from the node the user is looking at: an expanded operand stops auto-running
 * after a sibling above it is removed (its index shifted), a wrapped root's
 * open preview vanishes (the node moved to operand 0), and reordering swaps
 * which nodes are expanded. Field edits inside one node never move nodes and
 * keep calling `updateDefinition` directly.
 */
export function applyStructuralEdit(tabId: string, edit: StructuralEdit): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const expanded = _expanded.get(tabId);
	if (expanded) {
		const oldPks = [...expanded];
		const nextPks: string[] = [];
		for (const pk of oldPks) {
			const np = edit.remapPath(parsePathKey(pk));
			if (np !== null) nextPks.push(pathKey(np));
		}
		// Retire every OLD key whose node moved away or was removed: its
		// preview/error/timer belong to a position that now shows a different
		// node (or nothing). Keys that remap onto themselves — and old keys that
		// another node moved ONTO — are left for updateDefinition's sweep below.
		for (const pk of oldPks) {
			if (!nextPks.includes(pk)) {
				const key = `${tabId}::${pk}`;
				cancelAutoRun(key);
				_previews.delete(key);
				_evalErrors.delete(key);
				bumpGeneration(key);
				expanded.delete(pk);
			}
		}
		for (const pk of nextPks) expanded.add(pk);
		// The root position is permanently pinned (`pinRoot`, called once by
		// `ensureDraft`): it stays visible for the whole draft's lifetime, even
		// when the edit moves its old node away entirely and a BRAND-NEW node
		// now occupies `[]` (the auto-wrap's Combine is the case in point — the
		// retire loop above just cleared its predecessor's stale preview). Force
		// it back into the expanded set so updateDefinition's sweep below picks
		// it up and reschedules its run against whatever now sits at the root.
		expanded.add('');
	}
	// Selection is per-node state too: it must follow the node through the
	// mutation (a removed selected node falls back to the root).
	const selPk = _selected.get(tabId);
	if (selPk !== undefined) {
		const np = edit.remapPath(parsePathKey(selPk));
		_selected.set(tabId, np === null ? '' : pathKey(np));
	}
	updateDefinition(tabId, edit.defn);
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
	// bindTabToArtifact only re-keys the tab id — the visible tab title still
	// shows the OLD name (setDraftName is what normally keeps it in sync, but
	// there was no such edit here: `name` is a fresh argument, not something
	// the user typed into the draft-name input). Retitle explicitly so the
	// tab label matches the new library entry, same as the sidebar/name input.
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
	_selected.delete(tabId);
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
	_selected.delete(tabId);
}

export function resetNavigationEditors(): void {
	for (const timer of _debounceTimers.values()) clearTimeout(timer);
	_debounceTimers.clear();
	_drafts.clear();
	_previews.clear();
	_conflicts.clear();
	_evalErrors.clear();
	_expanded.clear();
	_visibleCounts.clear();
	_selected.clear();
	// Bump (not clear) so in-flight responses from before the reset stay stale
	// even if the same node key is immediately re-created.
	for (const key of _generations.keys()) bumpGeneration(key);
}
