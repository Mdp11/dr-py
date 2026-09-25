# Unified project open/create progress bar + reticulating splines

**Date:** 2026-07-20
**Status:** Design approved, ready for implementation plan
**Area:** `frontend/src/lib/state`, `frontend/src/lib/components`, `frontend/src/routes`

## Problem

Today the loading experience across project **create** and **open** is fragmented:

- The New Project **upload** has a real determinate bar (XHR `upload.progress`
  bytes), but it resets/relabels several times (`Uploading project files…` →
  `Processing files…` → `Opening project…`) and then hands off to a *separate*
  progress token in the workspace.
- **Opening** a project drives the same global overlay from a different
  producer (`trackOpenProgress` polling `GET /model/status`), which is mostly an
  indeterminate **spinner** — only the hydration `build` phase and the
  validation sweep expose real `done/total`; download/parse/replay are
  spinners with literal phase labels.
- **Warm opens** (session already hot) skip the overlay entirely.

The result is multiple bars/spinners, several literal "what is happening"
strings, and no single number that tracks the whole `click → workspace ready`
journey.

## Goals

1. **One** loading bar that tracks the entire journey from the click (Create in
   the wizard, or a project card in the picker) until the workspace is open and
   usable — across the client-side navigation, with no reset.
2. It must **actually track** using the real signals we already have (upload
   bytes; `/model/status` hydration + validation `done/total`); where a phase
   has no computable fraction, a **time-based estimate** fills the gap, with the
   bar adjusting when real signals arrive. The bar is **monotonic** (never
   moves backward).
3. **Remove** all literal "what is happening" phase text.
4. **Add** a rotating set of whimsical "reticulating splines" messages
   (verbatim list below) as the only text under the bar.

## Non-goals

- No backend changes. `/model/status` already exposes the signals we consume.
- `LoadFilesDialog` (loading a model file *into* an already-open project, from
  the TopBar) is **out of scope**: it keeps using the plain generic progress
  store and overlay, with no splines. The design must not break it.
- No change to `project-open.svelte.ts` (the tree-skeleton boolean); it is
  orthogonal — it gates the containment tree, not the overlay.
- No change to the `ProgressOverlay` visual style (centered card, `w-56` bar,
  percent). Only its label source changes.

## Chosen approach

**Single "journey" controller with weighted-milestone easing, frontend-only.**
One progress token owns the whole timeline and survives `goto()` (module state
persists in this `ssr=false` client-side SPA). It is fed by the real upload
bytes and `/model/status` polls; phases without a real fraction ease forward
with a time-based asymptotic creep that never stalls and never reverses. A
splines ticker drives the label. No backend work.

Rejected alternatives:

- **Pure fake trickle bar** (ease 0→90% on a guessed duration, snap to 100 on
  ready): ignores the real upload/build/validation counts we already have, so
  it feels disconnected on large (~80 MB) models. Fails goal 2.
- **Backend-computed unified progress endpoint**: cannot see client-side upload,
  navigation, or boot fetches, and is far more work (new status fields, tighter
  coupling) for accuracy the user said estimates can cover. Overkill.

## Architecture

### New module: `lib/state/open-journey.svelte.ts`

The single source of truth for the unified bar. It owns **exactly one** progress
entry for the whole journey. Public API:

- `beginJourney(kind: 'create' | 'open')` — start the timeline, the easing
  ticker, and the splines ticker. **Idempotent**: if a journey is already active
  it is a no-op (so create can start it and the workspace `boot()` can adopt the
  same one rather than opening a second bar).
- `journeyUpload(loaded: number, total: number | null)` — feed real upload bytes
  (create journey only).
- `journeyStatus(status: ModelStatus)` — feed each `/model/status` poll result;
  this **replaces** the status→label mapping currently in
  `open-progress.svelte.ts`.
- `finishJourney()` — snap to 100%, honour the **minimum visible duration**
  (~600 ms since `beginJourney`), then clear the entry and stop both tickers.
- `cancelJourney()` — teardown on unmount/error (stop tickers, clear entry) with
  no min-duration hold.

The module keeps module-level state: the active journey's `kind`, the underlying
progress token, the current phase, per-phase real fraction (if any), the
easing/splines timers, `startedAt`, and the last emitted percent (for the
monotonic clamp).

