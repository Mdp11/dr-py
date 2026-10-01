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
   ChangeSet, …)` (`service.ts:1352-1374`). `ChangeSet` carries ids only, and no `BatchResult`
   reaches the service: a delta's committed part is written without one
   (`working/working-copy.ts:688-759`), and unstage rewinds and replays (`:815-848`). `LiveIssues`
   already reads each transition's neighbourhood on the pre-state (`beforeRebase`) and the
   post-state (`validation/live.ts:127-159,347-430`). A metamodel change reopens the replica;
   there is no in-replica metamodel transition. After ready, transitions are model-lane jobs that
   queue behind a running scan: they land between passes, during a fill, not inside one.
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
10. Snippet `ref`s are never resolved in the engine (`table/resolve.ts:1-5`,
    `navigation/resolve.ts:57-65`); the `code_snippet` family is read only by prewarm
    (`service.ts:296`). The oracle inlines a ref as its definition and keeps a dangling one
    (`core/table/resolve.py:67-79`); a transform source resolves strictly, every failure a 422
    (`api/routes/tables.py:140+`).
11. The arity check is AST-based (`core/script/lint.py:79-88`, `entry_arity`), applied at
    evaluation (`core/table/script_inputs.py:356-363`).
12. Exports carry no script-error count: the server sets a boolean header,
    `X-Table-Script-Errors: true`, on any error or miss (`api/table_export_engine.py:855-862`).
13. The pinned oracle runner (`tests/script/trusted_runner.py`, `pin_determinism`) patches
    `datetime` process-wide, so scripted oracle runs live in a child process, as
    `script_parity`'s do. The server's routes answer a scripted table complete only after their
    sweep; the engine's answer matches that complete answer.
14. Nothing in the app calls `scriptCalls` or sets `prewarmScripts`
    (`sandbox/src/engine-worker.ts:28`).

## Decisions

**E1 · The gate is an `open` option.** CT-4's `open` gains `scripts?: 'evaluate'`. With it, the
replica evaluates scripts; without it, every refusal in point 1 stays as it is. The app does not
send it; the engine's Node tests, the Chromium script specs and the bench do, through the real
client and frame. Plan 4 removes the option together with the refusals.

**E2 · Collect.** `EvalContext` gains a `scripts` reader. A lookup checks the evaluation's memo
(E4), then the cell cache (E6). A miss records `(code, entry, element ids, inputs)` and reads as
the oracle's cache-only miss, a `pending` result (`embed.py`, `cache_only`), so the ported sites
take the oracle's own pending paths. A pass that recorded a miss is discarded, never published;
a pass with none publishes as today. No evaluator's signature changes.

**E3 · Fill and re-run.** The loop lives in `engine/src/evaluate/`, behind a runner that runs a
batch, so the golden replays drive it without a service. The service runs an evaluation that may reach a script as a loop:
submit the pass; when it recorded misses, group the misses into one batch per `(code, entry)`, run the
batches concurrently on the pool outside the scheduler (as `runScripts`), record every result in
the memo and, where E7 allows, in the cache; submit the pass again. A chain takes one round per
level. Every call a round runs is answered in the memo, so a round never misses the same call
twice and the loop ends.

**E4 · The evaluation's memo.** One per evaluation, keyed as the cache, holding every result
the evaluation has received, `timeout` and other uncached kinds included. It lets a `timeout`
cell publish without being cached. It dies with the evaluation, and with the pass when a
transition restarts it (E7).

**E5 · Cancel and progress.** `{cancel: id}` during a fill aborts its batches through their
signal (soft then hard stop, S13) and the evaluation is never answered. Fills emit
`progress {task: 'scripts', done, total}` in calls, summed over every fill in flight, emitted
directly at each batch result (a fill runs outside the scheduler's slice-end flush);
`ProgressTask` gains `'scripts'`.

**E6 · The cell cache.** One per replica, in the service, made at open and cleared by `discard`,
`diverge` and close. Keyed `(code, entry, element ids, inputs digest)`, the digest being the
`pyDumps` text of the resolved inputs. An entry holds the parsed result and its read-set (read
keys, or `null` for "depends on everything"). Bounds: 50,000 entries and 32 MB of result text,
least recently used first; a result above 64 KiB is not stored; a read-set over 128 keys is
stored as `null`. Cached: values and `runtime` and `syntax` errors; not cached: `timeout` and
every other kind. A snippet edit needs no eviction: the code is in the key.

**E7 · Eviction and the in-flight discard.** Each transition's touched keys are `touched_keys`'s
rules applied twice, as `LiveIssues` reads its neighbourhood: over the pre-state for the ids the
transition will touch (`wc.touchedIds()` and the delta's ids, read before it runs), and over the
post-state for its `ChangeSet`. The union is a superset of the oracle's keys for the same batch.
Entries whose read-set intersects it, or is `null`, are evicted. `discard`, `diverge` and close
clear the cache; a metamodel change reopens and so clears it. The service
counts transitions; a batch notes the count when it starts and its results enter the cache only
if the count has not moved when it returns. The memo of a pass a transition restarted is
dropped with it, since its results may have read the state before the transition.

**E8 · Snippet refs and the order cache.** Table, navigation and export resolution inline a
snippet `ref` as its definition from the `code_snippet` family, staged first, as the oracle
does; a dangling ref stays and evaluates to the oracle's error. `orderKey` then holds the code,
so an edited snippet's table gets a new order. Nothing else changes: an eviction by a transition
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
- the export transform (a failure is the export's error; jsonl requires a list), and
  `ExportFileResult.script_errors` a boolean, the server's header;
- `entry_arity` as a scanner of the top-level `def value(...)` signature, held to the oracle by a
  `script_arity` golden family;
- the harness result text parsed once into a result type the four sites share.

**E11 · Two engine methods** (CT-4), not yet called by the app: `tableScriptErrors` answers
`/tables/script-errors`'s body (the whole-table recap, capped at 200 items, `row_index` in the page's order, never a
202 since the fill precedes the answer) and `previewTransform` answers
`/exports/preview-transform`'s body, its 422s and file caps included.

**E12 · Oracle.** `table_eval`, `nav_eval` and `export_bytes` gain configured-script scenarios —
values, errors, a chain, expand columns, inputs, transforms, `script_errors` — whose Python side
runs the Recorder with the pinned trusted runner in a child process with `PYTHONHASHSEED=0` and
`TZ=UTC`, as `script_parity`, and records the complete answer. The engine replays them on the
Node host with real Pyodide. A `script_touched` family records `touched_keys` over element,
relationship, containment and delete batches; the engine's keys for each are a superset of the
oracle's.

**E13 · Tests.** Eviction: a delta, a stage and an unstage each evict exactly the entries whose
read-set they touch; a `null` read-set is evicted by any transition; a batch that spans a
transition is not cached. Fill loop: a chain takes one round per level; a cancel mid-fill is
never answered and stops its workers; a transition mid-fill restarts the evaluation and the
result reflects the new state; a `timeout` publishes and is not cached; a gated replica (no
`scripts: 'evaluate'`) still answers 501.

**E14 · The budget gate.** An `engine-bench-browser` row: a CSV `exportTable` of a table of ten
script columns over the 1,000 `Microservice` rows the `scriptCalls` row uses, so one call fills
all 10,000 cells, prewarmed (`scriptWarm` before the timer), through the real frame with
`scripts: 'evaluate'`, gated at ≤ 3 s (CN-3). An export, not a page, because a page holds at most
500 rows. Reported beside it, not gated: `evaluateTable`'s first page of the same table, the
cached re-export, and the rounds. Expected, reasoned not measured: the `scriptCalls` row's
2,234 ms, the same ten batches of 1,000, plus two export passes over 1,000 rows, tens of
milliseconds.

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
