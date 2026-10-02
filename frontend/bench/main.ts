/**
 * The bench page: the real sandbox through `frame.ts` and `client.ts`, and
 * model M's snapshot streamed from this origin. `bench/run.ts` drives it
 * through `window.bench`; every number is taken here, on the page's clock.
 */
import type {
	DeltaResult,
	ElementPage,
	EndResult,
	ExportFileResult,
	ModelFile,
	ScriptCallsResult,
	ScriptWarmResult,
	TablePageBody,
	TailResult,
	WireElement
} from '$engine';
import type { EngineClient, EngineLink } from '$lib/engine/client';
import { connectFrame } from '$lib/engine/frame';
import { isolation, parity, runaway, violationControl } from './scripts';
import type { IsolationReport, ParityReport, RunawayReport } from './scripts';

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
	/** Ten scripts over 1,000 `Microservice` ids each, concurrently on the pool. */
	scripts(): Promise<Measures>;
	/** The same ten scripts as a table's columns over those 1,000 rows, exported as csv through the engine. */
	scriptTable(): Promise<Measures>;
	/** The script parity corpus through the pool in the built sandbox, on a replica of the corpus model. */
	parity(): Promise<ParityReport>;
	/** The soft stop, the hard stops and a cancel, with the default limits. */
	runaway(): Promise<RunawayReport>;
	/** A script that rebinds its worker's scope, and the next batch on a worker of its own. */
	isolation(): Promise<IsolationReport>;
	/** A script that `eval`s, to show a worker's CSP violation reaches the page's count. */
	violationControl(): Promise<{ violations: number; answer: string }>;
	/** CSP violations the frame has reported since the open, the script worker's included. */
	violations(): number;
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

const CR_CREATED_AT = '2026-01-01T00:00:00.000Z';

let link: EngineLink | null = null;
let rev = 0;
let violations = 0;
/** Script fills that finished since the open, counted from the engine's progress events. */
let scriptRounds = 0;

