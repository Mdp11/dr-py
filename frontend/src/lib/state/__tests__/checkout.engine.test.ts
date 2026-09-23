import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { ModelOp as EngineOp } from '$engine';
import { server } from '$lib/api/__tests__/server';
import { ApiError, ValidationError } from '$lib/api/errors';
import type { FeedEvent } from '$lib/api/feed';
import {
	hold,
	PAGE_ORIGIN,
	type Committed,
	type Hold
} from '$lib/engine/__tests__/support/project-server';
import type { CommitAnswer } from '$lib/engine/sync';
import {
	commitApplied,
	commitStaged,
	discardConflict,
	discardElement,
	ensureCheckout,
	getHeldTokens,
	previewStaged,
	resetCheckout,
	setProjectInfo
} from '../checkout.svelte';
import {
	applyDelta,
	emit,
	ensureElement,
	ensureElements,
	getCachedElements,
	getModelRev,
	getStagedBatchIds,
	getStagedConflicts,
	getStagedOps,
	StagedUnreadableError,
	stagedSettled,
	validateAll
} from '../model.svelte';
import * as model from '../model.svelte';
import type { ModelOp } from '../ops';
import { getReplicaStatus, handReplicaFeed, replicaSettled, stopReplica } from '../replica.svelte';
import { engineStore, peerDelta, type EngineStore } from './support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

