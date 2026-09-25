// A project server for the shell's tests: the smart-city example held in an
// engine `Model`, served behind MSW routes the way the backend serves a replica.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { IDBFactory } from 'fake-indexeddb';
import { http, HttpResponse, type HttpHandler } from 'msw';
import {
	applyBatch,
	elementLine,
	Metamodel,
	Model,
	modelDigest,
	modelLines,
	parseJson,
	pyDumps,
	relationshipLine,
	type MetamodelDoc,
	type ModelOp,
	type Value
} from '$engine';
import { createSnapshotCache, type SnapshotCache } from '../../cache';
import type { CallOptions, EngineLink } from '../../client';
import {
	createReplicaSync,
	replicaApi,
	type ReplicaStatus,
	type ReplicaSync,
	type SyncApi,
	type SyncDeps
} from '../../sync';
import { connectInProcess } from '../../testing';

/** The API root the tests' `baseUrl`s hang off. */
export const BASE = 'http://api.test/api/v1';
/** happy-dom's page origin: the descriptor's `url` is a path, resolved against it. */
export const PAGE_ORIGIN = 'http://localhost:3000';

const ROOT = process.cwd() + '/..';
let smartCityFiles: { doc: MetamodelDoc; model: string } | null = null;

function smartCity(): { doc: MetamodelDoc; model: Model } {
	smartCityFiles ??= {
		doc: (
			JSON.parse(readFileSync(`${ROOT}/engine/fixtures/golden/smart_city.json`, 'utf-8')) as {
				metamodel: MetamodelDoc;
			}
		).metamodel,
		model: readFileSync(`${ROOT}/examples/smart-city.model.json`, 'utf-8')
	};
	const json = parseJson(smartCityFiles.model) as { [key: string]: Value[] };
	const model = new Model(Metamodel.fromJSON(smartCityFiles.doc));
	for (const element of json['elements']!) model.loadElement(element);
	for (const rel of json['relationships']!) model.loadRelationship(rel);
	model.rebuildIndexes();
	return { doc: smartCityFiles.doc, model };
}

export type Route = 'descriptor' | 'metamodel' | 'snapshot' | 'tail';

/** A commit as the server reports it: the delta, the feed frame and the commit response. */
export type Committed = {
	delta: { [key: string]: Value };
	eventText: string;
	responseText: string;
};

/** A point a handler stops at until the test lets it go on. */
export type Hold = {
	/** Resolves once the handler has reached the hold. */
	reached: Promise<void>;
	release(): void;
	/** Used by the handler. */
	arrive(): Promise<void>;
};

export function hold(): Hold {
	let reach!: () => void;
	let release!: () => void;
	const reached = new Promise<void>((resolve) => (reach = resolve));
	const released = new Promise<void>((resolve) => (release = resolve));
	return {
		reached,
		release,
		arrive: () => {
			reach();
			return released;
		}
	};
}

type Snapshot = {
	rev: number;
	metamodelId: string;
	digest: string;
	elements: number;
	relationships: number;
	lines: string[];
	bytes: Uint8Array;
};

type Row = { kind: 'delta'; event: { [key: string]: Value } } | { kind: 'rebind' };

export type FakeProject = ReturnType<typeof fakeProject>;

/**
 * Stands for the backend of one project: it lands batches under ids of its
 * own minting (`srv-1`, `srv-2`, …), keeps the journal a tail is served
 * from, and writes v2 snapshots of its model, gzipped at level 3.
 */
