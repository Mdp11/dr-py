import { describe, expect, it } from 'vitest';
import {
	compareSteps,
	drain,
	Model,
	modelLines,
	type CompareAnswer,
	type Delta
} from '../../src/index.ts';
import { nodeMetamodel, NODE_DOC } from '../model/fixtures.ts';
import { clone, Server, workingCopy } from '../working/helpers.ts';
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

type Event = Client['events'][number];

const CREATED_AT = '2026-09-29T10:00:00.000Z';

/** A model file holding `model`'s entities, in its order, as the text a user uploads. */
function fileText(model: Model, drop = 0): string {
	const lines = modelLines(model);
	const elements = lines.slice(0, model.elementCount);
	const relationships = lines.slice(model.elementCount, lines.length - drop);
	return `{"elements": [${elements.join(', ')}], "relationships": [${relationships.join(', ')}]}`;
}

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

/** The answer computed directly over a working copy of `model` at `rev`. */
const direct = (model: Model, rev: number, file: ArrayBuffer) =>
	drain(compareSteps(workingCopy(clone(model), rev), { file, created_at: CREATED_AT }));

/** How many answers `id` got. */
const answersTo = (client: Client, id: string) =>
	client.answers.filter((message) => (message as { id?: unknown }).id === id).length;

/** Resolves once the background digest check and the sweep of the ready replica have ended. */
async function idle(client: Client): Promise<void> {
	const ended = (task: string) => (event: Event) =>
		event.event === 'progress' && event.task === task && event.done === event.total;
	for (let turns = 0; ; turns++) {
		if (client.events.some(ended('verify')) && client.events.some(ended('sweep'))) break;
		if (turns === 10_000) throw new Error('the replica never went idle');
		await settle();
	}
	await client.call('staged');
}

const COUNT = 3_000;

/** `n0` … refers to the next, the last to the first: a compare of several steps. */
function ring(): Model {
	const model = new Model(nodeMetamodel());
	for (let i = 0; i < COUNT; i++) {
		model.setProperty(model.createElement('Node', `n${i}`), 'name', `node ${i}`);
	}
	for (let i = 0; i < COUNT; i++) model.connect('Refers', `n${i}`, `n${(i + 1) % COUNT}`, `r${i}`);
	return model;
}

/** The ring's file with one element renamed: `n1500` is `from file` there. */
const ringFile = () => bytesOf(fileText(ring()).replace('"node 1500"', '"from file"'));

/** Rewrites `from`, in place, as `to`, of the same length: what a second parse of the buffer would see. */
function overwrite(buffer: ArrayBuffer, from: string, to: string): void {
	const bytes = new Uint8Array(buffer);
	const text = new TextDecoder().decode(bytes);
	const at = new TextEncoder().encode(text.slice(0, text.indexOf(from))).length;
	bytes.set(new TextEncoder().encode(to), at);
}

/** A ready replica of the ring on a host whose turns the test ends. */
async function paused() {
	const host = fakeHost({ tick: 3 });
	host.auto = true;
	const client = connect(host);
	await openReplica(client, ring(), NODE_DOC);
	await idle(client);
	await settle();
	host.auto = false;
	return { host, client };
}

/** Opens `model` at rev 0 and makes it ready through a tail holding `deltas`: control-lane transitions. */
async function openThroughTail(client: Client, model: Model, deltas: Delta[]): Promise<void> {
	await client.call('open', { project_id: 'demo', metamodel: NODE_DOC });
	const chunks = gzChunks(snapshotText(model), 1 << 16).map((bytes) =>
		client.call('chunk', { bytes }, [bytes])
	);
	await client.call('end');
	await Promise.all(chunks);
	const ready = client.nextEvent((event) => event.event === 'replica' && event.state === 'ready');
	await client.call('applyTail', { text: tailText(deltas, 0) });
	await ready;
}

const dropLast = { kind: 'delete_relationship', id: `r${COUNT - 1}` } as const;

