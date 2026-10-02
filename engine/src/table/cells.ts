/**
 * A table's cells, as `evaluate_cells` of `core/table/cells.py` evaluates them
 * and `POST /tables/evaluate` writes them: every field present, in the
 * route's order, an element as its tree row. Values stay exact here; the page
 * puts them on the wire. A collapse cell reads its column's source afresh; an
 * expand cell reads back the slot the build promoted into its row's key.
 */
import type { Model } from '../model/model.ts';
import { PropertyValue, type Meter } from '../navigation/evaluate.ts';
import { ReadError } from '../read/errors.ts';
import { treeItem, type TreeItem } from '../read/tree.ts';
import type { ValuePayload } from '../script/result.ts';
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
import {
	danglingRefMessage,
	evaluateScriptColumn,
	navigationDisplayValues,
	payloadElementIds,
	propertyInputValues,
	type TableScripts
} from './script-inputs.ts';
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

/** What a cell that nothing computed says, in the grid, the recap and the files. */
export const NOT_COMPUTED_MESSAGE = 'not computed';

/** One cell, as the route's `TableCellOut` carries it. */
export type TableCell = {
	kind: 'element' | 'value' | 'values' | 'elements' | 'error' | 'pending';
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

const blankCell = (kind: TableCell['kind']): TableCell => ({
	kind,
	item: null,
	ref_type: null,
	present: null,
	value: null,
	element_id: null,
	editable: null,
	items: null,
	values: null,
	total: null,
	truncated: null,
	message: null,
	traceback: null
});

/** A script cell whose call failed, or whose input did. */
const errorCell = (message: string, traceback: string | null): TableCell => ({
	...blankCell('error'),
	message,
	traceback
});

/** A script cell no fill has computed yet. */
const pendingCell = (): TableCell => blankCell('pending');

/** A slot's value; a value terminal's is the value it carries. */
const slotValue = (b: Binding): Value => (b instanceof PropertyValue ? b.value : b);

/** An id naming an element, else nothing. */
const elementRef = (model: Model, value: Value): string | null =>
	typeof value === 'string' && model.findElement(value) !== undefined ? value : null;

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
	const values = propertyInputValues(pass, col, owners);
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
		const values = navigationDisplayValues(model, reached);
		return valuesCell(values.slice(0, cap), values.length, values.length > cap);
	}
	const ids = reached as string[];
	return elementsCell(model, ids.slice(0, cap), ids.length, ids.length > cap);
}

/** The cell of a failed or pending call. */
const failedCell = (error: {
	kind: string;
	message: string;
	traceback: string | null;
}): TableCell =>
	error.kind === 'pending' ? pendingCell() : errorCell(error.message, error.traceback);

/**
 * A script column's cell. An expand cell reads back the binding the build
 * promoted into its slot; an empty slot is a row kept empty, or a call that
 * failed or is pending, which the call tells apart. A collapse cell asks its
 * snippet afresh: the pass's scripts answer from what the evaluation already
 * holds, so it agrees with any call the build made over the same roots.
 */
function* scriptCell(
	pass: Pass,
	key: RowKey,
	col: ScriptColumn,
	index: number,
	limits: TableLimits
): Steps<TableCell> {
	const { model, defn, baseSlots } = pass;
	if (col.mode === 'expand') {
		const b = key[expandSlotOf(defn, baseSlots, index)];
		if (b instanceof PropertyValue) return valueCell(true, b.value, null, false);
		if (typeof b === 'string') return elementCell(model, b);
		if (col.snippet.ref !== null) return errorCell(danglingRefMessage(col.snippet.ref), null);
		if (col.snippet.definition !== null && pass.scripts !== null) {
			const roots = yield* resolveSourceElements(pass, key, col.source);
			if (roots.length > 0) {
				const result = yield* evaluateScriptColumn(pass, key, col, roots);
				if (result.error !== null) return failedCell(result.error);
			}
		}
		return emptyValueCell();
	}
	if (col.snippet.ref !== null) return errorCell(danglingRefMessage(col.snippet.ref), null);
	if (col.snippet.definition === null) return emptyValueCell();
	const roots = yield* resolveSourceElements(pass, key, col.source);
	if (roots.length === 0) return emptyValueCell();
	// Only an evaluation without scripts reaches here, and it refused before its first step.
	if (pass.scripts === null) throw new ReadError(501, 'reaches a script');
	const result = yield* evaluateScriptColumn(pass, key, col, roots);
	if (result.error !== null) return failedCell(result.error);
	const payload = result.payload as ValuePayload;
	const cap = limits.maxCellElements;
	if (payload.kind === 'scalar') {
		return payload.value === null ? emptyValueCell() : valueCell(true, payload.value, null, false);
	}
	if (payload.kind === 'scalars') {
		const { values } = payload;
		return valuesCell(values.slice(0, cap), values.length, values.length > cap);
	}
	if (payload.kind === 'element') {
		return elementCell(model, model.findElement(payload.id) === undefined ? null : payload.id);
	}
	const ids = payloadElementIds(model, payload);
	return elementsCell(model, ids.slice(0, cap), ids.length, ids.length > cap);
}

/**
 * The cells of `keys`, a row of cells per key, over a resolved definition.
 * `baseSlots` is the build's; `memo` is this pass's own; a definition that
 * reaches a script is read through `scripts`.
 */
export function* evaluateCellsSteps(
	model: Model,
	defn: TableDefinition,
	keys: readonly RowKey[],
	baseSlots: number,
	limits: TableLimits,
	meter: Meter,
	memo: NavMemo | null,
	scripts: TableScripts | null = null
): Steps<TableCell[][]> {
	const pass: Pass = { model, mm: model.metamodel, defn, baseSlots, meter, memo, scripts };
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
					row.push(yield* scriptCell(pass, key, col, index, limits));
					break;
			}
			if (meter.tick()) yield meter.end();
		}
		rows.push(row);
	}
	return rows;
}
