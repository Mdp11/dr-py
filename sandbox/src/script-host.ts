// The engine worker's side of the script worker: it spawns the worker, answers
// its bridge requests through the reply buffer and turns a run into a promise.
// It never blocks; only the script worker waits on the buffer.
import type {
	Bridge,
	RawScriptResult,
	ScriptBatch,
	ScriptHost,
	ScriptHostFactory,
	ScriptRun
} from '../../engine/src/script/host.ts';
import { createReplyBuffer, ReplyWriter } from './bridge-buffer.ts';
import type { CspViolation } from './handshake.ts';
import { batchToWire, type WireBatch } from './script-wire.ts';

/** Engine worker → script worker. `batch` is a `ScriptBatch` as `script-wire.ts` sends it. */
export type ToScriptWorker =
	| { type: 'init'; reply: SharedArrayBuffer }
	| { type: 'run'; run: number; batch: WireBatch; roots: string[] };

/**
 * Script worker → engine worker. `failed` ends the worker, at boot or mid-run;
 * `bridge` is a request the worker blocks on, and `more` asks for the next
 * chunk of a reply longer than the buffer.
 */
export type FromScriptWorker =
	| { type: 'ready'; ms: number }
	| { type: 'failed'; message: string }
	| { type: 'bridge'; text: string }
	| { type: 'more' }
	| { type: 'done'; run: number; results: RawScriptResult[]; trips: number; ms: number }
	| CspViolation;

/** What the host holds of a worker. */
export type WorkerPort = { postMessage(message: ToScriptWorker): void; terminate(): void };

/** Starts a worker that reports to `on`: every message it posts, and its `error` event. */
export type Spawn = (on: {
	message(data: unknown): void;
	error(message: string): void;
}) => WorkerPort;

type Settle<T> = { resolve(value: T): void; reject(error: Error): void };

/** One worker's lifetime: its buffer, and what is waiting on it. */
type Live = {
	port: WorkerPort;
	writer: ReplyWriter;
	booting: Settle<{ ms: number }> | null;
	running: ({ id: number } & Settle<ScriptRun>) | null;
};

const encoder = new TextEncoder();

const noop = () => {};

/**
 * A script host over `spawn`. One worker at a time, made by `boot()`; it ends
 * on `dispose()`, a `failed` message or an `error` event, and every promise
 * waiting on it then rejects, so nothing outlives it. The next `boot()` or
 * `run()` starts a new worker. Runs go one at a time.
 */