export function fakeProject(
	options: { projectId?: string; rev?: number; metamodelId?: string } = {}
) {
	const projectId = options.projectId ?? 'p';
	const { doc: initialDoc, model } = smartCity();
	let doc: MetamodelDoc = initialDoc;
	let rev = options.rev ?? 0;
	let metamodelId = options.metamodelId ?? 'mm-1';
	let minted = 0;
	const rows = new Map<number, Row>();
	const requests: Record<Route, number> = { descriptor: 0, metamodel: 0, snapshot: 0, tail: 0 };
	const failures = new Map<Route, { status: number; times: number }>();
	let corruptNext = false;
	let wrongDigestNext = false;

	const encode = (snap: Omit<Snapshot, 'bytes'>, digest = snap.digest): Uint8Array => {
		const header = pyDumps({
			format: 'datarover.snapshot/v2',
			project_id: projectId,
			rev: snap.rev,
			metamodel_id: snap.metamodelId,
			elements: snap.elements,
			relationships: snap.relationships,
			state_digest: digest
		});
		const text = [header, ...snap.lines].map((line) => line + '\n').join('');
		// A copy on its own buffer: a Node `Buffer`'s `slice` is a view, and its `buffer` may be larger.
		return new Uint8Array(gzipSync(Buffer.from(text, 'utf8'), { level: 3 }));
	};

	const take = (): Snapshot => {
		const snap = {
			rev,
			metamodelId,
			digest: modelDigest(model),
			elements: model.elementCount,
			relationships: model.relationshipCount,
			lines: modelLines(model)
		};
		return { ...snap, bytes: encode(snap) };
	};

	let current = take();

	const land = (ops: readonly ModelOp[]): Committed => {
		const result = applyBatch(model, ops, { idFor: () => `srv-${++minted}` });
		rev += 1;
		const common = {
			prev_rev: rev - 1,
			state_digest: modelDigest(model),
			changed_elements: [...result.changedElementIds].map((id) =>
				parseJson(elementLine(model.getElement(id)))
			),
			changed_relationships: [...result.changedRelationshipIds].map((id) =>
				parseJson(relationshipLine(model.getRelationship(id)))
			),
			deleted_element_ids: [...result.deletedElementIds],
			deleted_relationship_ids: [...result.deletedRelationshipIds],
			recreated_element_ids: [...result.recreatedElementIds],
			recreated_relationship_ids: [...result.recreatedRelationshipIds]
		};
		const event = {
			type: 'commit',
			rev,
			scope: ['model'],
			commit_id: `c-${rev}`,
			author_id: 'u-1',
			message: '',
			validation_error_count: 0,
			...common
		};
		const response = {
			model_rev: rev,
			id_map: Object.fromEntries(result.idMap),
			...common
		};
		rows.set(rev, { kind: 'delta', event });
		return {
			delta: { rev, ...common },
			eventText: pyDumps(event as unknown as Value),
			responseText: pyDumps(response as unknown as Value)
		};
	};

	/** A route's scripted failure, if one is due: consumes one of its `times`. */
	const failure = (route: Route): Response | null => {
		requests[route] += 1;
		const due = failures.get(route);
		if (due === undefined || due.times <= 0) return null;
		due.times -= 1;
		return HttpResponse.json({ detail: `${route} failed` }, { status: due.status });
	};

	const tailBody = (from: number) => {
		const deltas: { [key: string]: Value }[] = [];
		let complete = from <= rev && rev - from <= 1000;
		for (let at = from + 1; complete && at <= rev; at++) {
			const row = rows.get(at);
			if (row === undefined || row.kind !== 'delta') complete = false;
			else deltas.push(row.event);
		}
		return pyDumps({
			from_rev: from,
			head_rev: rev,
			complete,
			deltas: complete ? deltas : []
		} as unknown as Value);
	};

	/** The artifacts `GET /artifacts/payloads` serves, by id; none by default. */
	const artifacts = new Map<string, { id: string; [key: string]: unknown }>();
	/** What `POST /rules/parse` answers, by YAML text; a text it lacks is a 422. */
	const rulesParses = new Map<string, { ok: boolean; [key: string]: unknown }>();
	/** Every YAML text `POST /rules/parse` was sent, in order. */
	const rulesParsed: string[] = [];

	const project = {
		projectId,
		artifacts,
		rulesParses,
		rulesParsed,
		get rev() {
			return rev;
		},
		get metamodelId() {
			return metamodelId;
		},
		get doc() {
			return doc;
		},
		model,
		/** The API base URL of this project, as the sync's calls carry it. */
		baseUrl: `${BASE}/projects/${projectId}`,
		requests,

		commit: (ops: readonly ModelOp[]): Committed => land(ops),

		/** A commit no feed frame announces, as `/model/ops` lands one; the tail serves it. */
		silentCommit: (ops: readonly ModelOp[]): Committed => land(ops),

		/** Swaps the metamodel: every tail across it is incomplete, and a fresh snapshot is taken. */
		rebind(nextId: string, nextDoc: MetamodelDoc = doc) {
			metamodelId = nextId;
			doc = nextDoc;
			rev += 1;
			rows.set(rev, { kind: 'rebind' });
			current = take();
		},

		/** Bumps `rev` with no journal row, and takes a fresh snapshot. */
		opaqueBump() {
			rev += 1;
			current = take();
		},

		/** Fixes the snapshot the descriptor names at the current `rev`. */
		snapshot(): { rev: number; bytes: ArrayBuffer } {
			current = take();
			return { rev: current.rev, bytes: current.bytes.slice().buffer };
		},

		/** Makes the next `times` requests of `route` answer `status`, `{detail: '<route> failed'}`. */
		fail(route: Route, status: number, times: number) {
			failures.set(route, { status, times });
		},

		/** The next snapshot download is cut short: its bytes do not inflate. */
		corruptNextSnapshot() {
			corruptNext = true;
		},

		/** The next snapshot download names a state digest its entities do not have. */
		wrongDigestInNextSnapshot() {
			wrongDigestNext = true;
		},

		/**
		 * The four replica routes, and the artifact payloads and rules parse
		 * routes the replica store's follower asks. `chunk` cuts the snapshot body (4096 bytes by default);
		 * `hold` stops the download after its first chunk until released.
		 */
		handlers(handlerOptions: { chunk?: number; hold?: Hold } = {}): HttpHandler[] {
			const size = handlerOptions.chunk ?? 4096;
			const base = project.baseUrl;
			return [
				http.get(`${base}/replica/snapshot`, () => {
					const failed = failure('descriptor');
					if (failed !== null) return failed;
					return HttpResponse.json({
						rev: current.rev,
						metamodel_id: current.metamodelId,
						state_digest: current.digest,
						elements: current.elements,
						relationships: current.relationships,
						url: `/api/v1/projects/${projectId}/replica/snapshots/${current.rev}`
					});
				}),
				http.get(
					`${PAGE_ORIGIN}/api/v1/projects/${projectId}/replica/snapshots/:rev`,
					({ params }) => {
						const failed = failure('snapshot');
						if (failed !== null) return failed;
						if (Number(params['rev']) !== current.rev) {
							return HttpResponse.json(
								{ detail: `no v2 snapshot at rev ${String(params['rev'])}` },
								{ status: 404 }
							);
						}
						let bytes = current.bytes;
						if (wrongDigestNext) {
							wrongDigestNext = false;
							const flipped = (BigInt('0x' + current.digest) ^ 1n).toString(16).padStart(16, '0');
							bytes = encode(current, flipped);
						}
						if (corruptNext) {
							corruptNext = false;
							bytes = bytes.subarray(0, bytes.length - 16);
						}
						const pieces: Uint8Array[] = [];
						for (let at = 0; at < bytes.length; at += size) {
							pieces.push(bytes.slice(at, at + size));
						}
						const held = handlerOptions.hold;
						let sent = 0;
						const stream = new ReadableStream<Uint8Array>({
							async pull(controller) {
								if (sent === 1 && held !== undefined) await held.arrive();
								try {
									if (sent < pieces.length) controller.enqueue(pieces[sent++]!);
									else controller.close();
								} catch {
									// The download was abandoned while it was held.
								}
							}
						});
						return new HttpResponse(stream, {
							headers: {
								'Content-Type': 'application/gzip',
								'Content-Length': String(bytes.length)
							}
						});
					}
				),
				http.get(`${base}/replica/tail`, ({ request }) => {
					const failed = failure('tail');
					if (failed !== null) return failed;
					const from = Number(new URL(request.url).searchParams.get('from_rev'));
					return new HttpResponse(tailBody(from), {
						headers: { 'Content-Type': 'application/json' }
					});
				}),
				http.get(`${base}/metamodel`, () => {
					const failed = failure('metamodel');
					if (failed !== null) return failed;
					return HttpResponse.json(doc as unknown as Record<string, unknown>, {
						headers: { 'X-Metamodel-Id': metamodelId }
					});
				}),
				// The replica store's artifact follower asks the active project's own base.
				http.get(
					`${PAGE_ORIGIN}/api/v1/projects/${projectId}/artifacts/payloads`,
					({ request }) => {
						const ids = new URL(request.url).searchParams.getAll('id');
						const items = [...artifacts.values()].filter(
							(artifact) => ids.length === 0 || ids.includes(artifact.id)
						);
						return HttpResponse.json({ items });
					}
				),
				http.post(
					`${PAGE_ORIGIN}/api/v1/projects/${projectId}/rules/parse`,
					async ({ request }) => {
						const { yaml } = (await request.json()) as { yaml: string };
						rulesParsed.push(yaml);
						const answer = rulesParses.get(yaml);
						return answer === undefined
							? HttpResponse.json({ detail: 'no parse' }, { status: 422 })
							: HttpResponse.json(answer);
					}
				)
			];
		}
	};
	return project;
}

