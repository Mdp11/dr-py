/**
 * A table's rows, as `build_rows_ex` and `resolve_source_elements` of
 * `core/table/evaluate.py` build them, in steps. A row key holds the row
 * source's slots, then one slot per expand column: an element id, a raw
 * property value, a navigation's value terminal, or `null` for a row kept
 * empty. Every definition here is resolved (no navigation ref) and reaches no
 * script, so a script column is always unconfigured or never evaluated.
 */
import type { Metamodel } from '../metamodel/metamodel.ts';
import type { Model } from '../model/model.ts';
import {
	DEFAULT_LIMITS,
	evaluateSteps,
	Meter,
	NavValueError,
	PropertyValue,
	scopeSteps,
	type ChainNode
} from '../navigation/evaluate.ts';
import type { Steps } from '../steps/steps.ts';
import { PyFloat, type Value } from '../value/types.ts';
import type { MemoEntry, NavMemo } from './nav-memo.ts';
import type {
	ColumnSource,
	NavigationColumn,
	PropertyColumn,
	ScriptColumn,
	TableDefinition
} from './schema.ts';
import { propertyIsElementTyped, rawProperty } from './virtual-props.ts';

export type TableLimits = { maxRows: number; maxCellElements: number };

/** The route's limits: 50,000 rows, 20 elements a cell. */
export const DEFAULT_TABLE_LIMITS: TableLimits = { maxRows: 50_000, maxCellElements: 20 };

/** One slot of a row key. */
export type Binding = Value | PropertyValue;

export type RowKey = readonly Binding[];

/**
 * The rows, whether any are missing (the cap, or a navigation's own budget),
 * the row source's count before columns split or dropped any, and the row
 * source's slots at the head of every key.
 */
export type RowBuild = { keys: RowKey[]; truncated: boolean; baseTotal: number; baseSlots: number };

/** What one pass over the rows reads: the model, the definition, the key's layout, the meter and memo. */
export type Pass = {
	model: Model;
	mm: Metamodel;
	defn: TableDefinition;
	baseSlots: number;
	meter: Meter;
	memo: NavMemo | null;
};

type Reached = ChainNode[];

/** Python's `seq[i]`, a negative index counting from the end. */
const at = <T>(items: readonly T[], i: number): T => items[i < 0 ? items.length + i : i]!;

/** A step index out of a chain's range is the core's `ValueError`. */
function checkStepIndex(i: number, length: number): void {
	if (!(-length <= i && i < length)) {
		throw new NavValueError(`step_index ${i} out of range for a chain of ${length} steps`);
	}
}

/** A node's identity: an element by id, a value by type and value. */
const nodeKey = (node: ChainNode): string =>
	typeof node === 'string' ? 'e' + node : 'v' + node.key;

const sameNode = (a: ChainNode, b: ChainNode): boolean => nodeKey(a) === nodeKey(b);

const expandSlots = new WeakMap<TableDefinition, number[]>();

/**
 * The key slot of the expand column at `index`: the row source's slots plus
 * the expand columns before it. It holds for a key still being built, since a
 * source only names earlier columns.
 */
export function expandSlotOf(defn: TableDefinition, baseSlots: number, index: number): number {
	let before = expandSlots.get(defn);
	if (before === undefined) {
		before = [];
		let count = 0;
		for (const col of defn.columns) {
			before.push(count);
			if (col.kind !== 'element' && col.mode === 'expand') count++;
		}
		expandSlots.set(defn, before);
	}
	return baseSlots + before[index]!;
}

// -- navigations -----------------------------------------------------------------

/** `col`'s chains from `roots`, through the pass's memo unless its navigation may run a snippet. */
function* navigate(pass: Pass, col: NavigationColumn, roots: readonly string[]): Steps<MemoEntry> {
	const { mm, model, meter, memo } = pass;
	const defn = col.navigation.definition!;
	if (memo === null || memo.scripted(col)) {
		return yield* evaluateSteps(mm, model, defn, DEFAULT_LIMITS, roots, meter);
	}
	const key = memo.key(col, roots);
	const hit = memo.get(key);
	if (hit !== undefined) return hit;
	const result = yield* evaluateSteps(mm, model, defn, DEFAULT_LIMITS, roots, meter);
	const entry: MemoEntry = { chains: result.chains, truncated: result.truncated };
	memo.put(key, entry);
	return entry;
}

