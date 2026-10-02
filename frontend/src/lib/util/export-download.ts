/**
 * The download both export paths end in: `/tables/export` (`downloadTable` in
 * `state/table-editor.svelte.ts`) and `/exports/run` (`runExport` in
 * `Export/ExporterTab.svelte`). Also the fallback note both callers' chrome
 * shows.
 */
import type { Fallback } from '$lib/api/engine-route';
import type { ExportResult } from '$lib/api/tables';

/** Why an export the engine refused is the server's file, of committed state. */
export const EXPORT_FALLBACK_NOTE = {
	pattern: 'Exported from committed state: a search pattern needs the server'
} as const satisfies Record<Exclude<Fallback, 'rules'>, string>;

/**
 * Call `run` once and trigger a browser download of its file via a synthetic
 * anchor click. Resolves to the result, with its marks.
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
