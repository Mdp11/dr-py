// Open tables follow the replica's staged state: a `changed` that moves the
// working copy's rev, its staged version or the artifacts re-pages every open,
// evaluated tab once the edits pause, in the background, keeping its rows. The
// real engine answers through an in-process link; no fake timers.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '$lib/api/__tests__/server';
import type { FeedEvent } from '$lib/api/feed';
import { errorForStatus } from '$lib/api/errors';
import { getElementsBatch } from '$lib/api/model-read';
import * as tablesApi from '$lib/api/tables';
import { TableDefinitionSchema, type TableDefinition, type TablePage } from '$lib/api/types';
import type { ChangedEvent } from '$lib/engine/sync';
import { PAGE_ORIGIN, fakeProject } from '$lib/engine/__tests__/support/project-server';
import {
	resetArtifactEdits,
	stageArtifactDelete,
	stageArtifactUpdate
} from '../artifact-edits.svelte';
import { cancelIssuesRefetch, emit, ensureElements } from '../model.svelte';
import { handleFeedEvent } from '../realtime.svelte';
import { getReplicaStatus, handReplicaFeed, onTablesMoved } from '../replica.svelte';
import {
	ensureTableDraft,
	ensureTableRange,
	flushTablesRepage,
	getTableError,
	getTableLoading,
	getTablePage,
	loadTablePage,
	resetTableEditors,
	resumeTableEvaluation,
	revertSuspendedTableEdits,
	suspendTableEvaluation,
	updateTableDefinition
} from '../table-editor.svelte';
import {
	engineStore,
	rename,
	settled,
	withWrongDigest,
	type EngineStore
} from './support/engine-store';

const API = `${PAGE_ORIGIN}/api/v1/projects/p`;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let store: EngineStore | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
	resetTableEditors();
	resetArtifactEdits();
	// An issues refetch still out would find the engine gone and ask a server no longer there.
	cancelIssuesRefetch();
	await sleep(50);
	store?.dispose();
	store = null;
	cancelIssuesRefetch();
	vi.restoreAllMocks();
});

const real = tablesApi.evaluateTable;
type Args = Parameters<typeof real>[0];

/** Every `Person` (160 of them, in id order): the element and its `name`. */
const PEOPLE: TableDefinition = TableDefinitionSchema.parse({
	row_source: { kind: 'scope', types: ['Person'], criteria: [] },
	columns: [
		{ kind: 'element', source: { kind: 'row', chain_index: 0 } },
		{ kind: 'property', source: { kind: 'row', chain_index: 0 }, name: 'name' }
	]
});

type Started = {
	s: EngineStore;
	/** Every `changed` the sync heard since the start, with when it came. */
	changes: { event: ChangedEvent; at: number }[];
};

/**
 * The engine store, quiet: swept, its artifacts loaded and
 * any re-page their events scheduled spent, before a table is opened.
 */
async function start(
	options: {
		artifacts?: [string, object][];
		/** The follower's artifact load is answered only once this resolves; the start does not wait for it. */
		holdPayloads?: Promise<void>;
	} = {}
): Promise<Started> {
	const project = fakeProject();
	for (const [id, artifact] of options.artifacts ?? [])
		project.artifacts.set(id, artifact as never);
	const held = options.holdPayloads;
	if (held !== undefined) {
		const handlers = project.handlers.bind(project);
		// Answers nothing itself: once `held` resolves the request falls through to the project's route.
		project.handlers = (handlerOptions) => [
			http.get(`${API}/artifacts/payloads`, async () => {
				await held;
			}),
			...handlers(handlerOptions)
		];
	}
	server.use(
		http.get(`${API}/model/issues`, () => HttpResponse.json({ model_rev: 0, issues: [] }))
	);
	store = await engineStore({ project });
	const s = store;
	const changes: Started['changes'] = [];
	s.sync.on('changed', (event) => void changes.push({ event, at: Date.now() }));
	if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
	// A read is answered once the artifacts have loaded.
	if (held === undefined) await getElementsBatch(['e_000001']);
	await sleep(350);
	return { s, changes };
}

/** Opens `tab` over `definition` and waits for its first page. */
async function open(tab: string, definition: TableDefinition = PEOPLE): Promise<void> {
	await ensureTableDraft(tab);
	updateTableDefinition(tab, definition);
	await vi.waitFor(() => {
		expect(getTablePage(tab)).toBeDefined();
		expect(getTableLoading(tab)).toBe(false);
	});
}

