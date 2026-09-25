/**
 * The table definitions of `core/table/schema.py`. A row is a tuple of
 * bindings: the row source contributes one slot (scope, navigation) or one
 * per chain step (chains), and every expand column one more. A column maps
 * over its source — a row slot or an earlier column — and keeps the values
 * in one cell (collapse) or promotes each to a slot of its own (expand).
 */
import { ReadError } from '../read/errors.ts';
import { readCriteria, type Criterion } from '../search/criteria.ts';
import { pyRepr } from '../value/repr.ts';
import { PyFloat } from '../value/types.ts';
import {
	readNavigation,
	type NavigationDefinition,
	type SnippetSource
} from '../navigation/schema.ts';

/** The most columns a table may hold. */
export const MAX_COLUMNS = 50;

/** A saved navigation (`ref`) or an inline one; neither is an unconfigured source, reaching nothing. */
export type NavigationSource = { ref: string | null; definition: NavigationDefinition | null };

export type ScopeRows = { kind: 'scope'; types: string[]; criteria: Criterion[] };

/** The elements at `step_index` of the navigation's chains (none: the last). */
export type NavigationRows = {
	kind: 'navigation';
	navigation: NavigationSource;
	step_index: number | null;
};

/** Whole chains, one slot per step; `unique` keeps the first chain to each terminal. */
export type ChainRows = { kind: 'chains'; navigation: NavigationSource; unique: boolean };

export type RowSource = ScopeRows | NavigationRows | ChainRows;

export type RowSlot = { kind: 'row'; chain_index: number };

/** An earlier column; `step_index` re-projects a navigation column's chains at that step. */
export type ColumnRef = { kind: 'column'; index: number; step_index: number | null };

export type ColumnSource = RowSlot | ColumnRef;

export type CellMode = 'collapse' | 'expand';

/** A named earlier column a script column reads for the same row. */
export type ScriptInput = { name: string; ref: ColumnRef };

export type JsonColumnOptions = {
	key: string;
	item_key: string;
	value: 'name' | 'id' | 'object';
	group: boolean;
	single: boolean;
};

export type ColumnExportOptions = { include: boolean | null; header: string };

/** What a column carries for display and export only. */
type Presentation = {
	header: string;
	width_px: number | null;
	hidden: boolean;
	json_export: JsonColumnOptions | null;
	export: ColumnExportOptions | null;
};

export type ElementColumn = { kind: 'element'; source: ColumnSource } & Presentation;

export type PropertyColumn = {
	kind: 'property';
	source: ColumnSource;
	name: string;
	mode: CellMode;
	keep_empty: boolean;
} & Presentation;

export type NavigationColumn = {
	kind: 'navigation';
	source: ColumnSource;
	navigation: NavigationSource;
	step_index: number | null;
	mode: CellMode;
	keep_empty: boolean;
	sort_mode: 'value' | 'count';
	cell_cap: number;
} & Presentation;

/** Its snippet is not read further: a table that reaches a script runs on the server. */
export type ScriptColumn = {
	kind: 'script';
	source: ColumnSource;
	snippet: SnippetSource;
	inputs: ScriptInput[];
	mode: CellMode;
	keep_empty: boolean;
} & Presentation;

export type Column = ElementColumn | PropertyColumn | NavigationColumn | ScriptColumn;

export type SortKey = { column: number; direction: 'asc' | 'desc' };

export type RowNumberExportOptions = { include: boolean; header: string; key: string };

export type JsonSplitOptions = { enabled: boolean; filename_template: string };

export type TableDefinition = {
	schema_version: number | bigint;
	row_source: RowSource;
	columns: Column[];
	default_cell_mode: CellMode;
	show_row_numbers: boolean;
	export_order: number[];
	display_order: number[];
	sort: SortKey[];
	export_row_number: RowNumberExportOptions | null;
	json_split: JsonSplitOptions | null;
	transform: SnippetSource | null;
};

// -- reading -------------------------------------------------------------------

type Doc = { readonly [key: string]: unknown };

const isDoc = (value: unknown): value is Doc =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	!(value instanceof PyFloat);

function refuse(where: string, message: string): never {
	throw new ReadError(422, `${where}: ${message}`);
}

// An absent key takes the default; a `null` does not, as pydantic has it.
const field = (d: Doc, key: string, fallback?: unknown): unknown =>
	Object.hasOwn(d, key) && d[key] !== undefined ? d[key] : fallback;

function doc(raw: unknown, where: string): Doc {
	if (!isDoc(raw)) refuse(where, 'must be an object');
	return raw;
}

const isInt = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value);

