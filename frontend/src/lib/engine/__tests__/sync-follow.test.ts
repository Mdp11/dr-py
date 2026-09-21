import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	PyFloat,
	type DeltaResult,
	type MetamodelDoc,
	type ModelOp,
	type StageResult,
	type WireBatch,
	type WireConflict
} from '$engine';
import { server } from '$lib/api/__tests__/server';
import type { CommitAnswer, ReplicaStatus } from '../sync';
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

/** A sync of `project`, opened and `ready`. */
async function ready(project: FakeProject, overrides: SyncOverrides = {}) {
	server.use(...project.handlers());
	const over = syncOver(project, overrides);
	made.push(over);
	over.sync.open(project.projectId);
	await over.sync.settled();
	expect(over.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });
	return over;
}

const createOrganization = (tempId: string, name: string): ModelOp[] => [
	{ kind: 'create_element', temp_id: tempId, type_name: 'Organization', properties: { name } }
];

const rename = (id: string, name: string): ModelOp[] => [
	{ kind: 'update_element', id, properties_patch: { name } }
];

const last = (statuses: ReplicaStatus[]) => statuses.at(-1)!;

const runs = <T>(values: T[]): T[] =>
	values.filter((value, i) => i === 0 || values[i - 1] !== value);

/** The commit's feed frame, naming a state digest its entities do not have. */
function withWrongDigest(committed: Committed): string {
	const digest = committed.delta['state_digest'] as string;
	const wrong = (BigInt('0x' + digest) ^ 1n).toString(16).padStart(16, '0');
	const text = committed.eventText.replace(
		`"state_digest":"${digest}"`,
		`"state_digest":"${wrong}"`
	);
	expect(text).not.toBe(committed.eventText);
	return text;
}

/** The answer to the user's own commit, as the commit response states it. */
function answer(committed: Committed, patch: Partial<CommitAnswer> = {}): CommitAnswer {
	const body = JSON.parse(committed.responseText) as {
		model_rev: number;
		id_map: { [tempId: string]: string };
	};
	return {
		text: committed.responseText,
		rev: body.model_rev,
		applied: true,
		rebound: false,
		idMap: body.id_map,
		...patch
	};
}

/** Another metamodel document: the served one with one enum more. */
function otherDoc(doc: MetamodelDoc, name: string): MetamodelDoc {
	const plain = doc as unknown as { enums: { [name: string]: string[] } };
	return { ...plain, enums: { ...plain.enums, [name]: ['One'] } } as unknown as MetamodelDoc;
}

const deltaCalls = (over: ReturnType<typeof syncOver>) =>
	over.calls.filter((call) => call.method === 'applyDelta');