describe('compareModel', () => {
	it('answers the compare over the working copy, in the route’s key order', async () => {
		const client = connect(autoHost());
		const { model, doc } = smartCity();
		await openReplica(client, model, doc, { rev: 3 });
		const text = fileText(smartCity().model, 1);
		const file = bytesOf(text);

		const answer = await client.callAs<CompareAnswer>(
			'c',
			'compareModel',
			{ file, created_at: CREATED_AT },
			[file]
		);
		expect(Object.keys(answer)).toEqual([
			'model_rev',
			'cr',
			'other_element_count',
			'other_relationship_count'
		]);
		expect(answer.model_rev).toBe(3);
		expect(answer.cr['createdAt']).toBe(CREATED_AT);
		expect(answer.other_relationship_count).toBe(model.relationshipCount - 1);
		expect(JSON.stringify(answer)).toBe(
			JSON.stringify(direct(smartCity().model, 3, bytesOf(text)))
		);
	});

	it('refuses a file that is not an ArrayBuffer and a missing created_at at arrival', async () => {
		// No replica is open: a call that queued would never be answered.
		const client = connect(autoHost());
		const file = bytesOf('{}');
		expect(
			await refusal(client.call('compareModel', { file: '{}', created_at: CREATED_AT }))
		).toEqual({ status: 422, detail: 'file must be an ArrayBuffer' });
		expect(
			await refusal(
				client.call('compareModel', { file: new Uint8Array(file), created_at: CREATED_AT })
			)
		).toEqual({ status: 422, detail: 'file must be an ArrayBuffer' });
		expect(await refusal(client.call('compareModel', { file }))).toEqual({
			status: 422,
			detail: 'created_at must be a string'
		});
		expect(await refusal(client.call('compareModel', { file, created_at: '' }))).toEqual({
			status: 422,
			detail: 'created_at must be a string'
		});
	});

	it('answers a file it cannot read with the 501 the server takes over', async () => {
		const client = connect(autoHost());
		const { model, doc } = smartCity();
		await openReplica(client, model, doc);
		for (const file of [bytesOf('{"elements": ['), bytesOf('{"a": "\u0001"}')]) {
			expect(
				await refusal(client.call('compareModel', { file, created_at: CREATED_AT }, [file]))
			).toEqual({ status: 501, detail: 'reaches an unreadable file' });
		}
		const file = bytesOf('[]');
		expect(await refusal(client.call('compareModel', { file, created_at: CREATED_AT }))).toEqual({
			status: 422,
			detail: 'Model payload must be a JSON object'
		});
	});
});

describe('a compare over the scheduler', () => {
	it('answers once, from the state it began on, when a model-lane delta lands between its slices', async () => {
		const server = new Server(clone(ring()));
		const { delta } = server.commit([dropLast]);
		const { host, client } = await paused();
		const file = ringFile();

		const comparing = client.callAs<CompareAnswer>('c', 'compareModel', {
			file,
			created_at: CREATED_AT
		});
		await settle();
		expect(host.waiting).toBe(1);
		expect(answersTo(client, 'c')).toBe(0);
		const applied = client.call('applyDelta', { text: deltaText(delta) });
		await settle();
		host.auto = true;
		host.turn();
		expect(JSON.stringify(await comparing)).toBe(JSON.stringify(direct(ring(), 0, ringFile())));
		expect(await applied).toMatchObject({ status: 'applied', rev: 1 });
		await settle();
		expect(answersTo(client, 'c')).toBe(1);
	});

	it('starts over on a control-lane delta between its slices: one answer, over the new state, the file parsed once', async () => {
		const server = new Server(clone(ring()));
		const { delta } = server.commit([dropLast]);
		const { host, client } = await paused();
		const file = ringFile();

		const comparing = client.callAs<CompareAnswer>('c', 'compareModel', {
			file,
			created_at: CREATED_AT
		});
		await settle();
		// Held after its first block, which parsed the file.
		expect(host.waiting).toBe(1);
		expect(answersTo(client, 'c')).toBe(0);
		// A second parse of the buffer would read this name instead.
		overwrite(file, '"from file"', '"FROM FILE"');
		await client.call('close');
		host.auto = true;
		host.turn();
		// The delta lands on the control lane while the replica opens.
		await openThroughTail(client, ring(), [delta]);

		const answer = await comparing;
		expect(answer.model_rev).toBe(1);
		expect(JSON.stringify(answer)).toBe(JSON.stringify(direct(server.model, 1, ringFile())));
		const ops = answer.cr['ops'] as {
			elements: { modified: { after: { properties: { name: string } } }[] };
			relationships: { added: { id: string }[] };
		};
		expect(ops.relationships.added.map((r) => r.id)).toEqual([dropLast.id]);
		expect(ops.elements.modified.map((m) => m.after.properties.name)).toEqual(['from file']);
		await settle();
		expect(answersTo(client, 'c')).toBe(1);
	});

	it('never answers a cancelled compare, and answers a later one', async () => {
		const { host, client } = await paused();
		let answered = false;
		const file = ringFile();
		void client
			.callAs('c', 'compareModel', { file, created_at: CREATED_AT })
			.then(() => (answered = true));
		await settle();
		expect(host.waiting).toBe(1);
		client.cancel('c');
		const next = client.call<CompareAnswer>('compareModel', {
			file: ringFile(),
			created_at: CREATED_AT
		});
		host.auto = true;
		host.turn();
		expect(JSON.stringify(await next)).toBe(JSON.stringify(direct(ring(), 0, ringFile())));
		await settle();
		expect(answered).toBe(false);
		expect(answersTo(client, 'c')).toBe(0);
	});
});
