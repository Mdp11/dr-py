/**
 * Project-open status poll loop: polls GET /model/status until the backend
 * session is ready and feeds each result into the open-journey controller,
 * which owns the single progress bar. Fired from boot() in parallel with the
 * data requests that actually trigger hydration — the status endpoint itself
 * never hydrates, so polls return immediately.
 *
 * This loop no longer owns a progress token or any user-facing label — that is
 * the journey's job (lib/state/open-journey.ts). It only observes status and
 * decides when to stop (ready/empty, cold-timeout, cancel, or navigation).
 */

import { getModelStatus } from '$lib/api/model-status';
import { getActiveProjectId } from './active-project.svelte';
import { refreshSummary } from './model.svelte';
import { journeyStatus } from './open-journey';

// Consecutive 'cold' polls tolerated before giving up (~20s at the default
// 400ms pollMs). A project whose server-side hydration failed reports 'cold'
// forever; without this cap the poll loop would never exit.
export const MAX_COLD_POLLS = 50;

// Bumped by cancelOpenProgress() to abort any in-flight poll loop. Each
// trackOpenProgress captures the generation at entry and re-checks it every
// iteration; a mismatch means someone wants this run stopped, so it exits.
let _generation = 0;

/** Abort any in-flight trackOpenProgress poll loop. */
export function cancelOpenProgress(): void {
	_generation++;
}

export async function trackOpenProgress(pollMs = 400): Promise<void> {
	const pid = getActiveProjectId();
	const generation = _generation;
	let consecutiveCold = 0;
	let sawWork = false;
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
			sawWork = true;
		}
		journeyStatus(status);
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	journeyStatus({ state: 'ready', model_rev: null });
	// issue counts (and possibly the model itself) landed while we watched
	if (sawWork) await refreshSummary().catch(() => {});
}
