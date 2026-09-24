import type {
	DeltaResult,
	EndResult,
	ProgressTask,
	ServiceEvent,
	TailResult,
	WireArtifact,
	WireBatch,
	WireConflict,
	WireStagedArtifact
} from '$engine';
import { ValidationError } from '$lib/api/errors';
import {
	fetchMetamodelDocument,
	fetchSnapshot,
	fetchTail,
	getSnapshotDescriptor,
	type SnapshotDescriptor,
	type TailBody
} from '$lib/api/replica';
import type { SnapshotCache } from './cache';
import { EngineGoneError, type EngineClient, type EngineLink } from './client';

export type ReplicaPhase =
	| 'off'
	| 'opening'
	| 'ready'
	| 'resyncing'
	| 'frozen'
	| 'failed'
	| 'server';

export type ReplicaProgress = {
	task: 'download' | ProgressTask;
	done: number;
	/** `null` when the download's length is not known. */
	total: number | null;
};

/** The replica's state as the UI shows it; a new object on every change. */
export type ReplicaStatus = {
	phase: ReplicaPhase;
	rev: number | null;
	progress: ReplicaProgress | null;
	/** 1…3 while opening or resyncing, else 0. */
	attempt: number;
	source: 'cache' | 'network' | null;
	/** The frame's `crossOriginIsolated`; `null` before the handshake. */
	isolated: boolean | null;
	cspViolations: number;
	/** Why the phase is `off`, `frozen`, `failed` or `server`. */
	reason: string | null;
	/**
	 * The replica's issue store has been swept whole once. False for every
	 * new replica — a new run, a re-bootstrap, a new worker — until its first
	 * sweep ends; a sweep started again later keeps what it swept.
	 */
	seeded: boolean;
};

export const OFF: ReplicaStatus = {
	phase: 'off',
	rev: null,
	progress: null,
	attempt: 0,
	source: null,
	isolated: null,
	cspViolations: 0,
	reason: null,
	seeded: false
};

/** The server a sync reads from, each call scoped to the project it names. */
export type SyncApi = {
	descriptor(projectId: string): Promise<SnapshotDescriptor | null>;
	snapshot(url: string, signal: AbortSignal): Promise<Response>;
	tail(projectId: string, fromRev: number): Promise<TailBody>;
	metamodel(projectId: string): Promise<{ doc: unknown; metamodelId: string }>;
};

export type SyncDeps = {
	connect(): Promise<EngineLink>;
	api: SyncApi;
	cache: SnapshotCache;
	sleep(ms: number): Promise<void>;
	onStatus(status: ReplicaStatus): void;
	/**
	 * The staged and parked batches as the model store last read them, handed
	 * over when a re-bootstrap finds the worker gone and cannot ask it. The
	 * store leaves out the batches its own commits carried: they are committed.
	 */
	heldFallback?(): WireBatch[];
	/**
	 * The batches of the user's own commits whose answers no replica will
	 * apply now: the next replica does not hold them.
	 */
	onAbandoned?(batchIds: readonly number[]): void;
};

/** What the server answered to the user's own commit. */
export type CommitAnswer = {
	text: string;
	rev: number;
	applied: boolean;
	rebound: boolean;
	idMap: { [tempId: string]: string };
	batchIds?: number[];
};

export type CommitFlight = { settle(answer: CommitAnswer): void; abandon(): void };

/** The engine's `changed` event: what a transition or an applied delta moved. */
export type ChangedEvent = Extract<ServiceEvent, { event: 'changed' }>;

export type CallOptions = {
	signal?: AbortSignal;
	/** The call changes the replica: held for the phase alone, never for a `rev`. */
	transition?: boolean;
};

export type ReplicaSync = {
	/** Opens `projectId`'s replica; a no-op for the project already open, else `stop()` first. */
	open(projectId: string): void;
	/** Ends everything: the attempt in flight, the download, the link and the waiting inputs. */
	stop(): void;
	status(): ReplicaStatus;
	/** Resolves once no attempt runs, the pump is idle and no sleep is pending. */
	settled(): Promise<void>;
	feedCommit(raw: string, rev: number): void;
	feedRebind(rev: number): void;
	/** A snapshot event; in `off` it restarts the open, as the model may have come since. */
	feedSnapshot(modelRev: number): void;
	/**
	 * The server moved to `rev` without a journal row: a replica behind it
	 * re-bootstraps (its tail is incomplete), and `off` restarts the open.
	 */
	feedReset(rev: number): void;
	/** A `failed` replica re-bootstraps, adopting the batches it held; any other phase: nothing. */
	retry(): void;
	beginCommit(): CommitFlight;
	/**
	 * A commit is in flight, or the answer of one the user landed waits for a
	 * replica to apply it — while `frozen` or `failed`, until the replica
	 * after them does. Optional for a stand-in sync; `createReplicaSync`'s has it.
	 */
	ownPending?(): boolean;
	metamodelAdopted(): void;
	/**
	 * A read answered by the replica once its `rev` has reached every `rev`
	 * the sync was handed before the call (a feed delta, an applied commit
	 * response, a snapshot event, a reset event); a frozen or failed replica
	 * answers as it is. A `transition` waits for phase `ready` or `frozen`
	 * alone — while opening, resyncing or failed, so the batches a
	 * re-bootstrap carries are adopted first — and every call asked after it
	 * is posted after it. A call that finds the worker gone rebuilds a ready
	 * replica on a new one; a transition then waits for it, a read rejects.
	 * Rejects with `EngineGoneError` when there is no replica to ask — no
	 * open, phase `off` or `server`, a `stop()` meanwhile, a worker gone
	 * under a read.
	 */
	call<T>(method: string, params?: unknown, options?: CallOptions): Promise<T>;
	/**
	 * Hands every `changed` event of every engine the sync links to `listener`,
	 * whatever the phase; the returned function unsubscribes.
	 */
	on(event: 'changed', listener: (event: ChangedEvent) => void): () => void;
	/** The element ids a view places; kept, and sent to every engine the sync connects. */
	setViewPlacement(viewId: string, elementIds: readonly string[]): void;
	dropViewPlacement(viewId: string): void;
	/**
	 * The project's committed artifacts, replacing those kept; kept, and sent
	 * with the staged entries to every engine the sync connects.
	 */
	setArtifacts(artifacts: readonly WireArtifact[]): void;
	/** Upserts `changed`, drops `deletedIds` and, when given, replaces the staged entries, in one call. */
	putArtifacts(
		changed: readonly WireArtifact[],
		deletedIds: readonly string[],
		staged?: readonly WireStagedArtifact[]
	): void;
	/** The frontend's staged artifact buffer, replacing the entries kept. */
	setStagedArtifacts(entries: readonly WireStagedArtifact[]): void;
};

