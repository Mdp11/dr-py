import type { ClientConfig } from './client';

/** A model read surface: the reads that move between server and engine together. */
export type Surface = 'elements' | 'search' | 'relationships' | 'tree' | 'summary';
export type Side = 'engine' | 'server';

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

/**
 * Answers a read from the engine or the server. A call that names its server
 * (`baseUrl` or `fetch`) goes there. `engineCall` makes exactly one engine
 * call and parses its body with the server's schema.
 */
export function route<T>(
	surface: Surface,
	cfg: ClientConfig | undefined,
	engineCall: (call: EngineCall) => Promise<T>,
	serverCall: () => Promise<T>
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
			probe({ ok: false, error });
			throw error;
		}
	);
}