describe('following', () => {
	it('a delta moves the replica', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const committed = project.commit([
			{
				kind: 'update_element',
				id: 'e_000001',
				properties_patch: { description: new PyFloat(1), version: 9007199254740993n }
			}
		]);
		expect(committed.eventText).toContain('"description":1.0');
		expect(committed.eventText).toContain('"version":9007199254740993');

		over.sync.feedCommit(committed.eventText, 1);
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 1 });
		const applied = deltaCalls(over);
		expect(applied).toHaveLength(1);
		expect((applied[0]!.params as { text: string }).text).toBe(committed.eventText);
		expect(applied[0]!.params).toEqual({ text: committed.eventText });
		await expect(over.link!.client.call('getElement', { id: 'e_000001' })).resolves.toMatchObject({
			rev: 2,
			properties: { description: 1 }
		});
	});

	it('an old delta and a repeated one are dropped without a call', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const committed = project.commit(rename('e_000001', 'once'));
		over.sync.feedCommit(committed.eventText, 1);
		await over.sync.settled();
		expect(deltaCalls(over)).toHaveLength(1);

		over.sync.feedCommit(committed.eventText, 1);
		over.sync.feedCommit('{"not": "applied"}', 0);
		await over.sync.settled();
		expect(deltaCalls(over)).toHaveLength(1);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 1 });
	});

	it('a gap is healed by the tail', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const urls: string[] = [];
		server.events.on('request:start', ({ request }) => void urls.push(request.url));
		project.silentCommit(rename('e_000001', 'silent'));
		const loud = project.commit(rename('e_000002', 'loud'));

		over.sync.feedCommit(loud.eventText, 2);
		await over.sync.settled();

		expect(deltaCalls(over).map((call) => (call.result as DeltaResult).status)).toEqual(['gap']);
		const tails = urls.filter((url) => url.includes('/replica/tail'));
		expect(tails).toHaveLength(1);
		expect(new URL(tails[0]!).searchParams.get('from_rev')).toBe('0');
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2 });
		const client = over.link!.client;
		await expect(client.call('getElement', { id: 'e_000001' })).resolves.toMatchObject({
			properties: { name: 'silent' }
		});
		await expect(client.call('getElement', { id: 'e_000002' })).resolves.toMatchObject({
			properties: { name: 'loud' }
		});
	});

	it('an incomplete tail re-bootstraps', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const readyAt = over.calls.length;
		const seen = over.statuses.length;
		project.opaqueBump();
		const committed = project.commit(rename('e_000001', 'after the bump'));

		over.sync.feedCommit(committed.eventText, 2);
		await over.sync.settled();

		expect(runs(over.statuses.slice(seen).map((s) => s.phase))).toEqual(['resyncing', 'ready']);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2, source: 'network' });
		const after = over.methods().slice(readyAt);
		expect(after.indexOf('close')).toBeGreaterThan(-1);
		expect(after.indexOf('close')).toBeLessThan(after.indexOf('open'));
		expect(project.requests.snapshot).toBe(2);
		await expect(over.link!.client.call('getElement', { id: 'e_000001' })).resolves.toMatchObject({
			properties: { name: 'after the bump' }
		});
	});

	it('divergence, and the way back', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const client = over.link!.client;
		await client.call<StageResult>('stage', { ops: rename('e_000001', 'staged name') });
		await client.call<StageResult>('stage', { ops: createOrganization('tmp_x', 'staged org') });
		const before = await client.call<WireBatch[]>('staged');
		expect(before).toHaveLength(2);
		const committed = project.commit(rename('e_000002', 'peer'));
		const held = hold();
		// Registered last, so it is asked first: the re-bootstrap's download waits.
		server.use(...project.handlers({ hold: held }));
		const fedAt = over.calls.length;

		over.sync.feedCommit(withWrongDigest(committed), 1);
		await held.reached;
		expect(over.sync.status().phase).toBe('resyncing');
		let answeredIn: string | null = null;
		const read = client.call('getElement', { id: 'e_000001' }).then((element) => {
			answeredIn = over.sync.status().phase;
			return element;
		});
		held.release();
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 1 });
		await expect(read).resolves.toMatchObject({ properties: { name: 'staged name' } });
		expect(answeredIn).toBe('ready');
		// The engine's event and the delta's answer both report the divergence: one re-bootstrap.
		const after = over.methods().slice(fedAt);
		expect(after.filter((method) => method === 'staged')).toHaveLength(1);
		expect(after.filter((method) => method === 'close')).toHaveLength(1);
		expect(await client.call<WireBatch[]>('staged')).toEqual(before);
		await expect(client.call('getElement', { id: 'e_000002' })).resolves.toMatchObject({
			properties: { name: 'peer' }
		});
		await expect(client.call('getElement', { id: 'tmp_x' })).resolves.toMatchObject({
			properties: { name: 'staged org' }
		});
	});

	it('a parked batch crosses too', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const client = over.link!.client;
		const staged = await client.call<StageResult>('stage', {
			ops: [{ kind: 'update_element', id: 'e_000003', properties_patch: { description: 'mine' } }]
		});
		const deleted = project.commit([{ kind: 'delete_element', id: 'e_000003' }]);
		over.sync.feedCommit(deleted.eventText, 1);
		await over.sync.settled();
		const parked = await client.call<WireConflict[]>('conflicts');
		expect(parked.map((conflict) => conflict.batch.id)).toEqual([staged.batch.id]);

		const committed = project.commit(rename('e_000004', 'forces a re-bootstrap'));
		over.sync.feedCommit(withWrongDigest(committed), 2);
		await over.sync.settled();

		expect(over.statuses.some((s) => s.phase === 'resyncing')).toBe(true);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2 });
		const after = await client.call<WireConflict[]>('conflicts');
		expect(after.map((conflict) => conflict.batch)).toEqual(parked.map((c) => c.batch));
		expect(await client.call<WireBatch[]>('staged')).toEqual([]);
	});

	it('the background check can end the replica', async () => {
		const project = fakeProject();
		project.wrongDigestInNextSnapshot();
		const over = await ready(project);
		await over.until((s) => s.phase === 'resyncing');
		const resyncing = over.statuses.findIndex((s) => s.phase === 'resyncing');
		await over.until((s) => s.phase === 'ready', resyncing);
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 0, source: 'network' });
		expect(project.requests.snapshot).toBe(2);
		// The bytes the replica diverged from are cached no more; the good ones are.
		const good = new Uint8Array(project.snapshot().bytes);
		const cached = await over.cache.get(project.projectId, 0);
		expect(cached === null ? null : [...new Uint8Array(cached)]).toEqual([...good]);
	});

	it('a reconnect that is ahead catches up', async () => {
		const project = fakeProject();
		const over = await ready(project);
		project.silentCommit(rename('e_000001', 'one'));
		project.silentCommit(rename('e_000002', 'two'));

		over.sync.feedSnapshot(2);
		await over.sync.settled();
		expect(project.requests.tail).toBe(2);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2 });

		over.sync.feedSnapshot(2);
		await over.sync.settled();
		expect(project.requests.tail).toBe(2);
		expect(deltaCalls(over)).toHaveLength(0);
	});
});

