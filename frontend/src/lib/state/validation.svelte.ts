import type { Issue } from '$lib/api/types';

/**
 * The Validate OVERLAY store (F-4/U-8 redesign, spec 2026-08-12).
 *
 * The live committed issue list lives in model.svelte.ts (`_issuesByOwner`,
 * fed by open-time adoption, commit-delta splices, and refetches). This store
 * holds only the origin-tagged snapshot of the last EXPLICIT Validate run —
 * the one view that can show 'uncommitted' and 'resolved' issues, because it
 * validated the staged (uncommitted) edits. `null` means "no overlay": render
 * live. Any adoption of committed truth clears it (see adoptIssues/applyDelta
 * in model.svelte.ts) — the stage it described no longer matches reality.
 */
let _overlay: Issue[] | null = $state(null);
let _lastRunAt: number | null = $state(null);
let _running: boolean = $state(false);
let _lastError: string | null = $state(null);

export function getOverlay(): readonly Issue[] | null {
	return _overlay;
}

export function getLastRunAt(): number | null {
	return _lastRunAt;
}

export function isRunning(): boolean {
	return _running;
}

export function getLastError(): string | null {
	return _lastError;
}

export function setOverlay(issues: Issue[]): void {
	_overlay = issues;
	_lastRunAt = Date.now();
	_lastError = null;
}

export function setRunning(b: boolean): void {
	_running = b;
}

export function setLastError(message: string | null): void {
	_lastError = message;
}

/** Drop the overlay. Three callers, all "the model this snapshot described is
 * gone": `adoptIssues`/`applyDelta` in model.svelte.ts (committed truth moved),
 * `resetModelStore` (a different model is being installed), and `boot()` in the
 * project page (an in-SPA project switch, which does not reset the store).
 * Keeps `_lastError`: a failed Validate's error strip must survive a peer
 * commit. */
export function clearOverlay(): void {
	_overlay = null;
	_lastRunAt = null;
}
