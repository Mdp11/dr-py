import type { ClientConfig } from './client';
import { ApiError } from './errors';

/**
 * A surface: the reads that move between server and engine together — the
 * five model reads, the navigation evaluation, the criteria search and the
 * validation issues.
 */
export type Surface =
	| 'elements'
	| 'search'
	| 'relationships'
	| 'tree'
	| 'summary'
	| 'navigation'
	| 'criteria'
	| 'issues';
export type Side = 'engine' | 'server';

/** Why the server answered a call the engine refused: it reaches a script, a pattern, or validation rules. */
export type Fallback = 'script' | 'pattern' | 'rules';

/**
 * When the shadow compares an engine answer: only while nothing is staged
 * (the default), also while edits are staged (the call sent them to the
 * server too), or never.
 */
export type ShadowWhen = 'unstaged' | 'always' | 'never';

export type RouteOptions<T> = {
	/** Marks the server's answer to a call the engine sent it for a script or a pattern. */
	mark?: (value: T, reason: Exclude<Fallback, 'rules'>) => T;
	shadow?: ShadowWhen;
	/**
	 * The surface's side is asked again once the engine answers: a side gone
	 * to the server meanwhile takes the server's answer, since the replica
	 * that answered may not be the one the call was routed to.
	 */
	recheck?: boolean;
};

/** One read method of the engine, answered with the route's response body. */
export type EngineCall = <T>(method: string, params: unknown, signal?: AbortSignal) => Promise<T>;

export type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** What the shadow is handed after the engine answered a read. */
export type ShadowProbe = {
	surface: Surface;
	method: string;
	params: unknown;
	/** Compared while edits are staged: the call sent them to the server as well. */
	whileStaged?: boolean;
	engine: Outcome;
	/** The same engine read once more, parsed. */
	again(): Promise<unknown>;
	/** The same read from the server, parsed. */
	server(): Promise<unknown>;
};

/**
 * What `lib/api` knows of the engine, injected so that it imports nothing of
 * it. `side` is a surface's effective side; `gone` says an error means the
 * engine could not answer at all, so the server answers instead.
 */
export type EngineSeam = {
	side(surface: Surface): Side;
	call: EngineCall;
	gone(error: unknown): boolean;
	/** Handed every engine outcome; never awaited, and nothing it does reaches the caller. */
	shadow?(probe: ShadowProbe): void;
};

let installed: EngineSeam | null = null;

/** Installs the seam every routed read consults, or removes it with `null`. */
export function installEngineSeam(seam: EngineSeam | null): void {
	installed = seam;
}

/** The side a surface's reads take now: `server` without a seam. */
export function engineSide(surface: Surface): Side {
	return installed === null ? 'server' : installed.side(surface);
}

const FALLBACKS: { readonly [detail: string]: Fallback } = {
	'reaches a script': 'script',
	'reaches an unsupported pattern': 'pattern',
	'reaches validation rules': 'rules'
};

/** The engine's refusal that sends a call to the server, if `error` is one. */
function fallbackOf(error: unknown): Fallback | null {
	if (!(error instanceof ApiError) || error.status !== 501) return null;
	return Object.hasOwn(FALLBACKS, error.message) ? FALLBACKS[error.message]! : null;
}

/** The engine's 409s for a call whose staged batches, `base_rev` or replica moved under it. */
const MOVED = new Set(['stale staged batches', 'stale base_rev', 'replica is not ready']);

function movedUnder(error: unknown): boolean {
	return error instanceof ApiError && error.status === 409 && MOVED.has(error.message);
}

/**
 * The shadow rule for a call that sends staged ops to the server: compared
 * while staged, unless an op creates an entity — the server mints ids for it
 * that the engine never sees.
 */
export function comparableWhileStaged(ops: readonly { kind: string }[]): ShadowWhen {
	return ops.some((op) => op.kind === 'create_element' || op.kind === 'create_relationship')
		? 'never'
		: 'always';
}

/** `body` as the server is sent it: plain JSON, which a `$state` proxy is not, `undefined` left out. */
export function asSent(body: object): unknown {
	return JSON.parse(JSON.stringify(body));
}

/**
 * Answers a read from the engine or the server. A call that names its server
 * (`baseUrl` or `fetch`) goes there. `engineCall` makes exactly one engine
 * call and parses its body with the server's schema. A 501 the engine
 * refuses a script, a pattern or validation rules with is answered by the
 * server — for a script or a pattern handed to `options.mark` with its
 * reason — and not shadowed; any other 501 is the caller's. So is a 409 that
 * says the staged batches, the `base_rev` or the replica moved under the
 * call: the server answers it whole.
 */
export function route<T>(
	surface: Surface,
	cfg: ClientConfig | undefined,
	engineCall: (call: EngineCall) => Promise<T>,
	serverCall: () => Promise<T>,
	options: RouteOptions<T> = {}
): Promise<T> {
	const seam = installed;
	if (
		seam === null ||
		cfg?.baseUrl !== undefined ||
		cfg?.fetch !== undefined ||
		seam.side(surface) === 'server'
	) {
		return serverCall();
	}
	let method = '';
	let params: unknown = undefined;
	const recorded: EngineCall = (m, p, signal) => {
		method = m;
		params = p;
		return seam.call(m, p, signal);
	};
	let answer: Promise<T>;
	try {
		answer = engineCall(recorded);
	} catch (error) {
		answer = Promise.reject(error);
	}
	const when = options.shadow ?? 'unstaged';
	const probe = (engine: Outcome) => {
		if (seam.shadow === undefined || when === 'never') return;
		try {
			const returned: unknown = seam.shadow({
				surface,
				method,
				params,
				...(when === 'always' ? { whileStaged: true } : {}),
				engine,
				again: () => engineCall(seam.call),
				server: serverCall
			});
			// A shadow written as an async function returns a promise despite its type.
			Promise.resolve(returned).catch(() => undefined);
		} catch {
			// Nothing the shadow does reaches the caller.
		}
	};
	return answer.then(
		(value) => {
			if (options.recheck === true && seam.side(surface) === 'server') return serverCall();
			probe({ ok: true, value });
			return value;
		},
		(error: unknown) => {
			if (seam.gone(error) || movedUnder(error)) return serverCall();
			const reason = fallbackOf(error);
			if (reason !== null) {
				const { mark } = options;
				return mark === undefined || reason === 'rules'
					? serverCall()
					: serverCall().then((value) => mark(value, reason));
			}
			probe({ ok: false, error });
			throw error;
		}
	);
}
