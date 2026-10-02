import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { loadPyodide } from 'pyodide';
import type { PyDict } from 'pyodide/ffi';
import type { Interpreter } from '../src/script/guest.ts';
import type { ScriptHostFactory } from '../src/script/host.ts';
import { createPool, poolCap, type WorkerPort, type WorkerSpawner } from '../src/script/pool.ts';
import { INDEX_URL } from './pyodide.ts';

export { poolCap };

/** A fresh Pyodide interpreter, booted in this thread. */
export async function loadInterpreter(): Promise<Interpreter> {
	const py = await loadPyodide({ indexURL: INDEX_URL });
	const globals = py.globals as unknown as PyDict;
	return {
		runPython: (code) => py.runPython(code),
		globals: { get: (name) => globals.get(name), set: (name, value) => globals.set(name, value) }
	};
}

/** A spawner of `worker_threads` workers running `entry`, which is a `script-worker.ts` or serves as one. */
export const nodeWorkerSpawner =
	(entry: URL, workerData?: unknown): WorkerSpawner =>
	(): WorkerPort => {
		const worker = new Worker(entry, { workerData });
		return {
			post: (message, transfer) => worker.postMessage(message, transfer ?? []),
			onMessage: (handler) => worker.on('message', handler),
			onError(handler) {
				worker.on('error', (error) => handler(error.message));
				// A message that would not deserialize: the batch would wait for ever.
				worker.on('messageerror', (error) => handler(error.message));
				// Ending the worker ourselves reaches here too, and the pool ignores it.
				worker.on('exit', (code) => handler(`the script worker exited with code ${code}`));
			},
			terminate: () => void worker.terminate()
		};
	};

/** A `worker_threads` worker running `script-worker.ts`. */
export const spawnNodeWorker: WorkerSpawner = nodeWorkerSpawner(
	new URL('./script-worker.ts', import.meta.url)
);

/** The pool over `worker_threads`: one fresh thread, and so one fresh Pyodide, per batch. */
export const nodeScriptHost: ScriptHostFactory = () =>
	createPool(spawnNodeWorker, {
		cap: poolCap(availableParallelism()),
		now: () => performance.now()
	});

/**
 * The pool over `worker_threads` with at most `cap` workers: a test that runs many batches beside
 * its neighbours in a suite caps its own, so that their boots do not take every core.
 */
export const cappedNodeScriptHost =
	(cap: number): ScriptHostFactory =>
	() =>
		createPool(spawnNodeWorker, { cap, now: () => performance.now() });
