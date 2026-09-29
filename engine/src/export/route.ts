/**
 * `POST /tables/export` and `POST /tables/json-preview` in steps, and
 * `exportFilesSteps`, one table's export as `run_table_export` renders it for
 * both `/tables/export` and every exporter entry. An export evaluates every
 * row's cells with the export limits, over the order a page of the same table
 * kept, renders its files and answers their bytes as parts, which never pass
 * through `toWire`: nothing is published before the last step.
 */
import type { EvalContext } from '../evaluate/index.ts';
import { Meter } from '../navigation/evaluate.ts';
import { ReadError } from '../read/errors.ts';
import { pageOf, type ReadParams } from '../read/params.ts';
import type { Steps } from '../steps/steps.ts';
import { evaluateCellsSteps, type TableCell } from '../table/cells.ts';
import { NavMemo } from '../table/nav-memo.ts';
import type { CachedOrder } from '../table/order-cache.ts';
import { tableHasScript } from '../table/resolve.ts';
import { answered, orderedRows, resolved, sourceOf } from '../table/route.ts';
import { EXPORT_TABLE_LIMITS, type RowKey } from '../table/rows.ts';
import type { JsonSplitOptions, TableDefinition } from '../table/schema.ts';
import { pyStr } from '../value/repr.ts';
import { csvLinesSteps } from './csv.ts';
import {
	containsErrorMarker,
	jsonlLinesSteps,
	jsonText,
	jsonTextSteps,
	renderJsonExSteps,
	shapeJsonDocs,
	type JsonDoc,
	type JsonRenderOptions
} from './json.ts';
import { exportDefinition, exportLayout, type ExportLayout } from './layout.ts';
import { SPLIT_TOKENS, validateTokens } from './naming.ts';
import type { JsonDocumentOptions } from './schema.ts';
import { partitionLabel, renderFilenames, splitPartitions, validateTemplate } from './split.ts';
import { utf8 } from './utf8.ts';
import { buildWorkbookSteps } from './xlsx.ts';
import { zipSteps, type ZipFile } from './zip.ts';

export type ExportFormat = 'xlsx' | 'json' | 'csv' | 'jsonl';

const FORMATS: readonly ExportFormat[] = ['xlsx', 'json', 'csv', 'jsonl'];

/** The content type of each format's file. */
export const MEDIA_TYPES: { readonly [format in ExportFormat]: string } = {
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	json: 'application/json',
	csv: 'text/csv; charset=utf-8',
	jsonl: 'application/x-ndjson'
};

/**
 * A shipped file: its bytes in parts of at most 4 MiB, the name and content
 * type the route's headers carry, and whether rows are missing. No script
 * runs here, so no cell is ever an error.
 */
export type ExportFileResult = {
	parts: ArrayBuffer[];
	filename: string;
	content_type: string;
	truncated: boolean;
	script_errors: 0;
};

/** A table's rows in order and every row's cells, and what the build said of them. */
export type ExportRows = {
	keys: readonly RowKey[];
	cells: TableCell[][];
	truncated: boolean;
	baseSlots: number;
};

/** Rows the preview renders. */
export const PREVIEW_MAX_ROWS = 200;

/** The most bytes one part of a shipped file holds. */
export const PART_BYTES = 4 * 1024 * 1024;

/** `bytes` as parts of at most 4 MiB, each a copy on a buffer of its own. */
export function toParts(bytes: Uint8Array): ArrayBuffer[] {
	const parts: ArrayBuffer[] = [];
	for (let at = 0; at < bytes.length; at += PART_BYTES) {
		parts.push(bytes.slice(at, at + PART_BYTES).buffer);
	}
	return parts;
}

/** A file shipped as the route answers it. */
export const shipped = (
	bytes: Uint8Array,
	filename: string,
	contentType: string,
	truncated: boolean
): ExportFileResult => ({
	parts: toParts(bytes),
	filename,
	content_type: contentType,
	truncated,
	script_errors: 0
});

