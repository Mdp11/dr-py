/**
 * The JSON writer of `core/table/json_export.py` and the document shaping of
 * `api/table_export_engine.py`: one object a row, or a bucket of rows when an
 * expand column groups, serialized as `json.dumps(ensure_ascii=False)` writes
 * it. Objects the writer builds are `Map`s, so a key that looks like an array
 * index keeps its place; rows and groups bucket on Python equality.
 */
import type { Model } from '../model/model.ts';
import { displayName } from '../model/naming.ts';
import { Meter, PropertyValue } from '../navigation/evaluate.ts';
import { ReadError } from '../read/errors.ts';
import { drain, type Steps } from '../steps/steps.ts';
import type { TableCell } from '../table/cells.ts';
import { expandSlotOf, type Binding, type RowKey } from '../table/rows.ts';
import type { Column, TableDefinition } from '../table/schema.ts';
import { pyKey } from '../value/key.ts';
import { pyRepr, pyStr } from '../value/repr.ts';
import { pyDumps } from '../value/serialize.ts';
import { PyFloat, type Value } from '../value/types.ts';
import { ROW_NUMBER_SLOT } from './layout.ts';

/** A value the writer emits: a model value, or an object or list it built. */
export type JsonOut = Value | JsonDoc | JsonOut[];

/** An object the writer built, its keys in insertion order. */
export type JsonDoc = Map<string, JsonOut>;

/** The JSON-family formats. */
export type JsonFormat = 'json' | 'jsonl';

/**
 * What `renderJsonEx` reads besides the rows: `order`, the layout's rank per
 * definition column (`null`: definition order); `rowNumber`, the row number's
 * position and key; `keyColumn`, the column that keys each document.
 */
export type JsonRenderOptions = {
	order: readonly number[] | null;
	rowNumber: readonly [number, string] | null;
	keyColumn: number | null;
};

// -- keys --------------------------------------------------------------------------

/**
 * One key a column, `null` for a hidden one: its `json_export.key`, else its
 * header, else `{kind}_{index}`; a later clash takes `_2`, `_3`, … over every
 * key taken so far.
 */
export function resolveJsonKeys(defn: TableDefinition): (string | null)[] {
	const used = new Set<string>();
	return defn.columns.map((col, i) => {
		if (col.hidden) return null;
		const base = (col.json_export?.key ?? '') || col.header || `${col.kind}_${i}`;
		let key = base;
		for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
		used.add(key);
		return key;
	});
}

/** Whether a column's `group` is acted on: set, on a visible expand column. */
const honorsGroup = (col: Column): boolean =>
	col.json_export !== null &&
	col.json_export.group &&
	!col.hidden &&
	col.kind !== 'element' &&
	col.mode === 'expand';

/**
 * The key a grouped column's own value takes inside its entries, `null` for a
 * column that does not group. A blank `item_key`, or one equal to the
 * column's own key, is that key; another joins the clash rule after every
 * column key.
 */
function resolveItemKeys(
	defn: TableDefinition,
	level: readonly (string | null)[]
): (string | null)[] {
	const used = new Set(level.filter((key): key is string => key !== null));
	return defn.columns.map((col, i) => {
		const own = level[i] ?? null;
		if (own === null || !honorsGroup(col)) return null;
		const base = (col.json_export?.item_key ?? '') || own;
		if (base === own) return own;
		let key = base;
		for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
		used.add(key);
		return key;
	});
}

type Keys = { level: (string | null)[]; item: (string | null)[] };

// -- the group plan ------------------------------------------------------------------

/**
 * What nests in what: the grouped columns, each one's key slot, the columns
 * rendered inside its entries (itself first), the grouped columns directly
 * inside it, and the plain and grouped columns of the top level. A column
 * belongs to the innermost grouped column its source reaches.
 */
