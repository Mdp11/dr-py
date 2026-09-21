import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotCache, SNAPSHOT_CACHE_CAP, type SnapshotCache } from '../cache';

afterEach(() => {
	vi.restoreAllMocks();
});

/** An `ArrayBuffer` of `size` bytes, filled with `fill` so content can be compared. */
function buf(size: number, fill = 1): ArrayBuffer {
	const bytes = new Uint8Array(size);
	bytes.fill(fill);
	return bytes.buffer;
}

const bytesOf = (buffer: ArrayBuffer): number[] => [...new Uint8Array(buffer)];

function cache(overrides: { capBytes?: number; now?: () => number } = {}): SnapshotCache {
	return createSnapshotCache({ factory: new IDBFactory(), ...overrides });
}

// A request stub that the tests fire by hand: `openDb` sets its handlers
// synchronously after `open()` returns, so a microtask-scheduled trigger
// always finds them in place.
type BareRequest = {
	result: unknown;
	onupgradeneeded: (() => void) | null;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
	onblocked: (() => void) | null;
};

function brokenFactory(trigger: (request: BareRequest) => void): IDBFactory {
	return {
		open: () => {
			const request: BareRequest = {
				result: undefined,
				onupgradeneeded: null,
				onsuccess: null,
				onerror: null,
				onblocked: null
			};
			queueMicrotask(() => trigger(request));
			return request as unknown as IDBOpenDBRequest;
		}
	} as unknown as IDBFactory;
}

describe('SnapshotCache', () => {
	it('a miss on an empty store', async () => {
		await expect(cache().get('p1', 1)).resolves.toBeNull();
	});

	it('what was put comes back, as a copy', async () => {
		const c = cache();
		await c.put('p1', 1, buf(4, 7));
		const got = await c.get('p1', 1);
		expect(got).not.toBeNull();
		expect(bytesOf(got!)).toEqual([7, 7, 7, 7]);

		new Uint8Array(got!).fill(9);
		const again = await c.get('p1', 1);
		expect(bytesOf(again!)).toEqual([7, 7, 7, 7]);
	});

	it('another rev is a miss', async () => {
		const c = cache();
		await c.put('p1', 1, buf(4));
		await expect(c.get('p1', 2)).resolves.toBeNull();
	});

	it("a newer put replaces the project's row", async () => {
		const c = cache();
		await c.put('p1', 1, buf(4, 1));
		await c.put('p1', 2, buf(4, 2));
		await expect(c.get('p1', 1)).resolves.toBeNull();
		const got = await c.get('p1', 2);
		expect(bytesOf(got!)).toEqual([2, 2, 2, 2]);
	});

	it('the least recently used project goes first', async () => {
		let now = 0;
		const c = cache({ capBytes: 100, now: () => now });

		now = 1;
		await c.put('a', 1, buf(40));
		now = 2;
		await c.put('b', 1, buf(40));
		now = 3;
		await c.put('c', 1, buf(40));
		now = 4;
		await c.get('a', 1);
		now = 5;
		await c.put('d', 1, buf(40));

		await expect(c.get('b', 1)).resolves.toBeNull();
		await expect(c.get('a', 1)).resolves.not.toBeNull();
		await expect(c.get('c', 1)).resolves.not.toBeNull();
		await expect(c.get('d', 1)).resolves.not.toBeNull();
	});

	it('the project being written is never the one evicted', async () => {
		let now = 0;
		const c = cache({ capBytes: 50, now: () => now });

		now = 1;
		await c.put('a', 1, buf(30));
		now = 2;
		await c.put('b', 1, buf(30));
		// Both other rows (60 bytes) now exceed the cap; writing a third row of
		// any size forces an eviction, but never of the row just written.
		now = 3;
		await c.put('c', 1, buf(45));

		await expect(c.get('a', 1)).resolves.toBeNull();
		await expect(c.get('b', 1)).resolves.not.toBeNull();
		await expect(c.get('c', 1)).resolves.not.toBeNull();
	});

	it('a row larger than the cap is not stored', async () => {
		const c = cache({ capBytes: 50 });
		await c.put('p1', 1, buf(51));
		await expect(c.get('p1', 1)).resolves.toBeNull();
	});

	it('drop', async () => {
		const c = cache();
		await c.put('p1', 1, buf(4));
		await c.drop('p1');
		await expect(c.get('p1', 1)).resolves.toBeNull();
	});

	describe('nothing ever rejects', () => {
		it('no factory at all', async () => {
			const c = createSnapshotCache({ factory: undefined });
			await expect(c.get('p1', 1)).resolves.toBeNull();
			await expect(c.put('p1', 1, buf(4))).resolves.toBeUndefined();
			await expect(c.drop('p1')).resolves.toBeUndefined();
		});

		it('a factory whose open throws', async () => {
			const factory = {
				open: () => {
					throw new Error('open is unavailable');
				}
			} as unknown as IDBFactory;
			const c = createSnapshotCache({ factory });
			await expect(c.get('p1', 1)).resolves.toBeNull();
			await expect(c.put('p1', 1, buf(4))).resolves.toBeUndefined();
			await expect(c.drop('p1')).resolves.toBeUndefined();
		});

		it('a request whose open fires onerror', async () => {
			const factory = brokenFactory((request) => request.onerror?.());
			const c = createSnapshotCache({ factory });
			await expect(c.get('p1', 1)).resolves.toBeNull();
		});

		it('a request whose open fires onblocked', async () => {
			const factory = brokenFactory((request) => request.onblocked?.());
			const c = createSnapshotCache({ factory });
			await expect(c.get('p1', 1)).resolves.toBeNull();
		});

		it('a put whose transaction aborts', async () => {
			vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
				throw new DOMException('quota exceeded', 'QuotaExceededError');
			});
			const c = cache();
			await expect(c.put('p1', 1, buf(4))).resolves.toBeUndefined();
			vi.restoreAllMocks();
			await expect(c.get('p1', 1)).resolves.toBeNull();
		});
	});

	it('exposes the default cap', () => {
		expect(SNAPSHOT_CACHE_CAP).toBe(64 * 1024 * 1024);
	});
});