function str(d: Doc, key: string, where: string, fallback?: string): string {
	const value = field(d, key, fallback);
	if (typeof value !== 'string') refuse(`${where}.${key}`, 'must be a string');
	return value;
}

function optionalStr(d: Doc, key: string, where: string): string | null {
	const value = field(d, key, null);
	if (value !== null && typeof value !== 'string') {
		refuse(`${where}.${key}`, 'must be a string or null');
	}
	return value;
}

function bool(d: Doc, key: string, where: string, fallback: boolean): boolean {
	const value = field(d, key, fallback);
	if (typeof value !== 'boolean') refuse(`${where}.${key}`, 'must be a boolean');
	return value;
}

function int(d: Doc, key: string, where: string, min: number, fallback?: number): number {
	const value = field(d, key, fallback);
	if (!isInt(value) || value < min) {
		refuse(`${where}.${key}`, `must be an integer of at least ${min}`);
	}
	return value;
}

function optionalInt(d: Doc, key: string, where: string): number | null {
	const value = field(d, key, null);
	if (value !== null && !isInt(value)) refuse(`${where}.${key}`, 'must be an integer or null');
	return value;
}

function oneOf<T extends string>(
	d: Doc,
	key: string,
	where: string,
	options: readonly T[],
	fallback?: T
): T {
	const value = field(d, key, fallback);
	if (!options.includes(value as T)) {
		refuse(`${where}.${key}`, `must be one of ${options.join(', ')}`);
	}
	return value as T;
}

function names(d: Doc, key: string, where: string): string[] {
	const value = field(d, key, []);
	if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) {
		refuse(`${where}.${key}`, 'must be a list of strings');
	}
	return [...(value as string[])];
}

function ints(d: Doc, key: string, where: string): number[] {
	const value = field(d, key, []);
	if (!Array.isArray(value) || !value.every(isInt)) {
		refuse(`${where}.${key}`, 'must be a list of integers');
	}
	return [...(value as number[])];
}

function list(d: Doc, key: string, where: string): readonly unknown[] {
	const value = field(d, key, []);
	if (!Array.isArray(value)) refuse(`${where}.${key}`, 'must be a list');
	return value;
}

/** An optional sub-document: `null` when absent or null, else read by `read`. */
function optionalDoc<T>(
	d: Doc,
	key: string,
	where: string,
	read: (sub: Doc, at: string) => T
): T | null {
	const value = field(d, key, null);
	if (value === null) return null;
	const at = `${where}.${key}`;
	return read(doc(value, at), at);
}

function readNavigationSource(raw: unknown, where: string): NavigationSource {
	const d = doc(raw, where);
	const ref = optionalStr(d, 'ref', where);
	const inline = field(d, 'definition', null);
	const definition = inline === null ? null : readNavigation(inline, `${where}.definition`);
	if (ref !== null && definition !== null) {
		refuse(where, 'provide at most one of `ref` / `definition`');
	}
	return { ref, definition };
}

function readSnippetSource(d: Doc, where: string): SnippetSource {
	const ref = optionalStr(d, 'ref', where);
	const definition = field(d, 'definition', null);
	if (definition !== null && !isDoc(definition)) {
		refuse(`${where}.definition`, 'must be an object or null');
	}
	if (ref !== null && definition !== null) {
		refuse(where, 'provide at most one of `ref` / `definition`');
	}
	return { ref, definition };
}

function readRowSource(raw: unknown, where: string): RowSource {
	const d = doc(raw, where);
	const kind = oneOf(d, 'kind', where, ['scope', 'navigation', 'chains'] as const);
	if (kind === 'scope') {
		return {
			kind,
			types: names(d, 'types', where),
			criteria: readCriteria(field(d, 'criteria', []), `${where}.criteria`)
		};
	}
	const navigation = readNavigationSource(field(d, 'navigation'), `${where}.navigation`);
	if (kind === 'navigation') {
		return { kind, navigation, step_index: optionalInt(d, 'step_index', where) };
	}
	return { kind, navigation, unique: bool(d, 'unique', where, false) };
}

function readColumnRef(d: Doc, where: string): ColumnRef {
	oneOf(d, 'kind', where, ['column'] as const, 'column');
	return {
		kind: 'column',
		index: int(d, 'index', where, 0),
		step_index: optionalInt(d, 'step_index', where)
	};
}

function readSource(d: Doc, where: string): ColumnSource {
	const raw = field(d, 'source');
	const at = `${where}.source`;
	if (raw === undefined) return { kind: 'row', chain_index: 0 };
	const s = doc(raw, at);
	const kind = oneOf(s, 'kind', at, ['row', 'column'] as const);
	if (kind === 'row') return { kind, chain_index: int(s, 'chain_index', at, 0, 0) };
	return readColumnRef(s, at);
}

