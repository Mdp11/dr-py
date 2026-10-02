# Scripts, plan 4: console and removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make engine evaluation the only path for scripts, run the snippet console on the engine, give every script surface a "scripts need the engine" state when there is no engine, and close plan 3's open items.

**Architecture:** The engine drops the `open {scripts:'evaluate'}` option and evaluates scripts whenever it has a script host; it gains `runSnippet`, and its fill rounds settle in scheduler slices. The server refuses script work with 409 when the app's request header asks it to. The frontend sends that header, drops `pending` cells, polling and 202 retries, routes script reads to the engine, and runs the console there with a working-copy stamp guarding Stage.

**Tech Stack:** TypeScript engine (vitest, Node Pyodide host), SvelteKit 5 frontend (vitest happy-dom + MSW, Playwright), FastAPI backend (pytest, in-memory SQLite).

**Spec:** `docs/superpowers/specs/2026-10-02-scripts-console-removal-design.md` (decisions R1–R8). Program spec: `docs/superpowers/specs/2026-09-30-scripts-in-the-browser-design.md` §3, §4, §10.

## Global Constraints

- Header name and value, verbatim: `X-Data-Rover-Scripts: engine-only`. Refusal: HTTP 409, detail `scripts need the engine`.
- Engine refusal with no script host: `ReadError(503, 'no script host')`.
- **Tests, focused (owner, 2026-10-02):** a task runs only the test files it creates or edits, plus the typecheck/lint of the package it touched: `pixi run engine-check`, `pixi run frontend-check`, `pixi run sandbox-check`, `pixi run backend-lint`. Single files: `pixi run engine-test test/x.test.ts`, `pixi run frontend-test src/lib/x.test.ts`, `pixi run sandbox-test test/x.test.ts`, `pixi run -e core-dev pytest tests/api/test_x.py`. No task runs `dr-test`, `dr-tidy`, `frontend-test-e2e`, `engine-scripts-browser` or a bench; only Task 11 (e2e) and Task 12 (final gates) do.
- **No sleeping (owner, 2026-10-02):** no `sleep`, no timed waits, no polling loops — not in shell commands, not in tests. Long commands run in the foreground, or in the background with completion notification. Tests wait on events or promises (existing helpers such as `until` in `engine/test/service/script-eval.test.ts`), never on wall-clock delays, and use no fake timers (CLAUDE.md).
- Tests run the real engine, never a mock; scripted engine tests run on `cappedNodeScriptHost(2)` (`engine/node/script-host.ts`); `dispose()` every in-process link.
- The Python core is the oracle; `core/script` and the server's script runner, sweep and cell cache are frozen (only the route-layer header check of Task 2 is added).
- Comments: concise, present tense, no history, no spec or plan references (RC-6). A behaviour change updates its owning README in the same commit (RC-10).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the attribution the agent's harness gives).

## Review Focus

1. A transition (stage or delta) that lands while a round settles in slices: the results entering the cache must be those of the stamp the round ran on, and nothing settled after the transition may enter the cache — pinned in Task 6.
2. A console run whose script calls `_transport` directly with a non-model op (e.g. an artifact op): the answer must carry no ops and a `runtime` error — pinned in Task 5.
3. A table export with a transform but no script column, under the header: the server must answer 409 before running the transform — pinned in Task 2.
4. A console result computed, then a staged edit made, then Stage pressed: Stage must be disabled and `stageProposedOps` must refuse — pinned in Task 10.
5. An evaluation arriving before the first `open` completes, now that the path is not chosen at arrival: it must wait and be filled, not answer 501 — pinned in Task 1.

## Execution order and parallelism

Three lanes. A task marked `independent` shares no file with any task not yet done and consumes nothing from one.

| Lane | Tasks |
|---|---|
| Engine (main sequence) | 1 → 5 → 6 → 8 |
| Frontend | 3 → 9 → 10 (10 also waits for 5) |
| Small, any time | 2, 4 (independent); 7 (after 1) |
| Close | 11 (after all), 12 (after 11) |

execute-plan runs one independent task beside the main sequence; this plan would profit from running the whole frontend lane (3 → 9) beside the engine lane, since they share no files until Task 10.

---

### Task 1: The option goes (engine)

**Tag:** implementer · **Depends on:** independent

Implements spec R1 and R7's `run.ts` item (Known Issue 3).