type GroupPlan = {
	grouped: readonly number[];
	slotOf: ReadonlyMap<number, number>;
	members: ReadonlyMap<number, readonly number[]>;
	children: ReadonlyMap<number, readonly number[]>;
	topColumns: readonly number[];
	topGroups: readonly number[];
};

/** Per column, every column its source reaches, through the columns it reads. */
function deps(defn: TableDefinition): Set<number>[] {
	const out: Set<number>[] = [];
	for (const col of defn.columns) {
		const { source } = col;
		out.push(source.kind === 'column' ? new Set([source.index, ...out[source.index]!]) : new Set());
	}
	return out;
}

function groupPlan(defn: TableDefinition, baseSlots: number): GroupPlan {
	const reach = deps(defn);
	const grouped = defn.columns.flatMap((col, i) => (honorsGroup(col) ? [i] : []));
	const members = new Map<number, number[]>(grouped.map((k) => [k, []]));
	const children = new Map<number, number[]>(grouped.map((k) => [k, []]));
	const topColumns: number[] = [];
	const topGroups: number[] = [];
	defn.columns.forEach((col, i) => {
		if (col.hidden) return;
		const owners = grouped.filter((k) => reach[i]!.has(k));
		const home = owners.length === 0 ? null : Math.max(...owners);
		if (members.has(i)) {
			members.get(i)!.push(i);
			(home === null ? topGroups : children.get(home)!).push(i);
		} else if (home === null) topColumns.push(i);
		else members.get(home)!.push(i);
	});
	return {
		grouped,
		slotOf: new Map(grouped.map((k) => [k, expandSlotOf(defn, baseSlots, k)])),
		members,
		children,
		topColumns,
		topGroups
	};
}

// -- Python equality -----------------------------------------------------------------

/**
 * A slot's identity as a Python dict key: `1`, `1.0` and `True` are one key;
 * a value terminal equals only a terminal of the same type and value. A list
 * or dict is unhashable there.
 */
function slotKey(b: Binding): string {
	if (b instanceof PropertyValue) return 'p' + JSON.stringify(b.key);
	if (typeof b === 'object' && b !== null && !(b instanceof PyFloat)) {
		throw new Error(`unhashable type: '${Array.isArray(b) ? 'list' : 'dict'}'`);
	}
	return pyKey(b);
}

/** Items bucketed by `keyOf`, buckets and their items in first-appearance order. */
function bucketed<T>(items: readonly T[], keyOf: (item: T) => string | null): T[][] {
	const buckets = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		if (key === null) continue;
		const bucket = buckets.get(key);
		if (bucket === undefined) buckets.set(key, [item]);
		else bucket.push(item);
	}
	return [...buckets.values()];
}

// -- cells ---------------------------------------------------------------------------

type ValueMode = 'name' | 'id' | 'object';

/** An element as its column's `value` mode renders it; a dangling id is an error marker. */
function elementJson(model: Model, id: string, mode: ValueMode): JsonOut {
	const el = model.findElement(id);
	if (el === undefined) return new Map([['$error', `unknown element ${id}`]]);
	if (mode === 'id') return el.id;
	if (mode === 'object') {
		return new Map<string, JsonOut>([
			['id', el.id],
			['name', displayName(el)],
			['type', el.typeName]
		]);
	}
	return displayName(el);
}

/** `render_cell`'s `ValueError`: the routes answer 422 with its text. */
class CellError extends Error {}

/**
 * One cell as JSON. `single` collapses a list cell to its one item or
 * `null`, refusing more; a value absent or not declared is `null`; an error
 * cell is an error marker.
 */
