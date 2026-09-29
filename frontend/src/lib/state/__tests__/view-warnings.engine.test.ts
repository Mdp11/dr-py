import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '$lib/api/__tests__/server';
import { engineSide } from '$lib/api/engine-route';
import type { FeedEvent } from '$lib/api/feed';
import type { ArtifactHeader, Issue, View } from '$lib/api/types';
import { viewWarnings } from '$lib/api/views';
import {
	fakeProject,
	hold,
	PAGE_ORIGIN,
	type FakeProject,
	type Hold
} from '$lib/engine/__tests__/support/project-server';
import { setActiveViewId } from '../active-view.svelte';
import { resetArtifactEdits, stageArtifactDelete } from '../artifact-edits.svelte';
import { discardAll } from '../checkout.svelte';
import * as editGate from '../edit-gate';
import { cancelIssuesRefetch, emit, stagedSettled } from '../model.svelte';
import { handleFeedEvent } from '../realtime.svelte';
import { handReplicaFeed } from '../replica.svelte';
import {
	clearViewState,
	getView,
	getViewWarnings,
	refreshView,
	stagePlaceElementsAt
} from '../view.svelte';
import { engineStore, withWrongDigest, type EngineStore } from './support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let store: EngineStore | null = null;
/** Every engine call made so far has answered, and what awaited it has run. */
let answered: () => Promise<void> = () => Promise.resolve();

afterEach(async () => {
	// A computation still running against the replica ends before it goes:
	// with no view left, it asks nothing more.
	clearViewState();
	await answered();
	// A staged edit or a commit schedules one; it would land after the handlers go.
	cancelIssuesRefetch();
	resetArtifactEdits();
	store?.dispose();
	store = null;
	answered = () => Promise.resolve();
	localStorage.removeItem('dr.shadow');
	vi.restoreAllMocks();
});

const FOLDER = 'f1';

/** `e_000002` is an Organization, a containment root; `n1` a navigation the project holds. */
const committedView = (): View => ({
	name: 'Smart',
	folders: [
		{
			id: FOLDER,
			name: 'Orgs',
			folders: [],
			elements: ['e_000002'],
			artifacts: [{ id: 'n1', kind: 'navigation' }]
		}
	],
	artifacts: []
});

const NAV = {
	id: 'n1',
	kind: 'navigation',
	name: 'nav n1',
	artifact_rev: 1,
	updated_at: '2026-09-29T00:00:00Z',
	updated_by: null,
	entry_points: null,
	payload: { kind: 'path', start: { kind: 'scope', types: ['Organization'] }, steps: [] }
};

const NAV_HEADER: ArtifactHeader = {
	id: NAV.id,
	kind: NAV.kind,
	name: NAV.name,
	artifact_rev: NAV.artifact_rev,
	updated_at: NAV.updated_at,
	updated_by: null,
	entry_points: null
};

const warning = (message: string, targetIds: string[] = []): Issue => ({
	severity: 'warning',
	message,
	target_ids: targetIds,
	check: 'view',
	origin: 'on_server'
});

/** D: a Team its Organization owns, placed in the folder. */
const contained = (id: string) =>
	warning(
		`view 'Smart': element '${id}' has a containment parent and cannot be placed in folder 'Orgs'; placement ignored`,
		[id]
	);

const SENTINEL = warning('the server said so');

/** What `GET /views/v1` answers; a `hold` stops it until released. */
type Served = { view: View; warnings: Issue[]; hold: Hold | null };

/**
 * The replica store over a fake project holding `NAV`, `views` on `side`;
 * `GET /views/v1` answers `served` — `committedView()` with the sentinel
 * warning at first — and `gets` counts it. On the engine, resolves once the
 * views gate is open, unless `payloads` holds the follower's artifact load.
 * With `shadow`, the dev shadow is on and `GET /model/issues` answers an
 * empty list.
 */