/**
 * The nodes `col` reaches from `roots` at its step, first seen first, and
 * whether its navigation was cut short. An element reached twice is one node;
 * a value is one per owner, so equal values of two elements are two nodes.
 */
export function* navigationReached(
	pass: Pass,
	col: NavigationColumn,
	roots: readonly string[]
): Steps<[Reached, boolean]> {
	if (col.navigation.definition === null || roots.length === 0) return [[], false];
	const { chains, truncated } = yield* navigate(pass, col, roots);
	const i = col.step_index ?? -1;
	const seen = new Map<string, ChainNode>();
	for (const chain of chains) {
		checkStepIndex(i, chain.length);
		const node = at(chain, i);
		const key =
			typeof node === 'string' ? 'e' + node : 'v' + JSON.stringify([at(chain, i - 1), node.key]);
		if (!seen.has(key)) seen.set(key, node);
		if (pass.meter.tick()) yield pass.meter.end();
	}
	return [[...seen.values()], truncated];
}

/**
 * The elements at chain step `step` of `col`'s navigation from `roots`; with
 * `match`, only chains whose own projection is that node count.
 */
function* navigationStepElements(
	pass: Pass,
	col: NavigationColumn,
	roots: readonly string[],
	step: number,
	match: ChainNode | null
): Steps<string[]> {
	if (col.navigation.definition === null || roots.length === 0) return [];
	const { chains } = yield* navigate(pass, col, roots);
	const projected = col.step_index ?? -1;
	const seen = new Set<string>();
	for (const chain of chains) {
		checkStepIndex(step, chain.length);
		if (pass.meter.tick()) yield pass.meter.end();
		if (match !== null) {
			checkStepIndex(projected, chain.length);
			if (!sameNode(at(chain, projected), match)) continue;
		}
		const node = at(chain, step);
		if (typeof node === 'string') seen.add(node);
	}
	return [...seen];
}

// -- properties ------------------------------------------------------------------

/**
 * The ids in a property value that name model elements, first seen first. A
 * list or dict among the items is refused as Python's `dict.fromkeys` refuses
 * an unhashable one.
 */
export function elementIds(model: Model, raw: Value): string[] {
	const items = Array.isArray(raw) ? raw : [raw];
	for (const item of items) {
		if (typeof item === 'object' && item !== null && !(item instanceof PyFloat)) {
			throw new Error(`unhashable type: '${Array.isArray(item) ? 'list' : 'dict'}'`);
		}
	}
	const out = new Set<string>();
	for (const item of items) {
		if (typeof item === 'string' && model.findElement(item) !== undefined) out.add(item);
	}
	return [...out];
}

/**
 * The element ids an element-typed property holds over `owners`, first seen
 * first; an owner whose type declares it otherwise contributes nothing.
 */
export function propertyElementIds(
	pass: Pass,
	col: PropertyColumn,
	owners: readonly string[]
): string[] {
	const { mm, model } = pass;
	const out = new Set<string>();
	for (const id of owners) {
		const element = model.getElement(id);
		if (!propertyIsElementTyped(mm, element.typeName, col.name)) continue;
		const raw = rawProperty(element, col.name);
		const items = Array.isArray(raw) ? raw : [raw];
		for (const item of items) {
			if (typeof item === 'string' && model.findElement(item) !== undefined) out.add(item);
		}
	}
	return [...out];
}

/** Whether an expand property column's row holds an element: its property is element-typed on a source element. */
export function* expandedPropertyIsElementTyped(
	pass: Pass,
	key: RowKey,
	col: PropertyColumn
): Steps<boolean> {
	const owners = yield* resolveSourceElements(pass, key, col.source);
	return owners.some((id) =>
		propertyIsElementTyped(pass.mm, pass.model.getElement(id).typeName, col.name)
	);
}

/**
 * What an expand property column contributes for one row's roots: one
 * binding per value, in root order, lists flattened; element references keep
 * only ids that name elements.
 */
