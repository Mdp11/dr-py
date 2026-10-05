# Sub-project F: thin server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server stops loading models. The engine answers every case it used to refuse, the
frontend drops every server fallback, and the server's model-reading routes, script runner and
dead Python core are deleted. Commits run on a partial model read from head tables. Snapshots
and import stream rows, and `Session` hydration is gone.

**Architecture:** Three phases in one plan, with a checkpoint between the second and the third.
- **Phase A, the engine answers everything.** Engine and frontend only.
- **Phase B, removal.** The fixtures are frozen, the test seeding moves to helpers, then the
  server's model-reading code is deleted.
- **Phase C, the thin server.** Head tables are introduced *dual-written* beside the session
  model and proven equal to it. The commit check then switches to a partial model loaded from
  them. Snapshots and import move to rows, and finally `ProjectState` replaces `Session`.

**Tech Stack:**
- FastAPI, SQLAlchemy 2, Alembic, pytest on in-memory SQLite, plus an opt-in Postgres lane
- the TypeScript engine (vitest)
- SvelteKit 5 (vitest happy-dom + MSW, Playwright)
- `ijson` 3.5 (conda-forge), for streamed import

**Spec:** `docs/superpowers/specs/2026-10-05-thin-server-design.md`. Its section "Rulings from
the plan inventory" overrides the earlier sections where they conflict.

## Global Constraints

- **Tests, focused.** A task runs only the test files it creates or edits, plus the typecheck and
  lint of each package it touched: `pixi run engine-check`, `pixi run frontend-check`,
  `pixi run backend-lint`, `pixi run core-lint`. Single files: `pixi run engine-test test/x.test.ts`,
  `pixi run frontend-test src/lib/x.test.ts`, `pixi run -e core-dev pytest tests/api/test_x.py`.
  The full suites (`dr-test`, `dr-tidy`, `frontend-test-e2e`) run only in Tasks 7 and 22.
- **No sleeping.** No `sleep`, timed waits or polling loops in shell or tests. Tests wait on
  events or promises and use no fake timers. Long commands run in the foreground, or in the
  background with a completion notification.
- **The real engine.** Tests run the real engine, never a mock. Scripted engine tests run on
  `cappedNodeScriptHost(2)`. `dispose()` every in-process link.
- **Mutation boundaries.** The `Model` (`core/model/model.py`) and the engine op applier are the
  only mutation boundaries (RC-8). Property values are replaced wholesale, never mutated in
  place.
- **Wire text.** It reaches the engine as received (AD-26).
- **Comments.** Concise, present tense, no history, no spec or plan references (RC-6). A
  behaviour change updates its owning README in the same commit (RC-10).
- **New error texts, verbatim:**
  - regex: `pattern {pyRepr(p)} uses {reason}, which is not supported` (422)
  - facet issue: `{name}: pattern {pyRepr(p)} cannot be checked: {reason}`
  - compare file: `not a UTF-8 JSON model file` / `invalid JSON: {message}` (422)
  - change request: `invalid change request: {message}` (422)
  - rebind preview, containment: `commit or unstage model edits before changing containment`
    (409)
  - rebind refusal: `rebind leaves {n} entities the new metamodel cannot hold: {first ids, at most 5}` (422)
  - history range: `range too wide: at most 1000 revisions` (422)
  - commit-check bound: `commit check did not converge` (500, logged with the batch's op kinds
    and counts)
- **Python.** Python 3.14. ruff, mypy and pyright must pass (`backend-lint`, `core-lint`).
- **Migrations.** Alembic files are named `NNNN_snake_name.py` with `revision = "NNNN"`. The
  head at plan start is `0016`. This plan adds `0017` (Task 5) and `0018` (Task 13).
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, or the
  attribution the agent's harness gives.
- **Branch.** Work stays on `engine-migration`. Never push or merge.

## Review Focus

1. **A batch that reaches an entity the planner did not load.** For example, an element is
   attached under X and then X is deleted, or a relationship is created to an element whose
   other edges were never loaded. The check must re-run with the missing rows and give exactly
   the full model's answer, never a silently different one. Pinned in Task 15 (differential
   test, attach-then-delete) and Task 14 (guard unit tests).
2. **Two commits racing on one project.** They must serialize, and neither may read the other's
   half-written rows. The second must see the first's rev in its stale-rev check. Pinned in
   Task 20 (Postgres lane, two threads) and Task 15 (overlap check reads under the row lock).
3. **An import that fails on its last check** (a cycle, or a dangling reference at the end of the
   file). It must leave no project, no rows and no snapshot. Pinned in Task 18.
4. **A call made while the replica is still opening.** It must wait and then answer from the
   engine, not error and not hang after the replica becomes ready. A replica that fails while the
   call waits must reject it with the overlay showing. Pinned in Task 3.
5. **A model value `1.0`, an integer past 2^53, or a bare `NaN`/`Infinity` in an imported file.**
   It must round-trip through import, head rows, snapshot and the engine's open exactly as today.
   Pinned in Task 18 (import) and Task 17 (snapshot from rows).

## Execution order and parallelism

| Lane | Tasks |
|---|---|
| Engine → frontend (phase A) | 1 → 2 → 3 → 4 → 5 → 6 → 7 |
| Python tests and fixtures, beside phase A | 8 (independent) → 9 |
| Removal (phase B) | 10 → 11 (after 7 and 9) |
| Checkpoint | 12 (after 11) |
| Thin server (phase C) | 13 → 14 → 15 → 16 → 17 → 18 → 19 → 20 |
| Close | 21 (after 20), 22 (after 21) |

Tasks 8 and 9 touch only `tests/`, `scripts/`, `pixi.toml` tasks and `api/importer.py`, so they
share no file with Tasks 1–7. Run them beside phase A in a side worktree
(`git worktree add ../data-rover-py-fe`; symlink `.pixi`, `node_modules`, `engine/`,
`frontend/`, `sandbox/node_modules`; Python needs `PYTHONPATH=src`). Task 5 also edits
`api/schemas.py` and `routes/commits.py`, which Tasks 8 and 9 do not touch.

---

## Phase A: the engine answers everything

### Task 1: Engine refusals become answers (regex, compare file, change request, rule sets, rebind preview)

**Tag:** implementer · **Depends on:** independent

**Files:**
- Modify: `engine/src/search/criteria.ts:215-252`
- Modify: `engine/src/cr/read-file.ts:17,55,67`
- Modify: `engine/src/cr/propose.ts:24,63-65`, and its `unreadable()` call sites at
  :80, 91, 97, 108, 140-141, 151, 154, 160, 181, 183, 196, 198, plus the doc comment at :189
- Modify: `engine/src/rules/compile.ts:100-122`
- Modify: `engine/src/validation/candidate.ts:37,168-243`
- Modify: `engine/src/service/service.ts` (:316 `candidateRefusal` rules branch, :1280 the
  `rules` refusal in `live()`, :1450-1452)
- Modify: `engine/README.md` (the 501 table and fallback paragraphs)
- Test: `engine/test/search/criteria.test.ts` (:166-190, :298), `engine/test/navigation/nav.test.ts` (:473-499), `engine/test/service/evaluations.test.ts` (:23, :94), `engine/test/cr/propose.test.ts` (:99), `engine/test/service/cr.test.ts` (:171, :340-351), `engine/test/rules/sources.test.ts` (:169-193), `engine/test/service/candidate.test.ts`, `engine/test/golden/model-steps.ts` (:642-643, :690)

**Interfaces:**
- Produces:
  - `compileCriteria` throws `ReadError(422, …)` for an untranslatable or host-refused pattern.
  - `UNSUPPORTED` is deleted.
  - `readModelFile` throws `ReadError(422, …)`.
  - `proposeCr` throws `ReadError(422, 'invalid change request: ' + message)`.
  - `compileRuleSets` never sets `unreadable`. It pushes a `skipped` entry
    `{artifact_id, set_name, rule: '', reason}` and the `unreadable` field is deleted.
  - `stagedAdmitted(...)` becomes `stagedRefusal(...): Refused | null`.