/** Every call scoped to its own project, whatever project is active by then. */
export function replicaApi(root = '/api/v1'): SyncApi {
	const scoped = (projectId: string) => ({ baseUrl: `${root}/projects/${projectId}` });
	return {
		descriptor: (projectId) => getSnapshotDescriptor(scoped(projectId)),
		snapshot: (url, signal) => fetchSnapshot(url, signal),
		tail: (projectId, fromRev) => fetchTail(fromRev, scoped(projectId)),
		metamodel: (projectId) => fetchMetamodelDocument(scoped(projectId))
	};
}

/** Inputs that wait while the replica is not ready; past this many, a catch-up replaces them. */
export const WAITING_MAX = 1000;
const ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 3000];
/** Metamodel-id mismatches an open restarts from for free: a rebind landed mid-open. */
const FREE_RESTARTS = 3;

/** The open was stopped; whatever it was waiting for no longer matters. */
class Stopped extends Error {
	constructor() {
		super('stopped');
		this.name = 'Stopped';
	}
}

/** The engine could not be reached at all: a frame that did not load will not load a second later. */
class LinkFailed extends Error {
	constructor(cause: unknown) {
		super(reasonOf(cause), { cause });
		this.name = 'LinkFailed';
	}
}

/** The cached bytes were refused: dropped, and read again from the network at no charge. */
class CachedBytesRefused extends Error {
	constructor(cause: unknown) {
		super(reasonOf(cause), { cause });
		this.name = 'CachedBytesRefused';
	}
}

class MetamodelMismatch extends Error {
	constructor(served: string, expected: string) {
		super(`the metamodel served is ${served || 'unnamed'}, the snapshot's ${expected}`);
		this.name = 'MetamodelMismatch';
	}
}

class HeaderMismatch extends Error {
	constructor(header: EndResult, descriptor: SnapshotDescriptor) {
		super(
			`the snapshot holds rev ${header.rev} of ${header.metamodel_id}, ` +
				`its descriptor names rev ${descriptor.rev} of ${descriptor.metamodel_id}`
		);
		this.name = 'HeaderMismatch';
	}
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type Own = { batch_ids: number[]; id_map: { [tempId: string]: string } };

type Input =
	/** `retried`: it already waited once for the replica to reach it; a second failure drops it. */
	| { kind: 'delta'; raw: string; rev: number; own?: Own; retried?: boolean }
	| { kind: 'snapshot'; modelRev: number }
	| { kind: 'catch-up' };

const isOwn = (input: Input): boolean => input.kind === 'delta' && input.own !== undefined;

/** One `open()`, until `stop()`: every continuation checks it is still the current one. */
type Run = {
	readonly projectId: string;
	readonly controller: AbortController;
	everReady: boolean;
	/**
	 * Moves on every re-bootstrap and freeze: whatever the pump began under an
	 * older one speaks for a replica that is gone, and is not acted on.
	 */
	epoch: number;
	/** The epoch whose drain runs, if one does. */
	draining: number | null;
	/** Commits whose response has not come back: the pump holds while any is open. */
	flights: number;
	/** The open or re-bootstrap running now; a new one is its own cycle. */
	cycle: Cycle | null;
	cycling: boolean;
	/** A re-bootstrap was asked for while a cycle ran: it runs once more, after. */
	again: boolean;
	/**
	 * The staged and parked batches a re-bootstrap took, held until a replica
	 * adopted them and is ready — through a `failed` or an `off` in between.
	 */
	held: WireBatch[] | null;
	/**
	 * The batches of the user's own commits whose answers were dropped: no
	 * replica applies them, so none adopts them either.
	 */
	abandoned: Set<number>;
	/** The input the pump is handling. */
	handling: Input | null;
	connecting: Promise<EngineLink> | null;
	/** The highest rev a rebind froze the replica at; a rebind at or below it is its echo. */
	frozenAt: number;
};

/** One open or re-bootstrap, with its attempts; a freeze or a stop ends it. */
type Cycle = { readonly run: Run; readonly controller: AbortController };

/** The replica the pump worked for was replaced while it waited; the input goes back. */
class Superseded extends Error {
	constructor() {
		super('superseded');
		this.name = 'Superseded';
	}
}

/**
 * A call held in the shell: a read until the replica has reached `target`,
 * a transition until the phase takes it.
 */
type Waiter = {
	/** Arrival order: a transition held again after its worker died keeps its place. */
	readonly seq: number;
	readonly target: number;
	readonly transition: boolean;
	release(): void;
	refuse(error: unknown): void;
};

const aborted = () => new DOMException('The operation was aborted.', 'AbortError');

/** Transferring a view's `buffer` sends the WHOLE buffer, so a view is copied first. */
function exactBuffer(chunk: Uint8Array): ArrayBuffer {
	if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
		return chunk.buffer as ArrayBuffer;
	}
	return chunk.slice().buffer;
}

