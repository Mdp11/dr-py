/**
 * A table's cells, as `evaluate_cells` of `core/table/cells.py` evaluates them
 * and `POST /tables/evaluate` writes them: every field present, in the
 * route's order, an element as its tree row. Values stay exact here; the page
 * puts them on the wire. A collapse cell reads its column's source afresh; an
 * expand cell reads back the slot the build promoted into its row's key.
 */
import type { Model } from '../model/model.ts';
import { displayName } from '../model/naming.ts';
import { PropertyValue, type Meter } from '../navigation/evaluate.ts';
import { treeItem, type TreeItem } from '../read/tree.ts';
import type { Steps } from '../steps/steps.ts';
import type { Value } from '../value/types.ts';
import type { NavMemo } from './nav-memo.ts';
import {
	elementIds,
	expandSlotOf,
	navigationReached,
	resolveSourceElements,
	type Binding,
	type Pass,
	type RowKey,
	type TableLimits
} from './rows.ts';
import type {
	ElementColumn,
	NavigationColumn,
	PropertyColumn,
	ScriptColumn,
	TableDefinition
} from './schema.ts';
import {
	isVirtualProperty,
	propertyDatatype,
	propertyDeclared,
	propertyIsElementTyped,
	rawProperty
} from './virtual-props.ts';

/** One cell, as the route's `TableCellOut` carries it. */
export type TableCell = {
	kind: 'element' | 'value' | 'values' | 'elements' | 'error';
	/** element: the element referred to. */
	item: TreeItem | null;
	/** element: the type an editable reference's picker offers. */
	ref_type: string | null;
	present: boolean | null;
	value: Value;
	/** value: the element holding it; element: the owner of the reference. */
	element_id: string | null;
	editable: boolean | null;
	items: TreeItem[] | null;
	values: Value[] | null;
	total: number | null;
	truncated: boolean | null;
	message: string | null;
	traceback: string | null;
};

function elementCell(
	model: Model,
	id: string | null,
	owner: string | null = null,
	editable = false,
	refType: string | null = null
): TableCell {
	return {
		kind: 'element',
		item: id === null ? null : treeItem(model, model.getElement(id)),
		ref_type: refType,
		present: null,
		value: null,
		element_id: owner,
		editable,
		items: null,
		values: null,
		total: null,
		truncated: null,
		message: null,
		traceback: null
	};
}

function valueCell(
	present: boolean,
	value: Value,
	elementId: string | null,
	editable: boolean
): TableCell {
	return {
		kind: 'value',
		item: null,
		ref_type: null,
		present,
		value,
		element_id: elementId,
		editable,
		items: null,
		values: null,
		total: null,
		truncated: null,
		message: null,
		traceback: null
	};
}

const emptyValueCell = (): TableCell => valueCell(false, null, null, false);

function valuesCell(values: Value[], total: number, truncated: boolean): TableCell {
	return {
		kind: 'values',
		item: null,
		ref_type: null,
		present: true,
		value: null,
		element_id: null,
		editable: null,
		items: null,
		values,
		total,
		truncated,
		message: null,
		traceback: null
	};
}

function elementsCell(model: Model, ids: string[], total: number, truncated: boolean): TableCell {
	return {
		kind: 'elements',
		item: null,
		ref_type: null,
		present: null,
		value: null,
		element_id: null,
		editable: null,
		items: ids.map((id) => treeItem(model, model.getElement(id))),
		values: null,
		total,
		truncated,
		message: null,
		traceback: null
	};
}

/** A slot's value; a value terminal's is the value it carries. */
const slotValue = (b: Binding): Value => (b instanceof PropertyValue ? b.value : b);

/** An id naming an element, else nothing. */
const elementRef = (model: Model, value: Value): string | null =>
	typeof value === 'string' && model.findElement(value) !== undefined ? value : null;

/**
 * What a collapse property column holds over `owners`: lists flattened,
 * `null` skipped, an owner whose type does not declare it contributing nothing.
 */
function propertyValues(pass: Pass, col: PropertyColumn, owners: readonly string[]): Value[] {
	const values: Value[] = [];
	for (const id of owners) {
		const element = pass.model.getElement(id);
		if (!propertyDeclared(pass.mm, element.typeName, col.name)) continue;
		const v = rawProperty(element, col.name);
		if (Array.isArray(v)) values.push(...v);
		else if (v !== undefined && v !== null) values.push(v);
	}
	return values;
}

function* elementColumnCell(pass: Pass, key: RowKey, col: ElementColumn): Steps<TableCell> {
	const ids = yield* resolveSourceElements(pass, key, col.source);
	return elementCell(pass.model, ids[0] ?? null);
}

/**
 * An element-typed property on any source element renders its ids as
 * elements, dropping the scalars other types hold under the same name. One
 * source element's value is editable where its type declares the property.
 */
