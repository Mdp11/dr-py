// What a script worker thread does: `runWorker` over this thread's port and Pyodide.
import nodeCrypto from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { loadPyodide } from 'pyodide';
import { runWorker } from '../src/script/worker-main.ts';
import { INDEX_URL } from './pyodide.ts';

type Load = (options: object) => Promise<unknown>;

/** Serves this thread as a script worker; `wrap` lets a test stand between the worker and Pyodide. */
export function serveScriptWorker(wrap: (load: Load) => Load = (load) => load): void {
	if (parentPort === null) throw new Error('a script worker runs as a worker thread');
	const port = parentPort;
	// Bound before any script runs: a script can reach `parentPort` through Pyodide's `js` module and
	// rebind its methods, which must not change how this worker talks.
	const postMessage = port.postMessage.bind(port);
	const on = port.on.bind(port);

	// Pyodide in Node fills `os.urandom` through `node:crypto`, not `crypto.getRandomValues`, and each
	// worker thread has a module object of its own, so this pins this worker alone.
	nodeCrypto.randomFillSync = (buffer) => {
		const view = buffer as ArrayBufferView;
		new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0x42);
		return buffer;
	};

	runWorker(
		{
			post: (message, transfer) => postMessage(message, transfer ?? []),
			onMessage: (handler) => on('message', handler),
			globals: globalThis
		},
		wrap((options) => loadPyodide({ indexURL: INDEX_URL, ...options }))
	);
}
