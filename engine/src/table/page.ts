/**
 * A page of a table as `POST /tables/evaluate` answers it (`TablePageOut`),
 * its fields in the route's order. Values leave through `toWire`; a value
 * terminal in a row key leaves as `{"value": …}`.
 */
import { PropertyValue } from '../navigation/evaluate.ts';
import { toWire, type Wire } from '../read/wire.ts';
import type { TableCell } from './cells.ts';
import type { Binding, RowKey } from './rows.ts';
import type { TableDefinition } from './schema.ts';

export type TableColumnBody = { kind: string; header: string; width_px: number | null };

/** A cell on the wire. */
export type TableCellBody = Omit<TableCell, 'value' | 'values'> & {
	value: Wire;
	values: Wire[] | null;
};

export type TableRowBody = { key: Wire[]; cells: TableCellBody[] };

/** `warnings` and `script_status` concern scripts, which never reach the engine. */
export type TablePageBody = {
	columns: TableColumnBody[];
	rows: TableRowBody[];
	total: number;
	base_total: number;
	truncated: boolean;
	offset: number;
	model_rev: number;
	warnings: [];
	script_status: null;
};

const wireSlot = (b: Binding): Wire =>
	b instanceof PropertyValue ? { value: toWire(b.value) } : toWire(b);

export const wireKey = (key: RowKey): Wire[] => key.map(wireSlot);

export function wireCell(cell: TableCell): TableCellBody {
	return {
		kind: cell.kind,
		item: cell.item,
		ref_type: cell.ref_type,
		present: cell.present,
		value: toWire(cell.value),
		element_id: cell.element_id,
		editable: cell.editable,
		items: cell.items,
		values: cell.values === null ? null : cell.values.map(toWire),
		total: cell.total,
		truncated: cell.truncated,
		message: cell.message,
		traceback: cell.traceback
	};
}

export type PageOf = {
	keys: readonly RowKey[];
	cells: readonly TableCell[][];
	total: number;
	baseTotal: number;
	truncated: boolean;
	offset: number;
	rev: number;
};

/** The body of one page: the columns as `defn` asks for them, the rows with their cells. */
export function pageBody(defn: TableDefinition, page: PageOf): TablePageBody {
	return {
		columns: defn.columns.map((col) => ({
			kind: col.kind,
			header: col.header,
			width_px: col.width_px
		})),
		rows: page.keys.map((key, i) => ({ key: wireKey(key), cells: page.cells[i]!.map(wireCell) })),
		total: page.total,
		base_total: page.baseTotal,
		truncated: page.truncated,
		offset: page.offset,
		model_rev: page.rev,
		warnings: [],
		script_status: null
	};
}
