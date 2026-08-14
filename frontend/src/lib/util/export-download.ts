/**
 * Shared 202/`Retry-After` retry-and-download loop for every export that
 * reads the backend's cache-only script pass: `/tables/export`
 * (`downloadTable` in `state/table-editor.svelte.ts`) and `/exports/run`
 * (`runExport` in `Export/CustomExportTab.svelte`). THE STATUS CODE
 * IS THE RETRY SIGNAL, never the body's `state` — see either caller's
 * docstring for the full rationale; this module only owns the polling shape,
 * not why it exists.
 *
 * Extracted (P-14 task 12) rather than left duplicated because the two loops
 * were byte-identical apart from the one call that produces the next
 * `ExportResult` — `downloadTable`'s public signature is unchanged by this,
 * so there was no reason to keep a second copy.
 */
import type { ExportResult } from '$lib/api/tables';

/** Delay between two export retries while the backend's script-cache sweep is
 * still computing (202 + Retry-After: 1). */
export const EXPORT_RETRY_MS = 1_000;
/** Bound on export retries so a stuck sweep surfaces an error instead of
 * spinning silently forever (~2 minutes at EXPORT_RETRY_MS). */
export const EXPORT_MAX_ATTEMPTS = 120;

/** Progress of an export that is waiting on the background script sweep. */
export interface ExportProgress {
	done: number;
	total: number | null;
	/** 1-based retry number, so a caller can show "still preparing". */
	attempt: number;
}

/**
 * Call `run` until it resolves `{kind: 'ready'}`, then trigger a browser
 * download via a synthetic anchor click. `run` is invoked once up front and
 * again after each `EXPORT_RETRY_MS` wait while the result stays
 * `'preparing'`, reporting each wait through `onProgress`. Retries are
 * bounded (`EXPORT_MAX_ATTEMPTS`) so a wedged sweep ends in a visible error
 * rather than an invisible infinite loop, and the wait is abandoned early
 * when `signal` aborts (the caller's tab/dialog went away mid-wait).
 */
export async function retryAndDownload(
	run: () => Promise<ExportResult>,
	opts?: {
		onProgress?: (p: ExportProgress) => void;
		signal?: AbortSignal;
	}
): Promise<void> {
	let result = await run();
	for (let attempt = 1; result.kind === 'preparing'; attempt++) {
		if (opts?.signal?.aborted) return;
		if (attempt > EXPORT_MAX_ATTEMPTS) {
			throw new Error('Export is still being prepared — try again shortly.');
		}
		opts?.onProgress?.({ done: result.done, total: result.total, attempt });
		await new Promise((r) => setTimeout(r, EXPORT_RETRY_MS));
		if (opts?.signal?.aborted) return;
		result = await run();
	}
	const url = URL.createObjectURL(result.blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = result.filename;
	a.click();
	URL.revokeObjectURL(url);
}
