/**
 * A table's row order, as `sort_keys`, `order_rows` and `_sort_value` of
 * `core/table/evaluate.py` give it, in steps. Keys apply last to first, one
 * stable pass each, so the first key ends up primary. Each pass sorts the
 * rows with a value and appends the empty ones in their order: empties last
 * in both directions. Descending negates the comparison, so equal rows keep
 * their order. A property's value leads with its shape (0 scalar, 1 element)
 * so one property element-typed on one type and scalar on another orders
 * without comparing the two.
 *
 * A script column sorts by what its call returns. A key whose value would take a
 * navigation's script step, which no fill computes for a sort, is not driven:
 * the step prunes, every row ties, and the order is the build's, with a warning.
 */
import type { Model } from '../model/model.ts';
import { displayName } from '../model/naming.ts';
import { PropertyValue, type Meter } from '../navigation/evaluate.ts';
import { navigationHasScript } from '../navigation/resolve.ts';
import type { ValuePayload } from '../script/result.ts';
import type { Steps } from '../steps/steps.ts';
import { pyCasefold } from '../value/casefold.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { pyStr } from '../value/repr.ts';
import { PyFloat, type Value } from '../value/types.ts';
import type { NavMemo } from './nav-memo.ts';
import { evaluateScriptColumn, type TableScripts } from './script-inputs.ts';
import {
	expandedPropertyIsElementTyped,
	expandSlotOf,
	navigationReached,
	propertyElementIds,
	resolveSourceElements,
	type Pass,
	type RowKey
} from './rows.ts';
import type { Column, ColumnSource, NavigationColumn, TableDefinition } from './schema.ts';
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
		if (col.mode === 'expand') {
			const b = key[expandSlotOf(defn, baseSlots, index)];
			if (b instanceof PropertyValue) return [atom(model, b.value)];
			if (typeof b === 'string') return [atom(model, b)];
			return null; // a row kept empty, a failed call, or a pending one
		}
		if (col.snippet.definition === null || pass.scripts === null) return null;
		const els = yield* resolveSourceElements(pass, key, col.source);
		if (els.length === 0) return null;
		const result = yield* evaluateScriptColumn(pass, key, col, els);
		if (result.error !== null) return null; // failed and pending sort with the empties
		const payload = result.payload as ValuePayload;
		if (payload.kind === 'scalar') {
			return payload.value === null ? null : [atom(model, payload.value)];
		}
		if (payload.kind === 'scalars') {
			const values = payload.values.filter((v) => v !== null);
			return values.length === 0 ? null : values.map((v) => atom(model, v));
		}
		if (payload.kind === 'element') {
			return model.findElement(payload.id) === undefined ? null : [atom(model, payload.id)];
		}
		const atoms = payload.ids
			.filter((id) => model.findElement(id) !== undefined)
			.map((id) => atom(model, id))
			.sort(pyCompare);
		return atoms.length === 0 ? null : atoms;
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

// -- sorts a script cannot fill -------------------------------------------------------

const navigationScripted = (col: NavigationColumn): boolean =>
	col.navigation.definition !== null && navigationHasScript(col.navigation.definition);

/**
 * Whether resolving `source` evaluates a navigation holding a script step.
 * Mirrors `resolveSourceElements` branch for branch: a row slot and an expand
 * reference read a key slot and evaluate nothing; a collapse script column
 * ends the walk, since the fill resolves its source for every row it computes,
 * which fills every step underneath it.
 */
function sourceReachesScriptNavigation(defn: TableDefinition, source: ColumnSource): boolean {
	if (source.kind === 'row') return false;
	const ref = defn.columns[source.index]!;
	if (ref.kind === 'navigation' && source.step_index !== null) {
		return navigationScripted(ref) || sourceReachesScriptNavigation(defn, ref.source);
	}
	if (ref.kind !== 'element' && ref.mode === 'expand') return false;
	if (ref.kind === 'script') return false;
	if (ref.kind === 'navigation') {
		return navigationScripted(ref) || sourceReachesScriptNavigation(defn, ref.source);
	}
	return sourceReachesScriptNavigation(defn, ref.source);
}

/** Whether computing `col`'s sort value evaluates a navigation holding a script step that nothing fills. */
function sortReachesScriptNavigation(defn: TableDefinition, col: Column): boolean {
	if (col.kind === 'element') return sourceReachesScriptNavigation(defn, col.source);
	if (col.mode === 'expand' || col.kind === 'script') return false;
	if (col.kind === 'navigation') {
		return navigationScripted(col) || sourceReachesScriptNavigation(defn, col.source);
	}
	return sourceReachesScriptNavigation(defn, col.source);
}

/**
 * Whether any of `sort` falls back to the build order. It reads the definition
 * alone, so a served order that was kept can tell it again.
 */
export function sortFallsBackToBuildOrder(
	defn: TableDefinition,
	sort: readonly SortSpec[]
): boolean {
	return sort.some((spec) => sortReachesScriptNavigation(defn, defn.columns[spec.column]!));
}

/**
 * The scripts the pass for `col` may drive: `scripts`, or `null` for the key
 * that falls back to the build order, which warns once per key.
 */
function sortScripts(
	defn: TableDefinition,
	col: Column,
	scripts: TableScripts | null
): TableScripts | null {
	if (scripts === null || !sortReachesScriptNavigation(defn, col)) return scripts;
	scripts.warnings.add('sort_needs_script_nav');
	return null;
}

type Decorated = { value: Comparable; key: RowKey };

/** `keys` in the order `defn.sort` gives them; `baseSlots` is the build's. */
export function* orderRowsSteps(
	model: Model,
	defn: TableDefinition,
	keys: readonly RowKey[],
	baseSlots: number,
	meter: Meter,
	memo: NavMemo | null,
	scripts: TableScripts | null = null
): Steps<RowKey[]> {
	const sort = sortKeys(defn);
	let ordered = [...keys];
	if (sort.length === 0) return ordered;
	for (const { column, direction } of sort.reverse()) {
		const col = defn.columns[column]!;
		const pass: Pass = {
			model,
			mm: model.metamodel,
			defn,
			baseSlots,
			meter,
			memo,
			scripts: sortScripts(defn, col, scripts)
		};
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