// -- params ------------------------------------------------------------------------

function formatOf(params: ReadParams): ExportFormat {
	const { format = 'xlsx' } = params;
	if (!FORMATS.includes(format as ExportFormat)) {
		throw new ReadError(422, `format must be one of ${FORMATS.join(', ')}`);
	}
	return format as ExportFormat;
}

/** The export's context: the UTC day of the call and the project's id, which the caller passes. */
export function exportContext(params: ReadParams): { date: string; project: string } {
	const { date, project } = params;
	if (typeof date !== 'string' || !/^[0-9]{8}$/.test(date)) {
		throw new ReadError(422, 'date must be YYYYMMDD');
	}
	if (typeof project !== 'string' || project === '') {
		throw new ReadError(422, 'project must be a non-empty string');
	}
	return { date, project };
}

/** The `${rev}` / `${date}` / `${project}` a call's templates read: `rev` is the committed one. */
export function templateVars(
	ctx: EvalContext,
	{ date, project }: { date: string; project: string }
): { rev: string; date: string; project: string } {
	return { rev: pyStr(ctx.working?.rev ?? 0), date, project };
}

/** Whether the table's own `transform` is set, which only `/tables/export` runs. */
const hasTransform = (defn: TableDefinition): boolean =>
	defn.transform !== null && (defn.transform.ref !== null || defn.transform.definition !== null);

const isJsonFamily = (format: ExportFormat): format is 'json' | 'jsonl' =>
	format === 'json' || format === 'jsonl';

/** Whether `split` splits a `format` export: a JSON-family one alone; xlsx and CSV ignore it. */
const splits = (format: ExportFormat, split: JsonSplitOptions | null): split is JsonSplitOptions =>
	isJsonFamily(format) && split !== null && split.enabled;

/** The core's refusal of the split template a `format` export would use, else `null`. */
export function splitRefusal(format: ExportFormat, split: JsonSplitOptions | null): string | null {
	if (!splits(format, split)) return null;
	return (
		validateTemplate(split.filename_template) ??
		validateTokens(split.filename_template, SPLIT_TOKENS)
	);
}

// -- rows --------------------------------------------------------------------------

/**
 * Every row of a resolved `defn` that reaches no script, in order, with its
 * cells under the export limits. The order is `orderedRows`', so a table
 * whose order is kept builds no rows. `ordered` runs once the rows are in
 * order, before any cell.
 */
export function exportRowsSteps(
	ctx: EvalContext,
	defn: TableDefinition,
	meter: Meter,
	ordered: (order: CachedOrder) => void = () => {}
): Steps<ExportRows> {
	const { model } = ctx;
	const rows = orderedRows(ctx, defn, meter);
	return (function* (): Steps<ExportRows> {
		const order = yield* rows;
		ordered(order);
		const cells = yield* evaluateCellsSteps(
			model,
			defn,
			order.keys,
			order.baseSlots,
			EXPORT_TABLE_LIMITS,
			meter,
			new NavMemo()
		);
		return { keys: order.keys, cells, truncated: order.truncated, baseSlots: order.baseSlots };
	})();
}

const jsonOptions = (layout: ExportLayout, keyColumn: number | null): JsonRenderOptions => ({
	order: layout.rank,
	rowNumber: layout.rowNumberAt === null ? null : [layout.rowNumberAt, layout.rowNumberKey],
	keyColumn
});

// -- one table's export ------------------------------------------------------------

/**
 * One table's export: `defn` evaluated, `renderDefn` (the same table, or an
 * exporter entry's copy of it) rendered, `name` naming the file and the sheet,
 * `vars` the split filenames' context, `jsonDoc` an entry's document shaping.
 */
export type ExportJob = {
	defn: TableDefinition;
	renderDefn: TableDefinition;
	name: string;
	format: ExportFormat;
	vars: Readonly<Record<string, string>>;
	jsonDoc: JsonDocumentOptions | null;
};