async function open(
	side: 'engine' | 'server',
	{ payloads, shadow = false }: { payloads?: Hold; shadow?: boolean } = {}
) {
	if (shadow) localStorage.setItem('dr.shadow', '1');
	const project: FakeProject = fakeProject();
	project.artifacts.set(NAV.id, NAV);
	if (payloads !== undefined) {
		const handlers = project.handlers.bind(project);
		project.handlers = (options) => [
			http.get(
				`${PAGE_ORIGIN}/api/v1/projects/${project.projectId}/artifacts/payloads`,
				async () => {
					await payloads.arrive();
					return HttpResponse.json({ items: [NAV] });
				}
			),
			...handlers(options)
		];
	}
	store = await engineStore({ project, surfaces: { views: side } });
	const gets: string[] = [];
	const served: Served = { view: committedView(), warnings: [SENTINEL], hold: null };
	const base = `${PAGE_ORIGIN}/api/v1/projects/${project.projectId}`;
	server.use(
		http.get(`${base}/views/:id`, async ({ params }) => {
			gets.push(String(params['id']));
			const { view, warnings, hold: held } = served;
			if (held !== null) await held.arrive();
			return HttpResponse.json({ view, warnings, view_rev: 1 });
		}),
		http.get(`${base}/model/issues`, () =>
			HttpResponse.json({ model_rev: project.rev, issues: [], counts: {} })
		)
	);
	const calls = vi.spyOn(store.sync, 'call');
	const validations = () => calls.mock.calls.filter(([method]) => method === 'validateView').length;
	answered = async () => {
		await Promise.allSettled(calls.mock.results.map((result) => result.value as unknown));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	};
	if (side === 'engine' && payloads === undefined) {
		await vi.waitFor(() => expect(engineSide('views')).toBe('engine'));
	}
	// The replica store installs the shadow once its module has loaded.
	if (shadow) await import('$lib/engine/shadow');
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);
	setActiveViewId('v1');
	return { project, gets, validations, served };
}

