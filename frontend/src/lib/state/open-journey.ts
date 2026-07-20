/**
 * Unified project open/create progress ("the journey"): one entry in the global
 * progress store spanning click → workspace-ready, fed by real upload bytes and
 * `/model/status` polls, with time-based creep filling phases that report no
 * fraction. The controller (added below) contains no Date.now()/Math.random():
 * elapsed time is accumulated from the ticker interval so the store is
 * deterministic under fake timers. This file is the whole journey unit.
 */
import type { ModelStatus } from '$lib/api/model-status';

export type JourneyKind = 'create' | 'open';
export type PhaseName = 'upload' | 'create' | 'hydrate' | 'validate' | 'finalize';
export interface StatusProgress {
	phase: 'hydrate' | 'validate' | 'ready' | 'cold';
	fraction: number | null;
}

/** Reticulating splines — pure flavor text; the bar tells the real story.
 * Fixed order, cycled on a timer. Verbatim per product copy. */
export const SPLINES: readonly string[] = [
	"Asking every arrow where it thinks it's going…",
	'Deciding whether "one" or "many" was the right answer…',
	"Reminding a box that it lives inside another box…",
	"Untangling things that were connected a little too enthusiastically…",
	"Convincing two boxes they can't both be the parent…",
	"Making sure nothing is secretly its own grandparent…",
	"Letting the rules read the model and quietly judge it…",
	"Gently informing a loop that it is, in fact, a loop…",
	"Asking each relationship if it still likes where it ends up…",
	"Convincing the metamodel to stop reflecting on itself for one second…",
	"Reminding the view that it owns nothing and never did…",
	"Running validation, then pretending we didn't see that…",
	"Checking that every element remembered to bring a property…",
	"Asking the metamodel what counts as a relationship today…",
	"Quietly asking validation to be gentle this time…",
	"Sorting the table by a column it didn't know it had…",
	"Widening a column so one property could finally stretch its legs…",
	"Asking a subtree to hold still while we lock the whole family…",
	"Walking the navigation chain so you don't have to…"
];

/** Cycle the splines, wrapping (and tolerating negative indices). */
export function splineAt(index: number): string {
	const n = SPLINES.length;
	return SPLINES[((index % n) + n) % n];
}

/** Asymptotic creep toward `ceil` for phases with no real fraction. */
export function easeToward(floor: number, ceil: number, elapsedMs: number, tau: number): number {
	return ceil - (ceil - floor) * Math.exp(-elapsedMs / tau);
}

/** Never let the displayed percent decrease; cap at 100. */
export function clampMonotonic(candidate: number, last: number): number {
	return Math.max(Math.min(candidate, 100), last);
}

const SLICES: Record<JourneyKind, Record<PhaseName, [number, number]>> = {
	create: {
		upload: [0, 30],
		create: [30, 42],
		hydrate: [42, 80],
		validate: [80, 96],
		finalize: [96, 100]
	},
	// open has no upload/create phases; those slices are unused but kept so the
	// record is total over PhaseName.
	open: {
		upload: [0, 0],
		create: [0, 0],
		hydrate: [0, 72],
		validate: [72, 95],
		finalize: [95, 100]
	}
};

export function phaseSlice(kind: JourneyKind, phase: PhaseName): [number, number] {
	return SLICES[kind][phase];
}

/** Map a `/model/status` poll to a coarse phase + real fraction (null = creep). */
export function statusToProgress(status: ModelStatus): StatusProgress {
	if (status.state === 'validating' && status.validation) {
		const { done, total } = status.validation;
		return { phase: 'validate', fraction: total > 0 ? done / total : null };
	}
	if (status.state === 'hydrating' && status.hydration) {
		const { done, total } = status.hydration;
		return { phase: 'hydrate', fraction: total > 0 ? done / total : null };
	}
	if (status.state === 'ready' || status.state === 'empty') {
		return { phase: 'ready', fraction: 1 };
	}
	if (status.state === 'cold') {
		return { phase: 'cold', fraction: null };
	}
	return { phase: 'hydrate', fraction: null };
}
