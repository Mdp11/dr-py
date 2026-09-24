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
 * deferred for it, which the test settles.
 */
function follow(sync: ReplicaSync) {
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
		staged: () => staged
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
			payload: scope('Organization')
		};
		f.setStaged([created, { op: 'update', id: 'n1', payload: scope('Project') }]);
		f.follower.stagedChanged();
		await f.follower.settled();
		expect(f.methods()).toEqual(['setArtifacts', 'setStagedArtifacts']);

		// The commit lands: the buffer is cleared, then the commit is announced, in one run.
		f.committed.set('n1', artifact('n1', 2, 'Project'));
		f.committed.set('n9', artifact('n9', 1, 'Organization'));
		const gate = f.gate();
		f.setStaged([]);
		f.follower.stagedChanged();
		f.follower.onCommit({
			changed: [header(f.committed.get('n1')!), header(f.committed.get('n9')!)],
			deletedIds: []
		});
		await macrotask();
		expect(f.fetches.at(-1)).toEqual(['n1', 'n9']);

		// While the fetch is out, the engine still reads the working copy the commit came from.
		expect((await evaluate(over, { artifact_id: 'n1' })).total).toBe(
			await totalOf(over, 'Project')
		);
		expect((await evaluate(over, { artifact_id: 'tmp_b' })).total).toBe(
			await totalOf(over, 'Organization')
		);

		// An edit staged during the fetch is not pushed on its own.
		const edited: WireStagedArtifact = { op: 'update', id: 'n9', payload: scope('Project') };
		f.setStaged([edited]);
		f.follower.stagedChanged();
		await macrotask();
		expect(f.methods()).toEqual(['setArtifacts', 'setStagedArtifacts']);

		gate.resolve();
		await f.follower.settled();
		expect(f.methods()).toEqual(['setArtifacts', 'setStagedArtifacts', 'putArtifacts']);
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
		expect((await evaluate(over, { artifact_id: 'n9' })).total).toBe(
			await totalOf(over, 'Project')
		);
		await expect(evaluate(over, { artifact_id: 'tmp_b' })).rejects.toThrow(
			'unknown navigation artifact tmp_b'
		);

		// Released, a staged change goes on its own again.
		f.setStaged([]);
		f.follower.stagedChanged();
		await f.follower.settled();
		expect(f.posted.at(-1)).toEqual({ method: 'setStagedArtifacts', entries: [] });
	});

	it('a failed refresh releases the hold and pushes the buffer', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.follower.load();
		await f.follower.settled();
		const gate = f.gate();
		f.follower.onCommit({ changed: [header(artifact('n1', 1, 'Organization'))], deletedIds: [] });
		const entry: WireStagedArtifact = { op: 'delete', id: 'n5' };
		f.setStaged([entry]);
		f.follower.stagedChanged();
		await macrotask();

		gate.reject(new Error('offline'));
		await f.follower.settled();

		expect(f.methods()).toEqual(['setArtifacts', 'setStagedArtifacts']);
		expect(f.posted.at(-1)).toEqual({ method: 'setStagedArtifacts', entries: [entry] });
	});

	it('a commit with nothing to fetch still carries the buffer', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.committed.set('n1', artifact('n1', 1, 'Organization'));
		f.follower.load();
		await f.follower.settled();

		f.committed.delete('n1');
		f.follower.onCommit({ changed: [], deletedIds: ['n1'] });
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
		f.follower.onCommit({ changed: [], deletedIds: [] });
		await f.follower.settled();

		expect(f.fetches).toEqual([undefined]);
		expect(f.methods()).toEqual(['setArtifacts', 'setStagedArtifacts']);
		expect(f.posted.at(-1)).toEqual({ method: 'setStagedArtifacts', entries: [entry] });
	});

	it('a commit whose payloads an event brought first fetches nothing again', async () => {
		const over = await ready();
		const f = follow(over.sync);
		f.follower.load();
		await f.follower.settled();
		f.committed.set('n1', artifact('n1', 1, 'Organization'));

		f.follower.onEvent('created', header(f.committed.get('n1')!));
		f.follower.onCommit({ changed: [header(f.committed.get('n1')!)], deletedIds: [] });
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

		f.follower.onCommit({ changed: [header(f.committed.get('n1')!)], deletedIds: [] });
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
		f.follower.onCommit({ changed: [header(f.committed.get('n1')!)], deletedIds: [] });
		await macrotask();
		expect(f.fetches.at(-1)).toEqual(['n1']);

		f.follower.stop();
		gate.resolve();
		await f.follower.settled();

		expect(f.methods()).toEqual(['setArtifacts']);
		await expect(evaluate(over, { artifact_id: 'n1' })).rejects.toThrow(
			'unknown navigation artifact n1'
		);
	});
});
