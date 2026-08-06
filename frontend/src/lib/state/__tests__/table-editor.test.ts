import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as checkoutApi from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';
import * as tablesApi from '$lib/api/tables';
import type { FeedEvent } from '$lib/api/feed';
import type { ArtifactHeader } from '$lib/api/types';
import {
	closeTableDraft,
	ensureTableDraft,
	ensureTableRange,
	getTableDraft,
	getTableError,
	getTableLoading,
	getTableLockHolder,
	getTablePage,
	getTableSort,
	getTableWarnings,
	handleTableModelRevChanged,
	loadTablePage,
	reloadTableDraft,
	remapTableSortForMove,
	remapTableSortForRemove,
	resetTableEditors,
	retryTableLock,
	saveAsTableDraft,
	saveTableDraft,
	setTableName,
	setTableSort,
	updateTableDefinition
} from '../table-editor.svelte';
import { getDynamicTabs, openArtifactTab, resetWorkspaceTabs } from '../workspace.svelte';
import { loadArtifacts, resetArtifacts } from '../artifacts.svelte';
import {
	clearStagedArtifacts,
	getStagedArtifactOps,
	notifyArtifactCommit,
	resetArtifactEdits,
	revertStagedArtifact,
	stageArtifactDelete,
	stagedCreateSourceTab
} from '../artifact-edits.svelte';
import { isCheckedOutByMe, resetCheckout, setProjectInfo } from '../checkout.svelte';
// NB: `handleFeedEvent` only — never `resetRealtime` here, which would clear the
// module-load commit-tap table-editor registers and silently disarm the test.
import { handleFeedEvent } from '../realtime.svelte';
import { isTempId } from '../ops';

/** Flush the microtask/macrotask queue so a fire-and-forget `loadTablePage`
 * call (triggered by `updateTableDefinition`/`setTableSort`) has settled. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const EMPTY_PAGE = {
	columns: [],
	rows: [],
	total: 0,
	truncated: false,
	offset: 0,
	model_rev: 1,
	warnings: []
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
		model_rev,
		warnings: []
	};
}

function header(id: string, name: string, rev = 1, kind = 'table'): ArtifactHeader {
	return {
		id,
		kind,
		name,
		artifact_rev: rev,
		updated_at: '',
		updated_by: null,
		entry_points: null
	};
}

/** The saved table every `tbl:a1` test opens. */
function mockGetTable(id = 'a1', name = 'Sensors', rev = 4) {
	return vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
		...header(id, name, rev),
		payload: {
			schema_version: 1,
			default_cell_mode: 'collapse',
			row_source: { kind: 'scope', types: [], criteria: [] },
			columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '' }]
		}
	});
}

/** Mirror of the backend's lock canonicalization (see checkout.artifact.test.ts):
 * targets go out with the bare id + `type: "artifact"`, leases come back keyed
 * `art:<id>` under one token per call. */
function mockAcquire() {
	return vi.spyOn(checkoutApi, 'acquireLocks').mockImplementation(async (req) => {
		const token = `t_${req.targets[0].resource_id}`;
		return {
			token,
			leases: req.targets.map((t) => ({
				resource_id: t.type === 'artifact' ? `art:${t.resource_id}` : t.resource_id,
				mode: t.mode,
				holder: 'me',
				token,
				intent: req.intent,
				expires_at: 1
			}))
		};
	});
}

/** What POST /locks throws when a peer holds the artifact. */
function lockConflict(email: string): ConflictError {
	return new ConflictError(
		409,
		{
			conflicts: [
				{ resource_id: 'art:a1', held_by: 'u2', held_by_email: email, held_mode: 'exclusive' }
			]
		},
		'lock conflict'
	);
}

/** The temp id of the one staged `create_artifact` op in the buffer. */
function stagedTempId(): string {
	const op = getStagedArtifactOps().find((o) => o.kind === 'create_artifact');
	if (op?.kind !== 'create_artifact') throw new Error('no staged create in the buffer');
	return op.temp_id;
}

