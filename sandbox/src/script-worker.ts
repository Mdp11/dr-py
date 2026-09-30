// The script worker: Pyodide and the guest, spawned by the engine worker. Its
// bridge transport posts a request and BLOCKS on the reply buffer until the
// engine worker has written the whole reply, so this is the one place that
// calls `Atomics.wait`.
import type { loadPyodide as LoadPyodide } from 'pyodide';
import type { PyDict } from 'pyodide/ffi';
import { createGuest, type Guest, type Interpreter } from '../../engine/src/script/guest.ts';
import { armReply, readReply } from '../../engine/src/script/bridge-buffer.ts';
import type { CspViolation } from './handshake.ts';
import type { FromScriptWorker, ToScriptWorker } from './script-host.ts';
import { batchFromWire } from '../../engine/src/script/wire.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(message: FromScriptWorker): void {
	scope.postMessage(message);
}

// Violations in this scope never reach the page; the engine worker relays them.
scope.addEventListener('securitypolicyviolation', (raw) => {
	const event = raw as SecurityPolicyViolationEvent;
	post({
		type: 'csp-violation',
		directive: event.effectiveDirective,
		blocked: event.blockedURI
	} satisfies CspViolation);
});

// A truncated reply must fail loudly, not decode to U+FFFD, and a BOM is data.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

let guest: Guest | null = null;
let trips = 0;
let started = false;

async function init(reply: SharedArrayBuffer): Promise<void> {
	if (!scope.crossOriginIsolated) throw new Error('the script worker is not cross-origin isolated');
	const t0 = performance.now();
	// Loaded at run time from this origin; the bundler leaves the import alone.
	const { loadPyodide } = (await import(
		/* @vite-ignore */ new URL('/pyodide/pyodide.mjs', scope.location.origin).href
	)) as { loadPyodide: typeof LoadPyodide };
	const py = await loadPyodide({ indexURL: '/pyodide/' });
	const globals = py.globals as unknown as PyDict;
	const interpreter: Interpreter = {
		runPython: (code) => py.runPython(code),
		globals: { get: (name) => globals.get(name), set: (name, value) => globals.set(name, value) }
	};
	// Armed before the post: a reply can land the instant the request is out,
	// and arming after would erase it and block for good.
	guest = createGuest(interpreter, (requestText) => {
		trips++;
		armReply(reply);
		post({ type: 'bridge', text: requestText });
		return decoder.decode(readReply(reply, () => post({ type: 'more' })));
	});
	post({ type: 'ready', ms: performance.now() - t0 });
}

scope.addEventListener('message', (event) => {
	const message = event.data as ToScriptWorker;
	try {
		if (message.type === 'init') {
			if (started) return;
			started = true;
			init(message.reply).catch((error: unknown) => post(failure(error)));
		} else if (message.type === 'run') {
			if (guest === null) throw new Error('the script worker is not booted');
			const batch = batchFromWire(message.batch);
			trips = 0;
			const t0 = performance.now();
			const results = guest.run(batch, message.roots);
			post({ type: 'done', run: message.run, results, trips, ms: performance.now() - t0 });
		}
	} catch (error) {
		post(failure(error));
	}
});

function failure(error: unknown): FromScriptWorker {
	return { type: 'failed', message: error instanceof Error ? error.message : String(error) };
}
