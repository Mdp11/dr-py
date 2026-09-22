/**
 * The bench page: the real sandbox through `frame.ts` and `client.ts`, and
 * model M's snapshot streamed from this origin. `bench/run.ts` drives it
 * through `window.bench`; every number is taken here, on the page's clock.
 */
import type { DeltaResult, ElementPage, EndResult, TailResult, WireElement } from '$engine';
import type { EngineClient, EngineLink } from '$lib/engine/client';
import { connectFrame } from '$lib/engine/frame';

/** One pass's measurements by label, in insertion order; ms unless the label says otherwise. */
export type Measures = Record<string, number>;

export type OpenReport = {
	measures: Measures;
	header: EndResult;
	gzipBytes: number;
	isolated: boolean | null;
	violations: number;
};

export type Bench = {
	/** Opens M cold and returns once the digest check is done. */
	open(): Promise<OpenReport>;
	/** Edits and reads; the last of them diverges the replica. */
	transitions(): Promise<Measures>;
	close(): void;
};

declare global {
	interface Window {
		bench: Bench;
	}
}

/** The project `scripts/snapshot_v2.py` writes into the header. */
const PROJECT_ID = 'bench';
const IDLE_PINGS = 50;
const SLICE_MS = 16;

const now = () => performance.now();

const median = (values: readonly number[]) =>
	[...values].sort((a, b) => a - b)[values.length >> 1] ?? NaN;

/** A chunk's own buffer when the view spans it, else a copy: a transfer detaches the whole buffer. */
function exactBuffer(chunk: Uint8Array): ArrayBuffer {
	if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
		return chunk.buffer as ArrayBuffer;
	}
	return chunk.slice().buffer;
}

/**
 * `staged` round trips, each posted when the last was answered, until the
 * returned function is called. `staged` is answered on the worker's next host
 * turn, so the longest trip bounds the longest time the worker took no message.
 */
function ping(client: EngineClient): () => Promise<{ start: number; ms: number }[]> {
	const trips: { start: number; ms: number }[] = [];
	let running = true;
	const loop = (async () => {
		while (running) {
			const start = now();
			await client.call('staged');
			trips.push({ start, ms: now() - start });
		}
	})();
	return async () => {
		running = false;
		await loop;
		return trips;
	};
}

const longest = (trips: readonly { start: number; ms: number }[]) =>
	trips.reduce((worst, trip) => (trip.ms > worst.ms ? trip : worst), { start: NaN, ms: 0 });

function deferred(): { promise: Promise<number>; resolve(at: number): void } {
	let resolve!: (at: number) => void;
	const promise = new Promise<number>((done) => (resolve = done));
	return { promise, resolve };
}

let link: EngineLink | null = null;
let rev = 0;

async function open(): Promise<OpenReport> {
	link = await connectFrame();
	const client = link.client;
	let violations = 0;
	link.onViolation(() => violations++);
	const metamodel: unknown = await (await fetch('/data/metamodel.json')).json();

	const began = new Map<string, number>();
	const ended = new Map<string, number>();
	const ready = deferred();
	const verified = deferred();
	client.on((event) => {
		const at = now();
		if (event.event === 'progress') {
			if (!began.has(event.task)) began.set(event.task, at);
			if (event.done === event.total && !ended.has(event.task)) {
				ended.set(event.task, at);
				if (event.task === 'verify') verified.resolve(at);
			}
		} else if (event.event === 'replica' && event.state === 'ready') {
			ready.resolve(at);
		}
	});

	const start = now();
	const stopOpenPings = ping(client);
	const response = fetch('/data/snapshot.gz', { cache: 'no-store' });
	await client.call('open', { project_id: PROJECT_ID, metamodel });
	const body = (await response).body;
	if (body === null) throw new Error('the snapshot response has no body');
	const reader = body.getReader();
	const sent: Promise<unknown>[] = [];
	let gzipBytes = 0;
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		gzipBytes += next.value.byteLength;
		const bytes = exactBuffer(next.value);
		sent.push(client.call('chunk', { bytes }, { transfer: [bytes] }));
	}
	const lastChunk = now();
	const header = await client.call<EndResult>('end');
	const endAnswered = now();
	await Promise.all(sent);
	const text = JSON.stringify({
		from_rev: header.rev,
		head_rev: header.rev,
		complete: true,
		deltas: []
	});
	const tail = await client.call<TailResult>('applyTail', { text });
	if (tail.status !== 'applied' || tail.diverged) {
		throw new Error(`the empty tail answered ${JSON.stringify(tail)}`);
	}
	rev = tail.rev;
	const readyAt = await ready.promise;
	const openTrips = await stopOpenPings();

	const stopVerifyPings = ping(client);
	const verifiedAt = await verified.promise;
	const verifyTrips = await stopVerifyPings();

	const idle: number[] = [];
	for (let i = 0; i < IDLE_PINGS; i++) {
		const at = now();
		await client.call('staged');
		idle.push(now() - at);
	}

	const since = (at: number | undefined) => (at === undefined ? NaN : at - start);
	const openWorst = longest(openTrips);
	const parseBegan = began.get('parse') ?? Infinity;
	const steadyWorst = longest(openTrips.filter((trip) => trip.start >= parseBegan));
	const verifyWorst = longest(verifyTrips);
	return {
		measures: {
			'cold open: first byte asked to replica ready': readyAt - start,
			'  last chunk sent': lastChunk - start,
			'  end answered': endAnswered - start,
			'  parse began': since(began.get('parse')),
			'  parse ended': since(ended.get('parse')),
			'  index began': since(began.get('index')),
			'  index ended': since(ended.get('index')),
			'longest staged round trip during the open (slice bound)': openWorst.ms,
			'  posted at': since(openWorst.start),
			'  the longest posted after parse began': steadyWorst.ms,
			'  round trips during the open (count)': openTrips.length,
			[`  of them over ${SLICE_MS} ms (count)`]: openTrips.filter((trip) => trip.ms > SLICE_MS)
				.length,
			[`staged round trip when idle (median of ${IDLE_PINGS})`]: median(idle),
			'digest check: ready to its last progress': verifiedAt - readyAt,
			'longest staged round trip during it (slice bound)': verifyWorst.ms,
			'  posted at, after ready': verifyWorst.start - readyAt
		},
		header,
		gzipBytes,
		isolated: link.isolated,
		violations
	};
}

