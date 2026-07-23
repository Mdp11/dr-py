/**
 * Per-tab table drafts. Keyed by the workspace tab id so several table
 * editors can be open at once. This is the SIMPLER sibling of
 * `navigation-editor.svelte.ts` (no per-node previews, no expand/collapse
 * tree, no debounced auto-run), so all state here is keyed by `tabId` alone.
 *
 * Definitions are edited as plain JSON objects (the backend's
 * `TableDefinitionSchema` is the source of truth for validity; `columns.ts`
 * keeps definitions structurally correct by construction). Editing invalidates
 * the loaded rows: `updateTableDefinition` and `setTableSort` both reset to
 * offset 0 and re-request. There is no auto-run debounce — the caller (the
 * table editor UI) decides when to call `updateTableDefinition`.
 *
 * ROWS ARE A SPARSE CACHE, not a single page: `_data` holds, per tab, a
 * `TableData` whose `rows` array is `total` long with un-fetched slots left
 * `undefined` (the grid renders those as placeholders). `loadTablePage`
 * RESETS the cache from one response (definition/sort edits, external model
 * change); `ensureTableRange` lazily fills PAGE-aligned chunks around
 * whatever window the grid reports as visible, so scrolling streams rows in
 * without ever discarding what is already loaded. The backend caches the
 * ordered row set per (definition, sort, model_rev), so chunk requests are
 * cheap page reads, not re-evaluations.
 *
 * Staleness is guarded by a per-TAB generation counter (mirrors nav-editor's
 * `_generations`, just without the per-node keying): anything that makes an
 * in-flight `evaluateTable` response stale — a new `loadTablePage` call, a
 * reload, a close, a reset — bumps the tab's generation, and the async
 * loaders (full load AND chunk fills) drop the response on mismatch (or when
 * the draft is gone).
 */
import { SvelteMap } from 'svelte/reactivity';
import * as api from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import { evaluateTable, exportTable, fetchScriptErrors } from '$lib/api/tables';
import {
	TableDefinitionSchema,
	type ScriptErrorsRecap,
	type ScriptStatus,
	type TableColumn,
	type TableDefinition,
	type TablePage,
	type TableRow,
	type TableSort
} from '$lib/api/types';
import { loadArtifacts } from './artifacts.svelte';
import { onCommitEvent } from './realtime.svelte';
import { bindTabToArtifact, retitleTab } from './workspace.svelte';

/** Chunk size for both full loads and lazy range fills. */
const PAGE = 100;
/** The backend's `EvaluateTableIn.limit` upper bound (`le=500`). */
const MAX_LIMIT = 500;
/** Delay between two script-sweep polls (matches the backend's Retry-After). */
const POLL_MS = 1_000;
/** Bound on consecutive `computing` polls for one tab, mirroring
 * `EXPORT_MAX_ATTEMPTS` (~2 minutes at POLL_MS). A backend that somehow keeps
 * answering `computing` must not turn into an infinite client loop — every
 * poll costs a full server-side table pass. Reset by any user-initiated load. */
const POLL_MAX_ATTEMPTS = 120;
/** Delay between two script-error recap retries (the recap route answers 202
 * with `Retry-After: 1` while the sweep is still filling the cache). */
const RECAP_RETRY_MS = 1_000;
/** Bound on consecutive 202 recap retries for one tab. Same reasoning — and
 * the same order of magnitude — as `POLL_MAX_ATTEMPTS`: a recap is a
 * whole-table pass server-side, so "still computing" must never turn into an
 * unbounded once-a-second request loop. Giving up leaves NO badge, which is
 * the honest degraded answer (we do not know the failures) rather than an
 * error strip for something the user did not ask for. */
const RECAP_MAX_ATTEMPTS = 120;
/** Delay between two export retries while the sweep is still computing
 * (the backend answers 202 with `Retry-After: 1`). */
const EXPORT_RETRY_MS = 1_000;
/** Bound on export retries so a stuck sweep surfaces an error instead of
 * spinning silently forever (~2 minutes at EXPORT_RETRY_MS). */
const EXPORT_MAX_ATTEMPTS = 120;

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
			{
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: '',
				width_px: null,
				hidden: false
			}
		]
	};
}

/**
 * The per-tab row cache the grid renders. Same fields as a `TablePage`, but
 * `rows` is SPARSE: `total` long, with un-fetched slots `undefined`. `offset`
 * is the offset of the last full (reset) load — kept so a rebound tab's
 * re-issued load lands where the user was.
 */
export interface TableData {
	columns: TableColumn[];
	rows: (TableRow | undefined)[];
	total: number;
	/** Rows before expand columns split them — see TablePageSchema.base_total. */
	base_total?: number | null;
	truncated: boolean;
	offset: number;
	model_rev: number;
	/** Non-fatal per-page issues surfaced by embedded script evaluation (e.g. a
	 * ScriptColumn raising on some rows) — see TablePageSchema.warnings. */
	warnings: string[];
}

const _drafts = new SvelteMap<string, TableDraft>();
/** tabId -> the sparse row cache. */
const _pages = new SvelteMap<string, TableData>();
/** tabId -> the active sort (undefined = no sort). */
const _sorts = new SvelteMap<string, TableSort>();
const _loading = new SvelteMap<string, boolean>();
/** tabId -> the last load's error message (422/500). */
const _errors = new SvelteMap<string, string>();
const _conflicts = new SvelteMap<string, number>(); // tabId -> server rev
/**
 * tabId -> the last page's `script_status`. Rendered (progress readout /
 * failure strip), so it lives in a reactive map like `_loading`.
 */
const _scriptStatus = new SvelteMap<string, ScriptStatus>();

