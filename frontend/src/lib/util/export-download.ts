/**
 * The download both export paths end in: a table export (`downloadTable` in
 * `state/table-editor.svelte.ts`) and an exporter run (`runExport` in
 * `Export/ExporterTab.svelte`).
 */
import type { ExportResult } from '$lib/api/tables';

/**
 * Call `run` once and trigger a browser download of its file via a synthetic
 * anchor click. Resolves to the result.
 */
export async function downloadExport(run: () => Promise<ExportResult>): Promise<ExportResult> {
	const result = await run();
	const url = URL.createObjectURL(result.blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = result.filename;
	a.click();
	URL.revokeObjectURL(url);
	return result;
}
