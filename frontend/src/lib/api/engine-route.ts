import { ApiError } from './errors';

/**
 * A surface: a group of the engine's reads that `dr.surfaces` switches
 * together — the five model reads, the navigation evaluation, the criteria
 * search, the validation issues, the table pages, the exports, the metamodel
 * previews, the model download, the view warnings and the compare with
 * apply-CR.
 */
export type Surface =
	| 'elements'
	| 'search'
	| 'relationships'
	| 'tree'
	| 'summary'
	| 'navigation'
	| 'criteria'
	| 'issues'
	| 'tables'
	| 'exports'
	| 'metamodel'
	| 'download'
	| 'views'
	| 'compare';
export type Side = 'engine' | 'server';

/**
 * One read method of the engine, answered with the route's response body.
 * `transfer` moves those buffers of `params` to the engine: detached once
 * posted.
 */
export type EngineCall = <T>(
	method: string,
	params: unknown,
	signal?: AbortSignal,
	transfer?: ArrayBuffer[]
) => Promise<T>;

/**
 * What `lib/api` knows of the engine, injected so that it imports nothing of
 * it: its calls, and the wait for the replica to hold what a read needs.
 */
export type EngineSeam = {
	call: EngineCall;
	/** Resolves once the gate is open; rejects with `EngineUnavailableError` when the replica cannot open it. */
	whenReady(signal?: AbortSignal): Promise<void>;
};

/** The engine cannot answer: it failed, is not running or has no model. */
export class EngineUnavailableError extends Error {
	constructor(message = 'the engine is not available') {
		super(message);
		this.name = 'EngineUnavailableError';
	}
}

export type RouteOptions = {
	signal?: AbortSignal;
	/** Buffers of `params` moved to the engine: a call that moves some is not retried, as they are detached. */
	transfer?: ArrayBuffer[];
};

let installed: EngineSeam | null = null;

/** Installs the seam every routed read consults, or removes it with `null`. */
export function installEngineSeam(seam: EngineSeam | null): void {
	installed = seam;
}

/** The engine's 409s for a call whose staged batches, `base_rev` or replica moved under it. */
const MOVED = new Set([
	'stale staged batches',
	'stale base_rev',
	'replica is not ready',
	'replica closed'
]);

function movedUnder(error: unknown): boolean {
	return error instanceof ApiError && error.status === 409 && MOVED.has(error.message);
}

/** `body` as the engine is sent it: plain JSON, which a `$state` proxy is not, `undefined` left out. */
export function asSent(body: object): unknown {
	return JSON.parse(JSON.stringify(body));
}

/**
 * Answers a read from the engine. It waits for the gate first, so a replica
 * still opening or not yet swept answers when it can. A 409 that says the
 * staged batches, the `base_rev` or the replica moved under the call waits for
 * the gate again and asks once more; a second refusal, and every other
 * engine error, is the caller's as the engine gave it. No seam installed, or
 * a replica that cannot open the gate, is an `EngineUnavailableError`.
 */
export async function route<T>(
	method: string,
	params: unknown,
	options: RouteOptions = {}
): Promise<T> {
	const seam = installed;
	if (seam === null) throw new EngineUnavailableError('the engine is not running');
	const { signal, transfer } = options;
	await seam.whenReady(signal);
	try {
		return await seam.call<T>(method, params, signal, transfer);
	} catch (error) {
		if (!movedUnder(error) || (transfer !== undefined && transfer.length > 0)) throw error;
	}
	await seam.whenReady(signal);
	return seam.call<T>(method, params, signal);
}
