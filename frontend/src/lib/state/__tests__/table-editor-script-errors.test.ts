// The script-error RECAP (Task 6). A table's failing script cells can sit
// anywhere in a virtualized grid the client only ever holds a window of, so
// the backend's whole-table `POST /tables/script-errors` is the only complete
// answer. This suite pins the client half of that contract:
//
//   * WHEN the recap is fetched — only once a landed page's `script_status`
//     SETTLES (`ready`/`failed`), never per chunk fill (each call re-pays a
//     whole-table pass server-side);
//   * the 202 retry discipline — one timer per tab, delayed, non-compounding;
//   * invalidation — a new model rev, a status that stops being terminal, a
//     page with no script status at all, and tab teardown;
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
	loadTablePage,
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

/** Land one page for TAB and let the recap's own promise chain settle. */
async function land(page: TablePage): Promise<void> {
	evalSpy.mockResolvedValue(page);
	await loadTablePage(TAB, page.offset);
	await vi.advanceTimersByTimeAsync(0);
}

describe('script-error recap fetch-on-settle', () => {
	it('fetches the recap when the first page already reports a settled status', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		expect(getScriptErrors(TAB)).toBeNull();

		await land(pageWith({ state: 'ready', done: 10, total: 10 }));

		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrors(TAB)).toEqual(RECAP);
	});

	it('fetches once when the status transitions computing -> ready, not per chunk fill', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);

		// While computing the table is still being filled in — no recap yet (it
		// would 202 anyway) and, crucially, no request.
		await land(pageWith({ state: 'computing', done: 2, total: 300 }, 1, 0, 300));
		expect(recapSpy).toHaveBeenCalledTimes(0);
		expect(getScriptErrors(TAB)).toBeNull();

		await land(pageWith({ state: 'ready', done: 300, total: 300 }, 1, 0, 300));
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// Background CHUNK FILLS as the user scrolls (`mergePage`, no generation
		// bump) land the same page state over and over. Each recap is a
		// whole-table pass server-side, so scrolling a settled table must cost
		// exactly zero of them.
		const evalCalls = evalSpy.mock.calls.length;
		ensureTableRange(TAB, 100, 200);
		await vi.advanceTimersByTimeAsync(0);
		ensureTableRange(TAB, 200, 300);
		await vi.advanceTimersByTimeAsync(0);
		expect(evalSpy.mock.calls.length).toBeGreaterThan(evalCalls); // fills really went out
		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrors(TAB)).toEqual(RECAP);
	});

	it('fetches the recap for a FAILED sweep too (its holes are the errors)', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'failed', done: 4, total: 10, message: 'sweep died' }));
		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrors(TAB)).toEqual(RECAP);
	});

	it('re-fetches when a new model rev lands (row indices are per-rev addresses)', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }, 1));
		expect(recapSpy).toHaveBeenCalledTimes(1);

		await land(pageWith({ state: 'ready', done: 10, total: 10 }, 2));
		expect(recapSpy).toHaveBeenCalledTimes(2);
	});

	it('re-fetches after a re-evaluation at the SAME rev (a sort moves every row index)', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }, 1));
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// `row_index` is an address into the order the grid is SHOWING, so a
		// sort (or a definition edit) invalidates the recap even though the
		// model rev and the sweep status are both unchanged.
		setTableSort(TAB, { column: 0, direction: 'asc' });
		await vi.advanceTimersByTimeAsync(0);
		expect(recapSpy).toHaveBeenCalledTimes(2);
		expect(recapSpy.mock.calls[1][0]).toMatchObject({ sort: { column: 0, direction: 'asc' } });
	});

	it('drops the recap when a page arrives with no script status at all', async () => {
		vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		expect(getScriptErrors(TAB)).toEqual(RECAP);

		await land(pageWith(null));
		expect(getScriptErrors(TAB)).toBeNull();
	});

	it('drops the recap when the table goes back to computing', async () => {
		vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		expect(getScriptErrors(TAB)).toEqual(RECAP);

		// A recap describes a SETTLED table: its row indices address the sorted
		// grid, which is not what a computing (build-order, degraded) page shows.
		await land(pageWith({ state: 'computing', done: 1, total: 10 }, 2));
		expect(getScriptErrors(TAB)).toBeNull();
	});

	it('never 5xx-breaks the table: a failed recap fetch just leaves no badge', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockRejectedValue(new Error('boom'));
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrors(TAB)).toBeNull();
	});

	it('forgets the recap when the tab is closed', async () => {
		vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		expect(getScriptErrors(TAB)).toEqual(RECAP);

		closeTableDraft(TAB);
		expect(getScriptErrors(TAB)).toBeNull();
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

		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrors(TAB)).toBeNull();

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
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// One retry per second, never two: a compounding loop would double each
		// tick (2, 4, 8 …), which is exactly the storm this discipline prevents.
		await vi.advanceTimersByTimeAsync(1000);
		expect(recapSpy).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1000);
		expect(recapSpy).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1000);
		expect(recapSpy).toHaveBeenCalledTimes(4);
	});

	it('gives up rather than retrying a 202 forever', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue({ retry: true });
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));

		await vi.advanceTimersByTimeAsync(1000 * 400);
		const settled = recapSpy.mock.calls.length;
		expect(settled).toBeLessThan(200); // bounded, not once-a-second forever
		await vi.advanceTimersByTimeAsync(1000 * 400);
		expect(recapSpy).toHaveBeenCalledTimes(settled); // really stopped
	});

	it('cancels a pending retry when the tab is closed', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue({ retry: true });
		await ensureTableDraft(TAB);
		await land(pageWith({ state: 'ready', done: 10, total: 10 }));
		expect(recapSpy).toHaveBeenCalledTimes(1);

		closeTableDraft(TAB);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(recapSpy).toHaveBeenCalledTimes(1);
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