function joined(pieces: readonly ArrayBuffer[]): ArrayBuffer {
	const size = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
	const out = new Uint8Array(size);
	let at = 0;
	for (const piece of pieces) {
		out.set(new Uint8Array(piece), at);
		at += piece.byteLength;
	}
	return out.buffer;
}

/**
 * The replica's life, and the one place that knows the order of things. An
 * open is: the snapshot descriptor, the metamodel it was written under, the
 * bytes from the cache or the network, the engine's header, the tail to
 * head, ready. From then on it follows the feed: deltas in `rev` order, a gap
 * healed through the tail, and a re-bootstrap — the staged batches carried
 * over — when the tail cannot heal it or the replica diverged. A metamodel
 * rebind freezes it until the UI adopts the new metamodel.
 */
export function createReplicaSync(deps: SyncDeps): ReplicaSync {
	let status: ReplicaStatus = OFF;
	let run: Run | null = null;
	let link: EngineLink | null = null;
	let detach: (() => void)[] = [];
	const queue: Input[] = [];
	let busy = 0;
	const idle: (() => void)[] = [];
	/** The highest `rev` the sync has been handed since `open()`: what a read waits for. */
	let known = 0;
	const waiters: Waiter[] = [];
	/** Calls asked so far: a held call's place in arrival order. */
	let calls = 0;
	const placements = new Map<string, readonly string[]>();
	const artifacts = new Map<string, WireArtifact>();
	let stagedArtifacts: readonly WireStagedArtifact[] = [];
	const changedListeners = new Set<(event: ChangedEvent) => void>();
	/**
	 * The engine said its replica is `ready` since the replica the shell opens
	 * now began: only that replica's sweep may seed it, never one it replaced.
	 */
	let sweeping = false;

	const set = (patch: Partial<ReplicaStatus>) => {
		// Opening and re-bootstrapping begin a replica whose store is not swept.
		if (patch.phase === 'opening' || patch.phase === 'resyncing') {
			sweeping = false;
			patch = { ...patch, seeded: false };
		}
		status = { ...status, ...patch };
		deps.onStatus(status);
		examine();
	};

	/** The one place `known` rises. */
	const tell = (rev: number) => {
		if (rev > known) known = rev;
	};

	/** Whether a read held for `target` may go to the engine now. */
	const answers = (target: number): boolean => {
		const phase = status.phase;
		if (phase === 'frozen' || phase === 'failed') return true;
		return phase === 'ready' && status.rev !== null && status.rev >= target;
	};

	/**
	 * Whether a transition may go to the engine now: the phase alone, never
	 * the rev — and a worker to take it, since one gone is replaced by a
	 * re-bootstrap that adopts the batches first.
	 */
	const admits = (): boolean =>
		(status.phase === 'ready' || status.phase === 'frozen') && link !== null;

	const due = (waiter: Waiter): boolean => (waiter.transition ? admits() : answers(waiter.target));

	/**
	 * No replica to ask: none, or a frozen one whose worker is gone — the
	 * adoption rebuilds it, with the batches it held, and until then an edit
	 * waiting for it would hold every commit and read behind it.
	 */
	const refuses = (): boolean =>
		status.phase === 'off' ||
		status.phase === 'server' ||
		(status.phase === 'frozen' && link === null);

	const refuseWaiters = () => {
		for (const waiter of waiters.splice(0)) waiter.refuse(new EngineGoneError());
	};

	/**
	 * Releases, in arrival order, every held call the status now allows. A
	 * transition still held holds everything behind it; a read still held
	 * holds nothing.
	 */
	const examine = () => {
		if (waiters.length === 0) return;
		if (refuses()) {
			refuseWaiters();
			return;
		}
		const going: Waiter[] = [];
		for (const waiter of waiters) {
			if (due(waiter)) going.push(waiter);
			else if (waiter.transition) break;
		}
		if (going.length === 0) return;
		for (const waiter of going) waiters.splice(waiters.indexOf(waiter), 1);
		for (const waiter of going) waiter.release();
	};

	/** Holds `waiter` at its place in arrival order. */
	const hold = (waiter: Waiter) => {
		let at = waiters.length;
		while (at > 0 && waiters[at - 1]!.seq > waiter.seq) at -= 1;
		waiters.splice(at, 0, waiter);
	};

	/**
	 * The answers of the user's own commits in `dropped` will be applied by
	 * no replica: their batches leave what the run holds and stay out of
	 * every replica it opens, and the model store is told.
	 */
	const forget = (r: Run, dropped: readonly Input[]) => {
		const ids: number[] = [];
		for (const input of dropped) {
			if (input.kind !== 'delta' || input.own === undefined) continue;
			for (const id of input.own.batch_ids) {
				r.abandoned.add(id);
				ids.push(id);
			}
		}
		if (ids.length === 0) return;
		if (r.held !== null) r.held = r.held.filter((batch) => !r.abandoned.has(batch.id));
		deps.onAbandoned?.(ids);
	};

	/** Empties the waiting inputs, the user's own answers with them. */
	const dropQueue = (r: Run) => {
		const dropped = queue.splice(0);
		forget(r, dropped);
	};

	const learnRev = (rev: number) => {
		if (status.rev !== rev) set({ rev });
	};

	/** Counts `work` toward `settled()`. It must not reject. */
	const track = (work: Promise<void>) => {
		busy += 1;
		const done = () => {
			busy -= 1;
			if (busy === 0) for (const resolve of idle.splice(0)) resolve();
		};
		work.then(done, (error: unknown) => {
			done();
			queueMicrotask(() => {
				throw error;
			});
		});
	};

	/** `work`, unless the token is aborted first: then a `Stopped`, at once. */
	const guard = <T>(token: { controller: AbortController }, work: Promise<T>): Promise<T> => {
		const signal = token.controller.signal;
		return new Promise<T>((resolve, reject) => {
			const stopped = () => reject(new Stopped());
			if (signal.aborted) {
				work.catch(() => {});
				stopped();
				return;
			}
			signal.addEventListener('abort', stopped, { once: true });
			work.then(
				(value) => {
					signal.removeEventListener('abort', stopped);
					if (signal.aborted) stopped();
					else resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener('abort', stopped);
					reject(signal.aborted ? new Stopped() : error);
				}
			);
		});
	};

	/**
	 * The worker behind `made` is gone: the link goes, and a replica being
	 * followed is rebuilt on a new one. A frozen replica is rebuilt by the
	 * adoption, a failed one by `retry()`, the same way.
	 */
	const lost = (r: Run, made: EngineLink) => {
		if (link !== made) return;
		dropLink();
		ask(r, r.epoch);
	};

	const current = (c: Cycle): boolean =>
		run === c.run && c.run.cycle === c && !c.controller.signal.aborted;

	// -- the link --------------------------------------------------------------

	const dropLink = () => {
		for (const off of detach.splice(0)) off();
		const gone = link;
		link = null;
		gone?.dispose();
	};

	/** Placements are context: a refusal, or a worker gone, changes nothing to wait for. */
	const sendPlacement = (engine: EngineClient, viewId: string, ids: readonly string[] | null) => {
		const sent =
			ids === null
				? engine.call('dropViewPlacement', { view_id: viewId })
				: engine.call('setViewPlacement', { view_id: viewId, element_ids: ids });
		sent.catch(() => {});
	};

	/** Artifacts are context as placements are; a new worker starts with none. */
	const sendArtifacts = (engine: EngineClient, method: string, params: object) => {
		engine.call(method, params).catch(() => {});
	};

	const adopt = (r: Run, made: EngineLink) => {
		link = made;
		sweeping = false;
		// Before anything else reaches the new engine: no held read overtakes them.
		for (const [viewId, ids] of placements) sendPlacement(made.client, viewId, ids);
		if (artifacts.size > 0) {
			sendArtifacts(made.client, 'setArtifacts', { artifacts: [...artifacts.values()] });
		}
		if (stagedArtifacts.length > 0) {
			sendArtifacts(made.client, 'setStagedArtifacts', { entries: stagedArtifacts });
		}
		set({ isolated: made.isolated });
		detach = [
			made.client.on((event) => onEngineEvent(r, event)),
			made.client.on((event) => {
				if (event.event === 'changed' && link === made) forwardChanged(event);
			}),
			made.onViolation(() => {
				if (link === made) set({ cspViolations: status.cspViolations + 1 });
			})
		];
	};

	/**
	 * The link, built on first need and shared by every cycle of the run that
	 * asks while it is being built; one that arrives after its run was stopped
	 * is disposed.
	 */
	const client = async (c: Cycle): Promise<EngineClient> => {
		if (link !== null) return link.client;
		const r = c.run;
		if (r.connecting === null) {
			const pending = deps.connect().then((made) => {
				if (run !== r) {
					made.dispose();
					throw new Stopped();
				}
				adopt(r, made);
				return made;
			});
			r.connecting = pending;
			const clear = () => {
				if (r.connecting === pending) r.connecting = null;
			};
			pending.then(clear, clear);
		}
		try {
			return (await guard(c, r.connecting)).client;
		} catch (error) {
			throw error instanceof Stopped ? error : new LinkFailed(error);
		}
	};

	/**
	 * Only while the replica is ready does an engine `replica` event speak of
	 * the replica the shell follows; before, it speaks of one an attempt is
	 * still opening, and the attempt reads its outcome from the answers. A
	 * `sweep` report is not progress the UI shows: its end seeds the replica
	 * the engine last called `ready`, in any phase — the events come in the
	 * engine's order, so a replica's end of sweep never comes before its
	 * `ready`, nor one a new replica replaced after the new one began.
	 */
	const onEngineEvent = (r: Run, event: ServiceEvent) => {
		if (run !== r) return;
		const phase = status.phase;
		if (event.event === 'progress') {
			if (event.task === 'sweep') {
				if (sweeping && event.done === event.total && !status.seeded) set({ seeded: true });
				return;
			}
			const opening = phase === 'opening' || phase === 'resyncing';
			if (opening || (event.task === 'verify' && phase === 'ready')) {
				set({ progress: { task: event.task, done: event.done, total: event.total } });
			}
		} else if (event.event === 'replica') {
			sweeping = event.state === 'ready';
			// A replica gone from `ready` (diverged, closed) took its store with it.
			if (!sweeping && status.seeded) set({ seeded: false });
			if (phase !== 'ready') return;
			if (event.rev !== null) learnRev(event.rev);
			if (event.state === 'diverged') ask(r, r.epoch);
		}
	};

	const forwardChanged = (event: ChangedEvent) => {
		for (const listener of [...changedListeners]) {
			if (!changedListeners.has(listener)) continue;
			try {
				listener(event);
			} catch (error) {
				// One failing listener must not starve the others; the error still surfaces.
				queueMicrotask(() => {
					throw error;
				});
			}
		}
	};

	// -- opening ---------------------------------------------------------------

	/** Sends the bytes; `sent` settles once every chunk is taken, rejecting with the first refusal. */
	const sendCached = (engine: EngineClient, bytes: ArrayBuffer): Promise<void> => {
		set({ source: 'cache' });
		return engine.call<null>('chunk', { bytes }, { transfer: [bytes] }).then(() => undefined);
	};

	const download = async (
		c: Cycle,
		engine: EngineClient,
		url: string
	): Promise<{ sent: Promise<void>; copies: ArrayBuffer[] }> => {
		set({ source: 'network' });
		const response = await guard(c, deps.api.snapshot(url, c.controller.signal));
		const length = response.headers.get('Content-Length');
		const parsed = length === null ? NaN : Number.parseInt(length, 10);
		const total = Number.isFinite(parsed) ? parsed : null;
		if (response.body === null) throw new Error('the snapshot response has no body');
		const reader = response.body.getReader();
		const copies: ArrayBuffer[] = [];
		const calls: Promise<unknown>[] = [];
		let done = 0;
		set({ progress: { task: 'download', done, total } });
		try {
			for (;;) {
				const next = await guard(c, reader.read());
				if (next.done) break;
				// Read before the transfer, which may detach the chunk's own buffer.
				done += next.value.byteLength;
				const bytes = exactBuffer(next.value);
				copies.push(bytes.slice(0));
				// Not awaited one by one: a refusal is what `end` answers too.
				calls.push(engine.call<null>('chunk', { bytes }, { transfer: [bytes] }));
				set({ progress: { task: 'download', done, total } });
			}
		} catch (error) {
			void reader.cancel().catch(() => {});
			void Promise.allSettled(calls);
			throw error;
		}
		return { sent: Promise.all(calls).then(() => undefined), copies };
	};

	/** One attempt; resolves `'no model'`, or once the replica is ready. */
	const attempt = async (
		c: Cycle,
		cacheAllowed: boolean,
		batches: WireBatch[] | null
	): Promise<'ready' | 'no model'> => {
		const r = c.run;
		const projectId = r.projectId;
		const descriptor = await guard(c, deps.api.descriptor(projectId));
		if (descriptor === null) return 'no model';
		const engine = await client(c);
		const { doc, metamodelId } = await guard(c, deps.api.metamodel(projectId));
		if (metamodelId !== descriptor.metamodel_id) {
			throw new MetamodelMismatch(metamodelId, descriptor.metamodel_id);
		}
		await guard(c, engine.call('open', { project_id: projectId, metamodel: doc }));

		const cached = cacheAllowed ? await guard(c, deps.cache.get(projectId, descriptor.rev)) : null;
		let copies: ArrayBuffer[] | null = null;
		let sent: Promise<void>;
		if (cached !== null) {
			sent = sendCached(engine, cached);
		} else {
			({ sent, copies } = await download(c, engine, descriptor.url));
		}
		sent.catch(() => {});
		let header: EndResult;
		try {
			header = await guard(c, engine.call<EndResult>('end'));
			await guard(c, sent);
			if (header.rev !== descriptor.rev || header.metamodel_id !== descriptor.metamodel_id) {
				throw new HeaderMismatch(header, descriptor);
			}
		} catch (error) {
			const refused = error instanceof ValidationError || error instanceof HeaderMismatch;
			if (cached !== null && refused) throw new CachedBytesRefused(error);
			throw error;
		}
		// Only bytes the engine has read whole are cached.
		if (copies !== null) track(deps.cache.put(projectId, header.rev, joined(copies)));

		if (batches !== null) await guard(c, engine.call('adoptStaged', { batches }));
		const tail = await guard(c, deps.api.tail(projectId, header.rev));
		// The descriptor promised a complete tail: something moved, most likely a rebind.
		if (!tail.complete) throw new Error(`the tail from rev ${header.rev} is not complete`);
		const result = await guard(c, engine.call<TailResult>('applyTail', { text: tail.text }));
		if (result.diverged) throw new Error(`the replica diverged at rev ${result.rev}`);
		if (result.status === 'gap') {
			throw new Error(`the tail from rev ${header.rev} does not continue the snapshot`);
		}
		r.everReady = true;
		r.held = null;
		// The replica holds none of them: a batch numbered alike from now on is a new one.
		r.abandoned.clear();
		set({ phase: 'ready', rev: result.rev, attempt: 0, progress: null, reason: null });
		pump(r);
		return 'ready';
	};

	/** `close` on the engine, its answer ignored; false once the cycle is over. */
	const closeReplica = async (c: Cycle): Promise<boolean> => {
		if (link === null) return current(c);
		try {
			await guard(c, link.client.call('close'));
		} catch (error) {
			if (error instanceof Stopped) return false;
		}
		return current(c);
	};

	/** Up to three attempts, 1 s and 3 s apart; the last failure decides the phase. */
	const openReplica = async (
		c: Cycle,
		phase: 'opening' | 'resyncing',
		batches: WireBatch[] | null,
		cacheAllowed: boolean
	): Promise<void> => {
		const r = c.run;
		let failures = 0;
		let freeRestarts = 0;
		for (;;) {
			set({ phase, attempt: failures + 1, progress: null, source: null, reason: null });
			let outcome: 'ready' | 'no model';
			try {
				outcome = await attempt(c, cacheAllowed, batches);
			} catch (error) {
				if (error instanceof Stopped || !current(c)) return;
				// A frame that did not load will not load a second later.
				if (error instanceof LinkFailed) {
					giveUp(r, error.message);
					return;
				}
				if (error instanceof CachedBytesRefused) {
					cacheAllowed = false;
					await guard(c, deps.cache.drop(r.projectId)).catch(() => {});
					if (!(await closeReplica(c))) return;
					continue;
				}
				if (error instanceof MetamodelMismatch && freeRestarts < FREE_RESTARTS) {
					freeRestarts += 1;
					continue;
				}
				failures += 1;
				// A link whose engine went away is rebuilt by the next attempt.
				if (error instanceof EngineGoneError) dropLink();
				if (!(await closeReplica(c))) return;
				if (failures >= ATTEMPTS) {
					giveUp(r, reasonOf(error));
					return;
				}
				try {
					await guard(c, deps.sleep(RETRY_DELAYS_MS[failures - 1]!));
				} catch (slept) {
					if (slept instanceof Stopped || !current(c)) return;
					giveUp(r, reasonOf(slept));
					return;
				}
				continue;
			}
			if (outcome === 'no model') {
				dropQueue(r);
				set({
					phase: 'off',
					rev: null,
					attempt: 0,
					progress: null,
					source: null,
					reason: 'no model'
				});
			}
			return;
		}
	};

	/**
	 * Before the first ready of an open, the server serves instead; after it,
	 * the replica has failed — a worker that cannot be reached again included —
	 * and `retry()` rebuilds it with the batches the run holds. A failed
	 * replica keeps the user's own commits for the one a retry rebuilds: the
	 * batches it holds include the ones those commits carried, which only
	 * their bookkeeping drops.
	 */
	const giveUp = (r: Run, reason: string) => {
		if (r.everReady) {
			const own = queue.filter(isOwn);
			queue.length = 0;
			queue.push(...own);
			set({ phase: 'failed', attempt: 0, progress: null, reason });
		} else {
			dropQueue(r);
			dropLink();
			set({ phase: 'server', attempt: 0, progress: null, reason });
		}
	};

	// -- re-bootstrap ----------------------------------------------------------

	/**
	 * A fresh replica from a fresh snapshot, on the same worker: the staged and
	 * parked batches are read first and held — once the engine is told `close`
	 * it no longer has them — and every attempt adopts them. A worker that is
	 * gone cannot be asked: the model store's copy of them is held instead.
	 * The cache is not read, and its row is dropped: bytes a replica diverged
	 * from must not open the next one.
	 */
	const resync = async (c: Cycle): Promise<void> => {
		const r = c.run;
		set({ phase: 'resyncing', attempt: 1, progress: null, source: null, reason: null });
		if (r.held === null) {
			let batches: WireBatch[] | null = null;
			if (link !== null) {
				const engine = link.client;
				try {
					const [staged, conflicts] = await guard(
						c,
						Promise.all([
							engine.call<WireBatch[]>('staged'),
							engine.call<WireConflict[]>('conflicts')
						])
					);
					batches = [...staged, ...conflicts.map((conflict) => conflict.batch)];
				} catch (error) {
					if (error instanceof Stopped || !current(c)) return;
					if (!(error instanceof EngineGoneError)) {
						giveUp(r, reasonOf(error));
						return;
					}
					dropLink();
				}
			}
			batches ??= [...(deps.heldFallback?.() ?? [])];
			batches.sort((a, b) => a.id - b.id);
			r.held = batches.filter((batch) => !r.abandoned.has(batch.id));
		}
		try {
			await guard(c, deps.cache.drop(r.projectId));
		} catch {
			if (!current(c)) return;
		}
		if (!(await closeReplica(c))) return;
		await openReplica(c, 'resyncing', r.held, false);
	};

	/** Opens, then re-bootstraps once more for every time one was asked for meanwhile. */
	const cycles = async (r: Run, first: 'opening' | 'resyncing'): Promise<void> => {
		r.cycling = true;
		try {
			let kind = first;
			for (;;) {
				r.again = false;
				const c: Cycle = { run: r, controller: new AbortController() };
				r.cycle = c;
				// A reopen after `off` carries what a re-bootstrap before it held.
				if (kind === 'opening') await openReplica(c, 'opening', r.held, true);
				else await resync(c);
				if (!r.again || run !== r) return;
				kind = 'resyncing';
			}
		} finally {
			r.cycling = false;
		}
	};

	const rebootstrap = (r: Run) => {
		r.epoch += 1;
		if (r.cycling) {
			r.again = true;
			set({ phase: 'resyncing', attempt: 1, progress: null, source: null, reason: null });
			return;
		}
		track(cycles(r, 'resyncing'));
	};

	/**
	 * The open again, for a run that found no model: one may have come since.
	 * The run, its link and the batches it holds stay; a cycle still ending
	 * runs once more instead.
	 */
	const wake = (r: Run) => {
		if (r.cycling) {
			r.again = true;
			return;
		}
		set({ phase: 'opening', attempt: 1, progress: null, source: null, reason: null });
		track(cycles(r, 'opening'));
	};

	/**
	 * A re-bootstrap asked for by whatever judged the replica of `epoch`; one
	 * already replaced, or no longer followed, is not rebuilt again.
	 */
	const ask = (r: Run, epoch: number) => {
		if (run !== r || r.epoch !== epoch || status.phase !== 'ready') return;
		rebootstrap(r);
	};

	/**
	 * The replica stays as it is and follows nothing until the UI adopts the
	 * new metamodel. A rebind already frozen at — the feed's echo of the
	 * user's own, which may come after the adoption — changes nothing, nor
	 * does one a ready replica is already past: it opened from a snapshot
	 * written under the new metamodel.
	 */
	const freeze = (r: Run, rev: number) => {
		const phase = status.phase;
		if (phase !== 'opening' && phase !== 'ready' && phase !== 'resyncing' && phase !== 'frozen') {
			return;
		}
		if (rev <= r.frozenAt) return;
		if (phase === 'ready' && status.rev !== null && rev <= status.rev) return;
		r.frozenAt = rev;
		r.epoch += 1;
		r.again = false;
		r.cycle?.controller.abort();
		// The user's own commits keep their bookkeeping for the replica that comes next.
		const own = queue.filter(isOwn);
		queue.length = 0;
		queue.push(...own);
		set({
			phase: 'frozen',
			attempt: 0,
			progress: null,
			source: null,
			reason: `metamodel changed at rev ${rev}`
		});
	};

	// -- following -------------------------------------------------------------

	/** Deltas wait in `rev` order; the user's own goes before its echo. */
	const place = (input: Input) => {
		if (input.kind !== 'delta') {
			queue.push(input);
			return;
		}
		let at = queue.length;
		for (let i = queue.length - 1; i >= 0; i--) {
			const other = queue[i]!;
			if (other.kind !== 'delta') continue;
			if (other.rev > input.rev || (input.own !== undefined && other.rev === input.rev)) at = i;
			else break;
		}
		queue.splice(at, 0, input);
	};

	/** Every input waits while a replica is, or is being, followed; frozen or failed, the user's own commits alone. */
	const waits = (input: Input): boolean => {
		const phase = status.phase;
		if (phase === 'opening' || phase === 'resyncing' || phase === 'ready') return true;
		return (phase === 'frozen' || phase === 'failed') && isOwn(input);
	};

	const enqueue = (input: Input) => {
		const r = run;
		if (r === null) return;
		if (!waits(input)) {
			forget(r, [input]);
			return;
		}
		if (queue.length >= WAITING_MAX) {
			// The tail brings the replica to head, past whatever was waiting.
			const own = queue.filter(isOwn);
			queue.length = 0;
			queue.push({ kind: 'catch-up' }, ...own);
			if (isOwn(input)) place(input);
		} else {
			place(input);
		}
		pump(r);
	};

	/** An input whose replica was replaced under it waits for the next one. */
	const requeue = (input: Input) => {
		if (!waits(input)) return;
		if (input.kind === 'delta') place(input);
		else queue.unshift(input);
	};

	const following = (r: Run, epoch: number): boolean =>
		run === r && r.epoch === epoch && status.phase === 'ready';

	/** The engine, while the replica of `epoch` is still the one followed. */
	const live = (r: Run, epoch: number): EngineClient => {
		if (run !== r || link === null) throw new Stopped();
		if (!following(r, epoch)) throw new Superseded();
		return link.client;
	};

	/** Handles the waiting inputs one at a time, each to its end, while ready and no commit is in flight. */
	const pump = (r: Run) => {
		if (run !== r || status.phase !== 'ready' || r.flights > 0) return;
		if (r.draining === r.epoch || queue.length === 0) return;
		r.draining = r.epoch;
		track(drain(r, r.epoch));
	};

	const drain = async (r: Run, epoch: number): Promise<void> => {
		try {
			while (following(r, epoch) && r.flights === 0 && queue.length > 0) {
				const input = queue.shift()!;
				r.handling = input;
				try {
					await handle(r, epoch, input);
				} catch (error) {
					if (run !== r || error instanceof Stopped) return;
					if (error instanceof Superseded || !following(r, epoch)) {
						requeue(input);
						// The next replica may be following already, its own drain done.
						pump(r);
						return;
					}
					// A failed call or fetch: a re-bootstrap has retries of its own, and a
					// delta waits for the replica it brings, once.
					if (error instanceof EngineGoneError) dropLink();
					if (input.kind === 'delta' && input.retried !== true) {
						requeue({ ...input, retried: true });
					} else {
						forget(r, [input]);
					}
					ask(r, epoch);
				} finally {
					if (r.handling === input) r.handling = null;
				}
			}
		} finally {
			if (r.draining === epoch) r.draining = null;
		}
	};

	const handle = async (r: Run, epoch: number, input: Input): Promise<void> => {
		const rev = status.rev ?? 0;
		switch (input.kind) {
			case 'delta': {
				// Already covered — unless it is the user's own, which still has bookkeeping to do.
				if (input.own === undefined && input.rev <= rev) return;
				const params =
					input.own === undefined ? { text: input.raw } : { text: input.raw, own: input.own };
				const result = await guard(r, live(r, epoch).call<DeltaResult>('applyDelta', params));
				live(r, epoch);
				learnRev(result.rev);
				if (result.diverged) {
					ask(r, epoch);
				} else if (result.status === 'gap') {
					if (input.retried === true) {
						ask(r, epoch);
						return;
					}
					await catchUp(r, epoch);
					// The user's own commit goes again once the replica has reached it.
					if (input.own !== undefined) requeue({ ...input, retried: true });
				}
				return;
			}
			case 'snapshot':
				if (input.modelRev > rev) await catchUp(r, epoch);
				return;
			case 'catch-up':
				await catchUp(r, epoch);
				return;
		}
	};

	/**
	 * The tail from the replica's rev to head, in one go; one that cannot heal
	 * re-bootstraps. A fetch that throws is tried once more, a second later.
	 */
	const catchUp = async (r: Run, epoch: number): Promise<void> => {
		const fetchTail = () => guard(r, deps.api.tail(r.projectId, status.rev ?? 0));
		let tail: TailBody;
		try {
			tail = await fetchTail();
		} catch (error) {
			if (error instanceof Stopped) throw error;
			await guard(r, deps.sleep(1000));
			live(r, epoch);
			tail = await fetchTail();
		}
		if (!tail.complete) {
			ask(r, epoch);
			return;
		}
		const result = await guard(
			r,
			live(r, epoch).call<TailResult>('applyTail', { text: tail.text })
		);
		live(r, epoch);
		learnRev(result.rev);
		if (result.diverged || result.status === 'gap') ask(r, epoch);
	};

	// -- the surface -----------------------------------------------------------

	const stop = () => {
		const r = run;
		run = null;
		r?.controller.abort();
		r?.cycle?.controller.abort();
		queue.length = 0;
		known = 0;
		placements.clear();
		// The link goes with its worker, and with it the engine's own copy.
		artifacts.clear();
		stagedArtifacts = [];
		dropLink();
		sweeping = false;
		refuseWaiters();
		if (status !== OFF) {
			status = OFF;
			deps.onStatus(status);
		}
	};

	return {
		open(projectId) {
			if (run !== null && run.projectId === projectId) return;
			// Placements registered before the first open are this project's own.
			if (run !== null) stop();
			known = 0;
			const r: Run = {
				projectId,
				controller: new AbortController(),
				everReady: false,
				epoch: 0,
				draining: null,
				flights: 0,
				cycle: null,
				cycling: false,
				again: false,
				held: null,
				abandoned: new Set(),
				handling: null,
				connecting: null,
				frozenAt: -1
			};
			run = r;
			set({ ...OFF, phase: 'opening', attempt: 1 });
			track(cycles(r, 'opening'));
		},

		stop,

		status: () => status,

		settled() {
			if (busy === 0) return Promise.resolve();
			return new Promise<void>((resolve) => idle.push(resolve));
		},

		feedCommit(raw, rev) {
			tell(rev);
			enqueue({ kind: 'delta', raw, rev });
		},

		feedSnapshot(modelRev) {
			tell(modelRev);
			if (run !== null && status.phase === 'off') wake(run);
			else enqueue({ kind: 'snapshot', modelRev });
		},

		feedReset(rev) {
			tell(rev);
			// A snapshot event ahead of the replica: the tail cannot cross the hole, so it re-bootstraps.
			if (run !== null && status.phase === 'off') wake(run);
			else enqueue({ kind: 'snapshot', modelRev: rev });
		},

		retry() {
			if (run !== null && status.phase === 'failed') rebootstrap(run);
		},

		feedRebind(rev) {
			if (run !== null) freeze(run, rev);
		},

		beginCommit() {
			const r = run;
			if (r === null) return { settle() {}, abandon() {} };
			r.flights += 1;
			let open = true;
			const land = (): boolean => {
				if (!open) return false;
				open = false;
				r.flights -= 1;
				return run === r;
			};
			return {
				settle(answer) {
					if (!land()) return;
					if (answer.applied) tell(answer.rev);
					if (answer.rebound) {
						freeze(r, answer.rev);
					} else if (answer.applied) {
						const own = { batch_ids: answer.batchIds ?? [], id_map: answer.idMap };
						enqueue({ kind: 'delta', raw: answer.text, rev: answer.rev, own });
					}
					pump(r);
				},
				abandon() {
					if (land()) pump(r);
				}
			};
		},

		ownPending() {
			const r = run;
			if (r === null) return false;
			return r.flights > 0 || queue.some(isOwn) || (r.handling !== null && isOwn(r.handling));
		},

		metamodelAdopted() {
			if (run !== null && status.phase === 'frozen') rebootstrap(run);
		},

		call<T>(method: string, params?: unknown, options: CallOptions = {}) {
			const { signal } = options;
			const transition = options.transition === true;
			const r = run;
			if (r === null || refuses()) return Promise.reject(new EngineGoneError());
			if (signal?.aborted) return Promise.reject(aborted());
			const target = known;
			const seq = (calls += 1);
			const post = (): Promise<T> => {
				const made = link;
				if (made === null) return Promise.reject(new EngineGoneError());
				const sent = made.client.call<T>(method, params, signal === undefined ? {} : { signal });
				return sent.catch((error: unknown) => {
					if (!(error instanceof EngineGoneError) || run !== r) throw error;
					// The worker died under the call: the replica is rebuilt on a new one,
					// and a transition waits for it, behind the batches it adopts.
					lost(r, made);
					if (!transition || refuses()) throw error;
					return wait(true);
				});
			};
			/** `again`: a transition held once more, which the status may admit already. */
			const wait = (again = false): Promise<T> =>
				new Promise<T>((resolve, reject) => {
					if (signal?.aborted) {
						reject(aborted());
						return;
					}
					const onAbort = () => {
						const at = waiters.indexOf(waiter);
						if (at === -1) return;
						waiters.splice(at, 1);
						reject(aborted());
						// A transition leaving may free the calls it held.
						if (transition) examine();
					};
					const waiter: Waiter = {
						seq,
						target,
						transition,
						release() {
							signal?.removeEventListener('abort', onAbort);
							post().then(resolve, reject);
						},
						refuse(error) {
							signal?.removeEventListener('abort', onAbort);
							reject(error);
						}
					};
					hold(waiter);
					signal?.addEventListener('abort', onAbort, { once: true });
					if (again) examine();
				});
			// A waiting transition is one the phase still holds, and it holds every later call.
			const blocked = waiters.some((waiter) => waiter.transition);
			if (!blocked && (transition ? admits() : answers(target))) return post();
			return wait();
		},

		on(_event, listener) {
			const entry = (event: ChangedEvent) => listener(event);
			changedListeners.add(entry);
			return () => {
				changedListeners.delete(entry);
			};
		},

		setViewPlacement(viewId, elementIds) {
			const ids = [...elementIds];
			placements.set(viewId, ids);
			if (link !== null) sendPlacement(link.client, viewId, ids);
		},

		dropViewPlacement(viewId) {
			placements.delete(viewId);
			if (link !== null) sendPlacement(link.client, viewId, null);
		},

		setArtifacts(list) {
			artifacts.clear();
			for (const artifact of list) artifacts.set(artifact.id, artifact);
			if (link !== null) sendArtifacts(link.client, 'setArtifacts', { artifacts: [...list] });
		},

		putArtifacts(changed, deletedIds, staged) {
			for (const artifact of changed) artifacts.set(artifact.id, artifact);
			for (const id of deletedIds) artifacts.delete(id);
			if (staged !== undefined) stagedArtifacts = [...staged];
			if (link === null) return;
			const params = { changed: [...changed], deleted_ids: [...deletedIds] };
			sendArtifacts(
				link.client,
				'putArtifacts',
				staged === undefined ? params : { ...params, staged: stagedArtifacts }
			);
		},

		setStagedArtifacts(entries) {
			stagedArtifacts = [...entries];
			if (link !== null) {
				sendArtifacts(link.client, 'setStagedArtifacts', { entries: stagedArtifacts });
			}
		}
	};
}
