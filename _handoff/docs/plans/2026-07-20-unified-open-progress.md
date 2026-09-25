# Unified project open/create progress bar + reticulating splines — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragmented spinners/labels across project **create** and **open** with a single monotonic progress bar that spans the whole `click → workspace ready` journey and shows rotating "reticulating splines" flavor text instead of literal phase labels.

**Architecture:** A new frontend-only controller (`lib/state/open-journey.ts`) owns exactly one entry in the existing global progress store for the entire journey. It survives the client-side `goto()` navigation (module state persists in this `ssr=false` SPA). Real signals (XHR upload bytes, `GET /model/status` hydration/validation `done/total`) map into per-phase percentage slices; phases without a real fraction ease forward with time-based asymptotic creep; a monotonic clamp guarantees the bar never reverses. A ticker cycles the splines. No backend changes.

**Tech Stack:** SvelteKit 5 (runes), TypeScript, Vitest + happy-dom + MSW, Playwright (e2e).

## Global Constraints

- Frontend only — **no backend changes**. `GET /model/status` already exposes every signal consumed.
- The controller module must contain **no `Date.now()` / `Math.random()`**: elapsed time is accumulated from the ticker interval (nominal `TICK_MS` per fire) and spline order is a fixed constant. This keeps the store deterministically testable under fake timers.
- The 19 splines strings must appear **verbatim** (copy exactly, including the trailing `…` ellipsis character, not `...`).
- All literal phase strings (`Uploading project files…`, `Processing files…`, `Opening project…`, `Downloading model…`, `Parsing model…`, `Loading model…`, `Replaying changes…`, `Validating model…`) are **deleted**.
- `LoadFilesDialog.svelte` is **out of scope** and must keep working on the plain generic progress store — do not touch it.
- `ProgressOverlay.svelte` and `project-open.svelte.ts` are **not modified** (the overlay already renders `label + percent + bar`; the tree-skeleton boolean is orthogonal).
- Frontend commands run **inside `frontend/`**: `pixi run -e frontend bash -c 'cd frontend && <cmd>'`.
- Phase→slice budgets (locked in the approved spec):

  | Journey    | upload | create | hydrate | validate | finalize |
  | ---------- | ------ | ------ | ------- | -------- | -------- |
  | **create** | 0–30   | 30–42  | 42–80   | 80–96    | 96–100   |
  | **open**   | —      | —      | 0–72    | 72–95    | 95–100   |

---

## File Structure

- **Create** `frontend/src/lib/state/open-journey.ts` — the whole journey unit: `SPLINES` constant, pure helpers (`easeToward`, `clampMonotonic`, `phaseSlice`, `statusToProgress`, `splineAt`), and the impure controller (`beginJourney`, `journeyUpload`, `journeyStatus`, `finishJourney`, `cancelJourney`, `resetJourney`) driving the existing progress store via two `setInterval` tickers.
- **Create** `frontend/src/lib/state/__tests__/open-journey.test.ts` — pure-helper + controller tests.
- **Modify** `frontend/src/lib/state/open-progress.svelte.ts` — `trackOpenProgress` becomes a thin poll loop that feeds `journeyStatus` (no token/label ownership); keeps `MAX_COLD_POLLS` + cancel generation.
- **Modify** `frontend/src/lib/state/__tests__/open-progress.test.ts` — rewritten to the journey-feeding behavior.
- **Modify** `frontend/src/lib/components/projects/NewProjectWizard.svelte` — `beginJourney('create')` + `journeyUpload` + `cancelJourney` on error; remove old progress calls.
- **Modify** `frontend/src/lib/components/__tests__/NewProjectWizard.test.ts` — add journey cleanup + an error-tears-down-bar assertion.
- **Modify** `frontend/src/routes/projects/+page.svelte` — `open(id)` calls `beginJourney('open')` before `goto`.
- **Modify** `frontend/src/routes/p/[projectId]/+page.svelte` — `boot()` adopts/starts the journey, finishes it, cancels on error/unmount.
- **Modify** `frontend/src/lib/state/index.ts` — export the journey API.

---

### Task 0: Create the feature branch

