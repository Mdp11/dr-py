import { apiFetchRaw, type ClientConfig } from './client';
import { parseAttachmentFilename, type ExportResult } from './tables';

/**
 * Run a saved `kind='custom_export'` artifact (`POST /exports/run`) and
 * return its zip. The artifact id travels in the request BODY, not the path
 * — `authz._READ_ONLY_POST_SUFFIXES` matches fixed path suffixes, so an id in
 * the path would make the route unmatched and therefore not viewer-callable;
 * running an export is read-only and must work for viewers.
 *
 * Mirrors `exportTable`'s 202 protocol exactly: THE STATUS CODE IS THE RETRY
 * SIGNAL, never the body's `state` — a 202 means the background script-cache
 * sweep hasn't finished computing every cell across the bundled tables yet.
 */
export async function runCustomExport(
	artifactId: string,
	cfg?: ClientConfig
): Promise<ExportResult> {
	const res = await apiFetchRaw(
		'/exports/run',
		{ method: 'POST', body: { artifact_id: artifactId } },
		cfg
	);
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
