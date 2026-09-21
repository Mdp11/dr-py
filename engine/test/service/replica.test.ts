import { describe, expect, it } from 'vitest';
import { Model, type ModelOp, type SnapshotHeader, type WireElement } from '../../src/index.ts';
import { family, NODE_DOC, nodeMetamodel } from '../model/fixtures.ts';
import { clone, Server } from '../working/helpers.ts';
import {
	autoHost,
	connect,
	deltaText,
	fakeHost,
	gzChunks,
	openReplica,
	refusal,
	settle,
	smartCity,
	snapshotText,
	tailText,
	type Client
} from './helpers.ts';

const rename = (id: string, name: string): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

type Progress = { event: 'progress'; task: string; done: number; total: number };

const progressOf = (client: Client, task: string) =>
	client.eventsOf('progress').filter((event) => event.task === task) as unknown as Progress[];

function nonDecreasingToTotal(events: Progress[]): void {
	expect(events.length).toBeGreaterThan(0);
	for (let i = 1; i < events.length; i++) {
		expect(events[i]!.done).toBeGreaterThanOrEqual(events[i - 1]!.done);
	}
	expect(events.at(-1)!.done).toBe(events.at(-1)!.total);
}

/** Opens, feeds and ends; answers what `end` answered, or its refusal. */
async function feed(client: Client, text: string, doc: object = NODE_DOC, projectId = 'demo') {
	await client.call('open', { project_id: projectId, metamodel: doc });
	const refusals: unknown[] = [];
	for (const bytes of gzChunks(text, 64)) {
		await client.call('chunk', { bytes }, [bytes]).catch((error: unknown) => refusals.push(error));
	}
	return client.call<SnapshotHeader>('end').catch((error: unknown) => {
		refusals.push(error);
		return refusals;
	});
}

