// The entry of a script worker thread: `runWorker` over this thread's port and Pyodide.
import { parentPort } from 'node:worker_threads';
import { loadPyodide } from 'pyodide';
import { runWorker } from '../src/script/worker-main.ts';
import { INDEX_URL } from './pyodide.ts';

if (parentPort === null) throw new Error('script-worker runs as a worker thread');
const port = parentPort;

runWorker(
	{
		post: (message) => port.postMessage(message),
		onMessage: (handler) => port.on('message', handler),
		globals: globalThis
	},
	(options) => loadPyodide({ indexURL: INDEX_URL, ...options })
);
