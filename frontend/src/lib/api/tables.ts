import { utcDate } from '$lib/util/utc-date';
import { activeProjectId, apiFetch, apiFetchRaw, type ClientConfig } from './client';
import { asSent, route, type Fallback, type Side } from './engine-route';
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

/** The pages the engine answered; every other page is the server's. */
const enginePages = new WeakSet<TablePage>();

/**
 * The side that answered `page`, as `evaluateTable` returned it: the engine
 * holds the staged state, the server the committed one, so two pages of
 * different sides are never one table's rows.
 */
export function answeredBy(page: TablePage): Side {
	return enginePages.has(page) ? 'engine' : 'server';
}

/**
 * POST /tables/evaluate, the `tables` surface: the engine answers from the
 * working copy, staged edits and artifacts included; a table it refuses (a
 * script, a pattern) is the server's page, on committed state, marked with
 * why; one the engine cannot answer at all (its worker gone, its replica
 * rebuilt under it) is the server's page, unmarked. `signal` aborts the call
 * on either side; `answeredBy` says which side answered.
 */
export function evaluateTable(
	args: EvaluateArgs & { signal?: AbortSignal },
	cfg?: ClientConfig
): Promise<TablePage> {
	const body = {
		definition: args.definition,
		artifact_id: args.artifactId,
		offset: args.offset ?? 0,
		limit: args.limit ?? 100
	};
	const { signal } = args;
	return route(
		'tables',
		cfg,
		(call) =>
			call('evaluateTable', asSent(body), signal).then((answer) => {
				const page = TablePageSchema.parse(answer);
				enginePages.add(page);
				return page;
			}),
		() =>
			apiFetch(
				'/tables/evaluate',
				{
					method: 'POST',
					body,
					schema: TablePageSchema,
					...(signal === undefined ? {} : { signal })
				},
				cfg
			),
		{ mark: (page, reason) => ({ ...page, fallback: reason }) }
	);
}

/**
 * A finished export: whether rows were left out (`truncated`) and, when the
 * engine sent it to the server, why (`fallback`): it then holds the committed
 * state, not the staged one.
 */
export type ExportResult = {
	kind: 'ready';
	blob: Blob;
	filename: string;
	truncated?: boolean;
	fallback?: Exclude<Fallback, 'rules'>;
};

/**
 * The file name a response's `Content-Disposition` gives (e.g.
 * `attachment; filename="table.xlsx"`): its RFC 5987 `filename*` percent-
 * decoded when it carries one (the server adds it for a name outside
 * ASCII, beside a `filename` with those characters replaced), else its
 * `filename`. `undefined` when the header is absent or unparseable — callers
 * supply their own fallback name. Shared by every download-shaped route
 * ({@link exportTable}, `api/exports.ts`'s `runExporter`).
 */
export function parseAttachmentFilename(res: Response): string | undefined {
	const disp = res.headers.get('content-disposition') ?? '';
	const encoded = /filename\*=UTF-8''([^;\s]+)/i.exec(disp)?.[1];
	if (encoded !== undefined) {
		try {
			return decodeURIComponent(encoded);
		} catch {
			// A malformed escape: the plain name still stands.
		}
	}
	return /filename="([^"]+)"/.exec(disp)?.[1];
}

/**
 * A download route's answer: the file, named by its `Content-Disposition` or
 * `fallbackName`, truncated when `X-Table-Truncated` says so.
 */
export async function exportResponse(res: Response, fallbackName: string): Promise<ExportResult> {
	return {
		kind: 'ready',
		blob: await res.blob(),
		filename: parseAttachmentFilename(res) ?? fallbackName,
		truncated: res.headers.get('x-table-truncated') === 'true'
	};
}

/** The file an export method of the engine answered, as the server's would read. */
export function engineExport(answer: unknown): ExportResult {
	const file = EngineExportFileSchema.parse(answer);
	return {
		kind: 'ready',
		blob: new Blob(file.parts, { type: file.content_type }),
		filename: file.filename,
		truncated: file.truncated
	};
}

/** Marks a file the server answered for the engine, with why. */
export function markExport(result: ExportResult, reason: Exclude<Fallback, 'rules'>): ExportResult {
	return { ...result, fallback: reason };
}

/** An export's `date` and `project` on the engine: the server reads its own clock and URL. */
export function exportContext(): { date: string; project: string } {
	return { date: utcDate(), project: activeProjectId() ?? '' };
}

const ZIP = 'application/zip';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** `type` without its parameters: a browser's `res.blob()` keeps only the media type of a fetched body. */
export function mediaType(type: string): string {
	return (type.split(';')[0] ?? '').trim();
}

