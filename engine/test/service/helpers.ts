import { readFileSync } from 'node:fs';
import { Readable, pipeline } from 'node:stream';
import { createGunzip, gzipSync } from 'node:zlib';
import {
	createService,
	Metamodel,
	Model,
	modelLines,
	parseJson,
	pyDumps,
	type Delta,
	type HostDeps,
	type MetamodelDoc,
	type Port,
	type Value
} from '../../src/index.ts';
import { stateDigest } from '../golden/digest.ts';
import { loadFixture } from '../golden/load.ts';

/**
 * A host with a clock that moves `tick` ms per `now()` call. A yield records
 * the slice it ends — the time from the first `now()` after the previous turn
 * to the last one before it — and resolves on `turn()`, or on the next
 * macrotask when `auto` is set.
 */
export function fakeHost({ tick }: { tick: number }) {
	let clock = 0;
	let start: number | null = null;
	let last = 0;
	const waiting: (() => void)[] = [];
	const host = {
		slices: [] as number[],
		auto: false,
		deps: {
			now: () => {
				const value = clock;
				clock += tick;
				start ??= value;
				last = value;
				return value;
			},
			yieldToHost: () => {
				host.slices.push(last - (start ?? last));
				start = null;
				return new Promise<void>((resolve) => {
					if (host.auto) setImmediate(resolve);
					else waiting.push(resolve);
				});
			}
		} satisfies HostDeps,
		/** Ends the pending host turns. */
		turn: () => {
			for (const resolve of waiting.splice(0)) resolve();
		},
		get waiting(): number {
			return waiting.length;
		}
	};
	return host;
}

/** Lets every pending microtask and macrotask run. */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// -- a service over a direct port pair ---------------------------------------

/** Two ports wired to each other, delivering on a microtask as a message channel would. */
export function portPair(): [Port, Port] {
	const handlers: [((message: unknown) => void) | null, ((message: unknown) => void) | null] = [
		null,
		null
	];
	const port = (self: 0 | 1): Port => ({
		post: (message) => {
			void Promise.resolve().then(() => handlers[1 - self]?.(message));
		},
		onMessage: (handler) => {
			handlers[self] = handler;
		}
	});
	return [port(0), port(1)];
}

/** Inflates gzip bytes with Node's zlib, as the worker would with a DecompressionStream. */
export function inflate(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
	return pipeline(Readable.from(chunks), createGunzip(), () => undefined);
}

/** `text`, gzipped and cut into transferable buffers of `size` bytes. */
export function gzChunks(text: string, size: number): ArrayBuffer[] {
	const bytes = gzipSync(Buffer.from(text, 'utf8'));
	const chunks: ArrayBuffer[] = [];
	for (let at = 0; at < bytes.length; at += size) {
		const piece = bytes.subarray(at, at + size);
		chunks.push(piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.length));
	}
	return chunks;
}

export type ServiceError = { status: number; detail: string };
type Event = { event: string; [key: string]: unknown };

/** A client of a service on a fake host: calls, raw posts, cancels and the events it sent. */
export function connect(host = autoHost()) {
	const [mine, theirs] = portPair();
	createService(theirs, { ...host.deps, inflate });
	let nextId = 0;
	const pending = new Map<
		string | number,
		{ resolve(v: unknown): void; reject(e: unknown): void }
	>();
	const answers: unknown[] = [];
	const events: Event[] = [];
	let seen = 0;
	const waiters: { match: (event: Event) => boolean; resolve(event: Event): void }[] = [];
	mine.onMessage((message) => {
		const m = message as { id?: string | number; ok?: boolean; result?: unknown; error?: unknown };
		if ('event' in (message as object)) {
			const event = message as Event;
			events.push(event);
			const waiter = waiters.findIndex((w) => w.match(event));
			if (waiter >= 0) {
				seen = events.length;
				waiters.splice(waiter, 1)[0]!.resolve(event);
			}
			return;
		}
		answers.push(message);
		const call = pending.get(m.id!);
		if (call === undefined) return;
		pending.delete(m.id!);
		if (m.ok === true) call.resolve(m.result);
		else call.reject(m.error);
	});
	const client = {
		host,
		events,
		answers,
		/** Resolves with the result, rejects with `{status, detail}`. */
		call<T = unknown>(method: string, params: object = {}, transfer?: ArrayBuffer[]): Promise<T> {
			const id = ++nextId;
			return client.callAs<T>(id, method, params, transfer);
		},
		callAs<T = unknown>(
			id: string | number,
			method: string,
			params: object = {},
			transfer?: ArrayBuffer[]
		): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
				mine.post({ id, method, params }, transfer);
			});
		},
		post: (raw: unknown) => mine.post(raw),
		cancel: (id: string | number) => mine.post({ cancel: id }),
		/** The first event after the last one matched, that matches. */
		nextEvent(match: (event: Event) => boolean): Promise<Event> {
			for (let i = seen; i < events.length; i++) {
				if (match(events[i]!)) {
					seen = i + 1;
					return Promise.resolve(events[i]!);
				}
			}
			return new Promise((resolve) => waiters.push({ match, resolve }));
		},
		eventsOf: (name: string) => events.filter((event) => event.event === name)
	};
	return client;
}

