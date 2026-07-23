// The script-error RECAP (Task 6, on-demand since the final review). A table's
// failing script cells can sit anywhere in a virtualized grid the client only
// ever holds a window of, so the backend's whole-table
// `POST /tables/script-errors` is the only complete answer.
//
// That answer is EXPENSIVE, and expensive in a way the plan did not anticipate:
// the route renders the whole table CACHE-ONLY, so for the commonest shape (an
// unsorted collapse script column) — where the page route makes zero `value()`
// calls and reports `ready` without ever kicking a sweep — the recap misses on
// every row outside the window and kicks a full background sweep. Fetching it
// automatically would have turned "open a table with a script column" into
// "sweep the whole table", plus up to 120 once-a-second retries. So the recap
// is fetched only when the user asks for it. This suite pins the client half:
//
//   * WHEN the recap is fetched — never on settle, only on `requestScriptErrors`
//     (each call re-pays a whole-table pass server-side), and once per page
//     state no matter how many times it is asked for;
//   * the 202 retry discipline — one timer per tab, delayed, non-compounding;
//   * INVALIDATION: a new model rev, a re-evaluation at the same rev (sort /
//     definition edit), a status that stops being terminal, a page with no
//     script status at all, and tab teardown all DROP the recap without
//     fetching anything — a `row_index` is a grid address, so a recap that
//     outlived its row order must never be shown against the new one;
//   * the jump request round-trip (`requestScrollToCell`/`consumeScrollRequest`).
//
// Same harness as `table-editor-script-status.test.ts`: fake timers advanced
// with `advanceTimersByTimeAsync` (so the scheduled work's own await chain
// settles inside the advance) and `vi.spyOn` on the API module, whose call
// count is the assertion for "did a request actually go out".
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as tablesApi from '$lib/api/tables';
import type { ScriptErrorsRecap, TablePage } from '$lib/api/types';
import {
	closeTableDraft,
	consumeScrollRequest,
	ensureTableDraft,
	ensureTableRange,
	getScriptErrors,
	getScriptErrorsPhase,
	loadTablePage,
	requestScriptErrors,
	requestScrollToCell,
	resetTableEditors,
	setTableSort
} from '../table-editor.svelte';
import { resetWorkspaceTabs } from '../workspace.svelte';
import { resetArtifacts } from '../artifacts.svelte';

const TAB = 'tbl:draft:1';

const RECAP: ScriptErrorsRecap = {
	state: 'ready',
	errors: [
		{
			row_index: 3,
			row_element_id: 't4',
			row_label: 't4',
			column_index: 1,
			column_label: 'script',
			message: 'ZeroDivisionError: division by zero'
		}
	],
	total_errors: 1,
	truncated: false
};

/** A page of 10 rows at `offset`, out of a `total`-row table (so the store's
 * sparse cache has holes a chunk fill can be driven into). */
function pageWith(
	script_status: TablePage['script_status'],
	model_rev = 1,
	offset = 0,
	total = 10
): TablePage {
	return {
		columns: [{ kind: 'element', header: '', width_px: null }],
		rows: Array.from({ length: 10 }, (_, i) => ({ key: [`e${offset + i}`], cells: [] })),
		total,
		truncated: false,
		offset,
		model_rev,
		warnings: [],
		script_status
	};
}

let evalSpy: MockInstance<typeof tablesApi.evaluateTable>;

