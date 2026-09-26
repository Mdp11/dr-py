/**
 * `POST /tables/export` and `POST /tables/json-preview` in steps. An export
 * evaluates every row's cells with the export limits, over the order a page of
 * the same table kept, renders its file and answers its bytes as parts, which
 * never pass through `toWire`: nothing is published before the last step.
 */
import type { EvalContext } from '../evaluate/index.ts';
import { Meter } from '../navigation/evaluate.ts';
import { ReadError } from '../read/errors.ts';
import { pageOf, type ReadParams } from '../read/params.ts';
import type { Steps } from '../steps/steps.ts';
import { evaluateCellsSteps, type TableCell } from '../table/cells.ts';
import { NavMemo } from '../table/nav-memo.ts';
import { tableHasScript } from '../table/resolve.ts';
import { answered, orderedRows, resolved, sourceOf } from '../table/route.ts';
import { EXPORT_TABLE_LIMITS, type RowKey } from '../table/rows.ts';
import type { TableDefinition } from '../table/schema.ts';
import { csvLinesSteps } from './csv.ts';
import {
	jsonlLinesSteps,
	jsonText,
	jsonTextSteps,
	renderJsonExSteps,
	shapeJsonDocs,
	type JsonRenderOptions
} from './json.ts';
import { exportDefinition, exportLayout, type ExportLayout } from './layout.ts';

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

const PART_BYTES = 4 * 1024 * 1024;

/** `bytes` as parts of at most 4 MiB, each a copy on a buffer of its own. */
export function toParts(bytes: Uint8Array): ArrayBuffer[] {
	const parts: ArrayBuffer[] = [];
	for (let at = 0; at < bytes.length; at += PART_BYTES) {
		parts.push(bytes.slice(at, at + PART_BYTES).buffer);
	}
	return parts;
}

type Encoder = { encode(text: string): Uint8Array<ArrayBuffer> };

// Looked up rather than declared, as `utf8Decoder` looks up its decoder.
function utf8Encoder(): Encoder {
	const host = globalThis as unknown as { TextEncoder?: new () => Encoder };
	if (host.TextEncoder === undefined) throw new Error('This host has no TextEncoder');
	return new host.TextEncoder();
}

const LONE_SURROGATES = /\p{Cs}+/u;

/**
 * `text` as UTF-8. A lone surrogate refuses as Python's encoder does, its
 * position in code points from the start of the text, or of its line when
 * each line is encoded alone.
 */
function utf8(text: string, byLine: boolean): Uint8Array {
	const lone = LONE_SURROGATES.exec(text);
	if (lone !== null) {
		const start = byLine ? text.lastIndexOf('\n', lone.index - 1) + 1 : 0;
		const at = Array.from(text.slice(start, lone.index)).length;
		const run = lone[0];
		const where =
			run.length === 1
				? `character '\\u${run.charCodeAt(0).toString(16)}' in position ${at}`
				: `characters in position ${at}-${at + run.length - 1}`;
		throw new ReadError(422, `'utf-8' codec can't encode ${where}: surrogates not allowed`);
	}
	return utf8Encoder().encode(text);
}

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

/** Whether the table's own `transform` is set, which only `/tables/export` runs. */
const hasTransform = (defn: TableDefinition): boolean =>
	defn.transform !== null && (defn.transform.ref !== null || defn.transform.definition !== null);

// -- rows --------------------------------------------------------------------------

/**
 * Every row of a resolved `defn` that reaches no script, in order, with its
 * cells under the export limits. The order is `orderedRows`', so a table
 * whose order is kept builds no rows.
 */
export function exportRowsSteps(
	ctx: EvalContext,
	defn: TableDefinition,
	meter: Meter
): Steps<ExportRows> {
	const { model } = ctx;
	const rows = orderedRows(ctx, defn, meter);
	return (function* (): Steps<ExportRows> {
		const order = yield* rows;
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

const jsonOptions = (layout: ExportLayout): JsonRenderOptions => ({
	order: layout.rank,
	rowNumber: layout.rowNumberAt === null ? null : [layout.rowNumberAt, layout.rowNumberKey],
	keyColumn: null
});

// -- the routes --------------------------------------------------------------------

/**
 * `POST /tables/export` for one CSV, JSON or JSONL file. Before the first step
 * it reads its params and resolves the table through the working copy's
 * artifacts; a table that reaches a script, or carries a transform, refuses
 * with 501 for the server to run. The file is named after the saved table, or
 * `table`. JSON is written pretty; a split is ignored for CSV.
 */
export function exportTable(ctx: EvalContext, params: ReadParams): Steps<ExportFileResult> {
	const source = sourceOf(params);
	pageOf(params);
	const format = formatOf(params);
	exportContext(params);
	const defn = resolved(ctx.artifacts, source);
	if (tableHasScript(defn) || hasTransform(defn)) throw new ReadError(501, 'reaches a script');
	if (format === 'xlsx') throw new ReadError(422, 'xlsx not supported yet');
	if (format !== 'csv' && defn.json_split !== null && defn.json_split.enabled) {
		throw new ReadError(422, 'split not supported yet');
	}
	const name = typeof source === 'string' ? ctx.artifacts.resolve(source)!.name : 'table';
	const { model } = ctx;
	const meter = new Meter(0);
	const rows = exportRowsSteps(ctx, defn, meter);
	const layout = exportLayout(defn);

	return answered(
		(function* (): Steps<ExportFileResult> {
			const { keys, cells, truncated, baseSlots } = yield* rows;
			let pieces: string[];
			if (format === 'csv') {
				const shown = cells.map((row) => layout.order.map((i) => row[i]!));
				pieces = yield* csvLinesSteps(model, layout.headers, shown, layout.rowNumberAt, meter);
			} else {
				const [docs, docKeys] = yield* renderJsonExSteps(
					model,
					exportDefinition(defn),
					keys,
					cells,
					baseSlots,
					jsonOptions(layout),
					meter
				);
				pieces =
					format === 'jsonl'
						? yield* jsonlLinesSteps(docs, meter)
						: yield* jsonTextSteps(shapeJsonDocs(format, docs, docKeys), true, meter);
			}
			return {
				parts: toParts(utf8(pieces.join(''), format === 'jsonl')),
				filename: `${name}.${format}`,
				content_type: MEDIA_TYPES[format],
				truncated,
				script_errors: 0
			};
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
				jsonOptions(layout),
				meter
			);
			const shown = truncated && docs.length > 1 ? docs.slice(0, -1) : docs;
			return { sample: jsonText(shown, true), truncated };
		})()
	);
}
