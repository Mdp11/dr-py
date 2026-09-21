import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

import { createService, SnapshotError } from '../../engine/src/index.ts';
import { createHost, inflate, portOf } from '../src/host.ts';

const hosts: { close(): void }[] = [];
const channels: MessageChannel[] = [];

function host() {
	const made = createHost();
	hosts.push(made);
	return made;
}

function channel(): MessageChannel {
	const made = new MessageChannel();
	channels.push(made);
	return made;
}

afterEach(() => {
	for (const made of hosts.splice(0)) made.close();
	for (const made of channels.splice(0)) {
		made.port1.close();
		made.port2.close();
	}
});

async function* cut(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
	for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, at + size);
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
	const out: Uint8Array[] = [];
	for await (const chunk of chunks) out.push(chunk);
	return out;
}

function join(pieces: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
	let at = 0;
	for (const piece of pieces) {
		out.set(piece, at);
		at += piece.length;
	}
	return out;
}

function text200k(): Uint8Array {
	const lines: string[] = [];
	for (let i = 0; lines.join('\n').length < 200_000; i++) {
		lines.push(`{"id":"el-${i}","type_name":"Thing","properties":{"name":"thing ${i} ünïcødé"}}`);
	}
	return new TextEncoder().encode(lines.join('\n').slice(0, 200_000));
}

function nextMessage(port: MessagePort): Promise<unknown> {
	return new Promise((resolve) => {
		port.onmessage = (event) => resolve(event.data);
	});
}

describe('inflate', () => {
	it('gives the bytes back however the input is cut', async () => {
		const plain = text200k();
		const packed = new Uint8Array(gzipSync(plain));
		for (const size of [1, 7, 65_536]) {
			const pieces = await collect(inflate(cut(packed, size)));
			for (const piece of pieces) expect(piece).toBeInstanceOf(Uint8Array);
			expect(Buffer.from(join(pieces)).equals(Buffer.from(plain))).toBe(true);
		}
	});

	it('refuses a stream that does not inflate with a SnapshotError', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const packed = new Uint8Array(gzipSync(text200k()));
			const stray = join([packed, new Uint8Array([1, 2, 3, 4])]);
			const cases = [
				packed.slice(0, packed.length - 10),
				stray,
				new TextEncoder().encode('{"format":"datarover.snapshot/v2"}\n')
			];
			for (const bytes of cases) {
				const outcome = collect(inflate(cut(bytes, 4096)));
				await expect(outcome).rejects.toBeInstanceOf(SnapshotError);
				await expect(outcome).rejects.toThrow('snapshot bytes do not inflate');
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});

	it('ends when its reader stops early', async () => {
		const packed = new Uint8Array(gzipSync(text200k()));
		let read = 0;
		for await (const piece of inflate(cut(packed, 1024))) {
			read += piece.length;
			break;
		}
		expect(read).toBeGreaterThan(0);
	});

	it('keeps the error of a failing source as it is', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const closed = new Error('closed');
			const packed = new Uint8Array(gzipSync(text200k()));
			async function* source(): AsyncIterable<Uint8Array> {
				yield packed.slice(0, 1000);
				throw closed;
			}
			await expect(collect(inflate(source()))).rejects.toBe(closed);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});
});

describe('createHost', () => {
	it('yields to the host on a macrotask, first in first out', async () => {
		const { deps } = host();
		const order: number[] = [];
		void deps.yieldToHost().then(() => order.push(1));
		void deps.yieldToHost().then(() => order.push(2));
		for (let i = 0; i < 1000; i++) await null;
		expect(order).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(order).toEqual([1, 2]);
	});

	it('reads a monotonic clock', () => {
		const { deps } = host();
		const first = deps.now();
		expect(deps.now()).toBeGreaterThanOrEqual(first);
	});
});

describe('portOf', () => {
	it('carries the engine over a MessagePort', async () => {
		const { port1, port2 } = channel();
		port1.postMessage({ id: 0, method: 'nope' });
		createService(portOf(port2), host().deps);
		expect(await nextMessage(port1)).toEqual({
			id: 0,
			ok: false,
			error: { status: 404, detail: "No method 'nope'" }
		});
		const answer = nextMessage(port1);
		port1.postMessage({ id: 1, method: 'nope' });
		expect(await answer).toEqual({
			id: 1,
			ok: false,
			error: { status: 404, detail: "No method 'nope'" }
		});
	});

	it('hands its transfer list on', async () => {
		const { port1, port2 } = channel();
		const received = nextMessage(port2);
		const buffer = new ArrayBuffer(16);
		portOf(port1).post({ bytes: buffer }, [buffer]);
		expect(buffer.byteLength).toBe(0);
		const message = (await received) as { bytes: ArrayBuffer };
		expect(message.bytes.byteLength).toBe(16);
	});
});
