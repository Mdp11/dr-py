import { afterEach, describe, expect, it, vi } from 'vitest';
import { createService } from '$engine';
import { createHost, portOf } from '$sandbox/host';
import type { FrameMessage } from '$sandbox/handshake';
import { EngineGoneError, type ClientPort, type EngineLink } from '../client';
import { connectFrame, FrameError, type FrameDeps, type FrameElement } from '../frame';
import { SANDBOX_ORIGIN, sameHost } from '../origins';

// happy-dom's own `window.postMessage` cannot stand in for the sandbox: it
// delivers no ports, the origin `http://localhost:3000` and a `source` that is
// not the sender. The window is therefore a bare `EventTarget`, and each
// message is dispatched by hand with its `origin` and `source`.

type Harness = {
	deps: Partial<FrameDeps>;
	window: EventTarget;
	frame: FrameElement & { contentWindow: { postMessage: ReturnType<typeof vi.fn> } };
	createFrame: ReturnType<typeof vi.fn>;
	removed: () => number;
	channels: { port1: MessagePort; port2: MessagePort }[];
};

const cleanups: (() => void)[] = [];
const links: EngineLink[] = [];

afterEach(() => {
	for (const made of links.splice(0)) made.dispose();
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
});

function harness(overrides: Partial<FrameDeps> = {}): Harness {
	const window = new EventTarget();
	let removals = 0;
	const frame = {
		contentWindow: { postMessage: vi.fn() },
		remove: () => {
			removals += 1;
		}
	};
	const createFrame = vi.fn<FrameDeps['createFrame']>(() => frame);
	const channels: { port1: MessagePort; port2: MessagePort }[] = [];
	cleanups.push(() => {
		for (const { port1, port2 } of channels) {
			port1.close();
			port2.close();
		}
	});
	return {
		window,
		frame,
		createFrame,
		removed: () => removals,
		channels,
		deps: {
			window: window as FrameDeps['window'],
			location: { origin: 'http://127.0.0.1:5173' },
			createFrame,
			createChannel: () => {
				const channel = new MessageChannel();
				channels.push(channel);
				return channel as { port1: ClientPort; port2: MessagePort };
			},
			sandboxOrigin: SANDBOX_ORIGIN,
			timeoutMs: 5_000,
			...overrides
		}
	};
}

function dispatch(
	h: Harness,
	data: FrameMessage | Record<string, unknown>,
	from: { origin?: string; source?: unknown } = {}
): void {
	const event = new MessageEvent('message', { data, origin: from.origin ?? SANDBOX_ORIGIN });
	Object.defineProperty(event, 'source', {
		value: 'source' in from ? from.source : h.frame.contentWindow
	});
	h.window.dispatchEvent(event);
}

const ready = (crossOriginIsolated = true): FrameMessage => ({
	type: 'sandbox-ready',
	crossOriginIsolated
});

async function connected(h: Harness, isolated = true): Promise<EngineLink> {
	const connecting = connectFrame(h.deps);
	dispatch(h, ready(isolated));
	const link = await connecting;
	links.push(link);
	return link;
}

/** Settles to `'pending'` when `promise` has not settled within a macrotask. */
async function state(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
	const marker = Symbol('pending');
	const settled = await Promise.race([
		promise.then(
			() => 'resolved' as const,
			() => 'rejected' as const
		),
		new Promise<symbol>((resolve) => setTimeout(() => resolve(marker), 0))
	]);
	return settled === marker ? 'pending' : (settled as 'resolved' | 'rejected');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error('expected a rejection');
		},
		(error: unknown) => error
	);
}

/** Serves the engine on the port the shell transferred; closed in teardown. */
function serve(h: Harness): void {
	const [, , transfer] = h.frame.contentWindow.postMessage.mock.calls[0] as [
		unknown,
		string,
		MessagePort[]
	];
	const host = createHost();
	createService(portOf(transfer[0]!), host.deps);
	cleanups.push(() => host.close());
}

describe('origins', () => {
	it('compares hostnames, not ports', () => {
		expect(sameHost('http://localhost:5173', 'http://localhost:5174')).toBe(true);
		expect(sameHost('http://127.0.0.1:5173', 'http://localhost:5174')).toBe(false);
		expect(sameHost('null', 'http://localhost:5174')).toBe(false);
	});
});

