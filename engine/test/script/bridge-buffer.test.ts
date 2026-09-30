import { afterEach, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import {
	armReply,
	createReplyBuffer,
	HEADER_BYTES,
	readReply,
	REPLY_BUFFER_BYTES,
	ReplyWriter
} from '../../src/script/bridge-buffer.ts';

const CAPACITY = REPLY_BUFFER_BYTES - HEADER_BYTES;

/** The engine side of a real reader thread: answers each `bridge` with `answer`'s bytes. */
function setup(answer: (n: number) => Uint8Array | Promise<Uint8Array>) {
	const buffer = createReplyBuffer();
	const writer = new ReplyWriter(buffer);
	const worker = new Worker(new URL('./fixtures/buffer-reader.ts', import.meta.url), {
		workerData: { buffer }
	});
	workers.push(worker);
	let requests = 0;
	let waiting: { resolve(bytes: Uint8Array): void; reject(error: Error): void } | null = null;
	worker.on('error', (error) => waiting?.reject(error));
	worker.on('message', (message: { type: string; bytes?: Uint8Array }) => {
		if (message.type === 'bridge') {
			const n = requests++;
			void Promise.resolve(answer(n)).then((bytes) => writer.begin(bytes));
		} else if (message.type === 'more') writer.more();
		else if (message.type === 'reply') waiting?.resolve(message.bytes ?? new Uint8Array());
	});
	const read = (spinMs?: number) =>
		new Promise<Uint8Array>((resolve, reject) => {
			waiting = { resolve, reject };
			worker.postMessage({ type: 'read', spinMs });
		});
	return { buffer, read, requests: () => requests };
}

const workers: Worker[] = [];
afterEach(async () => {
	await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

/** `toEqual` walks a typed array element by element: minutes at 3 MiB. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.byteLength === b.byteLength && Buffer.compare(a, b) === 0;
}

function pattern(length: number, seed = 0): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed * 7 + (i >> 8)) & 0xff;
	return bytes;
}

describe('the reply buffer layout', () => {
	it('is 1 MiB with a 16-byte header', () => {
		expect(REPLY_BUFFER_BYTES).toBe(1 << 20);
		expect(HEADER_BYTES).toBe(16);
		expect(createReplyBuffer().byteLength).toBe(REPLY_BUFFER_BYTES);
	});

	it('writes one chunk at a time and records what is still to come', () => {
		const buffer = createReplyBuffer();
		const header = new Int32Array(buffer, 0, 4);
		const writer = new ReplyWriter(buffer);
		const reply = pattern(CAPACITY + 5);
		armReply(buffer);
		expect(header[0]).toBe(0);
		writer.begin(reply);
		expect([header[0], header[1], header[2]]).toEqual([1, CAPACITY, 5]);
		expect(
			sameBytes(new Uint8Array(buffer, HEADER_BYTES, CAPACITY), reply.subarray(0, CAPACITY))
		).toBe(true);
		armReply(buffer);
		writer.more();
		expect([header[0], header[1], header[2]]).toEqual([1, 5, 0]);
		expect(new Uint8Array(buffer, HEADER_BYTES, 5)).toEqual(reply.subarray(CAPACITY));
	});

	it('ignores a `more` with nothing left to send', () => {
		const buffer = createReplyBuffer();
		const header = new Int32Array(buffer, 0, 4);
		const writer = new ReplyWriter(buffer);
		writer.begin(pattern(3));
		armReply(buffer);
		writer.more();
		expect(header[0]).toBe(0);
	});

	it('drops the remainder of a reply a new one replaces', () => {
		const buffer = createReplyBuffer();
		const writer = new ReplyWriter(buffer);
		writer.begin(pattern(CAPACITY + 9));
		armReply(buffer);
		writer.begin(pattern(2, 1));
		armReply(buffer);
		writer.more();
		expect(new Int32Array(buffer, 0, 4)[0]).toBe(0);
	});

	it('reads a whole reply on one thread when the writer answers each `more`', () => {
		const buffer = createReplyBuffer();
		const writer = new ReplyWriter(buffer);
		const reply = pattern(2 * CAPACITY + 123);
		armReply(buffer);
		writer.begin(reply);
		let asked = 0;
		const got = readReply(buffer, () => {
			asked++;
			writer.more();
		});
		expect(asked).toBe(2);
		expect(sameBytes(got, reply)).toBe(true);
		expect(got.buffer).not.toBeInstanceOf(SharedArrayBuffer);
	});
});

describe('a reply crossing to a blocked reader thread', () => {
	it('delivers a short reply intact', async () => {
		const reply = new TextEncoder().encode('{"id": 1, "result": []}');
		const { read } = setup(() => reply);
		expect(await read()).toEqual(reply);
	});

	it('delivers an empty reply as zero bytes without hanging', async () => {
		const { read } = setup(() => new Uint8Array(0));
		const got = await read();
		expect(got.byteLength).toBe(0);
	});

	it('takes one chunk at exactly the capacity and two for one byte more', async () => {
		const exact = pattern(CAPACITY, 1);
		const over = pattern(CAPACITY + 1, 2);
		const sizes = [exact, over];
		const { read, buffer } = setup((n) => sizes[n]!);
		const header = new Int32Array(buffer, 0, 4);
		expect(sameBytes(await read(), exact)).toBe(true);
		// The last chunk of the reply stays in the buffer: one chunk, nothing to come.
		expect([header[1], header[2]]).toEqual([CAPACITY, 0]);
		expect(sameBytes(await read(), over)).toBe(true);
		expect([header[1], header[2]]).toEqual([1, 0]);
	});

	it.each(['a', 'aaa'])(
		'delivers 3.5 MiB of multi-byte text byte-identical, chunk edges inside characters (prefix %j)',
		async (prefix) => {
			const length = Math.floor(3.5 * (1 << 20));
			const unit = '😀é';
			const text = prefix + unit.repeat(Math.ceil(length / 6));
			const encoded = new TextEncoder().encode(text);
			expect(encoded.byteLength).toBeGreaterThan(length);
			// Every chunk edge falls between two bytes of one character.
			for (let edge = CAPACITY; edge < encoded.byteLength; edge += CAPACITY) {
				expect(encoded[edge]! & 0xc0, `byte at ${edge}`).toBe(0x80);
			}
			const { read } = setup(() => encoded);
			const got = await read();
			expect(got.byteLength).toBe(encoded.byteLength);
			expect(sameBytes(got, encoded)).toBe(true);
			expect(new TextDecoder('utf-8', { fatal: true }).decode(got)).toBe(text);
		}
	);

	it('does not lose the wake when the reply is written before the reader waits', async () => {
		const reply = pattern(3000, 3);
		const { read } = setup(() => reply);
		expect(sameBytes(await read(100), reply)).toBe(true);
	});

	it('does not lose the wake when the reply lands long after the reader waits', async () => {
		const reply = pattern(CAPACITY + 10, 4);
		const { read } = setup(async () => {
			await new Promise((done) => setTimeout(done, 100));
			return reply;
		});
		expect(sameBytes(await read(), reply)).toBe(true);
	});

	it('answers 2,000 rounds in a row on one buffer', async () => {
		const sizeOf = (n: number) => (n % 97 === 0 ? CAPACITY + (n % 5) : (n * 37) % 700);
		const { read, requests } = setup((n) => pattern(sizeOf(n), n));
		for (let n = 0; n < 2000; n++) {
			const got = await read(n % 3 === 0 ? 0.2 : undefined);
			expect(got.byteLength, `round ${n}`).toBe(sizeOf(n));
			expect(sameBytes(got, pattern(sizeOf(n), n)), `round ${n}`).toBe(true);
		}
		expect(requests()).toBe(2000);
	}, 60_000);
});
