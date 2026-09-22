import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ModelOp, ModelSummary, StageResult, WireBatch } from '$engine';
import { server } from '$lib/api/__tests__/server';
import { FrameError } from '../frame';
import type { ReplicaStatus } from '../sync';
import {
	fakeProject,
	syncOver,
	type Committed,
	type FakeProject,
	type SyncOverrides
} from './support/project-server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const made: ReturnType<typeof syncOver>[] = [];

afterEach(() => {
	for (const over of made.splice(0)) over.dispose();
	server.resetHandlers();
	server.events.removeAllListeners();
});

function open(project: FakeProject, overrides: SyncOverrides = {}) {
	server.use(...project.handlers());
	const over = syncOver(project, overrides);
	made.push(over);
	over.sync.open(project.projectId);
	return over;
}

/** A sync of `project`, opened and `ready`. */
async function ready(project: FakeProject, overrides: SyncOverrides = {}) {
	const over = open(project, overrides);
	await over.sync.settled();
	expect(over.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
	return over;
}

/** A sync of `project` that found no model: `off`. The next descriptor answers. */
async function off(project: FakeProject) {
	project.fail('descriptor', 404, 1);
	const over = open(project);
	await over.sync.settled();
	expect(over.sync.status()).toMatchObject({ phase: 'off', reason: 'no model' });
	return over;
}

const rename = (id: string, name: string): ModelOp[] => [
	{ kind: 'update_element', id, properties_patch: { name } }
];

const createOrganization = (tempId: string, name: string): ModelOp[] => [
	{ kind: 'create_element', temp_id: tempId, type_name: 'Organization', properties: { name } }
];

/** The feed frame of `committed`, its state digest flipped: the replica diverges on it. */
function withWrongDigest(committed: Committed): string {
	const digest = committed.delta['state_digest'] as string;
	const wrong = (BigInt('0x' + digest) ^ 1n).toString(16).padStart(16, '0');
	return committed.eventText.replace(`"state_digest":"${digest}"`, `"state_digest":"${wrong}"`);
}

const last = (statuses: ReplicaStatus[]) => statuses.at(-1)!;

const runs = <T>(values: T[]): T[] =>
	values.filter((value, i) => i === 0 || values[i - 1] !== value);

/** Whether `promise` has settled once the microtasks and a macrotask have run. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	promise.then(
		() => (settled = true),
		() => (settled = true)
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return !settled;
}

/** Ready, two batches staged, then a divergence whose re-bootstrap cannot download: `failed`. */
async function failedWithEdits(project: FakeProject) {
	const over = await ready(project);
	const client = over.link!.client;
	await client.call<StageResult>('stage', { ops: rename('e_000001', 'staged name') });
	await client.call<StageResult>('stage', { ops: createOrganization('tmp_x', 'staged org') });
	const staged = await client.call<WireBatch[]>('staged');
	expect(staged).toHaveLength(2);
	project.fail('snapshot', 503, 99);
	const committed = project.commit(rename('e_000002', 'peer'));
	over.sync.feedCommit(withWrongDigest(committed), 1);
	await over.sync.settled();
	expect(last(over.statuses)).toMatchObject({ phase: 'failed', reason: 'snapshot failed' });
	expect(over.sleeps).toEqual([1000, 3000]);
	return { over, staged };
}

describe('retry', () => {
	it('retry rebuilds a failed replica with the edits it held', async () => {
		const project = fakeProject();
		const { over, staged } = await failedWithEdits(project);
		const client = over.link!.client;
		const seen = over.statuses.length;
		const slept = over.sleeps.length;
		const connects = over.connects;
		// Two more failures: the retry has a whole budget of its own.
		project.fail('snapshot', 503, 2);

		over.sync.retry();
		expect(over.sync.status()).toMatchObject({ phase: 'resyncing', attempt: 1 });
		await over.sync.settled();

		const after = over.statuses.slice(seen);
		expect(runs(after.map((s) => s.phase))).toEqual(['resyncing', 'ready']);
		expect(runs(after.filter((s) => s.phase === 'resyncing').map((s) => s.attempt))).toEqual([
			1, 2, 3
		]);
		expect(over.sleeps.slice(slept)).toEqual([1000, 3000]);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: project.rev, attempt: 0 });
		expect(over.connects).toBe(connects);
		expect(await client.call<WireBatch[]>('staged')).toEqual(staged);
		await expect(client.call('getElement', { id: 'e_000002' })).resolves.toMatchObject({
			properties: { name: 'peer' }
		});
		await expect(client.call('getElement', { id: 'tmp_x' })).resolves.toMatchObject({
			properties: { name: 'staged org' }
		});
	});

	it('retry does nothing unless failed', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const calls = over.calls.length;
		const statuses = over.statuses.length;
		const requests = { ...project.requests };

		over.sync.retry();
		await over.sync.settled();

		expect(over.calls).toHaveLength(calls);
		expect(over.statuses).toHaveLength(statuses);
		expect(project.requests).toEqual(requests);
	});

	it('a read asked while failed is answered after the retry', async () => {
		const project = fakeProject();
		const { over } = await failedWithEdits(project);
		const read = over.sync.call<ModelSummary>('getModelSummary');
		expect(await pending(read)).toBe(true);

		project.fail('snapshot', 503, 0);
		over.sync.retry();
		await over.sync.settled();

		await expect(read).resolves.toMatchObject({ model_rev: project.rev });
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 1 });
	});
});