/**
 * tabId -> the whole-table script-error recap for the page state currently on
 * screen (`POST /tables/script-errors`). Rendered as the error badge + panel,
 * so it lives in a reactive map. Absent means "no recap to show": no script
 * column, a table that has not settled yet, or a recap fetch that failed —
 * embedded evaluation is degraded-never-failed, and that stance extends here.
 */
const _scriptErrors = new SvelteMap<string, ScriptErrorsRecap>();

/**
 * tabId -> the page state the tab's recap was fetched for, as
 * `"<script status>:<model_rev>:<generation>"`. This is the whole fetch-once
 * discipline: a recap costs a whole-table pass server-side, and
 * `handleScriptStatus` runs on EVERY landing page (including each background
 * chunk fill), so without a signature a settled table would re-fetch the recap
 * on every scroll. Set before the request goes out (so an in-flight fetch is
 * not duplicated) and dropped again if that request fails, so a later page
 * retries it.
 *
 * THE GENERATION IS LOAD-BEARING — do not reduce this to status + rev. A sort
 * change, a definition edit and a reload all re-evaluate the table at a
 * CONSTANT `model_rev` while reordering (or renumbering) every row, and a
 * recap's `row_index`/`column_index` are addresses into the order the grid is
 * showing. Keyed without the generation, the tab would keep serving the recap
 * built for the previous order and jump-to-cell would scroll to the wrong row.
 * `bumpGeneration` runs on exactly those re-evaluations, which is why it is
 * the right signal. See `handleScriptErrorRecap` for the full table.
 *
 * Control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _recapKeys = new Map<string, string>();

/**
 * tabId -> the ONE pending recap retry timer, and the consecutive 202s it has
 * spent. Same single-timer discipline as `_pollTimers`/`_pollAttempts`, kept
 * separate because the two loops answer different signals (a `computing` page
 * vs a 202 recap) and can in principle overlap for one tab.
 * Control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _recapTimers = new Map<string, ReturnType<typeof setTimeout>>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _recapAttempts = new Map<string, number>();

/**
 * tabId -> a pending "scroll the grid to this cell" request, set by the error
 * panel and consumed by `TableGrid`'s effect. Deliberately REACTIVE (unlike
 * the other control-state maps): the grid's `$effect` has to re-run when a
 * request appears, and it only ever reads it through `consumeScrollRequest`,
 * which clears the entry — so the effect converges after one extra run.
 */
const _scrollRequests = new SvelteMap<string, { rowIndex: number; columnIndex: number }>();

/**
 * tabId -> the ONE pending script-sweep re-poll. Exactly one timer per tab:
 * every landing page cancels the previous timer before scheduling its own, or
 * concurrent chunk fills would compound the polls geometrically. Control
 * state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _pollTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * tabId -> consecutive script-sweep polls issued for this tab (the loop bound,
 * see `POLL_MAX_ATTEMPTS`). Deliberately NOT cleared by `bumpGeneration`: every
 * poll goes through `loadTablePage`, which bumps the generation, so a
 * generation-scoped counter would reset itself on every tick and bound nothing.
 * Cleared on a non-`computing` status, on a USER-initiated load, and by the
 * per-tab teardown paths. Control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _pollAttempts = new Map<string, number>();

/**
 * Per-TAB page-load generation. Control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _generations = new Map<string, number>();

/**
 * In-flight chunk fills: tabId -> chunk offset -> the generation the fetch was
 * issued under, so `ensureTableRange` doesn't double-request a chunk. Control
 * state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _inflightChunks = new Map<string, Map<number, number>>();

/**
 * Failed-chunk retry counters: tabId -> chunk offset -> attempts so far.
 * A failed background fill would otherwise leave its rows as placeholders
 * forever unless the user happens to scroll again (the grid's range effect
 * only re-runs on window/cache changes) — so each failure schedules a
 * bounded, delayed re-request. Cleared on every generation bump (a reset
 * starts the count over). Control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _chunkRetries = new Map<string, Map<number, number>>();
const CHUNK_RETRY_DELAY_MS = 2_000;
const CHUNK_RETRY_MAX = 3;

/**
 * The row range the grid last asked for (`ensureTableRange`) — where the user
 * is looking. `handleTableModelRevChanged` refreshes THIS range after an
 * external commit, not row 0. Control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _viewRanges = new Map<string, { start: number; end: number }>();

/**
 * Tabs whose definition edits are being STAGED rather than evaluated — the
 * table settings dialog is open over them.
 *
 * Every applied definition edit re-evaluates the whole table against a fresh
 * backend cache key, and for a script or navigation column that means paying
 * a full sweep. While the user is inside the settings dialog they are
 * *composing*: typing a snippet, trying a navigation chain, undoing it. Each
 * of those intermediate states used to kick off a full re-evaluation of a
 * table nobody could even see (the dialog is modal), so the grid behind it
 * churned and the final, real edit queued behind the throwaway ones.
 *
 * So: `suspendTableEvaluation` records the definition as it stood when the
 * dialog opened; `updateTableDefinition` keeps updating the draft (the
 * editors, the dirty flag and Save all stay live and immediate — only the
 * *evaluation* is deferred) but skips the reload; `resumeTableEvaluation`
 * reloads exactly once, and only if the definition actually ended up
 * different from the snapshot.
 *
 * The value is a JSON fingerprint of the definition at suspend time. Object
 * key order can in principle differ between two structurally equal
 * definitions, which would cost one needless reload — the failure mode is a
 * false POSITIVE, never a false negative, so a real edit can never be
 * swallowed.
 *
 * Control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _suspended = new Map<string, string>();

/**
 * Suspended tabs that a peer's commit arrived for (`handleTableModelRevChanged`
 * skips suspended tabs — it would otherwise re-evaluate the half-composed
 * definition). Forces the reload on resume even when the definition came back
 * unchanged, so the user does not sit on data that is known to be stale.
 * Control state, never read from templates.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _suspendedStale = new Set<string>();

function definitionFingerprint(tabId: string): string {
	return JSON.stringify(_drafts.get(tabId)?.definition ?? null);
}

/**
 * Stage definition edits for `tabId` instead of evaluating them (see
 * `_suspended`). Idempotent — a second call while already suspended keeps the
 * ORIGINAL snapshot, so "opened the dialog, edited, opened a nested editor"
 * still compares against where the user started.
 *
 * Callers must suspend BEFORE the first edit: the header's "+ column" menu
 * appends the new column and *then* opens the dialog, and that append is
 * exactly one of the throwaway evaluations this exists to avoid.
 */
