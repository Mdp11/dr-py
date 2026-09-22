import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ModelOp, StageResult, WireBatch } from '$engine';
import { server } from '$lib/api/__tests__/server';
import { EngineGoneError } from '../client';
import { FrameError } from '../frame';
import type { ReplicaStatus } from '../sync';
import {
	fakeProject,
	hold,
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
	const over = syncOver(project, overrides);
	made.push(over);
	over.sync.open(project.projectId);
	return over;
}

/** A sync of `project`, opened and `ready`. */
async function ready(project: FakeProject, overrides: SyncOverrides = {}) {
	server.use(...project.handlers());
	const over = open(project, overrides);
	await over.sync.settled();
	expect(over.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
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

const last = (statuses: ReplicaStatus[]) => statuses.at(-1)!;

/** Stages `ops` through the sync as a transition. */
const stage = (over: ReturnType<typeof syncOver>, ops: ModelOp[], signal?: AbortSignal) =>
	over.sync.call<StageResult>(
		'stage',
		{ ops },
		signal === undefined ? { transition: true } : { transition: true, signal }
	);

/** Ready, two batches staged, then a divergence whose re-bootstrap cannot download: `failed`. */
async function failedWithEdits(project: FakeProject) {
	const over = await ready(project);
	const client = over.link!.client;
	await client.call<StageResult>('stage', { ops: rename('e_000001', 'staged name') });
	await client.call<StageResult>('stage', { ops: createOrganization('tmp_x', 'staged org') });
	project.fail('snapshot', 503, 99);
	const committed = project.commit(rename('e_000002', 'peer'));
	over.sync.feedCommit(withWrongDigest(committed), 1);
	await over.sync.settled();
	expect(last(over.statuses)).toMatchObject({ phase: 'failed' });
	return over;
}

describe('transitions', () => {
	it('a transition posts at once while ready whatever known is', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const flight = over.sync.beginCommit();
		const peer = project.commit(rename('e_000002', 'peer'));
		over.sync.feedCommit(peer.eventText, 1);

		const staged = await stage(over, rename('e_000001', 'staged'));

		expect(staged.batch.id).toBe(1);
		expect(over.sync.status().rev).toBe(0);
		expect(over.methods()).not.toContain('applyDelta');

		flight.abandon();
		await over.sync.settled();
		const methods = over.methods();
		expect(methods.indexOf('stage')).toBeLessThan(methods.indexOf('applyDelta'));
		expect(over.sync.status().rev).toBe(1);
	});

	it('a read asked after a transition is posted after it', async () => {
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const over = open(project);
		await held.reached;

		const staged = stage(over, rename('e_000001', 'staged'));
		const read = over.sync.call('getElement', { id: 'e_000001' });
		expect(await pending(staged)).toBe(true);
		expect(await pending(read)).toBe(true);
		held.release();

		await expect(staged).resolves.toMatchObject({ batch: { id: 1 } });
		await expect(read).resolves.toMatchObject({ properties: { name: 'staged' } });
		const methods = over.methods();
		const tail = methods.indexOf('applyTail');
		expect(tail).toBeGreaterThan(-1);
		expect(methods.slice(tail)).toEqual(['applyTail', 'stage', 'getElement']);
	});

	it('a read asked after a held transition waits behind it while failed', async () => {
		const project = fakeProject();
		const over = await failedWithEdits(project);

		const staged = stage(over, rename('e_000003', 'after the failure'));
		const read = over.sync.call('getElement', { id: 'e_000003' });
		expect(await pending(staged)).toBe(true);
		expect(await pending(read)).toBe(true);
		expect(over.methods()).not.toContain('getElement');

		project.fail('snapshot', 503, 0);
		over.sync.retry();
		await over.sync.settled();

		await expect(staged).resolves.toMatchObject({ batch: { id: 3 } });
		await expect(read).resolves.toMatchObject({ properties: { name: 'after the failure' } });
		expect(over.methods().slice(-2)).toEqual(['stage', 'getElement']);
	});

	it('a read behind an aborted transition goes as it would have alone', async () => {
		const project = fakeProject();
		const over = await failedWithEdits(project);
		const controller = new AbortController();
		const staged = stage(over, rename('e_000003', 'aborted'), controller.signal);
		const read = over.sync.call('getElement', { id: 'e_000003' });
		expect(await pending(read)).toBe(true);
		expect(over.methods()).not.toContain('getElement');

		controller.abort();
		await expect(staged).rejects.toMatchObject({ name: 'AbortError' });
		// A failed replica takes a read at once; its closed engine answers after the retry.
		expect(over.methods().at(-1)).toBe('getElement');

		project.fail('snapshot', 503, 0);
		over.sync.retry();
		await over.sync.settled();
		await expect(read).resolves.toMatchObject({ id: 'e_000003' });
		expect(over.methods()).not.toContain('stage');
	});

	it('a transition waits while opening, resyncing and failed', async () => {
		// Opening: posted once the replica is ready.
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const opening = open(project);
		await held.reached;
		const first = stage(opening, rename('e_000001', 'while opening'));
		expect(await pending(first)).toBe(true);
		held.release();
		await expect(first).resolves.toMatchObject({ batch: { id: 1 } });
		const opened = opening.methods();
		expect(opened.indexOf('stage')).toBeGreaterThan(opened.indexOf('applyTail'));

		// Resyncing: posted after the held batches are adopted.
		const again = fakeProject({ projectId: 'resync' });
		const resyncing = await ready(again);
		await resyncing.link!.client.call('stage', { ops: rename('e_000001', 'held') });
		const rehold = hold();
		server.use(...again.handlers({ hold: rehold }));
		const diverging = again.commit(rename('e_000002', 'diverges'));
		resyncing.sync.feedCommit(withWrongDigest(diverging), 1);
		await rehold.reached;
		expect(resyncing.sync.status().phase).toBe('resyncing');
		const second = stage(resyncing, rename('e_000003', 'while resyncing'));
		expect(await pending(second)).toBe(true);
		rehold.release();
		await expect(second).resolves.toMatchObject({ batch: { id: 2 } });
		const resynced = resyncing.methods();
		expect(resynced.lastIndexOf('stage')).toBeGreaterThan(resynced.indexOf('adoptStaged'));
		expect(resynced.lastIndexOf('stage')).toBeGreaterThan(resynced.lastIndexOf('applyTail'));

		// Failed: posted after the retry has adopted the held batches.
		const failing = fakeProject({ projectId: 'failing' });
		const failed = await failedWithEdits(failing);
		const third = stage(failed, rename('e_000004', 'while failed'));
		expect(await pending(third)).toBe(true);
		expect(failed.methods()).not.toContain('stage');
		failing.fail('snapshot', 503, 0);
		failed.sync.retry();
		await expect(third).resolves.toMatchObject({ batch: { id: 3 } });
		const retried = failed.methods();
		expect(retried.lastIndexOf('stage')).toBeGreaterThan(retried.lastIndexOf('adoptStaged'));
		expect(await failed.link!.client.call<WireBatch[]>('staged')).toHaveLength(3);
	});

	it('a transition posts while frozen', async () => {
		const project = fakeProject();
		const over = await ready(project);
		project.rebind('mm-2');
		over.sync.feedRebind(1);
		expect(over.sync.status()).toMatchObject({ phase: 'frozen', rev: 0 });

		await expect(stage(over, rename('e_000001', 'frozen'))).resolves.toMatchObject({
			batch: { id: 1 },
			coalesced: false
		});
		expect(over.methods().at(-1)).toBe('stage');
	});

	it('off and server refuse', async () => {
		const unreachable = fakeProject();
		server.use(...unreachable.handlers());
		const refused = open(unreachable, {
			connect: () => Promise.reject(new FrameError('timeout', 'no answer'))
		});
		await refused.sync.settled();
		expect(refused.sync.status().phase).toBe('server');
		await expect(stage(refused, rename('e_000001', 'x'))).rejects.toBeInstanceOf(EngineGoneError);

		const empty = fakeProject({ projectId: 'empty' });
		empty.fail('descriptor', 404, 1);
		server.use(...empty.handlers());
		const off = open(empty);
		await off.sync.settled();
		expect(off.sync.status()).toMatchObject({ phase: 'off', reason: 'no model' });
		await expect(stage(off, rename('e_000001', 'x'))).rejects.toBeInstanceOf(EngineGoneError);
		expect(off.methods()).not.toContain('stage');

		const never = syncOver(unreachable);
		made.push(never);
		await expect(stage(never, rename('e_000001', 'x'))).rejects.toBeInstanceOf(EngineGoneError);
	});

	it('a transition waiting when the open gives up is refused', async () => {
		const project = fakeProject();
		project.fail('snapshot', 503, 99);
		server.use(...project.handlers());
		const over = open(project);
		const staged = stage(over, rename('e_000001', 'x'));
		const refusal = expect(staged).rejects.toBeInstanceOf(EngineGoneError);
		await over.sync.settled();

		expect(over.sync.status().phase).toBe('server');
		await refusal;
		expect(over.methods()).not.toContain('stage');
	});

	it('stop refuses the waiter', async () => {
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const over = open(project);
		await held.reached;
		const staged = stage(over, rename('e_000001', 'x'));

		over.sync.stop();
		await expect(staged).rejects.toBeInstanceOf(EngineGoneError);
		held.release();
		await over.sync.settled();
		expect(over.methods()).not.toContain('stage');
	});

	it('an aborted transition posts nothing', async () => {
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const over = open(project);
		await held.reached;
		const controller = new AbortController();
		const staged = stage(over, rename('e_000001', 'x'), controller.signal);
		const read = over.sync.call('getElement', { id: 'e_000001' });
		controller.abort();
		await expect(staged).rejects.toMatchObject({ name: 'AbortError' });

		held.release();
		await over.sync.settled();
		expect(over.sync.status().phase).toBe('ready');
		await expect(read).resolves.toMatchObject({ id: 'e_000001' });
		expect(over.methods()).not.toContain('stage');

		const early = new AbortController();
		early.abort();
		await expect(stage(over, rename('e_000001', 'x'), early.signal)).rejects.toMatchObject({
			name: 'AbortError'
		});
		expect(over.methods()).not.toContain('stage');
	});
});
