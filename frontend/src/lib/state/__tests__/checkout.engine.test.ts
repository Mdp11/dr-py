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
	CommitPendingError,
	commitsLanded,
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
	getStagedChangeCount,
	getStagedConflicts,
	getStagedDiff,
	getStagedOps,
	reloadModelStore,
	StagedUnreadableError,
	stagedSettled,
	validateAll
} from '../model.svelte';
import * as model from '../model.svelte';
import type { ModelOp } from '../ops';
import {
	getReplicaStatus,
	handReplicaFeed,
	replicaMetamodelAdopted,
	replicaSettled,
	retryReplica,
	stopReplica
} from '../replica.svelte';
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
	commits: { ops: EngineOp[]; lock_tokens: string[] }[];
	validate: unknown[];
};

/** The resources an op needs a lease on, as the server's `required_locks` names them (temp ids need none). */
function leased(op: EngineOp): string[] {
	switch (op.kind) {
		case 'create_element':
			return [];
		case 'create_relationship':
			return [op.source_id, op.target_id].filter((id) => !id.startsWith('tmp_'));
		default:
			return [op.id];
	}
}

/**
 * The checkout routes of the fake project: every body is recorded, and a
 * commit lands its ops on the project, answering with the project's response
 * text. `hold` stops a commit before it lands; `refuse` answers it 422;
 * `rebound` says the commit swapped the metamodel; `verifyLocks` answers 409
 * "required lock not held" when an op's resource is under no token sent.
 */
