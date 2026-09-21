// No `$engine` or `$sandbox` import: the cache holds bytes, never model content.

/** One project's newest snapshot, kept until the cap evicts it. */
export type SnapshotCache = {
	get(projectId: string, rev: number): Promise<ArrayBuffer | null>;
	put(projectId: string, rev: number, bytes: ArrayBuffer): Promise<void>;
	drop(projectId: string): Promise<void>;
};

/** Total bytes kept across every project's row. */
export const SNAPSHOT_CACHE_CAP = 64 * 1024 * 1024;

const DB_NAME = 'datarover-snapshots';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';

type Row = {
	project_id: string;
	rev: number;
	bytes: ArrayBuffer;
	size: number;
	used_at: number;
};

function defaultFactory(): IDBFactory | undefined {
	return typeof globalThis.indexedDB === 'undefined' ? undefined : globalThis.indexedDB;
}

/** Opens the database, creating its one store on first use. `null` on any failure. */
function openDb(factory: IDBFactory): Promise<IDBDatabase | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (db: IDBDatabase | null) => {
			if (settled) return;
			settled = true;
			resolve(db);
		};
		let request: IDBOpenDBRequest;
		try {
			request = factory.open(DB_NAME, DB_VERSION);
		} catch {
			finish(null);
			return;
		}
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: 'project_id' });
			}
		};
		request.onsuccess = () => finish(request.result);
		request.onerror = () => finish(null);
		request.onblocked = () => finish(null);
	});
}

/**
 * Runs `body` over a fresh `readwrite` transaction on the one store and
 * resolves `fallback` on any failure along the way — a thrown open, a denied
 * request, a blocked upgrade, an aborted transaction, a store method that
 * throws synchronously. The connection opened for the call is closed once
 * the transaction settles.
 */
function withStore<T>(
	factory: IDBFactory | undefined,
	fallback: T,
	body: (store: IDBObjectStore, finish: (value: T) => void) => void
): Promise<T> {
	if (!factory) return Promise.resolve(fallback);
	return openDb(factory).then((db) => {
		if (!db) return fallback;
		return new Promise<T>((resolve) => {
			let settled = false;
			let result = fallback;
			const finish = (value: T) => {
				result = value;
			};
			const done = () => {
				if (settled) return;
				settled = true;
				try {
					db.close();
				} catch {
					// The connection is being discarded either way.
				}
				resolve(result);
			};
			let tx: IDBTransaction;
			try {
				tx = db.transaction(STORE_NAME, 'readwrite');
			} catch {
				done();
				return;
			}
			tx.onabort = done;
			tx.onerror = done;
			tx.oncomplete = done;
			try {
				const store = tx.objectStore(STORE_NAME);
				body(store, finish);
			} catch {
				try {
					tx.abort();
				} catch {
					// The transaction may already be finished.
				}
				done();
			}
		});
	});
}

/**
 * The IndexedDB store of snapshot bytes, one row per project: key
 * `project_id`, value `{project_id, rev, bytes, size, used_at}` — the newest
 * `rev` a project was cached at, by construction. Every call resolves,
 * whatever the store does: a missing `indexedDB`, a failed or blocked
 * `open`, an aborted transaction and a quota error are all a no-op
 * `put`/`drop` or a `null` `get`, never a rejection.
 */
export function createSnapshotCache(
	options: { factory?: IDBFactory | undefined; capBytes?: number; now?: () => number } = {}
): SnapshotCache {
	const factory = options.factory ?? defaultFactory();
	const capBytes = options.capBytes ?? SNAPSHOT_CACHE_CAP;
	const now = options.now ?? Date.now;

	return {
		get(projectId, rev) {
			return withStore<ArrayBuffer | null>(factory, null, (store, finish) => {
				const request = store.get(projectId);
				request.onerror = () => finish(null);
				request.onsuccess = () => {
					const row = request.result as Row | undefined;
					if (!row || row.rev !== rev) return;
					finish(row.bytes);
					try {
						store.put({ ...row, used_at: now() });
					} catch {
						// The read already succeeded; a failed recency update is not fatal.
					}
				};
			});
		},

		put(projectId, rev, bytes) {
			const size = bytes.byteLength;
			if (size > capBytes) return Promise.resolve();
			return withStore<void>(factory, undefined, (store) => {
				const row: Row = { project_id: projectId, rev, bytes, size, used_at: now() };
				store.put(row);
				// Evict least-recently-used rows of OTHER projects — the row just
				// written is never a candidate — until the total fits the cap.
				const all = store.getAll();
				all.onsuccess = () => {
					const others = ((all.result as Row[]) ?? [])
						.filter((other) => other.project_id !== projectId)
						.sort((a, b) => a.used_at - b.used_at);
					let total = size + others.reduce((sum, other) => sum + other.size, 0);
					for (const other of others) {
						if (total <= capBytes) break;
						store.delete(other.project_id);
						total -= other.size;
					}
				};
			});
		},

		drop(projectId) {
			return withStore<void>(factory, undefined, (store) => {
				store.delete(projectId);
			});
		}
	};
}
