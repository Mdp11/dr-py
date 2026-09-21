import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	Metamodel,
	Model,
	modelDigest,
	modelLines,
	parseJson,
	pyDumps,
	type MetamodelDoc,
	type ServiceEvent,
	type Value
} from '$engine';
import { ConflictError, NotFoundError, ValidationError } from '$lib/api/errors';
import { createEngineClient, EngineGoneError, type ClientPort, type EngineLink } from '../client';
import { connectInProcess } from '../testing';

const links: EngineLink[] = [];

function link(): EngineLink {
	const made = connectInProcess();
	links.push(made);
	return made;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const made of links.splice(0)) made.dispose();
});

/** Every message posted through any `MessagePort`, the engine's answers included. */
function spyOnPorts() {
	const { port1, port2 } = new MessageChannel();
	const proto = Object.getPrototypeOf(port1) as MessagePort;
	port1.close();
	port2.close();
	return {
		postMessage: vi.spyOn(proto, 'postMessage'),
		close: vi.spyOn(proto, 'close')
	};
}

const posted = (spy: ReturnType<typeof spyOnPorts>['postMessage']) =>
	spy.mock.calls.map(([message]) => message as Record<string, unknown> | null);

async function rejection(calling: Promise<unknown>): Promise<unknown> {
	return calling.then(
		() => {
			throw new Error('expected a rejection');
		},
		(error: unknown) => error
	);
}

/** The smart-city example as a gzipped v2 snapshot, cut into pieces of `size` bytes. */
function smartCitySnapshot(size = 4096): { doc: MetamodelDoc; chunks: ArrayBuffer[] } {
	const root = process.cwd() + '/..';
	const fixture = JSON.parse(
		readFileSync(`${root}/engine/fixtures/golden/smart_city.json`, 'utf-8')
	) as { metamodel: MetamodelDoc };
	const json = parseJson(readFileSync(`${root}/examples/smart-city.model.json`, 'utf-8')) as {
		[key: string]: Value[];
	};
	const model = new Model(Metamodel.fromJSON(fixture.metamodel));
	for (const element of json['elements']!) model.loadElement(element);
	for (const rel of json['relationships']!) model.loadRelationship(rel);
	model.rebuildIndexes();
	const header = pyDumps({
		format: 'datarover.snapshot/v2',
		project_id: 'p',
		rev: 0,
		metamodel_id: 'mm-1',
		elements: model.elementCount,
		relationships: model.relationshipCount,
		state_digest: modelDigest(model)
	});
	const text = [header, ...modelLines(model)].map((line) => line + '\n').join('');
	const bytes = gzipSync(Buffer.from(text, 'utf8'), { level: 3 });
	const chunks: ArrayBuffer[] = [];
	for (let at = 0; at < bytes.length; at += size) {
		const piece = bytes.subarray(at, at + size);
		chunks.push(piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.length));
	}
	return { doc: fixture.metamodel, chunks };
}

const EMPTY_TAIL = pyDumps({ from_rev: 0, head_rev: 0, complete: true, deltas: [] });

/** Opens smart-city through the client as the shell does and waits for `ready`. */
async function openSmartCity(made: EngineLink): Promise<void> {
	const { doc, chunks } = smartCitySnapshot();
	const ready = new Promise<void>((resolve) => {
		const off = made.client.on((event) => {
			if (event.event === 'replica' && event.state === 'ready') {
				off();
				resolve();
			}
		});
	});
	await made.client.call('open', { project_id: 'p', metamodel: doc });
	const sent = chunks.map((bytes) => made.client.call('chunk', { bytes }, { transfer: [bytes] }));
	await made.client.call('end');
	await Promise.all(sent);
	await made.client.call('applyTail', { text: EMPTY_TAIL });
	await ready;
}

const replicaStates = (events: ServiceEvent[]) =>
	events.flatMap((event) => (event.event === 'replica' ? [event.state] : []));