describe('the commit in flight', () => {
	it('the echo first', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const flight = over.sync.beginCommit();
		const own = project.commit(createOrganization('tmp_a', 'own'));
		over.sync.feedCommit(own.eventText, 1);
		await over.sync.settled();
		expect(deltaCalls(over)).toHaveLength(0);

		const settled = answer(own);
		expect(settled.idMap).toEqual({ tmp_a: 'srv-1' });
		flight.settle(settled);
		await over.sync.settled();

		expect(deltaCalls(over).map((call) => call.params)).toEqual([
			{ text: own.responseText, own: { batch_ids: [], id_map: { tmp_a: 'srv-1' } } }
		]);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 1 });
		await expect(over.link!.client.call('getElement', { id: 'srv-1' })).resolves.toMatchObject({
			properties: { name: 'own' }
		});
	});

	it.each([
		['the echo, then the peer', true],
		['the peer, then the echo', false]
	])("a peer's commit lands first — %s", async (_, echoFirst) => {
		const project = fakeProject();
		const over = await ready(project);
		const flight = over.sync.beginCommit();
		const peer = project.commit(rename('e_000002', 'peer'));
		const own = project.commit(createOrganization('tmp_a', 'own'));
		if (echoFirst) {
			over.sync.feedCommit(own.eventText, 2);
			over.sync.feedCommit(peer.eventText, 1);
		} else {
			over.sync.feedCommit(peer.eventText, 1);
			over.sync.feedCommit(own.eventText, 2);
		}
		await over.sync.settled();
		expect(deltaCalls(over)).toHaveLength(0);

		flight.settle(answer(own));
		await over.sync.settled();

		expect(deltaCalls(over).map((call) => call.params)).toEqual([
			{ text: peer.eventText },
			{ text: own.responseText, own: { batch_ids: [], id_map: { tmp_a: 'srv-1' } } }
		]);
		expect(deltaCalls(over).map((call) => (call.result as DeltaResult).status)).toEqual([
			'applied',
			'applied'
		]);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2 });
	});

	it('a response the tail already covered still goes to the engine', async () => {
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const over = syncOver(project);
		made.push(over);
		over.sync.open(project.projectId);
		await held.reached;
		const flight = over.sync.beginCommit();
		const own = project.commit(createOrganization('tmp_a', 'own'));
		flight.settle(answer(own));
		held.release();
		await over.sync.settled();

		const applied = deltaCalls(over);
		expect(applied.map((call) => call.params)).toEqual([
			{ text: own.responseText, own: { batch_ids: [], id_map: { tmp_a: 'srv-1' } } }
		]);
		expect(applied[0]!.result).toMatchObject({ status: 'duplicate', rev: 1 });
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 1 });
	});

	it('a response past a gap goes again once the tail has healed it', async () => {
		const project = fakeProject();
		const over = await ready(project);
		project.silentCommit(rename('e_000002', 'silent'));
		const flight = over.sync.beginCommit();
		const own = project.commit(createOrganization('tmp_a', 'own'));
		flight.settle(answer(own));
		await over.sync.settled();

		const applied = deltaCalls(over);
		const ownParams = {
			text: own.responseText,
			own: { batch_ids: [], id_map: { tmp_a: 'srv-1' } }
		};
		expect(applied.map((call) => call.params)).toEqual([ownParams, ownParams]);
		expect(applied.map((call) => (call.result as DeltaResult).status)).toEqual([
			'gap',
			'duplicate'
		]);
		expect(project.requests.tail).toBe(2);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2 });
	});

	it('a response that applied nothing queues nothing', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const flight = over.sync.beginCommit();
		flight.settle({ text: '{}', rev: 0, applied: false, rebound: false, idMap: {} });
		await over.sync.settled();
		expect(deltaCalls(over)).toHaveLength(0);

		// The pump goes on.
		const peer = project.commit(rename('e_000002', 'peer'));
		over.sync.feedCommit(peer.eventText, 1);
		await over.sync.settled();
		expect(deltaCalls(over).map((call) => call.params)).toEqual([{ text: peer.eventText }]);
	});

	it('abandon lets the pump go', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const flight = over.sync.beginCommit();
		const peer = project.commit(rename('e_000002', 'peer'));
		over.sync.feedCommit(peer.eventText, 1);
		await over.sync.settled();
		expect(deltaCalls(over)).toHaveLength(0);

		flight.abandon();
		await over.sync.settled();
		expect(deltaCalls(over).map((call) => call.params)).toEqual([{ text: peer.eventText }]);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 1 });
	});

	it('settling twice is a no-op', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const flight = over.sync.beginCommit();
		const own = project.commit(createOrganization('tmp_a', 'own'));
		flight.settle(answer(own));
		flight.settle(answer(own));
		flight.abandon();
		await over.sync.settled();
		expect(deltaCalls(over)).toHaveLength(1);

		// A second flight still holds the pump: the first one's count did not go negative.
		const second = over.sync.beginCommit();
		const peer = project.commit(rename('e_000002', 'peer'));
		over.sync.feedCommit(peer.eventText, 2);
		await over.sync.settled();
		expect(deltaCalls(over)).toHaveLength(1);
		second.abandon();
		await over.sync.settled();
		expect(deltaCalls(over)).toHaveLength(2);
	});
});

