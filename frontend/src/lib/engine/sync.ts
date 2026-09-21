import type {
	DeltaResult,
	EndResult,
	ProgressTask,
	ServiceEvent,
	TailResult,
	WireBatch
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
};

export const OFF: ReplicaStatus = {
	phase: 'off',
	rev: null,
	progress: null,
	attempt: 0,
	source: null,
	isolated: null,
	cspViolations: 0,
	reason: null
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
	feedSnapshot(modelRev: number): void;
	beginCommit(): CommitFlight;
	metamodelAdopted(): void;
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
	| { kind: 'delta'; raw: string; rev: number; own?: Own }
	| { kind: 'snapshot'; modelRev: number }
	| { kind: 'catch-up' };

/** One `open()`, until `stop()`: every continuation checks it is still the current one. */
type Run = {
	readonly projectId: string;
	readonly controller: AbortController;
	everReady: boolean;
	pumping: boolean;
};

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
 * head, ready. Feed inputs wait while the replica opens and are applied in
 * arrival order once it is ready.
 */
export function createReplicaSync(deps: SyncDeps): ReplicaSync {
	let status: ReplicaStatus = OFF;
	let run: Run | null = null;
	let link: EngineLink | null = null;
	let detach: (() => void)[] = [];
	const queue: Input[] = [];
	let busy = 0;
	const idle: (() => void)[] = [];

	const set = (patch: Partial<ReplicaStatus>) => {
		status = { ...status, ...patch };
		deps.onStatus(status);
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

	/** `work`, unless the run is stopped first: then a `Stopped`, at once. */
	const guard = <T>(r: Run, work: Promise<T>): Promise<T> => {
		const signal = r.controller.signal;
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

	// -- the link --------------------------------------------------------------

	const dropLink = () => {
		for (const off of detach.splice(0)) off();
		const gone = link;
		link = null;
		gone?.dispose();
	};

	const adopt = (r: Run, made: EngineLink) => {
		link = made;
		set({ isolated: made.isolated });
		detach = [
			made.client.on((event) => onEngineEvent(r, event)),
			made.onViolation(() => {
				if (link === made) set({ cspViolations: status.cspViolations + 1 });
			})
		];
	};

	/** The link, built on first need; one that arrives after its run was stopped is disposed. */
	const client = async (r: Run): Promise<EngineClient> => {
		if (link !== null) return link.client;
		const adopted = deps.connect().then((made) => {
			if (run !== r) {
				made.dispose();
				throw new Stopped();
			}
			adopt(r, made);
			return made;
		});
		try {
			return (await guard(r, adopted)).client;
		} catch (error) {
			throw error instanceof Stopped ? error : new LinkFailed(error);
		}
	};

	const onEngineEvent = (r: Run, event: ServiceEvent) => {
		if (run !== r) return;
		const phase = status.phase;
		if (event.event === 'progress') {
			const opening = phase === 'opening' || phase === 'resyncing';
			if (opening || (event.task === 'verify' && phase === 'ready')) {
				set({ progress: { task: event.task, done: event.done, total: event.total } });
			}
		} else if (event.event === 'replica' && event.state === 'diverged') {
			lost(r, `the replica diverged from the server at rev ${event.rev ?? status.rev}`);
		}
	};

	// -- opening ---------------------------------------------------------------

	/** Sends the bytes; `sent` settles once every chunk is taken, rejecting with the first refusal. */
	const sendCached = (engine: EngineClient, bytes: ArrayBuffer): Promise<void> => {
		set({ source: 'cache' });
		return engine.call<null>('chunk', { bytes }, { transfer: [bytes] }).then(() => undefined);
	};

	const download = async (
		r: Run,
		engine: EngineClient,
		url: string
	): Promise<{ sent: Promise<void>; copies: ArrayBuffer[] }> => {
		set({ source: 'network' });
		const response = await guard(r, deps.api.snapshot(url, r.controller.signal));
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
				const next = await guard(r, reader.read());
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
		r: Run,
		cacheAllowed: boolean,
		batches: WireBatch[] | null
	): Promise<'ready' | 'no model'> => {
		const projectId = r.projectId;
		const descriptor = await guard(r, deps.api.descriptor(projectId));
		if (descriptor === null) return 'no model';
		const engine = await client(r);
		const { doc, metamodelId } = await guard(r, deps.api.metamodel(projectId));
		if (metamodelId !== descriptor.metamodel_id) {
			throw new MetamodelMismatch(metamodelId, descriptor.metamodel_id);
		}
		await guard(r, engine.call('open', { project_id: projectId, metamodel: doc }));

		const cached = cacheAllowed ? await guard(r, deps.cache.get(projectId, descriptor.rev)) : null;
		let copies: ArrayBuffer[] | null = null;
		let sent: Promise<void>;
		if (cached !== null) {
			sent = sendCached(engine, cached);
		} else {
			({ sent, copies } = await download(r, engine, descriptor.url));
		}
		sent.catch(() => {});
		let header: EndResult;
		try {
			header = await guard(r, engine.call<EndResult>('end'));
			await guard(r, sent);
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

		if (batches !== null) await guard(r, engine.call('adoptStaged', { batches }));
		const tail = await guard(r, deps.api.tail(projectId, header.rev));
		// The descriptor promised a complete tail: something moved, most likely a rebind.
		if (!tail.complete) throw new Error(`the tail from rev ${header.rev} is not complete`);
		const result = await guard(r, engine.call<TailResult>('applyTail', { text: tail.text }));
		if (result.diverged) throw new Error(`the replica diverged at rev ${result.rev}`);
		if (result.status === 'gap') {
			throw new Error(`the tail from rev ${header.rev} does not continue the snapshot`);
		}
		r.everReady = true;
		set({ phase: 'ready', rev: result.rev, attempt: 0, progress: null, reason: null });
		pump(r);
		return 'ready';
	};

	/** `close` on the engine, its answer ignored; false once the run is stopped. */
	const closeReplica = async (r: Run): Promise<boolean> => {
		if (link === null) return run === r;
		try {
			await guard(r, link.client.call('close'));
		} catch (error) {
			if (error instanceof Stopped) return false;
		}
		return run === r;
	};

	/** Up to three attempts, 1 s and 3 s apart; the last failure decides the phase. */
	const openReplica = async (
		r: Run,
		phase: 'opening' | 'resyncing',
		batches: WireBatch[] | null
	): Promise<void> => {
		let failures = 0;
		let freeRestarts = 0;
		let cacheAllowed = true;
		for (;;) {
			set({ phase, attempt: failures + 1, progress: null, source: null, reason: null });
			let outcome: 'ready' | 'no model';
			try {
				outcome = await attempt(r, cacheAllowed, batches);
			} catch (error) {
				if (error instanceof Stopped || run !== r) return;
				if (error instanceof LinkFailed) {
					queue.length = 0;
					set({ phase: 'server', attempt: 0, progress: null, reason: error.message });
					return;
				}
				if (error instanceof CachedBytesRefused) {
					cacheAllowed = false;
					await guard(r, deps.cache.drop(r.projectId)).catch(() => {});
					if (!(await closeReplica(r))) return;
					continue;
				}
				if (error instanceof MetamodelMismatch && freeRestarts < FREE_RESTARTS) {
					freeRestarts += 1;
					continue;
				}
				failures += 1;
				// A link whose engine went away is rebuilt by the next attempt.
				if (error instanceof EngineGoneError) dropLink();
				if (!(await closeReplica(r))) return;
				if (failures >= ATTEMPTS) {
					giveUp(r, reasonOf(error));
					return;
				}
				try {
					await guard(r, deps.sleep(RETRY_DELAYS_MS[failures - 1]!));
				} catch {
					return;
				}
				continue;
			}
			if (outcome === 'no model') {
				queue.length = 0;
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

	/** Before the first ready of an open, the server serves instead; after it, the replica has failed. */
	const giveUp = (r: Run, reason: string) => {
		queue.length = 0;
		if (r.everReady) {
			set({ phase: 'failed', attempt: 0, progress: null, reason });
		} else {
			dropLink();
			set({ phase: 'server', attempt: 0, progress: null, reason });
		}
	};

	// -- following -------------------------------------------------------------

	/** The replica can no longer follow by delta; it stops following. */
	const lost = (r: Run, reason: string) => {
		if (run !== r || status.phase !== 'ready') return;
		queue.length = 0;
		set({ phase: 'failed', progress: null, reason });
	};

	const enqueue = (input: Input) => {
		const phase = status.phase;
		if (phase !== 'opening' && phase !== 'resyncing' && phase !== 'ready') return;
		if (queue.length >= WAITING_MAX) {
			// The tail brings the replica to head, past whatever was waiting.
			queue.length = 0;
			queue.push({ kind: 'catch-up' });
		} else {
			queue.push(input);
		}
		if (phase === 'ready' && run !== null) pump(run);
	};

	/** Handles the waiting inputs one at a time, each to its end, while the replica is ready. */
	const pump = (r: Run) => {
		if (r.pumping || run !== r) return;
		r.pumping = true;
		track(drain(r));
	};

	const drain = async (r: Run): Promise<void> => {
		try {
			while (run === r && status.phase === 'ready' && queue.length > 0) {
				const input = queue.shift()!;
				try {
					await handle(r, input);
				} catch (error) {
					if (error instanceof Stopped) return;
					lost(r, reasonOf(error));
				}
			}
		} finally {
			r.pumping = false;
		}
	};

	const handle = async (r: Run, input: Input): Promise<void> => {
		const rev = status.rev ?? 0;
		switch (input.kind) {
			case 'delta': {
				// Already covered — unless it is the user's own, which still has bookkeeping to do.
				if (input.own === undefined && input.rev <= rev) return;
				const params =
					input.own === undefined ? { text: input.raw } : { text: input.raw, own: input.own };
				const result = await guard(r, engine(r).call<DeltaResult>('applyDelta', params));
				set({ rev: result.rev });
				if (result.diverged) lost(r, `the replica diverged from the server at rev ${result.rev}`);
				else if (result.status === 'gap') lost(r, `rev ${input.rev} does not follow rev ${rev}`);
				return;
			}
			case 'snapshot':
				if (input.modelRev > rev) await catchUp(r);
				return;
			case 'catch-up':
				await catchUp(r);
				return;
		}
	};

	const engine = (r: Run): EngineClient => {
		if (run !== r || link === null) throw new Stopped();
		return link.client;
	};

	/** The tail from the replica's rev to head, in one go. */
	const catchUp = async (r: Run): Promise<void> => {
		const from = status.rev ?? 0;
		const tail = await guard(r, deps.api.tail(r.projectId, from));
		if (!tail.complete) {
			lost(r, `the tail from rev ${from} is not complete`);
			return;
		}
		const result = await guard(r, engine(r).call<TailResult>('applyTail', { text: tail.text }));
		set({ rev: result.rev });
		if (result.diverged) lost(r, `the replica diverged from the server at rev ${result.rev}`);
		else if (result.status === 'gap') lost(r, `the tail from rev ${from} does not follow it`);
	};

	// -- the surface -----------------------------------------------------------

	const stop = () => {
		const r = run;
		run = null;
		r?.controller.abort();
		queue.length = 0;
		dropLink();
		if (status !== OFF) {
			status = OFF;
			deps.onStatus(status);
		}
	};

	return {
		open(projectId) {
			if (run !== null && run.projectId === projectId) return;
			stop();
			const r: Run = {
				projectId,
				controller: new AbortController(),
				everReady: false,
				pumping: false
			};
			run = r;
			set({ ...OFF, phase: 'opening', attempt: 1 });
			track(openReplica(r, 'opening', null));
		},

		stop,

		status: () => status,

		settled() {
			if (busy === 0) return Promise.resolve();
			return new Promise<void>((resolve) => idle.push(resolve));
		},

		feedCommit(raw, rev) {
			enqueue({ kind: 'delta', raw, rev });
		},

		feedSnapshot(modelRev) {
			enqueue({ kind: 'snapshot', modelRev });
		},

		// The freeze and the commit in flight complete these; until then an own
		// commit reaches the replica as its feed echo.
		feedRebind() {},

		beginCommit() {
			return { settle() {}, abandon() {} };
		},

		metamodelAdopted() {}
	};
}