**Files:**
- Modify: `engine/src/service/service.ts` (`open` :1683-1705, `discard` :1674, `cells` :693, `evaluate()` :816-857, `fill()` :863-907, `pass()` :945, eviction :1592)
- Modify: `engine/src/service/types.ts` (`OpenParams` :75-79)
- Modify: `engine/src/evaluate/index.ts` (`EvalContext.scripts` :26-37)
- Modify: `engine/src/table/route.ts` (:48-65, :85-86, :165-168), `engine/src/table/script-errors.ts:50`, `engine/src/table/cells.ts:320`, `engine/src/export/route.ts:418-419,470-471`, `engine/src/export/preview-transform.ts:99`, `engine/src/navigation/route.ts:111-117`, `engine/src/export/run.ts` (:66 `exportReachesScript`, :168, :206, :213, :249-262), `engine/src/index.ts:141`
- Modify: stale comments `engine/src/table/schema.ts:90,454`, `engine/test/golden/model-steps.ts:516`
- Modify: `frontend/bench/main.ts:151` (drop the `scripts: 'evaluate'` open param only)
- Modify: `engine/README.md` (scripts sections; line 32's clause)
- Test: `engine/test/service/script-eval.test.ts`, `engine/test/export/reach.test.ts`, `engine/test/table/cells.test.ts`, `engine/test/navigation/nav.test.ts`, `engine/test/evaluate/fill.test.ts`, `engine/test/service/helpers.ts`, `engine/test/export/run.test.ts` (or the file holding `run.ts`'s transform-deferral tests; find with `grep -rln "TransformSyntaxError\|invalid transform" engine/test`)

**Interfaces:**
- Produces: `OpenParams` without `scripts`; `EvalContext.scripts: ScriptReader` (required); `openReplica(client, model, doc)` without the `scripts` option; a service with a script host always evaluates scripts; with none, a pass that needs a fill rejects `ReadError(503, 'no script host')`.

- [ ] **Step 1: Turn the 501 tests into the new behaviour (failing)**

  In `engine/test/service/script-eval.test.ts`:
  - Delete "is off by default…" (:136), "is refused as 422 for any value but "evaluate"…" (:148), "lives with the replica…" and "is refused with 501, as it always was…" (:888).
  - Rewrite "does nothing where the host gave the engine no script host" (:185) to assert `refusal(...)` is `{ status: 503, detail: 'no script host' }` for a table with a script column on a `connect()` with no `scripts`, and that a table with no script column still answers 200 there.
  - Make `evaluating()` (:116) open with no option; drop its `scripts` parameter.
  - Add: "an evaluation sent before the first open waits and is filled" — `connect(autoHost(), portPair(), { scripts: cappedNodeScriptHost(2) })`, send `evaluateTable` for a script-column table, then `openReplica`, then assert the page's script cells hold values (reuse the file's `NAME` code builder).

  In `engine/test/export/reach.test.ts` (describe :36), `engine/test/table/cells.test.ts` (:101, :107, :115), `engine/test/navigation/nav.test.ts` (:434, :450, and the `reaches a script` assertions at :437/:446/:458/:464 — keep :468's pattern assertion), `engine/test/evaluate/fill.test.ts` ("the gates" :709, :718): replace each 501 assertion by the fill path. Where a test built an `EvalContext` without `scripts`, give it a reader over `readOnlyBridge()`/`runnerOver` (fill.test.ts helpers :48, :57) and assert the evaluation answers values; where it only proved "refused before any step", delete it. `test/script/snippets.test.ts:196,319` test the reach predicate and stay.

  In `engine/test/service/helpers.ts`, drop `openReplica`'s `scripts` option (:266-276).

  Add to the `run.ts` transform tests: "an internal error in an entry with a transform throws at once" — a runner whose first call throws `new Error('boom')`, a run of two entries both with a transform; assert the run rejects with `boom` and the second entry's runner was never called.

- [ ] **Step 2: Run them to see them fail**

  Run: `pixi run engine-test test/service/script-eval.test.ts test/export/reach.test.ts test/table/cells.test.ts test/navigation/nav.test.ts test/evaluate/fill.test.ts` and the `run.ts` test file.
  Expected: FAIL (503 test answers 501; pre-open test answers 501; internal-error test sees deferral).

- [ ] **Step 3: Remove the option and the refusals**

  `service.ts`:
  ```ts
  // field, fixed at construction
  private readonly cells: CellCache | null; // = deps.scripts === undefined ? null : this.cellCache
  ```
  - `open`: delete the `scripts` read (:1685-1688) and `this.cells = …` (:1705). `discard`: keep `dropCells()`, delete `this.cells = null` (:1674).
  - `evaluate()`: always `evaluateFilled` (delete the plain scan :821-840).
  - `pass()`: always pass `scripts` (`...(this.cells === null ? {} : { scripts })` → `scripts`).
  - `fill()`: pass `cache: this.cells ?? undefined`; the runner throws when there is no host:
  ```ts
  runner: async (batch, signal) => {
  	if (this.deps.scripts === undefined) throw new ReadError(503, 'no script host');
  	const { results } = await this.runBatch(batch, signal, epoch);
  	return results.map(({ text }) => text);
  },
  ```
  `scriptCalls`/`scriptWarm` keep `scriptHost()`'s own 501.

  `types.ts`: delete `OpenParams.scripts` and its doc lines (:75-79, and the mention at :37).
  `evaluate/index.ts`: `scripts: ScriptReader` required; rewrite the doc (:26-30) without the 501.
  Delete every refusal listed under Files; `tableScripts` (`table/route.ts:85-86`) answers non-null whenever `tableHasScript`; `resolved(…)` runs `checkTableSnippets` unconditionally (drop its third argument here and at `export/run.ts:206`); `cells.ts:320` asserts `pass.scripts !== null` only for a table that has a script (it is a type guarantee now — keep a plain `Error` if TypeScript needs the narrowing). Delete `exportReachesScript` and its re-export.

  `export/run.ts:256-260`, defer only refusals:
  ```ts
  } catch (error) {
  	if (!deferring || !(error instanceof ReadError)) throw error;
  	if (error instanceof TransformSyntaxError) syntax.push(error);
  	else first ??= { error };
  }
  ```
  `frontend/bench/main.ts:151`: drop `scripts: 'evaluate'` from the open params.

- [ ] **Step 4: Run the tests and the typecheck**

  Run the Step 2 command, then `pixi run engine-check`.
  Expected: PASS. (`engine-check` covers `frontend/bench` only if it is in its tsconfig; if not, also run `pixi run frontend-check`.)

- [ ] **Step 5: README**

  `engine/README.md`: remove the option from the scripts sections; an evaluation reaching a script is always filled; no host → 503; line 32: "an evaluation runs on the replica pinned when its first scan starts".

- [ ] **Step 6: Commit** — `git commit -m "Evaluate scripts whenever the engine has a script host"`

---

### Task 2: The server refuses script work for the app

**Tag:** implementer · **Depends on:** independent

Implements spec R2 (server side).

**Files:**
- Modify: `src/data_rover/api/script_eval.py` (add the dependency and helper)
- Modify: `src/data_rover/api/routes/tables.py` (`evaluate_table` :235/:274-288, `json_preview` :657/:704, `export_table` :544/:575-582, `table_script_errors` :840/:897)
- Modify: `src/data_rover/api/routes/exports.py` (`run_export` :145, `_execute_export` :232/:325-350, `preview_transform` :613/:640-661)
- Modify: `src/data_rover/api/routes/artifacts.py` (`evaluate_navigation` :288/:336-340)
- Modify: `src/data_rover/api/README.md`
- Create: `tests/api/test_scripts_engine_only.py`

**Interfaces:**
- Produces: request header `X-Data-Rover-Scripts: engine-only` → 409 `scripts need the engine` on the seven handlers above when the request reaches a script; `GET /exports/run-by-name` ignores the header (CI).

- [ ] **Step 1: Write the failing tests**

  `tests/api/test_scripts_engine_only.py`. Reuse fixtures/helpers: `client`, `seed_default_project`, `AUTH_HEADERS` (`tests/api/conftest.py`), `CountingRunner` (`tests/api/_script_fakes.py:89`), `_script_table`/`THING_MM`/`VALUE_CODE`/`seed_thing_model` patterns from `tests/api/test_tables_script_status.py:59-118`, `_nav_table` from `test_tables_nav_script.py:136`, `_mk_table`/`_mk_export`/`_run` from `test_exports_route.py:39-92`, `_inline`/`_preview` from `test_exports_transform_preview.py:45-49`. Copy what you need into the new file's own helpers rather than importing private helpers across test modules if the repo does not already do so (check with `grep -rn "from tests.api.test_" tests/api | head`).

  ```python
  ENGINE_ONLY = {**AUTH_HEADERS, "X-Data-Rover-Scripts": "engine-only"}

  def test_evaluate_table_with_script_column_refuses(...):
      # CountingRunner installed via app.dependency_overrides[get_runner]
      r = client.post(papi("/tables/evaluate"), json={...script table...}, headers=ENGINE_ONLY)
      assert r.status_code == 409
      assert r.json()["detail"] == "scripts need the engine"
      assert runner.calls == 0

  def test_evaluate_table_without_scripts_is_unchanged(...): -> 200 with the header
  def test_evaluate_table_without_header_is_unchanged(...): -> 200, script_status not None
  def test_json_preview_with_script_column_refuses(...)
  def test_table_export_with_transform_only_refuses(...):  # Review Focus 3: no script column, a transform
      ...; assert runner.calls == 0
  def test_table_script_errors_refuses(...)
  def test_exports_run_refuses_before_any_entry_runs(...):
      # two entries: first a plain table, second a script table → 409 and runner.calls == 0
  def test_exports_run_by_name_ignores_header(...): -> the usual 200/202
  def test_preview_transform_refuses(...)
  def test_evaluate_navigation_with_script_step_refuses(...)
  def test_evaluate_navigation_without_script_step_is_unchanged(...)
  ```
  Fill each `...` with the request bodies the cited helpers build.

- [ ] **Step 2: Run to see them fail**

  Run: `pixi run -e core-dev pytest tests/api/test_scripts_engine_only.py -q` — Expected: FAIL (200/202 instead of 409).

- [ ] **Step 3: Implement**

  `script_eval.py`:
  ```python
  ENGINE_ONLY_HEADER = "X-Data-Rover-Scripts"

  def scripts_engine_only(
      x_data_rover_scripts: Annotated[str | None, Header()] = None,
  ) -> bool:
      """The app evaluates scripts in its engine and asks the server never to."""
      return x_data_rover_scripts == "engine-only"

  def refuse_scripts(engine_only: bool, reaches_script: bool) -> None:
      if engine_only and reaches_script:
          raise HTTPException(status.HTTP_409_CONFLICT, "scripts need the engine")
  ```
  Each handler gains `engine_only: Annotated[bool, Depends(scripts_engine_only)]` and calls `refuse_scripts` right after it resolves its definition, before `open_script_context`/`open_transform_host`/any sweep kick:
  - `evaluate_table`, `json_preview`, `table_script_errors`: `table_has_script(defn)`.
  - `export_table`: `table_has_script(defn) or (defn.transform is not None and not defn.transform.is_empty)`.
  - `evaluate_navigation`: `navigation_has_script(defn)`.
  - `preview_transform`: `True`, after its 422 checks (:640-659).
  - `_execute_export` gains `engine_only: bool` (keyword); `run_export` passes it, `run_by_name` passes `False`. Pre-pass after the 422 checks (:325-339), before :350: refuses if any transform code is not `None`, or any entry's table (resolved with `_resolve_table(EvaluateTableIn(artifact_id=t.id, offset=0, limit=100), project_id, db)`) has a script; map `LookupError` there to the same 422 as :406.
  `HTTPException` already passes the handlers' `except LookupError/ValueError` blocks.

- [ ] **Step 4: Run tests and lint**

  Run: `pixi run -e core-dev pytest tests/api/test_scripts_engine_only.py -q` then `pixi run backend-lint`. Expected: PASS.

- [ ] **Step 5: README** — `src/data_rover/api/README.md`: one paragraph on the header (who sends it, the 409, run-by-name exempt).
- [ ] **Step 6: Commit** — `git commit -m "Refuse script work on the server for a client that runs scripts itself"`

---

### Task 3: Frontend foundations and the table surface

**Tag:** implementer · **Depends on:** independent

Implements spec R2 (frontend: header, error kind, the shared state, the table surface).

**Files:**
- Modify: `frontend/src/lib/api/client.ts` (headers in `apiFetchRaw` :138-150, `apiUpload` :215-217, constant beside `CSRF_HEADER` :70-71)
- Modify: `frontend/src/lib/api/errors.ts` (add `isScriptsNeedEngine` beside `isUnauthorized` :40)
- Create: `frontend/src/lib/components/ScriptsNeedEngine.svelte`
- Modify: `frontend/src/lib/api/engine-route.ts` (`Fallback` :28, detail map :121, `mark` :241)
- Modify: `frontend/src/lib/api/types.ts` (pending cell :1308-1309, `script_status` :1338, 202 note :1375, Fallback unions :693,1340)
- Modify: `frontend/src/lib/api/tables.ts` (`evaluateTable` unchanged; `fetchScriptErrors` :279 → `route('tables', …, 'tableScriptErrors' …)`)
- Modify: `frontend/src/lib/state/table-editor.svelte.ts` (poll and recap retry: :102-116, :192, :254-290, :587, :655-703, :745-778, :952, :1122; `'script'` union :169; `_errors` :177 gains a kind)
- Modify: `frontend/src/lib/components/Table/TableView.svelte` (:106 note, :203, :229, :647, :752, :826-846), `frontend/src/lib/components/Table/TableGrid.svelte` (:31, :531-532, :612-613)
- Delete: `frontend/src/lib/components/Table/Cell/PendingCell.svelte`
- Modify: `frontend/README.md`, `frontend/src/lib/engine/README.md`
- Test: delete `frontend/src/lib/state/__tests__/table-editor-script-status.test.ts`; rewrite `table-editor-script-errors.test.ts` to the routed recap; update `api/__tests__/engine-route.test.ts` (6× 501 'reaches a script'), `api/__tests__/tables.test.ts`, `components/Table/__tests__/TableView.test.ts`, `TableGrid.test.ts`, `state/__tests__/table-editor-repage.test.ts`, `table-editor-staged-edits.test.ts`, `metamodel-editor.test.ts` (1× 501); create `api/__tests__/client-scripts-header.test.ts`

**Interfaces:**
- Produces: `SCRIPTS_HEADER = 'X-Data-Rover-Scripts'`, `SCRIPTS_ENGINE_ONLY = 'engine-only'` (client.ts); `isScriptsNeedEngine(err: unknown): boolean` (errors.ts); `<ScriptsNeedEngine />` (no props; renders "Scripts need the engine" and one line: "Open the app where the engine can run — scripts are not evaluated on the server."); `getTableError(id)` answering `{ kind: 'scripts' } | { kind: 'error'; message: string } | null`; `Fallback = 'pattern' | 'rules'`.

- [ ] **Step 1: Failing tests**
  - `client-scripts-header.test.ts`: with MSW, assert `apiFetch` and `apiUpload` send `X-Data-Rover-Scripts: engine-only`; `isScriptsNeedEngine` is true for `ApiError(409, {detail:'scripts need the engine'}, 'scripts need the engine')`, false for another 409.
  - `TableView.test.ts`: a server answer 409 `scripts need the engine` renders `ScriptsNeedEngine` (by its text) and no grid.
  - `table-editor-script-errors.test.ts`: the recap is called through the engine seam (`tableScriptErrors`) and has no 202 branch.

- [ ] **Step 2: Run them** — `pixi run frontend-test src/lib/api/__tests__/client-scripts-header.test.ts src/lib/components/Table/__tests__/TableView.test.ts src/lib/state/__tests__/table-editor-script-errors.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**
  ```ts
  // client.ts
  export const SCRIPTS_HEADER = 'X-Data-Rover-Scripts';
  export const SCRIPTS_ENGINE_ONLY = 'engine-only';
  // in apiFetchRaw, beside the CSRF header:
  if (!headers.has(SCRIPTS_HEADER)) headers.set(SCRIPTS_HEADER, SCRIPTS_ENGINE_ONLY);
  // in apiUpload, beside setRequestHeader(CSRF_HEADER…):
  xhr.setRequestHeader(SCRIPTS_HEADER, SCRIPTS_ENGINE_ONLY);

  // errors.ts
  export function isScriptsNeedEngine(err: unknown): boolean {
  	return err instanceof ApiError && err.status === 409 && err.message === 'scripts need the engine';
  }
  ```
  Then remove, per Files: the `script` reason and its note keys (the markers stay for `pattern`); `pending` cell kind and `PendingCell`; `script_status`, the `computing`/`failed` strips, `busy`, the 202 progress; the poll loop, `cancelPoll`, `handleScriptStatus`, the recap's 202 retry and the `fromPoll` re-issue. `_errors` stores the kind: on `isScriptsNeedEngine(error)` store `{kind:'scripts'}`; `TableGrid` renders `<ScriptsNeedEngine />` for it, the existing `<p class="p-4 text-xs text-destructive">` otherwise. `fetchScriptErrors` goes through `route('tables', cfg, (call) => call('tableScriptErrors', asSent(body), signal), () => apiFetch(...))`, mirroring `evaluateTable` (:42-75). Leave `api/tables.ts`'s export functions (`exportTable`, `preparing`) to Task 9.

- [ ] **Step 4: Run** the Step 2 files plus every test file listed under Files, then `pixi run frontend-check`. Expected: PASS.
- [ ] **Step 5: READMEs** — `frontend/README.md` and `frontend/src/lib/engine/README.md`: no `script` fallback; the header; the table's "scripts need the engine" state.
- [ ] **Step 6: Commit** — `git commit -m "Show that scripts need the engine on tables and drop pending cells"`

---

### Task 4: Cap CSP-violation reports per batch

**Tag:** implementer · **Depends on:** independent

Implements spec R6 (K-108 (1)).

**Files:**
- Modify: `engine/src/script/pool.ts` (`onMessage` :603-614; per-slot state :87-104)
- Test: `engine/test/script/pool-protocol.test.ts` (beside :404, :421)

**Interfaces:**
- Produces: `VIOLATION_REPORTS_PER_BATCH = 16` (module constant in pool.ts).

- [ ] **Step 1: Failing test** — in `pool-protocol.test.ts`, "relays at most 16 CSP violations per batch and counts again on the next": drive a worker (the file's fake worker protocol) to post 40 well-formed `csp-violation` messages during one batch; assert `onViolation` was called 16 times; run a second batch posting 3; assert 19 total. Add "a violation while no batch runs is relayed under the same cap" if `active` can be null there (count against the slot's counter, reset when a batch starts).
- [ ] **Step 2: Run** — `pixi run engine-test test/script/pool-protocol.test.ts` — Expected: FAIL (40).
- [ ] **Step 3: Implement** — a `violations: number` on the slot, reset to 0 where `phase = 'running'` is set (:519); in `onMessage`, `if (slot.violations++ >= VIOLATION_REPORTS_PER_BATCH) return;` before calling `options.onViolation`.
- [ ] **Step 4: Run** the test file and `pixi run engine-check`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Relay at most 16 CSP violations per script batch"`

---

### Task 5: `runSnippet` on the engine

**Tag:** implementer · **Depends on:** Task 1 (`service.ts`, `types.ts`)

Implements spec R3 (engine side) and K-107 (1).

**Files:**
- Create: `engine/src/script/console.ts` (params reading, op gate, answer building)
- Modify: `engine/src/service/service.ts` (`METHODS` :476-574; `readScriptBatch` :343-348; reuse `runScripts`/`runBatch` :1074-1135)
- Modify: `engine/src/service/types.ts` (beside `ScriptCallsResult` :136-147), `engine/src/index.ts` (export the types)
- Modify: `engine/README.md`, `architecture/contracts.md` (CT-4: `runSnippet`)
- Test: create `engine/test/script/console.test.ts` (pure gate/params), `engine/test/service/run-snippet.test.ts`

**Interfaces:**
- Consumes: `snippetFetch(artifacts)` (`engine/src/script/snippets.ts:83`), `entryArity` (`engine/src/script/arity.ts:213`), `OP_KINDS` (`engine/src/read/wire.ts:172`), `wc.rev`, `wc.stagedVersion`.
- Produces:
  ```ts
  export type RunSnippetParams = {
  	code?: string; artifact_id?: string;           // exactly one
  	entry: 'script' | 'value' | 'step';
  	element_ids: string[];                          // value: ≥ 1; step: exactly 1
  	inputs?: Record<string, unknown>;               // value only; the harness's wire shape
  };
  export type RunSnippetResult = {
  	stdout: string;
  	result_repr: string | null;
  	ops: unknown[];                                 // model ops only
  	error: { kind: string; message: string; traceback: string | null } | null;
  	truncated: boolean;
  	duration_ms: number;
  	stamp: { rev: number; staged: number };
  };
  ```
  Method name `runSnippet`; cancel by the call's `{cancel}`; refusals: 404 `snippet not found` (no artifact), 422 wrong kind / bad params (texts as the server's `snippets.py:260-272` and `schemas.py:1347-1363`), 501 from `scriptHost()` with no host.

- [ ] **Step 1: Failing tests**
  - `console.test.ts`: `readRunSnippet` refuses both/neither of `code`/`artifact_id`, `value` with 0 ids, `step` with 2 ids, `inputs` with `script`; `gateOps([{kind:'update_element',…}])` passes; `gateOps([{kind:'create_artifact'}])` answers `{ ok: false }`.
  - `run-snippet.test.ts` (on `connect(autoHost(), portPair(), { scripts: cappedNodeScriptHost(2) })` + `openReplica`):
    - "answers today's shape over the working copy": stage a rename, run `result = dr.get(id).name` (use the facade API the corpus uses; see `engine/test/script/` cases), assert `result_repr` is the staged name and `stamp` equals `{rev, staged}` of the replica.
    - "proposes ops and applies none": `dr.get(id).set(name='x')` → one `update_element` op; a following `getElement` answers the old name.
    - "a saved snippet runs by artifact_id"; "an unknown artifact_id is 404".
    - "a forged non-model op empties the ops and answers a runtime error" (Review Focus 2): code calling the facade's `_transport` directly with `{"op": "record_op", "op_dict": {"kind": "create_artifact"}}` — read `facade_src.py:108-110` and `engine/src/script/bridge.ts:371-390` for the exact request shape.
    - "cancel stops a runaway run": `while True: pass` with the call's signal aborted after the run starts (await the pool's start event as `runaway.test.ts` does) → rejects with the cancel, and the replica answers a read afterwards.
    - "transform with console is refused": `scriptCalls` with `entry:'transform', console:true` → 422.
