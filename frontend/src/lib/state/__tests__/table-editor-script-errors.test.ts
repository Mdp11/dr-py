// The script-error RECAP is fetched on demand. A table's failing script cells
// can sit anywhere in a virtualized grid the client only ever holds a window
// of, so the whole-table `tableScriptErrors` call (engine) is the only
// complete answer. It evaluates every script cell, so the recap is fetched only
// when the user asks for it. This suite pins the client half:
//
//   * WHEN the recap is fetched — never on landing, only on
//     `requestScriptErrors`, and once per page state no matter how many times
//     it is asked for;
//   * INVALIDATION: a new model rev, a re-evaluation at the same rev (sort /
//     definition edit), a page with no script column, and tab teardown all DROP
//     the recap without fetching anything — a `row_index` is a grid address, so
//     a recap that outlived its row order must never be shown against the new
//     one;
//   * the jump request round-trip (`requestScrollToCell`/`consumeScrollRequest`).
//
// `vi.spyOn` on the API module, whose call count is the assertion for "did a
// request actually go out"; waits are on the store's own state, never on time.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ApiError } from '$lib/api/errors';
import * as tablesApi from '$lib/api/tables';
import type { ScriptErrorsRecap, TableCell, TablePage } from '$lib/api/types';
import {
	canRequestScriptErrors,
	closeTableDraft,
	consumeScrollRequest,
	ensureTableDraft,
	ensureTableRange,
	getScriptErrors,
	getScriptErrorsPhase,
	getTableError,
	getTableLoading,
	getUncomputedScriptCellReason,
	loadTablePage,
	requestScriptErrors,
	requestScrollToCell,
	resetTableEditors,
	getTableDraft,
	updateTableDefinition
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
 * sparse cache has holes a chunk fill can be driven into). Carries a script
 * column unless `scripted` is false. */
function pageWith(model_rev = 1, offset = 0, total = 10, scripted = true): TablePage {
	return {
		columns: [
			{ kind: 'element', header: '', width_px: null },
			...(scripted ? [{ kind: 'script', header: 'calc', width_px: null }] : [])
		],
		rows: Array.from({ length: 10 }, (_, i) => ({ key: [`e${offset + i}`], cells: [] })),
		total,
		truncated: false,
		offset,
		model_rev,
		warnings: []
	};
}

/** A 10-row page whose SECOND column is a script column, every row carrying
 * `cell` in it — the evidence `getUncomputedScriptCellReason` reads. */
function scriptPageWith(cell: TableCell, model_rev = 1): TablePage {
	return {
		...pageWith(model_rev),
		rows: Array.from({ length: 10 }, (_, i) => ({
			key: [`e${i}`],
			cells: [{ kind: 'element', item: null }, cell] as TableCell[]
		}))
	};
}

const VALUE_CELL: TableCell = {
	kind: 'value',
	present: true,
	value: 42,
	element_id: null,
	editable: false
};

let evalSpy: MockInstance<typeof tablesApi.evaluateTable>;

beforeEach(() => {
	resetTableEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	evalSpy = vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(pageWith(1, 0, 10, false));
});
afterEach(() => {
	resetTableEditors();
	vi.restoreAllMocks();
});

/** Land one page for TAB. */
async function land(page: TablePage): Promise<void> {
	evalSpy.mockResolvedValue(page);
	await loadTablePage(TAB, page.offset);
}

/** Ask for the recap and let its promise chain settle. */
async function ask(): Promise<void> {
	requestScriptErrors(TAB);
	await vi.waitFor(() => expect(getScriptErrorsPhase(TAB)).not.toBe('loading'));
}

/** Let a load started by a definition edit finish. */
async function settled(): Promise<void> {
	await vi.waitFor(() => expect(getTableLoading(TAB)).toBe(false));
}