/** The checked-out-editor path: the default role after `resetCheckout` is
 * viewer, which short-circuits the lease open before any network call. */
function asEditor() {
	setProjectInfo({ role: 'editor', lockTtlSeconds: 100 });
}

beforeEach(() => {
	resetTableEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetArtifactEdits();
	resetCheckout();
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

	it('treats a TEMP-id tab as an unsaved draft rather than fetching it', async () => {
		// A save-as fork lives under `tbl:<tempId>`, which names nothing
		// server-side: `getArtifact('tmp_…')` would 404 and, since our only caller
		// is a fire-and-forget `$effect`, the rejection would strand the tab on
		// "Loading…" forever. The `tbl:draft:` prefix alone does not catch it.
		asEditor();
		const acquire = mockAcquire();
		const get = vi.spyOn(artifactsApi, 'getArtifact');
		const evaluate = vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);

		const draft = await ensureTableDraft('tbl:tmp_abc');

		expect(get).not.toHaveBeenCalled();
		expect(acquire).not.toHaveBeenCalled();
		expect(evaluate).not.toHaveBeenCalled();
		expect(draft.artifactId).toBeNull();
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
			entry_points: null,
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
		// getTablePage returns the store's sparse-cache TableData, which now
		// carries `warnings` straight from the TablePage response (see
		// installPage in table-editor.svelte.ts) — the raw EMPTY_PAGE fixture
		// already sets `warnings: []`, so the two now compare equal outright.
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
			entry_points: null,
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

	it('threads warnings from an installed page through getTableWarnings', async () => {
		const draft = await ensureTableDraft('tbl:draft:warn1'); // new drafts do not auto-load
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue({
			...EMPTY_PAGE,
			warnings: [{ code: 'nav_step_failed', occurrences: 3, total: 0, detail: 'script raised' }]
		});
		updateTableDefinition('tbl:draft:warn1', { ...draft.definition });
		await flush();
		expect(getTableWarnings('tbl:draft:warn1')).toEqual([
			{ code: 'nav_step_failed', occurrences: 3, total: 0, detail: 'script raised' }
		]);
	});

	it('returns an empty array from getTableWarnings when no page is installed or the page has none', async () => {
		expect(getTableWarnings('tbl:never-installed')).toEqual([]);
		const draft = await ensureTableDraft('tbl:draft:nowarn1'); // new drafts do not auto-load
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		updateTableDefinition('tbl:draft:nowarn1', { ...draft.definition });
		await flush();
		expect(getTableWarnings('tbl:draft:nowarn1')).toEqual([]);
	});

	it('mergePage (a lazy chunk fill) preserves the warnings installed by the reset load', async () => {
		const warning = { code: 'nav_step_failed', occurrences: 2, total: 0, detail: 'rows errored' };
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockResolvedValueOnce({ ...pageAt(0, 100, 250), warnings: [warning] })
			.mockImplementation(async (args) => pageAt(args.offset ?? 0, args.limit ?? 100, 250));
		await ensureTableDraft('tbl:draft:warnmerge');
		await loadTablePage('tbl:draft:warnmerge', 0);
		expect(getTableWarnings('tbl:draft:warnmerge')).toEqual([warning]);
		ensureTableRange('tbl:draft:warnmerge', 100, 150);
		await flush();
		// The chunk fill's own response carries no warnings (pageAt defaults to
		// []) — mergePage must not clobber the reset load's warnings with it.
		expect(getTableWarnings('tbl:draft:warnmerge')).toEqual([warning]);
		spy.mockRestore();
	});

	it('a failed load stores the error message', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockRejectedValue(new Error('boom'));
		await ensureTableDraft('tbl:draft:4');
		await loadTablePage('tbl:draft:4', 0);
		expect(getTableError('tbl:draft:4')).toBe('boom');
		expect(getTablePage('tbl:draft:4')).toBeUndefined();
	});

	it('saveTableDraft on an unsaved draft stages a create and binds the draft to the temp id', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const tabId = openArtifactTab('table', { artifactId: null, title: 'New table' });
		await ensureTableDraft(tabId);
		setTableName(tabId, 'Mine');
		const definition = getTableDraft(tabId)!.definition;

		await saveTableDraft(tabId);

		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'create_artifact',
				temp_id: expect.stringMatching(/^tmp_/),
				artifact_kind: 'table',
				name: 'Mine',
				payload: definition
			}
		]);
		const draft = getTableDraft(tabId)!;
		expect(isTempId(draft.artifactId!)).toBe(true);
		expect(draft.dirty).toBe(false);
		// The tab KEY is NOT re-keyed at stage time: it keeps living under
		// tbl:draft:N until the commit's id_map supplies a canonical id. The tab
		// RECORD does follow the draft onto the temp id.
		expect(getDynamicTabs()[0].id).toBe(tabId);
		expect(getDynamicTabs()[0].artifactId).toBe(draft.artifactId);
	});

	it('re-saving a staged create folds back into the create op', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const tabId = openArtifactTab('table', { artifactId: null, title: 'New table' });
		const draft = await ensureTableDraft(tabId);
		setTableName(tabId, 'Mine');
		await saveTableDraft(tabId);
		const tempId = getTableDraft(tabId)!.artifactId!;
		const edited = {
			...draft.definition,
			row_source: { kind: 'scope' as const, types: ['Sensor'], criteria: [] }
		};
		updateTableDefinition(tabId, edited);
		setTableName(tabId, 'Renamed');
		await flush();

		await saveTableDraft(tabId);

		// Still ONE op, still a create: the backend resolves update_artifact ids
		// literally, so a create+update pair for the same temp id would 422.
		expect(getStagedArtifactOps()).toEqual([
			{
				kind: 'create_artifact',
				temp_id: tempId,
				artifact_kind: 'table',
				name: 'Renamed',
				payload: edited
			}
		]);
		expect(getTableDraft(tabId)?.artifactId).toBe(tempId); // no second temp id minted
		expect(getTableDraft(tabId)?.dirty).toBe(false);
	});

	it('saveTableDraft on a saved artifact stages a full-payload update', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const draft = await ensureTableDraft('tbl:a1');
		const edited = {
			...draft.definition,
			row_source: { kind: 'scope' as const, types: ['Sensor'], criteria: [] }
		};
		updateTableDefinition('tbl:a1', edited);
		await flush();

		await saveTableDraft('tbl:a1');

		expect(getStagedArtifactOps()).toEqual([
			{ kind: 'update_artifact', id: 'a1', name: 'Sensors', payload: edited }
		]);
		expect(getTableDraft('tbl:a1')?.dirty).toBe(false);
		expect(getTableDraft('tbl:a1')?.artifactId).toBe('a1');
	});

	it('re-saving coalesces into one staged op carrying the latest payload', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const draft = await ensureTableDraft('tbl:a1');
		const first = {
			...draft.definition,
			row_source: { kind: 'scope' as const, types: ['First'], criteria: [] }
		};
		updateTableDefinition('tbl:a1', first);
		await flush();
		await saveTableDraft('tbl:a1');
		const second = {
			...draft.definition,
			row_source: { kind: 'scope' as const, types: ['Second'], criteria: [] }
		};
		updateTableDefinition('tbl:a1', second);
		await flush();
		await saveTableDraft('tbl:a1');

		expect(getStagedArtifactOps()).toEqual([
			{ kind: 'update_artifact', id: 'a1', name: 'Sensors', payload: second }
		]);
	});

	it('saveTableDraft refuses a name another table already uses', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [header('a2', 'Taken')] });
		await loadArtifacts();
		const tabId = openArtifactTab('table', { artifactId: null, title: 'New table' });
		await ensureTableDraft(tabId);
		setTableName(tabId, 'Taken');

		await expect(saveTableDraft(tabId)).rejects.toThrow(/named "Taken" already exists/);
		// Nothing staged, and the draft is untouched (still unsaved + dirty).
		expect(getStagedArtifactOps()).toEqual([]);
		expect(getTableDraft(tabId)?.artifactId).toBeNull();
		expect(getTableDraft(tabId)?.dirty).toBe(true);
	});

	it('evaluates the INLINE definition while a save is staged but uncommitted', async () => {
		// A staged save has not reached the server: evaluating by artifactId would
		// re-read the OLD payload and show the user a table they stopped editing.
		asEditor();
		mockAcquire();
		mockGetTable();
		const spy = vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const draft = await ensureTableDraft('tbl:a1');
		// pristine + nothing staged: evaluate by artifactId (backend cache reuse)
		expect(spy.mock.calls.at(-1)![0]).toMatchObject({ artifactId: 'a1' });
		const edited = {
			...draft.definition,
			row_source: { kind: 'scope' as const, types: ['Sensor'], criteria: [] }
		};
		updateTableDefinition('tbl:a1', edited);
		await flush();

		await saveTableDraft('tbl:a1');
		expect(getTableDraft('tbl:a1')?.dirty).toBe(false); // clean, but uncommitted

		spy.mockClear();
		await loadTablePage('tbl:a1', 0);
		const staged = spy.mock.calls.at(-1)![0];
		expect('artifactId' in staged).toBe(false);
		expect(staged.definition).toEqual(edited);

		// Once the commit lands (and the buffer is cleared) the server head IS the
		// draft again, so the per-artifact order cache is worth using once more.
		clearStagedArtifacts(); // `commitStaged` clears BEFORE it notifies
		notifyArtifactCommit({ idMap: {}, changed: [header('a1', 'Sensors', 5)], deletedIds: [] });
		spy.mockClear();
		await loadTablePage('tbl:a1', 0);
		expect(spy.mock.calls.at(-1)![0]).toMatchObject({ artifactId: 'a1' });
	});

	it('reloadTableDraft drops local state and re-fetches the server copy', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'table',
			name: 'Sensors',
			artifact_rev: 4,
			updated_at: '',
			updated_by: null,
			entry_points: null,
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
		// closeTableDraft touches every per-tab map — all of them must be cleared.
		expect(getTableDraft('tbl:draft:7')).toBeUndefined();
		expect(getTablePage('tbl:draft:7')).toBeUndefined();
		expect(getTableSort('tbl:draft:7')).toBeUndefined();
		expect(getTableLoading('tbl:draft:7')).toBe(false);
		expect(getTableError('tbl:draft:7')).toBeUndefined();
		expect(getTableLockHolder('tbl:draft:7')).toBeNull();
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

	it('a commit landing while a load is in flight does not strand the rebound tab on loading', async () => {
		// Hold the first evaluate open, resolve the re-issued one immediately.
		let resolveInflight!: (v: typeof EMPTY_PAGE) => void;
		const inflightPage = new Promise<typeof EMPTY_PAGE>((res) => (resolveInflight = res));
		const evaluate = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockImplementationOnce(() => inflightPage)
			.mockResolvedValue(EMPTY_PAGE);

		const tabId = openArtifactTab('table', { artifactId: null, title: 'New table' });
		const draft = await ensureTableDraft(tabId); // new drafts do not auto-load
		await saveTableDraft(tabId); // stages the create; the tab is NOT re-keyed yet
		const tempId = getTableDraft(tabId)!.artifactId!;
		// Kick a load and leave it unresolved (updateTableDefinition fires it).
		updateTableDefinition(tabId, { ...draft.definition });
		expect(getTableLoading(tabId)).toBe(true);

		// The commit rebinds the tab mid-flight: the old key is retired.
		notifyArtifactCommit({
			idMap: { [tempId]: 'a9' },
			changed: [header('a9', 'New table', 1)],
			deletedIds: []
		});

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

	it('a peer commit re-pages open tables only when it touched model content', async () => {
		const commit = (scope: string[]): FeedEvent => ({
			type: 'commit',
			rev: scope.length, // any forward rev; the reducer adopts it either way
			commit_id: 'c',
			author_id: 'peer',
			message: 'm',
			validation_error_count: 0,
			changed_elements: [],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			scope
		});

		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockImplementation(async (args) => pageAt(args.offset ?? 0, args.limit ?? 100, 1000));
		await ensureTableDraft('tbl:draft:11');
		await loadTablePage('tbl:draft:11', 0);
		await flush();
		spy.mockClear();

		// Artifact-only: no model content changed and no server-side evaluation
		// cache was invalidated, so re-paging every open table is pure waste.
		handleFeedEvent(commit(['artifact']));
		await flush();
		expect(spy).not.toHaveBeenCalled();

		handleFeedEvent(commit(['model', 'artifact']));
		await flush();
		expect(spy).toHaveBeenCalledTimes(1);
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
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		let resolveInflight!: (v: typeof EMPTY_PAGE) => void;
		const inflightPage = new Promise<typeof EMPTY_PAGE>((res) => (resolveInflight = res));
		vi.spyOn(tablesApi, 'evaluateTable')
			.mockResolvedValueOnce(EMPTY_PAGE) // ensureTableDraft's first page
			.mockImplementationOnce(() => inflightPage) // the edit's in-flight load
			.mockResolvedValue(EMPTY_PAGE); // the re-issued load

		const draft = await ensureTableDraft('tbl:a1');
		updateTableDefinition('tbl:a1', { ...draft.definition });
		expect(getTableLoading('tbl:a1')).toBe(true);
		await saveAsTableDraft('tbl:a1', 'Copy');
		const forkTab = `tbl:${stagedTempId()}`;
		resolveInflight(EMPTY_PAGE);
		await flush();
		expect(getTableLoading(forkTab)).toBe(false);
		expect(getTablePage(forkTab)).toBeDefined();
	});
});

describe('artifact lease on open', () => {
	it('acquires the art: lease before fetching the payload', async () => {
		asEditor();
		const acquire = mockAcquire();
		const get = mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);

		await ensureTableDraft('tbl:a1');

		expect(acquire.mock.calls[0][0]).toMatchObject({
			targets: [{ resource_id: 'a1', mode: 'exclusive', type: 'artifact' }],
			intent: 'edit'
		});
		// The lease is taken FIRST: showing an editable surface we may not own is
		// the failure mode the check-out is there to prevent.
		expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
		expect(get).toHaveBeenCalledWith('a1');
		expect(isCheckedOutByMe('art:a1')).toBe(true);
		expect(getTableLockHolder('tbl:a1')).toBeNull();
	});

	it('marks the tab lock-denied (unsaveable) when the lease is refused, but still loads it', async () => {
		asEditor();
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(lockConflict('peer@x'));
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);

		const draft = await ensureTableDraft('tbl:a1');

		expect(getTableLockHolder('tbl:a1')).toBe('peer@x');
		// A denial must not refuse the tab — it opens unsaveable with the banner.
		expect(draft.name).toBe('Sensors');
		expect(getTablePage('tbl:a1')).toBeDefined();
	});

	it('fails OPEN when POST /locks errors for a non-conflict reason', async () => {
		asEditor();
		// ensureCheckout rethrows anything that is not a ConflictError; if that
		// escaped ensureTableDraft the tab would sit on "Loading…" forever (its
		// caller is a fire-and-forget $effect).
		vi.spyOn(checkoutApi, 'acquireLocks').mockRejectedValue(new Error('boom'));
		const get = mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);

		const draft = await ensureTableDraft('tbl:a1');

		expect(get).toHaveBeenCalledWith('a1');
		expect(draft.name).toBe('Sensors');
		// No banner: an infrastructure error is not a peer holding the artifact.
		expect(getTableLockHolder('tbl:a1')).toBeNull();
	});

	it('shows no banner to a viewer (the whole workspace is already read-only)', async () => {
		const acquire = mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);

		await ensureTableDraft('tbl:a1'); // role is viewer (resetCheckout default)

		expect(acquire).not.toHaveBeenCalled();
		expect(getTableLockHolder('tbl:a1')).toBeNull();
		expect(getTableDraft('tbl:a1')).toBeDefined();
	});

	it('retryTableLock clears the banner once the peer releases', async () => {
		asEditor();
		const acquire = mockAcquire();
		acquire.mockRejectedValueOnce(lockConflict('peer@x'));
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:a1');
		expect(getTableLockHolder('tbl:a1')).toBe('peer@x');

		await retryTableLock('tbl:a1');

		expect(getTableLockHolder('tbl:a1')).toBeNull();
		expect(isCheckedOutByMe('art:a1')).toBe(true);
	});

	it('retryTableLock is a no-op for an unsaved (temp-id) draft', async () => {
		asEditor();
		const acquire = mockAcquire();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const tabId = openArtifactTab('table', { artifactId: null, title: 'New table' });
		await ensureTableDraft(tabId);
		await saveTableDraft(tabId); // draft.artifactId is now a temp id

		await retryTableLock(tabId);

		expect(acquire).not.toHaveBeenCalled();
	});

	it('closeTableDraft releases the lease when nothing staged needs it', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		await ensureTableDraft('tbl:a1');

		closeTableDraft('tbl:a1');
		await Promise.resolve();

		expect(release).toHaveBeenCalledWith('t_a1', undefined);
		expect(isCheckedOutByMe('art:a1')).toBe(false);
		expect(getTableLockHolder('tbl:a1')).toBeNull();
	});

	it('closeTableDraft keeps the lease while a staged op still needs it', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:a1');
		await saveTableDraft('tbl:a1'); // stages update_artifact a1 — the commit needs the lease
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);

		closeTableDraft('tbl:a1');
		await Promise.resolve();

		expect(release).not.toHaveBeenCalled();
		expect(isCheckedOutByMe('art:a1')).toBe(true);
	});
});

