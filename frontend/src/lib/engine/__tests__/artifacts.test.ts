import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WireArtifact, WireStagedArtifact } from '$engine';
import { ValidationError } from '$lib/api/errors';
import { server } from '$lib/api/__tests__/server';
import type { Artifact } from '$lib/api/types';
import { createArtifactFollower, type ArtifactFollower, type ArtifactMark } from '../artifacts';
import type { ReplicaSync } from '../sync';
import { fakeProject, syncOver } from './support/project-server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const made: ReturnType<typeof syncOver>[] = [];
const followers: ArtifactFollower[] = [];

afterEach(() => {
	for (const follower of followers.splice(0)) follower.stop();
	for (const over of made.splice(0)) over.dispose();
	server.resetHandlers();
});

async function ready() {
	const project = fakeProject();
	server.use(...project.handlers());
	const over = syncOver(project);
	made.push(over);
	over.sync.open(project.projectId);
	await over.sync.settled();
	expect(over.sync.status().phase).toBe('ready');
	return over;
}

const scope = (type: string) => ({
	kind: 'path',
	start: { kind: 'scope', types: [type] },
	steps: []
});

function artifact(id: string, rev: number, type: string): Artifact {
	return {
		id,
		kind: 'navigation',
		name: `nav ${id}`,
		artifact_rev: rev,
		updated_at: '2026-09-24T00:00:00Z',
		updated_by: null,
		entry_points: null,
		payload: scope(type)
	};
}

const header = ({ id, artifact_rev }: Artifact): ArtifactMark => ({ id, artifact_rev });

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

type Posted =
	| { method: 'setArtifacts'; artifacts: readonly WireArtifact[] }
	| {
			method: 'putArtifacts';
			changed: readonly WireArtifact[];
			deletedIds: readonly string[];
			staged?: readonly WireStagedArtifact[];
	  }
	| { method: 'setStagedArtifacts'; entries: readonly WireStagedArtifact[] };

/**
 * A follower over `sync`; `server` holds the committed artifacts its
 * `payloads` answers from. A fetch answers at once, unless `gate` holds a
 * deferred for it, which the test settles. `pause` is the follower's own.
 */
function follow(sync: ReplicaSync, pause?: () => Promise<void>) {
	const committed = new Map<string, Artifact>();
	const fetches: (readonly string[] | undefined)[] = [];
	const gates: Deferred<void>[] = [];
	const posted: Posted[] = [];
	let staged: WireStagedArtifact[] = [];
	const follower = createArtifactFollower({
		sync: {
			setArtifacts(artifacts) {
				posted.push({ method: 'setArtifacts', artifacts });
				sync.setArtifacts(artifacts);
			},
			putArtifacts(changed, deletedIds, entries) {
				posted.push({
					method: 'putArtifacts',
					changed,
					deletedIds,
					...(entries === undefined ? {} : { staged: entries })
				});
				sync.putArtifacts(changed, deletedIds, entries);
			},
			setStagedArtifacts(entries) {
				posted.push({ method: 'setStagedArtifacts', entries });
				sync.setStagedArtifacts(entries);
			}
		},
		async payloads(ids) {
			fetches.push(ids);
			const gate = gates.shift();
			if (gate !== undefined) await gate.promise;
			const all = [...committed.values()];
			return ids === undefined ? all : all.filter((a) => ids.includes(a.id));
		},
		staged: () => staged,
		...(pause === undefined ? {} : { pause })
	});
	followers.push(follower);
	return {
		follower,
		committed,
		fetches,
		posted,
		methods: () => posted.map((p) => p.method),
		/** The next fetch waits for the returned deferred. */
		gate(): Deferred<void> {
			const gate = deferred<void>();
			gates.push(gate);
			return gate;
		},
		setStaged(entries: WireStagedArtifact[]) {
			staged = entries;
		}
	};
}

type ChainPage = { total: number; chains: unknown[] };

const evaluate = (over: ReturnType<typeof syncOver>, params: object) =>
	over.sync.call<ChainPage>('evaluateNavigation', params);

/** The number of chains `type`'s scope answers, evaluated inline. */
const totalOf = async (over: ReturnType<typeof syncOver>, type: string) =>
	(await evaluate(over, { definition: scope(type) })).total;