function* propertyCell(
	pass: Pass,
	key: RowKey,
	col: PropertyColumn,
	index: number
): Steps<TableCell> {
	const { model, mm, defn, baseSlots } = pass;
	const owners = yield* resolveSourceElements(pass, key, col.source);
	const elementTyped = owners.some((id) =>
		propertyIsElementTyped(mm, model.getElement(id).typeName, col.name)
	);
	if (col.mode === 'expand') {
		const value = slotValue(key[expandSlotOf(defn, baseSlots, index)]!);
		// A value of many source elements has no one owner.
		const owner = owners.length === 1 ? owners[0]! : null;
		if (elementTyped) return elementCell(model, elementRef(model, value), owner, false);
		const present = owners.some((id) =>
			propertyDeclared(mm, model.getElement(id).typeName, col.name)
		);
		return valueCell(present, value, owner, false);
	}
	if (owners.length === 0) return emptyValueCell();
	if (owners.length === 1) {
		const id = owners[0]!;
		const element = model.getElement(id);
		const present = propertyDeclared(mm, element.typeName, col.name);
		const value = present ? (rawProperty(element, col.name) ?? null) : null;
		if (elementTyped && !Array.isArray(value)) {
			const refType = propertyDatatype(mm, element.typeName, col.name);
			return elementCell(model, elementRef(model, value), id, true, refType);
		}
		if (elementTyped) {
			const ids = elementIds(model, value);
			return elementsCell(model, ids, ids.length, false);
		}
		return valueCell(present, value, id, present && !isVirtualProperty(col.name));
	}
	const values = propertyValues(pass, col, owners);
	if (elementTyped) {
		const ids = elementIds(model, values);
		return elementsCell(model, ids, ids.length, false);
	}
	return valuesCell(values, values.length, false);
}

/**
 * A collapse navigation cell shows at most `min(cell_cap, maxCellElements)`
 * of what it reaches, or `maxCellElements` when the limits ignore cell caps,
 * `total` counting them all. A value anywhere makes it a values cell, an
 * element among values showing as its name.
 */
function* navigationCell(
	pass: Pass,
	key: RowKey,
	col: NavigationColumn,
	index: number,
	limits: TableLimits
): Steps<TableCell> {
	const { model, defn, baseSlots } = pass;
	if (col.mode === 'expand') {
		const b = key[expandSlotOf(defn, baseSlots, index)];
		if (b instanceof PropertyValue) return valueCell(true, b.value, null, false);
		return elementCell(model, typeof b === 'string' ? b : null);
	}
	const roots = yield* resolveSourceElements(pass, key, col.source);
	const [reached] = yield* navigationReached(pass, col, roots);
	const cap =
		limits.ignoreCellCaps === true
			? limits.maxCellElements
			: Math.min(col.cell_cap, limits.maxCellElements);
	if (reached.some((node) => node instanceof PropertyValue)) {
		const values = reached.map((node) =>
			typeof node === 'string' ? displayName(model.getElement(node)) : node.value
		);
		return valuesCell(values.slice(0, cap), values.length, values.length > cap);
	}
	const ids = reached as string[];
	return elementsCell(model, ids.slice(0, cap), ids.length, ids.length > cap);
}

/** A script column here runs no snippet: a configured one reaches a script and is refused before any cell. */
function scriptCell(pass: Pass, key: RowKey, col: ScriptColumn, index: number): TableCell {
	if (col.snippet.ref !== null || col.snippet.definition !== null) {
		throw new Error('a script column with a snippet is evaluated on the server');
	}
	if (col.mode === 'expand') {
		const b = key[expandSlotOf(pass.defn, pass.baseSlots, index)];
		if (b instanceof PropertyValue) return valueCell(true, b.value, null, false);
		if (typeof b === 'string') return elementCell(pass.model, b);
	}
	return emptyValueCell();
}

/**
 * The cells of `keys`, a row of cells per key, over a definition resolved and
 * reaching no script. `baseSlots` is the build's; `memo` is this pass's own.
 */
export function* evaluateCellsSteps(
	model: Model,
	defn: TableDefinition,
	keys: readonly RowKey[],
	baseSlots: number,
	limits: TableLimits,
	meter: Meter,
	memo: NavMemo | null
): Steps<TableCell[][]> {
	const pass: Pass = { model, mm: model.metamodel, defn, baseSlots, meter, memo };
	const rows: TableCell[][] = [];
	for (const key of keys) {
		const row: TableCell[] = [];
		for (const [index, col] of defn.columns.entries()) {
			switch (col.kind) {
				case 'element':
					row.push(yield* elementColumnCell(pass, key, col));
					break;
				case 'property':
					row.push(yield* propertyCell(pass, key, col, index));
					break;
				case 'navigation':
					row.push(yield* navigationCell(pass, key, col, index, limits));
					break;
				case 'script':
					row.push(scriptCell(pass, key, col, index));
					break;
			}
			if (meter.tick()) yield meter.end();
		}
		rows.push(row);
	}
	return rows;
}
