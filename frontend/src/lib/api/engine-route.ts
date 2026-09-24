import type { ClientConfig } from './client';
import { ApiError } from './errors';

/**
 * A surface: the reads that move between server and engine together — the
 * five model reads, the navigation evaluation and the criteria search.
 */
export type Surface =
	| 'elements'
	| 'search'
	| 'relationships'
	| 'tree'
	| 'summary'
	| 'navigation'
	| 'criteria';
export type Side = 'engine' | 'server';

/** Why the server answered a call the engine refused: it reaches a script, or a pattern. */
export type Fallback = 'script' | 'pattern';

export type RouteOptions<T> = {
	/** Marks the server's answer to a call the engine sent it. */
	mark?: (value: T, reason: Fallback) => T;
};

/** One read method of the engine, answered with the route's response body. */
export type EngineCall = <T>(method: string, params: unknown, signal?: AbortSignal) => Promise<T>;

export type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** What the shadow is handed after the engine answered a read. */
export type ShadowProbe = {
	surface: Surface;
	method: string;
	params: unknown;
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
	'reaches an unsupported pattern': 'pattern'
};

/** The engine's refusal that sends a call to the server, if `error` is one. */
function fallbackOf(error: unknown): Fallback | null {
	if (!(error instanceof ApiError) || error.status !== 501) return null;
	return Object.hasOwn(FALLBACKS, error.message) ? FALLBACKS[error.message]! : null;
}

/** `body` as the server is sent it: plain JSON, which a `$state` proxy is not, `undefined` left out. */
export function asSent(body: object): unknown {
	return JSON.parse(JSON.stringify(body));
}

/**
 * Answers a read from the engine or the server. A call that names its server
 * (`baseUrl` or `fetch`) goes there. `engineCall` makes exactly one engine
 * call and parses its body with the server's schema. A 501 the engine
 * refuses a script or a pattern with is answered by the server, handed to
 * `options.mark` with its reason, and not shadowed; any other 501 is the
 * caller's.
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
	const probe = (engine: Outcome) => {
		if (seam.shadow === undefined) return;
		try {
			const returned: unknown = seam.shadow({
				surface,
				method,
				params,
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
			probe({ ok: true, value });
			return value;
		},
		(error: unknown) => {
			if (seam.gone(error)) return serverCall();
			const reason = fallbackOf(error);
			if (reason !== null) {
				const { mark } = options;
				return mark === undefined
					? serverCall()
					: serverCall().then((value) => mark(value, reason));
			}
			probe({ ok: false, error });
			throw error;
		}
	);
}