function renderCell(model: Model, cell: TableCell, mode: ValueMode, single: boolean): JsonOut {
	switch (cell.kind) {
		case 'value':
			return cell.present !== true ? null : cell.value;
		case 'values': {
			const values = cell.values!;
			if (!single) return [...values];
			if (values.length > 1) {
				throw new CellError(
					`json_export.single: cell holds ${values.length} values, expected at most one`
				);
			}
			return values[0] ?? null;
		}
		case 'element':
			return cell.item === null ? null : elementJson(model, cell.item.id, mode);
		case 'elements': {
			const ids = cell.items!.map((item) => item.id);
			if (!single) return ids.map((id) => elementJson(model, id, mode));
			if (ids.length > 1) {
				throw new CellError(
					`json_export.single: cell holds ${ids.length} elements, expected at most one`
				);
			}
			return ids.length === 0 ? null : elementJson(model, ids[0]!, mode);
		}
		case 'error':
			return new Map([['$error', cell.message]]);
	}
}

const modeOf = (col: Column): ValueMode => col.json_export?.value ?? 'name';

/** A cell with its column's settings; a `single` refusal names the column. */
function columnCell(model: Model, col: Column, key: string, cell: TableCell): JsonOut {
	try {
		return renderCell(model, cell, modeOf(col), col.json_export?.single ?? false);
	} catch (error) {
		if (error instanceof CellError)
			throw new ReadError(422, `column ${pyRepr(key)}: ${error.message}`);
		throw error;
	}
}

/** The document key a cell renders: always single, a refusal worded for the key setting. */
function keyCell(model: Model, col: Column, cell: TableCell): JsonOut {
	try {
		return renderCell(model, cell, modeOf(col), true);
	} catch (error) {
		if (error instanceof CellError)
			throw new ReadError(422, `json_doc.key_column: ${error.message}`);
		throw error;
	}
}

// -- documents -----------------------------------------------------------------------

type Pair = readonly [RowKey, readonly TableCell[]];

type Render = {
	model: Model;
	defn: TableDefinition;
	keys: Keys;
	plan: GroupPlan;
	order: readonly number[] | null;
};

/**
 * One object: the plain `columns` and an array for each of `groups`, in
 * output order (definition order without `order`), the row number with them
 * when given. A plain column is read off the first row: it reads no grouped
 * slot, so it is the same on every row of the bucket.
 */
function renderLevel(
	r: Render,
	columns: readonly number[],
	groups: readonly number[],
	rows: readonly Pair[],
	rowNumber: readonly [number, string, number] | null
): JsonDoc {
	const groupSet = new Set(groups);
	const entries: [number, number][] = [...columns, ...groups].map((i) => [
		r.order === null ? i : r.order[i]!,
		i
	]);
	if (rowNumber !== null) entries.push([rowNumber[0], ROW_NUMBER_SLOT]);
	entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const obj: JsonDoc = new Map();
	for (const [, i] of entries) {
		if (i === ROW_NUMBER_SLOT) {
			obj.set(rowNumber![1], rowNumber![2]);
		} else if (groupSet.has(i)) {
			const key = r.keys.level[i] ?? null;
			if (key !== null) obj.set(key, renderGroup(r, i, rows));
		} else {
			// A grouped column met here renders its own value inside its entries.
			const key = (r.plan.slotOf.has(i) ? r.keys.item[i] : r.keys.level[i]) ?? null;
			if (key !== null) obj.set(key, columnCell(r.model, r.defn.columns[i]!, key, rows[0]![1][i]!));
		}
	}
	return obj;
}

/**
 * The array of grouped column `g`: its rows partitioned by the value in its
 * own slot, a row kept empty dropped. A group of the column alone, nesting
 * nothing, lists the values themselves.
 */
function renderGroup(r: Render, g: number, rows: readonly Pair[]): JsonOut[] {
	const slot = r.plan.slotOf.get(g)!;
	const parts = bucketed(rows, ([key]) => (key[slot] === null ? null : slotKey(key[slot]!)));
	const members = r.plan.members.get(g)!;
	const children = r.plan.children.get(g)!;
	if (members.length === 1 && children.length === 0) {
		const col = r.defn.columns[g]!;
		const key = r.keys.level[g] || `#${g}`;
		return parts.map((sub) => columnCell(r.model, col, key, sub[0]![1][g]!));
	}
	return parts.map((sub) => renderLevel(r, members, children, sub, null));
}

