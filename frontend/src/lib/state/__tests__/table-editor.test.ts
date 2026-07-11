import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import * as tablesApi from '$lib/api/tables';
import {
	closeTableDraft,
	ensureTableDraft,
	getTableConflict,
	getTableDraft,
	getTableError,
	getTableLoading,
	getTablePage,
	getTableSort,
	handleTableModelRevChanged,
	loadTablePage,
	reloadTableDraft,
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
	it('ensureTableDraft creates an empty draft for a draft tab', async () => {
		await ensureTableDraft('tbl:draft:1');
		const d = getTableDraft('tbl:draft:1');
		expect(d?.artifactId).toBeNull();
		expect(d?.definition.columns.length).toBeGreaterThanOrEqual(1);
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
		const draft = await ensureTableDraft('tbl:draft:3');
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

	it('a failed load stores the error message', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockRejectedValue(new Error('boom'));
		await ensureTableDraft('tbl:draft:4');
		await loadTablePage('tbl:draft:4', 0);
		expect(getTableError('tbl:draft:4')).toBe('boom');
		expect(getTablePage('tbl:draft:4')).toBeUndefined();
	});

	it('first save creates the artifact and rebinds the draft under tbl:<id>', async () => {
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
		const draft = await ensureTableDraft('tbl:draft:8');
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

		const draft = await ensureTableDraft('tbl:draft:9');
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

	it('handleTableModelRevChanged re-runs evaluateTable for every open table tab at its current offset', async () => {
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockResolvedValue({ ...EMPTY_PAGE, offset: 40 });
		await ensureTableDraft('tbl:draft:10');
		await loadTablePage('tbl:draft:10', 40);
		spy.mockClear();

		handleTableModelRevChanged();
		await flush();

		expect(spy).toHaveBeenCalledTimes(1);
		const lastCall = spy.mock.calls.at(-1)![0];
		expect(lastCall.offset ?? 0).toBe(40);
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
