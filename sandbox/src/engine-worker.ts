// Serves the engine over the first port the page hands over; any later one is ignored.
import { createService } from '../../engine/src/index.ts';
import type { CspViolation } from './handshake.ts';
import { createHost, portOf } from './host.ts';
import { browserScriptHost } from './script-host.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;

// Violations in this scope never reach the page's own listener; the page forwards them.
// The worker lib types the event as a plain `Event`.
scope.addEventListener('securitypolicyviolation', (raw) => {
	const event = raw as SecurityPolicyViolationEvent;
	scope.postMessage({
		type: 'csp-violation',
		directive: event.effectiveDirective,
		blocked: event.blockedURI
	} satisfies CspViolation);
});

let served = false;
scope.addEventListener('message', (event) => {
	if (served) return;
	const data: unknown = event.data;
	const port = event.ports[0];
	if (typeof data !== 'object' || data === null || port === undefined) return;
	if ((data as { type?: unknown }).type !== 'port') return;
	served = true;
	createService(portOf(port), {
		...createHost().deps,
		scripts: browserScriptHost,
		prewarmScripts: true
	});
});
