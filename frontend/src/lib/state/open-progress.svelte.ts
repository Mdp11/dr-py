/**
 * Project-open progress tracking (spec §4): polls GET /model/status until the
 * backend session is ready, driving the global progress overlay. Fired from
 * boot() in parallel with the data requests that actually trigger hydration —
 * the status endpoint itself never hydrates, so polls return immediately.
 */

import { getModelStatus } from '$lib/api/model-status';
import { getActiveProjectId } from './active-project.svelte';
import { refreshSummary } from './model.svelte';
import { endProgress, setProgressLabel, startProgress, updateProgress } from './progress.svelte';

export async function trackOpenProgress(pollMs = 400): Promise<void> {
	const pid = getActiveProjectId();
	let token: number | null = null;
	try {
		for (;;) {
			if (getActiveProjectId() !== pid) return; // navigated away
			let status;
			try {
				status = await getModelStatus();
			} catch {
				return; // status is best-effort; never block or crash boot
			}
			if (status.state === 'ready' || status.state === 'empty') break;
			if (token === null) token = startProgress('Opening project…');
			if (status.state === 'validating' && status.validation) {
				setProgressLabel(token, 'Validating model…');
				updateProgress(token, status.validation.done, status.validation.total);
			} else if (status.state === 'hydrating' && status.hydration && status.hydration.total > 0) {
				setProgressLabel(token, 'Loading model…');
				updateProgress(token, status.hydration.done, status.hydration.total);
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
		// issue counts (and possibly the model itself) landed while we watched
		if (token !== null) await refreshSummary().catch(() => {});
	} finally {
		if (token !== null) endProgress(token);
	}
}