- [ ] **Step 1: Branch off main**

The repo is on the default branch `main`; do not commit feature work there.

```bash
cd /home/mdp/workspace/data-rover-py && git checkout -b feat/unified-open-progress
```

Expected: `Switched to a new branch 'feat/unified-open-progress'`.

---

### Task 1: Pure helpers + SPLINES constant

**Files:**
- Create: `frontend/src/lib/state/open-journey.ts` (pure portion only in this task)
- Test: `frontend/src/lib/state/__tests__/open-journey.test.ts`

**Interfaces:**
- Consumes: `ModelStatus` from `$lib/api/model-status`.
- Produces (relied on by Task 2 and Task 3):
  - `type JourneyKind = 'create' | 'open'`
  - `type PhaseName = 'upload' | 'create' | 'hydrate' | 'validate' | 'finalize'`
  - `interface StatusProgress { phase: 'hydrate' | 'validate' | 'ready' | 'cold'; fraction: number | null }`
  - `const SPLINES: readonly string[]` (19 entries)
  - `splineAt(index: number): string`
  - `easeToward(floor: number, ceil: number, elapsedMs: number, tau: number): number`
  - `clampMonotonic(candidate: number, last: number): number`
  - `phaseSlice(kind: JourneyKind, phase: PhaseName): [number, number]`
  - `statusToProgress(status: ModelStatus): StatusProgress`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/open-journey.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	SPLINES,
	splineAt,
	easeToward,
	clampMonotonic,
	phaseSlice,
	statusToProgress
} from '../open-journey';

