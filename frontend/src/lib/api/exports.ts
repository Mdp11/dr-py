import { asSent, route } from './engine-route';
import { engineExport, exportContext, type ExportResult } from './tables';
import {
	TransformPreviewOutSchema,
	type ExporterDefinition,
	type ExporterEntry,
	type TransformPreviewOut
} from './types';

/**
 * Runs `method` over the working copy, staged edits and artifacts included,
 * with `body`.
 */
function run(method: 'runExporter' | 'runExporterDraft', body: object): Promise<ExportResult> {
	return route<unknown>(method, { ...(asSent(body) as object), ...exportContext() }).then(
		engineExport
	);
}

/** Run a saved `kind='exporter'` artifact and return its zip. */
export function runExporter(artifactId: string): Promise<ExportResult> {
	return run('runExporter', { artifact_id: artifactId });
}

/**
 * Run a STAGED exporter draft (an inline `definition`) — how the Export
 * button works for a dirty or never-committed draft. `name` stands in for the
 * artifact name (zip-stem fallback, manifest `artifact_name`). The draft is
 * validated exactly like a committed payload, so the 422s (missing table, bad
 * template) surface identically.
 */
export function runExporterDraft(
	definition: ExporterDefinition,
	name: string
): Promise<ExportResult> {
	return run('runExporterDraft', { definition, name });
}

/**
 * Dry-run ONE exporter entry's `transform(doc)` — the entry's Test button.
 * Unsplit, over a bounded sample of its table; split, the full run, one call
 * per file the export would write. The entry travels AS DRAFTED (unsaved
 * inline code included); the answer is 200 even when the snippet itself fails
 * (that failure is each file's `error` in the body). 422 is a problem with
 * the entry.
 */
export function previewTransform(entry: ExporterEntry): Promise<TransformPreviewOut> {
	const body = { entry };
	return route<unknown>('previewTransform', {
		...(asSent(body) as object),
		...exportContext()
	}).then((answer) => TransformPreviewOutSchema.parse(answer));
}