describe('saveAsTableDraft', () => {
	it('stages a fresh create, retitles and re-keys the tab, and leaves the original untouched', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const release = vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('table', { artifactId: 'a1', title: 'Sensors' });
		const draft = await ensureTableDraft('tbl:a1');

		await saveAsTableDraft('tbl:a1', 'Copy');

		// The original artifact is never touched: the staged batch holds the
		// fork's create and nothing else — no update op against `a1`.
		const ops = getStagedArtifactOps();
		expect(ops).toEqual([
			{
				kind: 'create_artifact',
				temp_id: expect.stringMatching(/^tmp_/),
				artifact_kind: 'table',
				name: 'Copy',
				payload: draft.definition
			}
		]);
		// The fork tab is re-keyed to tbl:<tempId> AT STAGE TIME (unlike a create
		// staged from a tbl:draft:N tab): a bound tab's key must always be
		// `tbl:<its own artifactId>`, or reopening the original would mint a
		// SECOND record with the id this tab still holds.
		const tempId = stagedTempId();
		expect(getDynamicTabs()).toHaveLength(1);
		expect(getDynamicTabs()[0].id).toBe(`tbl:${tempId}`);
		expect(getDynamicTabs()[0].title).toBe('Copy');
		expect(getDynamicTabs()[0].artifactId).toBe(tempId);
		expect(getTableDraft('tbl:a1')).toBeUndefined();
		const forked = getTableDraft(`tbl:${tempId}`)!;
		expect(forked.name).toBe('Copy');
		expect(forked.artifactId).toBe(tempId);
		expect(forked.artifactRev).toBeNull();
		expect(forked.dirty).toBe(false);
		// The original's lease is no longer needed by anything staged: released.
		expect(release).toHaveBeenCalledWith('t_a1', undefined);
		expect(isCheckedOutByMe('art:a1')).toBe(false);
	});

	it('frees the original artifact to reopen in its OWN tab with its own draft', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('table', { artifactId: 'a1', title: 'Sensors' });
		await ensureTableDraft('tbl:a1');

		await saveAsTableDraft('tbl:a1', 'Copy');
		const reopened = openArtifactTab('table', { artifactId: 'a1', title: 'Sensors' }); // sidebar click

		// Two tabs with DISTINCT ids — a duplicate id would blow up Workspace's
		// keyed {#each} over tab.id (each_key_duplicate), and there is no
		// <svelte:boundary> to catch it.
		const tabs = getDynamicTabs();
		expect(tabs).toHaveLength(2);
		expect(new Set(tabs.map((t) => t.id)).size).toBe(2);
		expect(reopened).toBe('tbl:a1');
		// …and the reopened tab really serves the ORIGINAL, not the fork's draft
		// (ensureTableDraft early-returns an existing draft under the same key).
		const original = await ensureTableDraft(reopened);
		expect(original.artifactId).toBe('a1');
		expect(original.name).toBe('Sensors');
	});

	it('carries the tab’s per-tab state onto the fork’s new tab key', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(pageAt(0, 100, 250));
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('table', { artifactId: 'a1', title: 'Sensors' });
		await ensureTableDraft('tbl:a1');
		setTableSort('tbl:a1', { column: 0, direction: 'asc' });
		await flush();
		expect(getTablePage('tbl:a1')?.total).toBe(250);

		await saveAsTableDraft('tbl:a1', 'Copy');

		const forkTab = `tbl:${stagedTempId()}`;
		expect(getTablePage(forkTab)?.total).toBe(250);
		expect(getTableSort(forkTab)).toEqual({ column: 0, direction: 'asc' });
		// The retired key keeps nothing (or a reopened original would inherit it).
		expect(getTablePage('tbl:a1')).toBeUndefined();
		expect(getTableSort('tbl:a1')).toBeUndefined();
	});

	it('records the POST-re-key tab as the staged create’s source', async () => {
		// The entry has to be minted before the fork's key can be computed, so its
		// sourceTabId starts out naming the tab that is about to be retired — and,
		// once the original is reopened, a DIFFERENT tab entirely.
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('table', { artifactId: 'a1', title: 'Sensors' });
		await ensureTableDraft('tbl:a1');

		await saveAsTableDraft('tbl:a1', 'Copy');

		const tempId = stagedTempId();
		expect(stagedCreateSourceTab(tempId)).toBe(`tbl:${tempId}`);
		// And that tab really is the one on screen.
		expect(getDynamicTabs().map((t) => t.id)).toContain(stagedCreateSourceTab(tempId));
	});

	it('refuses a name another table already uses', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [header('a2', 'Taken')] });
		await loadArtifacts();
		await ensureTableDraft('tbl:a1');

		await expect(saveAsTableDraft('tbl:a1', 'Taken')).rejects.toThrow(
			/named "Taken" already exists/
		);
		expect(getStagedArtifactOps()).toEqual([]);
		// The original tab/draft is left exactly as it was (untouched).
		expect(getTableDraft('tbl:a1')?.artifactId).toBe('a1');
		expect(getTableDraft('tbl:a1')?.name).toBe('Sensors');
	});
});

