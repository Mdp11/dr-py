# Scripts in the browser (sub-project D) — design

The fourth piece of the client-engine program (`architecture/program.md`): user Python scripts
leave the server's WASM guest and run in Pyodide, in script workers beside the engine worker,
reading the working copy through a synchronous bridge. The four script uses — snippet console
`run`, table script column, navigation script step, export transform — are answered by the
engine, staged edits included. The frontend loses `pending` cells, status polling, 202 retries
and the committed-state fallback for scripts.

Contracts this design touches: CT-6 (implemented here, with additions), CT-4 (new methods and a
progress field), CT-5.5 (its "reaches a script reads committed state" sentence ends), CT-7
(script output joins the fidelity rules, host against host). It closes AD-31 for scripts and
builds on AD-4 and AD-5.

## Goals

- A script host behind one interface, with two implementations: a worker pool over shared
  memory in the browser, an in-process direct call in Node.
- The facade (`FACADE_SOURCE`) and its synchronous `_transport(req) -> dict` unchanged; the
  dispatcher a TypeScript port of `src/data_rover/core/script/bridge.py`, trip-collapse kept.
- Every script use evaluated by the engine over the working copy, within the CN-3 script-cell
  budget (10,000 cells ≤ 3 s, prewarmed: the image and the pool's spares ready at the timer; the
  first use after open is reported, not gated).
- A runaway script stopped — softly by interrupt, hard by terminating its worker — with the
  replica intact.
- Identical code giving byte-identical output in Chromium and in Node.
- An engine cell cache keyed `(code, entry, element ids, inputs digest)` with read-set eviction.
- Removal from the frontend of `pending` cells, status polling, 202 retries, and the `script`
  half of the fallback marker; removal from the engine of the `reaches a script` refusals.

## Non-goals

- The headless service, its request contract and isolation (E). D delivers the Node script
  host E wraps.
- Deleting the server's `WasmScriptRunner`, script sweep, cell cache and script routes (F).
  They stay untouched: CI exports (`GET /exports/run-by-name`) use them until E.