/**
 * A call the sync made through a link, as it was made: `byteLength` read
 * before any transfer; `result` is the answer once it came, if it resolved.
 */
export type RecordedCall = {
	method: string;
	params: unknown;
	byteLength: number | null;
	/** The `signal` the call was handed, if any. */
	signal?: AbortSignal;
	result?: unknown;
};

export type SyncOverrides = {
	connect?: () => Promise<EngineLink>;
	api?: Partial<SyncApi>;
	cache?: SnapshotCache;
	sleep?: (ms: number) => Promise<void>;
	heldFallback?: SyncDeps['heldFallback'];
	onAbandoned?: SyncDeps['onAbandoned'];
};

/**
 * A sync of `project` over the real engine (`connectInProcess()`), the real
 * replica API under `BASE`, and a real cache on a fresh `fake-indexeddb`.
 * `sleep` records its delay and resolves at once. Every link it made is in
 * `links`; `dispose()` stops the sync and disposes them all.
 */
export function syncOver(project: { projectId: string }, overrides: SyncOverrides = {}) {
	const statuses: ReplicaStatus[] = [];
	const watchers: { from: number; test: (s: ReplicaStatus) => boolean; resolve(): void }[] = [];
	const sleeps: number[] = [];
	const calls: RecordedCall[] = [];
	const links: EngineLink[] = [];
	let connects = 0;
	const cache = overrides.cache ?? createSnapshotCache({ factory: new IDBFactory() });
	const connect = overrides.connect ?? (() => Promise.resolve(connectInProcess()));

	const recorded = (made: EngineLink): EngineLink => {
		const call = <T>(method: string, params?: unknown, options?: CallOptions): Promise<T> => {
			const bytes = (params as { bytes?: unknown } | undefined)?.bytes;
			const entry: RecordedCall = {
				method,
				params,
				byteLength: bytes instanceof ArrayBuffer ? bytes.byteLength : null,
				...(options?.signal === undefined ? {} : { signal: options.signal })
			};
			calls.push(entry);
			return made.client.call<T>(method, params, options).then((result) => {
				entry.result = result;
				return result;
			});
		};
		return { ...made, client: { ...made.client, call } };
	};

	const deps: SyncDeps = {
		connect: async () => {
			connects += 1;
			const made = await connect();
			links.push(made);
			return recorded(made);
		},
		api: { ...replicaApi(BASE), ...overrides.api },
		cache,
		sleep:
			overrides.sleep ??
			((ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			}),
		...(overrides.heldFallback === undefined ? {} : { heldFallback: overrides.heldFallback }),
		...(overrides.onAbandoned === undefined ? {} : { onAbandoned: overrides.onAbandoned }),
		onStatus: (status) => {
			statuses.push(status);
			for (const watcher of [...watchers]) {
				if (statuses.length > watcher.from && watcher.test(status)) {
					watchers.splice(watchers.indexOf(watcher), 1);
					watcher.resolve();
				}
			}
		}
	};
	const sync: ReplicaSync = createReplicaSync(deps);
	// The sync learns its project at `open`; `project` names whose server it runs against.
	void project;
	return {
		sync,
		statuses,
		sleeps,
		calls,
		links,
		cache,
		/** The link made last. */
		get link(): EngineLink | undefined {
			return links.at(-1);
		},
		get connects() {
			return connects;
		},
		/** The methods called, in order. */
		methods: () => calls.map((call) => call.method),
		/**
		 * Resolves on the first status at index `from` or later that passes
		 * `test` — for what the engine starts on its own, such as the
		 * background digest check, which `settled()` does not wait for.
		 */
		until(test: (status: ReplicaStatus) => boolean, from = 0): Promise<void> {
			if (statuses.slice(from).some(test)) return Promise.resolve();
			return new Promise<void>((resolve) => watchers.push({ from, test, resolve }));
		},
		dispose() {
			sync.stop();
			for (const made of links) made.dispose();
		}
	};
}

/** The smart-city example as a gzipped v2 snapshot at rev 0 of project `p`, cut into pieces of `size` bytes. */
export function smartCitySnapshot(size = 4096): { doc: MetamodelDoc; chunks: ArrayBuffer[] } {
	const project = fakeProject();
	const bytes = new Uint8Array(project.snapshot().bytes);
	const chunks: ArrayBuffer[] = [];
	for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.slice(at, at + size).buffer);
	return { doc: project.doc, chunks };
}
