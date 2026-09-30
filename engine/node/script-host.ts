import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { loadPyodide } from 'pyodide';
import type { PyDict } from 'pyodide/ffi';
import { createGuest, type Guest, type Interpreter } from '../src/script/guest.ts';
import type {
	Bridge,
	ScriptBatch,
	ScriptHost,
	ScriptHostFactory,
	ScriptRun
} from '../src/script/host.ts';

// An explicit index keeps the assets found when a bundler or test runner inlines the package.
const INDEX_URL = dirname(createRequire(import.meta.url).resolve('pyodide/package.json'));

/** A fresh Pyodide interpreter, booted in this process. */
export async function loadInterpreter(): Promise<Interpreter> {
	const py = await loadPyodide({ indexURL: INDEX_URL });
	const globals = py.globals as unknown as PyDict;
	return {
		runPython: (code) => py.runPython(code),
		globals: { get: (name) => globals.get(name), set: (name, value) => globals.set(name, value) }
	};
}

/** Pyodide in this process, with the bridge called directly. */
export const nodeScriptHost: ScriptHostFactory = (bridge: Bridge): ScriptHost => {
	let booting: Promise<{ ms: number }> | null = null;
	let guest: Guest | null = null;
	let disposed = false;
	let trips = 0;

	const transport = (requestText: string): string => {
		trips++;
		return bridge.dispatch(requestText);
	};

	async function start(): Promise<{ ms: number }> {
		const t0 = performance.now();
		const py = await loadInterpreter();
		if (!disposed) guest = createGuest(py, transport);
		return { ms: performance.now() - t0 };
	}

	function boot(): Promise<{ ms: number }> {
		if (disposed) return Promise.reject(new Error('script host is disposed'));
		booting ??= start();
		return booting;
	}

	return {
		boot,
		async run(batch: ScriptBatch): Promise<ScriptRun> {
			await boot();
			if (guest === null) throw new Error('script host is disposed');
			const roots = batch.calls.map((call) =>
				batch.entry === 'transform' ? '[]' : bridge.roots(call.elementIds)
			);
			trips = 0;
			const t0 = performance.now();
			const results = guest.run(batch, roots);
			return { results, trips, ms: performance.now() - t0 };
		},
		dispose() {
			disposed = true;
			guest = null;
		}
	};
};
