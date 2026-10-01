// The engine worker's script host: the engine's pool over Web Workers. Each batch runs in a fresh
// `script-worker.ts`, which the pool ends afterwards; the engine worker never blocks, only a script
// worker waits on its reply buffer.
import type { ScriptHost, ScriptHostFactory } from '../../engine/src/script/host.ts';
import {
	createPool,
	poolCap,
	type WorkerPort,
	type WorkerSpawner
} from '../../engine/src/script/pool.ts';
import type { CspViolation } from './handshake.ts';

/** The longest a relayed violation's directive or blocked URI is: a script can forge what it posts. */
const MAX_VIOLATION_FIELD = 256;

/** A script worker over a Web Worker: its `error` is handled here, so it never reaches the page as `worker-error`. */
export const spawnScriptWorker: WorkerSpawner = (): WorkerPort => {
	const worker = new Worker(new URL('./script-worker.ts', import.meta.url), { type: 'module' });
	return {
		post: (message, transfer) => worker.postMessage(message, transfer ?? []),
		onMessage(handler) {
			worker.onmessage = (event) => handler(event.data);
		},
		onError(handler) {
			worker.onerror = (event) => {
				// Left alone, the error would surface in the page as the engine worker's own.
				event.preventDefault();
				handler(event.message || 'the script worker failed');
			};
			// A message that would not deserialize: the batch would wait for ever.
			worker.onmessageerror = () =>
				handler('the script worker sent a message that would not deserialize');
		},
		terminate: () => worker.terminate()
	};
};

/**
 * What the pool calls with a violation a script worker reported. The report is a plain message any
 * script can post, so it is cut to a fixed length, and the relay never throws into the engine worker.
 */
export function violationRelay(
	post: (violation: CspViolation) => void
): (violation: { directive: string; blocked: string }) => void {
	return ({ directive, blocked }) => {
		try {
			post({
				type: 'csp-violation',
				directive: directive.slice(0, MAX_VIOLATION_FIELD),
				blocked: blocked.slice(0, MAX_VIOLATION_FIELD)
			});
		} catch {
			// A violation that cannot be reported changes nothing.
		}
	};
}

export type BrowserHostDeps = {
	spawn: WorkerSpawner;
	/** Posts a violation to the page. */
	post(violation: CspViolation): void;
	/** `navigator.hardwareConcurrency`; a browser that does not say counts as one core. */
	parallelism: number | undefined;
	warn(message: string): void;
};

/** The pool over `deps.spawn`, sized by the cores the browser reports. */
export function createBrowserHost(deps: BrowserHostDeps): ScriptHost {
	const { parallelism } = deps;
	return createPool(deps.spawn, {
		cap: poolCap(parallelism !== undefined && parallelism > 0 ? parallelism : 1),
		now: () => performance.now(),
		onViolation: violationRelay(deps.post),
		onWarning: deps.warn
	});
}

/** The script host the engine worker runs, relaying the script workers' CSP violations to the page. */
export const browserScriptHost: ScriptHostFactory = () =>
	createBrowserHost({
		spawn: spawnScriptWorker,
		post: (violation) =>
			(self as unknown as { postMessage(message: unknown): void }).postMessage(violation),
		parallelism: navigator.hardwareConcurrency,
		warn: (message) => console.warn(message)
	});