const renamed = (element: WireElement, name: string) => ({
	kind: 'update_element',
	id: element.id,
	properties_patch: { name }
});

async function transitions(): Promise<Measures> {
	if (link === null) throw new Error('open first');
	const client = link.client;
	const measures: Measures = {};
	const timed = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
		const start = now();
		const result = await run();
		measures[label] = now() - start;
		return result;
	};

	const pages = [
		await client.call<ElementPage>('listElementsPage', { limit: 500 }),
		await client.call<ElementPage>('listElementsPage', { limit: 500, offset: 500 })
	];
	const elements = pages.flatMap((page) => page.items);
	if (elements.length !== 1000) throw new Error(`the pages hold ${elements.length} elements`);

	const ops = elements.map((element, i) => renamed(element, `bench ${i}`));
	await timed('stage 1,000 update_element ops', () => client.call('stage', { ops }));
	await timed('unstage all', () => client.call('unstage', { what: 'all' }));
	await timed('the first listElementsPage {limit: 1} after it', () =>
		client.call('listElementsPage', { limit: 1 })
	);
	// An update is rewound in place; only an entity put back at an old place
	// makes the next ordered read re-sort.
	const offset = pages[0]!.total - 1;
	const [gone] = (await client.call<ElementPage>('listElementsPage', { limit: 1, offset })).items;
	await client.call('stage', { ops: [{ kind: 'delete_element', id: gone!.id }] });
	await timed('unstage a delete_element (the last element)', () =>
		client.call('unstage', { what: 'all' })
	);
	await timed('the first listElementsPage {limit: 1} after it (the re-sort)', () =>
		client.call('listElementsPage', { limit: 1 })
	);

	await timed("listElementsPage {q: 'a', limit: 50}, the broadest scan", () =>
		client.call('listElementsPage', { q: 'a', limit: 50 })
	);
	const rare = String(elements[700]!.properties['name']);
	await timed(`listElementsPage {q: '${rare}'}`, () =>
		client.call('listElementsPage', { q: rare })
	);
	await timed('listContainmentRoots {limit: 500}', () =>
		client.call('listContainmentRoots', { limit: 500 })
	);
	const ids = elements.slice(0, 500).map((element) => element.id);
	await timed('getElementsBatch of 500 ids', () => client.call('getElementsBatch', { ids }));

	// Last: the delta's digest is wrong on purpose (the page cannot compute
	// one), so it ends the replica — after the rewind, the apply and the replay.
	await timed('stage 100 single-op batches, one after another', async () => {
		for (let i = 0; i < 100; i++) {
			await client.call('stage', { ops: [renamed(elements[i]!, `mine ${i}`)] });
		}
	});
	const theirs = await client.call<WireElement>('getElement', { id: elements[500]!.id });
	const delta = {
		rev: rev + 1,
		prev_rev: rev,
		state_digest: '0000000000000000',
		changed_elements: [
			{ ...theirs, properties: { ...theirs.properties, name: 'theirs' }, rev: theirs.rev + 1 }
		],
		changed_relationships: [],
		deleted_element_ids: [],
		deleted_relationship_ids: [],
		recreated_element_ids: [],
		recreated_relationship_ids: []
	};
	const result = await timed('applyDelta over the 100 staged batches', () =>
		client.call<DeltaResult>('applyDelta', { text: JSON.stringify(delta) })
	);
	if (result.status !== 'applied') throw new Error(`the delta answered ${JSON.stringify(result)}`);
	return measures;
}

window.bench = {
	open,
	transitions,
	close() {
		link?.dispose();
		link = null;
	}
};