describe('staged-artifact listeners', () => {
	it('a commit rebinds a temp draft to its canonical id, carrying per-tab state', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(pageAt(0, 100, 250));
		const tabId = openArtifactTab('table', { artifactId: null, title: 'New table' });
		const draft = await ensureTableDraft(tabId);
		updateTableDefinition(tabId, { ...draft.definition });
		await flush();
		setTableSort(tabId, { column: 0, direction: 'asc' });
		await flush();
		setTableName(tabId, 'Mine');
		await saveTableDraft(tabId);
		const tempId = getTableDraft(tabId)!.artifactId!;

		notifyArtifactCommit({
			idMap: { [tempId]: 'a9' },
			changed: [header('a9', 'Mine', 7)],
			deletedIds: []
		});

		expect(getTableDraft(tabId)).toBeUndefined();
		const bound = getTableDraft('tbl:a9')!;
		expect(bound.artifactId).toBe('a9');
		expect(bound.artifactRev).toBe(7);
		expect(getDynamicTabs()[0].id).toBe('tbl:a9');
		expect(getDynamicTabs()[0].artifactId).toBe('a9');
		// Per-tab state follows the rebind, as it used to on first save.
		expect(getTablePage('tbl:a9')?.total).toBe(250);
		expect(getTableSort('tbl:a9')).toEqual({ column: 0, direction: 'asc' });
		expect(getTablePage(tabId)).toBeUndefined();
	});

	it('a commit adopts the new artifact_rev on an already-saved draft', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:a1');
		expect(getTableDraft('tbl:a1')?.artifactRev).toBe(4);

		notifyArtifactCommit({ idMap: {}, changed: [header('a1', 'Sensors', 9)], deletedIds: [] });

		expect(getTableDraft('tbl:a1')?.artifactRev).toBe(9);
		expect(getTableDraft('tbl:a1')?.artifactId).toBe('a1');
	});

	it('a committed delete closes the artifact’s open tab', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('table', { artifactId: 'a1', title: 'Sensors' });
		await ensureTableDraft('tbl:a1');

		notifyArtifactCommit({ idMap: {}, changed: [], deletedIds: ['a1'] });

		expect(getTableDraft('tbl:a1')).toBeUndefined();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('a staged delete closes the artifact’s open tab immediately', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('table', { artifactId: 'a1', title: 'Sensors' });
		await ensureTableDraft('tbl:a1');

		stageArtifactDelete('a1', header('a1', 'Sensors', 4));

		expect(getTableDraft('tbl:a1')).toBeUndefined();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('discarding a staged update re-dirties the draft', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		await ensureTableDraft('tbl:a1');
		await saveTableDraft('tbl:a1');
		expect(getTableDraft('tbl:a1')?.dirty).toBe(false);

		revertStagedArtifact('a1');

		expect(getTableDraft('tbl:a1')?.dirty).toBe(true);
		expect(getTableDraft('tbl:a1')?.artifactId).toBe('a1');
	});

	it('discarding a staged create unbinds the draft back to unsaved', async () => {
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		const tabId = openArtifactTab('table', { artifactId: null, title: 'New table' });
		await ensureTableDraft(tabId);
		setTableName(tabId, 'Mine');
		await saveTableDraft(tabId);
		const tempId = getTableDraft(tabId)!.artifactId!;

		revertStagedArtifact(tempId);

		const draft = getTableDraft(tabId)!;
		expect(draft.artifactId).toBeNull();
		expect(draft.artifactRev).toBeNull();
		expect(draft.dirty).toBe(true);
		// The tab was never re-keyed, so it is still the draft tab it started as —
		// and its record unbinds with the draft (the temp id will never exist).
		expect(getDynamicTabs()[0].id).toBe(tabId);
		expect(getDynamicTabs()[0].artifactId).toBeNull();
	});

	it('discarding a save-as fork leaves an unbound tab that cannot collide', async () => {
		asEditor();
		mockAcquire();
		mockGetTable();
		vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
		vi.spyOn(checkoutApi, 'releaseLock').mockResolvedValue(undefined);
		openArtifactTab('table', { artifactId: 'a1', title: 'Sensors' });
		await ensureTableDraft('tbl:a1');
		await saveAsTableDraft('tbl:a1', 'Copy');
		const tempId = stagedTempId();

		revertStagedArtifact(tempId);

		// The fork stays where it is, as an unbound (unsaved) draft named Copy.
		const forkTab = `tbl:${tempId}`;
		expect(getTableDraft(forkTab)?.artifactId).toBeNull();
		expect(getTableDraft(forkTab)?.name).toBe('Copy');
		expect(getTableDraft(forkTab)?.dirty).toBe(true);
		expect(getDynamicTabs()[0].id).toBe(forkTab);
		expect(getDynamicTabs()[0].artifactId).toBeNull();
		// Its key holds a client-minted `tmp_` id, which no artifact id can ever
		// equal — so reopening the original still gets a DISTINCT tab.
		openArtifactTab('table', { artifactId: 'a1', title: 'Sensors' });
		const tabs = getDynamicTabs();
		expect(tabs).toHaveLength(2);
		expect(new Set(tabs.map((t) => t.id)).size).toBe(2);
	});
});