- [ ] **Step 1: Rewrite the 501 assertions as the new answers (failing)**
  - **criteria.test.ts:**
    - each `unsupported` case now expects status 422, with a detail matching
      `/^pattern .* uses .*, which is not supported$/`
    - add a case for `(?i:abc)` expecting the reason `inline flags not at the start or scoped`
    - add a host-refused case (a repeat count past V8's limit) expecting the fixed reason
      `a construct this browser cannot compile`
  - **nav.test.ts:473-499 and evaluations.test.ts:** the same shape, through navigation and
    through `evaluateTable`.
  - **cr tests:**
    - non-UTF-8 bytes → 422 `not a UTF-8 JSON model file`
    - `{` → 422 starting `invalid JSON: `
    - a change-request document with `rev: "3"` → 422 starting `invalid change request: `
    - more than 20 change requests → 422 naming the limit
  - **sources.test.ts:**
    - a rule set with `parse: null` → `getModelIssues` answers 200
    - `rules_status.skipped` contains `{set_name, rule: '', reason: 'rule set could not be read'}`
    - the other sets' issues are present
  - **candidate.test.ts (service):**
    - a staged `create_element` of a type the candidate lacks → 422 `Unknown element type 'X'`
    - an abstract type → 422 `Cannot instantiate abstract type 'X'`
    - an unknown property → 422 `'T' has no property 'p'`, matching `ops/apply.ts:47`
    - a staged `delete_element` while containment differs → 409
      `commit or unstage model edits before changing containment`

- [ ] **Step 2: Run them to see them fail**

  Run: `pixi run engine-test test/search/criteria.test.ts test/navigation/nav.test.ts test/service/evaluations.test.ts test/cr/propose.test.ts test/service/cr.test.ts test/rules/sources.test.ts test/service/candidate.test.ts`
  Expected: FAIL, with 501s where 422/409 are expected.

- [ ] **Step 3: Implement**

  `criteria.ts`:
  ```ts
  const HOST_REFUSED = 'a construct this browser cannot compile';
  function unsupported(pattern: string, reason: string): ReadError {
  	return new ReadError(422, `pattern ${pyRepr(pattern)} uses ${reason}, which is not supported`);
  }
  // :243  if (regex.kind === 'unsupported') throw unsupported(p, regex.reason);
  // :225  onHost: beyondHost errors → throw unsupported(p, HOST_REFUSED);
  ```
  - `read-file.ts`: replace `UNREADABLE_FILE` with the two 422s. The second carries
    `error.message`.
  - `propose.ts`: `unreadable(message: string)` returns
    `new ReadError(422, \`invalid change request: ${message}\`)`. Give each call site the strict
    reader's message, or a fixed one naming the field (for example `"rev" must be an integer`).
  - `compile.ts:100-122`:
    - each `unreadable = true` becomes `skipped.push({ artifact_id, set_name, rule: '', reason })`
    - the reason is `'rule set could not be read'` for `parse === null`, the parse's message for
      a failed parse, and `RulesUnreadable`'s message for a strict-reader refusal
    - delete the field
  - `candidate.ts`: `stagedRefusal` returns the first refusal, in op order, as
    `{ status: 422, detail }` (the server wording above) or `{ status: 409, detail }` (the
    containment case). It returns `null` when every op is admitted.
  - `service.ts:1450`: `const refusal = stagedRefusal(...); if (refusal) throw new Refused(refusal.status, refusal.detail);`.
  - Delete the `rules` branches at :316 and :1280.

- [ ] **Step 4: Run the tests and the typecheck**

  Run: the Step 2 command, then `pixi run engine-check`.
  Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "Engine answers refused patterns, files, change requests, rule sets and rebind previews"`

### Task 2: Facet patterns degrade per value; Preview reports untranslatable patterns

**Tag:** implementer · **Depends on:** Task 1 (same `service.ts`, `candidate.ts`)

**Files:**
- Modify: `engine/src/validation/pipeline.ts:75,91-139` (`FacetPatterns`, `PatternUnusable`)
- Modify: `engine/src/validation/validators/facets.ts:93`
- Modify: `engine/src/validation/live.ts`: delete the `'pattern'` broken mode at :253, 298-299,
  336, 351, 368, 380, 404, 453-471, 500-536, 603, 634, 650
- Modify: `engine/src/validation/candidate.ts:32-38` (`prepareCandidate`)
- Modify: `engine/src/service/service.ts:315,1278,1302,1423,1507`
- Modify: `engine/README.md` (validation section)
- Test: `engine/test/validation/live.test.ts` (:880-902, :1109-1151), `engine/test/validation/candidate.test.ts` (:359-371), `engine/test/validation/values.test.ts`, `engine/test/service/issues.test.ts` (:296), `engine/test/service/candidate.test.ts` (:259, :530)

**Interfaces:**
- Produces:
  - `FacetPatterns.test(pattern, value): boolean | { reason: string }`.
  - `FacetPatterns.unusable(): Array<{ pattern: string; reason: string }>` lists the patterns
    that cannot be compiled.
  - `candidateIssues` throws `Refused(422, …)` naming type, property, pattern and reason when the
    candidate metamodel has an untranslatable facet pattern.

- [ ] **Step 1: Failing tests**
  - **values.test.ts:**
    - a property with facet pattern `(?i:x)`: each value gets exactly one issue,
      `{name}: pattern '(?i:x)' cannot be checked: inline flags not at the start or scoped`,
      with severity `error`, category `conformance`, and `targetIds` the owner
    - a sibling property with a good pattern still reports its mismatches
  - **live.test.ts:** replace the "broken mode" cases.
    - `getModelIssues` answers 200 over a model with an untranslatable pattern.
    - Staging an edit to an unrelated element updates issues as usual.
  - **issues.test.ts:296:** expects 200 and the per-value issue.
  - **service candidate tests:** `candidateIssues` with a candidate whose facet pattern is
    `(?<=a+)b` answers 422 with a detail containing the type, the property and
    `cannot be checked`.

- [ ] **Step 2: Run to see them fail**

  Run: `pixi run engine-test test/validation/values.test.ts test/validation/live.test.ts test/validation/candidate.test.ts test/service/issues.test.ts test/service/candidate.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement**
  - `FacetPatterns` keeps a `Map<string, Test | { reason: string }>`. A compile failure stores
    the reason: `regex.reason`, or `'a construct this browser cannot compile'` for a
    `beyondHost` error.
  - A RangeError while matching stores `{ reason: 'a construct this browser cannot compile' }`
    for that pattern from then on.
  - `facets.ts:93`:
    ```ts
    const verdict = patterns.test(def.pattern, item);
    if (typeof verdict === 'object') issues.push(errorIssue(`${name}: pattern ${pyRepr(def.pattern)} cannot be checked: ${verdict.reason}`, [ownerId]));
    else if (!verdict) issues.push(errorIssue(`${name}: ${pyRepr(item)} does not match pattern ${pyRepr(def.pattern)}`, [ownerId]));
    ```
  - Delete `PatternUnusable`, `broken`, the live store's `'pattern'` mode and the service's
    refusals that read it.
  - `prepareCandidate` throws `Refused(422, \`${type}.${prop}: pattern ${pyRepr(p)} cannot be checked: ${reason}\`)`
    for the first entry of `unusable()`.

- [ ] **Step 4: Run tests and `pixi run engine-check`.** Expected: PASS.

- [ ] **Step 5: Commit**

  `git commit -m "Engine reports an uncheckable facet pattern per value and in Preview"`

### Task 3: `route()` serves from the engine only

**Tag:** critical-implementer. Reason: it replaces the server fallback with waiting on the
replica gate and one retry after a sync settles, which is ordering-sensitive async code.
**Depends on:** Task 2

**Files:**
- Modify: `frontend/src/lib/api/engine-route.ts`. Delete:
  - `Fallback` (:28) and `ShadowWhen` (:35)
  - `RouteOptions.mark/shadow/digest/stale/recheck` (:37-55)
  - `Outcome` and `ShadowProbe` (:69-87)
  - `EngineSeam.side/gone/shadow` (:94-100)
  - `engineSide` (:110)
  - `FALLBACKS` and `fallbackOf` (:115-128)
  - `REFUSED_OPS` and `refusedOps` (:134-138)
  - `MOVED` and `movedUnder` (:141-150)
  - `comparableWhileStaged` (:157)
  - the `serverCall` parameter and its branches (:188-195, :211-247)
- Modify: every `route()` caller, dropping its server lambda:
  - `api/elements.ts:18`
  - `api/model-read.ts:46,60,79,111,138,187,209,268,318,354`
  - `api/tables.ts:53,203,237,264`
  - `api/metamodel.ts:67`
  - `api/artifacts.ts:73`
  - `api/changeRequest.ts` (two calls)
  - `api/checkout.ts:96,108`
  - `api/validation.ts:45,102`
  - `api/exports.ts:29,84`
  - `api/views.ts:50`
- Delete:
  - `api/model-ops.ts`
  - `api/relationships.ts`
  - `api/model.ts`'s `GET /model`
  - the legacy CRUD in `api/elements.ts` (:13, :31, :43)
  - `api/model-read.ts` neighborhood (:159) and changes (:338, :343)
  - every server-only helper that only a deleted lambda used
  - their re-exports in `api/index.ts:17-18`
- Modify: `frontend/src/lib/engine/seam.ts`: the seam exposes `call` and `whenReady()` only.
  `side`, `switches` and `gone` go.
- Test: `frontend/src/lib/api/__tests__/engine-route.test.ts` (rewrite), `download-route`, `compare-route`, `views-route`, `exports-route`, `metamodel-route`, `tables`, `validation`, `checkout`, `engine-reads`, `model-read`, `artifacts` route tests under `frontend/src/lib/api/__tests__/`

**Interfaces:**
- Produces:
  ```ts
  export interface EngineSeam {
  	call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  	whenReady(signal?: AbortSignal): Promise<void>; // resolves when the gate opens; rejects with EngineUnavailableError when the phase becomes failed or unavailable
  }
  export class EngineUnavailableError extends Error {}
  export async function route<T>(method: string, params: unknown, opts?: { signal?: AbortSignal }): Promise<T>;
  ```
- Behaviour of `route()`:
  1. Await `seam.whenReady()`.
  2. Call the engine.
  3. On a 409 whose detail is one of `stale base_rev`, `stale staged batches`,
     `replica is not ready` or `replica closed`, await `whenReady()` again and retry once.
  4. A second refusal is thrown as `ApiError(409, detail)`.
  5. Every other engine error is thrown as `ApiError(status, detail)` unchanged.
- Consumes: the `replica.svelte.ts` gate (:338-355), and `sync.ts` phases. Task 4 replaces
  `server` with `unavailable`. Until then `whenReady()` rejects on `server` too.

- [ ] **Step 1: Failing tests in `engine-route.test.ts`.** Delete every fallback, shadow and marker
  case. Add:
  - "a call made while the gate is closed waits and answers from the engine": open the gate
    after the call starts; the call resolves with the engine's answer.
  - "a call waiting on the gate rejects when the replica fails": move the phase to `failed`; the
    call rejects with `EngineUnavailableError`.
  - "a moved 409 is retried once after the gate settles": the engine answers
    `409 stale base_rev`, then 200; `route()` resolves with the 200 body; exactly 2 engine calls.
  - "a second moved 409 reaches the caller".
  - "a 422 from the engine reaches the caller unchanged".

  Each surface route test keeps its engine half; its server half is deleted.
- [ ] **Step 2:** `pixi run frontend-test src/lib/api/__tests__/engine-route.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `whenReady` is built on the existing gate promise in
  `replica.svelte.ts`: one shared promise per gate epoch, rejected on a terminal phase.
  `route()` passes its `signal` to both awaits.
- [ ] **Step 4:** Run the route tests listed under Files, then `pixi run frontend-check`.
  Expected: PASS.
- [ ] **Step 5:** `git commit -m "Frontend routes every surface to the engine and waits for the replica"`

### Task 4: Switches, shadow, legacy staging and the server phase go

**Tag:** implementer · **Depends on:** Task 3

**Files:**
- Delete:
  - `frontend/src/lib/engine/surfaces.ts`
  - `frontend/src/lib/engine/shadow.ts`
  - `frontend/src/lib/state/model-legacy.svelte.ts` (fold its shared `setModelApiConfig = setClientConfig` into `model-engine.svelte.ts`)
  - `frontend/src/lib/components/ReplicaFallbackNotice.svelte`
  - `frontend/src/lib/state/open-progress.svelte.ts`
  - `frontend/src/lib/state/changes.svelte.ts`
  - `frontend/src/lib/api/model-status.ts`
- Modify `frontend/src/lib/state/model.svelte.ts`: remove the `getStagingSide()` fork at
  :33-34, 79, 85, 90, 95, 99, 109, 116, 126, 205-206, 231-235, 249, 262. It re-exports the engine
  store.
- Modify `frontend/src/lib/state/replica.svelte.ts`:
  - delete the switches at :32-36, 319, 332, 358
  - delete the shadow at :323-374
  - delete `getStagingSide` and `stagingOnEngine` (:312-315, :400-402, :417)
  - delete the notice at :408 and :662-669
  - widen `isReplicaBlocked` (:671-676) to `failed`, `unavailable` and retrying
  - `retry()` from `unavailable` runs a fresh connect, not `rebootstrap`
- Modify `frontend/src/lib/engine/sync.ts`:
  - the `server` phase (:31) becomes `unavailable`
  - `giveUp` (:842-852) sets it; `call()` (:417) rejects there
  - `retry()` (:1226-1228) accepts `unavailable` and reconnects
- Modify:
  - `frontend/src/lib/state/checkout.svelte.ts` (forks at :61, 372, 404, 454, 457, 496, 1009)
  - `frontend/src/lib/components/StatusBar.svelte:54` (drop "server mode")
  - `frontend/src/lib/components/Export/TransformTestPanel.svelte:48`
  - `frontend/src/lib/state/index.ts` (:116-119, 202, 207, 591, 595)
  - `frontend/src/lib/state/open-journey.ts:371,406` (drop `anyEngineSurface` and the server
    progress half)
  - `frontend/src/routes/p/[projectId]/+page.svelte` (:20, 34, 47, 83, 105, 150, 152, 215, 304,
    464, 560, 583-584)
  - `frontend/src/routes/projects/+page.svelte:8,45`
  - `frontend/src/lib/components/projects/NewProjectWizard.svelte:8,97`
- Modify `frontend/src/lib/components/ReplicaFailedOverlay.svelte:31-35`: it shows
  `getReplicaStatus().reason` beneath its heading when set.
- Remove the fallback markers:
  - `Table/TableView.svelte` (:43, 106, 194, 530, 714-721)
  - `Export/ExporterTab.svelte` (:12, 191, 222, 339-340)
  - `util/export-download.ts:7-13`
  - `Navigation/ResultsDock.svelte` (:63, 122-124)
  - `state/navigation-editor.svelte.ts` (:133, 932, 949)
  - `state/table-editor.svelte.ts` (:56, 1011, 1028, 1492)
  - `api/tables.ts` (`answeredBy`, `markExport`)
  - `api/exports.ts:8,38`
  - `api/artifacts.ts:78`
- Modify `frontend/vite.config.ts`:
  - a `localhostRedirect` plugin first in `plugins`, for both `configureServer` and
    `configurePreviewServer`
  - `preview: { host: '127.0.0.1' }`
- Delete tests: `engine/__tests__/surfaces.test.ts`, `shadow.test.ts`, `seam.test.ts`, `state/__tests__/changes.test.ts`, `open-progress.test.ts`, `components/__tests__/ReplicaFallbackNotice.test.ts`.
- Rework tests: `state/__tests__/replica.svelte.test.ts`, `model-store`, `validate-staged`, `checkout.*`, `edit-gate`, `table-editor-repage`, `view-warnings.engine`, `TableView.test.ts`, `ExporterTab.test.ts`, `results-dock.test.ts`, `StatusBar.replica`, `NewProjectWizard`, `sync-open`, `sync-call`, `open-journey`, `WorkspacePage.*`, `MetamodelForms`, `MetamodelDiagram`, `ModelChangeDialog`, `TransformTestPanel`, `ProjectCard`, `sync-heal`, `sync-transition`, `view-json-editor`, `metamodel-tab`.

**Interfaces:**
- Produces:
  - `type ReplicaPhase = … | 'unavailable'` (no `'server'`)
  - `isReplicaBlocked(): boolean` covers `unavailable`
  - the overlay reads `getReplicaStatus().reason`
- The redirect plugin:
  ```ts
  function localhostRedirect(): Plugin {
  	const redirect = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
  		const host = req.headers.host ?? '';
  		if (!host.startsWith('localhost:')) return next();
  		res.statusCode = 302;
  		res.setHeader('Location', `http://127.0.0.1:${host.slice('localhost:'.length)}${req.url ?? '/'}`);
  		res.end();
  	};
  	return { name: 'localhost-redirect', configureServer: (s) => void s.middlewares.use(redirect), configurePreviewServer: (s) => void s.middlewares.use(redirect) };
  }
  ```

- [ ] **Step 1: Failing tests**
  - **replica.svelte.test.ts:**
    - "a replica that never becomes ready is unavailable and blocks the workspace":
      `isReplicaBlocked()` is true, and `getReplicaStatus().reason` is the frame's message
    - "retry from unavailable reconnects": a second connect is made, and the phase reaches
      `ready`
  - **ReplicaFailedOverlay test:** the reason text renders.
  - **vite redirect unit test** in `frontend/src/vite-redirect.test.ts`: the middleware answers
    302 to `http://127.0.0.1:5173/p/x?y=1` for host `localhost:5173`, and calls `next` for host
    `127.0.0.1:5173`. Export the plugin's handler from `vite.config.ts` for the test.
