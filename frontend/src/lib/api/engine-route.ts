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

/** The params of a call, or a function making them afresh for each attempt. */
export type RouteParams = unknown | (() => unknown | Promise<unknown>);

export type RouteOptions = {
	signal?: AbortSignal;
	/**
	 * Buffers of the params moved to the engine, detached once posted. Fixed
	 * buffers are moved by the first attempt only, so such a call is not asked
	 * again; a function names those of each attempt's params, which a params
	 * function makes afresh, so the call is asked again like any other.
	 */
	transfer?: ArrayBuffer[] | ((params: unknown) => ArrayBuffer[]);
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
	params: RouteParams,
	options: RouteOptions = {}
): Promise<T> {
	const seam = installed;
	if (seam === null) throw new EngineUnavailableError('the engine is not running');
	const { signal, transfer } = options;
	const attempt = async (): Promise<T> => {
		const sent = typeof params === 'function' ? await (params as () => unknown)() : params;
		const moved = typeof transfer === 'function' ? transfer(sent) : transfer;
		return seam.call<T>(method, sent, signal, moved);
	};
	await seam.whenReady(signal);
	try {
		return await attempt();
	} catch (error) {
		if (!movedUnder(error) || (Array.isArray(transfer) && transfer.length > 0)) throw error;
	}
	await seam.whenReady(signal);
	return attempt();
}
