// Serves the engine over the first port the page hands over; any later one is ignored.
import { createService } from '../../engine/src/index.ts';
import { createHost, portOf } from './host.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let served = false;
scope.addEventListener('message', (event) => {
	if (served) return;
	const data: unknown = event.data;
	const port = event.ports[0];
	if (typeof data !== 'object' || data === null || port === undefined) return;
	if ((data as { type?: unknown }).type !== 'port') return;
	served = true;
	createService(portOf(port), createHost().deps);
});