describe('script-error recap fetch-on-demand', () => {
	it('does NOT fetch a recap when a page settles — only when asked', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);

		await land(pageWith());

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
		await land(pageWith(1, 0, 300));

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
		ensureTableRange(TAB, 200, 300);
		await vi.waitFor(() => expect(evalSpy.mock.calls.length).toBeGreaterThan(evalCalls)); // fills really went out
		await vi.waitFor(() => expect(getTableLoading(TAB)).toBe(false));
		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrors(TAB)).toEqual(RECAP);
	});

	it('coalesces a rapid double request into ONE in-flight fetch', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith());

		// Two clicks in the same tick, before the first response lands.
		requestScriptErrors(TAB);
		requestScriptErrors(TAB);
		expect(getScriptErrorsPhase(TAB)).toBe('loading');
		await vi.waitFor(() => expect(getScriptErrorsPhase(TAB)).toBe('done'));
		expect(recapSpy).toHaveBeenCalledTimes(1);
	});

	it('ignores a request for a table with no script work at all', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith(1, 0, 10, false));

		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(0);
	});

	it('drops the recap when a new model rev lands, and re-fetches only on the next request', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith(1));
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// A peer's commit re-numbers every row: the recap on hand addresses the
		// PREVIOUS order and must go, without costing a request.
		await land(pageWith(2));
		expect(getScriptErrors(TAB)).toBeNull();
		expect(getScriptErrorsPhase(TAB)).toBe('idle');
		expect(recapSpy).toHaveBeenCalledTimes(1);

		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(2);
	});

	it('drops the recap after a re-evaluation at the SAME rev (a sort moves every row index)', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith(1));
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// `row_index` is an address into the order the grid is SHOWING, so a
		// sort (or a definition edit) invalidates the recap even though the
		// model rev is unchanged.
		evalSpy.mockResolvedValue(pageWith(1));
		updateTableDefinition(TAB, {
			...getTableDraft(TAB)!.definition,
			sort: [{ column: 0, direction: 'asc' }]
		});
		await settled();
		expect(getScriptErrors(TAB)).toBeNull();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(2);
		expect(recapSpy.mock.calls[1][0]).toMatchObject({
			definition: { sort: [{ column: 0, direction: 'asc' }] }
		});
	});

	it('cannot be asked for while a re-evaluation is in flight — even one that fails', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith(1));
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);

		// A sort whose evaluation FAILS. The grid keeps showing the rows of the
		// old order (nothing landed to replace them), but the recap route would
		// now be asked with the NEW sort — its `row_index`es would address an
		// order nobody is looking at. So the tab has no askable page state until
		// one really lands, and the stale recap is gone either way.
		evalSpy.mockRejectedValue(new Error('network'));
		updateTableDefinition(TAB, {
			...getTableDraft(TAB)!.definition,
			sort: [{ column: 0, direction: 'asc' }]
		});
		await settled();

		expect(getScriptErrors(TAB)).toBeNull();
		await ask();
		expect(recapSpy).toHaveBeenCalledTimes(1);
	});

	it('drops the recap when a page arrives with no script column', async () => {
		vi.spyOn(tablesApi, 'fetchScriptErrors').mockResolvedValue(RECAP);
		await ensureTableDraft(TAB);
		await land(pageWith());
		await ask();
		expect(getScriptErrors(TAB)).toEqual(RECAP);

		await land(pageWith(1, 0, 10, false));
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
		await land(pageWith());
		await ask();

		expect(getScriptErrors(TAB)).toEqual(empty);
		expect(getScriptErrorsPhase(TAB)).toBe('done');
	});

	it('never breaks the table: a failed fetch reports the error phase and can be retried', async () => {
		const recapSpy = vi.spyOn(tablesApi, 'fetchScriptErrors').mockRejectedValue(new Error('boom'));
		await ensureTableDraft(TAB);
		await land(pageWith());

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
		await land(pageWith());
		await ask();
		expect(getScriptErrors(TAB)).toEqual(RECAP);

		closeTableDraft(TAB);
		expect(getScriptErrors(TAB)).toBeNull();
		expect(getScriptErrorsPhase(TAB)).toBe('idle');
	});
});

describe('script-error recap routing', () => {
	it('reports a recap the server refuses as the error phase', async () => {
		const recapSpy = vi
			.spyOn(tablesApi, 'fetchScriptErrors')
			.mockRejectedValue(
				new ApiError(409, { detail: 'scripts need the engine' }, 'scripts need the engine')
			);
		await ensureTableDraft(TAB);
		await land(pageWith());
		await ask();

		expect(recapSpy).toHaveBeenCalledTimes(1);
		expect(getScriptErrorsPhase(TAB)).toBe('error');
		expect(getScriptErrors(TAB)).toBeNull();
	});
});