export function createScriptHost(
	bridge: Bridge,
	spawn: Spawn,
	onViolation: (violation: CspViolation) => void
): ScriptHost {
	let live: Live | null = null;
	let booting: Promise<{ ms: number }> | null = null;
	let disposed = false;
	let runs = 0;
	let queue: Promise<unknown> = Promise.resolve();

	/** Ends `worker` if it is still the live one: terminated, and everything waiting on it rejected. */
	function end(worker: Live, error: Error): void {
		if (live !== worker) return;
		live = null;
		booting = null;
		worker.port.terminate();
		const { booting: boot, running } = worker;
		worker.booting = null;
		worker.running = null;
		boot?.reject(error);
		running?.reject(error);
	}

	/** The reply is always written: the worker is blocked until it is. */
	function answer(worker: Live, text: string): void {
		let bytes: Uint8Array;
		try {
			bytes = encoder.encode(bridge.dispatch(text));
		} catch (error) {
			end(worker, error instanceof Error ? error : new Error(String(error)));
			return;
		}
		worker.writer.begin(bytes);
	}

	function onMessage(worker: Live, data: unknown): void {
		if (live !== worker || typeof data !== 'object' || data === null) return;
		const message = data as { type?: unknown; [key: string]: unknown };
		switch (message.type) {
			case 'ready': {
				const settle = worker.booting;
				worker.booting = null;
				if (settle !== null && typeof message.ms === 'number') settle.resolve({ ms: message.ms });
				else if (settle !== null) end(worker, new Error('the script worker sent a bad ready'));
				return;
			}
			case 'failed':
				end(
					worker,
					new Error(
						typeof message.message === 'string' ? message.message : 'the script worker failed'
					)
				);
				return;
			case 'bridge':
				if (typeof message.text === 'string') answer(worker, message.text);
				else end(worker, new Error('the script worker sent a bad bridge request'));
				return;
			case 'more':
				worker.writer.more();
				return;
			case 'done': {
				const running = worker.running;
				if (running === null || message.run !== running.id) return;
				if (
					!Array.isArray(message.results) ||
					typeof message.trips !== 'number' ||
					typeof message.ms !== 'number'
				) {
					end(worker, new Error('the script worker sent a bad result'));
					return;
				}
				worker.running = null;
				running.resolve({
					results: message.results as RawScriptResult[],
					trips: message.trips,
					ms: message.ms
				});
				return;
			}
			case 'csp-violation':
				if (typeof message.directive === 'string' && typeof message.blocked === 'string') {
					onViolation({
						type: 'csp-violation',
						directive: message.directive,
						blocked: message.blocked
					});
				}
				return;
		}
	}

	function start(): Promise<{ ms: number }> {
		return new Promise((resolve, reject) => {
			if (typeof SharedArrayBuffer === 'undefined') {
				reject(new Error('scripts need a cross-origin isolated sandbox'));
				return;
			}
			const reply = createReplyBuffer();
			let worker: Live | undefined;
			try {
				const port = spawn({
					message: (data) => worker !== undefined && onMessage(worker, data),
					error: (message) => worker !== undefined && end(worker, new Error(message))
				});
				worker = {
					port,
					writer: new ReplyWriter(reply),
					booting: { resolve, reject },
					running: null
				};
				live = worker;
				port.postMessage({ type: 'init', reply });
			} catch (error) {
				if (worker !== undefined)
					end(worker, error instanceof Error ? error : new Error(String(error)));
				else reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	function boot(): Promise<{ ms: number }> {
		if (disposed) return Promise.reject(new Error('script host is disposed'));
		if (booting === null) {
			const attempt = start();
			booting = attempt;
			// A boot that fails leaves nothing to reuse.
			attempt.catch(() => {
				if (booting === attempt) booting = null;
			});
		}
		return booting;
	}

	async function execute(batch: ScriptBatch): Promise<ScriptRun> {
		await boot();
		const worker = live;
		if (disposed || worker === null || worker.booting !== null) {
			throw new Error('the script worker stopped');
		}
		const roots = batch.calls.map((call) =>
			batch.entry === 'transform' ? '[]' : bridge.roots(call.elementIds)
		);
		const id = ++runs;
		return new Promise<ScriptRun>((resolve, reject) => {
			try {
				worker.port.postMessage({ type: 'run', run: id, batch: batchToWire(batch), roots });
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			worker.running = { id, resolve, reject };
		});
	}

	return {
		boot,
		run(batch) {
			const result = queue.then(() => execute(batch));
			queue = result.then(noop, noop);
			return result;
		},
		dispose() {
			disposed = true;
			if (live !== null) end(live, new Error('script host is disposed'));
		}
	};
}

function spawnWorker(on: Parameters<Spawn>[0]): WorkerPort {
	const worker = new Worker(new URL('./script-worker.ts', import.meta.url), { type: 'module' });
	worker.onmessage = (event) => on.message(event.data);
	worker.onerror = (event) => {
		// Handled here: left alone, the error would surface in the page as the engine worker's.
		event.preventDefault();
		on.error(event.message || 'the script worker failed');
	};
	return worker;
}

/** The script host the engine worker runs, relaying the script worker's CSP violations to the page. */
export const browserScriptHost: ScriptHostFactory = (bridge) =>
	createScriptHost(bridge, spawnWorker, (violation) =>
		(self as unknown as { postMessage(message: unknown): void }).postMessage(violation)
	);