/**
 * The table as documents, one step a slice of them, and with `keyColumn` one
 * key a document, read off its first row's cell: `renderJsonEx` in steps.
 */
export function* renderJsonExSteps(
	model: Model,
	defn: TableDefinition,
	rowKeys: readonly RowKey[],
	cells: readonly (readonly TableCell[])[],
	baseSlots: number,
	options: JsonRenderOptions,
	meter: Meter
): Steps<[JsonDoc[], string[] | null]> {
	if (rowKeys.length !== cells.length) throw new Error('a row key a row of cells');
	const plan = groupPlan(defn, baseSlots);
	const level = resolveJsonKeys(defn);
	const r: Render = {
		model,
		defn,
		keys: { level, item: resolveItemKeys(defn, level) },
		plan,
		order: options.order
	};
	const pairs: Pair[] = rowKeys.map((key, i) => [key, cells[i]!]);
	let buckets: Pair[][];
	if (plan.grouped.length === 0) {
		// Rows with equal keys stay apart, as xlsx writes them.
		buckets = pairs.map((pair) => [pair]);
	} else {
		const groupedSlots = new Set(plan.slotOf.values());
		buckets = bucketed(pairs, ([key]) =>
			key.flatMap((b, i) => (groupedSlots.has(i) ? [] : [slotKey(b)])).join(',')
		);
	}
	const docKeys = options.keyColumn === null ? null : documentKeys(r, buckets, options.keyColumn);
	const docs: JsonDoc[] = [];
	for (const [n, bucket] of buckets.entries()) {
		const rowNumber = options.rowNumber === null ? null : ([...options.rowNumber, n + 1] as const);
		docs.push(renderLevel(r, plan.topColumns, plan.topGroups, bucket, rowNumber));
		if (meter.tick()) yield meter.end();
	}
	return [docs, docKeys];
}

/**
 * One key a document: a scalar neither `null` nor empty, as text, no two
 * alike. Keys equal in Python but not as text (`1`, `1.0`, `True`) differ.
 */
function documentKeys(r: Render, buckets: readonly Pair[][], keyColumn: number): string[] {
	const { columns } = r.defn;
	if (!(0 <= keyColumn && keyColumn < columns.length)) {
		throw new ReadError(
			422,
			`json_doc.key_column ${keyColumn} out of range (table has ${columns.length} columns)`
		);
	}
	const col = columns[keyColumn]!;
	const out: string[] = [];
	const seen = new Set<string>();
	for (const bucket of buckets) {
		const rendered = keyCell(r.model, col, bucket[0]![1][keyColumn]!);
		const scalar =
			typeof rendered === 'string' ||
			typeof rendered === 'number' ||
			typeof rendered === 'bigint' ||
			typeof rendered === 'boolean' ||
			rendered instanceof PyFloat;
		if (!scalar || rendered === '') {
			throw new ReadError(
				422,
				`json_doc.key_column renders an empty or non-scalar key for document ${out.length + 1}`
			);
		}
		const key = pyStr(rendered);
		if (seen.has(key)) {
			throw new ReadError(422, `json_doc.key_column: duplicate document key ${pyRepr(key)}`);
		}
		seen.add(key);
		out.push(key);
	}
	return out;
}

/** The table as documents, and their keys with `keyColumn`. */
export function renderJsonEx(
	model: Model,
	defn: TableDefinition,
	rowKeys: readonly RowKey[],
	cells: readonly (readonly TableCell[])[],
	baseSlots: number,
	options: JsonRenderOptions
): [JsonDoc[], string[] | null] {
	return drain(renderJsonExSteps(model, defn, rowKeys, cells, baseSlots, options, new Meter(0)));
}

/** JSONL is the document list; JSON the documents keyed when keys were rendered, else the list. */
export function shapeJsonDocs(
	format: JsonFormat,
	docs: readonly JsonDoc[],
	docKeys: readonly string[] | null
): JsonOut {
	if (format === 'jsonl' || docKeys === null) return [...docs];
	return new Map(docKeys.map((key, i) => [key, docs[i]!]));
}