describe('opening', () => {
	// One byte at a time is some 36,000 chunks, which Node's zlib takes seconds to inflate.
	it.each([1, 7, 1 << 16])(
		'opens a replica from gzip chunks of %i bytes',
		async (size) => {
			const client = connect();
			const { model, doc } = smartCity();
			await client.call('open', { project_id: 'demo', metamodel: doc });
			// Streamed as a shell streams them: posted as they come, not one round trip each.
			const chunks = gzChunks(snapshotText(model, { rev: 5 }), size).map((bytes) =>
				client.call('chunk', { bytes }, [bytes])
			);
			const header = await client.call<SnapshotHeader>('end');
			expect(await Promise.all(chunks)).toEqual(chunks.map(() => null));
			expect(header).toMatchObject({
				project_id: 'demo',
				rev: 5,
				elements: 1002,
				relationships: 746
			});
			expect(client.events[0]).toEqual({ event: 'replica', state: 'opening', rev: null });
			nonDecreasingToTotal(progressOf(client, 'parse'));
			nonDecreasingToTotal(progressOf(client, 'index'));
			expect(client.eventsOf('replica')).toHaveLength(1);

			const ready = client.nextEvent((event) => event.state === 'ready');
			expect(await client.call('applyTail', { text: tailText([], 5) })).toEqual({
				status: 'applied',
				rev: 5,
				applied: 0,
				diverged: false
			});
			expect(await ready).toEqual({ event: 'replica', state: 'ready', rev: 5 });
		},
		30_000
	);

	it('refuses what cannot be opened with 422, and opens afresh after', async () => {
		const client = connect();
		const text = snapshotText(family());
		const cases: [string, string, object, string][] = [
			['not a snapshot', '{"elements":[]}\n', NODE_DOC, 'not a datarover.snapshot/v2 snapshot'],
			[
				'a cut text',
				text.split('\n').slice(0, 5).join('\n') + '\n',
				NODE_DOC,
				'snapshot v2 holds 4 entity lines, its header promises 4 + 3'
			],
			['another project', text, NODE_DOC, "snapshot belongs to project 'demo', not 'other'"]
		];
		for (const [label, body, doc, detail] of cases) {
			const answer = await feed(client, body, doc, label === 'another project' ? 'other' : 'demo');
			expect(answer, label).toContainEqual({ status: 422, detail });
			// Until the next open, the failure stands.
			expect(await refusal(client.call('end'))).toEqual({ status: 422, detail });
		}
		expect(
			await refusal(client.call('open', { project_id: 'demo', metamodel: { elements: 5 } }))
		).toMatchObject({ status: 422 });
		const header = await feed(client, text);
		expect(header).toMatchObject({ elements: 4, relationships: 3 });
	});

	it('refuses chunk and end with 409 when nothing is being opened', async () => {
		const client = connect();
		const [bytes] = gzChunks('x', 64);
		expect(await refusal(client.call('chunk', { bytes }))).toEqual({
			status: 409,
			detail: 'no snapshot is being opened'
		});
		expect(await refusal(client.call('end'))).toEqual({
			status: 409,
			detail: 'no snapshot is being opened'
		});
	});

	it('replaces what was open when another open comes', async () => {
		const client = connect();
		await openReplica(client, family(), NODE_DOC, { rev: 3 });
		const { model, doc } = smartCity();
		await openReplica(client, model, doc, { rev: 9 });
		expect(await client.call<WireElement>('getElement', { id: 'e_000001' })).toMatchObject({
			id: 'e_000001',
			properties: { name: 'Organization-001' }
		});
		expect(await refusal(client.call('getElement', { id: 'a' }))).toEqual({
			status: 404,
			detail: "No element with id 'a"
		});
		expect(client.eventsOf('replica').map((event) => [event.state, event.rev])).toEqual([
			['opening', null],
			['ready', 3],
			['opening', null],
			['ready', 9]
		]);
	});

	it('answers a pending end with 409 when the replica closes', async () => {
		const client = connect();
		await client.call('open', { project_id: 'demo', metamodel: NODE_DOC });
		const [first] = gzChunks(snapshotText(family()), 20);
		await client.call('chunk', { bytes: first });
		const ending = client.call('end');
		await client.call('close');
		expect(await refusal(ending)).toEqual({ status: 409, detail: 'replica closed' });
		expect(client.eventsOf('replica').at(-1)).toEqual({
			event: 'replica',
			state: 'opening',
			rev: null
		});
	});

	it('never lets a slice of an open pass 16 ms', async () => {
		const host = autoHost(1);
		const client = connect(host);
		const model = new Model(nodeMetamodel());
		for (let i = 0; i < 12_000; i++) model.createElement('Node', `n${i}`);
		for (let i = 0; i < 3_000; i++) model.connect('Contains', `n${i}`, `n${i + 1}`, `r${i}`);
		await openReplica(client, model, NODE_DOC);
		expect(host.slices.length).toBeGreaterThan(5);
		expect(Math.max(...host.slices)).toBeLessThanOrEqual(16);
	});
});