describe('reset', () => {
	it('a reset re-bootstraps', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const seen = over.statuses.length;
		const urls: string[] = [];
		server.events.on('request:start', ({ request }) => void urls.push(request.url));
		project.opaqueBump();

		over.sync.feedReset(project.rev);
		const read = over.sync.call<ModelSummary>('getModelSummary');
		await over.sync.settled();

		const tails = urls.filter((url) => url.includes('/replica/tail'));
		// The catch-up's (incomplete), then the fresh snapshot's own.
		expect(tails.map((url) => new URL(url).searchParams.get('from_rev'))).toEqual(['0', '1']);
		expect(runs(over.statuses.slice(seen).map((s) => s.phase))).toEqual(['resyncing', 'ready']);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 1, source: 'network' });
		expect(project.requests.snapshot).toBe(2);
		expect(over.sleeps).toEqual([]);
		await expect(read).resolves.toMatchObject({ model_rev: 1 });
	});

	it('a reset at or below the replica does nothing', async () => {
		const project = fakeProject({ rev: 3 });
		const over = await ready(project);
		const calls = over.calls.length;
		const requests = { ...project.requests };

		over.sync.feedReset(3);
		over.sync.feedReset(2);
		await over.sync.settled();

		expect(over.calls).toHaveLength(calls);
		expect(project.requests).toEqual(requests);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 3 });
	});
});

describe('waking from off', () => {
	it('off wakes on a reset', async () => {
		const project = fakeProject();
		const over = await off(project);
		const seen = over.statuses.length;
		project.opaqueBump();

		over.sync.feedReset(project.rev);
		expect(over.sync.status()).toMatchObject({ phase: 'opening', attempt: 1, reason: null });
		await over.sync.settled();

		expect(runs(over.statuses.slice(seen).map((s) => s.phase))).toEqual(['opening', 'ready']);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 1 });
		expect(over.connects).toBe(1);
	});

	it('off wakes on a snapshot event', async () => {
		const project = fakeProject();
		const over = await off(project);
		const seen = over.statuses.length;
		project.opaqueBump();

		over.sync.feedSnapshot(project.rev);
		await over.sync.settled();

		expect(runs(over.statuses.slice(seen).map((s) => s.phase))).toEqual(['opening', 'ready']);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 1 });
	});

	it('a replica that lost its model keeps its edits for the one that comes back', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const client = over.link!.client;
		await client.call<StageResult>('stage', { ops: rename('e_000001', 'staged name') });
		const staged = await client.call<WireBatch[]>('staged');
		project.fail('descriptor', 404, 1);
		project.opaqueBump();
		over.sync.feedReset(project.rev);
		await over.sync.settled();
		expect(last(over.statuses)).toMatchObject({ phase: 'off', reason: 'no model' });

		project.opaqueBump();
		over.sync.feedReset(project.rev);
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2 });
		expect(await client.call<WireBatch[]>('staged')).toEqual(staged);
	});

	it('server wakes on neither', async () => {
		const project = fakeProject();
		const over = open(project, {
			connect: () =>
				Promise.reject(new FrameError('timeout', 'the sandbox did not answer within 10000 ms'))
		});
		await over.sync.settled();
		expect(last(over.statuses)).toMatchObject({ phase: 'server' });
		const statuses = over.statuses.length;
		const requests = { ...project.requests };
		project.opaqueBump();

		over.sync.feedReset(project.rev);
		over.sync.feedSnapshot(project.rev);
		over.sync.retry();
		await over.sync.settled();

		expect(over.statuses).toHaveLength(statuses);
		expect(project.requests).toEqual(requests);
		expect(over.connects).toBe(1);
	});
});

describe('a tail that fails while following', () => {
	/** A silent commit, then a fed delta past it: a gap the tail heals. */
	function gap(project: FakeProject, over: ReturnType<typeof syncOver>) {
		project.silentCommit(rename('e_000001', 'silent'));
		const loud = project.commit(rename('e_000002', 'loud'));
		over.sync.feedCommit(loud.eventText, 2);
	}

	it('one failed tail fetch is tried again', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const seen = over.statuses.length;
		const tails = project.requests.tail;
		project.fail('tail', 500, 1);

		gap(project, over);
		await over.sync.settled();

		expect(over.sleeps).toEqual([1000]);
		expect(over.statuses.slice(seen).every((s) => s.phase === 'ready')).toBe(true);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2 });
		expect(project.requests.tail - tails).toBe(2);
		expect(project.requests.snapshot).toBe(1);
		await expect(over.link!.client.call('getElement', { id: 'e_000001' })).resolves.toMatchObject({
			properties: { name: 'silent' }
		});
	});

	it('two failed tail fetches re-bootstrap', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const seen = over.statuses.length;
		project.fail('tail', 500, 2);

		gap(project, over);
		await over.sync.settled();

		expect(over.sleeps).toEqual([1000]);
		expect(runs(over.statuses.slice(seen).map((s) => s.phase))).toEqual(['resyncing', 'ready']);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2 });
		expect(project.requests.snapshot).toBe(2);
	});

	it('an incomplete tail does not wait', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const seen = over.statuses.length;
		project.opaqueBump();
		const committed = project.commit(rename('e_000001', 'after the bump'));

		over.sync.feedCommit(committed.eventText, 2);
		await over.sync.settled();

		expect(over.sleeps).toEqual([]);
		expect(runs(over.statuses.slice(seen).map((s) => s.phase))).toEqual(['resyncing', 'ready']);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2 });
	});
});