### Phase plan (percentage budgets)

Each phase maps to a slice `[floor, ceil]` of the 0–100 bar:

| Journey    | upload | server create | hydrate (dl/parse/**build**/replay) | validation sweep | finalize |
| ---------- | ------ | ------------- | ----------------------------------- | ---------------- | -------- |
| **create** | 0–30%  | 30–42%        | 42–80%                              | 80–96%           | 96–100%  |
| **open**   | —      | —             | 0–72%                               | 72–95%           | 95–100%  |

Fill strategy per phase:

- **Real-fraction phases** — `upload` (bytes `loaded/total`), the hydration
  **`build`** sub-phase (`done/total`), and the **validation** sweep
  (`done/total`) — map their fraction `f ∈ [0,1]` linearly into the slice:
  `floor + f·(ceil − floor)`.
- **Estimate phases** — server create, and the download / parse / replay
  hydration sub-phases (which report `total = 0`, i.e. indeterminate) — use
  asymptotic creep toward the slice ceiling:
  `ceil − (ceil − floor)·e^(−elapsedInPhase / τ)`, snapping to `ceil` the moment
  the real signal indicates the phase completed (state advances).
- **Monotonic clamp** — the emitted percent is `max(candidate, lastEmitted)`;
  the bar never decreases even if a later signal would compute lower.

`τ` (creep time-constant) is a small constant (e.g. ~1200 ms) chosen so estimate
phases visibly move but decelerate before the ceiling; it is not tuned per
phase.

### Pure helpers (unit-tested, no side effects)

Extracted so the ticker stays thin and the math is deterministically testable:

- `easeToward(floor, ceil, elapsedMs, tau): number` — the asymptotic creep.
- `clampMonotonic(candidate, lastEmitted): number` — the non-decreasing clamp.
- `statusToPhase(status: ModelStatus): { phase, fraction | null }` — maps a
  poll result to the current phase and its real fraction (or `null` when the
  phase is estimate-only). Mirrors the branch logic currently in
  `open-progress.svelte.ts` (cold / hydrating(phase) / validating / ready /
  empty) but returns data instead of setting labels.

### Splines

A `SPLINES: readonly string[]` constant holding the 19 lines **verbatim**, in a
**fixed pre-shuffled order** (a hand-ordered constant — no `Math.random`, since
the codebase avoids nondeterminism and this keeps tests exact). The splines
ticker advances one line every ~3000 ms and **loops** back to the start if the
journey outlasts the list. The current line is written as the progress entry's
label; `ProgressOverlay` renders it where the old phase text was.

The 19 lines:

1. Asking every arrow where it thinks it's going…
2. Deciding whether "one" or "many" was the right answer…
3. Reminding a box that it lives inside another box…
4. Untangling things that were connected a little too enthusiastically…
5. Convincing two boxes they can't both be the parent…
6. Making sure nothing is secretly its own grandparent…
7. Letting the rules read the model and quietly judge it…
8. Gently informing a loop that it is, in fact, a loop…
9. Asking each relationship if it still likes where it ends up…
10. Convincing the metamodel to stop reflecting on itself for one second…
11. Reminding the view that it owns nothing and never did…
12. Running validation, then pretending we didn't see that…
13. Checking that every element remembered to bring a property…
14. Asking the metamodel what counts as a relationship today…
15. Quietly asking validation to be gentle this time…
16. Sorting the table by a column it didn't know it had…
17. Widening a column so one property could finally stretch its legs…
18. Asking a subtree to hold still while we lock the whole family…
19. Walking the navigation chain so you don't have to…

The first displayed line is chosen deterministically (index 0 of the shuffled
order) so warm opens — which may only show one or two lines — are stable.

## Data flow / wiring changes

All literal phase strings are **deleted** as part of these edits.

- **`routes/projects/+page.svelte` `open(id)`** — call `beginJourney('open')`
  **before** `goto()`, so the bar appears on the click.