/** Once the microtasks queued so far, and what they queue, have run. */
const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('the artifact follower', () => {
	it('load hands every committed artifact to the engine', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.committed.set('n1', artifact('n1', 1, 'Organization'));

		f.follower.load();
		await f.follower.settled();

		expect(f.fetches).toEqual([undefined]);
		expect(f.posted).toEqual([
			{
				method: 'setArtifacts',
				artifacts: [
					{
						id: 'n1',
						kind: 'navigation',
						name: 'nav n1',
						artifact_rev: 1,
						payload: scope('Organization')
					}
				]
			}
		]);
		const page = await evaluate(over, { artifact_id: 'n1' });
		expect(page.total).toBe(await totalOf(over, 'Organization'));
	});

	it('an event fetches a newer rev, and nothing for one the engine holds', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		f.follower.load();
		await f.follower.settled();

		f.follower.onEvent('updated', header(artifact('n1', 1, 'Organization')));
		await f.follower.settled();
		expect(f.fetches).toEqual([undefined]);

		f.committed.set('n1', artifact('n1', 2, 'Project'));
		f.follower.onEvent('updated', header(f.committed.get('n1')!));
		await f.follower.settled();
		expect(f.fetches).toEqual([undefined, ['n1']]);
		expect(f.posted.at(-1)).toMatchObject({ method: 'putArtifacts', deletedIds: [] });
		expect(f.posted.at(-1)).not.toHaveProperty('staged');
		expect((await evaluate(over, { artifact_id: 'n1' })).total).toBe(
			await totalOf(over, 'Project')
		);

		f.follower.onEvent('updated', header(artifact('n1', 1, 'Organization')));
		f.committed.set('n2', artifact('n2', 1, 'Organization'));
		f.follower.onEvent('created', header(f.committed.get('n2')!));
		await f.follower.settled();
		expect(f.fetches).toEqual([undefined, ['n1'], ['n2']]);
		expect((await evaluate(over, { artifact_id: 'n2' })).total).toBe(
			await totalOf(over, 'Organization')
		);
	});

	it('a deleted event drops the artifact', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		f.follower.load();
		await f.follower.settled();

		f.committed.delete('n1');
		f.follower.onEvent('deleted', header(artifact('n1', 1, 'Organization')));
		await f.follower.settled();

		expect(f.posted.at(-1)).toEqual({ method: 'putArtifacts', changed: [], deletedIds: ['n1'] });
		const refused = evaluate(over, { artifact_id: 'n1' });
		await expect(refused).rejects.toBeInstanceOf(ValidationError);
		await expect(refused).rejects.toThrow('unknown navigation artifact n1');
	});

	it("a commit's refresh holds the staged push and carries the buffer as it is when the fetch lands", async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		f.follower.load();
		await f.follower.settled();
		const created: WireStagedArtifact = {
			op: 'create',
			id: 'tmp_b',
			kind: 'navigation',
			name: 'b',
			payload: scope('EdgeGateway')
		};
		const updated: WireStagedArtifact = { op: 'update', id: 'n1', payload: scope('Project') };
		f.setStaged([created, updated]);
		f.follower.stagedChanged();
		await f.follower.settled();
		expect(f.methods()).toEqual(['setArtifacts', 'setStagedArtifacts']);
		const organizations = await totalOf(over, 'Organization');
		const projects = await totalOf(over, 'Project');
		const gateways = await totalOf(over, 'EdgeGateway');
		expect(new Set([organizations, projects, gateways]).size).toBe(3);

		// The commit lands: the buffer is cleared, then the commit is announced, in one run.
		// The server answers the create under `n9`, with a payload of its own writing.
		f.committed.set('n1', artifact('n1', 2, 'Project'));
		f.committed.set('n9', artifact('n9', 1, 'Organization'));
		const gate = f.gate();
		f.setStaged([]);
		f.follower.stagedChanged();
		f.follower.onCommit({
			idMap: { tmp_b: 'n9', tmp_model: 'e_9' },
			changed: [header(f.committed.get('n1')!), header(f.committed.get('n9')!)],
			deletedIds: []
		});
		// At once, the created artifact also under its real id.
		expect(f.posted.at(-1)).toEqual({
			method: 'setStagedArtifacts',
			entries: [created, updated, { ...created, id: 'n9' }]
		});
		await macrotask();
		expect(f.fetches.at(-1)).toEqual(['n1', 'n9']);

		// While the fetch is out, the engine reads the working copy the commit came from,
		// the created artifact under either id.
		expect((await evaluate(over, { artifact_id: 'n1' })).total).toBe(projects);
		expect((await evaluate(over, { artifact_id: 'tmp_b' })).total).toBe(gateways);
		expect((await evaluate(over, { artifact_id: 'n9' })).total).toBe(gateways);

		// An edit staged during the fetch is not pushed on its own.
		const edited: WireStagedArtifact = { op: 'update', id: 'n9', payload: scope('Project') };
		f.setStaged([edited]);
		f.follower.stagedChanged();
		await macrotask();
		expect(f.methods()).toEqual(['setArtifacts', 'setStagedArtifacts', 'setStagedArtifacts']);

		gate.resolve();
		await f.follower.settled();
		expect(f.methods()).toEqual([
			'setArtifacts',
			'setStagedArtifacts',
			'setStagedArtifacts',
			'putArtifacts'
		]);
		expect(f.posted.at(-1)).toEqual({
			method: 'putArtifacts',
			changed: [
				{
					id: 'n1',
					kind: 'navigation',
					name: 'nav n1',
					artifact_rev: 2,
					payload: scope('Project')
				},
				{
					id: 'n9',
					kind: 'navigation',
					name: 'nav n9',
					artifact_rev: 1,
					payload: scope('Organization')
				}
			],
			deletedIds: [],
			staged: [edited]
		});
		expect((await evaluate(over, { artifact_id: 'n9' })).total).toBe(projects);
		await expect(evaluate(over, { artifact_id: 'tmp_b' })).rejects.toThrow(
			'unknown navigation artifact tmp_b'
		);

		// Released, a staged change goes on its own again; the real id reads the committed payload.
		f.setStaged([]);
		f.follower.stagedChanged();
		await f.follower.settled();
		expect(f.posted.at(-1)).toEqual({ method: 'setStagedArtifacts', entries: [] });
		expect((await evaluate(over, { artifact_id: 'n9' })).total).toBe(organizations);
	});

	it('a second commit during a refresh keeps the first one held', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.follower.load();
		await f.follower.settled();
		const first: WireStagedArtifact = {
			op: 'create',
			id: 'tmp_a',
			kind: 'navigation',
			name: 'a',
			payload: scope('Organization')
		};
		f.setStaged([first]);
		f.follower.stagedChanged();
		await f.follower.settled();
		const gate = f.gate();
		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		f.setStaged([]);
		f.follower.stagedChanged();
		f.follower.onCommit({
			idMap: { tmp_a: 'n1' },
			changed: [header(f.committed.get('n1')!)],
			deletedIds: []
		});

		// Staged and committed while the first refresh is out.
		const second: WireStagedArtifact = { ...first, id: 'tmp_c', payload: scope('Project') };
		f.setStaged([second]);
		f.follower.stagedChanged();
		await macrotask();
		const secondGate = f.gate();
		f.committed.set('n2', artifact('n2', 1, 'Project'));
		f.setStaged([]);
		f.follower.stagedChanged();
		f.follower.onCommit({
			idMap: { tmp_c: 'n2' },
			changed: [header(f.committed.get('n2')!)],
			deletedIds: []
		});
		expect(f.posted.at(-1)).toEqual({
			method: 'setStagedArtifacts',
			entries: [first, { ...first, id: 'n1' }, second, { ...second, id: 'n2' }]
		});

		gate.resolve();
		await macrotask();
		expect(f.posted.at(-1)).toMatchObject({
			method: 'putArtifacts',
			staged: [second, { ...second, id: 'n2' }]
		});
		expect((await evaluate(over, { artifact_id: 'n2' })).total).toBe(
			await totalOf(over, 'Project')
		);

		secondGate.resolve();
		await f.follower.settled();
		expect(f.posted.at(-1)).toMatchObject({ method: 'putArtifacts', staged: [] });
		expect((await evaluate(over, { artifact_id: 'n2' })).total).toBe(
			await totalOf(over, 'Project')
		);
		await expect(evaluate(over, { artifact_id: 'tmp_c' })).rejects.toThrow(
			'unknown navigation artifact tmp_c'
		);
	});

	/**
	 * A follower whose committed `n1` (Organization) and staged create `tmp_c`
	 * (EdgeGateway) went into a commit whose refresh failed, and the one reload
	 * after it too: the committed layer lacks what the commit brought.
	 */
	async function afterFailedRefresh() {
		const over = await ready();
		const f = follow(over.sync);
		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		f.follower.load();
		await f.follower.settled();
		const totals = {
			organizations: await totalOf(over, 'Organization'),
			projects: await totalOf(over, 'Project'),
			gateways: await totalOf(over, 'EdgeGateway')
		};
		expect(new Set(Object.values(totals)).size).toBe(3);
		const created: WireStagedArtifact = {
			op: 'create',
			id: 'tmp_c',
			kind: 'navigation',
			name: 'c',
			payload: scope('EdgeGateway')
		};
		const updated: WireStagedArtifact = { op: 'update', id: 'n1', payload: scope('Project') };
		f.setStaged([created, updated]);
		f.follower.stagedChanged();
		await f.follower.settled();

		f.committed.set('n1', artifact('n1', 2, 'Project'));
		f.committed.set('n7', artifact('n7', 1, 'EdgeGateway'));
		const refresh = f.gate();
		const reload = f.gate();
		const retry = f.gate();
		f.setStaged([]);
		f.follower.stagedChanged();
		f.follower.onCommit({
			idMap: { tmp_c: 'n7' },
			changed: [header(f.committed.get('n1')!), header(f.committed.get('n7')!)],
			deletedIds: []
		});
		refresh.reject(new Error('offline'));
		reload.reject(new Error('offline'));
		retry.reject(new Error('offline'));
		await f.follower.settled();
		expect(f.fetches).toEqual([undefined, ['n1', 'n7'], undefined, undefined]);
		// The commit's entries stand in for what the refresh could not bring.
		expect(f.posted.at(-1)).toEqual({
			method: 'setStagedArtifacts',
			entries: [created, updated, { ...created, id: 'n7' }]
		});
		expect((await evaluate(over, { artifact_id: 'n1' })).total).toBe(totals.projects);
		expect((await evaluate(over, { artifact_id: 'n7' })).total).toBe(totals.gateways);
		return { over, f, totals, created };
	}

	it('loaded holds once a load lands, and not after stop; a new follower starts unloaded', async () => {
		const over = await ready();
		const f = follow(over.sync);
		expect(f.follower.loaded()).toBe(false);
		const loading = f.gate();
		f.follower.load();
		await macrotask();
		expect(f.follower.loaded()).toBe(false);

		loading.resolve();
		await f.follower.settled();
		expect(f.follower.loaded()).toBe(true);

		f.follower.stop();
		expect(f.follower.loaded()).toBe(false);
		expect(follow(over.sync).follower.loaded()).toBe(false);
	});

	it('a failed load asks once more after the pause, and lands', async () => {
		const over = await ready();
		let paused = 0;
		const f = follow(over.sync, async () => {
			paused += 1;
		});
		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		const first = f.gate();
		f.follower.load();
		first.reject(new Error('offline'));
		await f.follower.settled();

		expect(f.fetches).toEqual([undefined, undefined]);
		expect(paused).toBe(1);
		expect(f.follower.loaded()).toBe(true);
		expect((await evaluate(over, { artifact_id: 'n1' })).total).toBe(
			await totalOf(over, 'Organization')
		);
	});

	it("a failed load's retry that fails too is final", async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		const first = f.gate();
		const retry = f.gate();
		f.follower.load();
		first.reject(new Error('offline'));
		retry.reject(new Error('offline'));
		await f.follower.settled();
		await macrotask();

		expect(f.fetches).toEqual([undefined, undefined]);
		expect(f.posted).toEqual([]);
		expect(f.follower.loaded()).toBe(false);
	});

	it('a failed refresh reloads once at once', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.follower.load();
		await f.follower.settled();
		const created: WireStagedArtifact = {
			op: 'create',
			id: 'tmp_c',
			kind: 'navigation',
			name: 'c',
			payload: scope('Organization')
		};
		f.setStaged([created]);
		f.follower.stagedChanged();
		await f.follower.settled();
		f.committed.set('n7', artifact('n7', 1, 'Project'));
		const refresh = f.gate();
		f.setStaged([]);
		f.follower.stagedChanged();
		f.follower.onCommit({
			idMap: { tmp_c: 'n7' },
			changed: [header(f.committed.get('n7')!)],
			deletedIds: []
		});

		refresh.reject(new Error('offline'));
		await f.follower.settled();

		expect(f.fetches).toEqual([undefined, ['n7'], undefined]);
		expect(f.methods().slice(-2)).toEqual(['setArtifacts', 'setStagedArtifacts']);
		expect(f.posted.at(-1)).toEqual({ method: 'setStagedArtifacts', entries: [] });
		expect((await evaluate(over, { artifact_id: 'n7' })).total).toBe(
			await totalOf(over, 'Project')
		);
		await expect(evaluate(over, { artifact_id: 'tmp_c' })).rejects.toThrow(
			'unknown navigation artifact tmp_c'
		);
	});

	it("a failed refresh's entries give way to a later load", async () => {
		const { over, f, totals } = await afterFailedRefresh();

		f.follower.load();
		await f.follower.settled();

		expect(f.posted.at(-1)).toEqual({ method: 'setStagedArtifacts', entries: [] });
		expect((await evaluate(over, { artifact_id: 'n1' })).total).toBe(totals.projects);
		expect((await evaluate(over, { artifact_id: 'n7' })).total).toBe(totals.gateways);
		await expect(evaluate(over, { artifact_id: 'tmp_c' })).rejects.toThrow(
			'unknown navigation artifact tmp_c'
		);
	});

	it("a failed refresh's entries give way to a later commit of the same artifact", async () => {
		const { over, f, totals } = await afterFailedRefresh();
		const edited: WireStagedArtifact = { op: 'update', id: 'n1', payload: scope('EdgeGateway') };
		f.setStaged([edited]);
		f.follower.stagedChanged();
		await f.follower.settled();

		f.committed.set('n1', artifact('n1', 3, 'EdgeGateway'));
		f.setStaged([]);
		f.follower.stagedChanged();
		f.follower.onCommit({ idMap: {}, changed: [header(f.committed.get('n1')!)], deletedIds: [] });
		await f.follower.settled();

		expect(f.posted.at(-1)).toMatchObject({
			method: 'putArtifacts',
			staged: [
				{ op: 'create', id: 'tmp_c', kind: 'navigation', name: 'c' },
				{ op: 'create', id: 'n7' }
			]
		});
		expect((await evaluate(over, { artifact_id: 'n1' })).total).toBe(totals.gateways);
		// n7 had no news: its carried entry still stands in for it.
		expect((await evaluate(over, { artifact_id: 'n7' })).total).toBe(totals.gateways);
	});

	it("a failed refresh's entries give way to a peer's update event", async () => {
		const { over, f, totals } = await afterFailedRefresh();

		f.committed.set('n1', artifact('n1', 3, 'Organization'));
		f.follower.onEvent('updated', header(f.committed.get('n1')!));
		await f.follower.settled();

		expect(f.posted.at(-1)).toMatchObject({ method: 'putArtifacts', deletedIds: [] });
		expect(f.posted.at(-1)).toHaveProperty('staged');
		expect((await evaluate(over, { artifact_id: 'n1' })).total).toBe(totals.organizations);
	});

	it("a failed refresh's entries give way to a delete, an update staged over them merged in until then", async () => {
		const { over, f, totals } = await afterFailedRefresh();
		// A rename staged over the created artifact merges into its carried create.
		f.setStaged([{ op: 'update', id: 'n7', payload: scope('Organization') }]);
		f.follower.stagedChanged();
		await f.follower.settled();
		expect((await evaluate(over, { artifact_id: 'n7' })).total).toBe(totals.organizations);

		f.committed.delete('n7');
		f.follower.onEvent('deleted', header(artifact('n7', 1, 'EdgeGateway')));
		await f.follower.settled();

		expect(f.posted.at(-1)).toMatchObject({ method: 'putArtifacts', deletedIds: ['n7'] });
		await expect(evaluate(over, { artifact_id: 'n7' })).rejects.toThrow(
			'unknown navigation artifact n7'
		);
		await expect(evaluate(over, { artifact_id: 'tmp_c' })).rejects.toThrow(
			'unknown navigation artifact tmp_c'
		);
		// n1 had no news: its carried update still stands in for it.
		expect((await evaluate(over, { artifact_id: 'n1' })).total).toBe(totals.projects);
	});

	it('a commit with nothing to fetch still carries the buffer', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		f.follower.load();
		await f.follower.settled();

		f.committed.delete('n1');
		f.follower.onCommit({ idMap: {}, changed: [], deletedIds: ['n1'] });
		await f.follower.settled();

		expect(f.fetches).toEqual([undefined]);
		expect(f.posted.at(-1)).toEqual({
			method: 'putArtifacts',
			changed: [],
			deletedIds: ['n1'],
			staged: []
		});
	});

	it('a commit that moved no artifact holds nothing', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.follower.load();
		await f.follower.settled();
		const entry: WireStagedArtifact = { op: 'delete', id: 'n5' };
		f.setStaged([entry]);

		f.follower.stagedChanged();
		f.follower.onCommit({ idMap: {}, changed: [], deletedIds: [] });
		await f.follower.settled();

		expect(f.fetches).toEqual([undefined]);
		expect(f.methods()).toEqual(['setArtifacts', 'setStagedArtifacts']);
		expect(f.posted.at(-1)).toEqual({ method: 'setStagedArtifacts', entries: [entry] });
		expect(f.follower.hasOverlay()).toBe(false);
	});

	it("hasOverlay holds while a commit's entries lie under the buffer, and only then", async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.follower.load();
		await f.follower.settled();
		const created = (id: string): WireStagedArtifact => ({
			op: 'create',
			id,
			kind: 'navigation',
			name: id,
			payload: scope('Organization')
		});
		// Entries still in the buffer are not an overlay: the buffer's depth counts them.
		f.setStaged([created('tmp_a')]);
		f.follower.stagedChanged();
		await f.follower.settled();
		expect(f.follower.hasOverlay()).toBe(false);

		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		const refresh = f.gate();
		f.setStaged([]);
		f.follower.stagedChanged();
		f.follower.onCommit({
			idMap: { tmp_a: 'n1' },
			changed: [header(f.committed.get('n1')!)],
			deletedIds: []
		});
		expect(f.follower.hasOverlay()).toBe(true);
		await macrotask();
		expect(f.follower.hasOverlay()).toBe(true);
		refresh.resolve();
		await f.follower.settled();
		expect(f.follower.hasOverlay()).toBe(false);

		// A failed refresh's entries stay until newer committed news: here, a load.
		f.setStaged([created('tmp_b')]);
		f.follower.stagedChanged();
		await f.follower.settled();
		f.committed.set('n2', artifact('n2', 1, 'Organization'));
		const failed = f.gate();
		const reload = f.gate();
		const retry = f.gate();
		f.setStaged([]);
		f.follower.stagedChanged();
		f.follower.onCommit({
			idMap: { tmp_b: 'n2' },
			changed: [header(f.committed.get('n2')!)],
			deletedIds: []
		});
		failed.reject(new Error('offline'));
		reload.reject(new Error('offline'));
		retry.reject(new Error('offline'));
		await f.follower.settled();
		expect(f.follower.hasOverlay()).toBe(true);

		f.follower.load();
		await f.follower.settled();
		expect(f.follower.hasOverlay()).toBe(false);
	});

	it('a commit whose payloads an event brought first fetches nothing again', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.follower.load();
		await f.follower.settled();
		f.committed.set('n1', artifact('n1', 1, 'Organization'));

		f.follower.onEvent('created', header(f.committed.get('n1')!));
		f.follower.onCommit({ idMap: {}, changed: [header(f.committed.get('n1')!)], deletedIds: [] });
		await f.follower.settled();

		expect(f.fetches).toEqual([undefined, ['n1']]);
		expect(f.posted.at(-1)).toEqual({
			method: 'putArtifacts',
			changed: [],
			deletedIds: [],
			staged: []
		});
		expect((await evaluate(over, { artifact_id: 'n1' })).total).toBe(
			await totalOf(over, 'Organization')
		);
	});

	it('stop drops every answer that comes after it', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		const loading = f.gate();
		f.follower.load();
		await macrotask();
		expect(f.fetches).toEqual([undefined]);

		f.follower.stop();
		loading.resolve();
		await f.follower.settled();
		expect(f.posted).toEqual([]);

		f.follower.onCommit({ idMap: {}, changed: [header(f.committed.get('n1')!)], deletedIds: [] });
		f.follower.onEvent('updated', header(artifact('n1', 5, 'Organization')));
		f.follower.stagedChanged();
		f.follower.load();
		await f.follower.settled();
		expect(f.fetches).toEqual([undefined]);
		expect(f.posted).toEqual([]);
		await expect(evaluate(over, { artifact_id: 'n1' })).rejects.toThrow(
			'unknown navigation artifact n1'
		);
	});

	it('stop during a refresh drops its answer', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.follower.load();
		await f.follower.settled();
		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		const gate = f.gate();
		f.follower.onCommit({ idMap: {}, changed: [header(f.committed.get('n1')!)], deletedIds: [] });
		await macrotask();
		expect(f.fetches.at(-1)).toEqual(['n1']);

		f.follower.stop();
		gate.resolve();
		await f.follower.settled();

		// The hold's own push went at the commit; nothing after the stop.
		expect(f.methods()).toEqual(['setArtifacts', 'setStagedArtifacts']);
		await expect(evaluate(over, { artifact_id: 'n1' })).rejects.toThrow(
			'unknown navigation artifact n1'
		);
	});
});
