// The script-sweep polling loop (Task 10). A `/tables/evaluate` response whose
// `script_status.state` is `computing` means the backend served some cells from
// a cache the background sweep is still filling — the client must poll the SAME
// visible window until the status turns terminal (`ready`/`failed`).
//
// Time is driven with `vi.useFakeTimers()` and advanced via
// `advanceTimersByTimeAsync`, so the scheduled poll's own `await` chain settles
// inside the advance. `evaluateTable` is spied on the module (same style as
// `table-editor.test.ts`) — its call count is the assertion for "did a poll
// actually go out".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tablesApi from '$lib/api/tables';
import type { TablePage } from '$lib/api/types';
import {
	closeTableDraft,
	ensureTableDraft,
	ensureTableRange,
	getTableScriptStatus,
	loadTablePage,
	resetTableEditors,
	updateTableDefinition,
	getTableDraft,
	downloadTable
} from '../table-editor.svelte';
import { resetWorkspaceTabs } from '../workspace.svelte';
import { resetArtifacts } from '../artifacts.svelte';

const TAB = 'tbl:draft:1';

/** A page of `count` rows at `offset` out of `total`, with `script_status`. */
function pageAt(
	offset: number,
	count: number,
	total: number,
	script_status: TablePage['script_status']
): TablePage {
	return {
		columns: [{ kind: 'element', header: '', width_px: null }],
		rows: Array.from({ length: count }, (_, i) => ({ key: [`e${offset + i}`], cells: [] })),
		total,
		truncated: false,
		offset,
		model_rev: 1,
		warnings: [],
		script_status
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	resetTableEditors();
	resetWorkspaceTabs();
	resetArtifacts();
});
afterEach(() => {
	resetTableEditors();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Open a draft tab and land one page whose status is `computing`, covering
 * rows [100, 200) of 300 — the window the poll must re-request. */
async function seedComputing(spy: ReturnType<typeof vi.fn>): Promise<void> {
	await ensureTableDraft(TAB);
	await loadTablePage(TAB, 100);
	// The grid reports the window it shows; the poll re-requests exactly this.
	ensureTableRange(TAB, 100, 200);
	expect(spy).toHaveBeenCalledTimes(1);
}

describe('table script-status polling', () => {
	it('schedules exactly ONE re-poll of the visible window while computing', async () => {
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockResolvedValue(pageAt(100, 100, 300, { state: 'computing', done: 40, total: 300 }));
		await seedComputing(spy as unknown as ReturnType<typeof vi.fn>);

		expect(getTableScriptStatus(TAB)).toMatchObject({ state: 'computing', done: 40, total: 300 });

		await vi.advanceTimersByTimeAsync(1000);
		expect(spy).toHaveBeenCalledTimes(2);
		// the poll asks for the window the user is looking at, not row 0
		expect(spy.mock.calls[1][0]).toMatchObject({ offset: 100, limit: 100 });

		// exactly one timer per landing: a full second later there is one more
		// poll, not two (a compounding loop would double every tick)
		await vi.advanceTimersByTimeAsync(1000);
		expect(spy).toHaveBeenCalledTimes(3);
	});

	it('stops polling once a re-poll comes back ready', async () => {
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockResolvedValue(pageAt(100, 100, 300, { state: 'computing', done: 40, total: 300 }));
		await seedComputing(spy as unknown as ReturnType<typeof vi.fn>);

		spy.mockResolvedValue(pageAt(100, 100, 300, { state: 'ready', done: 300, total: 300 }));
		await vi.advanceTimersByTimeAsync(1000);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(getTableScriptStatus(TAB)).toMatchObject({ state: 'ready', done: 300 });

		await vi.advanceTimersByTimeAsync(10_000);
		expect(spy).toHaveBeenCalledTimes(2); // terminal: no further polls
	});

	it('cancels the pending poll when the tab is closed', async () => {
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockResolvedValue(pageAt(100, 100, 300, { state: 'computing', done: 1, total: 300 }));
		await seedComputing(spy as unknown as ReturnType<typeof vi.fn>);

		closeTableDraft(TAB);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(spy).toHaveBeenCalledTimes(1); // no fetch after close
		expect(getTableScriptStatus(TAB)).toBeNull();
	});

	it('cancels the pending poll when a definition edit bumps the generation', async () => {
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockResolvedValue(pageAt(100, 100, 300, { state: 'computing', done: 1, total: 300 }));
		await seedComputing(spy as unknown as ReturnType<typeof vi.fn>);

		// An edit issues its own load (call 2) and supersedes the scheduled poll.
		spy.mockResolvedValue(pageAt(0, 100, 300, { state: 'ready', done: 300, total: 300 }));
		updateTableDefinition(TAB, { ...getTableDraft(TAB)!.definition });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(getTableScriptStatus(TAB)).toMatchObject({ state: 'ready' });
	});

	it('stops polling on failed and surfaces the message', async () => {
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockResolvedValue(
				pageAt(100, 100, 300, { state: 'failed', done: 12, total: 300, message: 'sweep died' })
			);
		await seedComputing(spy as unknown as ReturnType<typeof vi.fn>);

		expect(getTableScriptStatus(TAB)).toMatchObject({ state: 'failed', message: 'sweep died' });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('clears the status when a page arrives without one', async () => {
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockResolvedValue(pageAt(100, 100, 300, { state: 'computing', done: 1, total: 300 }));
		await seedComputing(spy as unknown as ReturnType<typeof vi.fn>);

		spy.mockResolvedValue(pageAt(100, 100, 300, null));
		await vi.advanceTimersByTimeAsync(1000);
		expect(getTableScriptStatus(TAB)).toBeNull();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe('downloadTable export retry', () => {
	it('retries a 202 "preparing" export and downloads once ready', async () => {
		await ensureTableDraft(TAB);
		const blob = new Blob(['x'], { type: 'application/octet-stream' });
		const exportSpy = vi
			.spyOn(tablesApi, 'exportTable')
			.mockResolvedValueOnce({ kind: 'preparing', done: 5, total: 20 })
			.mockResolvedValueOnce({ kind: 'ready', blob, filename: 'table.xlsx' });
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		const progress: number[] = [];

		const done = downloadTable(TAB, { onProgress: (p) => progress.push(p.done) });
		await vi.advanceTimersByTimeAsync(2000);
		await done;

		expect(exportSpy).toHaveBeenCalledTimes(2);
		expect(click).toHaveBeenCalledTimes(1);
		expect(progress).toEqual([5]);
	});

	it('stops retrying when the caller aborts', async () => {
		await ensureTableDraft(TAB);
		const exportSpy = vi
			.spyOn(tablesApi, 'exportTable')
			.mockResolvedValue({ kind: 'preparing', done: 1, total: 20 });
		const ctl = new AbortController();

		const done = downloadTable(TAB, { signal: ctl.signal });
		await vi.advanceTimersByTimeAsync(500);
		ctl.abort();
		await vi.advanceTimersByTimeAsync(5000);
		await done;

		expect(exportSpy).toHaveBeenCalledTimes(1);
	});
});
