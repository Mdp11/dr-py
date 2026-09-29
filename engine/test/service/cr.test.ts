import { describe, expect, it } from 'vitest';
import {
	compareSteps,
	drain,
	Model,
	modelLines,
	proposeSteps,
	readCrs,
	type CompareAnswer,
	type Delta,
	type ProposeAnswer
} from '../../src/index.ts';
import { family, nodeMetamodel, NODE_DOC } from '../model/fixtures.ts';
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

type Json = { [key: string]: unknown };

/** A change request document, as the shell sends it. */
const crOf = (elements: Json = {}, relationships: Json = {}): Json => ({
	format: 'datarover.cr/v1',
	createdAt: CREATED_AT,
	ops: { elements, relationships }
});

/** An element of `model` as a change request lists it, `props` laid over its properties. */
function elementOf(model: Model, id: string, props: Json = {}): Json {
	const rec = model.getElement(id);
	return { id, type_name: rec.typeName, properties: { ...rec.props, ...props }, rev: rec.rev };
}

const renamed = (model: Model, id: string, name: string): Json => ({
	id,
	before: elementOf(model, id),
	after: elementOf(model, id, { name })
});

/** The proposal computed directly over a working copy of `model` at `rev`. */
const proposed = (model: Model, rev: number, crs: unknown) =>
	drain(
		proposeSteps(workingCopy(clone(model), rev), { crs: readCrs(crs), created_at: CREATED_AT })
	);

type Proposal = Extract<ProposeAnswer, { ops: unknown }>;

type CrOpsOut = {
	elements: {
		added: Json[];
		modified: { id: string; before: Json; after: Json }[];
		deleted: Json[];
	};
	relationships: { added: Json[]; modified: Json[]; deleted: Json[] };
};

