import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	drain,
	exportTable,
	MEDIA_TYPES,
	Model,
	ViewPlacements,
	type CommittedArtifact,
	type ExportFileResult,
	type JsonPreviewBody,
	type ModelOp,
	type Port,
	type StagedArtifact
} from '../../src/index.ts';
import { nodeMetamodel, NODE_DOC } from '../model/fixtures.ts';
import {
	autoHost,
	connect,
	fakeHost,
	openReplica,
	portPair,
	recording,
	refusal,
	settle,
	type Client,
	type Post
} from './helpers.ts';

type Event = Client['events'][number];

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

// -- a ring of nodes ------------------------------------------------------------

const COUNT = 3_000;

/** `n0` … refers to the next, the last to the first; names sort otherwise than ids. */
function ring(): Model {
	const model = new Model(nodeMetamodel());
	for (let i = 0; i < COUNT; i++) {
		model.setProperty(model.createElement('Node', `n${i}`), 'name', `node ${(i * 7) % COUNT}`);
	}
	for (let i = 0; i < COUNT; i++) model.connect('Refers', `n${i}`, `n${(i + 1) % COUNT}`, `r${i}`);
	return model;
}

/** The ring with `n1500`, whose row sorts somewhere in the middle, named to sort first. */
function renamed(): Model {
	const model = ring();
	model.setProperty(model.getElement('n1500'), 'name', 'aaa');
	return model;
}

const rename: ModelOp = { kind: 'update_element', id: 'n1500', properties_patch: { name: 'aaa' } };

const hop = (direction: 'out' | 'in') => ({
	kind: 'path',
	start: { kind: 'row' },
	steps: [{ kind: 'relationship', relationship_type: 'Refers', direction }]
});

/** Nodes and where each refers through the saved navigation `nv`, sorted by the latter. */
const TABLE = {
	row_source: { kind: 'scope', types: ['Node'] },
	columns: [{ kind: 'element' }, { kind: 'navigation', navigation: { ref: 'nv' } }],
	sort: [{ column: 1 }]
};

const committed = [
	{ id: 't', kind: 'table', name: 'T', artifact_rev: 1, payload: TABLE },
	{ id: 'nv', kind: 'navigation', name: 'Out', artifact_rev: 1, payload: hop('out') }
];
const turned = { op: 'update', id: 'nv', payload: hop('in') };

const CSV = { artifact_id: 't', format: 'csv', date: '20260901', project: 'demo' };

const DRAFT = {
	definition: { schema_version: 1, output: {}, entries: [{ source: { ref: 't' }, format: 'csv' }] },
	date: '20260901',
	project: 'demo'
};

/** A shipped file's bytes as text. */
function text(result: ExportFileResult): string {
	const decoder = new TextDecoder('utf-8', { fatal: true });
	return (
		result.parts.map((part) => decoder.decode(part, { stream: true })).join('') + decoder.decode()
	);
}

/** The CSV export of `model` computed directly, the artifacts committed and `staged` over them. */
function direct(model: Model, staged: readonly object[] = []): string {
	const set = new ArtifactSet();
	set.setCommitted(
		committed.map((a) => ({ ...a, rev: 1, payload: a.payload as CommittedArtifact['payload'] }))
	);
	set.setStaged(staged as StagedArtifact[]);
	const ctx = { model, artifacts: set, placements: new ViewPlacements() };
	return text(drain(exportTable(ctx, CSV)));
}

/** A ready replica of the ring on a host whose turns the test ends, the scan paused past its first slice. */
async function paused() {
	const host = fakeHost({ tick: 3 });
	host.auto = true;
	const client = connect(host);
	await openReplica(client, ring(), NODE_DOC);
	await idle(client);
	await client.call('setArtifacts', { artifacts: committed });
	await settle();
	host.auto = false;
	return { host, client };
}

/** How many answers `id` got. */
const answersTo = (client: Client, id: string) =>
	client.answers.filter((message) => (message as { id?: unknown }).id === id).length;

