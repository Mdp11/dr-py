/**
 * A pass's memo of navigation results, as `core/table/nav_memo.py` has it.
 * An expand column's rows come out contiguous per base row, so every later
 * consumer that navigates from a row's source repeats one navigation from one
 * set of roots; the memo runs it once. Each pass (build, order, cells) makes
 * its own and drops it at its end. A navigation that may run a snippet is
 * never memoized.
 */
import type { ChainNode } from '../navigation/evaluate.ts';
import { navigationHasScript } from '../navigation/resolve.ts';
import type { NavigationColumn } from './schema.ts';

export type MemoEntry = { chains: readonly (readonly ChainNode[])[]; truncated: boolean };

const DEFAULT_MAX_ENTRIES = 64;

/** A bounded LRU keyed by a column and its roots. */
export class NavMemo {
	readonly maxEntries: number;
	private readonly entries = new Map<string, MemoEntry>();
	private readonly columnIds = new Map<NavigationColumn, number>();
	private readonly scriptedColumns = new Map<NavigationColumn, boolean>();

	constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
		if (maxEntries < 1) throw new Error('maxEntries must be >= 1');
		this.maxEntries = maxEntries;
	}

	/** The key of `col` evaluated from `roots`, in order. */
	key(col: NavigationColumn, roots: readonly string[]): string {
		let id = this.columnIds.get(col);
		if (id === undefined) {
			id = this.columnIds.size;
			this.columnIds.set(col, id);
		}
		return `${id}:${JSON.stringify(roots)}`;
	}

	get(key: string): MemoEntry | undefined {
		const hit = this.entries.get(key);
		if (hit !== undefined) {
			this.entries.delete(key);
			this.entries.set(key, hit);
		}
		return hit;
	}

	put(key: string, entry: MemoEntry): void {
		this.entries.delete(key);
		this.entries.set(key, entry);
		for (const oldest of this.entries.keys()) {
			if (this.entries.size <= this.maxEntries) break;
			this.entries.delete(oldest);
		}
	}

	/** Whether `col`'s navigation may run a snippet; answered once per column. */
	scripted(col: NavigationColumn): boolean {
		let answer = this.scriptedColumns.get(col);
		if (answer === undefined) {
			const defn = col.navigation.definition;
			answer = defn !== null && navigationHasScript(defn);
			this.scriptedColumns.set(col, answer);
		}
		return answer;
	}

	get size(): number {
		return this.entries.size;
	}
}