export function suspendTableEvaluation(tabId: string): void {
	if (_suspended.has(tabId)) return;
	_suspended.set(tabId, definitionFingerprint(tabId));
}

/**
 * Resume evaluation and, if anything actually changed while suspended,
 * re-evaluate the table once from row 0. A no-op if the tab was not suspended.
 *
 * When the definition came back identical (composed and undone, or the dialog
 * was opened and dismissed), the loaded page is still valid — but chunk fills
 * were declined while suspended, so the visible range is re-driven to fill any
 * placeholder rows that were skipped rather than left pulsing until the next
 * scroll.
 */
export function resumeTableEvaluation(tabId: string): void {
	const before = _suspended.get(tabId);
	if (before === undefined) return;
	_suspended.delete(tabId);
	const stale = _suspendedStale.delete(tabId);
	if (!_drafts.has(tabId)) return; // tab closed while the dialog was open
	if (stale || definitionFingerprint(tabId) !== before) {
		const { offset, limit } = visibleRequest(tabId);
		void loadTablePage(tabId, offset, limit);
		return;
	}
	const view = _viewRanges.get(tabId);
	if (view) ensureTableRange(tabId, view.start, view.end);
}

/**
 * Drop a suspension WITHOUT evaluating — for teardown (the tab unmounted with
 * the dialog still open). Distinct from `resumeTableEvaluation` precisely
 * because firing a request for a view that is gone is the thing to avoid.
 */
export function abandonTableEvaluationSuspension(tabId: string): void {
	_suspended.delete(tabId);
	_suspendedStale.delete(tabId);
}

function bumpGeneration(tabId: string): number {
	const next = (_generations.get(tabId) ?? 0) + 1;
	_generations.set(tabId, next);
	// Chunk fetches issued under older generations will be dropped on landing;
	// clear their bookkeeping so the new generation can re-request those chunks.
	_inflightChunks.delete(tabId);
	_chunkRetries.delete(tabId);
	return next;
}

/** True while `gen` is still current for `tabId` and its draft exists. */
function isCurrent(tabId: string, gen: number): boolean {
	return _generations.get(tabId) === gen && _drafts.has(tabId);
}

/** Cancel the tab's pending script-sweep poll, if any. */
function cancelPoll(tabId: string): void {
	const timer = _pollTimers.get(tabId);
	if (timer !== undefined) {
		clearTimeout(timer);
		_pollTimers.delete(tabId);
	}
}

/**
 * Forget everything the script-sweep poll loop holds for a tab: the reported
 * status, the attempt budget, and any scheduled timer. The teardown paths
 * (`closeTableDraft`, `reloadTableDraft`) all want exactly this trio, and
 * dropping only two of the three leaks a timer or a stale budget.
 *
 * NOT used by `rekeyTableDraft`, which deliberately CARRIES the status and the
 * attempt budget over to the new tab id (only the timer is cancelled), nor by
 * `resetTableEditors`, which clears the maps wholesale.
 */
function clearScriptStatus(tabId: string): void {
	_scriptStatus.delete(tabId);
	_pollAttempts.delete(tabId);
	cancelPoll(tabId);
	clearScriptErrors(tabId);
}

/** Cancel the tab's pending recap retry, if any. */
function cancelRecapRetry(tabId: string): void {
	const timer = _recapTimers.get(tabId);
	if (timer !== undefined) {
		clearTimeout(timer);
		_recapTimers.delete(tabId);
	}
}

/**
 * Forget everything the script-error recap holds for a tab: the recap itself,
 * the page-state signature that says which page state it describes, the retry
 * budget and timer, and any un-consumed jump request (which addresses rows of
 * a grid that is going away).
 */
function clearScriptErrors(tabId: string): void {
	_scriptErrors.delete(tabId);
	_recapKeys.delete(tabId);
	_recapAttempts.delete(tabId);
	_scrollRequests.delete(tabId);
	cancelRecapRetry(tabId);
}

/**
 * Fetch the whole-table script-error recap for `tabId`. Called only from
 * `handleScriptErrorRecap` once a landed page's status has SETTLED — never
 * speculatively, because the route re-pays a whole-table pass on every call.
 *
 * Guarded TWICE, and both guards earn their keep: the generation (as every
 * async loader here is) and the page-state signature `key`. A chunk fill can
 * install a page of a NEWER model rev without bumping the generation (see
 * `mergePage`), so two fetches for two different page states could otherwise
 * be in flight under one generation and land in the wrong order.
 *
 * A 202 (`{ retry: true }`) means the background sweep is still filling the
 * cache: schedule ONE delayed retry (never two — the previous timer is always
 * cancelled first), bounded by `RECAP_MAX_ATTEMPTS`. Anything else — a
 * network error, a 4xx, a superseded generation — leaves the tab with no
 * recap and therefore no badge: this surface is an aid for finding failures,
 * and it must never be the thing that breaks a table view.
 */