describe('a table the server refuses to run scripts for', () => {
	it('is the scripts state, not an error message', async () => {
		evalSpy.mockRejectedValue(
			new ApiError(409, { detail: 'scripts need the engine' }, 'scripts need the engine')
		);
		await ensureTableDraft(TAB);
		await loadTablePage(TAB, 0);
		expect(getTableError(TAB)).toEqual({ kind: 'scripts' });
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

// The badge must never be DEAD. `_loadTablePage` drops the recap signature
// the instant a re-evaluation goes out, so a badge gated on the page alone would
// keep reading "Check for script errors" while a sort is in flight and clicking
// it would no-op (`requestScriptErrors` no-ops without a signature). The store
// owns the answer to "can this be asked for"; the component does not re-derive
// it.
describe('script-error recap askability', () => {
	it('is askable only while a page state is actually on screen', async () => {
		await ensureTableDraft(TAB);
		expect(canRequestScriptErrors(TAB)).toBe(false);

		await land(pageWith());
		expect(canRequestScriptErrors(TAB)).toBe(true);

		// A re-evaluation in flight: unaskable from the moment the request goes
		// out (not from the moment its response lands), because that is exactly
		// when `requestScriptErrors` starts no-opping.
		let settle: (p: TablePage) => void = () => {};
		evalSpy.mockImplementation(
			() =>
				new Promise<TablePage>((res) => {
					settle = res;
				})
		);
		updateTableDefinition(TAB, {
			...getTableDraft(TAB)!.definition,
			sort: [{ column: 0, direction: 'asc' }]
		});
		expect(canRequestScriptErrors(TAB)).toBe(false);

		settle(pageWith());
		await settled();
		expect(canRequestScriptErrors(TAB)).toBe(true);
	});

	it('is not askable for a table with no script work', async () => {
		await ensureTableDraft(TAB);
		await land(pageWith(2, 0, 10, false));
		expect(canRequestScriptErrors(TAB)).toBe(false);
	});
});

// With no script runner the backend answers the recap with ZERO errors — the
// honest server-side answer, since nothing was evaluated and so nothing is
// KNOWN to have failed. Rendered as an affirmative ("No script errors") it
// becomes a lie told directly above a grid whose every script cell reads
// `script runner unavailable`. `ScriptErrorsOut` cannot carry the distinction
// (its `state` is a one-valued literal and the wire shape is deliberately
// frozen), so the client earns it from the evidence it already holds: the
// cells of the page on screen.
describe('uncomputed script cells', () => {
	it('reports no reason when every script cell on screen produced a value', async () => {
		await ensureTableDraft(TAB);
		await land(scriptPageWith(VALUE_CELL));
		expect(getUncomputedScriptCellReason(TAB)).toBeNull();
	});

	it("reports the cell's own message when a script cell came back an error", async () => {
		await ensureTableDraft(TAB);
		// What the page route renders for every script cell with no runner: the
		// window pass is LIVE, so the cells say why.
		await land(scriptPageWith({ kind: 'error', message: 'script runner unavailable' }));
		expect(getUncomputedScriptCellReason(TAB)).toBe('script runner unavailable');
	});

	it('ignores error cells OUTSIDE script columns — a recap never covered those', async () => {
		await ensureTableDraft(TAB);
		const page = scriptPageWith(VALUE_CELL);
		page.rows[0].cells[0] = { kind: 'error', message: 'dangling reference' };
		await land(page);
		// Over-suppressing is its own failure: an honest "no script errors" must
		// survive a navigation column that happens to be broken.
		expect(getUncomputedScriptCellReason(TAB)).toBeNull();
	});

	it('reports nothing before a page lands, and nothing for a script-less table', async () => {
		await ensureTableDraft(TAB);
		expect(getUncomputedScriptCellReason(TAB)).toBeNull();
		await land(pageWith(1, 0, 10, false));
		expect(getUncomputedScriptCellReason(TAB)).toBeNull();
	});
});