- [ ] **Step 2: Run** — `pixi run engine-test test/script/console.test.ts test/service/run-snippet.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**
  - `console.ts`: `readRunSnippet(params): RunSnippetParams` (throws `Refused(422, …)`), `gateOps(ops: readonly unknown[]): { ok: true } | { ok: false; kind: string }` (accepts kinds in `OP_KINDS`), `consoleAnswer(text, ops, ms, stamp): RunSnippetResult` (parses the harness's `{stdout, result_repr, truncated, error?}`; a failed gate answers `ops: []` and `error: { kind: 'runtime', message: 'the script proposed a <kind> op, which is not a model op', traceback: null }`).
  - `service.ts`: `runSnippet: (service, call) => service.runSnippet(call)` in `METHODS`; `runSnippet` reads params, resolves `artifact_id` through `snippetFetch(this.artifacts)`, reads `stamp` from `this.ready()` before submitting, builds a one-call `ScriptBatch` (`console: true`, `inputs_text` from `dumpDefault(inputs)` when present), and reuses the `runScripts` path (recording dispatcher only for `script`).
  - `readScriptBatch`: `if (entry === 'transform' && console) throw new Refused(422, 'a console run has no transform entry')`.
- [ ] **Step 4: Run** the Step 2 files and `pixi run engine-check`. Expected: PASS.
- [ ] **Step 5: Docs** — `engine/README.md` (console section), CT-4 line for `runSnippet`.
- [ ] **Step 6: Commit** — `git commit -m "Run snippet console calls on the engine"`

---

### Task 6: Settle a fill round in scheduler slices

**Tag:** critical-implementer — the stamp check moves from one synchronous point into a restartable scan job, and a mistake lets a result computed before a transition into the cache after that transition's eviction. **critical-reviewer** — a stale cached script cell is silent wrong data that the tests can miss.
**Depends on:** Task 5 (`service.ts`)

Implements spec R4 (K-114 (4)).

**Files:**
- Modify: `engine/src/evaluate/fill.ts` (`FillOptions` :47-60; round loop :277-320)
- Modify: `engine/src/service/service.ts` (`fill()` :863-907; add a settle job beside `pass()`)
- Modify: `engine/README.md`, `BACKLOG-ENGINE.md` K-114 (4) (eviction key computation recorded; `batchesOf` recorded)
- Test: `engine/test/evaluate/fill.test.ts`, `engine/test/service/script-eval.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // FillOptions
  /**
   * Runs the settle of a round as model-lane work in slices; `run` makes the steps afresh on
   * every start. Absent, the steps are drained at once.
   */
  slices?: (run: () => Steps<void>, signal: FillSignal) => Promise<void>;
  ```

- [ ] **Step 1: Failing tests**
  - `fill.test.ts`: "settles through `slices` when given": a `slices` that records it was called and drains `run()`; assert the cache holds the round's results. "a settle that starts after a transition enters nothing": `slices` bumps the `transitions` counter before calling `run()`; assert the cache holds none of the round and the fill runs another round. "a settle restarted after a transition stops there": `slices` drains part of `run()`, bumps the counter, calls `run()` afresh and drains it; assert only entries settled before the bump are in the cache.
  - `script-eval.test.ts` (Review Focus 1): over a real service with `tracked()` (its `hook.after` holds a round's result back), hold a round of a script-column table, release it, and stage an edit that touches one row's read-set as soon as the settle job starts (hook: wrap the service's scheduler submit via the existing test seam, or stage right after release on the same tick so the stage queues behind the settle); assert the answered page shows the edited row's new value and a second `evaluateTable` asks the host only for that row.
  - "the engine answers a staged ping during a 10,000-call settle within one slice": not here — Task 7's bench measures it.
- [ ] **Step 2: Run** — `pixi run engine-test test/evaluate/fill.test.ts test/service/script-eval.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**
  `fill.ts` — replace the settle loop:
  ```ts
  let settled = false;
  const settleRound = function* (): Steps<void> {
  	// Called again when the job restarts: the stamp is checked on every start.
  	if (transitions() !== stamp) return;
  	let done = 0;
  	for (let g = 0; g < groups.length; g++) {
  		const { entry, keys } = groups[g]!;
  		for (let i = 0; i < keys.length; i++) {
  			if (memo.has(keys[i]!)) continue;
  			const text = texts[g]![i]!;
  			const { result, sound } = settle(text, entry, stdoutChars);
  			memo.set(keys[i]!, result);
  			if (sound) cache?.put(keys[i]!, result, text);
  			if (++done % SETTLE_STEP === 0) yield { done, total: stats.calls };
  		}
  	}
  	settled = true;
  };
  if (slices) await slices(settleRound, signal);
  else drain(settleRound());
  if (signal.aborted) aborted(signal);
  if (!settled) continue;
  ```
  with `const SETTLE_STEP = 256;`. Check `memo.has` is right for a restart (a key settled before the restart is not settled twice); if `memo` can hold a key from an earlier round for a different stamp, clear-on-stamp-change at the loop head already handles it — verify.
  `service.ts` — in `fill()`, `slices: (run, signal) => this.settleSlices(call, run, signal, start)`, where `settleSlices` submits `{ kind: 'scan', run: () => { start(); return run(); } }` on the model lane under `call.id`, cancels on abort exactly as `pass()` does (:924-956), and resolves on the job's outcome. A running scan holds transitions behind it (`scheduler.ts:52-60`), so the stamp check on each start covers the whole job.