async function _fetchScriptErrors(tabId: string, gen: number, key: string): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const sort = _sortFor(tabId, draft);
	const args = { ..._evaluateSource(draft), sort };
	try {
		const result = await fetchScriptErrors(args);
		// stale: edited/reloaded/closed, or a newer page state, mid-flight
		if (!isCurrent(tabId, gen) || _recapKeys.get(tabId) !== key) return;
		if ('retry' in result) {
			scheduleRecapRetry(tabId, gen, key);
			return;
		}
		_recapAttempts.delete(tabId);
		_scriptErrors.set(tabId, result);
	} catch {
		if (!isCurrent(tabId, gen) || _recapKeys.get(tabId) !== key) return;
		// Drop the signature so a later landing page (or the next rev) retries;
		// leaving it set would wedge this tab's badge for the life of the page.
		_recapKeys.delete(tabId);
		_recapAttempts.delete(tabId);
		_scriptErrors.delete(tabId);
	}
}

/** Schedule the ONE pending recap retry for `tabId`, or give up once the
 * attempt budget is spent (silently — see `RECAP_MAX_ATTEMPTS`). */
function scheduleRecapRetry(tabId: string, gen: number, key: string): void {
	cancelRecapRetry(tabId);
	const attempts = (_recapAttempts.get(tabId) ?? 0) + 1;
	if (attempts > RECAP_MAX_ATTEMPTS) {
		_recapAttempts.delete(tabId);
		return;
	}
	_recapAttempts.set(tabId, attempts);
	_recapTimers.set(
		tabId,
		setTimeout(() => {
			_recapTimers.delete(tabId);
			// edited/reloaded/closed, or superseded by a newer page state
			if (!isCurrent(tabId, gen) || _recapKeys.get(tabId) !== key) return;
			void _fetchScriptErrors(tabId, gen, key);
		}, RECAP_RETRY_MS)
	);
}

/**
 * The chunk-aligned request covering the range the grid last reported as
 * visible (falling back to the first chunk), capped at the backend's limit
 * bound. Shared by the commit refresh and the script-sweep poll: both must
 * re-request where the user is LOOKING, not row 0.
 */
function visibleRequest(tabId: string): { offset: number; limit: number } {
	const view = _viewRanges.get(tabId);
	const offset = view ? Math.floor(view.start / PAGE) * PAGE : 0;
	const limit = view
		? Math.min(MAX_LIMIT, Math.max(PAGE, Math.ceil((view.end - offset) / PAGE) * PAGE))
		: PAGE;
	return { offset, limit };
}

/**
 * Record a landed page's `script_status` and drive the polling loop.
 *
 * `computing` means the backend served this page from a script-value cache the
 * background sweep is still filling — some cells came back `pending` and, while
 * that is true, rows are returned in BUILD order (sorting half-computed values
 * would reshuffle the grid on every poll). A response that saw pending values
 * never reports `ready`, so the loop always gets one clean final page: poll
 * until the status turns terminal (`ready`/`failed`), then stop.
 *
 * Called from every page landing (install AND merge). Exactly one timer per
 * tab — the previous one is always cancelled first.
 *
 * The loop is BOUNDED (`POLL_MAX_ATTEMPTS`), the same defence in depth
 * `downloadTable` applies to its export retries: the backend is supposed to
 * turn terminal on its own (a sweep that finished but left holes reports
 * `failed`), but a client must never answer "still computing" with an
 * unbounded once-a-second request loop — each poll re-pays a whole-table pass
 * server-side. On give-up the tab's status is replaced with a `failed` one
 * carrying a user-facing message, which the grid already renders in its
 * destructive status strip; a user-initiated reload starts a fresh budget
 * (only poll-driven loads count, see `_loadTablePage`).
 */
function handleScriptStatus(tabId: string, page: TablePage): void {
	const status = page.script_status ?? null;
	if (status) _scriptStatus.set(tabId, status);
	else _scriptStatus.delete(tabId);
	handleScriptErrorRecap(tabId, page, status);
	cancelPoll(tabId);
	if (status?.state !== 'computing') {
		_pollAttempts.delete(tabId);
		return;
	}
	const attempts = (_pollAttempts.get(tabId) ?? 0) + 1;
	if (attempts > POLL_MAX_ATTEMPTS) {
		_pollAttempts.delete(tabId);
		_scriptStatus.set(tabId, {
			state: 'failed',
			done: status.done,
			total: status.total,
			message:
				'Script values are still being computed after ' +
				`${Math.round((POLL_MAX_ATTEMPTS * POLL_MS) / 1000)}s — giving up. ` +
				'Reload the table to try again.'
		});
		return;
	}
	_pollAttempts.set(tabId, attempts);
	const gen = _generations.get(tabId) ?? 0;
	_pollTimers.set(
		tabId,
		setTimeout(() => {
			_pollTimers.delete(tabId);
			if (!isCurrent(tabId, gen)) return; // edited/reloaded/closed since scheduled
			const { offset, limit } = visibleRequest(tabId);
			void _loadTablePage(tabId, offset, limit, true);
		}, POLL_MS)
	);
}

