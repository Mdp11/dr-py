/**
 * The display value an export writes for a cell, as `core/table/cell_text.py`
 * renders it: an element as its name, a value as itself, several joined with
 * `"; "` through Python's `str()`.
 */
import type { Model } from '../model/model.ts';
import { displayName } from '../model/naming.ts';
import { pyStr } from '../value/repr.ts';
import type { Value } from '../value/types.ts';
import type { TableCell } from './cells.ts';

const nameOf = (model: Model, id: string): string => displayName(model.getElement(id));

export function cellText(model: Model, cell: TableCell): Value {
	switch (cell.kind) {
		case 'element':
			return cell.item === null ? '' : nameOf(model, cell.item.id);
		case 'value':
			return cell.present !== true || cell.value === null ? '' : cell.value;
		case 'values':
			return cell.values!.map(pyStr).join('; ');
		case 'error':
			return `#ERROR: ${cell.message}`;
		case 'elements':
			return cell.items!.map((item) => nameOf(model, item.id)).join('; ');
	}
}