beforeEach(() => {
	vi.useFakeTimers();
	resetTableEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	evalSpy = vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(pageWith(null));
});
afterEach(() => {
	resetTableEditors();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Land one page for TAB and let any follow-up promise chain settle. */
async function land(page: TablePage): Promise<void> {
	evalSpy.mockResolvedValue(page);
	await loadTablePage(TAB, page.offset);
	await vi.advanceTimersByTimeAsync(0);
}

/** Ask for the recap and let its promise chain settle. */
async function ask(): Promise<void> {
	requestScriptErrors(TAB);
	await vi.advanceTimersByTimeAsync(0);
}

describe('script-error recap fetch-on-demand', () => {
	it('does NOT fetch a recap when a page settles — only when asked', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);

		await land(pageWith({ state: 'ready', done: 10, total: 10 }));

		// The whole point of the on-demand switch: settling is free.
		expect(recapSpy).toHaveBeenCalledTimes(0);
		expect(getScriptErrors(TAB)).toBeNull();
		expect(getScriptErrorsPhase(TAB)).toBe('idle');

		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrors(TAB)).toEqual(RECAP);
		expect(getScriptErrorsPhase(TAB)).toBe('done');
	});

	it('fetches once per page state, however often it is asked for', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 300, total: 300 }, 1, 0, 300));

		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);
		await ask();
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// Background CHUNK FILLS as the user scrolls (`mergePage`, no generation
		// bump) land the same page state over and over. They must neither
		// re-fetch nor invalidate the recap the user already paid for.
		const evalCalls = evalSpy.mock.calls.length;
		ensureTableRange(TAB, 100, 200);
		await vi.advanceTimersByTimeAsync(0);
		ensureTableRange(TAB, 200, 300);
		await vi.advanceTimersByTimeAsync(0);
		expect(evalSpy.mock.calls.length).toBeGreaterThan(evalCalls); // fills really went out
		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrors(TAB)).toEqual(RECAP);
	});

	it('coalesces a rapid double request into ONE in-flight fetch', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));

		// Two clicks in the same tick, before the first response lands.
		requestScriptErrors(TAB);
		requestScriptErrors(TAB);
		expect(getScriptErrorsPhase(TAB)).toBe('loading');
		await vi.advanceTimersByTimeAsync(0);
		expect(recapSpy).toHaveBeenCalledTimes(1);
	});

	it('ignores a request while the table is still computing', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'computing', done: 2, total: 300 }, 1, 0, 300));

		await ask();
		// The grid is showing degraded BUILD order — a recap's row indices would
		// not address it, and the route would 202 anyway.
		expect(recapSpy).toHaveBeenCalledTimes(0);
		expect(getScriptErrors(TAB)).toBeNull();
	});

	it('ignores a request for a table with no script work at all', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith(null));

		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(0);
	});

	it('fetches a recap for a FAILED sweep too (its holes are the errors)', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'failed', done: 4, total: 10, message: 'sweep died' }));
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrors(TAB)).toEqual(RECAP);
	});

	it('drops the recap when a new model rev lands, and re-fetches only on the next request', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }, 1));
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// A peer's commit re-numbers every row: the recap on hand addresses the
		// PREVIOUS order and must go, without costing a request.
		await land(pageWith({ state: 'ready', done: 10, total: 10 }, 2));
		expect(getScriptErrors(TAB)).toBeNull();
		expect(getScriptErrorsPhase(TAB)).toBe('idle');
		expect(recapSpy).toHaveBeenCalledTimes(1);

		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(2);
	});

	it('drops the recap after a re-evaluation at the SAME rev (a sort moves every row index)', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }, 1));
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// `row_index` is an address into the order the grid is SHOWING, so a
		// sort (or a definition edit) invalidates the recap even though the
		// model rev and the sweep status are both unchanged.
		evalSpy.mockResolvedValue(pageWith({ state: 'ready', done: 10, total: 10 }, 1));
		setTableSort(TAB, { column: 0, direction: 'asc' });
		await vi.advanceTimersByTimeAsync(0);
		expect(getScriptErrors(TAB)).toBeNull();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(2);
		expect(recapSpy.mock.calls[1][0]).toMatchObject({ sort: { column: 0, direction: 'asc' } });
	});

	it('cannot be asked for while a re-evaluation is in flight — even one that fails', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }, 1));
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// A sort whose evaluation FAILS. The grid keeps showing the rows of the
		// old order (nothing landed to replace them), but the recap route would
		// now be asked with the NEW sort — its `row_index`es would address an
		// order nobody is looking at. So the tab has no askable page state until
		// one really lands, and the stale recap is gone either way.
		evalSpy.mockRejectedValue(new Error('network'));
		setTableSort(TAB, { column: 0, direction: 'asc' });
		await vi.advanceTimersByTimeAsync(0);

		expect(getScriptErrors(TAB)).toBeNull();
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);
	});

	it('drops the recap when a page arrives with no script status at all', async () => {
		vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		await ask();
		expect(getScriptErrors(TAB)).toEqual(RECAP);

		await land(pageWith(null));
		expect(getScriptErrors(TAB)).toBeNull();
	});

	it('drops the recap when the table goes back to computing', async () => {
		vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		await ask();
		expect(getScriptErrors(TAB)).toEqual(RECAP);

		// A recap describes a SETTLED table: its row indices address the sorted
		// grid, which is not what a computing (build-order, degraded) page shows.
		await land(pageWith({ state: 'computing', done: 1, total: 10 }, 2));
		expect(getScriptErrors(TAB)).toBeNull();
	});

	it('keeps an EMPTY recap: "we checked, there are none" is an answer', async () => {
		const empty: ScriptErrorsRecap = {
			state: 'ready',
			errors: [],
			total_errors: 0,
			truncated: false
		};
		vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(empty);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		await ask();

		expect(getScriptErrors(TAB)).toEqual(empty);
		expect(getScriptErrorsPhase(TAB)).toBe('done');
	});

	it('never breaks the table: a failed fetch reports the error phase and can be retried', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockRejectedValue(new Error('boom'));
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));

		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrors(TAB)).toBeNull();
		expect(getScriptErrorsPhase(TAB)).toBe('error');

		// The user asked and got nothing: asking again must really try again,
		// not be swallowed by a signature that says "already fetched".
		recapSpy.mockResolvedValue(RECAP);
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(2);
		expect(getScriptErrors(TAB)).toEqual(RECAP);
	});

	it('forgets the recap when the tab is closed', async () => {
		vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		await ask();
		expect(getScriptErrors(TAB)).toEqual(RECAP);

		closeTableDraft(TAB);
		expect(getScriptErrors(TAB)).toBeNull();
		expect(getScriptErrorsPhase(TAB)).toBe('idle');
	});
});

