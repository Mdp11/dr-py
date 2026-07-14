import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import * as tablesApi from '$lib/api/tables';
import {
	closeTableDraft,
	ensureTableDraft,
	ensureTableRange,
	getTableConflict,
	getTableDraft,
	getTableError,
	getTableLoading,
	getTablePage,
	getTableSort,
	handleTableModelRevChanged,
	loadTablePage,
	reloadTableDraft,
	remapTableSortForMove,
	remapTableSortForRemove,
	resetTableEditors,
	saveAsTableDraft,
	saveTableDraft,
	setTableName,
	setTableSort,
	updateTableDefinition
} from '../table-editor.svelte';
import { resetWorkspaceTabs } from '../workspace.svelte';
import { resetArtifacts } from '../artifacts.svelte';

/** Flush the microtask/macrotask queue so a fire-and-forget `loadTablePage`
 * call (triggered by `updateTableDefinition`/`setTableSort`) has settled. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const EMPTY_PAGE = {
	columns: [],
	rows: [],
	total: 0,
	truncated: false,
	offset: 0,
	model_rev: 1
};

/** A page of `count` synthetic rows at `offset` out of `total`. */
function pageAt(offset: number, count: number, total: number, model_rev = 1) {
	return {
		columns: [{ kind: 'element', header: '', width_px: null }],
		rows: Array.from({ length: count }, (_, i) => ({
			key: [`e${offset + i}`],
			cells: []
		})),
		total,
		truncated: false,
		offset,
		model_rev
	};
}

beforeEach(() => {
	resetTableEditors();
	resetWorkspaceTabs();
	resetArtifacts();
});
afterEach(() => {
	resetTableEditors();
	vi.restoreAllMocks();
});

