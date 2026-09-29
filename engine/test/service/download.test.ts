import { describe, expect, it } from 'vitest';
import { drain, Model, modelFileSteps, type ModelFile, type ModelOp } from '../../src/index.ts';
import { fileText } from '../download/helpers.ts';
import { nodeMetamodel, NODE_DOC } from '../model/fixtures.ts';
import { clone, Server, workingCopy } from '../working/helpers.ts';
import {
	autoHost,
	connect,
	deltaText,
	fakeHost,
	openReplica,
	portPair,
	recording,
	settle,
	smartCity,
	type Client,
	type Post
} from './helpers.ts';

type Event = Client['events'][number];

/** The model file of `model` as committed, computed directly. */
const direct = (model: Model) => fileText(drain(modelFileSteps(workingCopy(clone(model)))));

/** How many answers `id` got. */
const answersTo = (client: Client, id: string) =>
	client.answers.filter((message) => (message as { id?: unknown }).id === id).length;

/** The post that answered `id`. */
const answerPost = (posts: readonly Post[], id: string) =>
	posts.find((post) => (post.message as { id?: unknown }).id === id)!;

/** Resolves once the background digest check and the sweep of the ready replica have ended. */
async function idle(client: Client): Promise<void> {
	const ended = (task: string) => (event: Event) =>
		event.event === 'progress' && event.task === task && event.done === event.total;
	for (;;) {
		if (client.events.some(ended('verify')) && client.events.some(ended('sweep'))) break;
		await settle();
	}
	await client.call('staged');
}

const COUNT = 3_000;

/** `n0` … refers to the next, the last to the first: a file of several steps. */
function ring(): Model {
	const model = new Model(nodeMetamodel());
	for (let i = 0; i < COUNT; i++) {
		model.setProperty(model.createElement('Node', `n${i}`), 'name', `node ${i}`);
	}
	for (let i = 0; i < COUNT; i++) model.connect('Refers', `n${i}`, `n${(i + 1) % COUNT}`, `r${i}`);
	return model;
}

const rename: ModelOp = { kind: 'update_element', id: 'n1500', properties_patch: { name: 'aaa' } };

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

describe('downloadModel', () => {
	it('answers the committed file, its parts as the transfer list', async () => {
		const [mine, theirs] = portPair();
		const sent = recording(theirs);
		const client = connect(autoHost(), [mine, sent.port]);
		const { model, doc } = smartCity();
		await openReplica(client, model, doc);

		const file = await client.callAs<ModelFile>('d', 'downloadModel', {});
		expect(Object.keys(file)).toEqual(['parts', 'filename', 'content_type']);
		expect(file).toMatchObject({ filename: 'model.json', content_type: 'application/json' });
		expect(file.parts.length).toBeGreaterThan(0);
		expect(file.parts.every((part) => part instanceof ArrayBuffer)).toBe(true);
		expect(fileText(file)).toBe(direct(smartCity().model));
		const transfer = answerPost(sent.posts, 'd').transfer!;
		expect(transfer).toHaveLength(file.parts.length);
		transfer.forEach((buffer, i) => expect(buffer).toBe(file.parts[i]));
	});

	it('answers the committed file while an edit is staged', async () => {
		const client = connect(autoHost());
		const { model, doc } = smartCity();
		await openReplica(client, model, doc);
		const committed = direct(smartCity().model);
		const [element] = smartCity().model.elements();
		await client.call('stage', {
			ops: [{ kind: 'update_element', id: element!.id, properties_patch: { name: 'staged' } }]
		});
		expect(await client.call('staged')).toHaveLength(1);
		expect(fileText(await client.call<ModelFile>('downloadModel'))).toBe(committed);
	});
});

describe('a download over the scheduler', () => {
	it('answers once, from the state it began on, when a delta lands between its slices', async () => {
		const server = new Server(clone(ring()));
		const before = direct(ring());
		const { delta } = server.commit([rename]);
		const after = direct(server.model);
		expect(after).not.toBe(before);
		const { host, client } = await paused();

		const downloading = client.callAs<ModelFile>('d', 'downloadModel');
		await settle();
		// Mid-download: the pump waits for the host.
		expect(host.waiting).toBe(1);
		const applied = client.call<{ status: string; rev: number }>('applyDelta', {
			text: deltaText(delta)
		});
		await settle();
		host.auto = true;
		host.turn();
		expect(fileText(await downloading)).toBe(before);
		expect(await applied).toMatchObject({ status: 'applied', rev: 1 });
		expect(fileText(await client.call<ModelFile>('downloadModel'))).toBe(after);
		await settle();
		expect(answersTo(client, 'd')).toBe(1);
	});

	it('starts over on the next replica when the replica closes between its slices, answering once', async () => {
		const server = new Server(clone(ring()));
		server.commit([rename]);
		const after = direct(server.model);
		const { host, client } = await paused();

		const downloading = client.callAs<ModelFile>('d', 'downloadModel');
		await settle();
		expect(host.waiting).toBe(1);
		await client.call('close');
		host.auto = true;
		host.turn();
		await openReplica(client, server.model, NODE_DOC, { rev: 1 });
		expect(fileText(await downloading)).toBe(after);
		await settle();
		expect(answersTo(client, 'd')).toBe(1);
	});

	it('never answers a cancelled download, and answers a later one', async () => {
		const { host, client } = await paused();
		let answered = false;
		void client.callAs('d', 'downloadModel').then(() => (answered = true));
		await settle();
		expect(host.waiting).toBe(1);
		client.cancel('d');
		const next = client.call<ModelFile>('downloadModel');
		host.auto = true;
		host.turn();
		expect(fileText(await next)).toBe(direct(ring()));
		await settle();
		expect(answered).toBe(false);
		expect(answersTo(client, 'd')).toBe(0);
	});
});
