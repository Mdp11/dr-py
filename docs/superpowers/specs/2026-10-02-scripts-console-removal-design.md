# Scripts, plan 4: console and removal — design

Refines `2026-09-30-scripts-in-the-browser-design.md` §3 (Removals), §4 and §10 for its fourth
and last plan, and closes what plan 3 (`2026-10-01-scripts-evaluation-design.md`) left open.
Script evaluation becomes the engine's only path: the `open {scripts:'evaluate'}` option (AD-34)
goes, the app evaluates every script use on the working copy, and with no engine a script
surface shows "scripts need the engine".

## What the code says (at `a066f298`)

1. The option is read at `service.ts:1689-1692` and sets `this.cells` (`:1705`) only with a
   script host. `evaluate()` picks the filled or the plain path from `this.cells` at arrival
   (`:817`); the plain path passes no `scripts`, so a script it reaches is a 501. The sandbox
   always hands the engine a script host (`sandbox/src/engine-worker.ts:28`); the frontend's only
   `open` (`frontend/src/lib/engine/sync.ts:715`) never sends the option.
2. The refusal gates are `table/route.ts:166`, `navigation/route.ts:111`,
   `export/route.ts:418,470`, `export/run.ts:168,213`, `table/script-errors.ts:50`,
   `export/preview-transform.ts:99`; `table/cells.ts:320` asserts one ran. `exportReachesScript`
   (`export/run.ts:66`) exists only for the gates. `tableHasScript`, `navigationHasScript`,
   `NavMemo.scripted` and the sort's scan drive evaluation and stay.
3. The frontend's surfaces take side `server` only when their switch says so or the replica phase
   is `off` or `server` (`frontend/src/lib/engine/seam.ts`). On that side the server answers a
   script table with `pending` cells and `script_status`, an export and the script-errors recap
   with 202 + `Retry-After`. The frontend polls (`state/table-editor.svelte.ts`), retries
   (`util/export-download.ts`, `api/tables.ts` `preparing`) and marks fallbacks with the `script`
   reason (`api/engine-route.ts:28,121,241`). `previewTransform` (`api/exports.ts:83`) and
   `fetchScriptErrors` (`api/tables.ts:279`) are server-only, though the engine has both
   (`engine/src/evaluate/index.ts:51,54`). No surface has a "needs the engine" state.
4. The console (`state/snippet-editor.svelte.ts:208-266`) and `SnippetTestPanel.svelte:148`
   call `POST /snippets/run` (`api/snippets.ts:40-46`), which runs on committed HEAD and answers
   `run_id, stdout, result_repr, ops, error, duration_ms, model_rev, stale, truncated`. The route
   refuses artifact, view and metamodel ops as a 500 (`api/routes/snippets.py:342-385`). Stop only
   drops the answer: `/snippets/cancel` is a no-op (`snippets.py:148-161`). Staging refuses a
   `stale` result or one whose `model_rev` is not the current rev (`state/snippet-stage.ts`,
   `state/stage-proposed.ts:54`).
5. The engine's `scriptCalls` (`service.ts:1060-1135`) with entry `script` and one call already
   runs a console call over the working copy with a recording dispatcher, answers the proposed
   ops, and stops on `{cancel}` (`service.ts:719-765`, `pool.ts:824-836`). `readScriptBatch`
   accepts `transform` with `console:true` (`service.ts:345-348`, K-107 (1)).
6. A fill round's settle and `CellCache.put` run in one synchronous loop after the round's await
   (`evaluate/fill.ts:311-319`), outside the scheduler: about 65 ms per 10,000 calls, 280 ms per
   50,000 (K-114 (4)). `window.bench.scriptTable()` pings nothing (`frontend/bench/main.ts:596`).
7. Nothing sets `prewarmScripts` (`engine/src/service/types.ts` only); the budget gate assumes a
   prewarmed pool. Each `csp-violation` a script worker reports updates the app's store once,
   unbounded (`pool.ts:606-614` → `sync.ts:576`, K-108 (1)).