/**
 * Keep the tab's script-error recap in step with the page state that just
 * landed. Called from `handleScriptStatus` (i.e. from every landing page).
 *
 * A recap describes a SETTLED table: its `row_index`es address the very order
 * the page route renders for this `(definition, sort, model_rev)`. So it is
 * fetched exactly when the status is terminal (`ready` — including a first
 * page that arrives already settled — or `failed`, whose remaining holes ARE
 * the errors), and dropped whenever that stops being true: no script status at
 * all (no script column), or a table that went back to `computing`, where the
 * grid shows degraded BUILD order and a stale recap would jump to the wrong
 * row.
 *
 * `_recapKeys` makes it fetch-ONCE per page state: this function runs on every
 * chunk fill too, and each recap is a whole-table pass server-side. The
 * signature is `"<status>:<model rev>:<generation>"`, and all three matter:
 *
 *   * the **generation** covers every re-evaluation the user can cause — a
 *     definition edit, a sort change, a reload — none of which need change the
 *     rev, yet all of which move `row_index`/`column_index`;
 *   * the **model rev** covers a chunk fill that installs a newer page WITHOUT
 *     bumping the generation (`mergePage`'s rev-mismatch branch);
 *   * the **status** covers a sweep that settles from `ready` to `failed`.
 *
 * A background chunk fill of the SAME page state changes none of them, which
 * is the point: scrolling a settled table costs no recap requests at all.
 */
function handleScriptErrorRecap(tabId: string, page: TablePage, status: ScriptStatus | null): void {
	if (status === null || status.state === 'computing') {
		clearScriptErrors(tabId);
		return;
	}
	const gen = _generations.get(tabId) ?? 0;
	const key = `${status.state}:${page.model_rev}:${gen}`;
	if (_recapKeys.get(tabId) === key) return; // already fetched (or fetching) this state
	clearScriptErrors(tabId);
	_recapKeys.set(tabId, key);
	void _fetchScriptErrors(tabId, gen, key);
}

/**
 * Move every per-tab entry (page, sort, loading, error, generation, view
 * range) from `oldTab` to `newTab`. Used by the first-save/fork paths, where a
 * `tbl:draft:*` tab is rebound to `tbl:<id>`. The draft itself is moved
 * separately by the caller (it also gets new artifact fields, not a plain
 * carry-over), and MUST already be `_drafts.set(newTab, …)` in place before
 * this runs.
 *
 * A load in flight when the save lands is closed over `oldTab`: once `oldTab`'s
 * draft is deleted its `isCurrent(oldTab, gen)` check fails, so its response is
 * orphaned and never clears `_loading`. Moving a `loading: true` marker to
 * `newTab` without a fresh request would therefore strand the new tab on
 * "loading forever". So: after moving, if the marker is still `true`, re-issue
 * the load under `newTab` (which supersedes the orphaned generation and lands a
 * real page). Mirrors navigation-editor.svelte.ts's `rekeyTab` safeguard
 * ("moved previews still marked loading are re-issued immediately").
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

	const view = _viewRanges.get(oldTab);
	_viewRanges.delete(oldTab);
	if (view !== undefined) _viewRanges.set(newTab, view);

	// An active staged-edit suspension must follow the tab, or it would sit
	// under `oldTab` forever (nothing else ever clears that key) while the new
	// tab evaluated on every keystroke.
	const suspendedAt = _suspended.get(oldTab);
	_suspended.delete(oldTab);
	if (suspendedAt !== undefined) _suspended.set(newTab, suspendedAt);
	if (_suspendedStale.delete(oldTab)) _suspendedStale.add(newTab);

	// The pending poll is closed over `oldTab` (whose draft is gone), so it
	// would no-op — cancel it and carry the status over; the re-issued load
	// below, or the next landing page, schedules a fresh poll under `newTab`.
	cancelPoll(oldTab);
	const status = _scriptStatus.get(oldTab);
	_scriptStatus.delete(oldTab);
	if (status !== undefined) _scriptStatus.set(newTab, status);
	// The attempt budget follows the status: a rebind is not a fresh start for
	// a sweep that has already been polled 100 times under the old tab id.
	const attempts = _pollAttempts.get(oldTab);
	_pollAttempts.delete(oldTab);
	if (attempts !== undefined) _pollAttempts.set(newTab, attempts);

	// The script-error recap belongs to the TABLE, not the tab id, so carry it
	// over rather than paying for a second whole-table pass after a save. Its
	// page-state signature only follows a recap we actually HAVE: a fetch still
	// in flight is closed over `oldTab` (whose draft is gone) and will be
	// dropped, and carrying its signature would leave the new tab believing it
	// had already fetched. Dropping the signature instead makes the next
	// landing page re-fetch. The pending retry timer is closed over the old id
	// too — cancel it; the rescheduled loads below re-settle the new one.
	const recap = _scriptErrors.get(oldTab);
	const recapKey = _recapKeys.get(oldTab);
	clearScriptErrors(oldTab);
	if (recap !== undefined) {
		_scriptErrors.set(newTab, recap);
		if (recapKey !== undefined) _recapKeys.set(newTab, recapKey);
	}

	// Chunk fetches in flight are closed over `oldTab`, whose draft is gone —
	// they will be dropped on landing. Drop their bookkeeping with them; the
	// grid re-requests any still-missing chunks under the new tab id.
	_inflightChunks.delete(oldTab);

	// The orphaned in-flight load will never settle under `newTab`; re-issue it
	// so the new tab does not hang on `loading: true`. Reads the draft under the
	// NEW id (the caller has already set it), same as nav's rekeyTab re-run.
	// Both re-issues below count as POLL continuations (`fromPoll: true`), not
	// user-initiated loads: a rebind mid-sweep must not hand the poll loop a
	// fresh attempt budget.
	if (loading === true) {
		void _loadTablePage(newTab, _pages.get(newTab)?.offset ?? 0, PAGE, true);
	} else if (status?.state === 'computing') {
		// Nothing was in flight to re-issue, but the sweep is still running and
		// the cancelled timer belonged to the old id — restart the loop, or the
		// tab would sit on `pending` cells forever.
		const { offset, limit } = visibleRequest(newTab);
		void _loadTablePage(newTab, offset, limit, true);
	}
}

export function getTableDraft(tabId: string): TableDraft | undefined {
	return _drafts.get(tabId);
}
export function getTablePage(tabId: string): TableData | undefined {
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
/**
 * Progress of the background script-value sweep behind this table's script
 * column(s), as of the last landed page. `null` for tables with no script
 * column (or before the first page lands). `computing` means the store has a
 * poll scheduled and some cells render as `pending`.
 */
