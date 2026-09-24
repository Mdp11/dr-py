import { SvelteMap } from 'svelte/reactivity';

import type { ClientConfig } from '$lib/api/client';
import type { Issue, IssueCounts, ModelSummary, OpsResponse } from '$lib/api/types';
import { engineSide } from '../api/engine-route';
import * as modelReadApi from '../api/model-read';
import { getModelIssues, type RulesStatus } from '../api/validation';
import { clearOverlay } from './validation.svelte';

/**
 * Shared half of the staged-commit model store: the model-wide counters and
 * error/status state both entity halves (legacy, engine) read and write —
 * summary, revision, structure revision, the live issue map and the
 * generation counter. Neither half owns a copy of this state; they reach it
 * through the setters below (`setModelRev`, `bumpStructureRev`,
 * `nextGeneration`, `applyDeltaShared`, `patchSummary`) so `model.svelte.ts`
 * (the facade) can dispatch entity reads/writes to either half while this
 * file stays the single source of truth for what both agree on.
 */

export interface ModelStoreError {
	kind: 'conflict' | 'rejected' | 'error';
	message: string;
}

/** Issues keyed by OWNER (= issue.target_ids[0]), mirroring the backend
 * ValidationState; fed by ops deltas and full validateAll() runs. */
const _issuesByOwner = new SvelteMap<string, Issue[]>();

let _summary: ModelSummary | null = $state(null);
let _modelRev = $state(0);
/** Bumped only by STRUCTURAL deltas (created/deleted entities, changed
 * relationships) — see {@link getStructureRev}. */
let _structureRev = $state(0);
let _issueCounts: IssueCounts | null = $state(null);
/** Exact total issue count when the last adoptIssues() was truncated at the
 * server cap; null when the live map is complete. Rendered by IssuesPanel. */
let _issuesTruncatedTotal: number | null = $state(null);
/** Compiled-rules health from the last GET /model/issues; null before the
 * first fetch (distinct from a fetch that reports zero skips). */
let _rulesStatus: RulesStatus | null = $state(null);
let _error: ModelStoreError | null = $state(null);

/** Bumped by resetSharedStore so in-flight responses of a dead store are
 * dropped. Reactive: consumers use it as the "a different model was
 * installed" signal (model_rev alone is ambiguous — two freshly loaded
 * models both start at the same rev). */
let _generation = $state(0);

/** Test/dev hook: `ClientConfig` forwarded to every direct API call either
 * half makes (bypassing the engine seam) — see `setModelApiConfig` in
 * `model-legacy.svelte.ts`, which is the public setter for this value. */
let _clientConfig: ClientConfig | undefined;

export function getClientConfig(): ClientConfig | undefined {
	return _clientConfig;
}

export function setClientConfig(cfg: ClientConfig | undefined): void {
	_clientConfig = cfg;
}

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

export function getIssuesByOwner(): ReadonlyMap<string, Issue[]> {
	return _issuesByOwner;
}

/** The live committed issue list: `_issuesByOwner` flattened in insertion
 * order (deterministic — mirrors the server store's owner ordering). */
export function getLiveIssues(): Issue[] {
	const out: Issue[] = [];
	for (const issues of _issuesByOwner.values()) out.push(...issues);
	return out;
}

export function getIssuesTruncatedTotal(): number | null {
	return _issuesTruncatedTotal;
}

/** null before the first GET /model/issues fetch. */
export function getRulesStatus(): RulesStatus | null {
	return _rulesStatus;
}

export function getModelSummary(): ModelSummary | null {
	return _summary;
}

export function getModelRev(): number {
	return _modelRev;
}

export function setModelRev(rev: number): void {
	_modelRev = rev;
}

/**
 * Structural-change counter for refetch effects (containment tree, incident
 * relationships, neighborhood graph). Unlike `model_rev` — which bumps on
 * EVERY acked batch, including debounced property-only updates while the user
 * types — this bumps only when a delta creates or deletes entities or touches
 * relationships, i.e. when paged read results can actually have changed
 * shape. Track this (+ `getModelGeneration()`) instead of `getModelRev()` to
 * avoid a refetch fan-out per keystroke ack.
 */
export function getStructureRev(): number {
	return _structureRev;
}

export function bumpStructureRev(): void {
	_structureRev += 1;
}

/**
 * Makes every structure-tracking read run again without a delta: a replica
 * that re-bootstraps onto a new metamodel answered the delta's refetch from
 * its frozen, older state.
 */
export function markStructureChanged(): void {
	bumpStructureRev();
}

