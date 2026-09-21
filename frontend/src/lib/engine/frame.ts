import type { FrameMessage } from '$sandbox/handshake';
import { createEngineClient, type ClientPort, type EngineLink } from './client';
import { SANDBOX_ORIGIN, sameHost } from './origins';

export type FrameElement = {
	contentWindow: {
		postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]): void;
	} | null;
	remove(): void;
};

export type FrameDeps = {
	window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
	location: { origin: string };
	createFrame(src: string): FrameElement;
	createChannel(): { port1: ClientPort; port2: MessagePort };
	sandboxOrigin: string;
	timeoutMs: number;
};

export class FrameError extends Error {
	readonly kind: 'same-host' | 'timeout' | 'worker';

	constructor(kind: FrameError['kind'], message: string) {
		super(message);
		this.name = 'FrameError';
		this.kind = kind;
	}
}

type Violation = { directive: string; blocked: string };

const HANDSHAKE_TIMEOUT_MS = 10_000;

function appendFrame(src: string): FrameElement {
	const frame = document.createElement('iframe');
	frame.src = src;
	frame.setAttribute('allow', 'cross-origin-isolated');
	frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
	frame.setAttribute('aria-hidden', 'true');
	frame.tabIndex = -1;
	frame.title = 'Data Rover engine';
	frame.style.cssText = 'position:absolute;width:0;height:0;border:0';
	document.body.append(frame);
	return frame;
}

const text = (value: unknown, fallback: string): string =>
	typeof value === 'string' ? value : fallback;

/** A frame message, or `null` for anything the sandbox does not send. */
function frameMessage(data: unknown): FrameMessage | null {
	if (typeof data !== 'object' || data === null) return null;
	const message = data as Record<string, unknown>;
	switch (message.type) {
		case 'sandbox-ready':
			return { type: 'sandbox-ready', crossOriginIsolated: message.crossOriginIsolated === true };
		case 'csp-violation':
			return {
				type: 'csp-violation',
				directive: text(message.directive, ''),
				blocked: text(message.blocked, '')
			};
		case 'worker-error':
			return { type: 'worker-error', message: text(message.message, 'the engine worker failed') };
		default:
			return null;
	}
}

/**
 * Embeds the sandbox and hands its worker a port once the page says it is
 * ready. A message counts only from the sandbox's origin and the frame's own
 * window. The app must be on another host than the sandbox, or the two would
 * be one site.
 */
export function connectFrame(overrides: Partial<FrameDeps> = {}): Promise<EngineLink> {
	const deps: FrameDeps = {
		window: overrides.window ?? window,
		location: overrides.location ?? location,
		createFrame: overrides.createFrame ?? appendFrame,
		createChannel: overrides.createChannel ?? (() => new MessageChannel()),
		sandboxOrigin: overrides.sandboxOrigin ?? SANDBOX_ORIGIN,
		timeoutMs: overrides.timeoutMs ?? HANDSHAKE_TIMEOUT_MS
	};
	if (sameHost(deps.location.origin, deps.sandboxOrigin)) {
		return Promise.reject(new FrameError('same-host', 'open the app at http://127.0.0.1:5173'));
	}

	return new Promise<EngineLink>((resolve, reject) => {
		const frame = deps.createFrame(`${deps.sandboxOrigin}/`);
		const violations: Violation[] = [];
		const listeners = new Set<{ listener: (violation: Violation) => void }>();
		let link: EngineLink | null = null;
		let ended = false;

		const end = () => {
			if (ended) return;
			ended = true;
			clearTimeout(timer);
			deps.window.removeEventListener('message', onMessage);
			listeners.clear();
			link?.client.dispose();
			frame.remove();
		};

		const fail = (error: FrameError) => {
			end();
			reject(error);
		};

		const connect = (
			crossOriginIsolated: boolean,
			target: NonNullable<FrameElement['contentWindow']>
		) => {
			const channel = deps.createChannel();
			target.postMessage({ type: 'connect' }, deps.sandboxOrigin, [channel.port2]);
			link = {
				client: createEngineClient(channel.port1),
				isolated: crossOriginIsolated,
				onViolation(listener) {
					if (ended) return () => {};
					const entry = { listener };
					listeners.add(entry);
					for (const violation of violations) listener({ ...violation });
					return () => {
						listeners.delete(entry);
					};
				},
				dispose: end
			};
			clearTimeout(timer);
			resolve(link);
		};

		function onMessage(event: Event) {
			const { origin, source, data } = event as MessageEvent;
			const target = frame.contentWindow;
			if (ended || origin !== deps.sandboxOrigin || target === null || source !== target) return;
			const message = frameMessage(data);
			if (message === null) return;
			switch (message.type) {
				case 'sandbox-ready':
					if (link === null) connect(message.crossOriginIsolated, target);
					return;
				case 'csp-violation': {
					const violation = { directive: message.directive, blocked: message.blocked };
					// Kept only until the link exists, for its first listeners.
					if (link === null) violations.push(violation);
					for (const entry of [...listeners]) entry.listener({ ...violation });
					return;
				}
				case 'worker-error':
					if (link === null) fail(new FrameError('worker', message.message));
					else end();
					return;
			}
		}

		const timer = setTimeout(
			() =>
				fail(new FrameError('timeout', `the sandbox did not answer within ${deps.timeoutMs} ms`)),
			deps.timeoutMs
		);
		deps.window.addEventListener('message', onMessage);
	});
}