describe('table-editor', () => {
	it('ensureTableDraft creates an empty draft for a draft tab WITHOUT evaluating it', async () => {
		const spy = vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:draft:1');
		const d = getTableDraft('tbl:draft:1');
		expect(d?.artifactId).toBeNull();
		expect(d?.definition.columns.length).toBeGreaterThanOrEqual(1);
		// A brand-new table opens EMPTY: its default untyped scope evaluates to
		// every element, so nothing runs until the first settings edit.
		await flush();
		expect(spy).not.toHaveBeenCalled();
		expect(getTablePage('tbl:draft:1')).toBeUndefined();
		// a peer's commit must not surprise-fill the never-evaluated table either
		handleTableModelRevChanged();
		await flush();
		expect(spy).not.toHaveBeenCalled();
		// the first definition edit triggers the first evaluation
		updateTableDefinition('tbl:draft:1', { ...d!.definition });
		await flush();
		expect(spy).toHaveBeenCalled();
		expect(getTablePage('tbl:draft:1')).toBeDefined();
	});

	it('setTableSort resets the loaded page offset', async () => {
		const spy = vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:draft:2');
		setTableSort('tbl:draft:2', { column: 0, direction: 'asc' });
		// the store re-requests page 0 with the sort
		await Promise.resolve();
		expect(spy).toHaveBeenCalled();
		const lastCall = spy.mock.calls.at(-1)![0];
		expect(lastCall.offset ?? 0).toBe(0);
		expect(lastCall.sort).toEqual({ column: 0, direction: 'asc' });
	});

	/** Widen a fresh draft to `n` element columns so a sort on a later column
	 * survives `_sortFor`'s out-of-range net during these remap tests. */
	function widenDraft(tabId: string, n: number): void {
		const d = getTableDraft(tabId)!;
		const col = d.definition.columns[0];
		updateTableDefinition(tabId, {
			...d.definition,
			columns: Array.from({ length: n }, () => ({ ...col }))
		});
	}

	it('remapTableSortForRemove clears a sort on the removed column and shifts later ones', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:draft:sortrm');
		widenDraft('tbl:draft:sortrm', 4);
		setTableSort('tbl:draft:sortrm', { column: 2, direction: 'asc' });
		remapTableSortForRemove('tbl:draft:sortrm', 1); // earlier column removed → shift down
		expect(getTableSort('tbl:draft:sortrm')).toEqual({ column: 1, direction: 'asc' });
		remapTableSortForRemove('tbl:draft:sortrm', 1); // the sorted column itself → cleared
		expect(getTableSort('tbl:draft:sortrm')).toBeUndefined();
	});

	it('remapTableSortForMove follows the sorted column across a reorder', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:draft:sortmv');
		widenDraft('tbl:draft:sortmv', 4);
		setTableSort('tbl:draft:sortmv', { column: 1, direction: 'desc' });
		remapTableSortForMove('tbl:draft:sortmv', 1, 3); // the sorted column moved
		expect(getTableSort('tbl:draft:sortmv')).toEqual({ column: 3, direction: 'desc' });
		remapTableSortForMove('tbl:draft:sortmv', 0, 3); // another column hopped over it
		expect(getTableSort('tbl:draft:sortmv')).toEqual({ column: 2, direction: 'desc' });
		remapTableSortForMove('tbl:draft:sortmv', 3, 0); // and hopped back
		expect(getTableSort('tbl:draft:sortmv')).toEqual({ column: 3, direction: 'desc' });
	});

	it('drops an out-of-range sort instead of sending it (defensive net)', async () => {
		const spy = vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:draft:sortoor');
		const d = getTableDraft('tbl:draft:sortoor')!;
		// the empty draft has ONE column; a sort on column 5 must never reach the
		// backend (it would 422 every request for the whole tab)
		setTableSort('tbl:draft:sortoor', { column: 5, direction: 'asc' });
		await flush();
		const lastCall = spy.mock.calls.at(-1)![0];
		expect(lastCall.sort).toBeUndefined();
		expect(getTableSort('tbl:draft:sortoor')).toBeUndefined();
		expect(d.definition.columns.length).toBe(1);
	});

	it('loads a saved artifact payload and its first page', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'table',
			name: 'My table',
			artifact_rev: 3,
			updated_at: '',
			updated_by: null,
			payload: {
				schema_version: 1,
				default_cell_mode: 'collapse',
				row_source: { kind: 'scope', types: ['Building'], criteria: [] },
				columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '' }]
			}
		});
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const draft = await ensureTableDraft('tbl:a1');
		expect(draft.name).toBe('My table');
		expect(draft.artifactRev).toBe(3);
		expect(getTablePage('tbl:a1')).toEqual(EMPTY_PAGE);
	});

	it('updateTableDefinition marks dirty, resets to offset 0, and reloads', async () => {
		vi.spyOn(tablesApi, 'evaluateTable')
			.mockResolvedValueOnce({ ...EMPTY_PAGE, total: 5 })
			.mockResolvedValueOnce({ ...EMPTY_PAGE, total: 9 });
		const draft = await ensureTableDraft('tbl:draft:3'); // new drafts do not auto-load
		await loadTablePage('tbl:draft:3', 40);
		expect(getTablePage('tbl:draft:3')?.total).toBe(5);
		updateTableDefinition('tbl:draft:3', { ...draft.definition });
		expect(getTableDraft('tbl:draft:3')?.dirty).toBe(true);
		await flush();
		const evaluate = vi.mocked(tablesApi.evaluateTable);
		const lastCall = evaluate.mock.calls.at(-1)![0];
		expect(lastCall.offset ?? 0).toBe(0);
		expect(getTablePage('tbl:draft:3')?.total).toBe(9);
	});

	it('a dirty SAVED table evaluates its edited definition, not the stale artifact payload', async () => {
		// Regression: a saved table always evaluated by artifactId, so the backend
		// re-read the SAVED payload and every unsaved settings edit (scope change,
		// new column, restored config) was silently ignored — the grid froze.
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a9',
			kind: 'table',
			name: 'Saved table',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			payload: {
				schema_version: 1,
				default_cell_mode: 'collapse',
				row_source: { kind: 'scope', types: ['Building'], criteria: [] },
				columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '' }]
			}
		});
		const spy = vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const draft = await ensureTableDraft('tbl:a9');
		// pristine saved table: evaluate by artifactId (backend cache reuse)
		expect(spy.mock.calls.at(-1)![0]).toMatchObject({ artifactId: 'a9' });

		const edited = {
			...draft.definition,
			row_source: { kind: 'scope' as const, types: ['Sensor'], criteria: [] }
		};
		updateTableDefinition('tbl:a9', edited);
		await flush();
		const lastCall = spy.mock.calls.at(-1)![0];
		expect('artifactId' in lastCall).toBe(false);
		expect(lastCall.definition).toEqual(edited);

		// lazy chunk fills of the dirty table must use the edited definition too
		spy.mockResolvedValue(pageAt(0, 100, 300));
		await loadTablePage('tbl:a9', 0);
		spy.mockClear();
		ensureTableRange('tbl:a9', 100, 200);
		await flush();
		expect(spy).toHaveBeenCalled();
		expect(spy.mock.calls.every(([args]) => !('artifactId' in args))).toBe(true);
	});

	it('a failed load stores the error message', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockRejectedValue(new Error('boom'));
		await ensureTableDraft('tbl:draft:4');
		await loadTablePage('tbl:draft:4', 0);
		expect(getTableError('tbl:draft:4')).toBe('boom');
		expect(getTablePage('tbl:draft:4')).toBeUndefined();
	});

	it('first save creates the artifact and rebinds the draft under tbl:<id>', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const create = vi.spyOn(artifactsApi, 'createArtifact').mockResolvedValue({
			id: 'a9',
			kind: 'table',
			name: 'Mine',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			payload: {}
		});
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
		await ensureTableDraft('tbl:draft:5');
		setTableName('tbl:draft:5', 'Mine');
		await saveTableDraft('tbl:draft:5');
		expect(create).toHaveBeenCalled();
		// The old draft-tab key must not leak after the rebind.
		expect(getTableDraft('tbl:draft:5')).toBeUndefined();
		expect(getTableDraft('tbl:a9')?.artifactRev).toBe(1);
		expect(getTableDraft('tbl:a9')?.dirty).toBe(false);
	});

	it('save conflict records the server rev from the 409 detail body', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'table',
			name: 'Sensors',
			artifact_rev: 4,
			updated_at: '',
			updated_by: null,
			payload: {
				schema_version: 1,
				default_cell_mode: 'collapse',
				row_source: { kind: 'scope', types: [], criteria: [] },
				columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '' }]
			}
		});
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:a1');
		vi.spyOn(artifactsApi, 'updateArtifact').mockRejectedValue(
			new ConflictError(
				409,
				{ detail: { message: 'artifact was modified by someone else', current_rev: 7 } },
				'HTTP 409'
			)
		);
		await expect(saveTableDraft('tbl:a1')).rejects.toBeInstanceOf(ConflictError);
		expect(getTableConflict('tbl:a1')).toBe(7);
	});

	it('a name-clash 409 on create does NOT enter rev-conflict state', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:draft:6');
		setTableName('tbl:draft:6', 'Taken');
		vi.spyOn(artifactsApi, 'createArtifact').mockRejectedValue(
			new ConflictError(409, { detail: "a table named 'Taken' already exists" }, 'name clash')
		);
		await expect(saveTableDraft('tbl:draft:6')).rejects.toBeInstanceOf(ConflictError);
		expect(getTableConflict('tbl:draft:6')).toBeUndefined();
		expect(getTableDraft('tbl:draft:6')?.name).toBe('Taken');
		expect(getTableDraft('tbl:draft:6')?.artifactId).toBeNull();
	});

	it('saveAsTableDraft forks into a new artifact, leaving the original untouched', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'table',
			name: 'Sensors',
			artifact_rev: 4,
			updated_at: '',
			updated_by: null,
			payload: {
				schema_version: 1,
				default_cell_mode: 'collapse',
				row_source: { kind: 'scope', types: [], criteria: [] },
				columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '' }]
			}
		});
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:a1');
		const create = vi.spyOn(artifactsApi, 'createArtifact').mockResolvedValue({
			id: 'a9',
			kind: 'table',
			name: 'Copy',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			payload: {}
		});
		const update = vi.spyOn(artifactsApi, 'updateArtifact');
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });

		await saveAsTableDraft('tbl:a1', 'Copy');

		expect(create).toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(getTableDraft('tbl:a1')).toBeUndefined();
		const newDraft = getTableDraft('tbl:a9')!;
		expect(newDraft.name).toBe('Copy');
		expect(newDraft.artifactId).toBe('a9');
		expect(newDraft.dirty).toBe(false);
	});

	it('reloadTableDraft drops local state and re-fetches the server copy', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'table',
			name: 'Sensors',
			artifact_rev: 4,
			updated_at: '',
			updated_by: null,
			payload: {
				schema_version: 1,
				default_cell_mode: 'collapse',
				row_source: { kind: 'scope', types: [], criteria: [] },
				columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '' }]
			}
		});
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:a1');
		updateTableDefinition('tbl:a1', getTableDraft('tbl:a1')!.definition);
		await flush();
		expect(getTableDraft('tbl:a1')?.dirty).toBe(true);
		await reloadTableDraft('tbl:a1');
		expect(getTableDraft('tbl:a1')?.dirty).toBe(false);
	});

	it('closeTableDraft removes all per-tab state', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:draft:7');
		setTableSort('tbl:draft:7', { column: 0, direction: 'asc' });
		await flush();
		closeTableDraft('tbl:draft:7');
		// closeTableDraft touches all six per-tab maps — every one must be cleared.
		expect(getTableDraft('tbl:draft:7')).toBeUndefined();
		expect(getTablePage('tbl:draft:7')).toBeUndefined();
		expect(getTableSort('tbl:draft:7')).toBeUndefined();
		expect(getTableLoading('tbl:draft:7')).toBe(false);
		expect(getTableError('tbl:draft:7')).toBeUndefined();
		expect(getTableConflict('tbl:draft:7')).toBeUndefined();
	});

	it('a stale evaluate response after a newer definition edit is dropped', async () => {
		let resolveFirst!: (v: typeof EMPTY_PAGE) => void;
		const first = new Promise<typeof EMPTY_PAGE>((res) => (resolveFirst = res));
		vi.spyOn(tablesApi, 'evaluateTable')
			.mockImplementationOnce(() => first)
			.mockResolvedValueOnce({ ...EMPTY_PAGE, total: 2 });
		const draft = await ensureTableDraft('tbl:draft:8'); // new drafts do not auto-load
		const inflight = loadTablePage('tbl:draft:8', 0);
		updateTableDefinition('tbl:draft:8', { ...draft.definition });
		resolveFirst({ ...EMPTY_PAGE, total: 1 });
		await inflight;
		await flush();
		// The stale response (total: 1) must not clobber the newer request.
		expect(getTablePage('tbl:draft:8')?.total).not.toBe(1);
	});

	it('a save landing while a load is in flight does not strand the new tab on loading', async () => {
		// Hold the first evaluate open, resolve the re-issued one immediately.
		let resolveInflight!: (v: typeof EMPTY_PAGE) => void;
		const inflightPage = new Promise<typeof EMPTY_PAGE>((res) => (resolveInflight = res));
		const evaluate = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockImplementationOnce(() => inflightPage)
			.mockResolvedValue(EMPTY_PAGE);
		vi.spyOn(artifactsApi, 'createArtifact').mockResolvedValue({
			id: 'a9',
			kind: 'table',
			name: 'Mine',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			payload: {}
		});
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });

		const draft = await ensureTableDraft('tbl:draft:9'); // new drafts do not auto-load
		// Kick a load and leave it unresolved (updateTableDefinition fires it).
		updateTableDefinition('tbl:draft:9', { ...draft.definition });
		expect(getTableLoading('tbl:draft:9')).toBe(true);
		// Save before that load resolves: the draft key is retired mid-flight.
		await saveTableDraft('tbl:draft:9');
		// The orphaned request finally resolves — but its generation is stale now.
		resolveInflight(EMPTY_PAGE);
		await flush();
		// The re-issued load under the new tab id must have settled it.
		expect(getTableLoading('tbl:a9')).toBe(false);
		expect(getTablePage('tbl:a9')).toBeDefined();
		// A fresh evaluate was issued under the new tab (the orphaned one + the
		// re-issue = at least two calls).
		expect(evaluate.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it('handleTableModelRevChanged re-runs evaluateTable over the range the grid last asked for', async () => {
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockImplementation(async (args) => pageAt(args.offset ?? 0, args.limit ?? 100, 1000));
		await ensureTableDraft('tbl:draft:10');
		await loadTablePage('tbl:draft:10', 0);
		// The grid reported the user looking at rows 250..320.
		ensureTableRange('tbl:draft:10', 250, 320);
		await flush();
		spy.mockClear();

		handleTableModelRevChanged();
		await flush();

		expect(spy).toHaveBeenCalledTimes(1);
		const lastCall = spy.mock.calls.at(-1)![0];
		// Chunk-aligned start covering [250, 320): offset 200, limit 200.
		expect(lastCall.offset ?? 0).toBe(200);
		expect(lastCall.limit).toBe(200);
	});

	describe('lazy range loading', () => {
		it('loadTablePage installs a sparse row cache sized to the full total', async () => {
			vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(pageAt(0, 100, 250));
			await ensureTableDraft('tbl:draft:20');
			await loadTablePage('tbl:draft:20', 0);
			const data = getTablePage('tbl:draft:20')!;
			expect(data.total).toBe(250);
			expect(data.rows).toHaveLength(250);
			expect(data.rows[0]?.key).toEqual(['e0']);
			expect(data.rows[99]?.key).toEqual(['e99']);
			expect(data.rows[100]).toBeUndefined();
		});

		it('ensureTableRange fetches only the missing chunks and splices them in', async () => {
			const spy = vi
				.spyOn(tablesApi, 'evaluateTable')
				.mockImplementation(async (args) => pageAt(args.offset ?? 0, args.limit ?? 100, 250));
			await ensureTableDraft('tbl:draft:21');
			await loadTablePage('tbl:draft:21', 0);
			spy.mockClear();

			ensureTableRange('tbl:draft:21', 80, 220);
			await flush();

			// Chunks 0 (loaded) is skipped; 100 and 200 are fetched.
			const offsets = spy.mock.calls.map((c) => c[0].offset ?? 0).sort((a, b) => a - b);
			expect(offsets).toEqual([100, 200]);
			const data = getTablePage('tbl:draft:21')!;
			expect(data.rows[150]?.key).toEqual(['e150']);
			expect(data.rows[249]?.key).toEqual(['e249']);
			// Everything loaded: a repeat call fetches nothing.
			spy.mockClear();
			ensureTableRange('tbl:draft:21', 0, 250);
			await flush();
			expect(spy).not.toHaveBeenCalled();
		});

		it('does not double-request a chunk already in flight', async () => {
			let resolveChunk!: (v: ReturnType<typeof pageAt>) => void;
			const pending = new Promise<ReturnType<typeof pageAt>>((res) => (resolveChunk = res));
			const spy = vi
				.spyOn(tablesApi, 'evaluateTable')
				.mockResolvedValueOnce(pageAt(0, 100, 250)) // the reset load
				.mockImplementation(() => pending);
			await ensureTableDraft('tbl:draft:22'); // new drafts do not auto-load
			await loadTablePage('tbl:draft:22', 0);
			spy.mockClear();

			ensureTableRange('tbl:draft:22', 100, 150);
			ensureTableRange('tbl:draft:22', 100, 180); // same chunk, still in flight
			expect(spy).toHaveBeenCalledTimes(1);
			resolveChunk(pageAt(100, 100, 250));
			await flush();
			expect(getTablePage('tbl:draft:22')!.rows[120]?.key).toEqual(['e120']);
		});

		it('a chunk landing after a definition edit is dropped (stale generation)', async () => {
			let resolveChunk!: (v: ReturnType<typeof pageAt>) => void;
			const pending = new Promise<ReturnType<typeof pageAt>>((res) => (resolveChunk = res));
			vi.spyOn(tablesApi, 'evaluateTable')
				.mockResolvedValueOnce(pageAt(0, 100, 250)) // the reset load
				.mockImplementationOnce(() => pending) // the chunk fill
				.mockResolvedValue(pageAt(0, 100, 300)); // the edit's fresh load
			const draft = await ensureTableDraft('tbl:draft:23'); // new drafts do not auto-load
			await loadTablePage('tbl:draft:23', 0);
			ensureTableRange('tbl:draft:23', 100, 150);
			updateTableDefinition('tbl:draft:23', { ...draft.definition });
			await flush();
			resolveChunk(pageAt(100, 100, 250)); // stale: sized for the OLD total
			await flush();
			const data = getTablePage('tbl:draft:23')!;
			expect(data.total).toBe(300);
			expect(data.rows[120]).toBeUndefined(); // the stale chunk must not splice in
		});

		it('a chunk from a different model rev replaces the cache instead of splicing', async () => {
			vi.spyOn(tablesApi, 'evaluateTable')
				.mockResolvedValueOnce(pageAt(0, 100, 250, 1))
				.mockResolvedValueOnce(pageAt(100, 100, 250, 2)); // rev moved between requests
			await ensureTableDraft('tbl:draft:24'); // new drafts do not auto-load
			await loadTablePage('tbl:draft:24', 0);
			ensureTableRange('tbl:draft:24', 100, 150);
			await flush();
			const data = getTablePage('tbl:draft:24')!;
			expect(data.model_rev).toBe(2);
			expect(data.rows[120]?.key).toEqual(['e120']);
			expect(data.rows[0]).toBeUndefined(); // rev-1 rows were dropped, not mixed
		});
	});

	it('save-as landing while a load is in flight also re-issues under the new tab', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'table',
			name: 'Sensors',
			artifact_rev: 4,
			updated_at: '',
			updated_by: null,
			payload: {
				schema_version: 1,
				default_cell_mode: 'collapse',
				row_source: { kind: 'scope', types: [], criteria: [] },
				columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '' }]
			}
		});
		let resolveInflight!: (v: typeof EMPTY_PAGE) => void;
		const inflightPage = new Promise<typeof EMPTY_PAGE>((res) => (resolveInflight = res));
		vi.spyOn(tablesApi, 'evaluateTable')
			.mockResolvedValueOnce(EMPTY_PAGE) // ensureTableDraft's first page
			.mockImplementationOnce(() => inflightPage) // the edit's in-flight load
			.mockResolvedValue(EMPTY_PAGE); // the re-issued load
		vi.spyOn(artifactsApi, 'createArtifact').mockResolvedValue({
			id: 'a9',
			kind: 'table',
			name: 'Copy',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			payload: {}
		});
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });

		const draft = await ensureTableDraft('tbl:a1');
		updateTableDefinition('tbl:a1', { ...draft.definition });
		expect(getTableLoading('tbl:a1')).toBe(true);
		await saveAsTableDraft('tbl:a1', 'Copy');
		resolveInflight(EMPTY_PAGE);
		await flush();
		expect(getTableLoading('tbl:a9')).toBe(false);
		expect(getTablePage('tbl:a9')).toBeDefined();
	});
});