/** The post that answered `id`. */
const answerPost = (posts: readonly Post[], id: string) =>
	posts.find((post) => (post.message as { id?: unknown }).id === id)!;

// -- a real channel ---------------------------------------------------------------

const channels: MessageChannel[] = [];

afterEach(() => {
	for (const channel of channels.splice(0)) {
		channel.port1.close();
		channel.port2.close();
	}
});

/** A worker-threads port as the engine's `Port`, posting with the transfer list it is handed. */
function nodePort(port: MessagePort): Port {
	return {
		post: (message, transfer) =>
			port.postMessage(message, transfer === undefined ? [] : [...transfer]),
		onMessage: (handler) => port.on('message', handler)
	};
}

describe('export bytes over the port', () => {
	it('answers an export with its parts as the transfer list, and nothing else with one', async () => {
		const [mine, theirs] = portPair();
		const sent = recording(theirs);
		const client = connect(autoHost(), [mine, sent.port]);
		await openReplica(client, ring(), NODE_DOC);
		await client.call('setArtifacts', { artifacts: committed });

		const file = await client.callAs<ExportFileResult>('file', 'exportTable', CSV);
		expect(Object.keys(file)).toEqual([
			'parts',
			'filename',
			'content_type',
			'truncated',
			'script_errors'
		]);
		expect(file).toMatchObject({
			filename: 'T.csv',
			content_type: MEDIA_TYPES.csv,
			truncated: false,
			script_errors: 0
		});
		expect(file.parts.length).toBeGreaterThan(0);
		expect(file.parts.every((part) => part instanceof ArrayBuffer)).toBe(true);
		expect(text(file)).toBe(direct(ring()));
		const transfer = answerPost(sent.posts, 'file').transfer!;
		expect(transfer).toHaveLength(file.parts.length);
		transfer.forEach((buffer, i) => expect(buffer).toBe(file.parts[i]));

		const zip = await client.callAs<ExportFileResult>('zip', 'runExporterDraft', DRAFT);
		expect(zip.content_type).toBe('application/zip');
		const zipTransfer = answerPost(sent.posts, 'zip').transfer!;
		expect(zipTransfer).toHaveLength(zip.parts.length);
		zipTransfer.forEach((buffer, i) => expect(buffer).toBe(zip.parts[i]));

		await client.callAs('page', 'evaluateTable', { artifact_id: 't', limit: 5 });
		const preview = await client.callAs<JsonPreviewBody>('preview', 'previewTableJson', {
			artifact_id: 't'
		});
		expect(Object.keys(preview)).toEqual(['sample', 'truncated']);
		expect(answerPost(sent.posts, 'page').transfer).toBeUndefined();
		expect(answerPost(sent.posts, 'preview').transfer).toBeUndefined();

		// Events, replica answers and refusals carry none either.
		await refusal(client.call('exportTable', { ...CSV, date: 'x' }));
		const carrying = sent.posts.filter((post) => post.transfer !== undefined);
		expect(carrying.map((post) => (post.message as { id: unknown }).id)).toEqual(['file', 'zip']);
	});

	it('detaches the sent parts over a real channel, the receiver holding the bytes', async () => {
		const channel = new MessageChannel();
		channels.push(channel);
		const sent = recording(nodePort(channel.port2));
		const client = connect(autoHost(), [nodePort(channel.port1), sent.port]);
		await openReplica(client, ring(), NODE_DOC);
		await client.call('setArtifacts', { artifacts: committed });

		const file = await client.callAs<ExportFileResult>('file', 'exportTable', CSV);
		expect(file.parts.length).toBeGreaterThan(0);
		expect(file.parts.every((part) => part.byteLength > 0)).toBe(true);
		expect(text(file)).toBe(direct(ring()));
		const { message, transfer } = answerPost(sent.posts, 'file');
		const own = (message as { result: ExportFileResult }).result.parts;
		expect(transfer).toEqual(own);
		expect(own.every((part) => part.byteLength === 0)).toBe(true);
	});
});