- [ ] **Step 2:** Run the new and changed test files → FAIL.
- [ ] **Step 3: Implement** the deletions and changes listed under Files. `grep -rn "dr.surfaces\|dr.shadow\|getStagingSide\|'server'" frontend/src` must return nothing (excluding string literals unrelated to the replica phase).
- [ ] **Step 4:** Run every test file under Files (deleted ones excepted), then `pixi run frontend-check` and `pixi run -e frontend npx eslint` (through `pixi run frontend-lint` if present; otherwise `dr-tidy` covers it in Task 22).
- [ ] **Step 5:** Update `frontend/README.md` (state, switches, staging sections) and `frontend/src/lib/engine/README.md` (seam, phases, shadow). `git commit -m "Frontend drops switches, shadow, legacy staging and the server phase"`

### Task 5: Commits carry client-reported counts

**Tag:** implementer · **Depends on:** Task 4 (`checkout.svelte.ts`)

**Files:**
- Create: `alembic/versions/0017_commit_count_nullable.py`, which makes
  `commits.validation_error_count` nullable
- Modify: `src/data_rover/api/db_models.py:249-255` (`Mapped[int | None]`)
- Modify: `src/data_rover/api/schemas.py`:
  - `CommitRequest` (:1032-1038) gains
    `validation_error_count: int = 0, issues: list[IssueOut] = []`
  - `ack_errors` stays, ignored as today
  - every out-schema field carrying the count becomes `int | None`
- Modify: `src/data_rover/api/routes/commits.py`:
  - `create_commit` writes the request's count and issues where it wrote `conformance`'s
    (:1311, 1330-1331, 1439, 1451, 1499-1504)
  - revert writes `None` and `[]` (:1703, 1716-1717, 1758, 1783-1788)
  - the server-side `conformance` computation stays until Task 10 removes it; this task only
    stops persisting it
- Modify: `frontend/src/lib/api/checkout.ts:147-153` (send `validation_error_count` and
  `issues`)
- Modify: `frontend/src/lib/state/checkout.svelte.ts:393` (pass the preview's
  `conformance_error_count` and `issues`)
- Modify: `frontend/src/lib/components/DiffDrawer.svelte:249,384`
- Modify: the history list component that renders the count (find it with
  `grep -rn "validation_error_count" frontend/src/lib/components`); it shows `—` for `null`
- Modify: `frontend/src/lib/state/realtime.svelte.ts:235`
- Test: `tests/api/test_commits_counts.py` (new), `tests/api/test_alembic.py`, `frontend/src/lib/state/__tests__/checkout.*`, the history component's test

- [ ] **Step 1: Failing tests**
  - `test_commits_counts.py::test_commit_stores_reported_count`: POST `/commits` with
    `validation_error_count: 3` and one issue. The `Commit` row and the response carry exactly
    those values, even though the server would compute a different count for that batch.
  - `::test_revert_stores_null_count`: the revert's row has `validation_error_count is None`
    and `issues == []`.
  - The checkout test asserts that the request body carries the preview's count and issues.
  - The history test renders `—` for `null`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. The migration follows `0016`'s style: `op.alter_column("commits", "validation_error_count", existing_type=sa.Integer(), nullable=True)` inside `batch_alter_table` for SQLite.
- [ ] **Step 4:** Run the four test files, then `pixi run backend-lint` and `pixi run frontend-check`. Expected: PASS.
- [ ] **Step 5:** Update `src/data_rover/api/README.md` (commit section: counts are client-reported). `git commit -m "Commits store client-reported validation counts"`

### Task 6: e2e follows the engine-only frontend

**Tag:** implementer · **Depends on:** Task 5

**Files:**
- Modify: `frontend/e2e/fixtures.ts:3-47` (delete `dr.shadow` and `shadowWatch`)
- Modify: the engine-vs-server pair specs: `eval-download-views.spec.ts` (:66-72, 151-169) and
  `eval-compare.spec.ts` (:64-70, 173-202). Delete the server halves.
- Modify: the shadow assertions in `eval-metamodel.spec.ts:168-213`,
  `engine-mode.spec.ts:147-173`, `eval-navigation.spec.ts:162,228,295,315`, `eval-issues`,
  `eval-rules`, `eval-tables`, `eval-exports` and `staged-edits`
- Modify: the marker assertions in `eval-tables.spec.ts:194,286-395` and
  `eval-navigation.spec.ts:206-265`. They become assertions of the 422 messages from Task 1
  where the case was a refused pattern.
- Modify: `engine-mode.spec.ts:287-312`. The boot-fallback case becomes "a workspace whose
  engine cannot start shows the blocking overlay with its reason". Force it the way the spec
  forced the old fallback today.
- Delete: `scripts-need-engine.spec.ts` (its premise is a server-side table)
- Modify: the switch-setting specs `artifact-commit`, `table-ux`, `snippet-flow`,
  `script-embedding` and `staged-edits`. Drop their `dr.surfaces` setup.

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** Run the changed specs: `pixi run frontend-test-e2e -- <spec files>`. Stop any stale sandbox preview first (CLAUDE.md gotcha). Expected: PASS.
- [ ] **Step 3:** `git commit -m "e2e drops shadow, switches and server pairs"`

### Task 7: Phase A gate

**Tag:** implementer · **Depends on:** Task 6

- [ ] **Step 1:** Run `pixi run engine-test`, `pixi run frontend-test` and `pixi run frontend-test-e2e`. Fix only what this phase broke. A known flake (`smoke:66`, `view:326`, the download-route 5 s timeout, snapshot determinism cold boot) is noted, not fixed.
- [ ] **Step 2:** Commit any fixes. Record the pass counts in the task report.

---

## Phase B: removal

### Task 8: Freeze the golden fixtures

**Tag:** implementer · **Depends on:** independent (runs beside phase A)

**Files:**
- Create: `scripts/engine_tables.py`, the generator for the engine source files whose Python
  source survives. It takes them over from `tests/golden/driver.py:30-39`:
  - the casefold, lower, digit and regex tables (stdlib)
  - `facade.generated.ts` (from `core/script/facade_src.py`)
  - `xlsx-widths.ts` and `xlsx-tables.ts`

  `harness.generated.ts` is no longer generated.
- Create: `tests/golden/test_engine_tables_current.py`, which fails when
  `scripts/engine_tables.py --check` reports a stale file.
- Create: `tests/golden/reader.py`, a slim replacement for `model_steps.py`'s pieces that the
  reader tests need:
  - the deterministic-id mock
  - `observe(model)`, which dumps state and digest
  - `index_dump(model)`, kept from `index_dump.py`
- Create the reader tests. Each loads its fixture from `engine/fixtures/golden/` and asserts
  that the Python result equals it:
  - `tests/golden/test_ops_fixtures.py`: `ops_batches`, `ops_churn`, `ops_recreate`,
    `ops_refused`. Checks `id_map`, changed, deleted and recreated, `before_*`, `inverse_ops`,
    digest and indexes.
  - `tests/golden/test_snapshot_fixture.py`: `snapshot_v2`. Checks the text, the digest, and the
    `same` and `refused` cases.
  - `tests/golden/test_model_fixtures.py`: `model_load`, `smart_city`, `model_mutations`,
    `model_cascades`, `model_indexes`, `model_churn`, `frozen_groups`, `metamodel_caches`,
    `validation_dirty`, `json_parse`, and the STRUCTURAL issues of `validation_kinds`.