async function open(): Promise<OpenReport> {
	link = await connectFrame();
	const client = link.client;
	scriptRounds = 0;
	violations = 0;
	link.onViolation(() => violations++);
	const metamodel: unknown = await (await fetch('/data/metamodel.json')).json();

	const began = new Map<string, number>();
	const ended = new Map<string, number>();
	const ready = deferred();
	const verified = deferred();
	const seeded = deferred();
	client.on((event) => {
		const at = now();
		if (event.event === 'progress' && event.task === 'scripts') {
			if (event.done === event.total) scriptRounds++;
		} else if (event.event === 'progress') {
			if (!began.has(event.task)) began.set(event.task, at);
			if (event.done === event.total && !ended.has(event.task)) {
				ended.set(event.task, at);
				if (event.task === 'verify') verified.resolve(at);
				if (event.task === 'sweep') seeded.resolve(at);
			}
		} else if (event.event === 'replica' && event.state === 'ready') {
			ready.resolve(at);
		}
	});

	const start = now();
	const stopOpenPings = ping(client);
	const response = fetch('/data/snapshot.gz', { cache: 'no-store' });
	await client.call('open', { project_id: PROJECT_ID, metamodel, scripts: 'evaluate' });
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

	// The digest check and the sweep run in their own scheduler slots, taking
	// turns. One ping loop at a time: the first until the check ends, the
	// second from then until the sweep ends, so that "longest slice while
	// sweeping" holds sweep steps alone. A sweep that ends first has none.
	let checked = false;
	let seededFirst = false;
	void seeded.promise.then(() => (seededFirst = !checked));
	const stopVerifyPings = ping(client);
	const verifiedAt = await verified.promise;
	checked = true;
	const verifyTrips = await stopVerifyPings();
	const stopSweepPings = seededFirst ? null : ping(client);
	const seededAt = await seeded.promise;
	const sweepTrips = stopSweepPings === null ? [] : await stopSweepPings();

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
	const sweepWorst = sweepTrips.length > 0 ? longest(sweepTrips) : { start: NaN, ms: NaN };
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
			'  posted at, after ready': verifyWorst.start - readyAt,
			'sweep (ready → seeded)': seededAt - readyAt,
			'longest slice while sweeping': sweepWorst.ms,
			'  posted at, after ready (sweep)': sweepWorst.start - readyAt,
			'  round trips once the digest check ended (count)': sweepTrips.length
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

	// The gate's table: a first page with nothing cached yet, then a page at
	// offset 500 whose order the first page's call left behind. One ping loop
	// spans both round trips, so its longest slice bounds the table's own work.
	const table: unknown = await (await fetch('/data/table.json')).json();
	const stopTablePings = ping(client);
	const firstPage = await timed('evaluateTable: first page (limit 500)', () =>
		client.call<TablePageBody>('evaluateTable', { definition: table, limit: 500, offset: 0 })
	);
	if (firstPage.rows.length !== 500 || !firstPage.truncated) {
		throw new Error(`the table's first page holds ${firstPage.rows.length} rows`);
	}
	const cachedPage = await timed('evaluateTable: page at offset 500 (order cached)', () =>
		client.call<TablePageBody>('evaluateTable', { definition: table, limit: 500, offset: 500 })
	);
	if (cachedPage.rows.length !== 500 || cachedPage.total !== firstPage.total) {
		throw new Error(`the table's cached page holds ${cachedPage.rows.length} rows`);
	}
	measures['longest staged round trip during the table (slice bound)'] = longest(
		await stopTablePings()
	).ms;

	// The same table exported, csv then xlsx, over the order the pages left
	// cached: each file rendered (and the workbook zipped) in the worker, its
	// parts transferred, a ping loop of its own alongside.
	let exportSlice = 0;
	for (const format of ['csv', 'xlsx']) {
		const stopPings = ping(client);
		const file = await timed(`exportTable: ${format} (order cached)`, () =>
			client.call<ExportFileResult>('exportTable', {
				definition: table,
				format,
				date: '20240229',
				project: PROJECT_ID
			})
		);
		const slice = longest(await stopPings()).ms;
		const bytes = file.parts.reduce((n, part) => n + part.byteLength, 0);
		if (bytes === 0 || !file.truncated) {
			throw new Error(`the ${format} export holds ${bytes} bytes, truncated=${file.truncated}`);
		}
		measures[`  its bytes (${format})`] = bytes;
		measures[`  longest staged round trip during it (${format})`] = slice;
		exportSlice = Math.max(exportSlice, slice);
	}
	measures['longest staged round trip during the exports (slice bound)'] = exportSlice;

	// The committed model file, written in the worker and its parts transferred.
	const stopDownloadPings = ping(client);
	const download = await timed('downloadModel', () => client.call<ModelFile>('downloadModel', {}));
	const downloadBytes = download.parts.reduce((n, part) => n + part.byteLength, 0);
	if (downloadBytes === 0) throw new Error('the model download holds no bytes');
	measures['  its bytes (downloadModel)'] = downloadBytes;
	measures['  longest staged round trip during it (downloadModel)'] = longest(
		await stopDownloadPings()
	).ms;

	// Custom rules installed: `setArtifacts` queues a rescan the store runs
	// before answering the next `getModelIssues`, so the pair is timed as ONE
	// call — the compile and the steps between the two calls are the rescan's
	// too — with the ping loop already running before `setArtifacts` posts.
	// The rules are removed again and that removal's own rescan drained, so
	// nothing after this block (the stage/delta rows below) runs with every
	// stage and rebase widened by their reach.
	const rules: unknown = await (await fetch('/data/rules.json')).json();
	const stopRescanPings = ping(client);
	await timed('setArtifacts: install the custom rules, until the rescan settles', async () => {
		await client.call('setArtifacts', { artifacts: rules });
		await client.call('getModelIssues', {});
	});
	measures['longest staged round trip during the rescan (slice bound)'] = longest(
		await stopRescanPings()
	).ms;
	await client.call('setArtifacts', { artifacts: [] });
	await client.call('getModelIssues', {});

	// The candidate diff over the settled store: the whole model validated
	// under a metamodel edit and diffed, a ping loop alongside.
	const candidate: unknown = await (await fetch('/data/candidate.json')).json();
	const stopCandidatePings = ping(client);
	const diff = await timed('candidateIssues: the model validated under a metamodel edit', () =>
		client.call<{ now_failing: unknown[]; now_passing: unknown[] }>('candidateIssues', {
			metamodel: candidate
		})
	);
	measures['longest staged round trip during candidateIssues (slice bound)'] = longest(
		await stopCandidatePings()
	).ms;
	// M holds no issue, so only what the edit adds is expected.
	if (diff.now_failing.length === 0) {
		throw new Error('the candidate edit changes nothing');
	}

	// Compare and apply-CR: the derived file goes to the worker transferred,
	// the change request it answers is proposed back, a ping loop alongside each.
	const compareFile = await (await fetch('/data/compare.json')).arrayBuffer();
	const stopComparePings = ping(client);
	const compared = await timed('compareModel: the working copy against an uploaded file', () =>
		client.call<{ cr: unknown; other_element_count: number }>(
			'compareModel',
			{ file: compareFile, created_at: CR_CREATED_AT },
			{ transfer: [compareFile] }
		)
	);
	measures['  longest staged round trip during it (compareModel)'] = longest(
		await stopComparePings()
	).ms;
	if (compared.other_element_count === 0) throw new Error('the compare read no elements');
	const stopProposePings = ping(client);
	const proposed = await timed('proposeCr: the compare’s change request', () =>
		client.call<{ ops?: unknown[] }>('proposeCr', {
			crs: [compared.cr],
			created_at: CR_CREATED_AT
		})
	);
	measures['  longest staged round trip during it (proposeCr)'] = longest(
		await stopProposePings()
	).ms;
	if (proposed.ops === undefined || proposed.ops.length === 0) {
		throw new Error('the compare’s change request proposes nothing');
	}

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

const SCRIPT_TYPE = 'Microservice';
const SCRIPT_IDS = 1000;
/** Each a `value(els)` body; `els[0]` is the call's one element. */
const SCRIPT_BODIES = [
	'return els[0].name.upper()',
	'return len(els[0].outgoing())',
	'return len(els[0].incoming())',
	'p = els[0].parent(); return p.name if p else None',
	'return [r.destination().name for r in els[0].outgoing()][:5]',
	'return sum(len(r.destination().outgoing()) for r in els[0].outgoing())',
	"return els[0].get('status')",
	"return ', '.join(sorted(els[0].get('tags') or []))",
	"e = els[0]; return f'{e.stereotype}:{e.id}'",
	'return len(els[0].children())'
];

/** The first `SCRIPT_IDS` ids of the model's `SCRIPT_TYPE` elements. */
async function scriptIds(client: EngineClient): Promise<string[]> {
	const ids: string[] = [];
	for (let offset = 0; ids.length < SCRIPT_IDS; offset += 500) {
		const page = await client.call<ElementPage>('listElementsPage', {
			type: SCRIPT_TYPE,
			limit: 500,
			offset
		});
		ids.push(...page.items.map((element) => element.id));
		if (offset + 500 >= page.total) break;
	}
	if (ids.length < SCRIPT_IDS) {
		throw new Error(`model M holds ${ids.length} ${SCRIPT_TYPE} elements, ${SCRIPT_IDS} needed`);
	}
	ids.length = SCRIPT_IDS;
	return ids;
}

const scriptCode = (body: string) => `def value(els):\n    ${body}\n`;

async function scripts(): Promise<Measures> {
	if (link === null) throw new Error('open first');
	const client = link.client;
	const ids = await scriptIds(client);

	const run = async (code: string, calls: { element_ids: string[] }[]) => {
		const result = await client.call<ScriptCallsResult>('scriptCalls', {
			code,
			entry: 'value',
			calls
		});
		for (const one of result.results) {
			const { error } = JSON.parse(one.text) as { error: { message: string } | null };
			if (error !== null) throw new Error(`a script cell failed: ${error.message}`);
		}
		return result;
	};
	// The first use after the open: a cold boot, reported and not gated.
	const warm = await run('def value(els):\n    return els[0].name\n', [{ element_ids: [ids[0]!] }]);
	// The timer starts with the image made and every spare of the pool ready.
	const warmed = await client.call<ScriptWarmResult>('scriptWarm');

	const calls = ids.map((id) => ({ element_ids: [id] }));
	const start = now();
	const results = await Promise.all(SCRIPT_BODIES.map((body) => run(scriptCode(body), calls)));
	const wall = now() - start;
	let trips = 0;
	let ms = 0;
	let dispatch = 0;
	for (const result of results) {
		trips += result.trips;
		ms += result.ms;
		dispatch += result.dispatch_ms;
	}
	const batchMs = results.map((r) => r.ms).sort((x, y) => x - y);
	const snapshotBoots = [warm, ...results]
		.filter((r) => r.boot === 'snapshot')
		.map((r) => r.boot_ms)
		.sort((x, y) => x - y);
	const parallelism =
		typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : 1;
	return {
		// The first use boots cold unless the image was ready already.
		...(warm.boot === 'cold' && { 'script boot (cold)': warm.boot_ms }),
		'script spares ready at the timer': warmed.spares,
		'script boot (snapshot)': snapshotBoots[Math.floor(snapshotBoots.length / 2)] ?? NaN,
		'10,000 script cells': wall,
		'script run sum': ms,
		'script batch ms (min)': batchMs[0]!,
		'script batch ms (median)': batchMs[Math.floor(batchMs.length / 2)]!,
		'script batch ms (max)': batchMs[batchMs.length - 1]!,
		'script dispatch busy': dispatch,
		'script bridge trips': trips,
		'script µs per trip': (ms * 1000) / trips,
		'script workers': Math.max(1, Math.min(4, parallelism - 2))
	};
}

/** The records of a csv text: a newline inside a quoted field does not end one. */
function csvRows(csv: string): number {
	let rows = 0;
	let quoted = false;
	let open = false;
	for (const c of csv) {
		if (c === '"') quoted = !quoted;
		if (c === '\n' && !quoted) {
			if (open) rows++;
			open = false;
		} else if (c !== '\r') open = true;
	}
	return open ? rows + 1 : rows;
}

async function scriptTable(): Promise<Measures> {
	if (link === null) throw new Error('open first');
	const client = link.client;
	const ids = await scriptIds(client);
	const definition = {
		row_source: {
			kind: 'scope',
			types: [SCRIPT_TYPE],
			criteria: [
				{
					type: 'any_of',
					criteria: ids.map((id) => ({ type: 'name_id', field: 'id', op: 'equals', value: id }))
				}
			]
		},
		columns: [
			{ kind: 'element' },
			{ kind: 'property', name: 'name' },
			...SCRIPT_BODIES.map((body) => ({
				kind: 'script',
				snippet: { definition: { code: scriptCode(body) } }
			}))
		],
		sort: [{ column: 1 }]
	};
	const params = { definition, format: 'csv', date: '20240229', project: PROJECT_ID };
	const exported = async () => {
		const file = await client.call<ExportFileResult>('exportTable', params);
		const csv = file.parts.map((part) => new TextDecoder().decode(part)).join('');
		// A script cell that failed or was not computed renders as `#ERROR: ...`, so the
		// scan is complete; `script_errors` says the same of the file.
		if (file.script_errors || csv.includes('#ERROR')) {
			throw new Error('a script table cell holds an error');
		}
		if (file.truncated) throw new Error('the script table export is truncated');
		return csvRows(csv);
	};

	// The pool's spares are ready before the timer, as in `scripts()`.
	await client.call('scriptWarm');
	const roundsBefore = scriptRounds;
	const start = now();
	const records = await exported();
	const wall = now() - start;
	const rounds = scriptRounds - roundsBefore;
	if (records !== SCRIPT_IDS + 1)
		throw new Error(`the script table's csv holds ${records} records`);
	const again = now();
	await exported();
	const cached = now() - again;
	const pageStart = now();
	const page = await client.call<TablePageBody>('evaluateTable', {
		definition,
		offset: 0,
		limit: 500
	});
	const firstPage = now() - pageStart;
	if (page.rows.length !== 500)
		throw new Error(`the script table's page holds ${page.rows.length} rows`);
	return {
		'script table export (10,000 cells)': wall,
		'  script rounds in it (count)': rounds,
		'script table export (cached)': cached,
		'script table first page (cached)': firstPage
	};
}

window.bench = {
	open,
	scripts,
	scriptTable,
	parity,
	runaway,
	isolation,
	violationControl,
	violations: () => violations,
	transitions,
	close() {
		link?.dispose();
		link = null;
	}
};