export function expandPropertyValues(
	pass: Pass,
	col: PropertyColumn,
	roots: readonly string[]
): Binding[] {
	const { mm, model } = pass;
	const out: Binding[] = [];
	for (const id of roots) {
		const element = model.getElement(id);
		const raw = rawProperty(element, col.name);
		if (raw === undefined || raw === null) continue;
		if (propertyIsElementTyped(mm, element.typeName, col.name)) out.push(...elementIds(model, raw));
		else if (Array.isArray(raw)) out.push(...raw);
		else out.push(raw);
	}
	return out;
}

// -- sources ---------------------------------------------------------------------

/**
 * The element ids a column source resolves to for one row. A row slot reads
 * its key slot; a ref to an expand column reads that column's slot; a ref
 * with a step index re-navigates the referenced column's own source; a ref to
 * a collapse column evaluates it again from its source.
 */
export function* resolveSourceElements(
	pass: Pass,
	key: RowKey,
	source: ColumnSource
): Steps<string[]> {
	const { model, defn, baseSlots } = pass;
	if (source.kind === 'row') {
		if (source.chain_index >= baseSlots) {
			throw new NavValueError(
				`chain_index ${source.chain_index} out of range (row source has ${baseSlots} slots)`
			);
		}
		const b = key[source.chain_index];
		return typeof b === 'string' ? [b] : [];
	}
	const ref = defn.columns[source.index]!;
	if (ref.kind === 'navigation' && source.step_index !== null) {
		const roots = yield* resolveSourceElements(pass, key, ref.source);
		let match: ChainNode | null = null;
		if (ref.mode === 'expand') {
			const b = key[expandSlotOf(defn, baseSlots, source.index)];
			// A row kept empty reached nothing.
			if (!(typeof b === 'string' || b instanceof PropertyValue)) return [];
			match = b;
		}
		return yield* navigationStepElements(pass, ref, roots, source.step_index, match);
	}
	if (ref.kind !== 'element' && ref.mode === 'expand') {
		const b = key[expandSlotOf(defn, baseSlots, source.index)];
		if (ref.kind === 'property') {
			// A property slot holds a raw value: only an element-typed one's id binds.
			if (!(typeof b === 'string' && model.findElement(b) !== undefined)) return [];
			return (yield* expandedPropertyIsElementTyped(pass, key, ref)) ? [b] : [];
		}
		return typeof b === 'string' ? [b] : [];
	}
	switch (ref.kind) {
		case 'element':
			return yield* resolveSourceElements(pass, key, ref.source);
		case 'navigation': {
			const roots = yield* resolveSourceElements(pass, key, ref.source);
			const [reached] = yield* navigationReached(pass, ref, roots);
			return reached.filter((node): node is string => typeof node === 'string');
		}
		case 'property': {
			const owners = yield* resolveSourceElements(pass, key, ref.source);
			return propertyElementIds(pass, ref, owners);
		}
		case 'script':
			// No snippet runs here: a script column binds nothing.
			return [];
	}
}

// -- the build -------------------------------------------------------------------

function* baseRowKeys(pass: Pass): Steps<[RowKey[], boolean]> {
	const { mm, model, defn, meter } = pass;
	const rs = defn.row_source;
	if (rs.kind === 'scope') {
		const ids = yield* scopeSteps(
			mm,
			model,
			{ kind: 'scope', types: rs.types, criteria: rs.criteria },
			meter
		);
		return [ids.map((id) => [id]), false];
	}
	const nav = rs.navigation.definition;
	if (nav === null) return [[], false];
	const result = yield* evaluateSteps(mm, model, nav, DEFAULT_LIMITS, null, meter);
	if (rs.kind === 'navigation') {
		// A value at the projected step seeds no row.
		const i = rs.step_index ?? -1;
		const seen = new Set<string>();
		for (const chain of result.chains) {
			checkStepIndex(i, chain.length);
			const node = at(chain, i);
			if (typeof node === 'string') seen.add(node);
			if (meter.tick()) yield meter.end();
		}
		return [[...seen].map((id) => [id]), result.truncated];
	}
	let keys: RowKey[] = result.chains.map((chain) => [...chain]);
	if (rs.unique) {
		const first = new Map<string, RowKey>();
		for (const key of keys) {
			const terminal = nodeKey(key[key.length - 1] as ChainNode);
			if (!first.has(terminal)) first.set(terminal, key);
			if (meter.tick()) yield meter.end();
		}
		keys = [...first.values()];
	}
	return [keys, result.truncated];
}

