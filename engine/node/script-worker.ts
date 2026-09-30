// The entry of a script worker thread: `runWorker` over this thread's port and Pyodide.
import { parentPort } from 'node:worker_threads';
import { loadPyodide } from 'pyodide';
import { runWorker } from '../src/script/worker-main.ts';
import { INDEX_URL } from './pyodide.ts';

if (parentPort === null) throw new Error('script-worker runs as a worker thread');
const port = parentPort;
// Bound before any script runs: a script can reach `parentPort` through Pyodide's `js` module and
// rebind its methods, which must not change how this worker talks.
const postMessage = port.postMessage.bind(port);
const on = port.on.bind(port);

runWorker(
	{
		post: (message) => postMessage(message),
		onMessage: (handler) => on('message', handler),
		globals: globalThis
	},
	(options) => loadPyodide({ indexURL: INDEX_URL, ...options })
);
