/**
 * Table row orders kept between calls, as `api/table_cache.py` keeps them per
 * session: a later page of the same table evaluates only its own cells.
 */
import { pyDumps } from '../value/serialize.ts';
import type { Value } from '../value/types.ts';
import type { RowKey } from './rows.ts';
import type { TableDefinition } from './schema.ts';

/** Where the working copy stood when an order was built: its committed rev and staged version. */
export type OrderStamp = { readonly rev: number; readonly stagedVersion: number };

/** A table's rows in order, and what the build said of them. Read, never mutated. */
export type CachedOrder = {
	readonly keys: readonly RowKey[];
	readonly truncated: boolean;
	readonly baseTotal: number;
	readonly baseSlots: number;
};

const MAX_ENTRIES = 16;

/** Fields a table and its columns carry for display and export only: they order no row. */
const SHOWN_TABLE: ReadonlySet<string> = new Set([
	'default_cell_mode',
	'show_row_numbers',
	'export_order',
	'display_order',
	'export_row_number',
	'json_split',
	'transform'
]);
const SHOWN_COLUMN: ReadonlySet<string> = new Set([
	'header',
	'width_px',
	'hidden',
	'json_export',
	'export'
]);

const without = (object: object, shown: ReadonlySet<string>): { [key: string]: unknown } =>
	Object.fromEntries(Object.entries(object).filter(([key]) => !shown.has(key)));

/**
 * The key a resolved table's order is kept under: its text without what is
 * only shown or exported. Every navigation it reads is inlined, so a change
 * to one changes the key.
 */
export function orderKey(defn: TableDefinition): string {
	const semantic = {
		...without(defn, SHOWN_TABLE),
		columns: defn.columns.map((col) => without(col, SHOWN_COLUMN))
	};
	return pyDumps(semantic as unknown as Value);
}

/** The orders of the last 16 tables asked for, least recently used first out. */
export class TableOrderCache {
	private readonly entries = new Map<string, { stamp: OrderStamp; order: CachedOrder }>();

	/** The order kept under `key` at `stamp`; one kept at another stamp is dropped. */
	get(key: string, stamp: OrderStamp): CachedOrder | undefined {
		const hit = this.entries.get(key);
		if (hit === undefined) return undefined;
		this.entries.delete(key);
		if (hit.stamp.rev !== stamp.rev || hit.stamp.stagedVersion !== stamp.stagedVersion) {
			return undefined;
		}
		this.entries.set(key, hit);
		return hit.order;
	}

	put(key: string, stamp: OrderStamp, order: CachedOrder): void {
		this.entries.delete(key);
		this.entries.set(key, { stamp: { rev: stamp.rev, stagedVersion: stamp.stagedVersion }, order });
		for (const oldest of this.entries.keys()) {
			if (this.entries.size <= MAX_ENTRIES) break;
			this.entries.delete(oldest);
		}
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}
