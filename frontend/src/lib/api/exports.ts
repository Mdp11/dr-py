import { apiFetch, apiFetchRaw, type ClientConfig } from './client';
import { parseAttachmentFilename, type ExportResult } from './tables';
import {
	TransformPreviewOutSchema,
	type ExporterDefinition,
	type ExporterEntry,
	type TransformPreviewOut
} from './types';

async function handleRunResponse(res: Response): Promise<ExportResult> {
	if (res.status === 202) {
		const body = (await res.json()) as { done?: number; total?: number | null };
		return { kind: 'preparing', done: body.done ?? 0, total: body.total ?? null };
	}
	return {
		kind: 'ready',
		blob: await res.blob(),
		filename: parseAttachmentFilename(res) ?? 'export.zip'
	};
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
export async function runExporter(artifactId: string, cfg?: ClientConfig): Promise<ExportResult> {
	const res = await apiFetchRaw(
		'/exports/run',
		{ method: 'POST', body: { artifact_id: artifactId } },
		cfg
	);
	return handleRunResponse(res);
}

/**
 * Run a STAGED exporter draft (`POST /exports/run` with an inline
 * `definition`) — how the Export button works for a dirty or
 * never-committed draft. `name` stands in for the artifact name (zip-stem
 * fallback, manifest `artifact_name`). Same 202 protocol as `runExporter`;
 * the server validates the draft exactly like a committed payload, so the
 * 422s (missing table, bad template) surface identically.
 */
export async function runExporterDraft(
	definition: ExporterDefinition,
	name: string,
	cfg?: ClientConfig
): Promise<ExportResult> {
	const res = await apiFetchRaw(
		'/exports/run',
		{ method: 'POST', body: { definition, name } },
		cfg
	);
	return handleRunResponse(res);
}

/**
 * Dry-run ONE exporter entry's `transform(doc)` over a bounded sample of its
 * table (`POST /exports/preview-transform`) — the entry's Test button. The
 * entry travels AS DRAFTED (unsaved inline code included); the server
 * renders the sample the way the export would and answers 200 even when the
 * snippet itself fails (that failure is `error` in the body). 422/429/503
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
