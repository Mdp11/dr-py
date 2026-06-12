import { getModelSummary, validateAll } from './model.svelte';
import { setActiveTab } from './workspace.svelte';
import { isRunning, setIssues, setLastError, setRunning } from './validation.svelte';

/**
 * Run a full validation of the SESSION model via the store's `validateAll()`
 * (which flushes pending ops first and reseeds the server-side issue store,
 * so subsequent ops deltas carry exact issue splices).
 * No-op if no model is loaded or a run is already in flight.
 *
 * On success: switches the workspace tab to "issues" and stores the result.
 * On error: stores the error message and logs to console.
 */
export async function runValidation(): Promise<void> {
	if (getModelSummary() === null) return;
	if (isRunning()) return;
	setRunning(true);
	setLastError(null);
	try {
		const issues = await validateAll();
		setIssues(issues);
		setActiveTab('issues');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('Validation failed', err);
		setLastError(message);
	} finally {
		setRunning(false);
	}
}
