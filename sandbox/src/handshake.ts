/** Frame → app, once the worker exists. */
export type SandboxReady = { type: 'sandbox-ready'; crossOriginIsolated: boolean };
/** App → frame, carrying the one port the engine is served on. */
export type Connect = { type: 'connect' };
/** Frame → app, for every `securitypolicyviolation`. */
export type CspViolation = { type: 'csp-violation'; directive: string; blocked: string };
/** Frame → app, when the worker's `error` event fires. */
export type WorkerFailed = { type: 'worker-error'; message: string };

export type FrameMessage = SandboxReady | CspViolation | WorkerFailed;

/**
 * The port of a `connect` from the app, or `null` for anything else: another
 * origin, another source, another message, or not exactly one port.
 */
export function connectPort(
	event: { origin: string; source: unknown; data: unknown; ports: readonly MessagePort[] },
	expected: { origin: string; parent: unknown }
): MessagePort | null {
	if (event.origin !== expected.origin || event.source !== expected.parent) return null;
	const data = event.data;
	if (typeof data !== 'object' || data === null) return null;
	if ((data as { type?: unknown }).type !== 'connect') return null;
	if (event.ports.length !== 1) return null;
	return event.ports[0] ?? null;
}
