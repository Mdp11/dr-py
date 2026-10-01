// The reply channel between the engine worker and its script worker: one
// SharedArrayBuffer the script worker blocks on, written by the engine worker.
//
//   header (Int32, bytes 0-15)  [0] state: 0 waiting, 1 chunk ready
//                               [1] bytes in this chunk
//                               [2] bytes still to come after it
//   payload (from byte 16)      the chunk, raw bytes of the reply's UTF-8
//
// The reply travels as bytes and is decoded once by the reader, on the whole
// reply: a chunk edge may fall inside a character.
//
// Who writes what: the reader stores state 0 (`armReply`, and between chunks)
// only while the writer is idle; the writer stores length, remainder and
// payload, then state 1, then notifies, and only when a request or a `more`
// has reached it. The reader posts that request or `more` AFTER its store of
// state 0, so a store of 0 never follows the writer's store of 1 for the same
// chunk, and the payload is never written while the reader copies it.

export const REPLY_BUFFER_BYTES = 1 << 20;
export const HEADER_BYTES = 16;

const STATE = 0;
const CHUNK = 1;
const REST = 2;
const CAPACITY = REPLY_BUFFER_BYTES - HEADER_BYTES;
const EMPTY = new Uint8Array(0);

export function createReplyBuffer(): SharedArrayBuffer {
	return new SharedArrayBuffer(REPLY_BUFFER_BYTES);
}

/** Engine side: holds a reply and writes it one chunk at a time. */
export class ReplyWriter {
	readonly #header: Int32Array;
	readonly #payload: Uint8Array;
	#pending: Uint8Array = EMPTY;
	#offset = 0;

	constructor(buffer: SharedArrayBuffer) {
		this.#header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
		this.#payload = new Uint8Array(buffer, HEADER_BYTES, CAPACITY);
	}

	/** Chunks of a reply remain to be written, each for a `more`. */
	get pending(): boolean {
		return this.#offset < this.#pending.length;
	}

	/** Starts a reply and writes its first chunk; the writer keeps `bytes`, which the caller must not change. */
	begin(bytes: Uint8Array): void {
		this.#pending = bytes;
		this.#offset = 0;
		this.#write();
	}

	/** Writes the next chunk, for a reader that copied the last and asked; nothing is written once the reply is out. */
	more(): void {
		if (this.#offset >= this.#pending.length) return;
		this.#write();
	}

	#write(): void {
		const n = Math.min(CAPACITY, this.#pending.length - this.#offset);
		const rest = this.#pending.length - this.#offset - n;
		Atomics.store(this.#header, CHUNK, n);
		Atomics.store(this.#header, REST, rest);
		this.#payload.set(this.#pending.subarray(this.#offset, this.#offset + n));
		this.#offset += n;
		if (rest === 0) {
			this.#pending = EMPTY;
			this.#offset = 0;
		}
		Atomics.store(this.#header, STATE, 1);
		Atomics.notify(this.#header, STATE);
	}
}

/** Worker side: call before posting a request. */
export function armReply(buffer: SharedArrayBuffer): void {
	Atomics.store(new Int32Array(buffer, 0, HEADER_BYTES / 4), STATE, 0);
}

/**
 * Worker side: blocks until the whole reply has crossed and returns it as a
 * fresh (non-shared) array. `askMore` is called after a chunk that is not the
 * last was copied out and the state reset, and must make the writer send the
 * next. There is no timeout: the engine always answers. Never call it on a
 * thread that may not block.
 */
export function readReply(buffer: SharedArrayBuffer, askMore: () => void): Uint8Array {
	const header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
	const payload = new Uint8Array(buffer, HEADER_BYTES, CAPACITY);
	let reply: Uint8Array | null = null;
	let filled = 0;
	for (;;) {
		// Re-checked after every return: `wait` answers "not-equal" at once when
		// the chunk is already there, and a wake is only ever a hint.
		while (Atomics.load(header, STATE) === 0) Atomics.wait(header, STATE, 0);
		const n = Atomics.load(header, CHUNK);
		const rest = Atomics.load(header, REST);
		if (n < 0 || n > CAPACITY || rest < 0 || (rest > 0 && n === 0)) {
			throw new Error(`reply buffer header is corrupt (${n} bytes, ${rest} to come)`);
		}
		reply ??= new Uint8Array(n + rest);
		if (filled + n + rest !== reply.length) throw new Error('reply chunks disagree on the length');
		// The copy lands in a plain array: a decoder refuses a view over shared memory.
		reply.set(payload.subarray(0, n), filled);
		filled += n;
		if (rest === 0) return reply;
		Atomics.store(header, STATE, 0);
		askMore();
	}
}
