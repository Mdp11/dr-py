// The script worker: Pyodide and the guest, for one batch (`engine/src/script/worker-main.ts`).
// This file only gives that body this scope and a Pyodide loaded from this origin.
import type { loadPyodide as LoadPyodide } from 'pyodide';
import { runWorker } from '../../engine/src/script/worker-main.ts';
import type { CspViolation } from './handshake.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;

// Bound before any script can run: a script reaches this scope through Pyodide's `js` module and
// can rebind `postMessage` or `addEventListener`, which must not change how this worker talks.
const postMessage = scope.postMessage.bind(scope);
const addEventListener = scope.addEventListener.bind(scope);
const later = scope.setTimeout.bind(scope);

// Violations in this scope never reach the page; the engine worker relays them.
addEventListener('securitypolicyviolation', (raw) => {
	const event = raw as SecurityPolicyViolationEvent;
	postMessage({
		type: 'csp-violation',
		directive: event.effectiveDirective,
		blocked: event.blockedURI
	} satisfies CspViolation);
});

/** Pyodide from this origin, never a CDN: the `import()` is left to run time, and the CSP allows it as `script-src 'self'`. */
async function load(options: object): Promise<unknown> {
	if (!scope.crossOriginIsolated) throw new Error('the script worker is not cross-origin isolated');
	const { loadPyodide } = (await import(
		/* @vite-ignore */ new URL('/pyodide/pyodide.mjs', scope.location.origin).href
	)) as { loadPyodide: typeof LoadPyodide };
	return loadPyodide({ indexURL: '/pyodide/', ...options });
}

/**
 * The pool ends this worker at `done`, and a script's CSP violations are reported on tasks that
 * follow the one it ran in: `done` goes out after them, or they would be lost with the worker.
 */
function post(message: unknown, transfer?: ArrayBuffer[]): void {
	if ((message as { type?: unknown }).type === 'done') later(() => postMessage(message), 0);
	else postMessage(message, transfer ?? []);
}

runWorker(
	{
		post,
		onMessage: (handler) => addEventListener('message', (event) => handler(event.data)),
		globals: globalThis
	},
	load
);
