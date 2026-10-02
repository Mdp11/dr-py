/**
 * The exporter artifact of `core/table/exporter.py`: a named collection of
 * table exports whose presentation lives in the artifact, and
 * `overriddenTable`, the copy of a table an entry renders through.
 */
import {
	bool,
	doc,
	field,
	int,
	ints,
	isInt,
	list,
	oneOf,
	optionalDoc,
	optionalInt,
	readExportOptions,
	readJsonOptions,
	readJsonSplitOptions,
	readRowNumberOptions,
	readSnippetSource,
	refuse,
	str,
	type ColumnExportOptions,
	type Doc,
	type JsonColumnOptions,
	type JsonSplitOptions,
	type RowNumberExportOptions,
	type TableDefinition
} from '../table/schema.ts';
import { checkSnippetDefinition } from '../script/snippets.ts';
import type { ExportFormat } from './route.ts';

/** The most entries an exporter may hold. */
export const MAX_EXPORTER_ENTRIES = 50;

const FORMATS = ['xlsx', 'json', 'csv', 'jsonl'] as const;

/** How a `json` entry's documents are shaped and written; `jsonl` reads `on_error` alone. */
export type JsonDocumentOptions = {
	shape: 'array' | 'object';
	key_column: number | null;
	pretty: boolean;
	on_error: 'emit' | 'fail';
};

/** One column's presentation in an entry, by definition index. */
export type ColumnOverride = {
	index: number;
	export: ColumnExportOptions | null;
	json_export: JsonColumnOptions | null;
};

/** A saved snippet (`ref`) or inline code; neither is no transform. */
export type EntryTransform = { ref: string | null; definition: { code: string } | null };

export type ExporterEntry = {
	source: { ref: string };
	name: string;
	folder: string;
	split_folder: boolean;
	format: ExportFormat;
	columns: ColumnOverride[];
	export_order: number[];
	show_row_numbers: boolean;
	export_row_number: RowNumberExportOptions | null;
	json_split: JsonSplitOptions | null;
	json_doc: JsonDocumentOptions | null;
	transform: EntryTransform | null;
};

export type OutputOptions = { mode: 'zip' | 'bare'; filename: string; manifest: boolean };

export type ExporterDefinition = {
	schema_version: number | bigint;
	output: OutputOptions;
	entries: ExporterEntry[];
};

// -- reading -------------------------------------------------------------------

function readJsonDocument(d: Doc, where: string): JsonDocumentOptions {
	return {
		shape: oneOf(d, 'shape', where, ['array', 'object'] as const, 'array'),
		key_column: optionalInt(d, 'key_column', where),
		pretty: bool(d, 'pretty', where, true),
		on_error: oneOf(d, 'on_error', where, ['emit', 'fail'] as const, 'emit')
	};
}

function readTransform(d: Doc, where: string): EntryTransform {
	const { ref, definition } = readSnippetSource(d, where);
	if (definition === null) return { ref, definition: null };
	checkSnippetDefinition(definition, `${where}.definition`);
	return { ref, definition: { code: str(definition as Doc, 'code', `${where}.definition`) } };
}

function readColumnOverride(raw: unknown, where: string): ColumnOverride {
	const d = doc(raw, where);
	return {
		index: int(d, 'index', where, 0),
		export: optionalDoc(d, 'export', where, readExportOptions),
		json_export: optionalDoc(d, 'json_export', where, readJsonOptions)
	};
}

/** One exporter entry as `readExporterDefinition` reads each of its entries. */
export function readExporterEntry(raw: unknown, where: string): ExporterEntry {
	const d = doc(raw, where);
	const at = `${where}.source`;
	return {
		source: { ref: str(doc(field(d, 'source'), at), 'ref', at) },
		name: str(d, 'name', where, ''),
		folder: str(d, 'folder', where, ''),
		split_folder: bool(d, 'split_folder', where, true),
		format: oneOf(d, 'format', where, FORMATS, 'xlsx'),
		columns: list(d, 'columns', where).map((col, i) =>
			readColumnOverride(col, `${where}.columns[${i}]`)
		),
		export_order: ints(d, 'export_order', where),
		show_row_numbers: bool(d, 'show_row_numbers', where, false),
		export_row_number: optionalDoc(d, 'export_row_number', where, readRowNumberOptions),
		json_split: optionalDoc(d, 'json_split', where, readJsonSplitOptions),
		json_doc: optionalDoc(d, 'json_doc', where, readJsonDocument),
		transform: optionalDoc(d, 'transform', where, readTransform)
	};
}

/**
 * An exporter definition as a client sends it or an artifact holds it, read
 * as pydantic reads canonical JSON: the defaults filled, unknown keys
 * ignored, what pydantic would refuse refused in the engine's words.
 */
export function readExporterDefinition(raw: unknown, where: string): ExporterDefinition {
	const d = doc(raw, where);
	const schemaVersion = field(d, 'schema_version', 1);
	if (!(isInt(schemaVersion) || typeof schemaVersion === 'bigint')) {
		refuse(`${where}.schema_version`, 'must be an integer');
	}
	const at = `${where}.output`;
	const output = doc(field(d, 'output', {}), at);
	const entries = list(d, 'entries', where);
	if (entries.length > MAX_EXPORTER_ENTRIES) {
		refuse(`${where}.entries`, `must hold at most ${MAX_EXPORTER_ENTRIES} entries`);
	}
	return {
		schema_version: schemaVersion,
		output: {
			mode: oneOf(output, 'mode', at, ['zip', 'bare'] as const, 'zip'),
			filename: str(output, 'filename', at, ''),
			manifest: bool(output, 'manifest', at, true)
		},
		entries: entries.map((entry, i) => readExporterEntry(entry, `${where}.entries[${i}]`))
	};
}

// -- the render copy -------------------------------------------------------------

/** Whether a transform source is set, a table's or an entry's: an empty one is no transform. */
export const hasTransformSource = (
	source: { readonly ref: string | null; readonly definition: object | null } | null
): boolean => source !== null && (source.ref !== null || source.definition !== null);

/** Whether an entry's transform is set. */
export const hasEntryTransform = (entry: ExporterEntry): boolean =>
	hasTransformSource(entry.transform);

/**
 * A copy of `defn` whose presentation is the entry's. A column the entry does
 * not mention takes the default presentation, never the table's own; an
 * override out of range, or naming a column an earlier one did, is dropped.
 * The copy is rendered through, never evaluated.
 */
export function overriddenTable(defn: TableDefinition, entry: ExporterEntry): TableDefinition {
	const byIndex = new Map<number, ColumnOverride>();
	for (const override of entry.columns) {
		if (override.index < defn.columns.length && !byIndex.has(override.index)) {
			byIndex.set(override.index, override);
		}
	}
	return {
		...defn,
		columns: defn.columns.map((col, i) => {
			const override = byIndex.get(i);
			return {
				...col,
				export: override === undefined ? null : override.export,
				json_export: override === undefined ? null : override.json_export
			};
		}),
		export_order: [...entry.export_order],
		show_row_numbers: entry.show_row_numbers,
		export_row_number: entry.export_row_number,
		json_split: entry.json_split,
		transform: entry.transform
	};
}
