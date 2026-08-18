import { getModelSummary, validateAll } from './model.svelte';
import { openIssuesTab } from './workspace.svelte';
import { isRunning, setOverlay, setLastError, setRunning } from './validation.svelte';
import { ConflictError } from '$lib/api/errors';
import { setModelError } from './model.svelte';

/**
 * Run a full validation that INCLUDES staged (uncommitted) edits via the store's
 * `validateAll()`. On success: open (or focus) the Issues tab and store the
 * origin-tagged result as the Validate overlay (`setOverlay`) — the one view that
 * can show 'uncommitted'/'resolved' issues. A 409 (the committed rev advanced
 * under us, e.g. a peer commit) marks the store conflicted so the UI prompts a
 * reload. Other errors are stored as the panel's lastError. No-op if no model is
 * loaded or a run is in flight.
 */
export async function runValidation(): Promise<void> {
	if (getModelSummary() === null) return;
	if (isRunning()) return;
	setRunning(true);
	setLastError(null);
	try {
		const issues = await validateAll();
		setOverlay(issues);
		openIssuesTab();
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