- Modify: `scripts/script_corpus_snapshot.py:23`. It inlines the corpus it imported from
  `tests.golden.scenarios.script_bridge`.
- Delete:
  - `tests/golden/__main__.py`, `driver.py`, `model_steps.py`, `tagged.py`, `scripted.py`
  - the table and source renderers
  - `tests/golden/scenarios/`
  - `tests/golden/test_fixtures_current.py`

  Keep `tests/golden/test_engine_xlsx.py` and `index_dump.py` (or fold `index_dump.py` into
  `reader.py`).
- Modify: `pixi.toml`:
  - delete `golden-fixtures` (:116-120) and `engine-parity-large` (:337-348)
  - for the oracle writers at :132-161, apply ruling 7: keep a writer only if it imports no
    module that Tasks 10–11 delete. Otherwise delete it, its task, its input files and the bench
    case that reads them (`engine/bench/run.ts:75,77`, `frontend/bench/run.ts:60-81`)
  - delete `scripts/bench.py`
  - keep `engine-bench-data` (`scripts/snapshot_v2.py`)
- Modify: `CLAUDE.md`. Commands: drop `golden-fixtures` and `engine-parity-large`. The rule "The
  Python core is the oracle for the engine" becomes "Golden fixtures are frozen. A fixture
  change is a reviewed edit; the Python reader tests hold the server's kept code to them."

- [ ] **Step 1:** Write the reader tests first, against the existing fixtures. Run `pixi run -e core-dev pytest tests/golden/test_ops_fixtures.py tests/golden/test_snapshot_fixture.py tests/golden/test_model_fixtures.py`. Expected: PASS, since the fixtures were generated from this code. A failure means the reader is wrong; fix the reader.
- [ ] **Step 2:** Write `scripts/engine_tables.py` and its staleness test. Run `pixi run -e core-dev python scripts/engine_tables.py --check`. Expected: no diff against the committed files.
- [ ] **Step 3:** Delete the generators, scenarios and tasks listed above. Run `grep -rn "tests.golden.scenarios\|tests/golden/driver\|model_steps" --include=*.py --include=*.toml --include=*.ts .`. Expected: nothing outside `.pixi`.
- [ ] **Step 4:** Run `pixi run -e core-dev pytest tests/golden`, `pixi run engine-test test/golden` and `pixi run core-lint`. Expected: PASS.
- [ ] **Step 5:** `git commit -m "Freeze the golden fixtures; Python reads them for its kept code"`

### Task 9: API tests seed and assert through helpers

**Tag:** implementer · **Depends on:** Task 8 (in the same side worktree; shares no file with phase A)

**Files:**
- Modify: `src/data_rover/api/importer.py`. Add:
  ```python
  def install_model(db: Session, project_id: str, *, metamodel_yaml: str, model_json: str | bytes) -> None:
      """Replace the project's metamodel and model with these documents at a fresh baseline (rev 0, no history)."""
  ```
  It does what `POST /metamodel` followed by `POST /model` (`routes/model.py:107`,
  `persist_baseline`) do today, without HTTP. Task 18 reimplements it on head rows; the
  signature does not change.
- Modify: `tests/api/conftest.py`. Add helpers, and rewrite `model_rev`, `element_count` and
  `commit_create` (:133-160) on top of them:
  ```python
  def install(project_id: str = "default", *, metamodel: str = SMART_CITY_MM, model: str = SMART_CITY_MODEL) -> None: ...
  @dataclass(frozen=True)
  class Head:
      rev: int
      elements: dict[str, dict]       # id -> {"id","type_name","properties","rev"}
      relationships: dict[str, dict]  # id -> {..., "source_id","target_id"}
  def head(project_id: str = "default") -> Head: ...
  def commit_ops(client, ops: list[dict], *, project_id: str = "default", base_rev: int | None = None) -> dict: ...
  ```
  - `head()` reads the project's state the way the server holds it. Here that is the registry
    session's model and `model_rev`. Task 15 switches it to head rows, and Task 19 deletes the
    session path.
  - `commit_ops` posts `/commits` with `{base_rev: head().rev if None, ops}` and returns the
    response JSON.
- Modify: every test file that uses `POST /model` (52), `/model/summary` (40), `/model/ops` (34)
  or `/model/upload` / `/model/load` (17):
  - seeding goes through `install(...)`
  - summary counts go through `len(head().elements)` and `len(head().relationships)`
  - ops go through `commit_ops`

  Find them with `grep -rln 'papi("/model")\|/model/summary\|/model/ops\|/model/upload\|/model/load' tests/api`.
- Modify: the files that test `/model/undo` (15). Each undo test becomes a revert test where it
  checks behaviour that revert shares (inverse exactness, recreated entities). Otherwise it is
  deleted. `test_ops_route.py` and `test_exact_rollback.py` keep their applier assertions,
  posted through `/commits`.

- [ ] **Step 1:** Add `install_model` and the helpers. Add `tests/api/test_helpers.py`:
  - `test_install_then_head_round_trips_smart_city`: the counts equal the example file's, and
    `rev == 0`
  - `test_commit_ops_advances_head`
- [ ] **Step 2:** Run `pixi run -e core-dev pytest tests/api/test_helpers.py`. Expected: PASS.
- [ ] **Step 3:** Migrate the files, in alphabetical batches of about 15. After each batch, run that batch's files. The count of passing tests per file must not drop, except for deleted undo-only tests, which you list in the commit message.
- [ ] **Step 4:** Run `grep -rln 'papi("/model")\|/model/summary\|/model/ops\|/model/undo\|/model/upload\|/model/load' tests/` (expected: nothing), then `pixi run -e core-dev pytest tests/api -x -q` and `pixi run backend-lint`.
- [ ] **Step 5:** `git commit -m "API tests seed and assert through install, head and commit_ops"`

### Task 10: The commit path, /open and preview stop validating

**Tag:** implementer · **Depends on:** Tasks 7 and 9

**Files:**
- Create: `src/data_rover/api/structural.py`:
  ```python
  def structural_blockers(model: Model, ids: Iterable[str]) -> list[Issue]:
      """STRUCTURAL issues (dangling element reference, second containment parent, containment cycle) over these ids."""
      issues = ValidationPipeline([TypeConformanceValidator(), ContainmentValidator()]).validate(model, Scope(set(ids)))
      return [i for i in issues if i.category is IssueCategory.STRUCTURAL]
  ```
  The ids are the batch's touched entities plus the referencers of deleted ids. These are
  `res.changed_*`, `res.recreated_*`, and for each id in `res.deleted_elements`
  `model.indexes.referencers_of(id)` as captured before the apply. `DirtyCollector` already
  gathers the referencers; take them from `res.dirty` with only its referencer part, and
  without `expand_dirty`.
- Modify `src/data_rover/api/routes/commits.py`. Delete:
  - the imports at :37-39, 61, 75-83, 142
  - `_CommitUnwind`'s rule and validation restore (:449, 467-471, 481)
  - the seeding at :506, 967 and 1535
  - the empty-batch issue fields (:986-988)
  - the rule recompile (:1131-1149; keep `rebound` at :1138)
  - the widened validation (:1150-1178)
  - the strict gate (:1191-1227)
  - the issue splice (:1228-1238)
  - the cache eviction (:1243-1254)
  - in revert: :1554-1559, 1666-1669, 1681, 1686
  
  The structural gate (:1179-1190, :1670-1680) calls `structural_blockers` and still answers 422
  with the same body.
- `open_project` (:500-515) answers `model_rev`, `role`, `lock_ttl_seconds` and `strict_mode`.
  `elements` and `relationships` stay for now (from the session model; Task 16 moves them to
  `ModelRow`). `issue_counts` is deleted from the schema.
- `preview_commit` (:526-650) keeps its non-model checks (`base_rev`, artifact ops dry, view ops)
  and the model batch's applier 422. Its validation half goes, and it answers no issues.
- Modify: `src/data_rover/api/routes/ops.py`. Delete `_ensure_validation_seeded` (:613-628).
- Modify: `src/data_rover/api/session.py`. Delete `validation`, `compiled_rules`,
  `invalidate_derived_caches`, `evict_touched_caches`, and their calls in
  `set_model`/`touch_model`/`set_metamodel`.
- Test: `tests/api/test_structural_gate.py` (new); trim `test_strict_mode.py` and `test_rules_commit_flow.py` to what remains (strict mode is a stored setting the frontend enforces; delete the server-gate assertions)

- [ ] **Step 1: Failing tests in `test_structural_gate.py`.** Each case runs through `commit_ops`:
  - a reference to a missing id → 422
  - a second containment parent → 422
  - a containment cycle → 422
  - deleting an element that an untouched element references → 422 (the referencer dangles)
  - "an existing structural issue on an untouched neighbour does not block": install a model
    whose element B already has a dangling reference, commit an update to unrelated element A,
    and expect 200
  - "a commit with conformance errors lands under strict mode": strict is client-enforced; the
    server stores the reported count
