// A script worker thread whose Pyodide refuses the snapshot API in one direction, for the pool's
// fallback to cold boots: `workerData` is `'make'` or `'load'`.
import { workerData } from 'node:worker_threads';
import { serveScriptWorker } from '../../../node/serve-worker.ts';

const refuse = workerData === 'make' ? '_makeSnapshot' : '_loadSnapshot';

serveScriptWorker(
	(load) => (options) =>
		refuse in options ? Promise.reject(new Error(`${refuse} is not supported here`)) : load(options)
);
