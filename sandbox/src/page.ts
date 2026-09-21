// Starts the engine worker, tells the app about it, and hands the app's port
// to it; from then on the page is outside the data path.
import { connectPort, type FrameMessage } from './handshake.ts';
import { APP_ORIGIN } from './origins.ts';

const worker = new Worker(new URL('./engine-worker.ts', import.meta.url), { type: 'module' });

function report(message: FrameMessage): void {
	window.parent.postMessage(message, APP_ORIGIN);
}

worker.addEventListener('error', (event) => {
	report({ type: 'worker-error', message: event.message || 'the engine worker failed' });
});

window.addEventListener('securitypolicyviolation', (event) => {
	report({ type: 'csp-violation', directive: event.effectiveDirective, blocked: event.blockedURI });
});

let connected = false;
window.addEventListener('message', (event) => {
	if (connected) return;
	const port = connectPort(event, { origin: APP_ORIGIN, parent: window.parent });
	if (port === null) return;
	connected = true;
	worker.postMessage({ type: 'port' }, [port]);
});

report({ type: 'sandbox-ready', crossOriginIsolated: window.crossOriginIsolated });
