/**
 * The cache of embedded call results: one entry per `(code, entry, element ids,
 * inputs, doc)` call, the code held as an id from `codes`, evicted by what a transition touched. An entry carries
 * the keys its call read; a transition's touched keys evict every entry that
 * read one of them, and every entry that depends on everything. Entries leave
 * least recently used first once the entry or byte bound is passed.
 */
import { pyDumps } from '../value/serialize.ts';
import type { EmbeddedEntry, ReadKey, ScriptErrorKind, ScriptResult } from './result.ts';

/** The text a call is looked up by. */
export type CellKey = string;

/**
 * Short ids for snippet codes, so that a key holds a number where it would hold
 * the code: a table asks for a call per row and a code may be 64 KiB. An id names
 * one code for as long as the ids live and is never given to another, not even
 * after `clear`, which only forgets the codes as the cache forgets its entries (a
 * call asked for after it gets a new id and misses the entries kept under the
 * old one, which age out).
 */
export class CodeIds {
	private readonly ids = new Map<string, number>();
	private next = 0;

	id(code: string): number {
		let id = this.ids.get(code);
		if (id === undefined) {
			id = this.next++;
			this.ids.set(code, id);
		}
		return id;
	}

	clear(): void {
		this.ids.clear();
	}
}

/**
 * The call's key: the id of its code, the entry, the ids it runs over, and the
 * texts of its resolved inputs and document (`null` for none). The code is
 * named by its id, so an edited snippet is a different key and a key does not
 * grow with the code.
 */
export function cellKey(
	codeId: number,
	entry: EmbeddedEntry,
	elementIds: readonly string[],
	inputsText: string | null,
	docText: string | null
): CellKey {
	return pyDumps([codeId, entry, [...elementIds], inputsText, docText]);
}

/**
 * A read key as a string, the form a touched set holds. The tag may be one the
 * guest invented, so it is not assumed to be a `ReadTag`: a tag holding a NUL
 * can only match another key's text by accident, which evicts too much and
 * never too little.
 */
export function readKeyText(key: ReadKey): string {
	const [tag, id] = key;
	return id === null ? `${tag}\u0001` : `${tag}\u0000${id}`;
}

export type CellCacheLimits = {
	/** Entries held. */
	entries: number;
	/** Keys and result texts held, counted as UTF-16 code units × 2. */
	bytes: number;
	/** An entry, key and text, above this is not stored. */
	entryBytes: number;
	/** A read-set above this many keys is stored as "depends on everything". */
	reads: number;
	/**
	 * What one `evict` may spend removing entries, in map operations: an entry costs one
	 * and one for each key it read. A transition that would spend more clears the cache.
	 */
	evictWork: number;
};

export const CELL_CACHE_LIMITS: CellCacheLimits = {
	entries: 50_000,
	bytes: 32 * 1024 * 1024,
	entryBytes: 64 * 1024,
	reads: 128,
	evictWork: 100_000
};

// What reproduces: a value, or an error the same code and state raise again.
// Anything else (a timeout, a cancel, a missing guest) is retried, so an unknown kind is not stored.
const CACHEABLE_ERRORS: ReadonlySet<ScriptErrorKind> = new Set(['runtime', 'syntax']);

type Entry = {
	result: ScriptResult;
	bytes: number;
	/** `null`: depends on everything. */
	reads: readonly string[] | null;
};

export class CellCache {
	private readonly limits: CellCacheLimits;
	// Map order is recency: the first key is the least recently used.
	private readonly entries = new Map<CellKey, Entry>();
	private readonly byRead = new Map<string, Set<CellKey>>();
	private readonly everything = new Set<CellKey>();
	private held = 0;
	/** The ids the keys of this cache's entries name their codes by. */
	readonly codes = new CodeIds();

	constructor(limits: CellCacheLimits = CELL_CACHE_LIMITS) {
		this.limits = limits;
	}

	get size(): number {
		return this.entries.size;
	}

	get bytes(): number {
		return this.held;
	}

	get(key: CellKey): ScriptResult | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.result;
	}

	/**
	 * Stores `result`, whose wire answer was `text`, unless it is not one that
	 * reproduces or is too large; a key carries the inputs, so it is counted with
	 * the text. A read-set above the bound, or none, is stored
	 * as "depends on everything".
	 */
	put(key: CellKey, result: ScriptResult, text: string): void {
		if (result.error !== null && !CACHEABLE_ERRORS.has(result.error.kind)) return;
		const bytes = (key.length + text.length) * 2;
		if (bytes > this.limits.entryBytes) return;
		this.remove(key);
		const keys = result.reads === null ? null : [...new Set(result.reads.map(readKeyText))];
		const reads = keys === null || keys.length > this.limits.reads ? null : keys;
		this.entries.set(key, { result, bytes, reads });
		this.held += bytes;
		if (reads === null) this.everything.add(key);
		else {
			for (const read of reads) {
				const readers = this.byRead.get(read);
				if (readers === undefined) this.byRead.set(read, new Set([key]));
				else readers.add(key);
			}
		}
		while (this.entries.size > this.limits.entries || this.held > this.limits.bytes) {
			this.remove(this.entries.keys().next().value!);
		}
	}

	/**
	 * Drops the entries that read a key in `touched` and every entry that
	 * depends on everything, the latter whatever `touched` holds; answers how
	 * many went. A transition that touched nothing does not call it. Dropping
	 * costs the entries' read-sets, which the bounds allow to be 6.4 million
	 * map operations: one that would pass `evictWork` clears the cache instead,
	 * which drops more and never less.
	 */
	evict(touched: ReadonlySet<string>): number {
		const budget = this.limits.evictWork;
		const doomed = new Set(this.everything);
		let work = doomed.size;
		for (const read of touched) {
			const readers = this.byRead.get(read);
			if (readers === undefined) continue;
			for (const key of readers) {
				if (doomed.has(key)) continue;
				doomed.add(key);
				work += 1 + this.entries.get(key)!.reads!.length;
				if (work > budget) {
					const held = this.entries.size;
					this.clear();
					return held;
				}
			}
		}
		for (const key of doomed) this.remove(key);
		return doomed.size;
	}

	clear(): void {
		this.codes.clear();
		this.entries.clear();
		this.byRead.clear();
		this.everything.clear();
		this.held = 0;
	}

	private remove(key: CellKey): void {
		const entry = this.entries.get(key);
		if (entry === undefined) return;
		this.entries.delete(key);
		this.held -= entry.bytes;
		if (entry.reads === null) this.everything.delete(key);
		else {
			for (const read of entry.reads) {
				const readers = this.byRead.get(read)!;
				readers.delete(key);
				if (readers.size === 0) this.byRead.delete(read);
			}
		}
	}
}