// Python's `keyword.kwlist`.
const KEYWORDS = new Set(
	(
		'False None True and as assert async await break class continue def del elif else except ' +
		'finally for from global if import in is lambda nonlocal not or pass raise return try while ' +
		'with yield'
	).split(' ')
);

const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;

function readInput(raw: unknown, where: string): ScriptInput {
	const d = doc(raw, where);
	const name = str(d, 'name', where);
	if (!IDENTIFIER.test(name) || KEYWORDS.has(name)) {
		refuse(`${where}.name`, `input name ${pyRepr(name)} is not a valid identifier`);
	}
	const at = `${where}.ref`;
	return { name, ref: readColumnRef(doc(field(d, 'ref'), at), at) };
}

function readJsonOptions(d: Doc, where: string): JsonColumnOptions {
	return {
		key: str(d, 'key', where, ''),
		item_key: str(d, 'item_key', where, ''),
		value: oneOf(d, 'value', where, ['name', 'id', 'object'] as const, 'name'),
		group: bool(d, 'group', where, false),
		single: bool(d, 'single', where, false)
	};
}

function readExportOptions(d: Doc, where: string): ColumnExportOptions {
	const include = field(d, 'include', null);
	if (include !== null && typeof include !== 'boolean') {
		refuse(`${where}.include`, 'must be a boolean or null');
	}
	return { include, header: str(d, 'header', where, '') };
}

function readPresentation(d: Doc, where: string): Presentation {
	return {
		header: str(d, 'header', where, ''),
		width_px: optionalInt(d, 'width_px', where),
		hidden: bool(d, 'hidden', where, false),
		json_export: optionalDoc(d, 'json_export', where, readJsonOptions),
		export: optionalDoc(d, 'export', where, readExportOptions)
	};
}

const MODES = ['collapse', 'expand'] as const;

function readColumn(raw: unknown, where: string): Column {
	const d = doc(raw, where);
	const kind = oneOf(d, 'kind', where, ['element', 'property', 'navigation', 'script'] as const);
	const source = readSource(d, where);
	switch (kind) {
		case 'element':
			return { kind, source, ...readPresentation(d, where) };
		case 'property':
			return {
				kind,
				source,
				name: str(d, 'name', where),
				mode: oneOf(d, 'mode', where, MODES, 'collapse'),
				keep_empty: bool(d, 'keep_empty', where, true),
				...readPresentation(d, where)
			};
		case 'navigation':
			return {
				kind,
				source,
				navigation: readNavigationSource(field(d, 'navigation'), `${where}.navigation`),
				step_index: optionalInt(d, 'step_index', where),
				mode: oneOf(d, 'mode', where, MODES, 'collapse'),
				keep_empty: bool(d, 'keep_empty', where, true),
				sort_mode: oneOf(d, 'sort_mode', where, ['value', 'count'] as const, 'value'),
				cell_cap: int(d, 'cell_cap', where, 1, 20),
				...readPresentation(d, where)
			};
		case 'script':
			return {
				kind,
				source,
				snippet: readSnippetSource(
					doc(field(d, 'snippet', {}), `${where}.snippet`),
					`${where}.snippet`
				),
				inputs: list(d, 'inputs', where).map((input, i) =>
					readInput(input, `${where}.inputs[${i}]`)
				),
				mode: oneOf(d, 'mode', where, MODES, 'collapse'),
				keep_empty: bool(d, 'keep_empty', where, true),
				...readPresentation(d, where)
			};
	}
}

function readSortKey(raw: unknown, where: string): SortKey {
	const d = doc(raw, where);
	return {
		column: int(d, 'column', where, 0),
		direction: oneOf(d, 'direction', where, ['asc', 'desc'] as const, 'asc')
	};
}

// -- static checks ---------------------------------------------------------------

/** Whether a source yields elements, and whether one per row. */
function sourceArity(columns: readonly Column[], source: ColumnSource): [boolean, boolean] {
	if (source.kind === 'row') return [true, true];
	const ref = columns[source.index]!;
	if (ref.kind === 'element') return [true, true];
	// A step index re-projects the chains: many elements a row, even off an expand column.
	if (ref.kind === 'navigation') return [true, ref.mode === 'expand' && source.step_index === null];
	return [true, ref.mode === 'expand'];
}

