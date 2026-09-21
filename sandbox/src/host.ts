// Runs in the worker and in the frontend's Node tests: only what a window, a
// worker and Node share.
import { SnapshotError, type Port, type ServiceDeps } from '../../engine/src/index.ts';

/**
 * Gunzips a byte stream. A failure of the stream itself (a truncated member,
 * trailing bytes, not gzip) is a `SnapshotError`, which the service answers
 * with a 422 and its text; a failure of the source is rethrown as it is.
 */
export async function* inflate(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
	const stream = new DecompressionStream('gzip');
	const writer = stream.writable.getWriter();
	const reader = stream.readable.getReader();
	const failed: { source: { error: unknown } | null } = { source: null };
	// Never rejects: a stream failure reaches the reader through the stream, a
	// source failure is recorded before the abort that the reader then meets.
	const pump = (async () => {
		const source = chunks[Symbol.asyncIterator]();
		for (;;) {
			let next: IteratorResult<Uint8Array>;
			try {
				next = await source.next();
			} catch (error) {
				failed.source = { error };
				await writer.abort(error).catch(() => {});
				return;
			}
			if (next.done === true) break;
			try {
				// The chunks are ArrayBuffer-backed: they arrive as transferred buffers.
				await writer.write(next.value as Uint8Array<ArrayBuffer>);
			} catch {
				await Promise.resolve(source.return?.()).catch(() => {});
				return;
			}
		}
		await writer.close().catch(() => {});
	})();
	let drained = false;
	try {
		for (;;) {
			let result: ReadableStreamReadResult<Uint8Array>;
			try {
				result = await reader.read();
			} catch {
				if (failed.source !== null) throw failed.source.error;
				throw new SnapshotError('snapshot bytes do not inflate');
			}
			if (result.done) break;
			yield result.value;
		}
		drained = true;
		await pump;
	} finally {
		// Failed or abandoned: cancelling the stream ends a pump blocked on a write.
		if (!drained) await reader.cancel().catch(() => {});
	}
}

/** The host's side of the shared thread; `close()` frees the yield channel. */
export function createHost(): { deps: ServiceDeps; close(): void } {
	// A message is a macrotask without the 4 ms clamp nested timeouts get.
	const channel = new MessageChannel();
	const waiting: (() => void)[] = [];
	channel.port2.onmessage = () => waiting.shift()?.();
	return {
		deps: {
			inflate,
			now: () => performance.now(),
			yieldToHost: () =>
				new Promise<void>((resolve) => {
					waiting.push(resolve);
					channel.port1.postMessage(null);
				})
		},
		close() {
			channel.port1.close();
			channel.port2.close();
		}
	};
}

export type HostPort = {
	postMessage(message: unknown, transfer: Transferable[]): void;
	onmessage: ((event: MessageEvent) => void) | null;
};

/** The engine's `Port` over a `MessagePort`; setting `onmessage` starts it. */
export function portOf(port: HostPort): Port {
	return {
		post(message, transfer) {
			port.postMessage(message, transfer ? [...transfer] : []);
		},
		onMessage(handler) {
			port.onmessage = (event) => handler(event.data);
		}
	};
}
