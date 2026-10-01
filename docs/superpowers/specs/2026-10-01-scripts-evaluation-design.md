# Scripts, plan 3: evaluation — design

Refines `2026-09-30-scripts-in-the-browser-design.md` §2, §3 and §10 for its third plan: the cell
cache and its eviction, collect-fill-re-run, the ported script cells, navigation step and export
transform, script errors, and the budget gate over the evaluation path. Builds on
`2026-09-30-scripts-script-host-design.md` (S1–S18) and the K-100 hot pool.

**Scope boundary (owner, 2026-10-01).** Plan 3 leaves the engine able to evaluate scripts and
the app unchanged: the `reaches a script` refusals stay on for the app, lifted per replica by an
`open` option that only tests and the bench send (E1). Plan 4 lifts them for good, turns prewarm
on in the sandbox, fixes K-108's `csp-violation` flood, wires the frontend to the engine's script
methods and makes the frontend removals. Those three plan-2 carry-overs move to plan 4 because
they only matter once the app runs scripts.

## What the code says (at `2fa3f3f6`)

1. Every evaluation that reaches a script is refused before its first step with
   `ReadError(501, 'reaches a script')`: `table/route.ts:127`, `navigation/route.ts:107`,
   `export/route.ts:334,374`, `export/run.ts:130,164`. The gates are `tableHasScript`
   (`table/resolve.ts:75-94`), `navigationHasScript` (`navigation/resolve.ts:74-82`) and
   `exportReachesScript` (`export/run.ts:61-69`).
2. Behind the gates, the script sites are stubs for unconfigured snippets: `scriptCell`
   (`table/cells.ts:259-269`) throws a plain `Error` for a configured one (a 500, not a 501); the
   row build binds `[]` (`rows.ts:315-317,368-371,391`); sort reads only an expand column's
   promoted slot (`sort.ts:131-137`); `walk()` has no script branch (`navigation/evaluate.ts:351-397`).
   `ExportFileResult.script_errors` is the literal `0` (`export/route.ts:63,100`).
3. Evaluators are synchronous generators (`Steps<T>`, `steps/steps.ts`) run as model-lane scans
   (`Service.evaluate`, `service.ts:760-781`); a control-lane transition restarts a running scan
   from scratch (`scheduler.ts`, `interruptScan`). A scan cannot await; `ScriptHost.run` is a
   Promise. `runScripts` (`service.ts:869-918`) already awaits the host outside the scheduler,
   pinned to an epoch, with `call.onCancel` aborting. Evaluations emit no progress; `ProgressTask`
   is `parse|index|tail|verify|sweep` (`service/types.ts:36`).
4. Every model transition — stage, unstage, delta, each tail delta — passes `Service.changed(wc,
   ChangeSet, …)` (`service.ts:1352-1374`). `ChangeSet` carries ids only. `BatchResult` keeps
   `beforeElements` and `beforeRelationships` images (`ops/result.ts:60-61`).
5. The server derives touched read keys per applied batch in `api/invalidation.py`
   (`touched_keys`): a changed element touches `el`, its parents' `children`, and `scan` for its
   type, its ancestors and `None`; a relationship touches `out` source and `in` target, plus
   `children`/`parent` for containment; deleted metadata comes from inverse units; anything
   missing answers `None` (clear everything). `ScriptCellCache` (`core/script/cell_cache.py`)
   caps at 50,000 entries, caches only `runtime` and `syntax` errors, and stores a read-set over
   128 keys as `None`.
6. The Python oracle: `ScriptEvalContext` (`core/script/embed.py:84-232`) memoizes per request
   by `(code, entry, ids, inputs digest)` and has a collect mode (`cache_only`, a miss is
   `pending`); `core/table/script_inputs.py` resolves inputs to what the referenced column's
   cell holds, uncapped, and a pending or errored input never reaches the guest;
   `_script_cell` (`core/table/cells.py:338-440`), `_hop_script`
   (`core/navigation/evaluate.py:395-449`) and the export transform (`api/table_export_engine.py:252-271,913-924`,
   a failure is a hard error, jsonl must return a list).
7. `TableOrderCache` (`table/order-cache.ts`) keys on the resolved definition's text with
   snippet `ref`s not inlined, so an edited snippet keeps its table's cached order; entries are
   stamped `(rev, stagedVersion)`.
8. Host results are raw JSON texts of the harness dict `{payload, error, reads, stdout}`
   (`script/host.ts:20-36`); there is no parsed `CallResult` in the engine.
9. Golden families `table_rows`, `table_eval`, `nav_eval` and `export_bytes` cover only
   unconfigured scripts, refs and the `reach_*` refusals; no family has an evaluated script
   value, error or transform output.
10. Nothing in the app calls `scriptCalls` or sets `prewarmScripts`
    (`sandbox/src/engine-worker.ts:28`).

## Decisions

**E1 · The gate is an `open` option.** CT-4's `open` gains `scripts?: 'evaluate'`. With it, the
replica evaluates scripts; without it, every refusal in point 1 stays as it is. The app does not
send it; the engine's Node tests, the Chromium script specs and the bench do, through the real
client and frame. Plan 4 removes the option together with the refusals.

**E2 · Collect.** `EvalContext` gains a `scripts` reader. A lookup checks the evaluation's memo
(E4), then the cell cache (E6). A miss records `(code, entry, element ids, inputs)` and returns a
placeholder that never leaves the engine. A pass that ended with misses returns a `{needs}`
marker in place of its result, so nothing is published; a pass with none publishes as today.

