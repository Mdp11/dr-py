import { apiFetch, apiFetchRaw, type ClientConfig } from './client';
import { asSent, route } from './engine-route';
import {
	engineExport,
	exportContext,
	exportDigest,
	exportResponse,
	markExport,
	type ExportResult
} from './tables';
import {
	TransformPreviewOutSchema,
	type ExporterDefinition,
	type ExporterEntry,
	type TransformPreviewOut
} from './types';

/**
 * `POST /exports/run` with `body`, the `exports` surface: the engine runs
 * `method` over the working copy, staged edits and artifacts included; a run
 * any of whose entries reaches a script is the server's file, on committed
 * state, marked with why.
 */
function run(
	method: 'runExporter' | 'runExporterDraft',
	body: object,
	cfg: ClientConfig | undefined
): Promise<ExportResult> {
	return route(
		'exports',
		cfg,
		(call) => call(method, { ...(asSent(body) as object), ...exportContext() }).then(engineExport),
		async () =>
			exportResponse(
				await apiFetchRaw('/exports/run', { method: 'POST', body }, cfg),
				'export.zip'
			),
		{ mark: markExport, digest: exportDigest }
	);
}

/**
 * Run a saved `kind='exporter'` artifact (`POST /exports/run`) and
 * return its zip. The artifact id travels in the request BODY, not the path
 * — `authz._READ_ONLY_POST_SUFFIXES` matches fixed path suffixes, so an id in
 * the path would make the route unmatched and therefore not viewer-callable;
 * running an export is read-only and must work for viewers.
 *
 * Mirrors `exportTable`'s 202 protocol exactly: THE STATUS CODE IS THE RETRY
 * SIGNAL, never the body's `state` — a 202 means the background script-cache
 * sweep hasn't finished computing every cell across the bundled tables yet.
 */
export function runExporter(artifactId: string, cfg?: ClientConfig): Promise<ExportResult> {
	return run('runExporter', { artifact_id: artifactId }, cfg);
}

/**
 * Run a STAGED exporter draft (`POST /exports/run` with an inline
 * `definition`) — how the Export button works for a dirty or
 * never-committed draft. `name` stands in for the artifact name (zip-stem
 * fallback, manifest `artifact_name`). Same 202 protocol as `runExporter`;
 * the draft is validated exactly like a committed payload, so the 422s
 * (missing table, bad template) surface identically.
 */
export function runExporterDraft(
	definition: ExporterDefinition,
	name: string,
	cfg?: ClientConfig
): Promise<ExportResult> {
	return run('runExporterDraft', { definition, name }, cfg);
}

/**
 * Dry-run ONE exporter entry's `transform(doc)` (`POST /exports/preview-transform`)
 * — the entry's Test button. Unsplit, over a bounded sample of its table;
 * split, the full run, one call per file the export would write. The entry
 * travels AS DRAFTED (unsaved inline code included); the server renders the
 * documents the way the export would and answers 200 even when the snippet
 * itself fails (that failure is each file's `error` in the body). 422/429/503
 * keep `POST /exports/run`'s meaning: a problem with the entry, no free
 * interactive slot, no runner.
 */
export function previewTransform(
	entry: ExporterEntry,
	cfg?: ClientConfig
): Promise<TransformPreviewOut> {
	return apiFetch(
		'/exports/preview-transform',
		{ method: 'POST', body: { entry }, schema: TransformPreviewOutSchema },
		cfg
	);
}