describe('the rebind', () => {
	it('an own rebind freezes', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const flight = over.sync.beginCommit();
		project.rebind('mm-2', otherDoc(project.doc, 'Extra'));
		flight.settle({ text: '{}', rev: project.rev, applied: true, rebound: true, idMap: {} });
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({
			phase: 'frozen',
			reason: 'metamodel changed at rev 1'
		});
		expect(deltaCalls(over)).toHaveLength(0);
	});

	it("a peer's rebind freezes, and adoption thaws", async () => {
		const project = fakeProject();
		const over = await ready(project);
		const next = otherDoc(project.doc, 'Extra');
		project.rebind('mm-2', next);
		over.sync.feedRebind(1);
		expect(over.sync.status()).toMatchObject({
			phase: 'frozen',
			reason: 'metamodel changed at rev 1'
		});

		const later = project.commit(rename('e_000001', 'under mm-2'));
		over.sync.feedCommit(later.eventText, 2);
		await over.sync.settled();
		expect(deltaCalls(over)).toHaveLength(0);
		expect(over.sync.status().phase).toBe('frozen');

		const seen = over.statuses.length;
		over.sync.metamodelAdopted();
		await over.sync.settled();
		expect(runs(over.statuses.slice(seen).map((s) => s.phase))).toEqual(['resyncing', 'ready']);
		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2 });
		const opens = over.calls.filter((call) => call.method === 'open');
		expect((opens.at(-1)!.params as { metamodel: unknown }).metamodel).toEqual(next);
		await expect(over.link!.client.call('getElement', { id: 'e_000001' })).resolves.toMatchObject({
			properties: { name: 'under mm-2' }
		});

		const calls = over.calls.length;
		const statuses = over.statuses.length;
		over.sync.metamodelAdopted();
		await over.sync.settled();
		expect(over.calls).toHaveLength(calls);
		expect(over.statuses).toHaveLength(statuses);
	});
});

