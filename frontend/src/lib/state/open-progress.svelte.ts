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

// Consecutive 'cold' polls tolerated before giving up (~20s at the default
// 400ms pollMs). A project whose server-side hydration failed reports 'cold'
// forever — without this cap the poll loop (and the token it holds open)
// would never exit, leaving the fixed inset-0 overlay blocking clicks
// permanently.
export const MAX_COLD_POLLS = 50;

// Bumped by cancelOpenProgress() to abort any in-flight poll loop (e.g. a
// failed boot tearing down the overlay, or unmount). Each trackOpenProgress
// call captures the generation at entry and re-checks it every iteration;
// a mismatch means someone else wants this run stopped, so it exits (the
// existing finally -> endProgress cleans up the token).
let _generation = 0;

/** Abort any in-flight trackOpenProgress poll loop and tear down its overlay token. */
export function cancelOpenProgress(): void {
	_generation++;
}

export async function trackOpenProgress(pollMs = 400): Promise<void> {
	const pid = getActiveProjectId();
	const generation = _generation;
	let token: number | null = null;
	let consecutiveCold = 0;
	try {
		for (;;) {
			if (_generation !== generation) return; // cancelled
			if (getActiveProjectId() !== pid) return; // navigated away
			let status;
			try {
				status = await getModelStatus();
			} catch {
				return; // status is best-effort; never block or crash boot
			}
			if (status.state === 'ready' || status.state === 'empty') break;
			if (status.state === 'cold') {
				consecutiveCold++;
				if (consecutiveCold > MAX_COLD_POLLS) return; // hydration never progressed; stop polling
			} else {
				consecutiveCold = 0;
			}
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