/** Whether a document carries an error marker at any depth. */
export function containsErrorMarker(value: JsonOut): boolean {
	if (value instanceof Map) {
		return value.has('$error') || [...value.values()].some(containsErrorMarker);
	}
	if (Array.isArray(value)) return value.some(containsErrorMarker);
	if (typeof value === 'object' && value !== null && !(value instanceof PyFloat)) {
		return Object.hasOwn(value, '$error') || Object.values(value).some(containsErrorMarker);
	}
	return false;
}

// -- serializing ---------------------------------------------------------------------

const isObject = (value: JsonOut): value is { [key: string]: Value } =>
	typeof value === 'object' &&
	value !== null &&
	!(value instanceof Map) &&
	!Array.isArray(value) &&
	!(value instanceof PyFloat);

/**
 * `json.dumps(value, ensure_ascii=False)`: compact without `indent`, Python's
 * layout with one. A non-finite float is written as Python writes it.
 */
function dump(value: JsonOut, indent: number | undefined, depth: number): string {
	if (isObject(value)) return dump(new Map(Object.entries(value)), indent, depth);
	if (!(value instanceof Map) && !Array.isArray(value)) {
		return pyDumps(value as Value, undefined, { allowNan: true });
	}
	const colon = indent === undefined ? ':' : ': ';
	const parts =
		value instanceof Map
			? [...value].map(([key, item]) => pyDumps(key) + colon + dump(item, indent, depth + 1))
			: value.map((item) => dump(item, indent, depth + 1));
	const [open, close] = value instanceof Map ? ['{', '}'] : ['[', ']'];
	if (parts.length === 0) return open + close;
	if (indent === undefined) return open + parts.join(',') + close;
	const inner = '\n' + ' '.repeat(indent * (depth + 1));
	return open + inner + parts.join(',' + inner) + '\n' + ' '.repeat(indent * depth) + close;
}

/** The pieces of a JSON file, one step a slice of its top-level members; joined, the file. */
export function* jsonTextSteps(payload: JsonOut, pretty: boolean, meter: Meter): Steps<string[]> {
	const indent = pretty ? 2 : undefined;
	const members: (readonly [string | null, JsonOut])[] | null =
		payload instanceof Map
			? [...payload]
			: Array.isArray(payload)
				? payload.map((item) => [null, item] as const)
				: null;
	if (members === null || members.length === 0) return [dump(payload, indent, 0)];
	const [open, close] = payload instanceof Map ? ['{', '}'] : ['[', ']'];
	const colon = pretty ? ': ' : ':';
	const between = pretty ? ',\n  ' : ',';
	const pieces = [pretty ? open + '\n  ' : open];
	for (const [i, [key, item]] of members.entries()) {
		const text = (key === null ? '' : pyDumps(key) + colon) + dump(item, indent, 1);
		pieces.push(i === 0 ? text : between + text);
		if (meter.tick()) yield meter.end();
	}
	pieces.push(pretty ? '\n' + close : close);
	return pieces;
}

/** A JSON file: pretty is `indent=2`, else compact; no trailing newline. */
export function jsonText(payload: JsonOut, pretty: boolean): string {
	return drain(jsonTextSteps(payload, pretty, new Meter(0))).join('');
}

/** The lines of a JSONL file, one compact document and its newline each, one step a slice of them. */
export function* jsonlLinesSteps(docs: readonly JsonOut[], meter: Meter): Steps<string[]> {
	const lines: string[] = [];
	for (const doc of docs) {
		lines.push(dump(doc, undefined, 0) + '\n');
		if (meter.tick()) yield meter.end();
	}
	return lines;
}

/** A JSONL file. */
export function jsonlText(docs: readonly JsonOut[]): string {
	return drain(jsonlLinesSteps(docs, new Meter(0))).join('');
}