export function getTableScriptStatus(tabId: string): ScriptStatus | null {
	return _scriptStatus.get(tabId) ?? null;
}

/**
 * Every failing script cell in the WHOLE table, as of the last settled page —
 * the input to the error badge and panel. `null` while the table has no script
 * column, has not settled yet, or the recap could not be fetched (degraded,
 * never failed: no recap simply means no badge).
 */
export function getScriptErrors(tabId: string): ScriptErrorsRecap | null {
	return _scriptErrors.get(tabId) ?? null;
}

/**
 * Ask the grid to scroll to (and briefly highlight) one cell. Set by the error
 * panel; the grid picks it up in an effect via {@link consumeScrollRequest}.
 * The indirection exists because the panel lives in the tab's fixed chrome
 * while the scroll container is inside `TableGrid` — and because the grid is
 * virtualized, so "scroll to row N" is the grid's own math, not the panel's.
 * One pending request per tab: a second click supersedes the first.
 */
export function requestScrollToCell(tabId: string, rowIndex: number, columnIndex: number): void {
	_scrollRequests.set(tabId, { rowIndex, columnIndex });
}

/**
 * Take the tab's pending scroll request, CLEARING it. Single-consumer by
 * design: the grid's effect re-runs on unrelated cache changes, and a request
 * that survived consumption would re-scroll the user away from wherever they
 * had since scrolled to.
 */
export function consumeScrollRequest(
	tabId: string
): { rowIndex: number; columnIndex: number } | null {
	const request = _scrollRequests.get(tabId);
	if (request === undefined) return null;
	_scrollRequests.delete(tabId);
	return request;
}

/** Non-fatal warnings from the last installed page (e.g. a ScriptColumn that
 * raised on some rows) — empty when no page is installed or none were sent. */
export function getTableWarnings(tabId: string): string[] {
	return _pages.get(tabId)?.warnings ?? [];
}

/** True when ANY open table draft holds unsaved definition/name edits —
 * closing or reloading the page would lose them (the unload guard's input). */