/** What one table's export wrote: one file, or one a partition (`archive`), by its name. */
export type ExportFiles = { files: ZipFile[]; truncated: boolean; archive: boolean };

/** `json_key_column`: the object shape's key column, `json` only, refused when unset or out of range. */
function jsonKeyColumn(job: ExportJob): number | null {
	const { format, jsonDoc, defn, name } = job;
	if (format !== 'json' || jsonDoc === null || jsonDoc.shape !== 'object') return null;
	const keyColumn = jsonDoc.key_column;
	if (keyColumn === null) {
		throw new ReadError(422, `${name}: json_doc.shape 'object' requires key_column`);
	}
	if (!(0 <= keyColumn && keyColumn < defn.columns.length)) {
		throw new ReadError(
			422,
			`${name}: json_doc.key_column ${keyColumn} out of range (table has ${defn.columns.length} columns)`
		);
	}
	return keyColumn;
}

/**
 * `run_table_export` in steps, its split template already checked: every
 * row evaluated from `job.defn`, the file (or, split, one file a partition)
 * rendered from `job.renderDefn`. JSON is pretty unless the entry says
 * otherwise; with `on_error: 'fail'`, a document holding an error marker
 * refuses with 422.
 */
export function exportFilesSteps(
	ctx: EvalContext,
	job: ExportJob,
	meter: Meter
): Steps<ExportFiles> {
	const { model } = ctx;
	const { defn, renderDefn, name, format, vars, jsonDoc } = job;
	const split = renderDefn.json_split;
	const layout = exportLayout(renderDefn);
	let keyColumn: number | null = null;
	const rows = exportRowsSteps(ctx, defn, meter, () => {
		keyColumn = jsonKeyColumn(job);
	});
	const pretty = jsonDoc === null || jsonDoc.pretty;

	function checkOnError(docs: readonly JsonDoc[]): void {
		if (jsonDoc?.on_error === 'fail' && docs.some(containsErrorMarker)) {
			throw new ReadError(
				422,
				`${name}: export contains error cells and json_doc.on_error is 'fail'`
			);
		}
	}

	return (function* (): Steps<ExportFiles> {
		const { keys, cells, truncated, baseSlots } = yield* rows;
		if (format === 'xlsx' || format === 'csv') {
			const shown = cells.map((row) => layout.order.map((i) => row[i]!));
			const { headers, rowNumberAt } = layout;
			let bytes: Uint8Array;
			if (format === 'xlsx') {
				bytes = yield* buildWorkbookSteps(model, headers, name, shown, rowNumberAt, meter);
			} else {
				const pieces = yield* csvLinesSteps(model, headers, shown, rowNumberAt, meter);
				bytes = utf8(pieces.join(''), false);
			}
			return { files: [{ path: `${name}.${format}`, bytes }], truncated, archive: false };
		}
		const eff = exportDefinition(renderDefn);
		const options = jsonOptions(layout, keyColumn);
		function* file(
			partKeys: readonly RowKey[],
			partCells: readonly TableCell[][]
		): Steps<Uint8Array> {
			const [docs, docKeys] = yield* renderJsonExSteps(
				model,
				eff,
				partKeys,
				partCells,
				baseSlots,
				options,
				meter
			);
			checkOnError(docs);
			const pieces =
				format === 'jsonl'
					? yield* jsonlLinesSteps(docs, meter)
					: yield* jsonTextSteps(shapeJsonDocs('json', docs, docKeys), pretty, meter);
			return utf8(pieces.join(''), format === 'jsonl');
		}
		if (!splits(format, split)) {
			const bytes = yield* file(keys, cells);
			return { files: [{ path: `${name}.${format}`, bytes }], truncated, archive: false };
		}
		const parts = splitPartitions(keys);
		const stems = renderFilenames(
			split.filename_template,
			parts.map((part) => partitionLabel(model, part.binding)),
			vars
		);
		const files: ZipFile[] = [];
		for (const [i, part] of parts.entries()) {
			const bytes = yield* file(
				part.indices.map((idx) => keys[idx]!),
				part.indices.map((idx) => cells[idx]!)
			);
			files.push({ path: `${stems[i]!}.${format}`, bytes });
		}
		return { files, truncated, archive: true };
	})();
}