function routes(
	s: EngineStore,
	options: { hold?: Hold; refuse?: boolean; rebound?: boolean; verifyLocks?: boolean } = {}
): Bodies {
	const bodies: Bodies = { locks: [], release: [], preview: [], commits: [], validate: [] };
	const granted = new Map<string, string[]>();
	let tokens = 0;
	server.use(
		http.post(`${API}/locks`, async ({ request }) => {
			const body = (await request.json()) as {
				targets: { resource_id: string; mode: string }[];
				intent: string;
			};
			bodies.locks.push(body);
			const token = `t${++tokens}`;
			granted.set(
				token,
				body.targets.map((target) => target.resource_id)
			);
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
			const body = (await request.json()) as { ops: EngineOp[]; lock_tokens: string[] };
			bodies.commits.push(body);
			await options.hold?.arrive();
			if (options.refuse === true) {
				return HttpResponse.json({ detail: 'structural blocker' }, { status: 422 });
			}
			if (options.verifyLocks === true) {
				const held = new Set(body.lock_tokens.flatMap((token) => granted.get(token) ?? []));
				if (body.ops.some((op) => leased(op).some((id) => !held.has(id)))) {
					return HttpResponse.json({ detail: 'required lock not held' }, { status: 409 });
				}
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

describe('a commit whose answer the replica holds', () => {
	/** A peer's rebind as the feed hands it over: the replica freezes, the project moves past it. */
	async function peerRebind(s: EngineStore): Promise<void> {
		s.project.rebind('mm-2');
		const frozen = s.until((status) => status.phase === 'frozen');
		handReplicaFeed(
			{
				type: 'rebind',
				rev: s.project.rev,
				from_metamodel_id: 'mm-1',
				to_metamodel_id: 'mm-2',
				validation_error_count: 0
			},
			undefined
		);
		await frozen;
	}

	/** The replica, rebuilt onto the metamodel the UI adopts, at the project's head. */
	async function adopt(s: EngineStore): Promise<void> {
		const ready = s.until((status) => status.phase === 'ready' && status.rev === s.project.rev);
		replicaMetamodelAdopted();
		await ready;
		await settled(s);
	}

	/** The ids of the replica's elements whose name holds `q`. */
	async function found(s: EngineStore, q: string): Promise<string[]> {
		const page = await s.link.client.call<{ items: { id: string }[] }>('listElementsPage', { q });
		return page.items.map((item) => item.id);
	}

	const organization = (tempId: string, name: string): ModelOp => ({
		kind: 'create_element',
		temp_id: tempId,
		type_name: 'Organization',
		properties: { name }
	});

	const noDiff = () => {
		const { counts } = getStagedDiff();
		return counts.added + counts.modified + counts.deleted === 0;
	};

	it('frozen: the landed batches leave the readers, a second commit sends none of them, and the rebuilt replica holds each once', async () => {
		const s = await open();
		const bodies = routes(s);
		await ensureElements(['e_000002', 'e_000003']);
		await peerRebind(s);
		// A peer's commit past the rebind: the frozen replica follows none of it.
		feedPeer(s, [{ kind: 'update_element', id: 'e_000003', properties_patch: { name: 'peer' } }]);

		const creates = [
			organization('tmp_a', 'Alpha Org'),
			organization('tmp_b', 'Beta Org'),
			organization('tmp_c', 'Gamma Org')
		];
		for (const op of creates) emit(op);
		await settled(s);
		expect(getStagedBatchIds()).toEqual([1, 2, 3]);

		const res = await commitStaged('m', false);
		await commitApplied();
		expect(getReplicaStatus().phase).toBe('frozen');
		expect(bodies.commits[0]!.ops).toEqual(creates);

		// The replica still holds them until it applies the answer; the store shows none.
		expect((await s.link.client.call<{ id: number }[]>('staged')).map((b) => b.id)).toEqual([
			1, 2, 3
		]);
		expect(getStagedBatchIds()).toEqual([]);
		expect(getStagedOps()).toEqual([]);
		expect(getStagedChangeCount()).toBe(0);
		expect(noDiff()).toBe(true);

		// A new edit stages; a commit is refused, and posts nothing, until the answer is applied.
		emit(rename('e_000002', 'after'));
		await settled(s);
		expect(getStagedOps()).toEqual([rename('e_000002', 'after')]);
		await expect(commitStaged('m', false)).rejects.toBeInstanceOf(CommitPendingError);
		expect(bodies.commits).toHaveLength(1);
		await commitsLanded();

		await adopt(s);
		expect(await s.link.client.call('staged')).toEqual([
			{ id: 4, ops: [rename('e_000002', 'after')] }
		]);
		expect(getStagedBatchIds()).toEqual([4]);
		for (const name of ['Alpha Org', 'Beta Org', 'Gamma Org']) {
			const ids = await found(s, name);
			expect(ids).toHaveLength(1);
			expect(Object.values(res.id_map)).toContain(ids[0]);
		}

		await commitStaged('m', false);
		expect(bodies.commits).toHaveLength(2);
		expect(bodies.commits[1]!.ops).toEqual([rename('e_000002', 'after')]);
	});

	it('frozen: an update the engine would merge into a landed batch waits for the replica to drop it', async () => {
		const s = await open();
		routes(s);
		await ensureElements(['e_000002']);
		await peerRebind(s);

		emit(rename('e_000002', 'Quartz'));
		await commitStaged('m', false);
		await commitApplied();

		// Merged into the committed batch, the engine would drop it with the answer.
		emit(rename('e_000002', 'Quartzite'));
		expect(nameOf('e_000002')).toBe('Quartzite');
		expect(getStagedOps()).toEqual([rename('e_000002', 'Quartzite')]);
		expect(await s.link.client.call('staged')).toEqual([
			{ id: 1, ops: [rename('e_000002', 'Quartz')] }
		]);

		await adopt(s);
		expect(await s.link.client.call('staged')).toEqual([
			{ id: 2, ops: [rename('e_000002', 'Quartzite')] }
		]);
		expect(getStagedOps()).toEqual([rename('e_000002', 'Quartzite')]);
		expect(getStagedBatchIds()).toEqual([2]);
		expect(nameOf('e_000002')).toBe('Quartzite');
	});

	it('failed: a commit whose answer lands meanwhile is not staged again by the retry, nor sent twice', async () => {
		const s = await open();
		const held = hold();
		const bodies = routes(s, { hold: held });
		await ensureElements(['e_000001']);
		emit(rename('e_000001', 'committed name'));
		emit(organization('tmp_x', 'Delta Org'));
		await settled(s);
		expect(getStagedBatchIds()).toEqual([1, 2]);

		const committing = commitStaged('m', false);
		await held.reached;
		// While the POST is out, the replica diverges on a peer's delta and cannot be rebuilt.
		s.project.fail('snapshot', 503, 99);
		const peer = s.project.commit([
			{ kind: 'update_element', id: 'e_000002', properties_patch: { name: 'peer' } }
		]);
		const failed = s.until((status) => status.phase === 'failed');
		await s.link.client.call('applyDelta', { text: withWrongDigest(peer) });
		await failed;
		held.release();
		const res = await committing;
		await commitApplied();

		expect(getReplicaStatus().phase).toBe('failed');
		expect(getStagedBatchIds()).toEqual([]);
		expect(getStagedOps()).toEqual([]);
		expect(getStagedChangeCount()).toBe(0);
		// A commit waits for the retry: refused, nothing posted.
		await expect(commitStaged('m', false)).rejects.toBeInstanceOf(CommitPendingError);
		expect(bodies.commits).toHaveLength(1);

		s.project.fail('snapshot', 503, 0);
		const ready = s.until((status) => status.phase === 'ready');
		retryReplica();
		await ready;
		await settled(s);

		expect(await s.link.client.call('staged')).toEqual([]);
		expect(getStagedBatchIds()).toEqual([]);
		expect(getStagedOps()).toEqual([]);
		expect(await found(s, 'Delta Org')).toEqual([res.id_map['tmp_x']]);
		expect(nameOf('e_000001')).toBe('committed name');
		expect(bodies.commits).toHaveLength(1);
	});
	it('off: a commit whose answer no replica applies is not staged again by the replica that comes back', async () => {
		const s = await open();
		const held = hold();
		const bodies = routes(s, { hold: held });
		await ensureElements(['e_000001']);
		emit(rename('e_000001', 'committed name'));
		await settled(s);

		// The rename is committed; a create is staged while the POST is out.
		const committing = commitStaged('m', false);
		await held.reached;
		emit(organization('tmp_x', 'Kept Org'));
		await settled(s);
		// Meanwhile the replica diverges and its re-bootstrap finds no model: `off`.
		s.project.fail('descriptor', 404, 1);
		const peer = s.project.commit([
			{ kind: 'update_element', id: 'e_000002', properties_patch: { name: 'peer' } }
		]);
		const off = s.until((status) => status.phase === 'off');
		await s.link.client.call('applyDelta', { text: withWrongDigest(peer) });
		await off;
		held.release();
		await committing;
		expect(bodies.commits).toHaveLength(1);

		s.project.opaqueBump();
		const ready = s.until((status) => status.phase === 'ready');
		handReplicaFeed({ type: 'reset', model_rev: s.project.rev } as FeedEvent, undefined);
		await ready;
		await settled(s);

		expect(await s.link.client.call('staged')).toEqual([
			{ id: 2, ops: [organization('tmp_x', 'Kept Org')] }
		]);
		expect(getStagedOps()).toEqual([organization('tmp_x', 'Kept Org')]);
		expect(getStagedBatchIds()).toEqual([2]);
		expect(nameOf('e_000001')).toBe('committed name');
	});
});

describe('reloading the model on the engine side', () => {
	it('drops the staged edits with their leases; the next edit commits with its own', async () => {
		const s = await open();
		const bodies = routes(s, { verifyLocks: true });
		await ensureElements(['e_000002', 'e_000003']);
		await ensureCheckout([{ resource_id: 'e_000002', mode: 'exclusive' }], 'edit');
		emit(rename('e_000002', 'stale'));
		await settled(s);

		// What "Reload model" does to the model store and the lock registry.
		await reloadModelStore();
		resetCheckout();
		setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
		await settled(s);

		expect(getStagedOps()).toEqual([]);
		expect(await s.link.client.call('staged')).toEqual([]);

		await ensureElements(['e_000003']);
		await ensureCheckout([{ resource_id: 'e_000003', mode: 'exclusive' }], 'edit');
		emit(rename('e_000003', 'fresh'));
		await commitStaged('m', false);

		expect(bodies.commits).toHaveLength(1);
		expect(bodies.commits[0]!.ops).toEqual([rename('e_000003', 'fresh')]);
		expect(bodies.commits[0]!.lock_tokens).toEqual(['t2']);
	});
});

describe('the count of commits in flight', () => {
	it('a refused POST, a POST that never answers and a commit refused before posting all leave it', async () => {
		const s = await open();
		await ensureElement('e_000002');
		emit(rename('e_000002', 'Quartz'));
		await settled(s);

		routes(s, { refuse: true });
		await expect(commitStaged('m', false)).rejects.toBeInstanceOf(ValidationError);
		await commitsLanded();

		server.use(http.post(`${API}/commits`, () => HttpResponse.error()));
		await expect(commitStaged('m', false)).rejects.toThrow();
		await commitsLanded();

		const flight = s.sync.beginCommit();
		await expect(commitStaged('m', false)).rejects.toBeInstanceOf(CommitPendingError);
		flight.abandon();
		await commitsLanded();
	});
});