describe('the view warnings with the views on the engine', () => {
	it("after a refresh are the engine's, never the server's", async () => {
		const { gets, validations, served } = await open('engine');
		served.view.folders[0]!.elements.push('e_000006');

		await refreshView();

		expect(getViewWarnings()).not.toContainEqual(SENTINEL);
		await vi.waitFor(() => expect(validations()).toBe(1));
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([contained('e_000006')]));
		expect(gets).toEqual(['v1']);
	});

	it('a staged placement of a contained element warns without asking the server', async () => {
		const { gets } = await open('engine');
		await refreshView();

		await stagePlaceElementsAt(FOLDER, ['e_000006']);

		await vi.waitFor(() => expect(getViewWarnings()).toEqual([contained('e_000006')]));
		expect(gets).toEqual(['v1']);

		// A refresh of the same view keeps them until the engine answers again.
		await refreshView();
		expect(getViewWarnings()).toEqual([contained('e_000006')]);
		expect(gets).toEqual(['v1', 'v1']);
	});

	it("a peer's model-only commit deleting a placed element warns without a view reload", async () => {
		const { project, gets, validations } = await open('engine');
		await refreshView();
		await vi.waitFor(() => expect(validations()).toBe(1));

		const committed = project.commit([{ kind: 'delete_element', id: 'e_000002' }]);
		handReplicaFeed(JSON.parse(committed.eventText) as FeedEvent, committed.eventText);

		await vi.waitFor(() =>
			expect(getViewWarnings()).toEqual([
				warning("view 'Smart': folder 'Orgs' references unknown element 'e_000002'", ['e_000002'])
			])
		);
		expect(gets).toEqual(['v1']);
	});

	it('a staged delete of an artifact the view places warns about it', async () => {
		const { gets, validations } = await open('engine');
		await refreshView();
		await vi.waitFor(() => expect(validations()).toBe(1));
		expect(getViewWarnings()).toEqual([]);

		stageArtifactDelete(NAV.id, NAV_HEADER);

		await vi.waitFor(() =>
			expect(getViewWarnings()).toEqual([
				warning("view 'Smart': folder 'Orgs' references unknown artifact 'n1'; renderers skip it")
			])
		);
		expect(gets).toEqual(['v1']);
	});

	it('five placements in quick succession ask the engine at most twice, and the last answer is the last view’s', async () => {
		const { validations } = await open('engine');
		await refreshView();
		await vi.waitFor(() => expect(validations()).toBe(1));
		const before = validations();
		const ids = ['e_000006', 'e_000007', 'e_000008', 'e_000009', 'e_000010'];

		await Promise.all(ids.map((id) => stagePlaceElementsAt(FOLDER, [id])));

		expect(getView()!.folders[0]!.elements).toEqual(['e_000002', ...ids]);
		await vi.waitFor(() => expect(getViewWarnings()).toEqual(ids.map(contained)));
		expect(validations() - before).toBeGreaterThan(0);
		expect(validations() - before).toBeLessThanOrEqual(2);
		expect(getViewWarnings()).toEqual(await viewWarnings('v1', getView()!));
	});

	it('an answer for a view the store no longer holds is dropped', async () => {
		const { validations } = await open('engine');
		await refreshView();
		await vi.waitFor(() => expect(validations()).toBe(1));
		await answered();

		await stagePlaceElementsAt(FOLDER, ['e_000006']);
		expect(validations()).toBe(2);
		clearViewState();
		await answered();

		expect(getView()).toBeNull();
		expect(getViewWarnings()).toEqual([]);
	});

	it('a refresh before the gate opens shows the server’s warnings until the engine can answer', async () => {
		const payloads = hold();
		const { validations } = await open('engine', { payloads });
		await payloads.reached;
		expect(engineSide('views')).toBe('server');

		await refreshView();
		expect(getViewWarnings()).toEqual([SENTINEL]);
		expect(validations()).toBe(0);

		payloads.release();
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([]));
		expect(validations()).toBeGreaterThan(0);
	});
});

describe('the view warnings as the views gate opens and closes', () => {
	let heldSnapshot: Hold | null = null;

	// A failed test must not leave the replica's download held.
	afterEach(() => {
		heldSnapshot?.release();
		heldSnapshot = null;
	});

	/** A peer's commit with the wrong digest: the replica resyncs, its download held until `snapshot` is released. */
	function resyncHeld(project: FakeProject) {
		const snapshot = hold();
		heldSnapshot = snapshot;
		server.use(...project.handlers({ hold: snapshot }));
		const committed = project.commit([]);
		handReplicaFeed(JSON.parse(committed.eventText) as FeedEvent, withWrongDigest(committed));
		return snapshot;
	}

	it("open from the replica reaching ready: the server's warnings, then the engine's, with one engine call", async () => {
		const { project, validations } = await open('engine');
		await refreshView();
		await vi.waitFor(() => expect(validations()).toBe(1));
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([]));

		const snapshot = resyncHeld(project);
		await vi.waitFor(() => expect(engineSide('views')).toBe('server'));
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([SENTINEL]));
		const before = validations();

		snapshot.release();
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([]));
		await answered();
		expect(validations() - before).toBe(1);
	});

	it('open from the follower loading after the replica is ready: the server’s warnings, then the engine’s', async () => {
		const payloads = hold();
		const { validations } = await open('engine', { payloads });
		await payloads.reached;
		await refreshView();
		expect(getViewWarnings()).toEqual([SENTINEL]);
		expect(validations()).toBe(0);

		payloads.release();
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([]));
		await answered();
		// The load's own hand-over and the `changed` of its artifacts each ask; one may run again after the other.
		expect(validations()).toBeGreaterThan(0);
		expect(validations()).toBeLessThanOrEqual(2);
	});

	it("close: the engine's warnings give way to the server's, with one view fetch", async () => {
		const { project, gets, validations } = await open('engine');
		await refreshView();
		await vi.waitFor(() => expect(validations()).toBe(1));
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([]));
		expect(gets).toEqual(['v1']);

		const snapshot = resyncHeld(project);

		await vi.waitFor(() => expect(engineSide('views')).toBe('server'));
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([SENTINEL]));
		expect(gets).toEqual(['v1', 'v1']);
		snapshot.release();
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([]));
	});
});

