/**
 * A table's row order, as `sort_keys`, `order_rows` and `_sort_value` of
 * `core/table/evaluate.py` give it, in steps. Keys apply last to first, one
 * stable pass each, so the first key ends up primary. Each pass sorts the
 * rows with a value and appends the empty ones in their order: empties last
 * in both directions. Descending negates the comparison, so equal rows keep
 * their order. A property's value leads with its shape (0 scalar, 1 element)
 * so one property element-typed on one type and scalar on another orders
 * without comparing the two.
 */
import type { Model } from '../model/model.ts';
import { displayName } from '../model/naming.ts';
import { PropertyValue, type Meter } from '../navigation/evaluate.ts';
import type { Steps } from '../steps/steps.ts';
import { pyCasefold } from '../value/casefold.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { pyStr } from '../value/repr.ts';
import { PyFloat, type Value } from '../value/types.ts';
import type { NavMemo } from './nav-memo.ts';
import {
	expandedPropertyIsElementTyped,
	expandSlotOf,
	navigationReached,
	propertyElementIds,
	resolveSourceElements,
	type Pass,
	type RowKey
} from './rows.ts';
import type { Column, TableDefinition } from './schema.ts';
import { propertyIsElementTyped, rawProperty } from './virtual-props.ts';

export type SortSpec = { column: number; direction: 'asc' | 'desc' };

/** A sort value as Python compares it: a number, a string, or a tuple of them. */
export type Comparable = number | string | readonly Comparable[];

/** `defn.sort` with out-of-range and repeated columns dropped, the first one winning. */
export function sortKeys(defn: TableDefinition): SortSpec[] {
	const n = defn.columns.length;
	const seen = new Set<number>();
	const out: SortSpec[] = [];
	for (const { column, direction } of defn.sort) {
		if (!(column >= 0 && column < n) || seen.has(column)) continue;
		seen.add(column);
		out.push({ column, direction });
	}
	return out;
}

const kindOf = (value: Comparable) =>
	typeof value === 'number' ? 'float' : typeof value === 'string' ? 'str' : 'tuple';

/**
 * Python's ordering of two sort values: numbers by value, strings by code
 * point, tuples item by item with a prefix first. Two kinds never meet.
 */
export function pyCompare(a: Comparable, b: Comparable): number {
	if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
	if (typeof a === 'string' && typeof b === 'string') return cmpCodePoint(a, b);
	if (typeof a === 'object' && typeof b === 'object') {
		const n = Math.min(a.length, b.length);
		for (let i = 0; i < n; i++) {
			const c = pyCompare(a[i]!, b[i]!);
			if (c !== 0) return c;
		}
		return a.length - b.length;
	}
	throw new Error(`'<' not supported between instances of '${kindOf(a)}' and '${kindOf(b)}'`);
}

/** Python's `float()` of an int: rounded to nearest, too large refused. */
function floatOfInt(value: bigint): number {
	const n = Number(value);
	if (!Number.isFinite(n)) throw new Error('int too large to convert to float');
	return n;
}

const label = (model: Model, id: string): string => pyCasefold(displayName(model.getElement(id)));

/** One comparable atom: numbers and booleans first, then strings, then element ids. */
function atom(model: Model, item: Value): Comparable {
	if (typeof item === 'boolean') return [0, item ? 1 : 0, ''];
	if (typeof item === 'number') return [0, item, ''];
	if (typeof item === 'bigint') return [0, floatOfInt(item), ''];
	if (item instanceof PyFloat) return [0, item.value, ''];
	if (typeof item === 'string' && model.findElement(item) !== undefined) {
		return [2, 0, label(model, item) + '\0' + item];
	}
	return [1, 0, pyCasefold(pyStr(item))];
}

/** One row's value for `col`, or `null` when it sorts with the empties. */
function* sortValue(pass: Pass, key: RowKey, col: Column, index: number): Steps<Comparable | null> {
	const { model, defn, baseSlots } = pass;
	if (col.kind === 'element') {
		const ids = yield* resolveSourceElements(pass, key, col.source);
		return ids.length === 0 ? null : [label(model, ids[0]!), ids[0]!];
	}
	if (col.kind === 'property') {
		if (col.mode === 'expand') {
			const v = key[expandSlotOf(defn, baseSlots, index)]!;
			if (v === null) return null;
			if (
				typeof v === 'string' &&
				model.findElement(v) !== undefined &&
				(yield* expandedPropertyIsElementTyped(pass, key, col))
			) {
				return [1, [label(model, v), v]];
			}
			return [0, [atom(model, v instanceof PropertyValue ? v.value : v)]];
		}
		const owners = yield* resolveSourceElements(pass, key, col.source);
		if (
			owners.some((id) => propertyIsElementTyped(pass.mm, model.getElement(id).typeName, col.name))
		) {
			// Element references order by the labels the grid shows, never by id.
			const ids = propertyElementIds(pass, col, owners);
			if (ids.length === 0) return null;
			return [1, ids.map((id) => label(model, id)).sort(cmpCodePoint)];
		}
		const values: Value[] = [];
		for (const id of owners) {
			const v = rawProperty(model.getElement(id), col.name);
			if (v === undefined || v === null) continue;
			if (Array.isArray(v)) values.push(...v);
			else values.push(v);
		}
		if (values.length === 0) return null;
		return [0, values.map((v) => atom(model, v))];
	}
	if (col.kind === 'script') {
		// No snippet runs here: only an expand column's promoted slot has a value.
		if (col.mode !== 'expand') return null;
		const b = key[expandSlotOf(defn, baseSlots, index)];
		if (b instanceof PropertyValue) return [atom(model, b.value)];
		if (typeof b === 'string') return [atom(model, b)];
		return null;
	}
	if (col.mode === 'expand') {
		const b = key[expandSlotOf(defn, baseSlots, index)];
		if (b instanceof PropertyValue) return [pyCasefold(pyStr(b.value)), ''];
		if (typeof b !== 'string') return null;
		return [label(model, b), b];
	}
	const roots = yield* resolveSourceElements(pass, key, col.source);
	const [reached] = yield* navigationReached(pass, col, roots);
	if (reached.length === 0) return null;
	if (col.sort_mode === 'count') return reached.length;
	return reached
		.map((node) => (typeof node === 'string' ? label(model, node) : pyCasefold(pyStr(node.value))))
		.sort(cmpCodePoint);
}

type Decorated = { value: Comparable; key: RowKey };

/** `keys` in the order `defn.sort` gives them; `baseSlots` is the build's. */
export function* orderRowsSteps(
	model: Model,
	defn: TableDefinition,
	keys: readonly RowKey[],
	baseSlots: number,
	meter: Meter,
	memo: NavMemo | null
): Steps<RowKey[]> {
	const sort = sortKeys(defn);
	let ordered = [...keys];
	if (sort.length === 0) return ordered;
	const pass: Pass = { model, mm: model.metamodel, defn, baseSlots, meter, memo };
	for (const { column, direction } of sort.reverse()) {
		const col = defn.columns[column]!;
		const valued: Decorated[] = [];
		const empty: RowKey[] = [];
		for (const key of ordered) {
			const value = yield* sortValue(pass, key, col, column);
			if (value === null) empty.push(key);
			else valued.push({ value, key });
			if (meter.tick()) yield meter.end();
		}
		const compare =
			direction === 'desc'
				? (a: Decorated, b: Decorated) => pyCompare(b.value, a.value)
				: (a: Decorated, b: Decorated) => pyCompare(a.value, b.value);
		const sorted = yield* meter.sort(valued, compare);
		ordered = [...sorted.map((d) => d.key), ...empty];
	}
	return ordered;
}
