type Waiter = {
	resolve(result: IteratorResult<Uint8Array, undefined>): void;
	reject(error: unknown): void;
};

/**
 * An async iterable of byte chunks, fed from outside: `push` adds one, `end`
 * says there are no more, `fail` ends it with an error that the reader meets
 * at once, whatever it had not read yet. One reader.
 */
export class ByteQueue implements AsyncIterable<Uint8Array> {
	private readonly chunks: Uint8Array[] = [];
	private ended = false;
	private failure: { error: unknown } | null = null;
	private waiter: Waiter | null = null;

	push(bytes: Uint8Array): void {
		if (this.ended || this.failure !== null) return;
		const waiter = this.take();
		if (waiter !== null) waiter.resolve({ value: bytes, done: false });
		else this.chunks.push(bytes);
	}

	end(): void {
		this.ended = true;
		if (this.chunks.length === 0) this.take()?.resolve({ value: undefined, done: true });
	}

	fail(error: unknown): void {
		if (this.failure !== null) return;
		this.failure = { error };
		this.chunks.length = 0;
		this.take()?.reject(error);
	}

	private take(): Waiter | null {
		const waiter = this.waiter;
		this.waiter = null;
		return waiter;
	}

	[Symbol.asyncIterator](): AsyncIterator<Uint8Array, undefined> {
		return {
			next: () => {
				if (this.failure !== null) return Promise.reject(this.failure.error);
				const chunk = this.chunks.shift();
				if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false });
				if (this.ended) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve, reject) => (this.waiter = { resolve, reject }));
			}
		};
	}
}