function checkInputs(
	columns: readonly Column[],
	i: number,
	col: ScriptColumn,
	where: string
): void {
	const seen = new Set<string>();
	col.inputs.forEach((input, k) => {
		if (seen.has(input.name)) {
			refuse(`${where}.inputs`, `column ${i}: duplicate input name ${pyRepr(input.name)}`);
		}
		seen.add(input.name);
		const at = `${where}.inputs[${k}].ref`;
		if (input.ref.index >= i) {
			refuse(
				at,
				`column ${i}: input ${pyRepr(input.name)} references column ${input.ref.index} (must be < ${i})`
			);
		}
		if (input.ref.step_index !== null && columns[input.ref.index]!.kind !== 'navigation') {
			refuse(
				at,
				`column ${i}: input ${pyRepr(input.name)} step_index requires the referenced column to be a navigation column`
			);
		}
	});
}

/**
 * The core's `_validate_sources`, in its order: a column ref points strictly
 * back; a ref's step index needs a navigation column; a row slot past 0 needs
 * chains; an element column needs one element a row. The `value()` arity of an
 * inline snippet is not checked: such a table reaches a script and is read
 * from the server, which checks it.
 */
function checkSources(defn: TableDefinition, where: string): void {
	const chains = defn.row_source.kind === 'chains';
	const { columns } = defn;
	columns.forEach((col, i) => {
		const at = `${where}.columns[${i}]`;
		const { source } = col;
		if (source.kind === 'column' && source.index >= i) {
			refuse(`${at}.source`, `column ${i} sources column ${source.index} (must be < ${i})`);
		}
		if (source.kind === 'column' && source.step_index !== null) {
			if (columns[source.index]!.kind !== 'navigation') {
				refuse(
					`${at}.source`,
					`column ${i}: source step_index requires the referenced column to be a navigation column`
				);
			}
		}
		if (source.kind === 'row' && source.chain_index !== 0 && !chains) {
			refuse(`${at}.source`, 'chain_index != 0 requires a chains row source');
		}
		const [producing, single] = sourceArity(columns, source);
		if (col.kind === 'navigation' && !producing) {
			refuse(`${at}.source`, `column ${i}: navigation source is not element-producing`);
		}
		if (col.kind === 'element' && !producing) {
			refuse(`${at}.source`, `column ${i}: element column needs an element-producing source`);
		}
		if (col.kind === 'element' && !single) {
			refuse(`${at}.source`, `column ${i}: element column needs a single-binding source`);
		}
		if (col.kind === 'script') checkInputs(columns, i, col, at);
	});
}

/**
 * A table definition as a client sends it or an artifact holds it, read as
 * pydantic reads it in canonical JSON: every `kind` required, the defaults
 * filled, unknown keys ignored, then the core's static checks. Navigations are
 * read by `readNavigation`; snippets are kept, not read. What pydantic would
 * coerce is refused, in the engine's words where the core has none.
 */
export function readTableDefinition(raw: unknown, where: string): TableDefinition {
	const d = doc(raw, where);
	const schemaVersion = field(d, 'schema_version', 1);
	if (!(isInt(schemaVersion) || typeof schemaVersion === 'bigint')) {
		refuse(`${where}.schema_version`, 'must be an integer');
	}
	const rowSource = readRowSource(field(d, 'row_source'), `${where}.row_source`);
	const rawColumns = field(d, 'columns');
	if (!Array.isArray(rawColumns)) refuse(`${where}.columns`, 'must be a list');
	if (rawColumns.length < 1 || rawColumns.length > MAX_COLUMNS) {
		refuse(`${where}.columns`, `must hold 1 to ${MAX_COLUMNS} columns`);
	}
	const defn: TableDefinition = {
		schema_version: schemaVersion,
		row_source: rowSource,
		columns: rawColumns.map((col: unknown, i) => readColumn(col, `${where}.columns[${i}]`)),
		default_cell_mode: oneOf(d, 'default_cell_mode', where, MODES, 'collapse'),
		show_row_numbers: bool(d, 'show_row_numbers', where, false),
		export_order: ints(d, 'export_order', where),
		display_order: ints(d, 'display_order', where),
		sort: list(d, 'sort', where).map((key, i) => readSortKey(key, `${where}.sort[${i}]`)),
		export_row_number: optionalDoc(d, 'export_row_number', where, (sub, at) => ({
			include: bool(sub, 'include', at, true),
			header: str(sub, 'header', at, ''),
			key: str(sub, 'key', at, '')
		})),
		json_split: optionalDoc(d, 'json_split', where, (sub, at) => ({
			enabled: bool(sub, 'enabled', at, false),
			filename_template: str(sub, 'filename_template', at, '')
		})),
		transform: optionalDoc(d, 'transform', where, readSnippetSource)
	};
	checkSources(defn, where);
	return defn;
}