- [ ] **Step 4: Run** the Step 2 files, `pixi run engine-test test/service`, and `pixi run engine-check`. Expected: PASS.
- [ ] **Step 5: Docs** — `engine/README.md`: a round settles in slices; K-114 (4): fixed for settle and put; eviction's key computation and `batchesOf` recorded as still synchronous.
- [ ] **Step 6: Commit** — `git commit -m "Settle a script fill round in scheduler slices"`

---

### Task 7: The bench pings during the script table

**Tag:** implementer · **Depends on:** Task 1 (`frontend/bench/main.ts`)

Implements spec R4's bench line.

**Files:**
- Modify: `frontend/bench/main.ts` (`scriptTable` cold export :596-598; `ping(client)` :85), `frontend/bench/run.ts` (`SLICES` :35)

- [ ] **Step 1: Implement** — wrap the cold `exported()` in `ping(client)` exactly as the other slice measures do, and report it as `longest staged round trip during the script table (slice bound)`; add that label to `SLICES` in `run.ts` so it gets a slice verdict line.
- [ ] **Step 2: Check** — `pixi run frontend-check`. The bench itself runs only in Task 12.
- [ ] **Step 3: Commit** — `git commit -m "Ping the engine during the bench's script table"`

---

### Task 8: Fill progress across replicas, and prewarm on