describe('re-bootstraps', () => {
	it('three failed re-bootstraps are failed, not server', async () => {
		const project = fakeProject();
		const over = await ready(project);
		project.fail('snapshot', 503, 99);
		const committed = project.commit(rename('e_000001', 'x'));
		over.sync.feedCommit(withWrongDigest(committed), 1);
		await over.sync.settled();

		expect(over.sleeps).toEqual([1000, 3000]);
		expect(last(over.statuses)).toMatchObject({
			phase: 'failed',
			attempt: 0,
			reason: 'snapshot failed'
		});

		const calls = over.calls.length;
		const requests = { ...project.requests };
		const later = project.commit(rename('e_000002', 'y'));
		over.sync.feedCommit(later.eventText, 2);
		over.sync.feedSnapshot(9);
		await over.sync.settled();
		expect(over.calls).toHaveLength(calls);
		expect(project.requests).toEqual(requests);
		expect(over.sync.status().phase).toBe('failed');
	});

	it('a re-bootstrap asked for during one runs once more, after it', async () => {
		const project = fakeProject();
		const over = await ready(project);
		const client = over.link!.client;
		await client.call<StageResult>('stage', { ops: rename('e_000001', 'staged name') });
		const staged = await client.call<WireBatch[]>('staged');
		const readyAt = over.calls.length;
		const held = hold();
		// Registered last, so it is asked first: the first re-bootstrap's download waits.
		server.use(...project.handlers({ hold: held }));

		project.rebind('mm-2', otherDoc(project.doc, 'Second'));
		over.sync.feedRebind(1);
		over.sync.metamodelAdopted();
		await held.reached;
		const third = otherDoc(project.doc, 'Third');
		project.rebind('mm-3', third);
		// The first re-bootstrap ends at its next step, but has not ended yet.
		over.sync.feedRebind(2);
		over.sync.metamodelAdopted();
		expect(over.sync.status().phase).toBe('resyncing');
		held.release();
		await over.sync.settled();

		expect(last(over.statuses)).toMatchObject({ phase: 'ready', rev: 2 });
		expect(over.sleeps).toEqual([]);
		const after = over.methods().slice(readyAt);
		// One read of the staged batches, then two opens one after the other, one adoption.
		expect(after.filter((method) => method === 'staged')).toHaveLength(1);
		expect(after.filter((method) => method === 'open')).toHaveLength(2);
		expect(after.filter((method) => method === 'adoptStaged')).toHaveLength(1);
		expect(after.filter((method) => method === 'applyTail')).toHaveLength(1);
		const second = after.lastIndexOf('open');
		expect(after.lastIndexOf('close')).toBe(second - 1);
		expect(after.indexOf('open')).toBeLessThan(after.lastIndexOf('close'));
		const opens = over.calls.filter((call) => call.method === 'open');
		expect((opens.at(-1)!.params as { metamodel: unknown }).metamodel).toEqual(third);
		// The batches the interrupted re-bootstrap took crossed into the replica that came.
		expect(await client.call<WireBatch[]>('staged')).toEqual(staged);
	});
});