describe('engine client', () => {
	it('a call is answered under its id', async () => {
		const { client } = link();
		await expect(client.call('staged')).resolves.toEqual([]);
		const settled = await Promise.allSettled([
			client.call('staged'),
			client.call('conflicts'),
			client.call('nope'),
			client.call('staged'),
			client.call('conflicts')
		]);
		expect(settled.map((outcome) => outcome.status)).toEqual([
			'fulfilled',
			'fulfilled',
			'rejected',
			'fulfilled',
			'fulfilled'
		]);
		expect(settled[0]).toEqual({ status: 'fulfilled', value: [] });
		expect(settled[1]).toEqual({ status: 'fulfilled', value: [] });
		expect((settled[2] as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundError);
	});

	it('an error answer is the ApiError its status names', async () => {
		const { client } = link();
		const missing = await rejection(client.call('nope'));
		expect(missing).toBeInstanceOf(NotFoundError);
		expect(missing).toMatchObject({
			message: "No method 'nope'",
			status: 404,
			body: { detail: "No method 'nope'" }
		});
		const early = await rejection(client.call('chunk', { bytes: new ArrayBuffer(1) }));
		expect(early).toBeInstanceOf(ConflictError);
		expect(early).toMatchObject({ status: 409 });
		const malformed = await rejection(
			client.call('open', { project_id: 'p', metamodel: { elements: 5 } })
		);
		expect(malformed).toBeInstanceOf(ValidationError);
		expect(malformed).toMatchObject({ status: 422 });
	});

	it('a signal that is already aborted posts nothing', async () => {
		const { client } = link();
		const spy = spyOnPorts();
		const controller = new AbortController();
		controller.abort();
		const refused = await rejection(
			client.call('staged', undefined, { signal: controller.signal })
		);
		expect(refused).toBeInstanceOf(DOMException);
		expect((refused as DOMException).name).toBe('AbortError');
		expect(spy.postMessage).not.toHaveBeenCalled();
	});

	it('aborting a waiting call cancels it', async () => {
		const { client } = link();
		const spy = spyOnPorts();
		const controller = new AbortController();
		const waiting = client.call('getElement', { id: 'x' }, { signal: controller.signal });
		const request = posted(spy.postMessage).find((message) => message?.method === 'getElement');
		expect(request).toBeDefined();
		controller.abort();
		const refused = await rejection(waiting);
		expect(refused).toBeInstanceOf(DOMException);
		expect((refused as DOMException).name).toBe('AbortError');
		expect(posted(spy.postMessage)).toContainEqual({ cancel: request!.id });
		await expect(client.call('staged')).resolves.toEqual([]);
	});

	it('a late answer to a cancelled call is dropped', async () => {
		const sent: unknown[] = [];
		const port: ClientPort = {
			postMessage: (message) => void sent.push(message),
			onmessage: null,
			close: () => {}
		};
		const client = createEngineClient(port);
		const listener = vi.fn();
		client.on(listener);
		const controller = new AbortController();
		const waiting = client.call('getElement', { id: 'x' }, { signal: controller.signal });
		const request = sent[0] as { id: number };
		controller.abort();
		const refused = await rejection(waiting);
		expect((refused as DOMException).name).toBe('AbortError');
		expect(sent).toEqual([request, { cancel: request.id }]);
		expect(() =>
			port.onmessage!(
				new MessageEvent('message', { data: { id: request.id, ok: true, result: 1 } })
			)
		).not.toThrow();
		expect(listener).not.toHaveBeenCalled();
		client.dispose();
	});

	it('events reach every listener until it unsubscribes', async () => {
		const made = link();
		const first: ServiceEvent[] = [];
		const second: ServiceEvent[] = [];
		const offFirst = made.client.on((event) => first.push(event));
		made.client.on((event) => second.push(event));
		await openSmartCity(made);
		for (const events of [first, second]) {
			const states = replicaStates(events);
			expect(states[0]).toBe('opening');
			expect(states.at(-1)).toBe('ready');
		}
		offFirst();
		const seen = first.length;
		await openSmartCity(made);
		expect(first.length).toBe(seen);
		expect(replicaStates(second).filter((state) => state === 'ready')).toHaveLength(2);
	});

	it('a transferred buffer leaves the caller', async () => {
		const { client } = link();
		await client.call('open', { project_id: 'p', metamodel: smartCitySnapshot().doc });
		const bytes = new ArrayBuffer(16);
		await client.call('chunk', { bytes }, { transfer: [bytes] });
		expect(bytes.byteLength).toBe(0);
	});

	it('dispose rejects what is pending and everything after', async () => {
		const { client } = link();
		const spy = spyOnPorts();
		const waiting = client.call('getElement', { id: 'x' });
		client.dispose();
		expect(await rejection(waiting)).toBeInstanceOf(EngineGoneError);
		expect(await rejection(client.call('staged'))).toBeInstanceOf(EngineGoneError);
		expect(spy.close).toHaveBeenCalled();
	});
});