**Tag:** implementer · **Depends on:** Task 6 (`service.ts`)

Implements spec R7 (Known Issue 2) and R6 (prewarm, K-108 (3)).

**Files:**
- Modify: `engine/src/service/service.ts` (`fills` :699, `fill()` `mine`/`start()` :864-877, `postScripts` :961-970, `endFill` :977-988, `prewarmScripts()` :1176-1190)
- Modify: `sandbox/src/engine-worker.ts:28`
- Modify: `engine/README.md`, `sandbox/README.md`
- Test: `engine/test/service/script-eval.test.ts`, the prewarm tests (`grep -rln prewarmScripts engine/test`)

- [ ] **Step 1: Failing tests**
  - "a fill of a dropped replica counts in no progress of the next": with `tracked()` holding a round, `openReplica` again (drops the first); start a fill on the new replica; collect `progress {task:'scripts'}` events; assert every `total` equals the new fill's calls only.
  - "the snippet scan is skipped while the artifacts have not moved": with `prewarmScripts: true` and no snippet, move placements twice (no artifact change) and assert the artifacts were scanned once (spy on `artifacts.ids` through the test's artifact set, or count via a wrapper the existing prewarm tests use).
- [ ] **Step 2: Run** — the two files. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `mine = { done: 0, total: 0, epoch: -1 }`; `start()` sets `mine.epoch = this.epoch` with the local `epoch`. `postScripts` skips `fill.epoch >= 0 && fill.epoch !== this.epoch`. `endFill(fill, post)`: when `!post`, delete it (and reset the sums if empty) without adding to `fillsEnded`.
  - `prewarmScripts()`: a `prewarmScanned = -1` field; return early when `this.artifacts.version === this.prewarmScanned`; set it after the scan.
  - `sandbox/src/engine-worker.ts`: `{ ...createHost().deps, scripts: browserScriptHost, prewarmScripts: true }`.
- [ ] **Step 4: Run** the files, `pixi run engine-check`, `pixi run sandbox-check`. Expected: PASS.
- [ ] **Step 5: READMEs** — engine (progress), sandbox (prewarm on).
- [ ] **Step 6: Commit** — `git commit -m "Count only the live replica's fills in progress and prewarm scripts"`

---

### Task 9: Exports, transform preview and navigation in the frontend

**Tag:** implementer · **Depends on:** Task 3 (`api/types.ts`, `api/tables.ts`, `TableView.svelte`, READMEs)

Implements spec R2 for exports, transform preview and navigation.

**Files:**
- Modify: `frontend/src/lib/api/tables.ts` (`preparing` :93, 202 branch of `exportResponse` :124), `frontend/src/lib/api/exports.ts` (:49, :61 docs; `previewTransform` :83-92 → `route('exports', …, 'previewTransform' …)`)
- Modify: `frontend/src/lib/util/export-download.ts` (`retryAndDownload` :45-70, constants :13-22)
- Modify: `frontend/src/lib/components/Export/ExportDialog.svelte` (:49, :124, :132-138), `ExporterTab.svelte` (:185, :205-234, :342-343), `TransformTestPanel.svelte` (:66-107, :150), `frontend/src/lib/components/Table/TableView.svelte` (`exportTable` :542-560, :910-911)
- Modify: `frontend/src/lib/state/navigation-editor.svelte.ts` (`_evalErrors` :197 → kind; :132 union; `runPreview` catch :947-954), `frontend/src/lib/components/Navigation/ResultsDock.svelte` (:62, :89-90, :107-108, :119), `StatusChip.svelte:20`
- Modify: `frontend/README.md`
- Test: `util/__tests__/export-download.test.ts`, `api/__tests__/exports.test.ts`, `exports-route.test.ts`, `artifacts.test.ts`, `components/Export/__tests__/ExporterTab.test.ts`, `TransformTestPanel.test.ts`, `components/Navigation/__tests__/results-dock.test.ts`, `components/Table/__tests__/TableView.test.ts`

**Interfaces:**
- Consumes: `isScriptsNeedEngine`, `<ScriptsNeedEngine />` (Task 3); `getReplicaStatus()` (`state/replica.svelte.ts:329`).

- [ ] **Step 1: Failing tests** — ExporterTab and TableView export: a 409 `scripts need the engine` renders `ScriptsNeedEngine`; no 202 retry exists (export-download test of a 202 is deleted; a 200 downloads). TransformTestPanel: with phase `server`, renders the state and calls nothing (MSW handler unused); with the engine, calls `previewTransform` on the seam. results-dock: a 409 renders the state in the body.
- [ ] **Step 2: Run** those files. Expected: FAIL.
- [ ] **Step 3: Implement** — remove `preparing`, the 202 branches and `retryAndDownload` (the download path calls the export once); map `isScriptsNeedEngine` to the state in each surface; `TransformTestPanel` shows `<ScriptsNeedEngine />` when `getReplicaStatus().phase` is `off` or `server`, else calls the routed `previewTransform`; drop its 429/503 branches. `_evalErrors` holds `'scripts' | 'error'`.
- [ ] **Step 4: Run** the Files' tests and `pixi run frontend-check`. Expected: PASS.
- [ ] **Step 5: README**, then **Step 6: Commit** — `git commit -m "Show that scripts need the engine on exports and navigations"`

---

### Task 10: The console on the engine (frontend)

**Tag:** implementer · **Depends on:** Task 5 (`RunSnippetParams`/`RunSnippetResult`), Task 9 (`api/types.ts`, READMEs)

Implements spec R3 (frontend).

**Files:**
- Modify: `frontend/src/lib/state/replica.svelte.ts` (stamp: `_stamp` and `getWorkingStamp()`; `callEngine<T>(method, params, {signal})` over `_sync`)
- Modify: `frontend/src/lib/api/snippets.ts` (`runSnippet` → engine; drop `cancelSnippet`), `frontend/src/lib/api/types.ts` (`SnippetRunOutSchema` :825-835 → `RunSnippetResult` imported as a type from `$engine`)
- Modify: `frontend/src/lib/state/snippet-editor.svelte.ts` (`runSnippetTab`/`stopSnippetTab` :208-266; `SnippetRunState` :104-115; `markRunStaged` :173-176; abort on close/rekey/reset :433, :527, :550)
- Modify: `frontend/src/lib/snippet/console-view.ts` (`isResultStale`), `frontend/src/lib/state/snippet-stage.ts`, `frontend/src/lib/state/stage-proposed.ts` (:48-54)
- Modify: `frontend/src/lib/components/Snippet/SnippetConsole.svelte` (:14, :19-49), `SnippetResultView.svelte` (:53-61), `SnippetTestPanel.svelte` (:98, :115-178)
- Modify: `frontend/README.md`, `frontend/src/lib/engine/README.md`
- Test: `state/__tests__/snippet-editor.test.ts`, `snippet-stage.test.ts`, `stage-proposed.test.ts`, `snippet/__tests__/console-view.test.ts`, `components/Snippet/__tests__/snippet-test-panel.test.ts`, `snippet-result-view.test.ts`, create `state/__tests__/working-stamp.test.ts`

**Interfaces:**
- Consumes: `RunSnippetResult` with `stamp: {rev, staged}`; the `changed` event's `rev` and `staged_version` (`engine/src/service/types.ts:56-62`).
- Produces: `getWorkingStamp(): { rev: number; staged: number } | null` (reactive; `null` on a new link, re-bootstrap, or phase `off`/`server`); `isResultStale(result: Pick<RunSnippetResult,'stamp'>, current: {rev,staged} | null): boolean` (true when `current` is null or differs in either field); `stageProposedOps(ops, stamp)`.

The frontend's vitest has no script host (`engine/testing.ts` builds the in-process engine without one, and Pyodide lives only in `engine/node_modules`). Console tests therefore drive the engine boundary with a seam whose `call` answers a `RunSnippetResult` (as the existing route tests stub the seam), and the real run is proven by Task 5 and Task 11's e2e. Do not add a script host to the frontend's vitest.

- [ ] **Step 1: Failing tests**
  - `working-stamp.test.ts`: `changed` events move the stamp; a new link / phase `server` resets it to `null`.
  - `console-view.test.ts`: `isResultStale` true when `staged` differs, when `rev` differs, when current is `null`; false when equal.
  - `stage-proposed.test.ts` (Review Focus 4): a stamp that moved before staging refuses; the check is repeated after the awaits (locks, `commitsLanded`) — the stamp moving during `acquireLocks` refuses.
  - `snippet-editor.test.ts`: Run calls `runSnippet` on the engine with the tab's signal; Stop aborts it (signal aborted) and the tab returns to idle; closing/rekeying a running tab aborts; with phase `server` the console shows the state and calls nothing.
  - `snippet-test-panel.test.ts`: same no-engine state; 429/503 cases deleted.
- [ ] **Step 2: Run** those files. Expected: FAIL.
- [ ] **Step 3: Implement** — per Interfaces. `runSnippetTab` holds an `AbortController` per tab; the result keeps `stamp`; `stagedRunId` becomes the result object's identity (or a local counter id); Stage disabled when `isResultStale(result, getWorkingStamp())`. Remove the 429/503 notices and "the server ends it at the wall timeout" text.
- [ ] **Step 4: Run** the Files' tests and `pixi run frontend-check`. Expected: PASS.
- [ ] **Step 5: READMEs**, then **Step 6: Commit** — `git commit -m "Run the snippet console on the engine and guard Stage by the working copy"`

---

### Task 11: e2e

**Tag:** implementer · **Depends on:** Tasks 1, 2, 3, 5, 8, 9, 10

Implements spec Tests/e2e and T-9.

**Files:**
- Modify: `frontend/e2e/eval-tables.spec.ts:277-346`, `eval-navigation.spec.ts:232-277`, `eval-exports.spec.ts:230-240`, `script-embedding.spec.ts:92-244`, `snippet-flow.spec.ts` (:121 locator; the flow on the engine)
- Create: `frontend/e2e/scripts-need-engine.spec.ts`

- [ ] **Step 1: Edit specs** — fallback markers and pending cells become assertions of engine-evaluated values; `script-embedding` waits for values, not `computing`; `snippet-flow.spec.ts:121` uses `page.getByRole('option', { name: /Renamed by snippet/ })` and runs console → Stage → commit. New spec: set `localStorage['dr.surfaces'] = JSON.stringify({ tables: 'server' })` before load, open a script table, expect the "Scripts need the engine" text.
- [ ] **Step 2: Build and run only the touched specs first** — stop any running sandbox `vite preview`, `pixi run sandbox-build`, then `pixi run frontend-test-e2e -- e2e/eval-tables.spec.ts e2e/eval-navigation.spec.ts e2e/eval-exports.spec.ts e2e/script-embedding.spec.ts e2e/snippet-flow.spec.ts e2e/scripts-need-engine.spec.ts`. Expected: PASS.
- [ ] **Step 3: Full e2e once** — `pixi run frontend-test-e2e`. A failure listed in T-15/T-11/T-12 is rerun alone before it counts; anything else is a regression to fix.
- [ ] **Step 4: Commit** — `git commit -m "Cover scripts on the engine and with no engine in e2e"`

---

### Task 12: Documents, backlog and final gates

**Tag:** implementer · **Depends on:** Task 11

Implements spec R5, R8 and Documents.

**Files:**
- Modify: `architecture/decisions.md` (AD-34: no option; the accepted limit of R5 with its reason), `architecture/contracts.md` (CT-4: option removed, `runSnippet`, 503 `no script host`; CT-5.5: scripts read the working copy), `architecture/program.md` (D done)
- Modify: `BACKLOG-ENGINE.md` (close K-74; K-107 (1) done; K-108 (1)(3) done; K-114 (4) done for settle/put, (10) accepted; T-15 gains `eval-compare:231`, `replica:64`, `script-embedding:114`, `strict-mode:41`, `view:85`; each R8 item keeps a line saying why it does not block), `BACKLOG.md` (close T-9; update R-3)

- [ ] **Step 1: Write the documents** as listed.
- [ ] **Step 2: Gates (orchestrator runs them, once):** `pixi run dr-tidy`; `pixi run dr-test`; `pixi run engine-scripts-browser` (stop any sandbox preview first). Then **ask the owner whether the machine is quiet**, and only then `pixi run engine-bench-browser`; record the script table median (gate ≤ 3,000 ms), the new slice line, and the exports' slice (K-113) in K-100/K-113. If the gate misses, stop and report — do not tune.
- [ ] **Step 3: Commit** — `git commit -m "Record plan 4 of scripts in the browser"`