describe('following the server', () => {
	async function ready() {
		const committed = family();
		const server = new Server(clone(committed));
		const client = connect();
		await openReplica(client, committed, NODE_DOC);
		return { server, client };
	}

	it('applies a delta, and drops it the second time', async () => {
		const { server, client } = await ready();
		const { delta } = server.commit([rename('a', 'x'), { kind: 'delete_element', id: 'd' }]);
		const changed = client.nextEvent((event) => event.event === 'changed');
		expect(await client.call('applyDelta', { text: deltaText(delta) })).toEqual({
			status: 'applied',
			rev: 1,
			diverged: false
		});
		expect(await changed).toEqual({
			event: 'changed',
			rev: 1,
			staged_version: 0,
			element_ids: ['a'],
			relationship_ids: [],
			deleted_element_ids: ['d'],
			deleted_relationship_ids: ['b-d'],
			structural: true
		});
		const events = client.events.length;
		expect(await client.call('applyDelta', { text: deltaText(delta) })).toEqual({
			status: 'duplicate',
			rev: 1,
			diverged: false
		});
		server.commit([rename('a', 'y')]);
		const { delta: ahead } = server.commit([rename('a', 'z')]);
		expect(await client.call('applyDelta', { text: deltaText(ahead) })).toEqual({
			status: 'gap',
			rev: 1,
			diverged: false
		});
		await settle();
		expect(client.events.length).toBe(events);
		expect(await client.call('getElement', { id: 'a' })).toMatchObject({
			properties: { name: 'x' }
		});
	});

	it('refuses a delta before ready and while diverged, and a tail before end', async () => {
		const client = connect();
		const committed = family();
		const server = new Server(clone(committed));
		const { delta } = server.commit([rename('a', 'x')]);
		expect(await refusal(client.call('applyDelta', { text: deltaText(delta) }))).toEqual({
			status: 409,
			detail: 'replica is not ready'
		});
		expect(await refusal(client.call('applyTail', { text: tailText([]) }))).toMatchObject({
			status: 409
		});
		await openReplica(client, committed, NODE_DOC);
		await client.call('applyDelta', {
			text: deltaText({ ...delta, state_digest: '0'.repeat(16) })
		});
		const { delta: next } = server.commit([rename('a', 'y')]);
		expect(await refusal(client.call('applyDelta', { text: deltaText(next) }))).toEqual({
			status: 409,
			detail: 'replica is not ready'
		});
		expect(await refusal(client.call('applyTail', { text: tailText([next], 1) }))).toMatchObject({
			status: 409
		});
	});

	it('catches a ready replica up with a tail', async () => {
		const host = autoHost(10);
		const committed = family();
		const server = new Server(clone(committed));
		const client = connect(host);
		await openReplica(client, committed, NODE_DOC);
		const deltas = [
			server.commit([rename('a', '1')]).delta,
			server.commit([rename('b', '2')]).delta,
			server.commit([rename('c', '3')]).delta
		];
		expect(await client.call('applyTail', { text: tailText(deltas, 0) })).toEqual({
			status: 'applied',
			rev: 3,
			applied: 3,
			diverged: false
		});
		expect(client.eventsOf('changed').map((event) => [event.rev, event.element_ids])).toEqual([
			[1, ['a']],
			[2, ['b']],
			[3, ['c']]
		]);
		expect(progressOf(client, 'tail').map(({ done, total }) => [done, total])).toEqual([
			[1, 3],
			[2, 3],
			[3, 3]
		]);
		// Starting behind the replica: the duplicates are skipped.
		const more = [...deltas, server.commit([rename('d', '4')]).delta];
		expect(await client.call('applyTail', { text: tailText(more, 0) })).toMatchObject({
			status: 'applied',
			rev: 4,
			applied: 1
		});
		// Starting ahead of it: a gap, and nothing moves.
		server.commit([rename('a', '5')]);
		const far = [server.commit([rename('a', '6')]).delta];
		expect(await client.call('applyTail', { text: tailText(far, 5) })).toEqual({
			status: 'gap',
			rev: 4,
			applied: 0,
			diverged: false
		});
	});

	it("takes the user's own commit, echo first too", async () => {
		const { server, client } = await ready();
		const mine = await client.call<{ batch: { id: number } }>('stage', {
			ops: [{ kind: 'create_element', temp_id: 'tmp_e', type_name: 'Node', properties: {} }]
		});
		await client.call('stage', {
			ops: [{ kind: 'update_element', id: 'a', properties_patch: { peer: 'tmp_e' } }]
		});
		const { delta, result } = server.commit([
			{ kind: 'create_element', temp_id: 'tmp_e', type_name: 'Node', properties: {} }
		]);
		const own = { batch_ids: [mine.batch.id], id_map: Object.fromEntries(result.idMap) };
		expect(await client.call('applyDelta', { text: deltaText(delta) })).toMatchObject({
			status: 'applied'
		});
		expect(await client.call('applyDelta', { text: deltaText(delta), own })).toMatchObject({
			status: 'duplicate'
		});
		expect(await client.call('staged')).toEqual([
			{ id: 2, ops: [{ kind: 'update_element', id: 'a', properties_patch: { peer: 'srv-1' } }] }
		]);
		await refusal(client.call('getElement', { id: 'tmp_e' }));
	});
});

