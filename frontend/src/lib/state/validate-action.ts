import * as validationApi from '$lib/api/validation';
import { getBaseline } from './baseline.svelte';
import { setActiveTab } from './workspace.svelte';
import {
	isRunning,
	setIssues,
	setLastError,
	setRunning
} from './validation.svelte';
import { getWorkingModel } from './working.svelte';

/**
 * Run the inline-validation endpoint against the current working model.
 * No-op if no baseline is loaded or a run is already in flight.
 *
 * On success: switches the workspace tab to "issues" and stores the result.
 * On error: stores the error message and logs to console.
 */
export async function runValidation(): Promise<void> {
	const baseline = getBaseline();
	if (baseline === null) return;
	if (isRunning()) return;
	setRunning(true);
	setLastError(null);
	try {
		const working = getWorkingModel();
		const issues = await validationApi.validateModel({
			inline: {
				elements: working.elements,
				relationships: working.relationships
			}
		});
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