export function hasDirtyTableDrafts(): boolean {
	for (const draft of _drafts.values()) {
		if (draft.dirty) return true;
	}
	return false;
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
		// Deliberately NO first load: the default definition is an untyped scope,
		// which evaluates to EVERY element — a brand-new table must open EMPTY
		// instead (the grid shows a "choose a scope in Settings" hint). The first
		// definition edit (updateTableDefinition) triggers the first evaluation;
		// an explicit all-elements table stays reachable via the scope picker's
		// "Select all"/"Deselect all".
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
 * What evaluate/export requests should evaluate: the artifact id ONLY while
 * the draft is pristine (letting the backend reuse its per-artifact order
 * cache), the INLINE definition otherwise. A dirty saved table MUST send its
 * edited definition — evaluating by artifactId re-reads the SAVED payload, so
 * every unsaved settings edit (scope change, new column, restored config)
 * would be silently ignored and the grid would appear frozen until Save.
 */
function _evaluateSource(
	draft: TableDraft
): { definition: TableDefinition } | { artifactId: string } {
	return draft.artifactId === null || draft.dirty
		? { definition: draft.definition }
		: { artifactId: draft.artifactId };
}

/**
 * The sort to send with a request, validated against the CURRENT definition.
 * `_sorts` outlives definition edits, so a sort can point past the last column
 * after an external definition swap (reload, rebind) — the backend hard-422s
 * an out-of-range sort on EVERY request, which would brick the whole tab. The
 * structural edits that shift indices (remove/move) remap the sort precisely
 * (see `remapTableSortForRemove`/`ForMove`); this is the belt-and-braces net
 * for any path that doesn't.
 */
function _sortFor(tabId: string, draft: TableDraft): TableSort | undefined {
	const sort = _sorts.get(tabId);
	if (sort === undefined) return undefined;
	if (sort.column >= draft.definition.columns.length) {
		_sorts.delete(tabId);
		return undefined;
	}
	return sort;
}

/**
 * Keep the active sort pointing at the SAME column across a column removal
 * (mirrors `removeColumn`'s ColumnRef shifting): sort on the removed column is
 * cleared; a sort past it shifts down one. Call before the definition edit is
 * applied so the reload it triggers already uses the remapped sort.
 */
export function remapTableSortForRemove(tabId: string, index: number): void {
	const sort = _sorts.get(tabId);
	if (sort === undefined) return;
	if (sort.column === index) _sorts.delete(tabId);
	else if (sort.column > index) _sorts.set(tabId, { ...sort, column: sort.column - 1 });
}

/** Same contract as `remapTableSortForRemove`, for `moveColumn(from, to)`. */
export function remapTableSortForMove(tabId: string, from: number, to: number): void {
	const sort = _sorts.get(tabId);
	if (sort === undefined) return;
	let column = sort.column;
	if (column === from) column = to;
	else if (from < column && column <= to) column -= 1;
	else if (to <= column && column < from) column += 1;
	if (column !== sort.column) _sorts.set(tabId, { ...sort, column });
}

/** Install `page` as a FRESH sparse cache (drops any previously loaded rows). */
function installPage(tabId: string, page: TablePage): void {
	const rows: (TableRow | undefined)[] = new Array<TableRow | undefined>(page.total);
	for (let i = 0; i < page.rows.length && page.offset + i < page.total; i++) {
		rows[page.offset + i] = page.rows[i];
	}
	_pages.set(tabId, {
		columns: page.columns,
		rows,
		total: page.total,
		base_total: page.base_total,
		truncated: page.truncated,
		offset: page.offset,
		model_rev: page.model_rev,
		warnings: page.warnings
	});
	handleScriptStatus(tabId, page);
}

/**
 * Splice `page`'s rows into the existing sparse cache. A response from a
 * different model rev (or a changed row count — same rev but a different
 * definition landed a reset in between) cannot be spliced into the current
 * cache; install it fresh instead and let the grid re-request whatever else
 * its window needs.
 */
function mergePage(tabId: string, page: TablePage): void {
	const data = _pages.get(tabId);
	if (!data || data.model_rev !== page.model_rev || data.total !== page.total) {
		installPage(tabId, page);
		return;
	}
	const rows = data.rows.slice();
	for (let i = 0; i < page.rows.length && page.offset + i < data.total; i++) {
		rows[page.offset + i] = page.rows[i];
	}
	_pages.set(tabId, { ...data, rows });
	// (the install branch above already handled the status for its own page)
	handleScriptStatus(tabId, page);
}

/**
 * (Re)fetch the table's page at `offset` and RESET the row cache from it,
 * guarded by the per-tab generation counter. A fresh call always clears any
 * stale error first — the error slot must match what's on screen, same rule
 * as nav-editor's eval-error flag. `limit` defaults to one chunk; the
 * commit-refresh path passes more to re-cover the user's visible range in one
 * request.
 */
export async function loadTablePage(
	tabId: string,
	offset: number,
	limit: number = PAGE
): Promise<void> {
	// A load nobody's poll timer asked for is a fresh start: give the sweep
	// poll loop a new attempt budget (see `_pollAttempts`).
	return _loadTablePage(tabId, offset, limit, false);
}

/** `loadTablePage` plus the poll-loop bookkeeping the exported wrapper hides:
 * `fromPoll` distinguishes a tick of the script-sweep poll loop (which spends
 * the tab's attempt budget) from any other caller (which resets it). */
async function _loadTablePage(
	tabId: string,
	offset: number,
	limit: number,
	fromPoll: boolean
): Promise<void> {
	if (!fromPoll) _pollAttempts.delete(tabId);
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const gen = bumpGeneration(tabId); // supersede any older in-flight load
	_errors.delete(tabId);
	_loading.set(tabId, true);
	const sort = _sortFor(tabId, draft);
	const args = { ..._evaluateSource(draft), offset, limit, sort };
	try {
		const page = await evaluateTable(args);
		if (!isCurrent(tabId, gen)) return; // stale: edited/reloaded/closed mid-flight
		installPage(tabId, page);
		_loading.set(tabId, false);
	} catch (err) {
		if (isCurrent(tabId, gen)) {
			_errors.set(tabId, err instanceof Error ? err.message : String(err));
			_loading.set(tabId, false);
		}
	}
}

/**
 * Lazily fill the row cache around `[start, end)` — the window (plus prefetch
 * margin) the grid currently shows. Missing PAGE-aligned chunks that aren't
 * already in flight are fetched concurrently and spliced in as they land, so
 * the user scrolls over placeholders that resolve, never a blank reload.
 * Cheap when everything is already loaded (one pass over the range), so the
 * grid may call it on every window change.
 */
export function ensureTableRange(tabId: string, start: number, end: number): void {
	const draft = _drafts.get(tabId);
	const data = _pages.get(tabId);
	if (!draft || !data) return;
	const lo = Math.max(0, start);
	const hi = Math.min(end, data.total);
	_viewRanges.set(tabId, { start: lo, end: Math.max(lo, hi) });
	if (lo >= hi) return;
	// Staged-edit window: the draft's definition has moved on from the one
	// `data` was built with, so a chunk fetched now would splice rows of a
	// DIFFERENT shape into the loaded page. The range is recorded above and
	// re-driven by `resumeTableEvaluation`, so nothing is lost by declining.
	if (_suspended.has(tabId)) return;
	const gen = _generations.get(tabId) ?? 0;
	let chunks = _inflightChunks.get(tabId);
	for (let c = Math.floor(lo / PAGE) * PAGE; c < hi; c += PAGE) {
		if (chunks?.has(c)) continue;
		let missing = false;
		const chunkEnd = Math.min(c + PAGE, data.total);
		for (let i = c; i < chunkEnd; i++) {
			if (data.rows[i] === undefined) {
				missing = true;
				break;
			}
		}
		if (!missing) continue;
		if (!chunks) {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- control state, never read from templates
			chunks = new Map();
			_inflightChunks.set(tabId, chunks);
		}
		chunks.set(c, gen);
		void fetchChunk(tabId, c, gen);
	}
}

async function fetchChunk(tabId: string, offset: number, gen: number): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const sort = _sortFor(tabId, draft);
	const args = { ..._evaluateSource(draft), offset, limit: PAGE, sort };
	try {
		const page = await evaluateTable(args);
		if (!isCurrent(tabId, gen)) return; // superseded by a reset/close mid-flight
		_chunkRetries.get(tabId)?.delete(offset);
		mergePage(tabId, page);
	} catch {
		// A background chunk fill failing is non-fatal: its slots stay
		// placeholders. Errors that matter (bad definition/sort) also fail the
		// offset-0 reset load, which owns the visible error slot. Transient
		// failures get a bounded delayed retry — without one, a lone failed
		// chunk would pulse forever unless the user happened to scroll again.
		if (isCurrent(tabId, gen)) {
			let retries = _chunkRetries.get(tabId);
			if (!retries) {
				// eslint-disable-next-line svelte/prefer-svelte-reactivity -- control state, never read from templates
				retries = new Map();
				_chunkRetries.set(tabId, retries);
			}
			const attempt = (retries.get(offset) ?? 0) + 1;
			retries.set(offset, attempt);
			if (attempt <= CHUNK_RETRY_MAX) {
				setTimeout(() => {
					if (isCurrent(tabId, gen)) ensureTableRange(tabId, offset, offset + PAGE);
				}, CHUNK_RETRY_DELAY_MS * attempt);
			}
		}
	} finally {
		const chunks = _inflightChunks.get(tabId);
		if (chunks?.get(offset) === gen) chunks.delete(offset);
	}
}