- Snippet `lint` and `format`: they read no model and stay server routes.
- The `pattern` fallback (AD-31's other half) and `K-54`: `mark`, `Fallback` and the pattern
  branch of `engine-route.ts` stay.
- A server fallback, a surface switch or a shadow comparison for scripts (decision 3).
- Persisting the cell cache across reloads.
- The degraded export path (`K-74`): closed as not needed (decision 6).
- A binary bridge layout, unless plan 1's measurement shows JSON misses the budget.
- Production headers and asset hosting for the sandbox (F).

## Decisions taken with the owner (2026-09-30)

1. **The two hosts are browser Pyodide and Node Pyodide.** D builds the script host
   host-agnostic and proves parity between them. The server's WASM guest is a cross-check where
   CPython versions agree, never a gate.
2. **Collect, fill, re-run.** Evaluators stay synchronous generators. A cell-cache miss records
   the call and continues with a private placeholder; a pass that ends with misses hands them
   to the script host, awaits, and runs again; only a pass with no misses publishes.
   *Rejected:* suspend-and-resume in the scheduler (one round trip per miss unless every
   evaluator learns to look ahead; a staleness check at every resume point); async evaluators
   (rewrites C).
3. **Scripts are engine-only.** With no engine — the app on `localhost`, no cross-origin
   isolation, the link down — a script table, navigation, export or console run shows a
   "scripts need the engine" state, not a result. No switch, no shadow: an exception to MR-1
   and MR-2, parity being proved by the two-host corpus instead.
   *Rejected:* the server as fallback until F (keeps `pending`, polling and 202 alive); a
   shadow for script tables (a second server sweep per table, CPython-version noise).
4. **Prewarm one worker when the project has snippets; grow on demand.** Cap
   `max(1, min(4, hardwareConcurrency − 2))`; idle extra workers are terminated after a quiet
   period, one stays warm. A project with no snippets boots Pyodide on the first console run.
5. **The engine worker owns the script workers**, as nested module workers; the sandbox page
   is not involved.
6. **`K-74` is dropped.** An export waits for its fill, so every cell is a value or an error
   and `degraded` stays `false`.
7. **Four plans** (§9).

## 1. Script host

### Interface — `engine/src/script/`

The engine sees one interface: `run(batch) → Promise<results>` and `cancel(run)`. A batch is
the calls of one script: `(code, entry, [element ids, inputs]…)`. A result is the port of
`CallResult`: `{value, error, duration_ms, reads, stdout}`. `engine/src/` keeps no DOM or Node
dependency; the two hosts live outside it and are handed in.

- **Browser host** — `sandbox/src/`: the pool and the shared-memory transport.
- **Node host**: Pyodide in-process, `_transport` a direct call into the dispatcher. The
  parity corpus and the engine's script tests run on it; E wraps it.

Both pin the same Pyodide version (CN-4's, until deliberately moved) and run the same Python
sources.

### Python sources

- `FACADE_SOURCE` is used as is.
- The run harness — stdout cap, traceback filter, `result` pickup, `repr` truncation,
  arity-based input binding — is hoisted out of `_GUEST_BOOTSTRAP_SOURCE`
  (`src/data_rover/api/script_runner.py`) into one source beside `FACADE_SOURCE`. The server
  guest, `tests/script/trusted_runner.py` and both Pyodide hosts execute that one copy.
- The engine embeds facade and harness as a generated file; a test fails when it is stale, as
  for golden fixtures. The Python files stay the owners until F moves ownership to the engine.

### Browser topology

- The engine worker spawns each script worker and holds its handle, a private `MessagePort`
  and a `SharedArrayBuffer` for replies, plus a one-byte interrupt buffer.
- A script worker's `error` is reported to the engine, never through the page's `worker-error`
  message, so it cannot end the engine link.
- Each script worker checks its own `crossOriginIsolated` before booting.
- CSP is unchanged. Pyodide's loader, WASM and stdlib are copied into the sandbox build so
  every URL is `'self'`.

### One bridge trip

1. The facade calls `_transport(req)`; the worker posts the request on its port and blocks in
   `Atomics.wait`.
2. The dispatcher answers from the working copy.
3. The engine writes the reply into the worker's buffer and wakes it. A reply larger than the
   buffer crosses in continuation chunks.

Encoding is JSON behind `_transport`. Bridge requests are answered on the host turn ahead of
queued evaluation slices, so a blocked worker waits at most one slice.

### Dispatcher — port of `bridge.py`

Same ops, same sorted orders, same caps, same trip-collapse: one `_transport` call carries one
op, and a reply piggybacks the projections the facade's memo will need (far endpoints, children,
the call's roots). Writes are recorded as proposed ops and never applied; temp ids (`tmp_N`)
and read-sets are the facade's, and a read-set reaches the engine with its call's result.
Embedded entries (`value`, `step`, `transform`) are read-only by construction, as on the server.

### Pool and prewarm

Decision 4. A worker runs one batch at a time; a fill with several scripts spreads them across
the pool. The engine learns the project has snippets from the artifact family.

### Limits and stop

- Limits keep the server runner's values: wall time per call, stdout, `repr` and ops caps.
  There is no per-run memory limit in Pyodide; a worker that exhausts its memory crashes and is
  replaced.
- **Soft stop:** the engine sets the interrupt buffer; Python raises; the call returns a
  `timeout` error; the worker stays warm.
- **Hard stop:** a worker that has not returned after a grace period is terminated, replaced by
  a fresh boot, and the rest of its batch re-queued on another worker.
- Cancelling an evaluation or a console run (`{cancel:id}`) stops its scripts the same way.
- The replica takes no part in either stop.

### Determinism

Applied identically in both hosts before any user code: fixed clock, fixed randomness,
`PYTHONHASHSEED=0`. Results leave the engine through its `json.dumps`-compatible serializer.
`result_repr`, stdout, error text and filtered tracebacks are part of the output and covered by
parity.

## 2. Cell cache

- In engine memory, keyed `(code, entry, element ids, inputs digest)`; each entry holds the
  result and its read-set.
- A delta or a staged or unstaged op that touches a read-set evicts the entry. A run in flight
  when any transition lands is discarded on return and run again: its read-set is not known
  until it returns, and its session's memo may hold projections the transition made stale, so
  the session is dropped with it.
- Bounded by entry count and bytes inside the CN-3 heap budget, least recently used first.
  A result above a per-entry size cap is not stored.
- Errors are cached like values; `timeout` results are not.
- `TableOrderCache` depends on the cell cache as well as on `(rev, stagedVersion)`.

## 3. Evaluation

### Collect, fill, re-run

- The stubs C left — `scriptCell` (`engine/src/table/cells.ts`), the row-build and sort sites
  (`engine/src/table/rows.ts`, `sort.ts`), the script step in `walk()`
  (`engine/src/navigation/evaluate.ts`) — and export transforms read the cell cache.
- A miss records the call and yields a placeholder that never leaves the engine.
- The route wrapping the evaluator runs the pass; on misses it fills through the script host
  and runs it again; the first pass without misses publishes. "Publishes nothing before its
  last step" holds across rounds.
- A chain — a script column feeding a scripted navigation or another script column — takes
  one round per level.
- A page with no script-dependent order fills only that page's cells. A sort or row source
  that depends on a script fills the whole scope, to the 50,000-row cap.
- A fill reports progress ("running scripts, n of m") on the existing progress events.

### Ports

- `core/table/script_inputs.py` (input resolution, the arity check) and the script branches of
  `core/table/cells.py`, `core/navigation/evaluate.py` (`_hop_script`) and the export
  transform call.
- `previewTransform` and `fetchScriptErrors` become engine methods; `script_errors` is
  counted, `script_status` leaves the page type.

### Removals

- Engine: every `ReadError(501, 'reaches a script')`, `tableHasScript` /
  `navigationHasScript` / `exportReachesScript` as refusal gates (kept where evaluation needs
  them, e.g. `NavMemo.scripted`).
- Frontend: the `script` reason in `engine-route.ts` and its three markers (`table-fallback`,
  `export-fallback`, `nav-fallback` for scripts); `PendingCell` and the `pending` cell kind;
  the poll loop in `state/table-editor.svelte.ts`; the 202 retry in `util/export-download.ts`.
- With no engine, script surfaces show the "scripts need the engine" state (decision 3).

## 4. Console

`runSnippet` becomes an engine method returning today's shape: `stdout`, `result_repr`,
proposed `ops`, `error`, `truncated`. `stale` goes: the run reads the working copy. Ops are
shown and staged by the user, as now; the engine never applies them. Cancel interrupts the run.
`T-9`'s locator is fixed so the console → stage → commit e2e is green.

## 5. Oracle, tests, benchmarks

- **Parity corpus:** committed cases `(code, model, entry, ids, inputs) → output bytes` over
  the four uses, errors, tracebacks, caps and truncation. Run in Node (vitest) and in Chromium;
  each must equal the committed bytes. Seeded from `tests/api/test_snippets_wasm.py` and the
  trusted-runner tests.
- **Dispatcher:** golden fixtures from `bridge.py` — requests, replies, trip counts, read-sets —
  through the golden driver.
- **Runaway:** `while True: pass` ends by soft stop; a script that swallows the interrupt ends
  by hard stop. After each, the replica answers a read and its stamp is unchanged.
- **Eviction:** a delta and a staged op each evict exactly the entries whose read-set they
  touch, in flight included.
- **Evaluation:** the existing table, navigation and export golden families gain script
  scenarios, run on the Node host.
- **e2e:** a script table with staged edits shows working-copy values; the console flow;
  script surfaces with no engine.
- **Budget gate:** a row in `engine-bench-browser` — ten scripts × 1,000 ids on warm workers —
  with Pyodide boot reported separately.

Tests run the real engine and real Pyodide, without fake timers.

## 6. Freeze (MR-3)

`core/script` (facade, bridge, harness) is frozen for behaviour from the start of plan 1; the
harness hoist is a move, not a change. The script branches of `core/table`, `core/navigation`
and the export engine are already frozen by C. The script-table exception to the feature
freeze (`program.md`) ends when plan 3 lands.

## 7. Changes to `architecture/` and the backlog

- CT-6: nested workers owned by the engine; continuation chunks; in-flight read-set discard;
  the script-host interface.
- CT-5.5: drop the committed-state sentence for scripts. AD-31: closed for scripts.
- New decisions from `AD-34`: collect-fill-re-run; scripts engine-only (the MR-1/MR-2
  exception); pool and prewarm policy.
- CN-4: the cross-worker bridge measurement, once plan 1 has it.
- `program.md`: D's status per plan; `system.md` where it describes script flow.
- Backlog: close `K-74` and `T-9`; update `R-3`.
- READMEs with the behaviour (RC-10): `engine/`, `sandbox/`, `frontend/src/lib/engine/`,
  `frontend/`, `src/data_rover/core/script/` (also its stale line on embedded stdout).

## 8. Risks

- **Cross-worker bridge cost is unmeasured.** CN-4's 2.7 s ran Pyodide and the store in one
  worker over direct FFI. Plan 1 measures first; the binary layout is its contingency.
- **Nested workers and Pyodide under the sandbox build.** The spike served Pyodide from
  outside the build. Plan 1 proves the built sandbox boots it with zero CSP violations.
- **An interrupt Python can swallow.** The hard stop covers it, at the cost of a boot.
- **Whole-scope fills.** 50,000 cells is about 10 s on one worker at budget speed; the pool
  and the cache carry it. Reported, not gated.
- **Memory.** Four workers are about 360 MB outside the engine heap; the idle shrink bounds it.
- **Repeated passes.** Each round re-runs a pass; cheap on a warm cache, measured in plan 3.

## 9. Plans

Four, written one at a time, each leaving the branch green.

1. **Bridge foundation** — §1's interface, browser topology, bridge trip, dispatcher, Node
   host; Pyodide in the sandbox build; the cross-worker measurement; the binary layout if JSON
   misses the budget.
2. **Script host** — §1's Python sources, determinism, pool, prewarm, limits and stop; the
   parity corpus and runaway tests.
3. **Evaluation** — §2 and §3: cell cache, collect-fill-re-run, table script columns,
   navigation script step, export transform, script errors; the budget gate.
4. **Console and removal** — §4 and §3's removals; `T-9`; docs, architecture and backlog; close.

## 10. Done when

- The script-cell budget gate (≤ 3 s, prewarmed) is met in `engine-bench-browser`.
- The runaway tests pass with the replica intact.
- The parity corpus is byte-identical in Node and Chromium.
- No frontend code names `pending` cells, script status polling or a 202 retry; no engine code
  answers `reaches a script`.
- `dr-test`, `dr-tidy` and e2e are green, `T-9` included.

## Known limits

- A reload recomputes every script result.
- With no engine there are no script results.
- A script relying on module-global state between calls is unsound under the cache, as on the
  server today.
- CI exports still run scripts on the server until E, so a CI export and a browser export of a
  script table come from different CPython builds until then.