describe('an export over the scheduler', () => {
	it('answers once, from the state it ran on, when an edit is staged between its slices', async () => {
		const before = direct(ring());
		const after = direct(renamed());
		expect(after).not.toBe(before);
		const { host, client } = await paused();

		const order: string[] = [];
		const exporting = client.callAs<ExportFileResult>('export', 'exportTable', CSV);
		void exporting.then(() => order.push('export'));
		await settle();
		// Mid-export: the pump waits for the host.
		expect(host.waiting).toBe(1);
		const staging = client.call('stage', { ops: [rename] }).then(() => order.push('stage'));
		await settle();
		expect(host.waiting).toBe(1);
		host.auto = true;
		host.turn();
		const file = await exporting;
		await staging;
		expect(order).toEqual(['export', 'stage']);
		expect(text(file)).toBe(before);

		expect(text(await client.call<ExportFileResult>('exportTable', CSV))).toBe(after);
		await settle();
		expect(answersTo(client, 'export')).toBe(1);
	});

	it('answers once, from the artifacts it started with, when artifacts are staged between its slices', async () => {
		const before = direct(ring());
		const after = direct(ring(), [turned]);
		expect(after).not.toBe(before);
		const { host, client } = await paused();

		const exporting = client.callAs<ExportFileResult>('export', 'exportTable', CSV);
		await settle();
		expect(host.waiting).toBe(1);
		await client.call('setStagedArtifacts', { entries: [turned] });
		expect(host.waiting).toBe(1);
		host.auto = true;
		host.turn();
		expect(text(await exporting)).toBe(before);

		expect(text(await client.call<ExportFileResult>('exportTable', CSV))).toBe(after);
		await settle();
		expect(answersTo(client, 'export')).toBe(1);
	});

	it('restarts an export whose replica closes between its slices, answering once from the next replica', async () => {
		const before = direct(ring());
		const after = direct(renamed());
		expect(after).not.toBe(before);
		const { host, client } = await paused();

		const exporting = client.callAs<ExportFileResult>('export', 'exportTable', CSV);
		await settle();
		expect(host.waiting).toBe(1);
		await client.call('close');
		host.auto = true;
		host.turn();
		await openReplica(client, renamed(), NODE_DOC);
		expect(text(await exporting)).toBe(after);

		expect(text(await client.call<ExportFileResult>('exportTable', CSV))).toBe(after);
		await settle();
		expect(answersTo(client, 'export')).toBe(1);
	});

	it('never answers a cancelled export, and answers a later call', async () => {
		const { host, client } = await paused();
		let answered = false;
		void client.callAs('export', 'exportTable', CSV).then(() => (answered = true));
		await settle();
		expect(host.waiting).toBe(1);
		client.cancel('export');
		const next = client.call<ExportFileResult>('exportTable', CSV);
		host.auto = true;
		host.turn();
		expect(text(await next)).toBe(direct(ring()));
		await settle();
		expect(answered).toBe(false);
		expect(answersTo(client, 'export')).toBe(0);
	});
});

describe('the export context', () => {
	it('refuses a date not written YYYYMMDD and a missing project, with 422', async () => {
		const client = connect(autoHost());
		await openReplica(client, ring(), NODE_DOC);
		await client.call('setArtifacts', { artifacts: committed });
		const DATE = { status: 422, detail: 'date must be YYYYMMDD' };
		const PROJECT = { status: 422, detail: 'project must be a non-empty string' };
		const withoutProject = (params: object) =>
			Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'project'));
		for (const [method, params] of [
			['exportTable', CSV],
			['runExporterDraft', DRAFT]
		] as const) {
			expect(await refusal(client.call(method, { ...params, date: '2026-9-1' }))).toEqual(DATE);
			expect(await refusal(client.call(method, withoutProject(params)))).toEqual(PROJECT);
			expect(await refusal(client.call(method, { ...params, project: '' }))).toEqual(PROJECT);
		}
	});
});
