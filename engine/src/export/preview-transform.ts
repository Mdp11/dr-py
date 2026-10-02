/**
 * `POST /exports/preview-transform` in steps: the exporter entry's Test button.
 * The entry's table is rendered the way the export renders it, and its
 * `transform(doc)` is run once for each file the export would write, each
 * file's outcome reported on its own: a snippet that fails is that file's
 * `error`, not a refusal. Unsplit the one file is rendered from the table's
 * first 200 rows; split it is every partition, the first 200 of them
 * transformed. The entry's own problems refuse with 422 as `/exports/run`
 * refuses them.
 */
import type { EvalContext } from '../evaluate/index.ts';
import { Meter } from '../navigation/evaluate.ts';
import { ReadError } from '../read/errors.ts';
import type { ReadParams } from '../read/params.ts';
import type { ScriptError } from '../script/result.ts';
import { resolveTransformSource, transformSyntaxRefusal } from '../script/snippets.ts';
import type { Steps } from '../steps/steps.ts';
import { evaluateCellsSteps, type TableCell } from '../table/cells.ts';
import { NavMemo } from '../table/nav-memo.ts';
import { answered, orderedRows, resolved, tableScripts } from '../table/route.ts';
import { EXPORT_TABLE_LIMITS, type RowKey } from '../table/rows.ts';
import {
	exportContext,
	isJsonFamily,
	jsonKeyColumn,
	jsonOptions,
	PREVIEW_MAX_ROWS,
	splitRefusal,
	templateVars,
	transformFormatRefusal
} from './route.ts';
import { exportDefinition, exportLayout } from './layout.ts';
import { jsonTextSteps, renderJsonExSteps, shapeJsonDocs, type JsonOut } from './json.ts';
import { hasEntryTransform, overriddenTable, readExporterEntry } from './schema.ts';
import { partitionLabel, renderFilenames, splitPartitions } from './split.ts';
import { pyTypeName, transformSteps, type TransformOutcome } from './transform.ts';

/** The most files a split preview transforms. */
export const PREVIEW_MAX_FILES = 200;

/** One dry `transform(doc)` call: the document of one file, and what the snippet made of it. */
export type TransformPreviewFile = {
	filename: string;
	input: string;
	output: string | null;
	stdout: string;
	error: ScriptError | null;
};

export type TransformPreviewBody = {
	files: TransformPreviewFile[];
	split: boolean;
	truncated: boolean;
};

type Sample = { filename: string; doc: JsonOut };

const pretty = (doc: JsonOut, meter: Meter): Steps<string> =>
	(function* () {
		return (yield* jsonTextSteps(doc, true, meter)).join('');
	})();

/** The file `outcome` made of `sample`: a `jsonl` result that is no list is the call's `runtime` error. */
function* previewFile(
	sample: Sample,
	outcome: TransformOutcome,
	jsonl: boolean,
	meter: Meter
): Steps<TransformPreviewFile> {
	const input = yield* pretty(sample.doc, meter);
	const file = { filename: sample.filename, input, output: null, stdout: '', error: null };
	if (outcome.kind !== 'ok' && outcome.kind !== 'failed') return file;
	if (outcome.kind === 'failed') return { ...file, stdout: outcome.stdout, error: outcome.error };
	if (jsonl && !Array.isArray(outcome.value)) {
		const message = `transform must return a list for jsonl; got ${pyTypeName(outcome.value)}`;
		return {
			...file,
			stdout: outcome.stdout,
			error: { kind: 'runtime', message, traceback: null }
		};
	}
	const output = yield* pretty(outcome.value as JsonOut, meter);
	return { ...file, output, stdout: outcome.stdout };
}

/**
 * The route's body without `duration_ms`. Before the first step it reads the
 * entry, `date` and `project` (the split filenames' `${date}` and `${project}`)
 * and resolves its transform and table through the working copy's artifacts.
 */
export function previewTransform(
	ctx: EvalContext,
	params: ReadParams
): Steps<TransformPreviewBody> {
	const entry = readExporterEntry(params['entry'], 'entry');
	const context = exportContext(params);
	const { scripts: reader } = ctx;
	const label = entry.name || entry.source.ref;
	const { format } = entry;
	if (!isJsonFamily(format)) throw transformFormatRefusal(label, format);
	if (!hasEntryTransform(entry)) throw new ReadError(422, `${label}: no transform configured`);
	const code = resolveTransformSource(ctx.artifacts, entry.transform!, label);
	const syntaxRefusal = transformSyntaxRefusal(entry.transform!, label);
	const table = ctx.artifacts.resolve(entry.source.ref);
	if (table === null || table.kind !== 'table') {
		throw new ReadError(422, `missing table(s) for entries: ${label}`);
	}
	const defn = resolved(ctx.artifacts, entry.source.ref);

	const { model } = ctx;
	const meter = new Meter(0);
	const scripts = tableScripts(ctx, defn);
	const rows = orderedRows(ctx, defn, meter, scripts);
	const renderDefn = overriddenTable(defn, entry);
	const jsonl = format === 'jsonl';

	return answered(
		(function* (): Steps<TransformPreviewBody> {
			const order = yield* rows;
			const layout = exportLayout(renderDefn);
			const eff = exportDefinition(renderDefn);
			const options = jsonOptions(layout, jsonKeyColumn(format, entry.json_doc, defn, label));
			const shape = jsonl ? 'jsonl' : 'json';
			function* cellsOf(keys: readonly RowKey[]): Steps<TableCell[][]> {
				return yield* evaluateCellsSteps(
					model,
					defn,
					keys,
					order.baseSlots,
					EXPORT_TABLE_LIMITS,
					meter,
					new NavMemo(),
					scripts
				);
			}
			function* render(keys: readonly RowKey[], cells: TableCell[][]): Steps<JsonOut> {
				const [docs, docKeys] = yield* renderJsonExSteps(
					model,
					eff,
					keys,
					cells,
					order.baseSlots,
					options,
					meter
				);
				return shapeJsonDocs(shape, docs, docKeys);
			}

			const samples: Sample[] = [];
			let truncated: boolean;
			const split = renderDefn.json_split;
			if (split !== null && split.enabled) {
				const refusal = splitRefusal(format, split);
				if (refusal !== null) throw new ReadError(422, refusal);
				const cells = yield* cellsOf(order.keys);
				const parts = splitPartitions(order.keys);
				const stems = renderFilenames(
					split.filename_template,
					parts.map((part) => partitionLabel(model, part.binding)),
					templateVars(ctx, context)
				);
				for (const [i, part] of parts.slice(0, PREVIEW_MAX_FILES).entries()) {
					const doc = yield* render(
						part.indices.map((idx) => order.keys[idx]!),
						part.indices.map((idx) => cells[idx]!)
					);
					samples.push({ filename: `${stems[i]!}.${format}`, doc });
				}
				truncated = parts.length > PREVIEW_MAX_FILES;
			} else {
				const window = order.keys.slice(0, PREVIEW_MAX_ROWS);
				samples.push({
					filename: `${label}.${format}`,
					doc: yield* render(window, yield* cellsOf(window))
				});
				truncated = order.keys.length > window.length;
			}

			const files: TransformPreviewFile[] = [];
			for (const sample of samples) {
				const outcome = yield* transformSteps(reader, code, sample.doc, label, meter);
				if (outcome.kind === 'syntax') throw new ReadError(422, syntaxRefusal);
				files.push(yield* previewFile(sample, outcome, jsonl, meter));
			}
			return { files, split: split !== null && split.enabled, truncated };
		})()
	);
}
