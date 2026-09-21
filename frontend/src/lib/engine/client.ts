import type { ServiceEvent } from '$engine';
import { errorForStatus } from '$lib/api/errors';

/** Where the client talks to the engine; a `MessagePort` fits. */
export type ClientPort = {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	onmessage: ((event: MessageEvent) => void) | null;
	close(): void;
};

export type CallOptions = { signal?: AbortSignal; transfer?: ArrayBuffer[] };

export type EngineClient = {
	call<T>(method: string, params?: unknown, options?: CallOptions): Promise<T>;
	/** Subscribes to the engine's events; the returned function unsubscribes. */
	on(listener: (event: ServiceEvent) => void): () => void;
	/** Rejects every pending call, closes the port and refuses every later call. */
	dispose(): void;
};

/** An engine that was reached, and what its host reports besides the client. */
export type EngineLink = {
	client: EngineClient;
	/** Whether the engine's host is cross-origin isolated; `null` when it has no say. */
	isolated: boolean | null;
	onViolation(listener: (violation: { directive: string; blocked: string }) => void): () => void;
	dispose(): void;
};

/** A call made after, or still waiting at, the client's `dispose()`. */
export class EngineGoneError extends Error {
	constructor() {
		super('the engine is gone');
		this.name = 'EngineGoneError';
	}
}

type Pending = {
	resolve(result: unknown): void;
	reject(error: unknown): void;
	/** Detaches the abort listener. */
	release(): void;
};

type Listener = { listener: (event: ServiceEvent) => void };

const aborted = () => new DOMException('The operation was aborted.', 'AbortError');

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

/**
 * The engine's service over a port: each call is a request under its own id,
 * answered once; an error answer is the `ApiError` its status names, as after
 * an HTTP call.
 */
export function createEngineClient(port: ClientPort): EngineClient {
	const pending = new Map<number, Pending>();
	const listeners = new Set<Listener>();
	let nextId = 1;
	let disposed = false;

	const settle = (id: number): Pending | undefined => {
		const call = pending.get(id);
		if (call === undefined) return undefined;
		pending.delete(id);
		call.release();
		return call;
	};

	const deliver = (event: ServiceEvent) => {
		for (const entry of [...listeners]) {
			if (!listeners.has(entry)) continue;
			try {
				entry.listener(event);
			} catch (error) {
				// One failing listener must not starve the others; the error still surfaces.
				queueMicrotask(() => {
					throw error;
				});
			}
		}
	};

	port.onmessage = ({ data }) => {
		if (disposed || !isRecord(data)) return;
		if ('event' in data) {
			deliver(data as ServiceEvent);
			return;
		}
		if (typeof data.id !== 'number') return;
		const call = settle(data.id);
		if (call === undefined) return;
		if (data.ok === true) {
			call.resolve(data.result);
			return;
		}
		const error = isRecord(data.error) ? data.error : {};
		const status = typeof error.status === 'number' ? error.status : 500;
		const detail = typeof error.detail === 'string' ? error.detail : `engine error ${status}`;
		call.reject(errorForStatus(status, { detail }, detail));
	};

	return {
		call<T>(method: string, params?: unknown, options: CallOptions = {}): Promise<T> {
			if (disposed) return Promise.reject(new EngineGoneError());
			const { signal, transfer } = options;
			if (signal?.aborted) return Promise.reject(aborted());
			const id = nextId++;
			return new Promise<T>((resolve, reject) => {
				const onAbort = () => {
					if (settle(id) === undefined) return;
					port.postMessage({ cancel: id });
					reject(aborted());
				};
				pending.set(id, {
					resolve: resolve as (result: unknown) => void,
					reject,
					release: () => signal?.removeEventListener('abort', onAbort)
				});
				signal?.addEventListener('abort', onAbort, { once: true });
				const request = params === undefined ? { id, method } : { id, method, params };
				try {
					port.postMessage(request, transfer ?? []);
				} catch (error) {
					settle(id);
					reject(error);
				}
			});
		},

		on(listener) {
			const entry: Listener = { listener };
			listeners.add(entry);
			return () => {
				listeners.delete(entry);
			};
		},

		dispose() {
			if (disposed) return;
			disposed = true;
			listeners.clear();
			for (const id of [...pending.keys()]) settle(id)?.reject(new EngineGoneError());
			port.onmessage = null;
			port.close();
		}
	};
}