- **`components/projects/NewProjectWizard.svelte` `onSubmit`** — call
  `beginJourney('create')`; replace the three
  `startProgress`/`setProgressLabel`/`setProgressIndeterminate`/`updateProgress`
  calls with `journeyUpload(loaded, total)` in the existing XHR `onProgress`
  callback. Keep `apiUpload`'s XHR plumbing untouched. Remove the
  `'Uploading project files…' / 'Processing files…' / 'Opening project…'`
  strings. The submit button keeps its `Creating…` label (button affordance, not
  the bar).
- **`routes/p/[projectId]/+page.svelte` `boot()`** — adopt the active journey
  (call `beginJourney('open')`, which no-ops if one is already active from the
  wizard/picker, and starts one on a direct-URL landing). Replace
  `trackOpenProgress()` with a poll loop that calls `journeyStatus(status)` each
  tick. Call `finishJourney()` once **both** boot's sequential loads have
  resolved **and** status reached `ready`/`empty`. Keep `setProjectOpening`
  (tree skeleton) exactly as is. `onDestroy` → `cancelJourney()` (alongside the
  existing teardown).
- **`lib/state/open-progress.svelte.ts`** — its status→label logic is absorbed
  into `journeyStatus`/`statusToPhase`. Fold the file into the new module (or
  reduce it to a thin re-export). `MAX_COLD_POLLS` (the ~20 s cold-session
  give-up) moves into the new poll loop / journey.
- **`components/ProgressOverlay.svelte`** — mechanically unchanged: determinate
  bar + `%` + a single label line. The label is now the current spline. Because
  the journey always sets a numeric `done/total`, the indeterminate spinner path
  is effectively unused during create/open (it remains for other generic
  producers like `LoadFilesDialog`).
- **`lib/state/index.ts`** — export the new journey API; drop the removed
  `open-progress` exports (or keep re-exported shims if still referenced).

### Warm opens

Warm opens still call `beginJourney`/`finishJourney`; because there is little
real work, the bar fills quickly. `finishJourney`'s ~600 ms minimum-visible
duration (measured from `beginJourney`) ensures a smooth fill-to-100% rather
than a jarring flash. One or two splines lines show.

## Error / edge handling

- **Upload/create failure** (wizard `catch`) → `cancelJourney()` and surface the
  existing error UI; no min-duration hold on the error path.
- **Boot failure / 403 bounce** (`routes/p/[projectId]/+page.svelte`) →
  `cancelJourney()` before the redirect so the bar doesn't linger on the picker.
- **Cold-session timeout** (`MAX_COLD_POLLS` reached, ~20 s) → stop polling; the
  journey either finishes (if boot's loads succeeded) or is cancelled, matching
  today's behaviour.
- **Concurrent journeys** — `beginJourney` idempotency prevents a second bar
  when create's journey is adopted by `boot()`. Navigating away mid-open →
  `onDestroy` → `cancelJourney()` clears state so the next open starts clean.
- **Monotonic guarantee** protects against a later poll computing a lower
  percent (e.g. validation `total` arriving after build hit its ceiling).

## Testing

- **Pure helpers** (`easeToward`, `clampMonotonic`, `statusToPhase`) — unit
  tests: asymptote never exceeds `ceil`, monotonic non-decrease, snap-on-phase-
  complete, and each `ModelStatus` variant maps to the right phase + fraction.
- **`open-journey` store** — a create-journey sequence
  (upload bytes → status polls → finish) and an open-journey sequence
  (status polls → finish) each produce a **non-decreasing** percent, respect the
  slice boundaries at phase transitions, and reach exactly 100% at finish;
  splines rotate every interval and loop; `finishJourney` respects the min
  duration; `cancelJourney` clears state with no hold. Tickers are driven via
  injectable/fake timers (no `Date.now`/`Math.random` in the module).
- **Component/regression** — update `ProgressOverlay.test.ts`,
  `open-progress.test.ts`, and `NewProjectWizard.test.ts` to the new label
  source and the journey API. Remove assertions on deleted literal strings.
- **E2E** — the existing create/open Playwright specs assert the overlay appears
  and reaches 100%; they do not assert the old literal strings, so their removal
  is safe. Add a light assertion that a splines line is visible during open.

## Open questions

None. Budgets, spline cadence (~3 s), min visible duration (~600 ms), pure
rotation, and warm-open behaviour (show briefly) are all settled.
