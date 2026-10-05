import { utcDate } from '$lib/util/utc-date';
import { activeProjectId } from './client';
import { asSent, route } from './engine-route';
import {
	EngineExportFileSchema,
	JsonPreviewSchema,
	TablePageSchema,
	type ExportFormat,
	type JsonPreview,
	type ScriptErrorsRecap,
	type TableDefinition,
	type TablePage
} from './types';

interface EvaluateArgs {
	definition?: TableDefinition;
	artifactId?: string;
	offset?: number;
	limit?: number;
}

/**
 * Evaluates a table over the replica's working copy, staged edits and
 * artifacts included. `signal` aborts the call.
 */
export function evaluateTable(args: EvaluateArgs & { signal?: AbortSignal }): Promise<TablePage> {
	const body = {
		definition: args.definition,
		artifact_id: args.artifactId,
		offset: args.offset ?? 0,
		limit: args.limit ?? 100
	};
	const { signal } = args;
	return route<unknown>('evaluateTable', asSent(body), signal === undefined ? {} : { signal }).then(
		(answer) => TablePageSchema.parse(answer)
	);
}

/** A finished export, and whether rows were left out (`truncated`). */
export type ExportResult = {
	kind: 'ready';
	blob: Blob;
	filename: string;
	truncated?: boolean;
};

/** The file an export method of the engine answered. */
export function engineExport(answer: unknown): ExportResult {
	const file = EngineExportFileSchema.parse(answer);
	return {
		kind: 'ready',
		blob: new Blob(file.parts, { type: file.content_type }),
		filename: file.filename,
		truncated: file.truncated
	};
}

/** An export's `date` and `project`: the engine has neither clock nor URL of its own. */
export function exportContext(): { date: string; project: string } {
	return { date: utcDate(), project: activeProjectId() ?? '' };
}

/**
 * Export the current definition (or saved artifact) in any `ExportFormat`,
 * from the working copy, staged edits and artifacts included. `signal` aborts
 * the call.
 */
export function exportTable(args: {
	definition?: TableDefinition;
	artifactId?: string;
	format?: ExportFormat;
	signal?: AbortSignal;
}): Promise<ExportResult> {
	const format = args.format ?? 'xlsx';
	const body = { definition: args.definition, artifact_id: args.artifactId, format };
	const { signal } = args;
	return route<unknown>(
		'exportTable',
		{ ...(asSent(body) as object), ...exportContext() },
		signal === undefined ? {} : { signal }
	).then(engineExport);
}

/**
 * A bounded, already-rendered JSON sample for the export settings pane,
 * rendered through the very function the export uses, so the pane can never
 * disagree with the file the user downloads. `truncated` means the sample
 * covers only the head of the table.
 */
export function previewTableJson(args: {
	definition?: TableDefinition;
	artifactId?: string;
}): Promise<JsonPreview> {
	const body = { definition: args.definition, artifact_id: args.artifactId };
	return route<unknown>('previewTableJson', asSent(body)).then((answer) =>
		JsonPreviewSchema.parse(answer)
	);
}

/**
 * Every failing script cell in the WHOLE table, with the grid position to jump
 * to. The grid is virtualized, so the client only ever holds a window of rows
 * — this call is the only complete answer.
 *
 * `row_index` is only a valid grid address for the `(definition, model_rev)`
 * the page was rendered with — the definition carries the sort — so the caller
 * must send the definition the grid is showing.
 */
export function fetchScriptErrors(
	args: Omit<EvaluateArgs, 'offset' | 'limit'> & { signal?: AbortSignal }
): Promise<ScriptErrorsRecap> {
	const body = { definition: args.definition, artifact_id: args.artifactId };
	const { signal } = args;
	return route<ScriptErrorsRecap>(
		'tableScriptErrors',
		asSent(body),
		signal === undefined ? {} : { signal }
	);
}