beforeEach(() => {
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

let store: EngineStore | null = null;

afterEach(() => {
	store?.dispose();
	store = null;
	resetCheckout();
	vi.restoreAllMocks();
});

/** Where the checkout store's calls go: the active project's base, on the page. */
const API = `${PAGE_ORIGIN}/api/v1/projects/p`;

type Bodies = {
	locks: unknown[];
	release: unknown[];
	preview: unknown[];
	commits: { ops: EngineOp[] }[];
	validate: unknown[];
};

/**
 * The checkout routes of the fake project: every body is recorded, and a
 * commit lands its ops on the project, answering with the project's response
 * text. `hold` stops a commit before it lands; `refuse` answers it 422;
 * `rebound` says the commit swapped the metamodel.
 */
function routes(
	s: EngineStore,
	options: { hold?: Hold; refuse?: boolean; rebound?: boolean } = {}
): Bodies {
	const bodies: Bodies = { locks: [], release: [], preview: [], commits: [], validate: [] };
	let tokens = 0;
	server.use(
		http.post(`${API}/locks`, async ({ request }) => {
			const body = (await request.json()) as {
				targets: { resource_id: string; mode: string }[];
				intent: string;
			};
			bodies.locks.push(body);
			const token = `t${++tokens}`;
			return HttpResponse.json({
				token,
				leases: body.targets.map((target) => ({
					resource_id: target.resource_id,
					mode: target.mode,
					holder: 'u-1',
					token,
					intent: body.intent,
					expires_at: 1
				}))
			});
		}),
		http.post(`${API}/locks/release`, async ({ request }) => {
			bodies.release.push(await request.json());
			return new HttpResponse(null, { status: 204 });
		}),
		http.post(`${API}/commits/preview`, async ({ request }) => {
			bodies.preview.push(await request.json());
			return HttpResponse.json({
				conformance_error_count: 0,
				structural_blockers: [],
				issues: [],
				would_block: false
			});
		}),
		http.post(`${API}/commits`, async ({ request }) => {
			const body = (await request.json()) as { ops: EngineOp[] };
			bodies.commits.push(body);
			await options.hold?.arrive();
			if (options.refuse === true) {
				return HttpResponse.json({ detail: 'structural blocker' }, { status: 422 });
			}
			const committed = s.project.commit(body.ops);
			return new HttpResponse(commitResponse(committed, options.rebound === true), {
				headers: { 'Content-Type': 'application/json' }
			});
		}),
		http.post(`${API}/model/validate`, async ({ request }) => {
			bodies.validate.push(await request.json());
			return HttpResponse.json([]);
		}),
		http.get(`${API}/metamodel`, () =>
			HttpResponse.json(s.project.doc as unknown as Record<string, unknown>, {
				headers: { 'X-Metamodel-Id': s.project.metamodelId }
			})
		),
		http.get(`${API}/model/issues`, () =>
			HttpResponse.json({ model_rev: s.project.rev, issues: [], counts: {} })
		)
	);
	return bodies;
}

/** The project's response text with the fields a commit response adds, as the server writes it. */
function commitResponse(committed: Committed, rebound: boolean): string {
	const extra = `,"commit_id":"c-${String(committed.delta['rev'])}","message":"m"${rebound ? ',"rebound":true' : ''}`;
	return committed.responseText.slice(0, -1) + extra + '}';
}

/** Every flight the replica store opens, and what it was settled with or that it was abandoned. */
function flights(s: EngineStore): { answers: CommitAnswer[]; abandoned: number } {
	const seen = { answers: [] as CommitAnswer[], abandoned: 0 };
	const begin = s.sync.beginCommit.bind(s.sync);
	vi.spyOn(s.sync, 'beginCommit').mockImplementation(() => {
		const flight = begin();
		return {
			settle(answer) {
				seen.answers.push(answer);
				flight.settle(answer);
			},
			abandon() {
				seen.abandoned += 1;
				flight.abandon();
			}
		};
	});
	return seen;
}

async function open(): Promise<EngineStore> {
	store = await engineStore();
	return store;
}

/** Everything the engine said has reached the store. */
async function settled(s: EngineStore): Promise<void> {
	await s.sync.settled();
	await stagedSettled();
}

const rename = (id: string, name: string): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

const CREATE_X: ModelOp = {
	kind: 'create_element',
	temp_id: 'tmp_x',
	type_name: 'Organization',
	properties: { name: 'zed' }
};

function nameOf(id: string): unknown {
	return getCachedElements().get(id)?.properties['name'];
}

/** The feed frame of `committed`, its state digest flipped: the replica diverges on it. */
function withWrongDigest(committed: Committed): string {
	const digest = committed.delta['state_digest'] as string;
	const wrong = (BigInt('0x' + digest) ^ 1n).toString(16).padStart(16, '0');
	return committed.eventText.replace(`"state_digest":"${digest}"`, `"state_digest":"${wrong}"`);
}

/** A peer's commit: the feed frame to the replica, the delta to the model store. */
function feedPeer(s: EngineStore, ops: readonly EngineOp[]): void {
	const committed = s.project.commit(ops);
	handReplicaFeed(JSON.parse(committed.eventText) as FeedEvent, committed.eventText);
	applyDelta(peerDelta(committed));
}

describe('the commit on the engine side', () => {
	it("the commit sends the engine's batches and names them", async () => {
		const s = await open();
		const bodies = routes(s);
		const seen = flights(s);
		await ensureElement('e_000002');

		emit(CREATE_X);
		emit(rename('e_000002', 'Q'));
		// Coalesces into the second batch.
		emit(rename('e_000002', 'Quartz'));
		const res = await commitStaged('m', false);

		expect(bodies.commits).toHaveLength(1);
		expect(bodies.commits[0]!.ops).toEqual([CREATE_X, rename('e_000002', 'Quartz')]);
		expect(seen.answers).toHaveLength(1);
		expect(seen.answers[0]).toMatchObject({
			rev: 1,
			applied: true,
			rebound: false,
			idMap: { tmp_x: 'srv-1' },
			batchIds: [1, 2]
		});
		expect(res.model_rev).toBe(1);
		await settled(s);

		expect(getStagedOps()).toEqual([]);
		expect(getStagedBatchIds()).toEqual([]);
		expect(getStagedConflicts()).toEqual([]);
		expect(await s.link.client.call('staged')).toEqual([]);
		expect(getCachedElements().has('tmp_x')).toBe(false);
		expect(getCachedElements().get('srv-1')).toMatchObject({
			id: 'srv-1',
			type_name: 'Organization',
			properties: { name: 'zed' }
		});
		expect(nameOf('e_000002')).toBe('Quartz');
		expect(getModelRev()).toBe(1);
		expect(getReplicaStatus()).toMatchObject({ phase: 'ready', rev: 1 });
	});

	it('an edit during the flight survives', async () => {
		const s = await open();
		const held = hold();
		const bodies = routes(s, { hold: held });
		const seen = flights(s);
		await ensureElement('e_000002');

		emit(CREATE_X);
		emit(rename('e_000002', 'Quartz'));
		const committing = commitStaged('m', false);
		await held.reached;
		// An update of the element the held commit creates: no batch holds one to merge into.
		emit(rename('tmp_x', 'later'));
		await stagedSettled();
		expect(getStagedBatchIds()).toEqual([1, 2, 3]);

		held.release();
		await committing;
		await settled(s);

		expect(bodies.commits[0]!.ops).toEqual([CREATE_X, rename('e_000002', 'Quartz')]);
		expect(seen.answers[0]!.batchIds).toEqual([1, 2]);
		expect(getStagedBatchIds()).toEqual([3]);
		expect(getStagedOps()).toEqual([rename('srv-1', 'later')]);
		expect(nameOf('srv-1')).toBe('later');
		expect(getCachedElements().has('tmp_x')).toBe(false);
	});

	it('an edit made as the wait ends is neither sent nor named', async () => {
		const s = await open();
		const bodies = routes(s);
		const seen = flights(s);
		await ensureElement('e_000002');
		const wait = model.stagedSettled;
		vi.spyOn(model, 'stagedSettled').mockImplementation(async () => {
			await wait();
			emit(rename('e_000002', 'straggler'));
		});

		emit(CREATE_X);
		await commitStaged('m', false);
		vi.mocked(model.stagedSettled).mockRestore();
		await settled(s);

		expect(bodies.commits[0]!.ops).toEqual([CREATE_X]);
		expect(seen.answers[0]!.batchIds).toEqual([1]);
		expect(getStagedOps()).toEqual([rename('e_000002', 'straggler')]);
		expect(getStagedBatchIds()).toEqual([2]);
	});

	it('a refused commit keeps the batches', async () => {
		const s = await open();
		const bodies = routes(s, { refuse: true });
		const seen = flights(s);
		await ensureElement('e_000002');

		emit(CREATE_X);
		emit(rename('e_000002', 'Quartz'));
		await expect(commitStaged('m', false)).rejects.toBeInstanceOf(ValidationError);
		await settled(s);

		expect(bodies.commits).toHaveLength(1);
		expect(seen.abandoned).toBe(1);
		expect(seen.answers).toEqual([]);
		expect(getStagedBatchIds()).toEqual([1, 2]);
		expect(getStagedOps()).toEqual([CREATE_X, rename('e_000002', 'Quartz')]);
		expect(nameOf('e_000002')).toBe('Quartz');
		expect(getModelRev()).toBe(0);
	});

	it('a commit is refused, and nothing posted, while the staged edits cannot be read', async () => {
		const s = await open();
		const bodies = routes(s);
		const seen = flights(s);
		const call = s.sync.call.bind(s.sync);
		vi.spyOn(s.sync, 'call').mockImplementation(((
			method: string,
			params?: unknown,
			options?: never
		) => {
			if (method === 'stagedDiff') return Promise.reject(new ApiError(500, {}, 'engine error 500'));
			return call(method, params, options);
		}) as typeof s.sync.call);

		emit(CREATE_X);
		await s.sync.settled();
		await expect(commitStaged('m', false)).rejects.toBeInstanceOf(StagedUnreadableError);
		await expect(previewStaged()).rejects.toBeInstanceOf(StagedUnreadableError);
		await expect(validateAll()).rejects.toBeInstanceOf(StagedUnreadableError);

		expect(bodies.commits).toEqual([]);
		expect(bodies.preview).toEqual([]);
		expect(bodies.validate).toEqual([]);
		expect(seen.answers).toEqual([]);
		expect(seen.abandoned).toBe(0);
	});

	it('a commit that swaps the metamodel drops the batches it carried', async () => {
		const s = await open();
		routes(s, { rebound: true });
		const seen = flights(s);
		await ensureElement('e_000002');

		emit(CREATE_X);
		emit(rename('e_000002', 'Quartz'));
		await commitStaged('m', false);
		expect(seen.answers[0]).toMatchObject({ rebound: true, batchIds: [1, 2] });
		expect(getReplicaStatus().phase).toBe('frozen');
		// The UI adopts the new metamodel and the replica is rebuilt from the server.
		const back = s.until((status) => status.phase === 'ready');
		await back;
		await settled(s);

		expect(getStagedOps()).toEqual([]);
		expect(getStagedBatchIds()).toEqual([]);
		expect(getStagedConflicts()).toEqual([]);
		expect(await s.link.client.call('staged')).toEqual([]);
		expect(getReplicaStatus()).toMatchObject({ phase: 'ready', rev: 1 });
	});
});

describe('waiting for the replica to apply a commit', () => {
	/** Holds every `applyDelta` the sync posts to the engine until `release`. */
	function holdDeltas(s: EngineStore): { release(): void } {
		const held = hold();
		const client = s.link.client;
		const call = client.call.bind(client);
		vi.spyOn(client, 'call').mockImplementation((async (
			method: string,
			params?: unknown,
			options?: never
		) => {
			if (method === 'applyDelta') await held.arrive();
			return call(method, params, options);
		}) as typeof client.call);
		return { release: () => held.release() };
	}

	const pending = async (promise: Promise<void>): Promise<boolean> => {
		let done = false;
		void promise.then(() => (done = true));
		await new Promise((resolve) => setTimeout(resolve, 20));
		return !done;
	};

	it('commitApplied waits until the replica has applied the answer; an edit after it survives', async () => {
		const s = await open();
		routes(s);
		await ensureElement('e_000002');
		const deltas = holdDeltas(s);

		emit(rename('e_000002', 'Quartz'));
		await commitStaged('m', false);
		const applied = commitApplied();
		expect(applied).not.toBeNull();
		expect(await pending(applied!)).toBe(true);

		deltas.release();
		await applied;
		// The committed batch is gone: a keystroke now is a batch of its own.
		emit(rename('e_000002', 'Quartzite'));
		await settled(s);

		expect(getStagedOps()).toEqual([rename('e_000002', 'Quartzite')]);
		expect(getStagedBatchIds()).toEqual([2]);
		expect(nameOf('e_000002')).toBe('Quartzite');
	});

	it('commitApplied stops waiting when the replica fails, its answer still unapplied', async () => {
		const s = await open();
		routes(s);
		await ensureElement('e_000002');
		// A peer's commit ahead of the user's: the engine is handed it directly, its digest wrong.
		const peer = s.project.commit([
			{ kind: 'update_element', id: 'e_000003', properties_patch: { name: 'peer' } }
		]);
		const direct = s.link.client.call.bind(s.link.client);
		holdDeltas(s);
		// A cache re-read the failed replica leaves waiting goes to the server once
		// the replica is stopped, below.
		server.use(http.post('*/model/elements/batch', () => HttpResponse.json({ items: [] })));
		s.project.fail('snapshot', 503, 99);

		emit(rename('e_000002', 'Quartz'));
		await commitStaged('m', false);
		const applied = commitApplied()!;
		expect(await pending(applied)).toBe(true);

		// The sync still waits on the held answer when the replica diverges and
		// its rebuild fails: the phase alone ends the wait.
		const failed = s.until((status) => status.phase === 'failed');
		await direct('applyDelta', { text: withWrongDigest(peer) });
		await failed;
		await applied;
		expect(await pending(replicaSettled())).toBe(true);

		stopReplica();
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
});

describe('preview and validate on the engine side', () => {
	it('preview waits for the engine', async () => {
		const s = await open();
		const bodies = routes(s);
		await ensureElement('e_000002');

		emit(rename('e_000002', 'a'));
		await settled(s);
		// Merged by the engine into the first batch: what it sends is that batch.
		emit(rename('e_000002', 'ab'));
		await previewStaged();

		expect(bodies.preview).toEqual([{ base_rev: 0, ops: [rename('e_000002', 'ab')] }]);
	});

	it("validateAll sends the engine's ops", async () => {
		const s = await open();
		const bodies = routes(s);
		await ensureElement('e_000002');

		emit(CREATE_X);
		emit(rename('e_000002', 'a'));
		await settled(s);
		emit(rename('e_000002', 'ab'));
		await validateAll();

		expect(bodies.validate).toEqual([{ base_rev: 0, ops: [CREATE_X, rename('e_000002', 'ab')] }]);
	});
});

describe('discarding on the engine side', () => {
	it('discardConflict releases the lease', async () => {
		const s = await open();
		const bodies = routes(s);
		await ensureElements(['e_000003']);
		expect(await ensureCheckout([{ resource_id: 'e_000003', mode: 'exclusive' }], 'edit')).toEqual({
			ok: true
		});

		emit(rename('e_000003', 'mine'));
		await settled(s);
		feedPeer(s, [{ kind: 'delete_element', id: 'e_000003' }]);
		await settled(s);
		expect(getStagedConflicts().map((conflict) => conflict.batch.id)).toEqual([1]);

		await discardConflict(1);
		await settled(s);

		expect(getStagedConflicts()).toEqual([]);
		expect(await s.link.client.call('conflicts')).toEqual([]);
		expect(bodies.release).toEqual([{ token: 't1' }]);
		expect(getHeldTokens()).toEqual([]);
	});

	it('discardElement releases the lease once the engine has unstaged', async () => {
		const s = await open();
		const bodies = routes(s);
		await ensureElements(['e_000003']);
		await ensureCheckout([{ resource_id: 'e_000003', mode: 'exclusive' }], 'edit');

		emit(rename('e_000003', 'mine'));
		await settled(s);
		await discardElement('e_000003');

		expect(getStagedOps()).toEqual([]);
		expect(bodies.release).toEqual([{ token: 't1' }]);
		expect(getHeldTokens()).toEqual([]);
	});
});
