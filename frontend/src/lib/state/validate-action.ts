import { getModelSummary, validateAll } from './model.svelte';
import { setActiveTab } from './workspace.svelte';
import { isRunning, setIssues, setLastError, setRunning } from './validation.svelte';
import { ConflictError } from '$lib/api/errors';
import { setModelError } from './model.svelte';

/**
 * Run a full validation that INCLUDES staged (uncommitted) edits via the store's
 * `validateAll()`. On success: switch the workspace tab to "issues" and store the
 * origin-tagged result. A 409 (the committed rev advanced under us, e.g. a peer
 * commit) marks the store conflicted so the UI prompts a reload. Other errors are
 * stored as the panel's lastError. No-op if no model is loaded or a run is in flight.
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
		if (err instanceof ConflictError) {
			setModelError({
				kind: 'conflict',
				message: 'Model changed on the server. Reload to continue.'
			});
			setLastError('Model changed on the server — reload to validate.');
		} else {
			const message = err instanceof Error ? err.message : String(err);
			console.error('Validation failed', err);
			setLastError(message);
		}
	} finally {
		setRunning(false);
	}
}