describe('divergence, and the way back', () => {
	it('holds reads while diverged and answers them from the next replica', async () => {
		const committed = family();
		const server = new Server(clone(committed));
		const client = connect();
		await openReplica(client, committed, NODE_DOC);
		await client.call('stage', { ops: [rename('c', 'mine')] });
		const { delta } = server.commit([rename('a', 'theirs')]);
		const diverged = client.nextEvent((event) => event.state === 'diverged');
		expect(
			await client.call('applyDelta', {
				text: deltaText({ ...delta, state_digest: 'f'.repeat(16) })
			})
		).toEqual({ status: 'applied', rev: 1, diverged: true });
		expect(await diverged).toEqual({ event: 'replica', state: 'diverged', rev: 1 });

		let answered: unknown = null;
		const waiting = client.call<WireElement>('getElement', { id: 'c' }).then((element) => {
			answered = element;
			return element;
		});
		const staged = await client.call<unknown[]>('staged');
		expect(staged).toEqual([{ id: 1, ops: [rename('c', 'mine')] }]);
		await settle();
		expect(answered).toBeNull();

		await client.call('close');
		await openReplica(client, server.model, NODE_DOC, { rev: 1, adopt: staged });
		expect(await waiting).toMatchObject({ id: 'c', properties: { name: 'mine' } });
		expect(await client.call('staged')).toEqual(staged);
		expect(await client.call('getElement', { id: 'a' })).toMatchObject({
			properties: { name: 'theirs' }
		});
	});
});

describe('the digest check in the background', () => {
	it('runs to its total once ready', async () => {
		const client = connect();
		const { model, doc } = smartCity();
		await openReplica(client, model, doc);
		await client.call('staged');
		await settle();
		const verify = progressOf(client, 'verify');
		expect(verify[0]).toMatchObject({ done: 0 });
		nonDecreasingToTotal(verify);
		expect(client.eventsOf('replica').at(-1)).toMatchObject({ state: 'ready' });
	});

	it('finds a header whose digest is wrong', async () => {
		const client = connect();
		const diverged = client.nextEvent((event) => event.state === 'diverged');
		await openReplica(client, family(), NODE_DOC, { digest: 'f'.repeat(16) });
		expect(await diverged).toEqual({ event: 'replica', state: 'diverged', rev: 0 });
	});

	it('starts over after a stage, and still ends true; an unstage of nothing does not restart it', async () => {
		const host = fakeHost({ tick: 8 });
		host.auto = true;
		const client = connect(host);
		const { model, doc } = smartCity();
		await openReplica(client, model, doc);
		host.auto = false;
		const turn = async () => {
			host.turn();
			await settle();
		};
		await settle();
		// The check has begun: it reported 0 and ended a slice.
		expect(progressOf(client, 'verify').map((event) => event.done)).toEqual([0]);
		const staging = client.call('stage', { ops: [rename('e_000001', 'x')] });
		await turn();
		await staging;
		const unstaging = client.call('unstage', { what: { batch: 99 } });
		for (let i = 0; i < 10; i++) await turn();
		await unstaging;
		const dones = progressOf(client, 'verify').map((event) => event.done);
		expect(dones.filter((done) => done === 0)).toHaveLength(2);
		expect(dones.at(-1)).toBe(progressOf(client, 'verify').at(-1)!.total);
		expect(client.eventsOf('replica').at(-1)).toMatchObject({ state: 'ready' });
	});
});