describe('open-journey pure helpers', () => {
	it('has 19 verbatim splines, first is the arrow line', () => {
		expect(SPLINES).toHaveLength(19);
		expect(SPLINES[0]).toBe('Asking every arrow where it thinks it’s going…');
		expect(SPLINES[18]).toBe('Walking the navigation chain so you don’t have to…');
	});

	it('splineAt wraps and never returns undefined, including negatives', () => {
		expect(splineAt(0)).toBe(SPLINES[0]);
		expect(splineAt(19)).toBe(SPLINES[0]);
		expect(splineAt(20)).toBe(SPLINES[1]);
		expect(splineAt(-1)).toBe(SPLINES[18]);
	});

	it('easeToward approaches ceil asymptotically and never exceeds it', () => {
		expect(easeToward(0, 72, 0, 1200)).toBe(0);
		const mid = easeToward(0, 72, 1200, 1200);
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(72);
		expect(easeToward(0, 72, 100000, 1200)).toBeLessThanOrEqual(72);
	});

	it('clampMonotonic never decreases and caps at 100', () => {
		expect(clampMonotonic(40, 30)).toBe(40);
		expect(clampMonotonic(20, 30)).toBe(30);
		expect(clampMonotonic(150, 30)).toBe(100);
	});

	it('phaseSlice returns the approved budgets', () => {
		expect(phaseSlice('create', 'upload')).toEqual([0, 30]);
		expect(phaseSlice('create', 'hydrate')).toEqual([42, 80]);
		expect(phaseSlice('create', 'finalize')).toEqual([96, 100]);
		expect(phaseSlice('open', 'hydrate')).toEqual([0, 72]);
		expect(phaseSlice('open', 'validate')).toEqual([72, 95]);
		expect(phaseSlice('open', 'finalize')).toEqual([95, 100]);
	});

	it('statusToProgress maps every backend state', () => {
		expect(
			statusToProgress({ state: 'validating', validation: { running: true, done: 5, total: 10 } })
		).toEqual({ phase: 'validate', fraction: 0.5 });
		expect(
			statusToProgress({ state: 'hydrating', hydration: { phase: 'build', done: 3, total: 4 } })
		).toEqual({ phase: 'hydrate', fraction: 0.75 });
		expect(
			statusToProgress({ state: 'hydrating', hydration: { phase: 'download', done: 0, total: 0 } })
		).toEqual({ phase: 'hydrate', fraction: null });
		expect(statusToProgress({ state: 'ready', model_rev: 1 })).toEqual({
			phase: 'ready',
			fraction: 1
		});
		expect(statusToProgress({ state: 'empty' })).toEqual({ phase: 'ready', fraction: 1 });
		expect(statusToProgress({ state: 'cold' })).toEqual({ phase: 'cold', fraction: null });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/open-journey.test.ts'`
Expected: FAIL — `Failed to resolve import "../open-journey"` (module does not exist yet).

- [ ] **Step 3: Write the pure portion of the module**

Create `frontend/src/lib/state/open-journey.ts` (pure exports only for now — the controller lands in Task 2). **Copy the 19 splines verbatim, using the `’` and `…` characters exactly:**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/open-journey.test.ts'`
Expected: PASS (6 tests).

> If Step 1's string assertions fail on the `’`/`…` characters, the copy is wrong — fix the constant, not the test.

- [ ] **Step 5: Commit**

```bash
cd /home/mdp/workspace/data-rover-py && git add frontend/src/lib/state/open-journey.ts frontend/src/lib/state/__tests__/open-journey.test.ts && git commit -m "feat(open-progress): journey pure helpers + reticulating splines"
```

---

### Task 2: Journey controller (tickers + store integration)

**Files:**
- Modify: `frontend/src/lib/state/open-journey.ts` (append the controller)
- Test: `frontend/src/lib/state/__tests__/open-journey.test.ts` (append a controller describe block)

**Interfaces:**
- Consumes: `startProgress`, `updateProgress`, `setProgressLabel`, `endProgress` from `./progress.svelte`; the Task 1 pure helpers.
- Produces (relied on by Tasks 3–6):
  - `beginJourney(kind: JourneyKind): void` — idempotent; no-op if a journey is active.
  - `journeyUpload(loaded: number, total: number | null): void`
  - `journeyStatus(status: ModelStatus): void`
  - `finishJourney(): void`
  - `cancelJourney(): void`
  - `resetJourney(): void` — test-only teardown (safe when inactive).

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/state/__tests__/open-journey.test.ts`:

```ts
import { afterEach, beforeEach, vi } from 'vitest';
import {
	beginJourney,
	journeyUpload,
	journeyStatus,
	finishJourney,
	cancelJourney,
	resetJourney
} from '../open-journey';
import { getActiveProgress, resetProgress } from '../progress.svelte';

describe('open-journey controller', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetProgress();
		resetJourney();
	});
	afterEach(() => {
		resetJourney();
		resetProgress();
		vi.useRealTimers();
	});

	const pct = () => getActiveProgress()?.done ?? null;

	it('starts one entry showing the first spline at 0%', () => {
		beginJourney('open');
		const e = getActiveProgress();
		expect(e).not.toBeNull();
		expect(e?.label).toBe(SPLINES[0]);
		expect(e?.done).toBe(0);
		expect(e?.total).toBe(100);
	});

	it('beginJourney is idempotent — no second entry, kind is preserved', () => {
		beginJourney('create');
		journeyUpload(50, 100); // create-only signal takes effect
		beginJourney('open'); // must no-op (kind stays create)
		journeyUpload(100, 100); // still honored → proves kind is still create
		vi.advanceTimersByTime(80);
		// create/upload slice is [0,30]; 100% bytes → phase advances to create[30,42]
		expect(pct()).toBeGreaterThanOrEqual(30);
	});

	it('open journey creeps in the hydrate slice and never exceeds its ceil', () => {
		beginJourney('open');
		vi.advanceTimersByTime(80 * 200); // long creep
		const p = pct()!;
		expect(p).toBeGreaterThan(0);
		expect(p).toBeLessThanOrEqual(72);
	});

	it('is monotonic across a full open sequence and finishes at 100', () => {
		beginJourney('open');
		const seen: number[] = [];
		const step = () => {
			vi.advanceTimersByTime(80);
			seen.push(pct()!);
		};
		journeyStatus({ state: 'hydrating', hydration: { phase: 'build', done: 1, total: 4 } });
		step();
		journeyStatus({ state: 'validating', validation: { running: true, done: 2, total: 10 } });
		step();
		journeyStatus({ state: 'ready', model_rev: 1 });
		step();
		finishJourney();
		vi.advanceTimersByTime(80 * 20); // past MIN_VISIBLE + fill to 100
		// monotonic non-decrease
		for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
		// teardown after finish
		expect(getActiveProgress()).toBeNull();
	});

	it('rotates the spline label on the spline ticker', () => {
		beginJourney('open');
		expect(getActiveProgress()?.label).toBe(SPLINES[0]);
		vi.advanceTimersByTime(3000);
		expect(getActiveProgress()?.label).toBe(SPLINES[1]);
	});

	it('finishJourney holds the entry for the minimum visible duration', () => {
		beginJourney('open');
		finishJourney();
		vi.advanceTimersByTime(240); // < MIN_VISIBLE_MS (600)
		expect(getActiveProgress()).not.toBeNull();
		vi.advanceTimersByTime(600); // now past the floor
		expect(getActiveProgress()).toBeNull();
	});

	it('cancelJourney tears down immediately with no hold', () => {
		beginJourney('open');
		vi.advanceTimersByTime(80);
		cancelJourney();
		expect(getActiveProgress()).toBeNull();
	});

	it('journeyStatus/journeyUpload are no-ops when inactive', () => {
		journeyStatus({ state: 'ready', model_rev: 1 });
		journeyUpload(1, 2);
		expect(getActiveProgress()).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/open-journey.test.ts'`
Expected: FAIL — `beginJourney is not a function` (controller not implemented).

- [ ] **Step 3: Append the controller to `open-journey.ts`**

First, add the progress-store import at the **top** of `frontend/src/lib/state/open-journey.ts`, directly below the existing `import type { ModelStatus } …` line (a mid-file `import` would fail the `import/first` lint rule):

```ts
import {
	startProgress,
	updateProgress,
	setProgressLabel,
	endProgress
} from './progress.svelte';
```

Then append the controller to the **end** of the file:

```ts
// Tick cadence (ms). Elapsed time is accumulated from these nominal intervals —
// see the module header for why we avoid Date.now().
const TICK_MS = 80;
const SPLINE_MS = 3000;
const TAU_MS = 1200; // creep time-constant: visible motion that decelerates near the ceil
const MIN_VISIBLE_MS = 600; // floor so a warm open reads as a smooth fill, not a flash

let _active = false;
let _kind: JourneyKind = 'open';
let _phase: PhaseName = 'hydrate';
let _phaseElapsed = 0;
let _totalElapsed = 0;
let _fraction: number | null = null;
let _last = 0;
let _finishing = false;
let _splineIndex = 0;
let _token: number | null = null;
let _tick: ReturnType<typeof setInterval> | null = null;
let _splineTick: ReturnType<typeof setInterval> | null = null;

function _setPhase(phase: PhaseName, fraction: number | null): void {
	if (phase !== _phase) {
		_phase = phase;
		_phaseElapsed = 0; // restart the creep clock for the new slice
	}
	_fraction = fraction;
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
	_phaseElapsed = 0;
	_totalElapsed = 0;
	_fraction = null;
	_last = 0;
	_splineIndex = 0;
}

function _onTick(): void {
	if (!_active || _token === null) return;
	_phaseElapsed += TICK_MS;
	_totalElapsed += TICK_MS;
	const [floor, ceil] = phaseSlice(_kind, _phase);
	const candidate =
		_fraction !== null
			? floor + _fraction * (ceil - floor)
			: easeToward(floor, ceil, _phaseElapsed, TAU_MS);
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
	_splineIndex = 0;
	_token = startProgress(splineAt(0));
	updateProgress(_token, 0, 100);
	_tick = setInterval(_onTick, TICK_MS);
	_splineTick = setInterval(_onSplineTick, SPLINE_MS);
}

/** Feed real upload bytes (create journey only). */
export function journeyUpload(loaded: number, total: number | null): void {
	if (!_active || _kind !== 'create' || _phase !== 'upload') return;
	if (total !== null && total > 0) {
		_fraction = Math.min(1, loaded / total);
		if (loaded >= total) _setPhase('create', null); // bytes on the wire; server-side parse dominates
	}
}

/** Feed a `/model/status` poll result. */
export function journeyStatus(status: ModelStatus): void {
	if (!_active) return;
	const p = statusToProgress(status);
	if (p.phase === 'cold') return; // keep creeping in the current slice
	if (p.phase === 'ready') {
		_setPhase('validate', 1); // push to the validate ceil while boot's last fetches finish
		return;
	}
	_setPhase(p.phase, p.fraction);
}

/** Snap to 100% (honoring the min visible duration) then tear down. */
export function finishJourney(): void {
	if (!_active) return;
	_finishing = true;
	_setPhase('finalize', 1);
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/open-journey.test.ts'`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/mdp/workspace/data-rover-py && git add frontend/src/lib/state/open-journey.ts frontend/src/lib/state/__tests__/open-journey.test.ts && git commit -m "feat(open-progress): journey controller with ticker easing + splines"
```

---

### Task 3: Rewrite `trackOpenProgress` to feed the journey

**Files:**
- Modify: `frontend/src/lib/state/open-progress.svelte.ts`
- Test: `frontend/src/lib/state/__tests__/open-progress.test.ts`

**Interfaces:**
- Consumes: `journeyStatus`, `beginJourney`, `resetJourney`, `getActiveProgress` (via test).
- Produces (unchanged names, still exported): `trackOpenProgress(pollMs?: number): Promise<void>`, `cancelOpenProgress(): void`, `MAX_COLD_POLLS`.

- [ ] **Step 1: Rewrite the test**

Replace the entire body of `frontend/src/lib/state/__tests__/open-progress.test.ts` with:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../api/__tests__/server';
import { setActiveBaseUrl } from '$lib/api/client';
import { getActiveProgress, resetProgress } from '../progress.svelte';
import { beginJourney, resetJourney } from '../open-journey';
import { MAX_COLD_POLLS, trackOpenProgress } from '../open-progress.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('trackOpenProgress feeds the journey', () => {
	beforeEach(() => {
		resetProgress();
		resetJourney();
		setActiveBaseUrl(BASE);
	});
	afterEach(() => resetJourney());

	it('advances the journey bar toward the validate slice, then refreshes the summary at ready', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let calls = 0;
		let summaryFetched = false;
		server.use(
			http.get(`${BASE}/model/status`, async () => {
				calls++;
				if (calls === 1)
					return HttpResponse.json({
						state: 'validating',
						model_rev: 1,
						validation: { running: true, done: 5, total: 10 }
					});
				await gate;
				return HttpResponse.json({ state: 'ready', model_rev: 1 });
			}),
			http.get(`${BASE}/model/summary`, () => {
				summaryFetched = true;
				return HttpResponse.json({
					model_rev: 1,
					element_count: 0,
					relationship_count: 0,
					elements_by_type: {},
					issue_counts: {},
					undo_depth: 0
				});
			})
		);
		beginJourney('open'); // boot() owns beginJourney in production; the loop only feeds it
		const done = trackOpenProgress(1);
		// validate slice is [72,95]; 5/10 → 72 + 0.5*(95-72) = 83.5 → the bar should be past 72
		await vi.waitFor(() => expect(getActiveProgress()?.done ?? 0).toBeGreaterThanOrEqual(72));
		release();
		await done;
		expect(summaryFetched).toBe(true);
	});

	it('never starts a bar when no journey is active (loop is a silent feeder)', async () => {
		server.use(
			http.get(`${BASE}/model/status`, () =>
				HttpResponse.json({ state: 'hydrating', hydration: { phase: 'build', done: 1, total: 4 } })
			)
		);
		// no beginJourney → journeyStatus no-ops; one poll then cancel
		const p = trackOpenProgress(1);
		await vi.waitFor(() => expect(getActiveProgress()).toBeNull());
		// stop the loop
		const { cancelOpenProgress } = await import('../open-progress.svelte');
		cancelOpenProgress();
		await p;
	});

	it('gives up after MAX_COLD_POLLS consecutive cold polls', async () => {
		let calls = 0;
		server.use(
			http.get(`${BASE}/model/status`, () => {
				calls++;
				return HttpResponse.json({ state: 'cold', model_rev: null });
			})
		);
		beginJourney('open');
		await trackOpenProgress(1);
		expect(calls).toBe(MAX_COLD_POLLS + 1);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/open-progress.test.ts'`
Expected: FAIL — the current `trackOpenProgress` still owns its own token/labels, so the journey bar never advances (and `beginJourney` import may be unused until the rewrite).

- [ ] **Step 3: Rewrite `open-progress.svelte.ts`**

Replace the entire file `frontend/src/lib/state/open-progress.svelte.ts` with:

```ts
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
```

> Note: `refreshSummary` now runs only when the loop actually observed in-flight work (`sawWork`), matching the old behavior where the summary refresh was gated on a token having been created. An immediately-`ready` warm open skips it (boot's own `refreshSummary()` covers that path).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/open-progress.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/mdp/workspace/data-rover-py && git add frontend/src/lib/state/open-progress.svelte.ts frontend/src/lib/state/__tests__/open-progress.test.ts && git commit -m "refactor(open-progress): poll loop feeds the journey instead of owning the bar"
```

---

### Task 4: Wire the New Project wizard to the create journey

**Files:**
- Modify: `frontend/src/lib/components/projects/NewProjectWizard.svelte`
- Test: `frontend/src/lib/components/__tests__/NewProjectWizard.test.ts`

**Interfaces:**
- Consumes: `beginJourney`, `journeyUpload`, `cancelJourney` from `$lib/state`.

- [ ] **Step 1: Update the component**

In `frontend/src/lib/components/projects/NewProjectWizard.svelte`, replace the progress import block (lines 7–13):

```ts
	import { beginJourney, journeyUpload, cancelJourney } from '$lib/state';
```

Replace the whole `onSubmit` body (lines 30–61) with:

```ts
	async function onSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!canSubmit || !metamodel) return;
		error = null;
		pending = true;
		// Start the single journey bar now (on the click). It survives the goto()
		// into the workspace, where boot() adopts the same journey (beginJourney is
		// idempotent) and drives it through hydration/validation to 100%.
		beginJourney('create');
		try {
			const created = await createProject({ name, metamodel, model, view }, (loaded, total) => {
				journeyUpload(loaded, total);
			});
			// Do NOT end the journey here — boot() continues it after navigation.
			await onCreated(created.id);
		} catch (err) {
			cancelJourney(); // tear the bar down on failure
			error =
				err instanceof ApiError ? err.message : 'Could not create the project. Check the files.';
		} finally {
			pending = false;
		}
	}
```

> The `ApiError` import (line 6) and everything else in the file stay unchanged. The submit button keeps its `{pending ? 'Creating…' : 'Create project'}` label (a button affordance, not the bar).

- [ ] **Step 2: Update the test — add journey cleanup + an error-tears-down assertion**

In `frontend/src/lib/components/__tests__/NewProjectWizard.test.ts`, add imports at the top:

```ts
import { resetJourney } from '$lib/state/open-journey';
import { getActiveProgress, resetProgress } from '$lib/state/progress.svelte';
```

Extend the existing `afterEach` so the background journey ticker never leaks across tests:

```ts
afterEach(() => {
	resetJourney();
	resetProgress();
	document.body.innerHTML = '';
	vi.clearAllMocks();
});
```

Add a new test inside the `describe('NewProjectWizard', …)` block:

```ts
	it('tears the progress bar down when creation fails', async () => {
		createProject.mockRejectedValue(
			new ValidationError(422, { detail: 'nope' }, 'nope')
		);
		const c = mount(NewProjectWizard, {
			target: document.body,
			props: { open: true, onCreated: vi.fn() }
		});
		flushSync();
		const name = document.querySelector('input[name="project-name"]') as HTMLInputElement;
		name.value = 'W';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		setFile(
			document.querySelector('input[data-testid="mm-input"]') as HTMLInputElement,
			new File(['types: []'], 'mm.yaml')
		);
		flushSync();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await Promise.resolve();
		await Promise.resolve();
		flushSync();
		expect(getActiveProgress()).toBeNull();
		unmount(c);
	});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/NewProjectWizard.test.ts'`
Expected: PASS (existing tests + the new one). The existing "creates a project…" test still asserts `createProject` is called with `(objectContaining(...), any(Function))` — the callback is now `journeyUpload`-forwarding, still a function, so it passes.

- [ ] **Step 4: Commit**

```bash
cd /home/mdp/workspace/data-rover-py && git add frontend/src/lib/components/projects/NewProjectWizard.svelte frontend/src/lib/components/__tests__/NewProjectWizard.test.ts && git commit -m "feat(open-progress): start the create journey from the New Project wizard"
```

---

### Task 5: Wire the picker + workspace boot, export the journey API, verify end-to-end

**Files:**
- Modify: `frontend/src/lib/state/index.ts`
- Modify: `frontend/src/routes/projects/+page.svelte`
- Modify: `frontend/src/routes/p/[projectId]/+page.svelte`

**Interfaces:**
- Consumes: `beginJourney`, `finishJourney`, `cancelJourney` from `$lib/state`.

- [ ] **Step 1: Export the journey API from the state index**

In `frontend/src/lib/state/index.ts`, immediately after the existing
`export { cancelOpenProgress, trackOpenProgress } from './open-progress.svelte';`
line, add:

```ts
export {
	beginJourney,
	journeyUpload,
	journeyStatus,
	finishJourney,
	cancelJourney
} from './open-journey';
```

> Keep the existing `progress.svelte` re-exports (still used by `LoadFilesDialog`). Do not remove `cancelOpenProgress`/`trackOpenProgress`.

- [ ] **Step 2: Start the journey on the picker click**

In `frontend/src/routes/projects/+page.svelte`, add `beginJourney` to the `$lib/state` import (line 7):

```ts
	import { clearAccessNotice, getAccessNotice, isAdmin, beginJourney } from '$lib/state';
```

Replace the `open` function (lines 41–43) with:

```ts
	function open(id: string): void {
		// Start the single progress bar on the click; it survives the goto() and
		// boot() in the workspace adopts the same journey (beginJourney is idempotent).
		beginJourney('open');
		void goto(resolve(`/p/${id}`));
	}
```

> `onCreated` (the create path) needs no change — the wizard already began the journey; `onCreated` just navigates.

- [ ] **Step 3: Adopt / finish / cancel the journey in workspace boot**

In `frontend/src/routes/p/[projectId]/+page.svelte`:

(a) Add the journey functions to the big `$lib/state` import block (the one containing `cancelOpenProgress`, `setProjectOpening`, `trackOpenProgress`). Add these three names to that list:

```ts
		beginJourney,
		finishJourney,
		cancelJourney,
```

(b) Update the unmount teardown (line 73) from:

```ts
	onDestroy(() => cancelOpenProgress());
```

to:

```ts
	onDestroy(() => {
		cancelOpenProgress();
		cancelJourney();
	});
```

(c) In `boot()`, start/adopt the journey and finish it. Change the top of `boot()` (around lines 104–106) from:

```ts
		setProjectOpening(true);
		try {
			void trackOpenProgress(); // fire-and-forget: overlay while the requests below hydrate the session
```

to:

```ts
		setProjectOpening(true);
		// Adopt the journey started on the picker/wizard click, or start one now for
		// a direct-URL landing. Idempotent: a create/open journey already running is
		// preserved (kind + slice table intact).
		beginJourney('open');
		try {
			void trackOpenProgress(); // fire-and-forget: feeds the journey while the requests below hydrate
```

(d) In the metamodel-catch error path, change (line 121) from:

```ts
					cancelOpenProgress(); // a failed boot must tear the open-progress overlay down
```

to:

```ts
					cancelOpenProgress(); // stop the status poll loop
					cancelJourney(); // and tear the progress bar down
```

(e) Change the `finally` block (lines 136–138) from:

```ts
		} finally {
			setProjectOpening(false);
		}
```

to:

```ts
		} finally {
			setProjectOpening(false);
			finishJourney(); // snap to 100% (honoring the min visible duration) and tear down; no-op if already cancelled
		}
```

> `onReloadModel()` (later in the file) is untouched — model reload within an open project is out of scope and never showed the overlay.

- [ ] **Step 4: Typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: no new errors (0 errors from the touched files; unused-import errors here mean a name was added to an import list but not used, or vice versa — reconcile them).

- [ ] **Step 5: Run the full frontend unit suite**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'`
Expected: PASS. In particular `open-journey`, `open-progress`, `NewProjectWizard`, and `ProgressOverlay` suites are green. `ProgressOverlay.test.ts` is unchanged and still passes (it drives the generic store directly).

- [ ] **Step 6: Lint**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run lint'`
Expected: clean (no unused imports left behind in the three wired files or the wizard).

- [ ] **Step 7: Commit**

```bash
cd /home/mdp/workspace/data-rover-py && git add frontend/src/lib/state/index.ts frontend/src/routes/projects/+page.svelte "frontend/src/routes/p/[projectId]/+page.svelte" && git commit -m "feat(open-progress): single journey bar across picker open + workspace boot"
```

---

### Task 6: Manual/e2e smoke (verification only — no code)

This task has no code changes; it confirms the integrated behavior. The existing
Playwright specs (`e2e/auth.spec.ts` opens the `default` project; the workspace
specs create/open projects) already assert the overlay appears and the workspace
loads, and none assert the removed literal strings, so they remain valid.

- [ ] **Step 1: Run the e2e smoke (optional, heavy — boots backend + dev server)**

Run: `pixi run -e frontend bash -c 'cd frontend && npx playwright install chromium && npm run test:e2e'`
Expected: PASS. If the WASM guest binary isn't fetched, the snippet/script specs self-skip (pre-existing behavior) — that is not a regression from this change.

- [ ] **Step 2: Manual check (if a dev stack is up)**

With `pixi run backend-start` + `pixi run frontend-start`, log in as the bootstrap admin, then:
1. Open an existing project from the picker → the bar appears on click, shows a rotating splines line + climbing percent, and fills to 100% before the workspace is interactive (warm opens still show it briefly, ~600ms).
2. Create a project via the wizard → one continuous bar from upload through open, no reset across navigation, splines rotating, no literal phase text anywhere.

- [ ] **Step 3: Final commit (if anything was adjusted during smoke)**

Only if manual/e2e surfaced a fix. Otherwise the feature is complete on `feat/unified-open-progress`.

---

## Self-Review

**Spec coverage:**
- Single continuous bar click→ready, surviving navigation → Tasks 2 (module-level state), 4 (wizard begin), 5 (picker begin + boot adopt/finish). ✓
- Real signals (upload bytes, status done/total) + estimate for the rest → Task 2 `_onTick` (fraction vs `easeToward`). ✓
- Monotonic → `clampMonotonic` (Task 1), applied in `_onTick` (Task 2). ✓
- Remove literal "what is happening" text → wizard (Task 4) + `open-progress.svelte.ts` rewrite (Task 3) delete all eight strings; Global Constraints lists them. ✓
- Reticulating splines (19 verbatim, rotating, looping) → `SPLINES` + `splineAt` (Task 1), spline ticker (Task 2). ✓
- Warm opens show briefly with min duration → `MIN_VISIBLE_MS` in `_onTick`/`finishJourney` (Task 2), asserted in the min-duration test. ✓
- LoadFilesDialog untouched / still works → Global Constraints + not in any task's file list. ✓
- ProgressOverlay + project-open unchanged → Global Constraints; ProgressOverlay test left as-is (Task 5 Step 5). ✓
- No backend changes → Global Constraints; no `src/data_rover` files in any task. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result. ✓

**Type consistency:** `beginJourney`/`journeyUpload`/`journeyStatus`/`finishJourney`/`cancelJourney`/`resetJourney` signatures identical across Tasks 2, 3, 4, 5. `StatusProgress.phase` union (`'hydrate'|'validate'|'ready'|'cold'`) matches `statusToProgress` returns and `journeyStatus` handling. `PhaseName` slices total over both kinds. `ModelStatus` shape (from `model-status.ts`) matches the test fixtures. ✓