/** A spy on the store's evaluate calls that answers through the real route. */
function spyEvaluate() {
	return vi.spyOn(tablesApi, 'evaluateTable').mockImplementation((args) => real(args));
}

/** The `name` cell's value in row `index` of `tab`'s page. */
function nameAt(tab: string, index: number): unknown {
	const cell = getTablePage(tab)?.rows[index]?.cells[1];
	return cell?.kind === 'value' ? cell.value : undefined;
}

/** The element id row `index` of the table holds, as the engine orders it. */
async function idAt(index: number): Promise<string> {
	const page = await real({ definition: PEOPLE, offset: index, limit: 1 });
	return page.rows[0]!.key[0] as string;
}

/** Stages a rename of `id` and waits for the engine's `changed` that carries it. */
async function stageRename(s: EngineStore, id: string, name: string): Promise<void> {
	await ensureElements([id]);
	emit(rename(id, name));
	await settled(s);
}

describe('a staged edit re-pages the open tables', () => {
	it('once, only once its debounce timer fires, showing the staged value', async () => {
		const { s, changes } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		expect(getTablePage('tbl:draft:1')!.rows[0]!.key[0]).toBe(first);
		const asked: { at: number; args: Args }[] = [];
		vi.spyOn(tablesApi, 'evaluateTable').mockImplementation((args) => {
			asked.push({ at: Date.now(), args });
			return real(args);
		});
		const from = changes.length;

		await stageRename(s, first, 'staged once');

		// The timer is armed (the change already landed) but has not fired: no
		// re-page is asked yet — the actual proof the wait is debounced, not a
		// timestamp comparison that a synchronous re-page would pass too.
		expect(asked).toHaveLength(0);
		await flushTablesRepage();
		expect(asked).toHaveLength(1);
		expect(asked[0]!.args).toMatchObject({ definition: PEOPLE, offset: 0, limit: 100 });

		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('staged once'));
		const moved = changes.slice(from).filter(({ event }) => event.staged_version > 0);
		expect(moved.length).toBeGreaterThan(0);
		// No later debounce sneaks in a second re-page.
		await flushTablesRepage();
		expect(asked).toHaveLength(1);
		expect(getTableError('tbl:draft:1')).toBeNull();
	});

	it('three edits within the window re-page once, with the last', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		const spy = spyEvaluate();

		await stageRename(s, first, 'one');
		await stageRename(s, first, 'two');
		await stageRename(s, first, 'three');

		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('three'));
		// No later debounce sneaks in a second re-page.
		await flushTablesRepage();
		expect(spy).toHaveBeenCalledOnce();
	});

	it('keeps the rows installed while the re-page runs, and replaces them at install', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		const before = getTablePage('tbl:draft:1')!;
		const seen: { same: boolean; loaded: number; loading: boolean }[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const spy = vi.spyOn(tablesApi, 'evaluateTable').mockImplementation(async (args) => {
			const page = await real(args);
			await held;
			return page;
		});

		await stageRename(s, first, 'staged');
		await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
		for (let i = 0; i < 5; i++) {
			const now = getTablePage('tbl:draft:1');
			seen.push({
				same: now === before,
				loaded: now?.rows.filter((row) => row !== undefined).length ?? 0,
				loading: getTableLoading('tbl:draft:1')
			});
			await sleep(20);
		}
		expect(seen.every((at) => at.same && at.loaded === 100 && at.loading)).toBe(true);
		expect(nameAt('tbl:draft:1', 0)).not.toBe('staged');

		release();
		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('staged'));
		const after = getTablePage('tbl:draft:1')!;
		expect(after).not.toBe(before);
		expect(after.rows.filter((row) => row !== undefined)).toHaveLength(100);
		expect(getTableLoading('tbl:draft:1')).toBe(false);
	});

	it('drops a chunk asked before the change and answered after it, though its total is equal', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const target = await idAt(120);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let chunk: TablePage | null = null;
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockImplementationOnce(async (args) => {
				chunk = await real(args);
				await held;
				return chunk;
			})
			.mockImplementation((args) => real(args));

		ensureTableRange('tbl:draft:1', 100, 150);
		await vi.waitFor(() => expect(chunk).not.toBeNull());
		expect(spy.mock.calls[0]![0]).toMatchObject({ offset: 100, limit: 100 });
		const asked = chunk as unknown as TablePage;
		const page = getTablePage('tbl:draft:1')!;
		expect([asked.total, asked.model_rev]).toEqual([page.total, page.model_rev]);

		await stageRename(s, target, 'staged');
		release();
		await sleep(0);
		await sleep(0);

		// Answered after the change: its pre-change rows never reach the grid.
		expect(getTablePage('tbl:draft:1')!.rows[120]).toBeUndefined();
		// The grid asks nothing more of the stale page until the re-page lands.
		ensureTableRange('tbl:draft:1', 100, 150);
		expect(spy).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 120)).toBe('staged'));
		expect(spy.mock.calls[1]![0]).toMatchObject({ offset: 100, limit: 100 });
	});

	it('a re-page that fails transiently keeps the page, sets no error and is retried', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		const before = getTablePage('tbl:draft:1');
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockImplementation((args) => real(args));

		await stageRename(s, first, 'staged');
		await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(getTableLoading('tbl:draft:1')).toBe(false));
		expect(getTablePage('tbl:draft:1')).toBe(before);
		expect(getTableError('tbl:draft:1')).toBeNull();

		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('staged'), { timeout: 5000 });
		expect(spy).toHaveBeenCalledTimes(2);
		expect(getTableError('tbl:draft:1')).toBeNull();
	});

	it('a retry that comes due while the settings dialog is open waits for its resume', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockImplementation((args) => real(args));

		await stageRename(s, first, 'staged');
		await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(getTableLoading('tbl:draft:1')).toBe(false));
		// The dialog opens and composes an edit before the retry comes due.
		suspendTableEvaluation('tbl:draft:1');
		updateTableDefinition('tbl:draft:1', { ...PEOPLE, sort: [{ column: 1, direction: 'desc' }] });
		await sleep(2500);
		expect(spy).toHaveBeenCalledOnce();

		// Cancelled: the definition is the one before, and the owed refresh runs.
		revertSuspendedTableEdits('tbl:draft:1');
		resumeTableEvaluation('tbl:draft:1');
		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('staged'));
		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy.mock.calls[1]![0]).toMatchObject({ definition: PEOPLE });
		expect(spy.mock.calls[1]![0].definition?.sort ?? []).toEqual([]);
		expect(getTableError('tbl:draft:1')).toBeNull();
	});

	it('a re-page that keeps failing shows the last failure once its retries are spent', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		const before = getTablePage('tbl:draft:1');
		let failures = 0;
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockImplementation(() => Promise.reject(new TypeError(`failure ${++failures}`)));

		await stageRename(s, first, 'staged');
		await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(getTableLoading('tbl:draft:1')).toBe(false));
		expect(getTableError('tbl:draft:1')).toBeNull();

		await vi.waitFor(
			() => expect(getTableError('tbl:draft:1')).toEqual({ kind: 'error', message: 'failure 4' }),
			{
				timeout: 15000
			}
		);
		expect(spy).toHaveBeenCalledTimes(4);
		expect(getTablePage('tbl:draft:1')).toBe(before);
		expect(getTableLoading('tbl:draft:1')).toBe(false);
	}, 20000);

	it('a failure replaces an older error message rather than keeping it', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockRejectedValueOnce(errorForStatus(422, { detail: 'first refusal' }, 'first refusal'))
			.mockRejectedValueOnce(new TypeError('second failure'))
			.mockImplementation((args) => real(args));
		await loadTablePage('tbl:draft:1', 0);
		expect(getTableError('tbl:draft:1')).toEqual({ kind: 'error', message: 'first refusal' });

		await stageRename(s, first, 'staged');

		await vi.waitFor(() =>
			expect(getTableError('tbl:draft:1')).toEqual({ kind: 'error', message: 'second failure' })
		);
		// Retried, the re-page lands and takes the error with it.
		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('staged'), { timeout: 5000 });
		expect(getTableError('tbl:draft:1')).toBeNull();
		expect(spy).toHaveBeenCalledTimes(3);
	});

	it('a re-page that supersedes a definition edit still out reports its failure', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		const before = getTablePage('tbl:draft:1');
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockImplementationOnce(() => new Promise<TablePage>(() => {}))
			.mockRejectedValueOnce(new Error('the edited table is refused'));

		updateTableDefinition('tbl:draft:1', { ...PEOPLE, sort: [{ column: 1, direction: 'desc' }] });
		await stageRename(s, first, 'staged');

		await vi.waitFor(() =>
			expect(getTableError('tbl:draft:1')).toEqual({
				kind: 'error',
				message: 'the edited table is refused'
			})
		);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy.mock.calls[1]![0]).toMatchObject({ definition: { sort: [{ column: 1 }] } });
		expect(getTableLoading('tbl:draft:1')).toBe(false);
		expect(getTablePage('tbl:draft:1')).toBe(before);
	});

	it('a re-page aborted by a newer load rejects with an AbortError and sets nothing', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		let repage: Promise<TablePage> | null = null;
		const spy = vi
			.spyOn(tablesApi, 'evaluateTable')
			.mockImplementationOnce((args) => {
				repage = real(args);
				// A reload asked before the engine answers supersedes the re-page.
				queueMicrotask(() => void loadTablePage('tbl:draft:1', 0));
				return repage;
			})
			.mockImplementation((args) => real(args));

		await stageRename(s, first, 'staged');
		await vi.waitFor(() => expect(repage).not.toBeNull());
		await expect(repage).rejects.toMatchObject({ name: 'AbortError' });
		expect((spy.mock.calls[0]![0] as Args & { signal?: AbortSignal }).signal?.aborted).toBe(true);

		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('staged'));
		expect(getTableLoading('tbl:draft:1')).toBe(false);
		expect(getTableError('tbl:draft:1')).toBeNull();
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it('a suspended tab is marked stale rather than loaded; a never-evaluated tab is left alone', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		await ensureTableDraft('tbl:draft:2');
		const first = await idAt(0);
		suspendTableEvaluation('tbl:draft:1');
		const spy = spyEvaluate();

		await stageRename(s, first, 'staged');
		// The debounce fires and finds the tab suspended: marked stale, not loaded.
		await flushTablesRepage();

		expect(spy).not.toHaveBeenCalled();
		expect(getTablePage('tbl:draft:2')).toBeUndefined();
		expect(nameAt('tbl:draft:1', 0)).not.toBe('staged');

		// The dialog closes on an unchanged definition: the owed refresh runs.
		resumeTableEvaluation('tbl:draft:1');
		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('staged'));
		expect(spy).toHaveBeenCalledOnce();
		expect(spy.mock.calls[0]![0]).toMatchObject({ definition: PEOPLE });
	});
});