function decoded(bytes: Uint8Array): string {
	return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

/**
 * What the dev shadow compares of an export: its name, media type
 * (without parameters) and `truncated`, and a `body` that is the text of a
 * JSON, JSONL or CSV file, a zip's members in order as `[path, text]` (an xlsx member `[path,
 * 'xlsx']`), and nothing for an xlsx — the engine's workbooks and zips are
 * not the server's bytes.
 */
export async function exportDigest(result: ExportResult): Promise<unknown> {
	const contentType = mediaType(result.blob.type);
	const digest = {
		filename: result.filename,
		content_type: contentType,
		truncated: result.truncated ?? false
	};
	if (contentType === XLSX) return digest;
	const bytes = new Uint8Array(await result.blob.arrayBuffer());
	if (contentType !== ZIP) return { ...digest, body: decoded(bytes) };
	const { unzipSync } = await import('fflate');
	const members = Object.entries(unzipSync(bytes)).map(([path, data]) => [
		path,
		path.endsWith('.xlsx') ? 'xlsx' : decoded(data)
	]);
	return { ...digest, body: members };
}

/**
 * Export the current definition (or saved artifact) in any `ExportFormat`
 * (`POST /tables/export`), the `exports` surface: the engine answers from
 * the working copy, staged edits and artifacts included; a table it refuses
 * (a script, a pattern) is the server's file, on committed state, marked
 * with why. A table with a script is refused with a 409 `scripts need the
 * engine` on the server. `signal` aborts the call on either side.
 */
export function exportTable(
	args: {
		definition?: TableDefinition;
		artifactId?: string;
		format?: ExportFormat;
		signal?: AbortSignal;
	},
	cfg?: ClientConfig
): Promise<ExportResult> {
	const format = args.format ?? 'xlsx';
	const body = { definition: args.definition, artifact_id: args.artifactId, format };
	const { signal } = args;
	return route(
		'exports',
		cfg,
		(call) =>
			call('exportTable', { ...(asSent(body) as object), ...exportContext() }, signal).then(
				engineExport
			),
		async () =>
			exportResponse(
				await apiFetchRaw(
					'/tables/export',
					{ method: 'POST', body, ...(signal === undefined ? {} : { signal }) },
					cfg
				),
				`table.${format}`
			),
		{ mark: markExport, digest: exportDigest }
	);
}

/**
 * A bounded, already-rendered JSON sample for the export settings pane
 * (`POST /tables/json-preview`), the `exports` surface.
 *
 * The sample is rendered through the very function the export uses, on the
 * side the export takes, so the pane can never disagree with the file the
 * user downloads. `truncated` means the sample covers only the head of the
 * table.
 */
export function previewTableJson(
	args: { definition?: TableDefinition; artifactId?: string },
	cfg?: ClientConfig
): Promise<JsonPreview & { fallback?: Exclude<Fallback, 'rules'> }> {
	const body = { definition: args.definition, artifact_id: args.artifactId };
	return route(
		'exports',
		cfg,
		(call) =>
			call('previewTableJson', asSent(body)).then((answer) => JsonPreviewSchema.parse(answer)),
		() =>
			apiFetch('/tables/json-preview', { method: 'POST', body, schema: JsonPreviewSchema }, cfg),
		{ mark: (preview, reason) => ({ ...preview, fallback: reason }) }
	);
}

/**
 * Every failing script cell in the WHOLE table, with the grid position to jump
 * to (`POST /tables/script-errors`, the `tables` surface). The grid is
 * virtualized, so the client only ever holds a window of rows — this route is
 * the only complete answer.
 *
 * `row_index` is only a valid grid address for the `(definition, model_rev)`
 * the page was rendered with — the definition carries the sort — so the caller
 * must send the definition the grid is showing.
 */
export function fetchScriptErrors(
	args: Omit<EvaluateArgs, 'offset' | 'limit'> & { signal?: AbortSignal },
	cfg?: ClientConfig
): Promise<ScriptErrorsRecap> {
	const body = { definition: args.definition, artifact_id: args.artifactId };
	const { signal } = args;
	return route(
		'tables',
		cfg,
		(call) => call('tableScriptErrors', asSent(body), signal) as Promise<ScriptErrorsRecap>,
		() =>
			apiFetch<ScriptErrorsRecap>(
				'/tables/script-errors',
				{ method: 'POST', body, ...(signal === undefined ? {} : { signal }) },
				cfg
			)
	);
}
