// Tests only: the real engine, on this thread, behind a real port.
import { createService } from '$engine';
import { createHost, portOf } from '$sandbox/host';
import { createEngineClient, type EngineLink } from './client';

/**
 * The engine's service with the worker's own host code over a Node
 * `MessageChannel`, and a client on the other end. `dispose()` closes every
 * port it opened, without which the test process never exits.
 */
export function connectInProcess(): EngineLink {
	const channel = new MessageChannel();
	const host = createHost();
	createService(portOf(channel.port2), host.deps);
	const client = createEngineClient(channel.port1);
	return {
		client,
		isolated: null,
		onViolation: () => () => {},
		dispose() {
			client.dispose();
			channel.port1.close();
			channel.port2.close();
			host.close();
		}
	};
}