export function updateTableDefinition(tabId: string, defn: TableDefinition): void {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	_drafts.set(tabId, { ...draft, definition: defn, dirty: true });
	// The draft update above is always immediate — only the (expensive)
	// re-evaluation is staged while the settings dialog is open. See
	// `_suspended`; `resumeTableEvaluation` performs the single reload.
	if (_suspended.has(tabId)) return;
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
	_viewRanges.delete(tabId);
	abandonTableEvaluationSuspension(tabId);
	clearScriptStatus(tabId);
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
	_viewRanges.delete(tabId);
	abandonTableEvaluationSuspension(tabId);
	clearScriptStatus(tabId);
	bumpGeneration(tabId); // orphan any in-flight load
}

/** Progress of an export that is waiting on the background script sweep. */
export interface ExportProgress {
	done: number;
	total: number | null;
	/** 1-based retry number, so a caller can show "still preparing". */
	attempt: number;
}

/**
 * Export the current definition (or saved artifact) as an .xlsx and trigger a
 * browser download via a synthetic anchor click.
 *
 * While the backend's script-cache sweep is still filling in a script column's
 * cells, `/tables/export` answers **202 + Retry-After: 1** (surfaced by the API
 * client as `{ kind: 'preparing' }`) instead of the file. THE STATUS CODE IS
 * THE RETRY SIGNAL: retry until the call resolves `ready`, reporting each wait
 * through `onProgress` so the caller can keep the user informed, and stop early
 * when `signal` aborts (the tab was closed / the user navigated away). Retries
 * are bounded (`EXPORT_MAX_ATTEMPTS`) so a wedged sweep ends in a visible error
 * rather than an invisible infinite loop.
 */
export async function downloadTable(
	tabId: string,
	opts?: { onProgress?: (p: ExportProgress) => void; signal?: AbortSignal }
): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const sort = _sortFor(tabId, draft);
	const args = { ..._evaluateSource(draft), sort };
	let result = await exportTable(args);
	for (let attempt = 1; result.kind === 'preparing'; attempt++) {
		if (opts?.signal?.aborted) return;
		if (attempt > EXPORT_MAX_ATTEMPTS) {
			throw new Error('Export is still being prepared — try again shortly.');
		}
		opts?.onProgress?.({ done: result.done, total: result.total, attempt });
		await new Promise((r) => setTimeout(r, EXPORT_RETRY_MS));
		if (opts?.signal?.aborted) return;
		result = await exportTable(args);
	}
	const url = URL.createObjectURL(result.blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = result.filename;
	a.click();
	URL.revokeObjectURL(url);
}

/**
 * Feed reducer hook: fired after every commit/rebind feed event (a cell edit
 * committed anywhere may have changed data any open table reads). Re-runs
 * every OPEN table tab's load over the range the user is LOOKING at (the last
 * `ensureTableRange` window, chunk-aligned, capped at the backend's limit
 * bound), fire-and-forget — `loadTablePage`'s own per-tab generation guard
 * drops stale responses, so there is no need to await or serialize these.
 * Drafts are refetched too: their `row_source`/columns may read model data
 * that just changed even though the draft's definition itself is unsaved.
 */
export function handleTableModelRevChanged(): void {
	for (const [tabId] of _drafts) {
		// A tab that has never evaluated (no page, no error, no load in flight) is
		// a brand-new table still waiting for its scope — a peer's commit must not
		// surprise-fill it with every element.
		if (!_pages.has(tabId) && !_errors.has(tabId) && !(_loading.get(tabId) ?? false)) continue;
		// Mid-composition (settings dialog open): re-evaluating here would run
		// the half-edited definition. Remember that this tab owes a refresh and
		// let `resumeTableEvaluation` do it on close.
		if (_suspended.has(tabId)) {
			_suspendedStale.add(tabId);
			continue;
		}
		const { offset, limit } = visibleRequest(tabId);
		void loadTablePage(tabId, offset, limit);
	}
}

// Register once at module load: the realtime store taps every commit/rebind
// feed event and fans it out to registered listeners. This is a one-way
// import (realtime.svelte.ts does not import table-editor), so no cycle.
onCommitEvent(() => handleTableModelRevChanged());

export function resetTableEditors(): void {
	_drafts.clear();
	_pages.clear();
	_sorts.clear();
	_loading.clear();
	_errors.clear();
	_conflicts.clear();
	_viewRanges.clear();
	_suspended.clear();
	_suspendedStale.clear();
	_scriptStatus.clear();
	_pollAttempts.clear();
	for (const tabId of [..._pollTimers.keys()]) cancelPoll(tabId);
	_scriptErrors.clear();
	_recapKeys.clear();
	_recapAttempts.clear();
	_scrollRequests.clear();
	for (const tabId of [..._recapTimers.keys()]) cancelRecapRetry(tabId);
	// Bump (not clear) so in-flight responses from before the reset stay stale
	// even if the same tab id is immediately re-created. (bumpGeneration also
	// drops the tab's in-flight chunk bookkeeping.)
	for (const key of _generations.keys()) bumpGeneration(key);
}