describe('proposeCr', () => {
	it('answers the proposal, a conflict as a result, and the gate’s refusal as a 422', async () => {
		const client = connect(autoHost());
		const model = family();
		await openReplica(client, model, NODE_DOC, { rev: 2 });

		const crs = [crOf({ modified: [renamed(model, 'a', 'A2')] })];
		const answer = await client.call<Proposal>('proposeCr', { crs, created_at: CREATED_AT });
		expect(Object.keys(answer)).toEqual(['model_rev', 'cr', 'ops']);
		expect(answer.ops).toEqual([
			{ kind: 'update_element', id: 'a', properties_patch: { name: 'A2' } }
		]);
		expect(JSON.stringify(answer)).toBe(JSON.stringify(proposed(family(), 2, crs)));

		const conflicting = [crOf({ added: [elementOf(model, 'a')] })];
		expect(await client.call('proposeCr', { crs: conflicting, created_at: CREATED_AT })).toEqual({
			conflict: {
				cr_index: 0,
				conflicts: [
					{
						kind: 'id_exists',
						entity: 'element',
						id: 'a',
						reason: "Element 'a' already exists in the model"
					}
				],
				model_rev: 2
			}
		});

		const unknown = [crOf({ added: [{ id: 'n1', type_name: 'Nope' }] })];
		expect(
			await refusal(client.call('proposeCr', { crs: unknown, created_at: CREATED_AT }))
		).toEqual({ status: 422, detail: "Unknown element type 'Nope'" });
	});

	it('refuses change requests it cannot read with the 501 the server takes over, and a missing created_at, at arrival', async () => {
		// No replica is open: a call that queued would never be answered.
		const client = connect(autoHost());
		const unreadable = { status: 501, detail: 'reaches an unreadable change request' };
		expect(await refusal(client.call('proposeCr', { crs: [], created_at: CREATED_AT }))).toEqual(
			unreadable
		);
		expect(
			await refusal(
				client.call('proposeCr', {
					crs: [crOf({ added: [{ id: 'n1', type_name: 'Node', rev: '3' }] })],
					created_at: CREATED_AT
				})
			)
		).toEqual(unreadable);
		expect(await refusal(client.call('proposeCr', { crs: [crOf()] }))).toEqual({
			status: 422,
			detail: 'created_at must be a string'
		});
	});

	it('replaces the working copy with a file while an edit is staged: the answered ops, staged, leave the file', async () => {
		const client = connect(autoHost());
		const model = family();
		await openReplica(client, model, NODE_DOC, { rev: 1 });
		await client.call('stage', {
			ops: [{ kind: 'update_element', id: 'a', properties_patch: { name: 'A staged' } }]
		});
		// `a` has another name, `b` is gone with its relationships, `e` is new and refers to `a`.
		const text = JSON.stringify({
			elements: [
				{ id: 'a', type_name: 'Node', properties: { name: 'A file' } },
				{ id: 'c', type_name: 'Node', properties: { name: 'C' } },
				{ id: 'd', type_name: 'Node', properties: { name: 'D' } },
				{ id: 'e', type_name: 'Node', properties: { name: 'E' } }
			],
			relationships: [
				{ id: 'a-c', type_name: 'Refers', source_id: 'a', target_id: 'c' },
				{ id: 'e-a', type_name: 'Refers', source_id: 'e', target_id: 'a' }
			]
		});
		const compare = () =>
			client.call<CompareAnswer>('compareModel', { file: bytesOf(text), created_at: CREATED_AT });

		const { cr } = await compare();
		const compared = cr['ops'] as CrOpsOut;
		// `a`'s change is from its staged name.
		expect(
			compared.elements.modified.map((m) => [m.id, (m.before['properties'] as Json)['name']])
		).toEqual([['a', 'A staged']]);
		// As the shell sends it: through JSON.
		const answer = await client.call<Proposal>('proposeCr', {
			crs: [JSON.parse(JSON.stringify(cr))],
			created_at: CREATED_AT
		});
		expect(answer.ops.filter((op) => op['kind'] === 'update_element')).toEqual([
			{ kind: 'update_element', id: 'a', properties_patch: { name: 'A file' } }
		]);
		// Temp ids of the caller's own, as the shell remaps them.
		const fresh = (id: unknown) =>
			typeof id === 'string' && id.startsWith('tmp_') ? `tmp_replace_${id.slice(4)}` : id;
		const ops = answer.ops.map((op) => {
			const out: Json = { ...op };
			for (const key of ['temp_id', 'source_id', 'target_id']) {
				if (key in out) out[key] = fresh(out[key]);
			}
			return out;
		});
		await client.call('stage', { ops });

		const empty = { added: [], modified: [], deleted: [] };
		expect((await compare()).cr['ops']).toEqual({ elements: empty, relationships: empty });
	});

	it('leaves the working copy as it was', async () => {
		const client = connect(autoHost());
		const model = family();
		await openReplica(client, model, NODE_DOC, { rev: 1 });
		await client.call('stage', {
			ops: [{ kind: 'update_element', id: 'a', properties_patch: { name: 'A staged' } }]
		});
		const file = () => bytesOf(fileText(family(), 1));
		const seen = async () =>
			JSON.stringify([
				await client.call('stagedDiff'),
				await client.call('compareModel', { file: file(), created_at: CREATED_AT })
			]);
		const before = await seen();
		const answer = await client.call<Proposal>('proposeCr', {
			crs: [
				crOf(
					{
						added: [{ id: 'n1', type_name: 'Node', properties: { name: 'N1' } }],
						deleted: [elementOf(model, 'c')]
					},
					{
						deleted: [
							{ id: 'a-c', type_name: 'Refers', source_id: 'a', target_id: 'c', properties: {} }
						]
					}
				)
			],
			created_at: CREATED_AT
		});
		expect(answer.ops.map((op) => op['kind'])).toEqual([
			'create_element',
			'delete_relationship',
			'delete_element'
		]);
		expect(await seen()).toBe(before);
	});
});

describe('a proposal over the scheduler', () => {
	/** Every element of the ring renamed: a proposal of several steps. */
	const renameAll = () => {
		const model = ring();
		return [
			crOf({
				modified: [...model.elements()].map((rec) => renamed(model, rec.id, `renamed ${rec.id}`))
			})
		];
	};

	it('starts over on a control-lane delta between its slices, and answers once, over the new state', async () => {
		const server = new Server(clone(ring()));
		const { delta } = server.commit([dropLast]);
		const { host, client } = await paused();

		const proposing = client.callAs<Proposal>('p', 'proposeCr', {
			crs: renameAll(),
			created_at: CREATED_AT
		});
		await settle();
		expect(host.waiting).toBe(1);
		expect(answersTo(client, 'p')).toBe(0);
		await client.call('close');
		host.auto = true;
		host.turn();
		await openThroughTail(client, ring(), [delta]);

		const answer = await proposing;
		expect(answer.model_rev).toBe(1);
		expect(answer.cr['baseline']).toEqual({
			filename: null,
			elementCount: COUNT,
			relationshipCount: COUNT - 1
		});
		expect(JSON.stringify(answer)).toBe(JSON.stringify(proposed(server.model, 1, renameAll())));
		await settle();
		expect(answersTo(client, 'p')).toBe(1);
	});
});
