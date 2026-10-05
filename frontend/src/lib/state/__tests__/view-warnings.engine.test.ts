import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '$lib/api/__tests__/server';
import type { FeedEvent } from '$lib/api/feed';
import { getElementsBatch } from '$lib/api/model-read';
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
import * as editGate from '../edit-gate';
import { cancelIssuesRefetch } from '../model.svelte';
import { getReplicaStatus, handReplicaFeed, stopReplica } from '../replica.svelte';
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
 * The replica store over a fake project holding `NAV`; `GET /views/v1`
 * answers `served` — `committedView()` with the sentinel warning at first —
 * and `gets` counts it. Resolves once the replica holds the artifacts, unless
 * `payloads` holds the follower's artifact load. `GET /model/issues` answers
 * an empty list.
 */
async function open({ payloads, loads = [NAV] }: { payloads?: Hold; loads?: (typeof NAV)[] } = {}) {
	const project: FakeProject = fakeProject();
	project.artifacts.set(NAV.id, NAV);
	if (payloads !== undefined) {
		const handlers = project.handlers.bind(project);
		project.handlers = (options) => [
			http.get(
				`${PAGE_ORIGIN}/api/v1/projects/${project.projectId}/artifacts/payloads`,
				async () => {
					await payloads.arrive();
					return HttpResponse.json({ items: loads });
				}
			),
			...handlers(options)
		];
	}
	store = await engineStore({ project });
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
	// A read is answered once the artifacts have loaded.
	if (payloads === undefined) await getElementsBatch(['e_000001']);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	vi.spyOn(editGate, 'folderEditLock').mockResolvedValue(true);
	setActiveViewId('v1');
	return { project, gets, validations, served };
}

describe('the view warnings', () => {
	it("after a refresh are the engine's, never the server's", async () => {
		const { gets, validations, served } = await open();
		served.view.folders[0]!.elements.push('e_000006');

		await refreshView();

		expect(getViewWarnings()).not.toContainEqual(SENTINEL);
		await vi.waitFor(() => expect(validations()).toBe(1));
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([contained('e_000006')]));
		expect(gets).toEqual(['v1']);
	});

	it('a staged placement of a contained element warns without asking the server', async () => {
		const { gets } = await open();
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
		const { project, gets, validations } = await open();
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
		const { gets, validations } = await open();
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
		const { validations } = await open();
		await refreshView();
		await vi.waitFor(() => expect(validations()).toBe(1));
		const before = validations();
		const ids = ['e_000006', 'e_000007', 'e_000008', 'e_000009', 'e_000010'];

		await Promise.all(ids.map((id) => stagePlaceElementsAt(FOLDER, [id])));

		expect(getView()!.folders[0]!.elements).toEqual(['e_000002', ...ids]);
		await vi.waitFor(() => expect(getViewWarnings()).toEqual(ids.map(contained)));
		expect(validations() - before).toBeGreaterThan(0);
		expect(validations() - before).toBeLessThanOrEqual(2);
		expect(getViewWarnings()).toEqual(await viewWarnings(getView()!));
	});

	it('an answer for a view the store no longer holds is dropped', async () => {
		const { validations } = await open();
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

	it('a refresh before the gate opens shows no warnings until the engine can answer', async () => {
		const payloads = hold();
		const { validations } = await open({ payloads });
		await payloads.reached;

		await refreshView();
		expect(getViewWarnings()).toEqual([]);
		expect(validations()).toBe(0);

		payloads.release();
		await vi.waitFor(() => expect(validations()).toBeGreaterThan(0));
		await answered();
		expect(getViewWarnings()).toEqual([]);
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

	it('a resync keeps the warnings, and they are recomputed once the replica is ready again, with one or two engine calls', async () => {
		const { project, validations } = await open();
		await refreshView();
		await vi.waitFor(() => expect(validations()).toBe(1));
		await stagePlaceElementsAt(FOLDER, ['e_000006']);
		await vi.waitFor(() => expect(getViewWarnings()).toEqual([contained('e_000006')]));

		const snapshot = resyncHeld(project);
		await vi.waitFor(() => expect(getReplicaStatus().phase).toBe('resyncing'));
		expect(getViewWarnings()).toEqual([contained('e_000006')]);
		const before = validations();

		snapshot.release();
		await vi.waitFor(() =>
			expect(getReplicaStatus()).toMatchObject({ phase: 'ready', seeded: true })
		);
		await answered();
		// The commit that closed the replica asked for a recompute of its own: it
		// may be in flight as the replica closes, refused with a moved 409 and asked
		// again once the gate opens, beside the one the opening asks for.
		expect(validations() - before).toBeGreaterThanOrEqual(1);
		expect(validations() - before).toBeLessThanOrEqual(2);
		expect(getViewWarnings()).toEqual([contained('e_000006')]);
	});

	it('open from the follower loading after the replica is ready: no warnings, then the engine’s, with one or two engine calls', async () => {
		const payloads = hold();
		// No artifact loads, so no `changed` of the artifacts asks: only the load's own hand-over does.
		const { validations } = await open({ payloads, loads: [] });
		await payloads.reached;
		await refreshView();
		expect(getViewWarnings()).toEqual([]);
		expect(validations()).toBe(0);

		payloads.release();
		await vi.waitFor(() => expect(validations()).toBeGreaterThanOrEqual(1));
		await answered();
		// The refresh's own recompute waited at the gate; the gate opening asks
		// again. The project holds no artifact, so the engine says the view's is unknown.
		expect(getViewWarnings()).toEqual([
			warning("view 'Smart': folder 'Orgs' references unknown artifact 'n1'; renderers skip it")
		]);
		expect(validations()).toBeLessThanOrEqual(2);
	});

	it('stopping the replica fetches no view', async () => {
		const { gets } = await open();
		await refreshView();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		const before = gets.length;

		stopReplica();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		expect(gets.length).toBe(before);
	});
});