describe('the view warnings with the views on the server', () => {
	it("are the server's, and a staged placement asks the engine nothing", async () => {
		const { gets, validations } = await open('server');
		await refreshView();
		expect(getViewWarnings()).toEqual([SENTINEL]);

		await stagePlaceElementsAt(FOLDER, ['e_000006']);
		await store!.sync.settled();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(getViewWarnings()).toEqual([SENTINEL]);
		expect(validations()).toBe(0);
		expect(gets).toEqual(['v1']);
	});
});

describe('the views shadow', () => {
	/** The `[shadow] views` lines reported so far. */
	function viewLines() {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		return () =>
			errors.mock.calls
				.map(([line]) => String(line))
				.filter((line) => line.startsWith('[shadow] views'));
	}

	/** Every engine call, and the shadow comparisons behind them, have run out. */
	async function drained(store: EngineStore) {
		for (let round = 0; round < 5; round++) {
			await answered();
			await store.sync.settled();
		}
	}

	it('reports a real difference while nothing is pending', async () => {
		const lines = viewLines();
		await open('engine', { shadow: true });

		await refreshView();
		await vi.waitFor(() => expect(lines()).toHaveLength(1));

		expect(lines()[0]).toMatch(/^\[shadow\] views validateView \{"view":\{"name":"Smart",/);
	});

	it("stays silent while a peer's view commit is ahead of the store's view", async () => {
		const lines = viewLines();
		const { project, served, validations } = await open('engine', { shadow: true });
		served.warnings = [];
		await refreshView();
		await vi.waitFor(() => expect(validations()).toBe(1));
		await drained(store!);

		// The peer places a contained element; its commit moves the rev, and the
		// store's refetch of the view is held until the replica has moved.
		const peerView = committedView();
		peerView.folders[0]!.elements.push('e_000006');
		const held = hold();
		Object.assign(served, { view: peerView, warnings: [contained('e_000006')], hold: held });
		const committed = project.commit([]);
		const raw = committed.eventText.replace('"scope":["model"]', '"scope":["view"]');
		expect(raw).not.toBe(committed.eventText);
		handleFeedEvent(JSON.parse(raw) as FeedEvent, raw);
		await vi.waitFor(() => expect(validations()).toBe(2));
		await answered();
		held.release();

		await vi.waitFor(() => expect(getViewWarnings()).toEqual([contained('e_000006')]));
		await drained(store!);
		expect(lines()).toEqual([]);
	});

	it('stays silent while a discard of everything refetches the view', async () => {
		const lines = viewLines();
		const { served, validations } = await open('engine', { shadow: true });
		served.warnings = [];
		await refreshView();
		await vi.waitFor(() => expect(validations()).toBe(1));
		emit({ kind: 'update_element', id: 'e_000003', properties_patch: { name: 'staged' } });
		await stagedSettled();
		await stagePlaceElementsAt(FOLDER, ['e_000006']);
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([contained('e_000006')]));
		await drained(store!);

		// The refetch the discard awaits is held until the replica has reverted.
		const held = hold();
		served.hold = held;
		const before = validations();
		const discarded = discardAll();
		await vi.waitFor(() => expect(validations()).toBeGreaterThan(before));
		await answered();
		held.release();
		await discarded;

		await vi.waitFor(() => expect(getViewWarnings()).toEqual([]));
		await drained(store!);
		expect(lines()).toEqual([]);
	});
});