8. A dropped fill stays in `this.fills` until its aborted batches end (`service.ts:903`), so
   `postScripts` (`:963-966`) sums it into the next replica's progress and `endFill` adds its
   total into `fillsEnded` (`:979-982`).
9. `export/run.ts:257` defers every error while a transform is present; the oracle defers only
   refusals and lets an internal error propagate at once.
10. T-9: `e2e/snippet-flow.spec.ts:121` waits for a `button` named after the renamed element; the
    sidebar search renders hits as `role="option"` (`Sidebar/Search.svelte:238,251`).

## Decisions (owner, 2026-10-02)

### R1 · The option goes

- `OpenParams.scripts` is removed and no longer read.
  The service holds its cell cache whenever it has a script host.
- A service with no script host answers an evaluation whose pass needs a fill with
  `ReadError(503, 'no script host')`. An evaluation that reaches no script, or whose cells are
  all cached, answers as now.
- Every `reaches a script` refusal and `exportReachesScript` go; the assertion in
  `table/cells.ts` becomes a type the pass guarantees. The scans that drive evaluation stay.
- `evaluate()` no longer chooses a path at arrival: Known Issue 4 of the handoff is moot, and a
  test pins that a call arriving before the first `open` waits and is filled.

### R2 · No engine: the server refuses on request

- The app sends `X-Data-Rover-Scripts: engine-only` on every API request.
- With that header, the server answers 409 with detail `scripts need the engine` wherever it
  would have answered a `pending` cell, a non-null `script_status`, a 202 for scripts, or run a
  script: `POST /tables/evaluate`, `/tables/export`, `/tables/script-errors`,
  `POST /exports/run`, `/exports/preview-transform`, and the navigation evaluation route. The
  refusal comes before any script work starts.
- Without the header — CI, `GET /exports/run-by-name`, `scripts/export_large.py`, API tests —
  every route behaves as today. The server's script runner, sweep and cache stay untouched (F).
- The frontend maps that 409 to one error kind and renders "scripts need the engine" on the
  table, the navigation results and the export dialogs. The console, the snippet test panel and
  the transform test panel always reach a script: with the surface on side `server` they show
  the state without calling anyone.
- Frontend removals: the `script` reason of `Fallback` and its notes (the markers stay for
  `pattern`); `PendingCell` and the `pending` cell kind; `script_status` and its strips; the poll
  loop and recap retry; `retryAndDownload`, the `preparing` result and the 202 branches.
  `previewTransform` and `fetchScriptErrors` route through `route('exports'|'tables', …)`.

### R3 · Console on the engine

- Engine method `runSnippet` over the existing `scriptCalls` machinery. Params: `code` or
  `artifact_id`, `entry` (`script`, `value`, `step`), `element_ids`, `inputs` (only with
  `value`), with the server's arity rules (`value` ≥ 1 id, `step` exactly 1). A saved snippet
  resolves from the working copy's artifacts, as embedded runs do.
- Answer: `stdout`, `result_repr`, `ops`, `error {kind, message, traceback}`, `truncated`,
  `duration_ms`, and `stamp {rev, staged}` — the working copy's committed rev and staged
  version when the run started. `run_id`, `model_rev` and `stale` go.