**E3 · Fill and re-run.** The service runs an evaluation that may reach a script as a loop:
submit the pass; on `{needs}`, group the misses into one batch per `(code, entry)`, run the
batches concurrently on the pool outside the scheduler (as `runScripts`), record every result in
the memo and, where E7 allows, in the cache; submit the pass again. A chain takes one round per
level. Every call a round runs is answered in the memo, so a round never misses the same call
twice and the loop ends.

**E4 · The evaluation's memo.** One per evaluation, keyed as the cache, holding every result
the evaluation has received, `timeout` and other uncached kinds included. It lets a `timeout`
cell publish without being cached. It dies with the evaluation, and with the pass when a
transition restarts it (E7).

**E5 · Cancel and progress.** `{cancel: id}` during a fill aborts its batches through their
signal (soft then hard stop, S13) and the evaluation is never answered. A fill emits
`progress {task: 'scripts', done, total}` in calls, at most once per batch result plus first and
last; `ProgressTask` gains `'scripts'`.

**E6 · The cell cache.** One per replica, in the service, made at open and cleared by `discard`,
`diverge` and close. Keyed `(code, entry, element ids, inputs digest)`, the digest being the
`pyDumps` text of the resolved inputs. An entry holds the parsed result and its read-set (read
keys, or `null` for "depends on everything"). Bounds: 50,000 entries and 32 MB of result text,
least recently used first; a result above 64 KiB is not stored; a read-set over 128 keys is
stored as `null`. Cached: values and `runtime` and `syntax` errors; not cached: `timeout` and
every other kind. A snippet edit needs no eviction: the code is in the key.

**E7 · Eviction and the in-flight discard.** In `Service.changed`, each applied batch's touched
keys come from a port of `touched_keys`, reading deleted entities' type and endpoints from the
batch's before-images; entries whose read-set intersects them, or is `null`, are evicted. A
transition with no batch result to read (`discard`, `diverge`, a metamodel move, and unstage
where it rebuilds rather than rewinds — the plan confirms which) clears the cache. The service
counts transitions; a batch notes the count when it starts and its results enter the cache only
if the count has not moved when it returns. The memo of a pass a transition restarted is
dropped with it, since its results may have read the state before the transition.

**E8 · The order cache.** `orderKey` inlines the resolved code of every snippet `ref`, so an
edited snippet's table gets a new order. Nothing else changes: an eviction by a transition
already moves `(rev, stagedVersion)`, and an LRU drop does not make a stored order wrong for its
state. This narrows the program spec's "`TableOrderCache` depends on the cell cache".

**E9 · Scope of a fill.** A page whose order no script affects fills only its own cells; a
script sort, row source or script-fed navigation in the row source fills the whole scope, to the
50,000-row cap.

**E10 · Ports.** Line for line from the oracle, every quirk kept:
- `script_inputs.py` (resolution, arity check; a missing or errored input gets a synthetic,
  uncached result and never reaches the guest);
- `_script_cell`, expand columns included, and the row-build and sort sites;
- `_hop_script` in `walk()` (a failure prunes with a warning; a non-id string is a terminal
  value; non-finite floats as their repr; dedup on `(type name, value)`);
- the export transform (a failure is the export's error; jsonl requires a list) and
  `script_errors` counted in `ExportFileResult`;
- the harness result text parsed once into a result type the four sites share.

**E11 · Two engine methods** (CT-4), not yet called by the app: `tableScriptErrors` answers
`/tables/script-errors`'s body (the whole-table recap, `row_index` in the page's order, never a
202 since the fill precedes the answer) and `previewTransform` answers
`/exports/preview-transform`'s body, its 422s and file caps included.

**E12 · Oracle.** `table_eval`, `nav_eval` and `export_bytes` gain configured-script scenarios —
values, errors, a chain, expand columns, inputs, transforms, `script_errors` — whose Python side
runs the trusted runner in a child process with `PYTHONHASHSEED=0` and `TZ=UTC`, as
`script_parity`. The engine replays them on the Node host with real Pyodide. A `script_touched`
family pins the port of `touched_keys` over element, relationship, containment and delete cases.

**E13 · Tests.** Eviction: a delta, a stage and an unstage each evict exactly the entries whose
read-set they touch; a `null` read-set is evicted by any transition; a batch that spans a
transition is not cached. Fill loop: a chain takes one round per level; a cancel mid-fill is
never answered and stops its workers; a transition mid-fill restarts the evaluation and the
result reflects the new state; a `timeout` publishes and is not cached; a gated replica (no
`scripts: 'evaluate'`) still answers 501.

**E14 · The budget gate.** An `engine-bench-browser` row: `evaluateTable` over a table of ten
script columns × 1,000 rows, prewarmed (`scriptWarm` before the timer), through the real frame
with `scripts: 'evaluate'`, gated at ≤ 3 s (CN-3). Reported beside it: the cold first use, a
cached re-page, the rounds and the pass time outside the fill. Expected, reasoned not measured:
the `scriptCalls` row's 2,234 ms plus two passes over 1,000 rows, tens of milliseconds.

## Documents

CT-4 (`open`'s `scripts` option, `tableScriptErrors`, `previewTransform`, the `scripts` progress
task), CT-6 (the cell cache, eviction, the in-flight discard), a new `AD-34` (collect-fill-re-run,
the service loop), `program.md` (D plan 3), `engine/README.md` (evaluation with scripts), and the
backlog: K-108 noted as plan 4's, what this plan leaves open added.

## Known limits of this plan

- The app still refuses scripts in the engine and reads them from the server (E1).
- Prewarm stays off in the app; K-108's violation flood is open until plan 4.
- One batch per `(code, entry)` per round: calls of one script share module state within a round,
  not across rounds or evaluations. A script relying on module-global state is unsound, as on
  the server.
- Constant transitions during a long fill restart it each time; a fill completes only once a
  batch outlives the edits.