- [ ] **Step 2:** Run → the neighbour case and the strict case FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pixi run -e core-dev pytest tests/api/test_structural_gate.py tests/api/test_strict_mode.py tests/api/test_rules_commit_flow.py tests/api/test_commits*.py tests/api/test_revert*.py`, then `pixi run backend-lint`.
- [ ] **Step 5:** `git commit -m "Commits check structure over the batch only; validation is the engine's"`

### Task 11: Delete the server's model-reading routes, runner and dead core

**Tag:** implementer · **Depends on:** Task 10

**Files:**
- Delete route modules, and their `include_router` lines and imports (`api/main.py:19-46`,
  `:305-331`):
  - `routes/read.py`
  - `routes/validation.py`
  - `routes/tables.py`
  - `routes/exports.py`
  - `routes/change_request.py`
  - `routes/elements.py`
  - `routes/relationships.py`
  - `routes/model.py`, the whole module, `GET /model/download` included (the frontend
    downloads through the engine). `persist_baseline`'s callers move to `install_model`.
- Partial removals:
  - `routes/artifacts.py:293-385` (`/navigations/evaluate`)
  - `routes/snippets.py:260-438` (`run`, `cancel` and their helpers)
  - `routes/commits.py:722-748` (`/commits/{rev}/model`)
  - `routes/metamodel_swap.py:54-77` (`/metamodel/diff`; keep `/metamodel/structural-diff`)
  - `routes/views.py:66-71` (warnings)
  - `routes/ops.py:821-1215` (`/model/ops`, `/model/undo`, `_finalize`,
    `_persist_undo_commit`, `_resolve_undo_view_id`). The applier and `_persist_commit` stay.
- Delete API modules:
  - `script_sweep.py`, `table_cache.py`, `script_runner.py`, `script_eval.py`,
    `snippet_concurrency.py`
  - `validation_sweep.py`, `search_index_build.py`, `invalidation.py`
  - `search.py`, `table_export.py`, `table_export_engine.py`, `export_manifest.py`
  - `metamodel_candidate.py`, `change_request_ops.py`, `changes.py`, `rules.py`
- Modify:
  - `api/main.py:47,183-229,276,287` (runner boot and shutdown)
  - `api/session.py` (the remaining fields and imports listed in the removal inventory:
    `validation_sweep`, `search_index_build`, `script_cell_cache`, `script_sweeps`, `op_log`,
    `op_log_dropped`, `touch_model`, and the evict guards that read them)
  - `api/hydration.py:25,29,34,38,266,297-301`
  - `api/routes/metamodel.py:21,90,156`
  - `api/settings.py`: delete `xlsx_autofit_max_px`, `validation_sweep_sync`,
    `search_index_sync`, and every `snippet_*` except `snippet_format_timeout_s` and the lint
    and format concurrency settings, if those routes read them
  - `api/schemas.py`: drop the imports and models of deleted routes; keep `metamodel.diff`
- Delete core modules:
  - `core/navigation/{evaluate,resolve}.py`
  - the matchers in `core/search/criteria.py` (:137-312, and the trim in `core/search/__init__.py`)
  - `core/table/{cell_text,cells,csv_export,evaluate,export_layout,json_export,naming,nav_memo,resolve,script_inputs,split,virtual_props}.py`
  - `core/script/{bridge,cell_cache,embed,harness_src,runner,warnings}.py`
  - `core/model/change_request.py`
  - `core/view/validation.py` (and `core/view/__init__.py:5`)
  - `core/validation/state.py`
  - `core/validation/rules/{reach,validator}.py`
  - in `core/validation/dirty.py`: `change_request_dirty_ids` (:355) and the TYPE_CHECKING
    import (:81)
- Modify `core/model/indexes.py` (263, 506, 534, 851-890): the trigram search index goes.
- Delete `scripts/ensure_guest.sh`. In `pixi.toml`, delete the activation hook (:44-45) and the
  `wasmtime` dependency (:41-42).
- Delete tests (about 96 files, by the removal inventory):
  - the `tests/api` files for every deleted route or service
  - `tests/navigation/*` except `test_schema`
  - `tests/script/*` except docs, lint and schema
  - `tests/search/test_criteria` (keep model tests)
  - `tests/table/*` except `test_exporter` and `test_schema`
  - `tests/validation/rules/{reach,validator}*`
  - `tests/validation/test_{validation_state,scoped}`
  - `tests/view/test_validation`
  - `tests/model/*change_request*`

  Trim `tests/model/test_indexes.py` (CR and search parts), `tests/api/test_snippets_routes.py`
  (run and cancel) and `tests/api/test_view_routes.py` (warnings).
- Modify the READMEs:
  - `src/data_rover/api/README.md`: "Session and the delta protocol" bullets 10, 12, 20-22, 24-26;
    persistence :80; check-out :121-128; "Code execution, tables and exports" (144-166) becomes a
    two-line pointer to the engine; metamodel :173, :179
  - `src/data_rover/core/README.md` :9, :16-25
  - `src/data_rover/core/script/README.md`: remove the runner, harness, bridge and evaluation
    sections (167-end, except the facade surface, which docs serves)
  - `CLAUDE.md`: drop the snippet guest gotcha, and change the "per-request path" rule to say
    whole-model work no longer exists on the server

- [ ] **Step 1:** Delete in this order: routes, services, core, tests. Run `pixi run -e core-dev python -c "import data_rover.api.main"` after each group.
- [ ] **Step 2:** Add `tests/api/test_removed_routes.py`. It is parametrized over every deleted path and method and asserts 404 or 405, so a route that survives by accident is caught.
- [ ] **Step 3:** Run `pixi run core-test` (the full Python suite; it is the only way to see a dangling import) and `pixi run backend-lint` + `pixi run core-lint`. Expected: PASS.
- [ ] **Step 4:** `git commit -m "Delete the server's model-reading routes, script runner and dead core"`

### Task 12: Checkpoint (owner)

**Tag:** orchestrator, not an agent · **Depends on:** Task 11

- [ ] **Step 1:** Run a tracer to answer, with `path:line`:
  - Which modules still build a full `Model`?
  - Which routes depend on `get_request_session`, and which session fields does each read?
  - Does anything in Tasks 13–19 contradict the code as it now stands?
- [ ] **Step 2:** Report to the owner: what the server still does, the line counts deleted, any plan amendments for Tasks 13–19. **Stop until the owner says go.**

---

## Phase C: the thin server

### Rulings for phase C (in addition to the spec's)

- **Properties are stored as text.** `properties` is a `Text` column holding exactly the JSON
  text the snapshot line encoder writes for that value (compact, `ensure_ascii=False`). Values
  `NaN`/`Infinity` are written as bare literals, as `parse_model_json` accepts them.
  - Why: Postgres JSONB rejects non-finite numbers, and nothing queries inside properties
    (`entity_refs` is its own table).
  - Reading goes through `parse_model_json`.
  - The snapshot writer splices the text without decoding it.
  - This replaces the spec's "JSON, JSONB on Postgres".
- **Head rows are dual-written first.** Task 13 writes them beside the session model on every
  path that changes the model, and a test proves them equal. Task 15 makes them authoritative.
  The session model is then kept as a mirror (the commit applies its canonical ops there too)
  only for the readers Tasks 16–17 have not moved yet. Task 19 deletes the mirror.
- **Backfill on hydrate, temporary.** A project whose `ModelRow.next_seq` is NULL gets its rows
  written from the hydrated model on first hydrate (Task 13). This keeps development databases
  working through phase C. Task 19 deletes it with hydration; the cutover re-imports (spec §8).
- **`seq` follows model order.** Rows ordered by `seq` must equal the model's dict order, which
  is the order `iter_entity_lines` writes.
  - An entity that exists before and after a batch keeps its `seq`.
  - An entity created or recreated in the batch gets `next_seq`, in the order of the model's
    `indexes.element_order` / `relationship_order` after the apply.
  - A revert's restored entity lands last in the model (`restore_element` passes no order), so
    it gets a fresh `seq` too.

### Task 13: Head tables, dual-written

**Tag:** critical-implementer. Reason: a new persistent schema and its per-commit maintenance;
a wrong `seq` or a stale `entity_refs` row corrupts every later snapshot.
**Depends on:** Task 12 (owner go)

**Files:**
- Create: `alembic/versions/0018_head_tables.py`
- Modify: `src/data_rover/api/db_models.py`. Add:
  ```python
  class ElementRow(Base):
      __tablename__ = "elements"
      project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
      id: Mapped[str] = mapped_column(String, primary_key=True)
      type_name: Mapped[str] = mapped_column(String, nullable=False)
      properties: Mapped[str] = mapped_column(Text, nullable=False)   # JSON text, see ruling
      rev: Mapped[int] = mapped_column(Integer, nullable=False)
      seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
      __table_args__ = (UniqueConstraint("project_id", "seq"),)
  class RelationshipRow(Base):
      __tablename__ = "relationships"
      # the same columns, plus:
      source_id: Mapped[str] = mapped_column(String, nullable=False)
      target_id: Mapped[str] = mapped_column(String, nullable=False)
      __table_args__ = (UniqueConstraint("project_id", "seq"), Index("ix_rel_source", "project_id", "source_id"), Index("ix_rel_target", "project_id", "target_id"))
  class EntityRefRow(Base):
      __tablename__ = "entity_refs"
      project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
      referencer_id: Mapped[str] = mapped_column(String, primary_key=True)
      target_id: Mapped[str] = mapped_column(String, primary_key=True)
      __table_args__ = (Index("ix_refs_target", "project_id", "target_id"),)
  ```
  `ModelRow` gains:
  - `state_digest: String(16) | None`
  - `element_count: int` (default 0)
  - `relationship_count: int` (default 0)
  - `next_seq: BigInteger | None`, where NULL means rows not yet written

  Elements and relationships have separate `seq` spaces.
- Create: `src/data_rover/api/head.py`:
  ```python
  @dataclass(frozen=True)
  class RefProps:
      element: Mapping[str, tuple[str, ...]]       # element type -> element-valued property names
      relationship: Mapping[str, tuple[str, ...]]  # relationship type -> element-valued property names
  def ref_props(metamodel: Metamodel) -> RefProps: ...   # cached per Metamodel identity; mirrors IndexSet._ref_prop_names (indexes.py:754-766)
  def refs_of(properties: Mapping[str, Any], names: Sequence[str]) -> set[str]: ...  # string items, scalar or list, as indexes.py:779
  def encode_properties(properties: Mapping[str, Any]) -> str: ...   # the snapshot line encoder's text for this dict
  def write_baseline(db: Session, project_id: str, metamodel: Metamodel, model: Model) -> None: ...
      # deletes the project's rows and refs, writes every entity in model order (seq 0..n-1 per table), refs, counts, digest, next_seq
  def write_batch(db: Session, project_id: str, metamodel: Metamodel, model: Model, res: _BatchResult) -> None: ...
      # applies one applied batch: upserts touched survivors, deletes deleted ids and their refs-as-referencer, assigns seq per the ruling, replaces refs of touched referencers, updates counts and next_seq; does not commit
  def rebuild_refs(db: Session, project_id: str, metamodel: Metamodel) -> None: ...   # streams rows in chunks of 1000
  def read_head(db: Session, project_id: str) -> tuple[list[dict], list[dict]]: ...  # tests and contract checks only: every row in seq order, decoded
  ```
  `ModelRow.state_digest` is written by `write_baseline` from `digest_value` and by the commit
  path from `fold_batch`. `write_batch` does not touch it.
- Modify: every model-changing path to call the writer in the same transaction as its
  `Commit`/`ModelRow` write. `write_batch` must run before `_persist_commit`'s `db.commit()`:
  split `_persist_commit` (`ops.py:678-751`) into `_stage_commit` (no commit) and the caller's
  commit.
  - `create_commit`: `write_batch`, plus `rebuild_refs` when the batch rebinds
  - `revert_commit`: `write_batch`
  - `install_model` and `import_project`: `write_baseline`
  - `hydration._hydrate_session`: backfill when `next_seq` is NULL
  - clone: through `import_project`
- Test: `tests/api/test_head_rows.py` (new), `tests/api/test_alembic.py`

- [ ] **Step 1: Failing tests (`test_head_rows.py`)**
  - `test_install_writes_rows_in_model_order`: after `install()` of smart-city, `read_head` equals
    the model's elements and relationships in dict order, with `properties` decoded. Counts,
    `next_seq` and `state_digest` match the model.
  - `test_rows_follow_random_commits`: a seeded `random.Random(7)` drives 200 commits through
    `commit_ops`: creates, updates, deletes under containment, relationship churn,
    delete-then-recreate of the same id in one batch, and reverts of random ranges. After each,
    `read_head` equals the session model in order and content, the `entity_refs` rows equal
    `{(r, t) for r, t in model refs}`, and `ModelRow.state_digest` equals the session digest.
  - `test_float_and_bigint_survive`: properties `1.0`, `2**60`, `float("nan")` and
    `float("inf")` round-trip through rows exactly (the decoded value's `repr` is equal).
  - `test_rebind_rebuilds_refs`: a rebind that turns a string property into an element-valued
    one makes its values appear in `entity_refs`.
  - `test_backfill_on_hydrate`: clear the rows and set `next_seq = NULL`, evict, hydrate; the
    rows return equal.
  - The `test_alembic.py` case upgrades to 0018 and downgrades to 0017.
- [ ] **Step 2:** Run `pixi run -e core-dev pytest tests/api/test_head_rows.py tests/api/test_alembic.py` → FAIL.
- [ ] **Step 3:** Implement. Writes use bulk `insert` and `delete ... where id in (...)` in chunks of 500. Sort touched ids by the model's order before assigning `seq`.
- [ ] **Step 4:** Run the Step 2 command, plus `pixi run -e core-dev pytest tests/api/test_commits*.py tests/api/test_revert*.py tests/api/test_importer.py` and `pixi run backend-lint`. Expected: PASS.
- [ ] **Step 5:** `git commit -m "Head tables, written beside the session model on every change"`

### Task 14: A partial `Model`

**Tag:** critical-implementer. Reason: the guard decides whether a commit check can ever see
incomplete data; it changes read sites inside the frozen core.
**Critical-reviewer:** a read that slips past the guard gives a wrong accept or reject without
any test failing, so a dangling reference or a containment cycle could be committed.
**Depends on:** Task 13

**Files:**
- Create: `src/data_rover/core/model/partial.py`:
  ```python
  class NotLoaded(Exception):
      def __init__(self, ids: Iterable[str]) -> None:
          self.ids = frozenset(ids)
          super().__init__(f"not loaded: {sorted(self.ids)[:5]}")
  @dataclass(frozen=True)
  class PartialRows:
      elements: Sequence[Mapping[str, Any]]       # seq order, decoded
      relationships: Sequence[Mapping[str, Any]]  # seq order; both endpoints of each are in `elements`
      absent: frozenset[str]                       # queried in both tables, found in neither
      edges_complete: frozenset[str]               # elements whose every incident relationship is loaded
      parents_complete: frozenset[str]             # elements whose every incoming containment relationship is loaded
      referencers_complete: frozenset[str]         # ids whose every referencer is loaded
  def build_partial_model(metamodel: Metamodel, rows: PartialRows) -> Model: ...
  ```
- Modify: `src/data_rover/core/model/model.py` and `indexes.py`:
  - Every read of an edge, parent or referencer index goes through an `IndexSet` accessor
    (`outgoing_ids`, `incoming_ids`, `parents_of`, `first_parent`, `referencers_of`, and a
    `children_of` if missing). That covers the raw reads at `model.py:266,270,274,298-299` and
    `indexes.py:640-648`, `containment_closure` (`core/validation/dirty.py:86-105`), and
    `required_locks`' `rel_source` (`api/locking.py:476-478`).
  - Writes stay raw.
  - `settle_order` (`model.py:247-261`) reorders the dicts in place (`clear()` + `update()`) so
    a guarded dict keeps its class.
  - The search index is already gone (Task 11). In partial mode `rebuild` builds no uniqueness
    groups (conformance is the engine's).
- Behaviour in partial mode:
  - **Entity dicts** (`model.elements`, `model.relationships`) are a `dict` subclass. A key that
    is present answers as usual.
  - **Absent ids.** A missing key that is in `absent`, or was deleted during this model's life,
    answers "absent" (`in` is False, `.get` returns the default, `[]` raises `KeyError`).
  - **Any other missing key** raises `NotLoaded({key})` from `__contains__`, `get` and
    `__getitem__`.
  - **Created ids.** An id created during this model's life counts as complete for every guard.
  - **Accessors.** `outgoing_ids` / `incoming_ids` need the id in `edges_complete`; `parents_of`
    / `first_parent` need it in `parents_complete` or `edges_complete`; `referencers_of` needs it
    in `referencers_complete`. Otherwise they raise `NotLoaded({id})`. A full model has no
    guards: the accessors answer as today.
  - **Not an exception subclass.** `NotLoaded` must not subclass `KeyError` or `ValueError`, so
    `_apply_batch`'s 422 mapping (`ops.py:524`) does not swallow it.
    `_apply_batch` re-raises it after `_rollback`.
- Test: `tests/model/test_partial.py` (new); the golden reader tests from Task 8 (`tests/golden/test_model_fixtures.py`, `test_ops_fixtures.py`) must stay green, since they hold the read-site rewrite to the old behaviour.

- [ ] **Step 1: Failing tests (`test_partial.py`)**, each on a small hand-built metamodel with one containment relationship type:
  - absent id: `"x" in m.elements` is False, `m.get_element("x")` raises KeyError
  - unknown id: `"y" in m.elements` raises `NotLoaded`, whose `.ids == {"y"}`
  - `outgoing_ids(e)` for an e loaded only as another relationship's endpoint raises `NotLoaded`
  - `first_parent(a)` with `a` in `parents_complete` answers the loaded parent
  - an element created by `insert_element` answers every accessor
  - a deleted element answers absent afterwards
  - `_apply_batch` on a batch that touches an unloaded id raises `NotLoaded` (not a 422), and
    the model is rolled back
  - `settle_order` keeps the guards (after a rollback, an unknown id still raises `NotLoaded`)
  - full-model parity: on a model loaded with every row and every id in all complete sets, a
    seeded run of 100 random batches gives the same `_BatchResult` (canonical ops, inverses,
    `id_map`, changed, deleted, recreated, before states) and the same `structural_blockers` as
    on a normal `Model`
- [ ] **Step 2:** Run `pixi run -e core-dev pytest tests/model/test_partial.py` → FAIL.
- [ ] **Step 3:** Implement. First the read-site rewrite, then run the golden reader tests and `tests/model` (they must stay green before the guard exists). Then add the guard.
- [ ] **Step 4:** Run `pixi run -e core-dev pytest tests/model tests/golden tests/validation` and `pixi run core-lint`. Expected: PASS.
- [ ] **Step 5:** `git commit -m "A partial Model that refuses to answer from rows it did not load"`

### Task 15: The commit check runs on a partial model

**Tag:** critical-implementer. Reason: the transaction, the row lock, the miss-and-re-run loop
and the write order are the core invariant of the thin server.
**Critical-reviewer:** a wrong load plan or write order can commit a structurally broken model,
or corrupt rows and the digest.
**Depends on:** Task 14

**Files:**
- Create: `src/data_rover/api/commit_load.py`:
  ```python
  MAX_ROUNDS = 8
  def plan_load(db: Session, project_id: str, metamodel: Metamodel, ops: Sequence[ModelOpIn], extra: frozenset[str] = frozenset()) -> PartialRows: ...
  def load_and_apply(db: Session, project_id: str, metamodel: Metamodel, ops: list[ModelOpIn], *, restore: bool) -> tuple[Model, _BatchResult]: ...
      # rounds of plan_load → build_partial_model → _apply_batch; on NotLoaded add e.ids to extra; past MAX_ROUNDS raise HTTPException(500, "commit check did not converge") after logging op kinds and counts
  def subtree_ids(db: Session, project_id: str, roots: Collection[str], containment_types: Collection[str]) -> set[str]: ...  # recursive CTE down
  def ancestor_ids(db: Session, project_id: str, starts: Collection[str], containment_types: Collection[str]) -> set[str]: ...  # recursive CTE up
  ```
- What `plan_load` loads, for named ids N and `extra` E:
  - **N:** update and delete targets, relationship endpoints, element-valued values in created
    and updated properties (per `ref_props`), and id hints.
  - **Delete roots:** the `delete_element` targets, and every element in E.
    - The containment subtree S of the roots (`subtree_ids`).
    - Every relationship incident to S, and that relationship's other endpoint.
    - Every element of S is `edges_complete`.
    - The referencers of every id in S and of every deleted relationship id (`entity_refs` by
      target), with those ids in `referencers_complete`.
  - **Containment relationships created, or restored by a revert:**
    - the target's incoming containment relationships, with the target `parents_complete`
    - `ancestor_ids` of the source, each with its incoming containment relationships, each
      `parents_complete`
  - **Plain relationship creates and deletes:** their endpoints, loaded without completeness.
    The applier only writes their edge sets.
  - **Endpoints:** every endpoint of every loaded relationship.
  - **Absence:** every named or extra id found in neither table goes into `absent`.
  - **Bounds:** queries use `IN` lists chunked at 500. The CTEs carry the containment type list
    as a bound parameter. Row order is `seq`.
- Modify `src/data_rover/api/routes/commits.py` (`create_commit`, `revert_commit`):
  1. Open the transaction. `db.execute(select(ModelRow).where(ModelRow.project_id == pid).with_for_update())`; the session's `write_mutex` is still held around it (CN-10, SQLite).
  2. The stale-rev overlap check moves here, under the row lock. `base_rev` is compared with
     `ModelRow.model_rev`, and the tail is read in the same transaction. `_batch_touched_ids`
     runs on the partial model after the load.
  3. `load_and_apply`.
  4. `structural_blockers(model, ids)` from Task 10. On blockers, roll back and answer 422 as
     today.
  5. `required_locks` on the partial model, then lease verification.
  6. `capture_entity_states` always. Delete `ENTITY_STATES_MAX` (`commit_states.py:39,68-71`).
  7. `ModelRow.state_digest = format_digest(fold_batch(parse_digest(row.state_digest), model, res))`.
  8. `write_batch`, `_stage_commit`, then commit.
  9. After the commit, apply `res.canonical_ops` to the session model mirror with the same
     applier (restore mode for revert), set `session.model_rev`, and broadcast inside the mutex
     as today.

  The metamodel and artifact/view halves keep their order around the model half.
- Modify the `head()` test helper (`tests/api/conftest.py`): it reads `read_head` and
  `ModelRow.model_rev`.
- Test: `tests/api/test_commit_differential.py` (new), `tests/api/test_commit_load.py` (new); the existing commit and revert tests

- [ ] **Step 1: Failing tests**
  - **`test_commit_load.py`:**
    - `plan_load` for a delete loads exactly the subtree, the incident relationships and their
      endpoints, and the referencers (assert the id sets on a hand-built model of about 30
      entities)
    - for a containment connect, it loads the ancestor chain
    - an unknown id lands in `absent`
  - **`test_commit_load.py::test_attach_then_delete_reruns`:** one batch connects existing
    element C (outside every planned set) under X with a containment relationship, then
    deletes X. The commit converges in 2 rounds. C and its subtree are gone, and the rows equal
    the full-model result.
  - **`test_commit_load.py::test_round_bound`:** monkeypatch `MAX_ROUNDS = 1` on that same batch;
    the answer is 500 `commit check did not converge`, and no row changed.
  - **`test_commit_differential.py`:** for each seed in `range(300)`:
    1. Generate a model: 40–120 elements under a random containment forest, 0–80 plain
       relationships, element-valued properties, a few pre-existing dangling references.
    2. `install` it.
    3. Generate a batch of 1–12 ops from the kinds: create, update with refs, delete (root, leaf,
       middle), connect containment (including cycle-making and second-parent), disconnect,
       delete-and-recreate, id-hint collision across tables.
    4. Commit it through `commit_ops`.
    5. Apply the same batch to a full `Model` built from the same dicts, with
       `_apply_batch(restore=False)` and `structural_blockers`.
    6. Assert: the same accept or reject; on reject the same status and detail; on accept equal
       `read_head` and full-model order and content, equal `entity_refs`, equal `entity_states`,
       `inverse_ops` and `id_map` in the response or row, and an equal digest.
    7. Then revert the commit and assert the rows return to the installed state.

    Print the seed in the assertion message.
- [ ] **Step 2:** Run `pixi run -e core-dev pytest tests/api/test_commit_load.py tests/api/test_commit_differential.py` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the Step 2 command, then `tests/api/test_commits*.py tests/api/test_revert*.py tests/api/test_head_rows.py tests/api/test_structural_gate.py tests/api/test_locks*.py` and `pixi run backend-lint`. Expected: PASS.
- [ ] **Step 5:** `git commit -m "Commits run the applier on a partial model read from head rows"`

### Task 16: Locks, rebind, preview, /open, metamodel and history read rows

**Tag:** critical-implementer. Reason: the rebind's set-based checks and the history fold
replace whole-model paths. Ruling 11 tightens rebind.
**Depends on:** Task 15

**Files:**
- Modify: `src/data_rover/api/routes/locks.py:75,89` and `api/locking.py:382-419`.
  `expand_targets` takes `subtree_ids` from `commit_load` for DELETE-exclusive model targets,
  and no model.
- Create: `src/data_rover/api/rebind_check.py`:
  ```python
  def rebind_refusals(db: Session, project_id: str, metamodel: Metamodel, *, limit: int = 5) -> tuple[int, list[str]]: ...
      # streams elements then relationships in seq chunks of 1000; an entity is refused when its type is unknown, an element type is abstract, or a property key is undeclared; returns (count, first `limit` ids)
  def containment_violations(db: Session, project_id: str, containment_types: Collection[str]) -> list[str]: ...
      # second parents (GROUP BY target_id HAVING count > 1 over the new containment types) and cycles (a walk over the (source, target) id pairs of those types)
  ```
- Modify: `routes/commits.py` (rebind hoist) and `api/metamodel_ops.py:144`.
  - After `load_candidate`, run `rebind_refusals`. If the count is above 0, answer 422
    `rebind leaves {n} entities the new metamodel cannot hold: {ids}`.
  - Run `containment_violations`; any violation is a 422 naming the first ids.
  - Then `rebuild_refs`, and the forced snapshot (until Task 17 the snapshot still comes from
    the session mirror).
  - The `Scope.all()` validation at `commits.py:1157-1188` goes.
- Modify `routes/commits.py`:
  - `open_project` (:500) takes `elements` and `relationships` from `ModelRow` counts, with no
    `require_model`.
  - `preview_commit` no longer requires the model. It checks `base_rev` against `ModelRow`, runs
    the artifact and view dry checks, and dry-runs the model batch with `load_and_apply` in a
    rolled-back transaction for the applier's 422.
- Modify: `routes/metamodel.py:68`. It checks `ModelRow.element_count` instead of
  `model.elements`.
- Modify: `commit_diff.py:476-506` and `range_diff.py:48-67,125,209`.
  - Delete `reconstruct_model_at` and `reconstruct_range`.
  - A commit whose `entity_states` is NULL answers 409 `diff unavailable for this commit`.
    No such rows exist after re-import.
  - `can_fold` accepts rebind rows; they carry no entity states and contribute nothing to the
    fold. A range past 1000 revs is 422 `range too wide: at most 1000 revisions`.
  - Both endpoints depend on `require_membership`, not `get_request_session`.
- Delete: `hydration.reconstruct_model_at` (`hydration.py:166`) and `GET /commits/{rev}/model`
  leftovers if any.
- Test: `tests/api/test_rebind_rows.py` (new); update `tests/api/test_locks*.py`, `test_commit_diff*.py`, `test_range_diff*.py`, `test_open*.py`, `test_preview*.py`, and rebind tests that expected a type-dropping rebind to land (they now expect 422)

- [ ] **Step 1: Failing tests**
  - **`test_rebind_rows.py`:**
    - dropping a type still in use → 422 with the count and the first ids
    - dropping a property still set → 422
    - making a used type abstract → 422
    - a new containment set that creates a second parent → 422, and one that creates a cycle →
      422
    - a clean rebind → 200, with refs rebuilt
  - **Lock test:** a delete-intent lock on a root covers its subtree, computed with no session
    model (assert by evicting the session first).
  - **Range-diff tests:** a range over a rebind folds; 1001 revs → 422.
  - **Open and preview tests:** both answer with the session's model set to `None` (patch it),
    proving they don't read it.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the files under Test and `pixi run backend-lint`. Expected: PASS.
- [ ] **Step 5:** Update `src/data_rover/api/README.md` (locking, rebind, history). `git commit -m "Locks, rebind, preview, open and history read rows"`

### Task 17: Snapshots stream from rows

**Tag:** implementer · **Depends on:** Task 16

**Files:**
- Modify: `src/data_rover/api/snapshot_codec.py`. Add:
  ```python
  def encode_snapshot_v2_rows(*, project_id: str, rev: int, metamodel_id: str, state_digest: str, elements: int, relationships: int, element_lines: Iterable[str], relationship_lines: Iterable[str]) -> Iterator[bytes]: ...
  ```
  It builds the same header dict as `encode_snapshot_v2` (:74-86, key order `format, project_id,
  rev, metamodel_id, elements, relationships, state_digest`), then the lines, through
  `_gzip_member`.
- Create: `src/data_rover/api/snapshot_rows.py`:
  ```python
  def element_line(row: ElementRow) -> str:       # '{"id":<json>,"type_name":<json>,"properties":' + row.properties + ',"rev":<int>}' + "\n", with _LINE_ENCODER for the strings
  def relationship_line(row: RelationshipRow) -> str:   # key order id, type_name, source_id, target_id, properties, rev
  def write_snapshot_from_rows(project_id: str) -> int: ...   # returns the rev written
  ```
  `write_snapshot_from_rows`:
  - opens its own `db_session()`. On Postgres it runs
    `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`.
  - reads `ModelRow` (rev, digest, counts, metamodel id).
  - streams `ElementRow` then `RelationshipRow` ordered by `seq`, with `yield_per(2000)`.
  - writes to the store under `snapshot_key`, then `record_snapshot`.
- Modify: `src/data_rover/api/storage_gcs.py:39-50`. `put` streams into
  `blob.open("wb", content_type="application/gzip", chunk_size=8 * 1024 * 1024)`, with no
  `content_encoding`. `MemorySnapshotStore` is unchanged.
- Modify: `src/data_rover/api/snapshot_job.py`. The job takes a project id, not a session, and
  runs `write_snapshot_from_rows`. It keeps dropping a trigger while a job runs. Its triggers:
  - `_maybe_periodic_snapshot` (`ops.py:808-818`) after each commit
  - the rebind's forced snapshot (`commits.py:1386`)
  - `install_model` and `import_project` at rev 0
- Modify: `routes/replica.py:40-69`. The descriptor depends on `require_membership` and reads
  `model_rev` from `ModelRow`. On a miss it runs `write_snapshot_from_rows` synchronously under
  the row lock (503 on failure, as today).
- Delete: `hydration.write_snapshot`, `persist_baseline`'s snapshot write, the evict hook's
  snapshot (`session.py:574-577`), and `encode_snapshot_v2`'s callers outside tests.
  `encode_snapshot_v2` stays for the contract test.
- Test: `tests/api/test_snapshot_rows.py` (new); update `tests/api/test_snapshot_job.py`, `test_snapshot_writers.py`, `test_replica*.py`

- [ ] **Step 1: Failing tests (`test_snapshot_rows.py`)**
  - `test_rows_snapshot_equals_model_encoder_smart_city`: install smart-city. The decompressed
    bytes of the rows snapshot equal those of
    `encode_snapshot_v2(build_model_from_dicts(mm, parse_model_json(file)), ...)`, with the same
    project id, rev, metamodel id and digest.
  - `test_rows_snapshot_equals_fixture_model`: the same for the `snapshot_v2` golden fixture's
    model (install its `metamodel` and the entities parsed from its `text`).
  - `test_rows_snapshot_after_random_commits`: 50 random commits from Task 15's generator. Write
    from rows and decode with `decode_snapshot`. The state digest equals `ModelRow.state_digest`,
    and the entities equal `read_head`.
  - `test_exact_values`: `1.0`, `2**60`, `NaN` and `Infinity` properties appear in the snapshot
    text exactly as the model encoder writes them.
  - `test_descriptor_without_model`: patch the session's model to `None`; the descriptor answers
    and writes a snapshot.
  - `test_gcs_put_sets_gzip_type`: with the fake-gcs emulator absent, unit-test `put` against a
    stub `blob.open` that records `content_type == "application/gzip"` and no encoding.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the files under Test, then `pixi run engine-test test/snapshot` (the engine still opens what the server writes; if no such test reads a server-written file, skip it) and `pixi run backend-lint`. Expected: PASS.
- [ ] **Step 5:** Update the README persistence section. `git commit -m "Snapshots stream from head rows as application/gzip"`

### Task 18: Streamed import and SQL clone

**Tag:** critical-implementer. Reason: parser fidelity (non-finite literals, `1.0`, big integers)
and an all-or-nothing transaction with set-based checks.
**Depends on:** Task 17

**Files:**
- Modify: `pixi.toml`. Add `ijson = ">=3.5,<4"` to the `api` feature dependencies, then run
  `pixi install`.
- Create: `src/data_rover/api/import_stream.py`:
  ```python
  @dataclass
  class ImportReport:
      elements: int
      relationships: int
  def ingest_model(db: Session, project_id: str, metamodel: Metamodel, source: BinaryIO) -> ImportReport: ...
  ```
  `ingest_model` writes rows inside the caller's transaction:
  - Parse `source` with ijson (`items(source, "elements.item", use_float=True)`, then
    `"relationships.item"`; if the file stores relationships before elements, buffer the
    relationship rows into the table first and check endpoints afterwards, so order of keys in
    the file does not matter).
  - Non-finite literals: if ijson's backend rejects bare `NaN`/`Infinity`/`-Infinity`, pass the
    stream through a byte-level filter that maps them to sentinel strings and back exactly as
    `parse_model_json`'s `_nonfinite_literal` would. The test decides; there is no silent
    difference.
  - Per entity:
    - type known; an element type not abstract
    - property keys declared
    - `seq` in file order
    - `encode_properties`
    - `refs_of` into `entity_refs`

    Collect failures up to 5 ids; past that, count only.
  - After the ingest, run the set-based checks in SQL:
    - ids unique across both tables (`elements.id` join `relationships.id`; K-29)
    - relationship endpoints exist (anti-join)
    - no dangling references (anti-join of `entity_refs.target_id` against both tables)
    - `containment_violations` (Task 16)

    Any failure raises `HTTPException(422, …)` naming the check and the first ids.
  - Fold `digest_value` over `(id, rev)` streamed from the rows into `ModelRow.state_digest`.
    Set the counts and `next_seq`.
- Modify: `src/data_rover/api/importer.py`.
  - `import_project` runs everything in one transaction: the project, the rows from
    `ingest_model`, artifacts and views. It commits only if every check passes, then schedules
    the rev-0 snapshot.
  - `install_model` replaces a project's model: in one transaction, delete its rows, refs,
    commits and snapshots rows, set the metamodel, run `ingest_model`, write the rev-0 import
    commit, set `model_rev = 0`.
  - Neither builds a `Model`.
- Modify: `routes/projects.py:88-147`.
  - Files are spooled (`UploadFile.file`), never `.read()` whole.
  - The total upload is capped at `max_request_body_bytes` (413 past it, read from
    `Content-Length` and enforced while streaming).
  - The pre-validation (:108-114) goes; `import_project`'s transaction is the validation.
- Clone (`routes/projects.py:165-226`):
  - `INSERT … SELECT` of `elements`, `relationships`, `entity_refs`, artifacts and views into the
    new project id, in one transaction
  - a copy of `ModelRow`'s digest, counts and `next_seq`
  - a rev-0 commit
  - then the snapshot job
- Test: `tests/api/test_import_stream.py` (new); update `tests/api/test_importer.py`, `tests/api/test_projects*.py`

- [ ] **Step 1: Failing tests (`test_import_stream.py`)**
  - Smart-city imports; `read_head` equals the parsed file, in order.
  - Exact values: a file with `1.0`, `12345678901234567890`, `NaN`, `Infinity` and `-Infinity`
    gives rows whose decoded values equal `parse_model_json`'s, with the same `repr`.
  - A relationships-first file imports the same rows.
  - Each refusal is a 422 naming its check, and afterwards the project does not exist (no
    `projects`, `elements`, `commits` or `snapshots` rows):
    - an element and a relationship sharing an id (K-29)
    - a missing endpoint
    - a dangling reference at the file's last element
    - a containment cycle
    - two containment parents
    - an unknown type
    - an abstract type
    - an undeclared property
  - A 600 MiB `Content-Length` → 413 before reading.
  - The clone's rows equal the source's, its digest is equal, and a commit on the clone leaves
    the source unchanged.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the files under Test, plus `pixi run -e core-dev pytest tests/api/test_helpers.py` (`install` now goes through `ingest_model`) and `pixi run backend-lint`. Expected: PASS.
- [ ] **Step 5:** Update the README import section. `git commit -m "Import streams rows with set-based checks; clone copies rows"`

### Task 19: `ProjectState` replaces `Session`

**Tag:** critical-implementer. Reason: it is the in-process holder of leases, the feed hub and
the write mutex for every route; a wrong lifetime loses leases or splits the feed.
**Depends on:** Task 18

**Files:**
- Create: `src/data_rover/api/project_state.py`:
  ```python
  class ProjectState:
      project_id: str
      metamodel: Metamodel            # frozen, loaded by ModelRow.metamodel_id; replaced on rebind
      views: dict[str, View]          # loaded with the folder-id heal of hydration.py:247-260
      model_rev: int                  # mirrors ModelRow.model_rev; written only by the commit path
      strict_mode: bool               # ModelRow.validation_policy
      write_mutex: threading.RLock
      lock_table: LockTable
      hub: FeedHub
      mirror_mutex: threading.Lock
      last_access: float
  class ProjectStateRegistry:
      def get(self, project_id: str) -> ProjectState: ...   # loads ModelRow, metamodel, views, leases (restore_leases); never a model
      def peek(self, project_id: str) -> ProjectState | None: ...
      def evict(self, project_id: str) -> bool: ...          # refuses while leases or feed clients remain; no snapshot
      def discard(self, project_id: str) -> None: ...
      def idle(self, now: float, ttl: float) -> list[str]: ...
  def get_registry() -> ProjectStateRegistry: ...
  def get_project_state(project_id: str, _membership: Membership = Depends(require_membership)) -> ProjectState: ...
  ```
- Modify: every route module using `get_request_session` (the routes trace in "What the code
  says"; after Task 11: artifact_bundle, artifacts, commits, locks, metamodel, metamodel_swap,
  ops, replica, rules, settings, snippets, views) and the direct registry callers (`feed.py`,
  `projects.py`, `main.py` sweepers, `snapshot_job.py`). They depend on `get_project_state`.
- Remove the session model mirror from the commit path (Task 15, step 9).
- Delete:
  - `api/session.py`
  - `api/hydration.py` (with the backfill)
  - `deps.require_model` and `deps.get_request_session`
  - `routes/_snapshot.py`'s use outside tests: `build_model_from_dicts` stays for
    `build_partial_model` and tests
- Create: `tests/api/test_no_model.py`, the done-criterion guard. It walks every module under
  `src/data_rover/api` with `ast` and fails if any module other than `commit_load.py` calls
  `Model(`, `build_model_from_dicts`, `build_partial_model`, `decode_snapshot` or
  `parse_model_json` on a model file. `import_stream.py` may call `parse_model_json` only on a
  single property value; list the allowed (module, name) pairs explicitly in the test.
- Test: `tests/api/test_project_state.py` (new); every API test module still passes

- [ ] **Step 1: Failing tests**
  - `test_project_state.py`:
    - `get` loads no model: patch `build_model_from_dicts` to raise, then open, commit, lock,
      tail and feed on a project
    - a lease survives eviction refusal
    - `evict` with no leases or clients drops the state, and the next `get` restores leases from
      the mirror
    - two `get` calls race for one id and share one state (threads with a barrier; no sleeping)
  - `test_no_model.py` as above.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pixi run core-test` (full Python suite: every route module changed) and `pixi run backend-lint` + `pixi run core-lint`. Expected: PASS.
- [ ] **Step 5:** Update `src/data_rover/api/README.md` ("Session and the delta protocol" becomes "Project state"). `git commit -m "ProjectState replaces Session; the server loads no model"`

### Task 20: Postgres lane and measurements

**Tag:** implementer · **Depends on:** Task 19

**Files:**
- Modify: `pixi.toml`. Add the task `core-test-pg`: runs
  `pytest -m pg tests/api/pg` with
  `DATA_ROVER_TEST_DATABASE_URL=postgresql+psycopg://datarover:datarover@127.0.0.1:5432/datarover_test`
  (the compose service; check `docker-compose.yml` for the real user and port). The task is not
  added to `dr-test`.
- Create: `tests/api/pg/conftest.py`. It skips the module when the URL is unset or unreachable,
  creates the schema with `alembic upgrade head`, and truncates between tests.
- Create: `tests/api/pg/test_pg.py`:
  - `test_concurrent_commits_serialize`: two threads, released by a `threading.Barrier`, commit
    non-overlapping batches at the same `base_rev`. One gets 200, the other the stale-rev
    answer or 200 at the next rev. The rows equal the full-model result of the accepted batches
    in order, and the digest matches.
  - `test_values_round_trip`: `1.0`, `2**60`, `NaN` and `Infinity` through import, commit and
    snapshot.
  - `test_ctes`: `subtree_ids` and `ancestor_ids` on a 5,000-element chain.
  - `test_snapshot_repeatable_read`: a snapshot running while a commit lands writes the
    pre-commit state (drive with a hook in `write_snapshot_from_rows` that blocks on an event
    after the header is read).
  - `test_tail_null_cast`: K-36. A commit whose `entity_states` holds JSON `null` values reads
    back through `/replica/tail` unchanged.
- Create: `scripts/measure_thin_server.py`. Against Postgres and model M
  (`engine-bench-data`'s output), it reports medians of 3 for:
  - an import of M
  - a 1,000-op commit
  - a delete of a 10,000-element subtree
  - a snapshot from rows

  It is a script, not a test.
- [ ] **Step 1:** Write the lane and tests. Run `docker compose up -d postgres` (the owner's machine; ask first if it is not running), then `pixi run core-test-pg`. Expected: PASS.
- [ ] **Step 2:** Ask the owner whether the machine is quiet, then run `pixi run -e api python scripts/measure_thin_server.py`. Record the numbers for Task 21. A number that looks wrong is diagnosed, not tuned.
- [ ] **Step 3:** `git commit -m "Postgres test lane and thin-server measurements"`

### Task 21: Documents

**Tag:** chores · **Depends on:** Task 20

**Files:**
- `architecture/program.md`:
  - F's status row: done, with Task 20's measurements (host, versions, date, medians), the
    deploy deferred to its own spec
  - MR-1 to MR-3 marked retired
- `architecture/system.md`:
  - "Current → target": every row done, or replaced by the state that exists
  - the thin-server section updated for the rulings (properties as text, partial-model guard,
    rebind tightening)
- `architecture/decisions.md`:
  - AD-7 consequences done
  - AD-18 and AD-24: the oracle and the forked store are gone
  - AD-31: superseded
- `architecture/constraints.md`: CN-13 and CN-7 carry a note that the corporate load balancer
  and SSO are settled in the deploy spec.
- `BACKLOG-ENGINE.md`:
  - close K-29, K-35, K-36, K-80 and the download-buffering item, each with the commit that
    closed it
  - K-106 stays (E)
- READMEs not yet updated by their task: `engine/README.md`, `frontend/README.md` (and the
  stale sentence near :2410, "for a script column a fresh sweep"), `sandbox/README.md`.
- `CLAUDE.md`: the map rows, commands (`core-test-pg`), gotchas (localhost now redirects), and
  the rules section: no oracle, the server loads no model, properties as text.
- [ ] **Step 1:** Edit. `grep -rn "oracle\|shadow\|dr.surfaces\|run-by-name\|WasmScriptRunner\|hydrat" architecture/ CLAUDE.md src/data_rover/**/README.md engine/README.md frontend/README.md` returns only historical mentions in program.md's status table.
- [ ] **Step 2:** `git commit -m "Document the thin server"`

### Task 22: Final gates

**Tag:** implementer · **Depends on:** Task 21

- [ ] **Step 1:** Run `pixi run dr-tidy`. Expected: ruff, mypy and pyright pass, as do the frontend, engine and sandbox lint and format.
- [ ] **Step 2:** Run `pixi run dr-test`. Expected: PASS, except the known flakes listed in Task 7, each re-run alone and passing.
- [ ] **Step 3:** Stop any stale sandbox preview, then `pixi run frontend-test-e2e`. Expected: PASS, except the known flakes.
- [ ] **Step 4:** Commit any fixes. Report the counts and anything skipped.