describe('a staged navigation re-pages a table that reads it', () => {
	const scope = (type: string, steps: object[] = []) => ({
		kind: 'path',
		start: { kind: 'scope', types: [type] },
		steps
	});
	const nav = (type: string) => ({
		id: 'n1',
		kind: 'navigation',
		name: 'nav n1',
		artifact_rev: 1,
		updated_at: '2026-09-25T00:00:00Z',
		updated_by: null,
		entry_points: null,
		payload: scope(type)
	});
	const READS_N1: TableDefinition = TableDefinitionSchema.parse({
		row_source: { kind: 'navigation', navigation: { ref: 'n1' } },
		columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 } }]
	});

	it('a staged deletion of the navigation is refused, and its error shows at once', async () => {
		await start({ artifacts: [['n1', nav('Organization')]] });
		await open('tbl:draft:1', READS_N1);
		const spy = spyEvaluate();
		// eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropping `payload` on purpose
		const { payload: _payload, ...header } = nav('Organization');

		stageArtifactDelete('n1', header);

		await vi.waitFor(() =>
			expect(getTableError('tbl:draft:1')).toEqual({
				kind: 'error',
				message: expect.stringMatching(/n1/)
			})
		);
		expect(getTableLoading('tbl:draft:1')).toBe(false);
		// A refusal is not retried: asking again over the same state answers the same.
		await sleep(2500);
		expect(spy).toHaveBeenCalledOnce();
		await expect(spy.mock.results[0]!.value).rejects.toMatchObject({ status: 422 });
	});

	it('when only the artifacts moved', async () => {
		const { s, changes } = await start({ artifacts: [['n1', nav('Organization')]] });
		await open('tbl:draft:1', READS_N1);
		expect(getTablePage('tbl:draft:1')).toMatchObject({ total: 5 });
		const from = changes.length;

		stageArtifactUpdate('n1', { payload: scope('Project') });

		await vi.waitFor(() => expect(getTablePage('tbl:draft:1')).toMatchObject({ total: 8 }));
		const moved = changes.slice(from).map(({ event }) => event);
		expect(moved.length).toBeGreaterThan(0);
		// Nothing but the artifacts moved: the committed rev, and no staged edit.
		for (const event of moved) {
			expect([event.rev, event.staged_version]).toEqual([s.project.rev, 0]);
		}
		expect(new Set(moved.map((event) => event.artifacts_version)).size).toBe(moved.length);
	});
});