/** Bumps on every {@link resetSharedStore} — i.e. whenever a different model
 * (or no model) is installed. Refresh effects track this + `getModelRev()`. */
export function getModelGeneration(): number {
	return _generation;
}

export function nextGeneration(): void {
	_generation += 1;
}

/** null = the model has not been validated yet (distinct from zero issues). */
export function getIssueCounts(): IssueCounts | null {
	return _issueCounts;
}

export function getModelError(): ModelStoreError | null {
	return _error;
}

export function clearModelError(): void {
	// conflict errors are NOT clearable this way: the store is divergent and
	// only a reload (resetModelStore + refetch) makes it trustworthy again
	if (_error !== null && _error.kind !== 'conflict') _error = null;
}

export function setModelError(e: ModelStoreError | null): void {
	_error = e;
}

/** Keep the coherent bits of a loaded summary in sync with a delta; element/
 * relationship counts are NOT maintained incrementally (refreshSummary() is
 * the cheap exact source). A no-op before a summary has ever been loaded. */
export function patchSummary(modelRev: number, issueCounts: IssueCounts): void {
	if (_summary !== null) {
		_summary = { ..._summary, model_rev: modelRev, issue_counts: issueCounts };
	}
}

/** Bucket an issue under its owner (= target_ids[0]), mirroring the backend ValidationState. */
function addIssueToOwner(issue: Issue): void {
	const owner = issue.target_ids[0] ?? '';
	const existing = _issuesByOwner.get(owner);
	if (existing !== undefined) _issuesByOwner.set(owner, [...existing, issue]);
	else _issuesByOwner.set(owner, [issue]);
}

/**
 * Splice an {@link OpsResponse} delta's SHARED half into the store: the
 * structural formula, the issue-store delta, the Validate overlay, and the
 * revision/summary counters. `hasElement` answers whether an entity the delta
 * calls "changed" was already cached BEFORE this delta — the entity-half's
 * own cache, since the structural formula must see it pre-remap (a just-
 * created id looked up by its (canonical) id would otherwise read as
 * "already known"). Returns whether the delta was structural, so a caller
 * doing its own structural-triggered work need not recompute it.
 *
 * Does not touch entity caches, staged ops, selection or visit history — that
 * is each entity half's own `applyDelta`. `structure: false` leaves the
 * structure rev alone, for a half that moves it on a signal of its own;
 * `rev: false` leaves `model_rev` (the store's and the summary's) alone, for
 * a delta older than what the store already shows — the issue splice, the
 * issue counts and the overlay clear still apply.
 */
export function applyDeltaShared(
	d: OpsResponse,
	hasElement: (id: string) => boolean,
	options: { structure?: boolean; rev?: boolean } = {}
): boolean {
	// Structural = anything that can change paged read results (containment
	// levels, incident-relationship pages, neighborhoods): entity creation
	// (acked creates always carry a temp-id -> canonical-id mapping), entity
	// deletion, or any relationship change. Property-only element acks (the
	// per-keystroke debounced updates) deliberately do NOT count.
	const structural =
		Object.keys(d.id_map).length > 0 ||
		d.changed_relationships.length > 0 ||
		d.deleted_element_ids.length > 0 ||
		d.deleted_relationship_ids.length > 0 ||
		d.changed_elements.some((e) => !hasElement(e.id));

	for (const owner of d.issues_removed_owner_ids) _issuesByOwner.delete(owner);
	for (const issue of d.issues_added) addIssueToOwner(issue);
	clearOverlay(); // committed truth moved; any Validate snapshot is moot

	const moveRev = options.rev !== false;
	if (moveRev) setModelRev(d.model_rev);
	if (structural && options.structure !== false) bumpStructureRev();
	_issueCounts = d.issue_counts;
	if (moveRev) patchSummary(d.model_rev, d.issue_counts);
	else if (_summary !== null) _summary = { ..._summary, issue_counts: d.issue_counts };

	return structural;
}

// ---------------------------------------------------------------------------
// Summary / validation / lifecycle
// ---------------------------------------------------------------------------

/**
 * Fetch GET /model/summary and adopt rev / issue counts. The engine's summary
 * carries no issue counts: answered there, the store keeps its own and asks
 * GET /model/issues for fresh ones. Its `rev` is never older than the store's,
 * as an engine read waits for every `rev` the replica was told of.
 */
export async function refreshSummary(): Promise<ModelSummary> {
	const fromEngine = engineSide('summary') === 'engine';
	const s = await modelReadApi.getModelSummary(_clientConfig);
	_modelRev = s.model_rev;
	if (fromEngine) {
		const adopted = { ...s, issue_counts: _issueCounts };
		_summary = adopted;
		void refetchIssues();
		return adopted;
	}
	_summary = s;
	_issueCounts = s.issue_counts;
	return s;
}