describe('script-error recap 202 retry', () => {
	it('schedules exactly ONE delayed retry per 202 and stops once it lands', async () => {
		const recapSpy = vi
			.spyOn(tablesApi, 'fetchScriptErrors')
			.mockResolvedValueOnce({ retry: true })
			.mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		await ask();

		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrors(TAB)).toBeNull();
		// The control must keep saying "checking" across the retry chain.
		expect(getScriptErrorsPhase(TAB)).toBe('loading');

		// The retry is DELAYED, not immediate — a zero-delay retry would be a
		// tight loop against a route that re-pays a whole-table pass.
		await vi.advanceTimersByTimeAsync(500);
		expect(recapSpy).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(600);
		expect(recapSpy).toHaveBeenCalledTimes(2);
		expect(getScriptErrors(TAB)).toEqual(RECAP);

		// ...and the chain really stopped: no third call ever goes out.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(recapSpy).toHaveBeenCalledTimes(2);
	});

	it('keeps exactly one retry timer per tab under a repeated 202', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue({ retry: true });
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// One retry per second, never two: a compounding loop would double each
		// tick (2, 4, 8 …), which is exactly the storm this discipline prevents.
		await vi.advanceTimersByTimeAsync(1000);
		expect(recapSpy).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1000);
		expect(recapSpy).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1000);
		expect(recapSpy).toHaveBeenCalledTimes(4);

		// A second request mid-chain must not start a parallel loop.
		await ask();
		await vi.advanceTimersByTimeAsync(1000);
		expect(recapSpy).toHaveBeenCalledTimes(5);
	});

	it('gives up after RECAP_MAX_ATTEMPTS rather than retrying a 202 forever', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue({ retry: true });
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		await ask();

		// The exact bound: 1 requested fetch + RECAP_MAX_ATTEMPTS (120) retries;
		// the 121st is never scheduled. Same shape as the sweep poll's give-up
		// test, and asserted exactly so a change to the constant has to be a
		// deliberate edit here rather than sliding under a loose ceiling.
		await vi.advanceTimersByTimeAsync(1000 * 400);
		expect(recapSpy).toHaveBeenCalledTimes(121);

		// ...and it really has stopped, not merely paused.
		await vi.advanceTimersByTimeAsync(1000 * 400);
		expect(recapSpy).toHaveBeenCalledTimes(121);
		// Giving up is reported as a failed check, not as "no errors" — and the
		// user can ask again.
		expect(getScriptErrors(TAB)).toBeNull();
		expect(getScriptErrorsPhase(TAB)).toBe('error');

		recapSpy.mockResolvedValue(RECAP);
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(122);
		expect(getScriptErrors(TAB)).toEqual(RECAP);
	});

	it('cancels a pending retry when the tab is closed', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue({ retry: true });
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		closeTableDraft(TAB);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(recapSpy).toHaveBeenCalledTimes(1);
	});

	it('cancels a pending retry when the page state changes under it', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue({ retry: true });
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }, 1));
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// A newer rev supersedes the state the pending retry was fetching for.
		await land(pageWith({ state: 'ready', done: 10, total: 10 }, 2));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrorsPhase(TAB)).toBe('idle');
	});
});

describe('jump-to-cell request', () => {
	it('round-trips a scroll request and clears it on consume', () => {
		expect(consumeScrollRequest(TAB)).toBeNull();

		requestScrollToCell(TAB, 3, 1);
		expect(consumeScrollRequest(TAB)).toEqual({ rowIndex: 3, columnIndex: 1 });
		// One consumer only: a second read gets nothing (the grid's effect
		// re-runs on unrelated cache changes and must not re-scroll).
		expect(consumeScrollRequest(TAB)).toBeNull();
	});

	it('keeps requests per tab and forgets them on close', () => {
		requestScrollToCell(TAB, 1, 0);
		requestScrollToCell('tbl:draft:2', 7, 2);
		closeTableDraft(TAB);

		expect(consumeScrollRequest(TAB)).toBeNull();
		expect(consumeScrollRequest('tbl:draft:2')).toEqual({ rowIndex: 7, columnIndex: 2 });
	});
});