- Every recorded op must be a model op (`update_element`, `delete_element`, `create_element`,
  `create_relationship`, the facade's set); any other makes the run's answer an error of kind
  `runtime` with no ops. A script can call `_transport` directly, so this gate is the engine's,
  as it was the server route's.
- `readScriptBatch` refuses `transform` with `console:true` (K-107 (1)).
- Frontend: the console and `SnippetTestPanel` call `runSnippet` on the engine only; with the
  replica phase `off` or `server` they show the state. Stop aborts the call's signal, which cancels the run. A result is out of date once the
  current working-copy stamp differs from its `stamp`: the existing banner shows and Stage is
  disabled; `stageProposedOps` checks the stamp instead of `model_rev`. The 429 and 503 notices
  and the "server ends it at the wall timeout" text go. The pool queues concurrent runs.
- The server's `/snippets/run` and `/snippets/cancel` stay for F; the app no longer calls them.
- T-9: the locator becomes `getByRole('option', { name: /Renamed by snippet/ })`.

### R4 · Settle in slices (K-114 (4))

- A round's settle and `CellCache.put` become a `Steps` generator that the service runs as a
  model-lane scan job, cancelled on abort like a pass. The stamp check (`transitions() !==
  stamp`) moves to the job's start: a running scan holds transitions behind it, so the check
  holds for the whole settle. Transitions wait at most one slice.
- `batchesOf` stays synchronous; its cost is one `parseExact` per call, recorded in K-114.
- The bench pings during `scriptTable()`'s cold export and reports `longest staged round trip
  during the script table (slice bound)` beside the other slice lines.
- Eviction's key computation inside the transition slice is recorded, not changed.

### R5 · Accepted: dropped rounds under a stream of transitions (K-114 (10))

A cold evaluation that a stream of transitions keeps moving answers once a round fits between
two transitions. The visible table re-pages after an edit anyway; exports and long fills wait
for edits to pause. Admitting results whose read-set no transition touched changes the stamping
invariant; it is recorded, with this reason, in AD-34 and K-114.

### R6 · Pool and prewarm

- The sandbox passes `prewarmScripts` (decision 4 of the program spec). The service skips the
  snippet scan while `artifacts.version` has not moved (K-108 (3)).
- The pool relays at most 16 `csp-violation` reports per batch per worker and drops the rest
  (K-108 (1)).

### R7 · Plan 3's small open items

- `engine/README.md:32`: an evaluation runs on the replica pinned when its first scan starts.
- A fill records its epoch at `start()`. `postScripts` skips fills of another epoch; `endFill`
  for a dropped fill deletes it without adding its total into `fillsEnded`.
- `export/run.ts` defers only `ReadError`; any other error throws at once.
- T-15 lists the five e2e load flakes: `eval-compare:231`, `replica:64`,
  `script-embedding:114`, `strict-mode:41`, `view:85`.

### R8 · Recorded, not fixed

K-114 (1)–(3), (5)–(9); K-113, re-measured after R4; K-111; the remaining K-107 and K-108
items. Each keeps or gains a line saying why it does not block.

## Tests

- **Engine:** the 501 tests (`export/reach`, `table/cells`, `navigation/nav`,
  `script/snippets`, `evaluate/fill`, `service/script-eval`) become fill tests or `no script
  host` tests. New tests cover `runSnippet` (shape, saved snippet, non-model op refused,
  transform refused, cancel, stamp), settle in slices (a transition queued during a settle lands
  after it, and the settled results are those of the pre-transition stamp), fill progress across
  a replica change, and `run.ts`'s internal error.
- **API:** pytest per route for the header: 409 when the request reaches a script, unchanged
  answers without the header or without scripts.
- **Frontend vitest:** the status, poll and 202 tests are deleted; the no-engine state is tested
  per surface; the console tests drive the engine client.
- **e2e:** `eval-tables`, `eval-navigation`, `eval-exports` and `script-embedding` assert engine
  results where they asserted fallback markers or pending cells; a new spec switches `tables` to
  `server` and expects the state; `snippet-flow` runs console → stage → commit on the engine.
- **Gates:** `dr-test`, `dr-tidy`, `frontend-test-e2e` (T-9 included), `engine-scripts-browser`,
  and the script-cell budget in `engine-bench-browser` (≤ 3 s, prewarmed), run only after the
  owner confirms the machine is quiet.

## Documents

- AD-34: no option; R5's accepted limit. CT-4: `runSnippet`, the removed option, the 503. CT-5.5:
  scripts read the working copy. `program.md`: D done.
- Backlog: close K-74, T-9; update R-3, K-107 (1), K-108 (1)(3), K-114 (4)(10), T-15.
- READMEs (RC-10): `engine/`, `sandbox/`, `frontend/src/lib/engine/`, `frontend/`,
  `src/data_rover/api/` (the header).

## Known limits

- A cold evaluation under a steady stream of transitions waits for a pause (R5).
- With no engine there are no script results, only the state.
- CI exports still run scripts on the server, with the server's CPython, until E.