/** Like {@link refreshSummary} but a no-op when a summary is already loaded. */
export async function loadSummary(): Promise<ModelSummary> {
	return _summary ?? refreshSummary();
}

/**
 * Adopt a summary the caller already holds (load/upload responses return one)
 * without an extra GET /model/summary round-trip. Load flows call
 * `resetModelStore()` first, then this.
 */
export function adoptSummary(s: ModelSummary): void {
	_summary = s;
	_modelRev = s.model_rev;
	_issueCounts = s.issue_counts;
}

/**
 * Adopt an issue snapshot (GET /model/issues, or the engine's list over the
 * working copy) as the live store. Ignores a response STRICTLY older than the
 * cached rev (it lost a race with a commit splice; the next delta or refetch
 * heals) — equal-rev responses are adopted because the background sweep
 * grows the store WITHOUT bumping model_rev, and the engine's list moves
 * with staged edits. Clears the Validate overlay: committed truth moved, so
 * any staged snapshot is moot.
 */
export function adoptIssues(
	issues: Issue[],
	counts: IssueCounts,
	modelRev: number,
	truncated = false
): void {
	if (modelRev < _modelRev) return;
	_issuesByOwner.clear();
	for (const issue of issues) addIssueToOwner(issue);
	_issueCounts = counts;
	if (_summary !== null) _summary = { ..._summary, issue_counts: counts };
	_issuesTruncatedTotal = truncated ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
	clearOverlay();
}

/** Fetch GET /model/issues — the engine's list, with the issues on it — and
 * adopt it. Best-effort by contract: every caller is a background refresh
 * (boot, peer commit, sweep completion, feed reconnect, the replica's issue
 * store moving) where a miss just means the next event heals. */
export async function refetchIssues(): Promise<void> {
	// Same guard every other in-flight read in this store relies on
	// (`_generation`): a boot refetch for project A that lands after a switch
	// to project B must NOT be adopted into B. The rev guard in adoptIssues
	// cannot catch it — resetSharedStore put `_modelRev` back to 0, so any rev
	// passes it.
	const gen = _generation;
	try {
		const res = await getModelIssues(_clientConfig);
		if (gen !== _generation) return; // a different model was installed mid-flight
		adoptIssues(res.issues, res.counts, res.model_rev, res.truncated);
		_rulesStatus = res.rules_status;
	} catch {
		// keep the current map; the next commit delta or refetch heals
	}
}

// Debounce for issue refetches: peer commits, reconnect snapshots and the
// replica's issue-store moves can arrive in bursts (a multi-op batch, a flaky
// connection reconnecting several times, a sweep's slices); one GET per burst
// is enough. The refetch corrects what the synthesized peer-commit delta
// cannot know — the feed event carries no issue delta by design: refetch is
// preferred over shipping deltas on the wire because reconnect needs the
// refetch path anyway.
let _issuesRefetchTimer: ReturnType<typeof setTimeout> | null = null;

/** Refetches the issues 300 ms after the last of a burst of calls. */
export function scheduleIssuesRefetch(): void {
	if (_issuesRefetchTimer !== null) clearTimeout(_issuesRefetchTimer);
	_issuesRefetchTimer = setTimeout(() => {
		_issuesRefetchTimer = null;
		void refetchIssues();
	}, 300);
}

export function cancelIssuesRefetch(): void {
	if (_issuesRefetchTimer !== null) clearTimeout(_issuesRefetchTimer);
	_issuesRefetchTimer = null;
}

/**
 * Drop the shared counters and issue map — for tests and for replacing the
 * model (`resetModelStore()`, the facade, calls this and the entity half's
 * own reset). In-flight responses from before the reset are ignored when
 * they land (see the `_generation` guard on {@link refetchIssues}).
 *
 * The Validate OVERLAY goes with them: it is origin-tagged against the model
 * being dropped, and since the overlay WINS over the live map in every issue
 * consumer, leaving it would render the old project's staged issues across the
 * new one's whole UI — indefinitely, if the new project's best-effort issue
 * refetch fails (a failed refetch never reaches adoptIssues, so nothing else
 * would clear it).
 */
export function resetSharedStore(): void {
	nextGeneration();
	clearOverlay();
	_issuesByOwner.clear();
	_summary = null;
	_modelRev = 0;
	_structureRev = 0;
	_issueCounts = null;
	_issuesTruncatedTotal = null;
	_rulesStatus = null;
	_error = null;
}