/** Whether a collapse column's cell for one row would hold anything, and whether its navigation was cut short. */
function* collapseHasValue(
	pass: Pass,
	col: PropertyColumn | NavigationColumn | ScriptColumn,
	roots: readonly string[]
): Steps<[boolean, boolean]> {
	if (col.kind === 'script') {
		// A dangling ref's error cell stays; nothing else runs here.
		return [col.snippet.ref !== null, false];
	}
	if (col.kind === 'navigation') {
		const [reached, truncated] = yield* navigationReached(pass, col, roots);
		return [reached.length > 0, truncated];
	}
	for (const id of roots) {
		const raw = rawProperty(pass.model.getElement(id), col.name);
		if (raw === undefined || raw === null) continue;
		if (!Array.isArray(raw) || raw.length > 0) return [true, false];
	}
	return [false, false];
}

/** What an expand column contributes for one row, and whether its navigation was cut short. */
function* expandValues(
	pass: Pass,
	col: PropertyColumn | NavigationColumn | ScriptColumn,
	roots: readonly string[]
): Steps<[Binding[], boolean]> {
	if (col.kind === 'script') return [col.snippet.ref !== null ? [null] : [], false];
	if (col.kind === 'navigation') return yield* navigationReached(pass, col, roots);
	return [expandPropertyValues(pass, col, roots), false];
}

/**
 * Every row of `defn`, in build order. Columns apply in order: an expand
 * column adds a slot, one row per value (a `null` one when nothing is reached
 * and `keep_empty`); a collapse column without `keep_empty` drops the rows its
 * cell would leave empty. An expand column that passes `maxRows` keeps its
 * first `maxRows` rows and every later column still runs over them.
 */
export function* buildRowsSteps(
	model: Model,
	defn: TableDefinition,
	limits: TableLimits,
	meter: Meter,
	memo: NavMemo | null
): Steps<RowBuild> {
	const probe: Pass = { model, mm: model.metamodel, defn, baseSlots: 1, meter, memo };
	const [base, cut] = yield* baseRowKeys(probe);
	let keys = base;
	let truncated = cut;
	const baseTotal = keys.length;
	const baseSlots = defn.row_source.kind === 'chains' && keys.length > 0 ? keys[0]!.length : 1;
	const pass: Pass = { ...probe, baseSlots };
	for (const col of defn.columns) {
		if (col.kind === 'element') continue;
		if (col.mode !== 'expand') {
			if (col.keep_empty) continue;
			const kept: RowKey[] = [];
			for (const key of keys) {
				const roots = yield* resolveSourceElements(pass, key, col.source);
				const [hasValue, navCut] = yield* collapseHasValue(pass, col, roots);
				if (navCut) truncated = true;
				if (hasValue) kept.push(key);
				if (meter.tick()) yield meter.end();
			}
			keys = kept;
			continue;
		}
		const next: RowKey[] = [];
		for (const key of keys) {
			const roots = yield* resolveSourceElements(pass, key, col.source);
			const [reached, navCut] = yield* expandValues(pass, col, roots);
			if (navCut) truncated = true;
			if (reached.length === 0) {
				if (col.keep_empty) next.push([...key, null]);
			} else {
				for (const value of reached) {
					next.push([...key, value]);
					if (meter.tick()) yield meter.end();
				}
			}
			if (meter.tick()) yield meter.end();
			if (next.length > limits.maxRows) {
				truncated = true;
				next.length = limits.maxRows;
				break;
			}
		}
		keys = next;
	}
	if (keys.length > limits.maxRows) {
		keys = keys.slice(0, limits.maxRows);
		truncated = true;
	}
	return { keys, truncated, baseTotal, baseSlots };
}
