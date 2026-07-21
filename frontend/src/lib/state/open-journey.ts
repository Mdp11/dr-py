/**
 * Unified project open/create progress ("the journey"): one entry in the global
 * progress store spanning click → workspace-ready, fed by real upload bytes and
 * `/model/status` polls, with time-based creep filling phases that report no
 * fraction. The controller (added below) contains no Date.now()/Math.random():
 * elapsed time is accumulated from the ticker interval so the store is
 * deterministic under fake timers. This file is the whole journey unit.
 */
import type { ModelStatus } from '$lib/api/model-status';
import { startProgress, updateProgress, setProgressLabel, endProgress } from './progress.svelte';

export type JourneyKind = 'create' | 'open';
export type PhaseName = 'upload' | 'create' | 'hydrate' | 'validate' | 'finalize';
export interface StatusProgress {
	phase: 'hydrate' | 'validate' | 'ready' | 'cold';
	fraction: number | null;
}

/** Reticulating splines — pure flavor text; the bar tells the real story.
 * Fixed order, cycled on a timer. Verbatim per product copy. */
export const SPLINES: readonly string[] = [
	'Asking every arrow where it thinks it’s going…',
	'Deciding whether “one” or “many” was the right answer…',
	'Reminding a box that it lives inside another box…',
	'Untangling things that were connected a little too enthusiastically…',
	'Convincing two boxes they can’t both be the parent…',
	'Making sure nothing is secretly its own grandparent…',
	'Letting the rules read the model and quietly judge it…',
	'Gently informing a loop that it is, in fact, a loop…',
	'Asking each relationship if it still likes where it ends up…',
	'Convincing the metamodel to stop reflecting on itself for one second…',
	'Reminding the view that it owns nothing and never did…',
	'Running validation, then pretending we didn’t see that…',
	'Checking that every element remembered to bring a property…',
	'Asking the metamodel what counts as a relationship today…',
	'Quietly asking validation to be gentle this time…',
	'Sorting the table by a column it didn’t know it had…',
	'Widening a column so one property could finally stretch its legs…',
	'Asking a subtree to hold still while we lock the whole family…',
	'Walking the navigation chain so you don’t have to…'
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

// Tick cadence (ms). Elapsed time is accumulated from these nominal intervals —
// see the module header for why we avoid Date.now().
const TICK_MS = 80;
const SPLINE_MS = 4200;
// Creep time-constant. Deliberately long: with a short tau the creep pins itself
// to the slice ceil within a few seconds and then *looks frozen* for the whole
// rest of a slow hydrate. A long tau keeps the bar inching for a minute-plus.
const TAU_MS = 6000;
// Per-tick easing toward the target. Real signals (a status poll, a phase
// change) move the *target*; the displayed percent chases it so no update
// teleports the bar.
const SMOOTH = 0.2;
const MIN_STEP = 0.05; // keeps the chase converging instead of crawling forever
const FINISH_MS = 480; // finalize ramps linearly over this, whatever the gap
const MIN_VISIBLE_MS = 600; // floor so a warm open reads as a smooth fill, not a flash

let _active = false;
let _kind: JourneyKind = 'open';
let _phase: PhaseName = 'hydrate';
let _phaseElapsed = 0;
let _totalElapsed = 0;
let _fraction: number | null = null;
let _last = 0;
let _finishing = false;
let _finishStep = 0;
let _splineIndex = 0;
// Anchor for remapping a real fraction onto the *remaining* slice. Without it,
// a creep that ran ahead of the first reported fraction (e.g. displayed 20% of
// the hydrate slice while the server reports 2% done) stalls at that value
// until the real fraction catches up — the long freeze users saw mid-open.
let _anchorPercent: number | null = null;
let _anchorFraction = 0;
let _phaseFloor = 0;
// Clock since the last *changed* signal, for the residual creep between polls.
let _signalElapsed = 0;
let _signalPercent = 0;
let _token: number | null = null;
let _tick: ReturnType<typeof setInterval> | null = null;
let _splineTick: ReturnType<typeof setInterval> | null = null;

function _setPhase(phase: PhaseName, fraction: number | null): void {
	if (phase !== _phase) {
		_phase = phase;
		_phaseElapsed = 0; // restart the creep clock for the new slice
		_phaseFloor = Math.max(phaseSlice(_kind, phase)[0], _last);
		_anchorPercent = null;
		_anchorFraction = 0;
	}
	if (fraction !== _fraction) {
		_signalElapsed = 0;
		_signalPercent = _last;
	}
	_fraction = fraction;
}

/** Where the bar *wants* to be right now, before easing. */
function _targetPercent(): number {
	const [floor, ceil] = phaseSlice(_kind, _phase);
	if (_fraction === null) {
		_anchorPercent = null; // a phase can drop back to creeping
		return easeToward(Math.max(floor, _phaseFloor), ceil, _phaseElapsed, TAU_MS);
	}
	if (_anchorPercent === null) {
		_anchorPercent = Math.max(_last, floor);
		_anchorFraction = _fraction;
	}
	// Two readings of the same fraction: the plain slice mapping (right when the
	// server is ahead of us) and the anchored remap of the *remaining* slice
	// (right when the creep ran ahead of the server). Whichever is further along.
	const span = 1 - _anchorFraction;
	const norm = span <= 0 ? 1 : Math.min(1, Math.max(0, (_fraction - _anchorFraction) / span));
	const base = Math.max(
		floor + _fraction * (ceil - floor),
		_anchorPercent + norm * (ceil - _anchorPercent)
	);
	// Between two polls the fraction is constant; keep inching into a slice of
	// what's left so a slow server still reads as "working", not "hung".
	const soft = base + 0.25 * (ceil - base);
	return Math.max(base, easeToward(Math.max(base, _signalPercent), soft, _signalElapsed, TAU_MS));
}

/** Ease the displayed percent toward `target` (never backwards). */
function _approach(display: number, target: number): number {
	if (target <= display) return display;
	const gap = target - display;
	return Math.min(target, display + Math.max(gap * SMOOTH, Math.min(MIN_STEP, gap)));
}

function _stop(): void {
	if (_tick !== null) clearInterval(_tick);
	if (_splineTick !== null) clearInterval(_splineTick);
	if (_token !== null) endProgress(_token);
	_tick = null;
	_splineTick = null;
	_token = null;
	_active = false;
	_finishing = false;
	_finishStep = 0;
	_phaseElapsed = 0;
	_totalElapsed = 0;
	_fraction = null;
	_last = 0;
	_splineIndex = 0;
	_anchorPercent = null;
	_anchorFraction = 0;
	_phaseFloor = 0;
	_signalElapsed = 0;
	_signalPercent = 0;
}

function _onTick(): void {
	if (!_active || _token === null) return;
	_phaseElapsed += TICK_MS;
	_signalElapsed += TICK_MS;
	_totalElapsed += TICK_MS;
	// Finalize ramps linearly so the last stretch takes the same ~half second
	// whether it starts at 95% or (degenerately) at 0% — never a snap to 100.
	const candidate = _finishing
		? Math.min(100, _last + _finishStep)
		: _approach(_last, _targetPercent());
	_last = clampMonotonic(candidate, _last);
	updateProgress(_token, _last, 100);
	if (_finishing && _totalElapsed >= MIN_VISIBLE_MS && _last >= 100) _stop();
}

function _onSplineTick(): void {
	if (!_active || _token === null) return;
	_splineIndex += 1;
	setProgressLabel(_token, splineAt(_splineIndex));
}

/** Start the journey. Idempotent: a no-op if one is already active, so the
 * create flow can start it and the workspace boot() can adopt the same one. */
export function beginJourney(kind: JourneyKind): void {
	if (_active) return;
	_active = true;
	_kind = kind;
	_phase = kind === 'create' ? 'upload' : 'hydrate';
	_phaseElapsed = 0;
	_totalElapsed = 0;
	_fraction = kind === 'create' ? 0 : null;
	_last = 0;
	_finishing = false;
	_finishStep = 0;
	_splineIndex = 0;
	_anchorPercent = null;
	_anchorFraction = 0;
	_phaseFloor = phaseSlice(kind, _phase)[0];
	_signalElapsed = 0;
	_signalPercent = 0;
	_token = startProgress(splineAt(0));
	updateProgress(_token, 0, 100);
	_tick = setInterval(_onTick, TICK_MS);
	_splineTick = setInterval(_onSplineTick, SPLINE_MS);
}

/** Feed real upload bytes (create journey only). */
export function journeyUpload(loaded: number, total: number | null): void {
	if (!_active || _finishing || _kind !== 'create' || _phase !== 'upload') return;
	if (total !== null && total > 0) {
		_setPhase('upload', Math.min(1, loaded / total));
		if (loaded >= total) _setPhase('create', null); // bytes on the wire; server-side parse dominates
	}
}

/** Feed a `/model/status` poll result. */
export function journeyStatus(status: ModelStatus): void {
	if (!_active || _finishing) return;
	const p = statusToProgress(status);
	if (p.phase === 'cold') return; // keep creeping in the current slice
	if (p.phase === 'ready') {
		_setPhase('validate', 1); // push to the validate ceil while boot's last fetches finish
		return;
	}
	_setPhase(p.phase, p.fraction);
}

/** Ramp to 100% (honoring the min visible duration) then tear down. */
export function finishJourney(): void {
	if (!_active) return;
	_finishing = true;
	_setPhase('finalize', 1);
	_finishStep = Math.max(0.5, (100 - _last) / (FINISH_MS / TICK_MS));
}

/** Tear down immediately (error / unmount) with no min-duration hold. */
export function cancelJourney(): void {
	if (!_active) return;
	_stop();
}

/** Test-only teardown; safe when inactive. */
export function resetJourney(): void {
	_stop();
}