describe('connectFrame', () => {
	it('a ready frame is connected', async () => {
		const h = harness();
		const link = await connected(h);
		expect(h.createFrame).toHaveBeenCalledOnce();
		expect(h.createFrame).toHaveBeenCalledWith(`${SANDBOX_ORIGIN}/`);
		const post = h.frame.contentWindow.postMessage;
		expect(post).toHaveBeenCalledOnce();
		const [message, target, transfer] = post.mock.calls[0] as [unknown, string, unknown[]];
		expect(message).toEqual({ type: 'connect' });
		expect(target).toBe(SANDBOX_ORIGIN);
		expect(transfer).toHaveLength(1);
		expect(transfer[0]).toBe(h.channels[0]!.port2);
		expect(link.isolated).toBe(true);

		const other = harness();
		const unisolated = await connected(other, false);
		expect(unisolated.isolated).toBe(false);
	});

	it("the link's client talks over the channel", async () => {
		const h = harness();
		const link = await connected(h);
		serve(h);
		await expect(link.client.call('staged')).resolves.toEqual([]);
	});

	it('other origins, other sources and other messages are ignored', async () => {
		const h = harness();
		const connecting = connectFrame(h.deps);
		dispatch(h, ready(), { origin: 'http://127.0.0.1:5173' });
		expect(await state(connecting)).toBe('pending');
		dispatch(h, ready(), { source: {} });
		expect(await state(connecting)).toBe('pending');
		dispatch(h, ready(), { source: null });
		expect(await state(connecting)).toBe('pending');
		dispatch(h, { type: 'sandbox-readied', crossOriginIsolated: true });
		expect(await state(connecting)).toBe('pending');
		h.window.dispatchEvent(new MessageEvent('message', { data: 'sandbox-ready' }));
		expect(await state(connecting)).toBe('pending');
		expect(h.frame.contentWindow.postMessage).not.toHaveBeenCalled();

		dispatch(h, ready());
		links.push(await connecting);
		expect(h.frame.contentWindow.postMessage).toHaveBeenCalledOnce();
	});

	it('a second ready does not connect twice', async () => {
		const h = harness();
		await connected(h);
		dispatch(h, ready());
		expect(h.frame.contentWindow.postMessage).toHaveBeenCalledOnce();
		expect(h.channels).toHaveLength(1);
	});

	it("no frame on the sandbox's own host", async () => {
		const h = harness({ location: { origin: 'http://localhost:5173' } });
		const error = await rejection(connectFrame(h.deps));
		expect(error).toBeInstanceOf(FrameError);
		expect((error as FrameError).kind).toBe('same-host');
		expect((error as FrameError).message).toBe('open the app at http://127.0.0.1:5173');
		expect(h.createFrame).not.toHaveBeenCalled();
	});

	it('a frame that never answers times out', async () => {
		const h = harness({ timeoutMs: 20 });
		const removeListener = vi.spyOn(h.window, 'removeEventListener');
		const error = await rejection(connectFrame(h.deps));
		expect(error).toBeInstanceOf(FrameError);
		expect((error as FrameError).kind).toBe('timeout');
		expect(h.removed()).toBe(1);
		expect(removeListener).toHaveBeenCalledWith('message', expect.any(Function));
		dispatch(h, ready());
		expect(h.frame.contentWindow.postMessage).not.toHaveBeenCalled();
		expect(h.channels).toHaveLength(0);
	});

	it('a worker error before ready rejects; after ready it ends the link', async () => {
		const before = harness();
		const connecting = connectFrame(before.deps);
		dispatch(before, { type: 'worker-error', message: 'boom' });
		const error = await rejection(connecting);
		expect(error).toBeInstanceOf(FrameError);
		expect((error as FrameError).kind).toBe('worker');
		expect((error as FrameError).message).toBe('boom');
		expect(before.removed()).toBe(1);
		dispatch(before, ready());
		expect(before.frame.contentWindow.postMessage).not.toHaveBeenCalled();

		// Nothing serves the port, so the call waits until the link ends.
		const after = harness();
		const link = await connected(after);
		const waiting = link.client.call('staged');
		dispatch(after, { type: 'worker-error', message: 'boom' });
		expect(await rejection(waiting)).toBeInstanceOf(EngineGoneError);
		expect(after.removed()).toBe(1);
	});

	it('violations are counted for whoever listens', async () => {
		const h = harness();
		const link = await connected(h);
		const seen: { directive: string; blocked: string }[] = [];
		const unsubscribe = link.onViolation((violation) => seen.push(violation));
		dispatch(h, { type: 'csp-violation', directive: 'script-src', blocked: 'inline' });
		dispatch(h, { type: 'csp-violation', directive: 'connect-src', blocked: 'http://x/' });
		dispatch(h, { type: 'csp-violation', directive: 'img-src', blocked: 'data' }, { source: {} });
		expect(seen).toEqual([
			{ directive: 'script-src', blocked: 'inline' },
			{ directive: 'connect-src', blocked: 'http://x/' }
		]);
		unsubscribe();
		dispatch(h, { type: 'csp-violation', directive: 'script-src', blocked: 'eval' });
		expect(seen).toHaveLength(2);
	});

	it('violations before ready reach every later listener', async () => {
		const h = harness();
		const connecting = connectFrame(h.deps);
		dispatch(h, { type: 'csp-violation', directive: 'script-src', blocked: 'inline' });
		dispatch(h, ready());
		const link = await connecting;
		links.push(link);
		const seen: { directive: string; blocked: string }[] = [];
		link.onViolation((violation) => seen.push(violation));
		expect(seen).toEqual([{ directive: 'script-src', blocked: 'inline' }]);

		dispatch(h, { type: 'csp-violation', directive: 'connect-src', blocked: 'http://x/' });
		const later: { directive: string; blocked: string }[] = [];
		link.onViolation((violation) => later.push(violation));
		expect(later).toEqual([{ directive: 'script-src', blocked: 'inline' }]);
		expect(seen).toHaveLength(2);
	});

	it('dispose removes the frame, the listener and the port', async () => {
		const h = harness();
		const removeListener = vi.spyOn(h.window, 'removeEventListener');
		const link = await connected(h);
		const close = vi.spyOn(h.channels[0]!.port1, 'close');
		const seen: unknown[] = [];
		link.onViolation((violation) => seen.push(violation));
		link.dispose();
		expect(h.removed()).toBe(1);
		expect(removeListener).toHaveBeenCalledWith('message', expect.any(Function));
		expect(close).toHaveBeenCalledOnce();
		await expect(link.client.call('staged')).rejects.toBeInstanceOf(EngineGoneError);
		dispatch(h, { type: 'csp-violation', directive: 'script-src', blocked: 'inline' });
		expect(seen).toEqual([]);
		link.dispose();
		expect(h.removed()).toBe(1);
	});
});