describe('one re-page path per side', () => {
	/** A peer's rename of `id`, as the feed hands it over. */
	function peerCommit(s: EngineStore, id: string): void {
		const committed = s.project.commit([
			{ kind: 'update_element', id, properties_patch: { name: 'peer' } }
		]);
		handleFeedEvent(JSON.parse(committed.eventText) as FeedEvent, committed.eventText);
	}

	it('a peer commit re-pages once, through changed', async () => {
		const { s, changes } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		const spy = spyEvaluate();
		const from = changes.length;

		peerCommit(s, first);

		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('peer'));
		// No later debounce sneaks in a second re-page.
		await flushTablesRepage();
		expect(spy).toHaveBeenCalledOnce();
		expect(changes.slice(from).some(({ event }) => event.rev === s.project.rev)).toBe(true);
	});
});

describe('the open tables re-page when the engine takes the tables over', () => {
	/** How often the tables were told they moved since it was last zeroed. */
	let moves = 0;
	let unhear: (() => void) | null = null;
	beforeEach(() => {
		moves = 0;
		unhear = onTablesMoved(() => void (moves += 1));
	});
	afterEach(() => unhear?.());

	it('after a dead worker is replaced', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		await stageRename(s, first, 'staged');
		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('staged'));

		moves = 0;
		s.link.dispose();
		const back = s.until((status) => status.phase === 'ready');
		// The read finds the worker gone: unavailable, and the replica is rebuilt on a new one.
		await loadTablePage('tbl:draft:1', 0);
		expect(getTableError('tbl:draft:1')).toMatchObject({
			kind: 'error',
			message: 'the engine is gone'
		});
		await back;
		// Told as the replica is ready, before it posts any `changed`.
		expect(moves).toBe(1);

		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('staged'));
		expect(getTablePage('tbl:draft:1')).toMatchObject({ total: 160 });
	});

	it('after a model reload re-bootstraps the replica', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		// A reload: the model moves with no journal row the tail could cross.
		s.project.silentCommit([
			{ kind: 'update_element', id: first, properties_patch: { name: 'reloaded' } }
		]);
		s.project.opaqueBump();
		const resyncing = s.until((status) => status.phase === 'resyncing');
		const back = s.until((status) => status.phase === 'ready');

		moves = 0;
		handReplicaFeed({ type: 'reset', model_rev: s.project.rev }, undefined);
		await resyncing;
		await back;
		expect(moves).toBe(1);

		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('reloaded'));
		expect(getReplicaStatus().rev).toBe(s.project.rev);
	});

	it('after a replica that found no model opens again', async () => {
		const { s } = await start();
		await open('tbl:draft:1');
		const first = await idAt(0);
		// The replica diverges and its re-bootstrap finds no model: `off`.
		s.project.fail('descriptor', 404, 1);
		const peer = s.project.commit([
			{ kind: 'update_element', id: first, properties_patch: { name: 'peer' } }
		]);
		const off = s.until((status) => status.phase === 'off');
		await s.link.client.call('applyDelta', { text: withWrongDigest(peer) });
		await off;
		// With no replica to ask the page is an error, not another side's rows.
		await loadTablePage('tbl:draft:1', 0);
		expect(getTableError('tbl:draft:1')).toMatchObject({ kind: 'error', message: 'no model' });

		s.project.opaqueBump();
		const opening = s.until((status) => status.phase === 'opening');
		const back = s.until((status) => status.phase === 'ready');
		moves = 0;
		handReplicaFeed({ type: 'reset', model_rev: s.project.rev }, undefined);
		await opening;
		await back;
		expect(moves).toBe(1);

		await vi.waitFor(() => expect(nameAt('tbl:draft:1', 0)).toBe('peer'));
		expect(getTablePage('tbl:draft:1')).toMatchObject({ total: 160 });
	});

	it('a table asked before the artifacts land waits for them and answers from the engine', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await start({ holdPayloads: held });
		expect(getReplicaStatus()).toMatchObject({ phase: 'ready', seeded: true });
		await ensureTableDraft('tbl:draft:1');
		updateTableDefinition('tbl:draft:1', PEOPLE);
		await vi.waitFor(() => expect(getTableLoading('tbl:draft:1')).toBe(true));
		expect(getTablePage('tbl:draft:1')).toBeUndefined();

		release();

		await vi.waitFor(() => expect(getTablePage('tbl:draft:1')).toMatchObject({ total: 160 }));
		expect(getTableError('tbl:draft:1')).toBeNull();
	});
});