export type Client = ReturnType<typeof connect>;

export function autoHost(tick = 1) {
	const host = fakeHost({ tick });
	host.auto = true;
	return host;
}

/** A call's refusal, as `{status, detail}`. */
export async function refusal(calling: Promise<unknown>): Promise<ServiceError> {
	return calling.then(
		() => {
			throw new Error('expected a refusal');
		},
		(error: unknown) => error as ServiceError
	);
}

// -- models and snapshots -----------------------------------------------------

type SmartCityFixture = { metamodel: MetamodelDoc; model_file: string };

/** The smart-city example, loaded as the golden test loads it, and its metamodel document. */
export function smartCity(): { model: Model; doc: MetamodelDoc } {
	const fixture = loadFixture<SmartCityFixture>('smart_city');
	const file = new URL(`../../../${fixture.model_file}`, import.meta.url);
	const json = parseJson(readFileSync(file, 'utf-8')) as { [key: string]: Value[] };
	const model = new Model(Metamodel.fromJSON(fixture.metamodel));
	for (const element of json['elements']!) model.loadElement(element);
	for (const rel of json['relationships']!) model.loadRelationship(rel);
	model.rebuildIndexes();
	return { model, doc: fixture.metamodel };
}

export type SnapshotOptions = {
	projectId?: string;
	rev?: number;
	metamodelId?: string;
	digest?: string;
};

/** The v2 snapshot text a server would write over `model`. */
export function snapshotText(model: Model, options: SnapshotOptions = {}): string {
	const header = pyDumps({
		format: 'datarover.snapshot/v2',
		project_id: options.projectId ?? 'demo',
		rev: options.rev ?? 0,
		metamodel_id: options.metamodelId ?? 'mm-1',
		elements: model.elementCount,
		relationships: model.relationshipCount,
		state_digest: options.digest ?? stateDigest(model)
	});
	return [header, ...modelLines(model)].map((line) => line + '\n').join('');
}

/** A tail body, as `/replica/tail` answers. */
export function tailText(deltas: readonly Delta[], fromRev = 0): string {
	const head = deltas.length === 0 ? fromRev : deltas.at(-1)!.rev;
	return pyDumps({
		from_rev: fromRev,
		head_rev: head,
		complete: true,
		deltas
	} as unknown as Value);
}

export const deltaText = (delta: Delta) => pyDumps(delta as unknown as Value);

/** Opens a replica of `model` as the shell does — open, chunks, end, an empty tail — and waits for `ready`. */
export async function openReplica(
	client: Client,
	model: Model,
	doc: MetamodelDoc,
	options: SnapshotOptions & { chunk?: number; adopt?: unknown[] } = {}
): Promise<unknown> {
	const projectId = options.projectId ?? 'demo';
	await client.call('open', { project_id: projectId, metamodel: doc });
	const chunks = gzChunks(snapshotText(model, options), options.chunk ?? 1 << 16).map((bytes) =>
		client.call('chunk', { bytes }, [bytes])
	);
	const header = await client.call('end');
	await Promise.all(chunks);
	if (options.adopt !== undefined) await client.call('adoptStaged', { batches: options.adopt });
	const ready = client.nextEvent((event) => event.event === 'replica' && event.state === 'ready');
	await client.call('applyTail', { text: tailText([], options.rev ?? 0) });
	await ready;
	return header;
}