// -- the routes --------------------------------------------------------------------

/**
 * `POST /tables/export` for one xlsx, CSV, JSON or JSONL file — or, with the
 * table's own `json_split` enabled (JSON-family formats only; xlsx and CSV
 * ignore it), an `application/zip` named `{name}.zip` of one file a partition.
 * Before the first step it reads its params and resolves the table through
 * the working copy's artifacts; a table that reaches a script, or carries a
 * transform, refuses with 501 for the server to run, and a bad split
 * template with 422. The file is named after the saved table, or `table`.
 * JSON is written pretty.
 */
export function exportTable(ctx: EvalContext, params: ReadParams): Steps<ExportFileResult> {
	const source = sourceOf(params);
	pageOf(params);
	const format = formatOf(params);
	const context = exportContext(params);
	const defn = resolved(ctx.artifacts, source);
	if (tableHasScript(defn) || hasTransform(defn)) throw new ReadError(501, 'reaches a script');
	const badSplit = splitRefusal(format, defn.json_split);
	if (badSplit !== null) throw new ReadError(422, badSplit);
	const name = typeof source === 'string' ? ctx.artifacts.resolve(source)!.name : 'table';
	const job: ExportJob = {
		defn,
		renderDefn: defn,
		name,
		format,
		vars: templateVars(ctx, context),
		jsonDoc: null
	};
	const meter = new Meter(0);
	const files = exportFilesSteps(ctx, job, meter);

	return answered(
		(function* (): Steps<ExportFileResult> {
			const out = yield* files;
			if (out.archive) {
				const zipped = yield* zipSteps(out.files, meter);
				return shipped(zipped, `${name}.zip`, 'application/zip', out.truncated);
			}
			const [file] = out.files;
			return shipped(file!.bytes, file!.path, MEDIA_TYPES[format], out.truncated);
		})()
	);
}

/** A JSON sample of a table's first rows, as the export's settings pane shows it. */
export type JsonPreviewBody = { sample: string; truncated: boolean };

/**
 * `POST /tables/json-preview`: the table's first 200 rows as pretty JSON, with
 * the table's own layout and no split. When rows are left out, so is the last
 * of several documents, which may be cut short.
 */
export function previewTableJson(ctx: EvalContext, params: ReadParams): Steps<JsonPreviewBody> {
	const source = sourceOf(params);
	pageOf(params);
	const defn = resolved(ctx.artifacts, source);
	if (tableHasScript(defn)) throw new ReadError(501, 'reaches a script');
	const { model } = ctx;
	const meter = new Meter(0);
	const rows = orderedRows(ctx, defn, meter);
	const layout = exportLayout(defn);

	return answered(
		(function* (): Steps<JsonPreviewBody> {
			const order = yield* rows;
			const window = order.keys.slice(0, PREVIEW_MAX_ROWS);
			const truncated = order.keys.length > window.length;
			const cells = yield* evaluateCellsSteps(
				model,
				defn,
				window,
				order.baseSlots,
				EXPORT_TABLE_LIMITS,
				meter,
				new NavMemo()
			);
			const [docs] = yield* renderJsonExSteps(
				model,
				exportDefinition(defn),
				window,
				cells,
				order.baseSlots,
				jsonOptions(layout, null),
				meter
			);
			const shown = truncated && docs.length > 1 ? docs.slice(0, -1) : docs;
			return { sample: jsonText(shown, true), truncated };
		})()
	);
}
