# Metamodel Candidate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine answers the metamodel editor's "Preview changes" (`diffMetamodel`) and the commit preview of a staged `metamodel.rebind` over the working copy, staged edits and rules included, with the Python route's model half as oracle. It does this behind a `metamodel` surface switch that ends the plan defaulting to the engine. The server keeps the structural half, gains `document` on lint and a `POST /metamodel/structural-diff`, and stays the fallback. The candidate scan at M is measured in Node and Chromium and reported to the owner.

**Architecture:** Plan 7 of 8 for sub-project C (`architecture/program.md`), built before plan 6. Bottom-up:
1. Server: lint's `document`, the structural-diff route, and the route's model half extracted as a function (behaviour unchanged).
2. The `metamodel_candidate` golden family.
3. Engine: the uniqueness key function leaves `IndexSet`, and a `Structure` seam puts containment parents and uniqueness groups behind the validation run (live behaviour unchanged).
4. `CandidateStructure`, built in steps.
5. The candidate scan and diff.
6. The service methods.
7. Parity and the gate at M.
8. The shell: the `metamodel` surface, the routed diff and rebind preview, the shadow and the note.
9. e2e, the flip, and the documents.

**Tech Stack:** TypeScript 6 (`strict`, erasable syntax, no DOM or Node in `engine/src/`), vitest 3, Svelte 5 runes, zod, MSW, Playwright; Python 3.14 (FastAPI, pydantic v2, pytest, ruff); pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-28-eval-metamodel-candidate-design.md` (approved 2026-09-28), which refines §6 of `docs/superpowers/specs/2026-09-24-evaluation-design.md`.

Read these first:
- `architecture/contracts.md` (CT-4), `architecture/decisions.md` (AD-26, AD-31), `architecture/program.md` (MR-1…MR-4), `architecture/conventions.md`.
- `src/data_rover/api/README.md` (metamodel editing, validation, rules).
- `engine/README.md` (`src/model/`, `src/validation/`, `src/rules/`, `src/service/`, golden fixtures, bench, parity).
- `frontend/src/lib/engine/README.md` (surfaces, gates, fallbacks, shadow), and `frontend/README.md` before touching `frontend/src/lib/state/`.
- Plans 2 and 3 (`2026-09-24-eval-validation-core.md`, `2026-09-25-eval-rules.md`), whose issue store, probe, rules compile and 501s this plan builds on.

**What kind of plan this is.** Like plans 1–5, this plan gives direction with specifics:
- interfaces and signatures;
- the test cases and what each asserts;
- the order of the work;
- a full account of the mechanisms that are easy to get wrong.

It gives no full code. The expected results of the "see it fail" steps are reasoned from the code, not observed. If one does not appear, trust the run, read the step's intent, and say so in the hand-back.

## What planning found

These facts were checked against the code at `43bca7f8` with tracers.

1. **The server's candidate paths.**
   - **`POST /metamodel/lint`** (`api/routes/metamodel_swap.py:108-150`). The return annotation is its response model. It depends only on `require_membership`. It always answers 200 with `{ok, errors}`:
     - YAML errors carry a 1-based `line`/`column` from `problem_mark`;
     - a `ValueError` (bad UTF-8 or bad JSON) or a `MetamodelError` carries the message only.

     It is not in `_READ_ONLY_POST_SUFFIXES` (`authz.py:60-82`), so a viewer gets 403 and an editor passes. `test_lint_valid_ok` asserts `r.json() == {"ok": True, "errors": []}` (`tests/api/test_metamodel_lint.py:42-45`).
   - **`POST /metamodel/diff`** (`:72-105`) is declared with `response_model=None` and is on the viewer allowlist (`authz.py:67`). The steps:
     1. `_load_candidate` refuses with 422.
     2. `diff_metamodels` runs outside the mutex.
     3. Under `session.write_mutex`, `current = _ensure_validation_seeded(session, model).all_issues()`, in store order. `candidate = candidate_pipeline(session, candidate).validate(build_rebind_view(model, candidate))`.
     4. `_issue_key` (`:48-62`) is `(category.value, severity.value, check, message, tuple(sorted(target_ids)))`.
     5. Both sides go into dict comprehensions, so the position is the first occurrence and the value the last.
     6. `now_failing` is in candidate order and `now_passing` in store order. `unchanged_count` counts shared keys. The two counts are `len()` of the raw lists.
     7. `IssueOut.from_core` gives `origin: "on_server"`.
   - **`GET /metamodel`** (`routes/metamodel.py:107-122`) is serialized by FastAPI 0.140.1 with `by_alias=True`, no exclusions. `Metamodel` and its parts have no aliases and always emit defaults. A nested `document: Metamodel | None` serializes identically.
   - **`candidate_pipeline(session, candidate)`** (`api/rules.py:67-70`) is `pipeline_for(compile_rule_sets(session.compiled_rules.sources, candidate))`, which uses the committed rule sources.
   - **`ValidationPipeline.validate`** (`core/validation/pipeline.py:114-169`): over the whole model it runs every element through every validator, then every relationship, then each validator's `validate_global`. The validator order is TypeConformance, Multiplicity, Facets, EndpointTyping, Containment, Uniqueness.
   - **The rebind preview** (`routes/commits.py:516-649`), in order:
     1. stale `base_rev` → 409;
     2. `split_rebind` (at most one rebind);
     3. the owner check;
     4. `load_candidate` → 422;
     5. under the mutex, swap the metamodel in place, apply the batch, and validate with `candidate_pipeline(...).validate(model, Scope.all())`;
     6. roll back and restore.

     `PreviewResponse` is `{conformance_error_count, structural_blockers, issues, would_block}`, and `would_block` is false with a rebind.
2. **The golden harness.**
   - `@scenario(name)` (`tests/golden/driver.py:41-48`) registers a family. The module must be imported in `tests/golden/scenarios/__init__.py`. Families are written to `engine/fixtures/golden/<name>.json`, and `test_fixtures_current.py` asserts nothing is stale.
   - Recorder steps are the `do` cases of `model_steps.py::_apply` (`:829-979`); `seed` builds a `ValidationState` and sweeps synchronously.
   - `_staged` (`:778-825`) parses ops with `TypeAdapter(list[ModelOpIn])`, which has no `metamodel.rebind`, and calls `preview_commit` as an editor with `db=None`. A rebind preview step needs its own case.
   - The engine replays live in `engine/test/golden/model-steps.ts` (`replaySteps` `:731`, `validationOf` `:349`, `allIds` `:358`). The validation goldens are `engine/test/validation/{kinds,steps,dirty}.golden.test.ts`, each also run with `{hashKey: () => 0}`.
3. **Engine indexes** (`engine/src/model/indexes.ts`).
   - **Uniqueness state:**
     - `buckets: Map<number, ElementRec | Set<ElementRec>>`;
     - `keyText`, set only for members of multi-element buckets;
     - `el.uniq`, the hash.
   - **Uniqueness methods:**
     - `uniqKey(el)` = `keyText.get(el) ?? freshKey(el)`;
     - `uniqGroupOf(el)` filters the bucket by `uniqKey`, and returns `[el]` when the bucket is not a Set;
     - `freshKey` (`:265`) = `pyKey([typeName, parents[0]?.source.id ?? null, signature])`, whose signature is the props without a key spec, else `[spec props, spec relationships' sorted exact-type endpoints]`;
     - `keySpec` memoizes `model.metamodel.effectiveElementKeySpec`;
     - `relEndpoints` (`:288`).
   - **Containment parents:** `onRelationshipCreated` keeps `el.parents` sorted by `ord`, and `rebuildSteps` (`:214-255`) pushes them in state order.
   - **Steps:** `Steps<T> = Generator<Progress, T, void>`. `rebuildSteps` yields every 1,024 visits.
   - **Callers outside `indexes.ts`:**
     - `uniqKey` / `buckets` / `el.uniq`: `validators/uniqueness.ts:30-35` and `debug/verify-consistent.ts`;
     - `uniqGroupOf`: also `validation/dirty.ts`;
     - `el.parents`: `validators/containment.ts:15,33`, `model.ts:123`, `read/tree.ts:21` and `debug/`.
   - **`model.metamodel` in validation and rules:** `dirty.ts` (live only), `pipeline.ts:141` (the identity guard), `live.ts:289`, `rules/evaluate.ts:94`.
4. **Engine validation.**
   - `Run = {model, patterns, out}` (`pipeline.ts:16`).
   - `validateScoped(model, ids, v, p, rules = null)` (`:134-173`) throws unless `v.metamodel === p.metamodel === model.metamodel`, runs the entity hooks per id, then every `validateGlobal(run, scope)`.
   - Only Containment, Uniqueness and `RulesValidator` have a global hook. Containment's and Uniqueness's emit per scoped id in scope order.
   - `FacetPatterns(mm).unusable` marks a candidate the host cannot run.
   - `issueKey` (`issue.ts:46-48`) does not sort `targetIds`. `wireIssue(i, origin)` (`:50`) gives `IssueOut`.
   - `LiveIssues`:
     - builds its own `Validators` and `FacetPatterns` from `wc.model.metamodel` (`live.ts:287-302`);
     - `settled` is `rescan === null`, `seeded` exists but no refusal reads it, and `whenSwept` / `whenSettled` are at `:607` / `:613`;
     - its sweep takes elements, then relationships, in state order.
   - `IssueStore.iter()` gives owners in insertion (`seq`) order.
   - `Model.elements()` / `relationships()` give state (`ord`) order.
5. **The engine service** (`engine/src/service/service.ts`).
   - `Refused(status, detail)`. Its texts are `UNSUPPORTED_PATTERN`, `UNREADABLE_RULES`, `NOT_READY`, `STALE_BASE` and `STALE_BATCHES` (`:124-128`).
   - `live()` (`:590-598`) refuses 409 or 501.
   - `settled(call, run, on?)` (`:684-711`) is a model-lane transition that waits on `whenSettled`. `wait(call, until, then)` (`:714-718`) makes a waiting call cancellable. `validateModel` (`:646-673`) waits on `whenSwept`, then `settled`.
   - `evaluate` (`:537-562`) submits a model-lane scan whose `run()` re-reads `this.ready()`. `scheduler.submit(id, lane, job, done)`: a scan is `{kind: 'scan', run(): Steps<T>}`, and `run()` is called again after `interruptScan`.
   - `moveArtifacts` is a `now` method, so it can queue a rescan at any time. A running scan starves the sweep and rescan slot.
   - `previewCommit` (`:302-314`) takes `{base_rev, batch_ids, strict}`, checks `STALE_BASE` and `requireStaged`, and answers `previewBody(live, strict)` (`validation/bodies.ts:136-157`) from a probe that uses the committed rules.
   - `compiled(layer, mm)` (`:785-793`) → `compileRuleSets(ruleSources(artifacts, layer), mm)`.
6. **Engine tests and bench.**
   - Service helpers (`engine/test/service/helpers.ts`): `fakeHost`, `connect`, `callAs`, `cancel`, `refusal`, `smartCity`, `openReplica`. Cancellation follows `evaluations.test.ts:137-161`.
   - Validation helpers: `sweptFresh`, `byOwner`, `wireKey` (`engine/test/validation/helpers.ts`).
   - **`engine/bench/run.ts`.** Every `ROWS` key must be recorded on every pass. `steppedExport` samples the extra heap. `measureIssues(wc)` is called from `pass()`.
   - **`engine/bench/parity-large.ts`:**
     1. opens the snapshot;
     2. applies `large.violations.ops.json`;
     3. compiles `large.rules.json`;
     4. sweeps a `LiveIssues`;
     5. compares with `large.issues.json`, which is written by `scripts/issues_large.py` through `engine-parity-oracle` (`pixi.toml:127-130`).

     `engine-parity-large` depends on the oracle tasks (`:312-320`). `large.model.json` comes from `examples/generate_large_model.py --scale 170`.
   - **Browser rows** are in `frontend/bench/main.ts::transitions()` (`timed(label, …)`, `ping`); `frontend/bench/run.ts` names its required inputs (`:46-53`).
7. **The shell.**
   - `route(surface, cfg, engineCall, serverCall, {mark, shadow, recheck, digest})` (`frontend/src/lib/api/engine-route.ts:140-209`) goes to the server when `cfg.baseUrl` or `cfg.fetch` is set. Errors that fall to the server:
     - `gone`;
     - 409s in `MOVED`;
     - 501 `script` / `pattern` / `rules`.

     Other errors are probed and rethrown. `comparableWhileStaged(ops)` is at `:119-123`.
   - `previewCommit` (`frontend/src/lib/api/checkout.ts:62-104`) returns `serverPreview(ops)` for any batch with a rebind (`:74-76`). Otherwise it calls `route('issues', …)`, with the non-model rest merged by `mergePreviews`. The test `'a rebind sends every op to the server'` is at `checkout.test.ts:273-281`.
   - `diffMetamodel` / `lintMetamodel` are in `frontend/src/lib/api/metamodel.ts:47-73`. `MetamodelLintSchema` (`types.ts:410-413`) has no `document`.
   - `previewMetamodelChanges` (`state/metamodel-editor.svelte.ts:266-288`) maps an `ApiError` 422 to "The candidate metamodel is invalid."
   - `SURFACES` / `SURFACE_DEFAULTS` are in `frontend/src/lib/engine/surfaces.ts`, and `surfaces.test.ts:20-30` pins them. `anyEngineSurface` special-cases `issues`.
   - The gates are in `installSeam` (`state/replica.svelte.ts:250-262`); `issues` is `getStagingSide() === 'engine' && sync.status().seeded && follower.loaded()`.
   - In `shadow.ts`, `present()`'s `issues` branch uses `byIssueKey`.
   - `exportsIncludeStaged()` (`replica.svelte.ts:443-449`) is the pattern for the note.
   - The Preview button (`MetamodelTab.svelte:130-137`) shows for owners only and has no testid. `MetamodelTab.svelte:43` has a local `SURFACES` const, so watch the name clash.
   - The engine-mode API test harness is `frontend/src/lib/api/__tests__/issues-engine.ts`.
   - In e2e, the fixture fails a spec on any `[shadow]` line. `eval-exports.spec.ts::openReady` forces a surface with `dr.surfaces`. `helpers/api-client.ts::peerRebind` exists.

## Decisions

- **D1 — The model half as a function.** `src/data_rover/api/metamodel_candidate.py` gets two functions:
  - `candidate_issues(model: Model, candidate: Metamodel, sources) -> list[Issue]` returns `candidate_pipeline`'s validation over `build_rebind_view`. It takes the sources rather than the session.
  - `model_half(current: list[Issue], candidate: list[Issue]) -> dict` returns `{now_failing, now_passing, unchanged_count, current_error_count, candidate_error_count}`, with the issues rendered by `IssueOut.from_core(...).model_dump(mode="json")`.

  `diff_metamodel` calls both under the mutex and serializes the same fields, so its behaviour is unchanged (the existing diff tests hold it). `_issue_key` moves there. The golden recorder and `scripts/candidate_large.py` call these functions.
- **D2 — Lint's `document`.** `MetamodelLintResponse` gains `document: Metamodel | None = None`, set from `load_metamodel_str`'s result. It is the parsed document, as `GET /metamodel` answers and `open` takes it, not text. `test_lint_valid_ok` is updated.
- **D3 — `POST /metamodel/structural-diff`.**
  - It reads the candidate with `_read_metamodel_blob`. `_load_candidate` refuses 422, and so does a decode `ValueError`, which is caught here.
  - It answers `diff_metamodels(require_metamodel(session), candidate)` as `MetamodelStructuralDiff` with `response_model=None`, so `from` survives.
  - It takes no mutex and touches no model. It is not added to the viewer allowlist, so a viewer is refused as lint refuses one.
- **D4 — `Structure`** (`engine/src/model/structure.ts`).
  - The interface:

    ```ts
    export interface Structure {
      readonly metamodel: Metamodel;
      parentsOf(el: ElementRec): readonly RelRec[];
      /** The element's uniqueness group, itself included; null when it is alone. */
      groupOf(el: ElementRec): readonly ElementRec[] | null;
      keyOf(el: ElementRec): string;
    }
    ```

  - `liveStructure(model)` is memoized on the model. Its members:
    - `parentsOf` → `el.parents`;
    - `groupOf` → `null` unless `buckets.get(el.uniq) instanceof Set`, else `uniqGroupOf(el)`, which may be `[el]` after a hash collision;
    - `keyOf` → `uniqKey`.
  - `Uniqueness` skips an element whose group is `null` or of length 1, which matches today's result for both.
- **D5 — The key function.** `engine/src/model/uniq-key.ts` exports `uniqKeyText(mm, parentsOf, el, specs: Map<string, KeySpec | null>)` and `keyEndpoints(el, keyRel)`, moved verbatim from `freshKey`, `keySpec` and `relEndpoints`. `IndexSet` calls them with `model.metamodel`, `(e) => e.parents` and its own `keySpecs` map.
- **D6 — Candidate groups key on text, not hash.** `CandidateStructure` groups on the key text itself, so it has no collisions. Python groups on tuple equality, and `pyKey` already folds `1`, `1.0` and `True` together.
- **D7 — Order.**
  - The scan validates elements, then relationships, in state order, 512 ids a step. `validateSplit` returns `{entity: Issue[], global: Issue[][]}` (one list per validator in list order). `validateScoped` becomes `entity` plus the flattened `global`.
  - The scan appends each slice's `entity` to one list and each `global[i]` to buffer `i`, then answers `entity ++ buffer0 ++ buffer1 …`. That is the Python whole-model order, because Containment's and Uniqueness's global hooks answer per scoped id in scope order and carry no cross-id output state (`safe` and `primaries` are caches only).
- **D8 — Rules.** `candidateIssues` compiles the WORKING rules under the candidate, which matches the live store it diffs against. The rebind preview compiles the COMMITTED rules, which matches the server's `candidate_pipeline` and the engine's `previewCommit`. An unreadable compile is refused 501 `UNREADABLE_RULES`; unusable candidate patterns are refused 501 `UNSUPPORTED_PATTERN`.
- **D9 — Waiting, and a store that moved.**
  - On arrival, the handler parses (422 `metamodel: …` as `open`) and builds `FacetPatterns` (501).
  - It then runs `this.live()`. If the store is not yet swept, it `wait`s on `whenSwept`, then goes through `settled(call, run)`.
  - `run` records a stamp `{rev, stagedVersion, rulesVersion}` (the probe's cache key; find the field names in `live.ts`), submits a model-lane scan with its own `done`, and returns the waiting sentinel.
  - The scan's `run()` re-reads `this.live()` and compares the stamp at its first and its last step. If the stamp moved or the store is not `settled`, it returns the `MOVED` sentinel, and `done` re-enters the handler's wait instead of answering.
  - A cancel drops it at any stage.
- **D10 — The rebind preview in the engine.** `previewCommit` accepts an optional `rebind: {metamodel}`. With it, the service does the following:
  1. Keeps the `STALE_BASE` / `requireStaged` checks.
  2. Parses as D9 and waits as D9.
  3. Scans the whole working copy under the candidate with the committed rules (D8).
  4. Answers `rebindPreviewBody(issues)` = `{conformance_error_count, structural_blockers, issues, would_block: false}`, every issue `wireIssue(i, 'on_server')`.
  - The working copy already holds the staged model ops, which is the server's hoisted order.
- **D11 — The shell's diff.**
  - `diffMetamodel(body, cfg?)` = `route('metamodel', cfg, engineCall, serverCall, {shadow: 'unstaged'})`. The server call is today's `/metamodel/diff`.
  - The engine call:
    1. `lintMetamodel(body, cfg)`; not `ok` → throw `ApiError` 422 `Invalid metamodel`, so the editor's message holds.
    2. `Promise.all([call('candidateIssues', {metamodel: lint.document}), structuralDiff(body, cfg)])`.
    3. Answer `MetamodelDiffSchema.parse({...model, structural})`.
  - `structuralDiff` is a new `lib/api/metamodel.ts` function for D3.
- **D12 — The shell's rebind preview.** In `previewCommit`, a batch with a rebind while `local` is set goes through `route('metamodel', …)`:
  1. Lint the rebind's `blob`; not `ok` → throw `ApiError` 422, and the probe and server answer it.
  2. Call the engine's `previewCommit {base_rev, batch_ids, strict, rebind: {metamodel: document}}`.
  3. Merge the non-model rest's `serverPreview(rest)` with `mergePreviews`, as today.

  The server call is today's whole-batch `serverPreview(ops)`, and the shadow is `comparableWhileStaged(ops)`. Without `local`, the batch is the server's whole as before.
- **D13 — The switch.**
  - `metamodel` joins `Surface`, `SURFACES` and `SURFACE_DEFAULTS` as `server` (Task 8), not `READ_SURFACES`. `anyEngineSurface` counts it only with staging on the engine, as `issues`.
  - Its gate is `issues`'s.
  - It flips to `engine` in Task 9, after e2e with the switch forced to `engine` shows no `[shadow]` line.
- **D14 — The shadow.** `present('metamodel', value)` sorts `now_failing` and `now_passing` with `byIssueKey`. The counts and `structural` compare as they are. A rebind preview is `issues`-shaped, so `present` reuses the `issues` branch for it (`ISSUE_LISTS`).
- **D15 — The note.** `metamodelIncludesStaged()` in `replica.svelte.ts`, the twin of `exportsIncludeStaged()` over `engineSide('metamodel')`, is re-exported from `state/index.ts`. `MetamodelTab` shows `data-testid="metamodel-staged-note"`, "Includes staged changes", above the preview panel when it holds.
- **D16 — Out of scope:** plan 6; `K-71` (rules install time); the server diff's O(model) cost (recorded as a new K item, Task 9).

## Global Constraints

- **Environment.** Everything runs through pixi (`PATH=~/.pixi/bin:$PATH`). There is no global `node` or `python`.
- **Branch and commits.**
  - Work on `feat/eval-metamodel-candidate`, at `engine-migration` (`77877911`) plus the design commit `43bca7f8` and this plan's commit.
  - One commit per task. Never push `engine-migration` or `main`.
  - `engine-migration` is fast-forwarded only with the owner's go-ahead (Task 9).
- **Freeze (MR-3).**
  - `core/model`, `core/metamodel`, the model-op applier and plans 1–5's areas stay frozen.
  - From Task 1 on, the diff route's model half and `build_rebind_view` are frozen for behaviour. D1 moves code without changing behaviour.
  - `diff_metamodels` is not frozen.
  - `src/data_rover/` changes only in Task 1. The Python core is the oracle: fix the engine, never a fixture. Fixtures change only through `pixi run golden-fixtures`.
- **Engine `src/` rules.**
  - No DOM, Node built-in, timer, clock, `Math.random`, `Intl` or locale comparison. Erasable syntax, `.ts` specifiers, no `any` in an exported signature.
  - The live validation path's output is unchanged: every existing golden and `engine-parity-large` pass unmodified.
  - A steps generator publishes nothing before its last step, and `run()` re-reads live state on every start.
- **Tests.**
  - Tests import the engine through `engine/src/index.ts`.
  - Engine and frontend tests run the real engine, never a mock, and without fake timers. Every in-process link is `dispose()`d.
  - A "see it fail" step lists the tests it expects red. Any OTHER red test is a finding to report, not to silence.
- **Lint and checks.**
  - `pixi run engine-tidy` for `engine/` and `pixi run dr-tidy` for the rest.
  - For every file under `tests/` and `scripts/`, run `pixi run -e core-dev ruff check <files>` and `ruff format <files>`.
  - `pixi run engine-check`, `frontend-check` and `sandbox-check` pass.
- **Comments and documents.**
  - Comments are concise and present-tense, with no references to specs, plans or `architecture/` ids in code (RC-6).
  - `architecture/`, the READMEs and the backlogs change in the commit of the code they describe (RC-10).
  - `benchmarks/` is git-ignored; never `git add -f`.
- **Commit messages.** Subjects are one imperative sentence, capitalized, with no prefix and no trailing period. The message ends with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01E4zc673uKkd2KQCM3cuUQW
  ```

- **Ids.** The next free are `AD-34`, `K-80`, `C-24`, `T-11` and `U-11`. Grep before use; K ids are unique across both backlogs.
- **Baseline.** Before Task 1, run `pixi run dr-test` and `pixi run engine-parity-large`, and record the counts in the Task 1 hand-back. They are the reference for "nothing else went red".
- **e2e in this environment.**
  1. Run `pixi run sandbox-build` first.
  2. Stop a stale `vite preview` in its own command.
  3. Run `PLAYWRIGHT_BROWSERS_PATH=<scratchpad>/pwb pixi run frontend-test-e2e`.

## Review Focus

The six conditions most likely to bite a user that the tasks' ordinary tests would not reach. Each has its test in the task named.

1. **Rules change mid-preview.** The owner stages a rule-set edit while a candidate scan runs. The answer pairs the new rules on both sides, never a stale current side with a fresh candidate. *Task 6* (a `moveArtifacts` between arrival and the scan's last step makes it re-wait and answer the new state).
2. **Hash collisions.** Under a forced `hashKey: () => 0`, the live structure groups by key text, not bucket. The candidate built under the live metamodel equals the live structure, and the live goldens still pass. *Tasks 3, 4.*
3. **A candidate that removes what the model uses.** An element type the model holds is deleted, a key names a property the candidate dropped, or a containment flag is set on a relationship type the candidate renamed. The result is the oracle's unknown-type, drift and parent issues, never a throw. *Tasks 2, 5.*
4. **A staged create beside a staged rebind.** The commit preview answers locally under the candidate, including the new element's issues under its `tmp_` id. The shadow stays silent (`never`). *Tasks 6, 8.*
5. **A candidate mid-typing.** An invalid buffer on Preview shows "The candidate metamodel is invalid.", not the generic failure. An invalid rebind blob in the commit preview answers the server's 422. *Task 8.*
6. **A transition mid-scan.** A feed delta (control lane) interrupts the scan. It restarts from scratch and answers once. *Task 6.*

---

## File Structure

**Python (Tasks 1, 2, 7)**
- Create: `src/data_rover/api/metamodel_candidate.py` (D1).
- Modify:
  - `src/data_rover/api/routes/metamodel_swap.py` (D1, D2, D3);
  - `src/data_rover/api/schemas.py` (D2);
  - `src/data_rover/api/README.md`.
- Tests:
  - `tests/api/test_metamodel_lint.py`, `tests/api/test_metamodel_diff.py`;
  - create `tests/api/test_metamodel_structural_diff.py`.
- Goldens:
  - create `tests/golden/scenarios/metamodel_candidate.py`;
  - modify `tests/golden/model_steps.py` (the `candidate` and `preview_rebind` steps) and `tests/golden/scenarios/__init__.py`.
- Bench: create `scripts/candidate_large.py`; modify `pixi.toml`.

**Engine**
- Create:
  - `engine/src/model/uniq-key.ts`, `engine/src/model/structure.ts` (Tasks 3, 4);
  - `engine/src/validation/candidate.ts` (Task 5).
- Modify:
  - `engine/src/model/{indexes,model}.ts`;
  - `engine/src/validation/{pipeline,issue,bodies}.ts`;
  - `engine/src/validation/validators/{containment,uniqueness}.ts`;
  - `engine/src/rules/evaluate.ts`;
  - `engine/src/service/service.ts`;
  - `engine/src/index.ts`;
  - `engine/README.md`.
- Tests:
  - `engine/test/model/structure.test.ts`;
  - `engine/test/validation/{candidate,candidate.golden}.test.ts`;
  - `engine/test/service/candidate.test.ts`;
  - `engine/test/golden/model-steps.ts`.
- Bench: `engine/bench/run.ts`, `engine/bench/parity-large.ts`.

**Frontend (Tasks 8, 9)**
- Modify:
  - `frontend/src/lib/api/{metamodel,checkout,engine-route,types}.ts`;
  - `frontend/src/lib/engine/{surfaces,shadow}.ts`;
  - `frontend/src/lib/state/{replica.svelte,index}.ts`;
  - `frontend/src/lib/components/Metamodel/MetamodelTab.svelte`;
  - `frontend/src/lib/engine/README.md`.
- Tests:
  - `frontend/src/lib/api/__tests__/{checkout,metamodel-route}.test.ts`;
  - `frontend/src/lib/engine/__tests__/{surfaces,shadow}.test.ts`;
  - `frontend/src/lib/state/__tests__/replica.svelte.test.ts`;
  - `frontend/src/lib/components/Metamodel/__tests__/` (the note).
- Bench: `frontend/bench/{main,run}.ts`.
- e2e: create `frontend/e2e/eval-metamodel.spec.ts`.

**Documents:** `architecture/contracts.md` (CT-4), `architecture/program.md` (C's status, MR-3 row 7), `BACKLOG-ENGINE.md`.

## Mechanisms

**M1 — `CandidateStructure`** (`engine/src/model/structure.ts`).

```ts
export function candidateStructureSteps(model: Model, mm: Metamodel): Steps<Structure>
```

1. **Pass 1.** Go over `model.relationships()` (state order). A relationship whose `mm.isContainment(rel.typeName)` holds (the same call `rebuildSteps` makes) is pushed onto `parents.get(rel.target)`. Push order is state order, which is `ord` order, which is what `rebuildSteps` gives.
2. **Pass 2.** Go over `model.elements()`: `key = uniqKeyText(mm, parentsOf, el, specs)` and `groups: Map<string, ElementRec | ElementRec[]>` (one element, then an array once a second arrives).
3. **Finish.** Keep only arrays, as `memberOf: Map<ElementRec, ElementRec[]>` and `keyOfMember: Map<ElementRec, string>`. Drop everything else.
   - `groupOf` → `memberOf.get(el) ?? null`;
   - `keyOf` → `keyOfMember.get(el) ?? uniqKeyText(…)`;
   - `parentsOf` → `parents.get(el) ?? EMPTY`.

- **Steps.** Yield `{done, total}` every 2,048 visits (total = relationships + elements + 1). Tune the step size only if the Task 7 gate shows the longest step above the sweep's.
- **The candidate is read-only.** It never writes a record field.

**M2 — The candidate scan** (`engine/src/validation/candidate.ts`).

```ts
export type Candidate = {
  readonly metamodel: Metamodel;
  readonly validators: Validators;
  readonly patterns: FacetPatterns;
  readonly rules: CompiledRules | null;
};
export function prepareCandidate(doc: unknown, rules: (mm: Metamodel) => CompiledRules): Candidate;
export function* candidateScan(model: Model, c: Candidate, step?: number): Steps<Issue[]>;
export type CandidateDiff = {
  now_failing: IssueOut[];
  now_passing: IssueOut[];
  unchanged_count: number;
  current_error_count: number;
  candidate_error_count: number;
};
export function candidateDiff(current: Iterable<Issue>, candidate: readonly Issue[]): CandidateDiff;
export function rebindPreviewBody(issues: readonly Issue[]): PreviewBody;
```

- **`prepareCandidate`.**
  - `Metamodel.fromJSON` throws `Refused`-able errors; the service maps them to 422 `metamodel: …`.
  - `patterns.unusable` → throw `PatternUnusable`.
  - `rules.unreadable` → throw a marker the service maps to 501 `UNREADABLE_RULES`.
- **`candidateScan`.** It drives `candidateStructureSteps`, then D7's slices over `model.elements()`, then `model.relationships()`, calling `validateSplit(model, ids, c.validators, c.patterns, c.rules, structure)`.
- **`candidateDiff`.**
  - `candidateKey(i)` = `JSON.stringify([i.category, i.severity, i.check, i.message, [...i.targetIds].sort(cmpCodePoint)])`, lives in `issue.ts`, and is the route's key.
  - Use two `Map`s: `set` on the first occurrence keeps the position, and a later duplicate overwrites the value. `Map.set` on an existing key keeps its position, which is exactly the dict's behaviour.
  - Issues are rendered with `wireIssue(i, 'on_server')`.

**M3 — The service** (`service.ts`).

- **`candidateIssues`.** A custom `METHODS` handler, per D9. Its scan's `run()`:
  1. `live = this.live()`. If the stamp moved or the store is not `settled`, return `MOVED` before the first yield.
  2. `c = prepareCandidate(doc, mm => compileRuleSets(ruleSources(this.artifacts, 'working'), mm))`.
  3. `issues = yield* candidateScan(wc.model, c)`.
  4. Check the stamp again; if it moved, return `MOVED`.
  5. Return `candidateDiff(storeIssues(live.store), issues)`, where `storeIssues` yields the store's issues in `iter()` order (flattening per owner if `iter()` yields owners).
- **`done`.** `MOVED` → re-enter the handler's wait path; an ok value → `call.answer`; an error → `refuse`.
- **`previewCommit` with `rebind`.** It uses the same path with the committed layer and `rebindPreviewBody`.
- Both register in `METHODS`, not `EVALUATIONS`: they need the issue store, which `EvalContext` does not carry.

---

### Task 1: The server — `document`, structural-diff, the model half as a function · `critical-implementer`
*Reason: touches a frozen route (move only), an authz decision and a response shape the engine depends on.*

**Files:** Python (Task 1) in File Structure; `architecture/program.md` (MR-3 row 7).

**Interfaces:**
- Produces:
  - `metamodel_candidate.candidate_issues(model, candidate, sources) -> list[Issue]`;
  - `metamodel_candidate.model_half(current, candidate) -> dict`;
  - `metamodel_candidate.issue_key(issue) -> tuple`;
  - lint `{ok, errors, document}`;
  - `POST /api/v1/projects/{id}/metamodel/structural-diff` → `MetamodelStructuralDiff`.

- [ ] **Step 0: Baseline.** Run `pixi run dr-test` and `pixi run engine-parity-large`, and record the counts.
- [ ] **Step 1: Failing tests.**
  - **`test_metamodel_lint.py`:**
    - `test_lint_valid_ok` → `{"ok": True, "errors": [], "document": <GET body>}`;
    - a new test commits a rebind to a candidate (`_acquire_mm` from `test_commits_metamodel_ops.py`), then asserts lint's `document` for the same YAML equals `GET /metamodel`'s JSON exactly;
    - an invalid candidate has `document is None`.
  - **`test_metamodel_structural_diff.py`:**
    - equals `/metamodel/diff`'s `structural` for `_MM_STRUCT_RENAMED` and for a `from` field change (copy the constants from `test_metamodel_diff.py`);
    - a bad candidate → 422;
    - bad UTF-8 → 422;
    - a viewer → 403 and an editor → 200 (copy the viewer setup from `test_metamodel_lint.py:104`);
    - the model and the issue store are untouched (the `/model/summary` rev is unchanged).
  - **`test_metamodel_diff.py`:** a test that calls `model_half` directly with duplicate keys on both sides and asserts:
    - the first position and the last value win;
    - `unchanged_count` counts distinct keys;
    - the two counts are raw lengths, warnings included.
- [ ] **Step 2: See them fail.** Expect the lint equality tests, the whole new structural-diff file and the `model_half` import to fail; nothing else.
- [ ] **Step 3: Implement D1, D2 and D3.** `diff_metamodel` becomes the following, with its locking, error and response behaviour unchanged:

  ```python
  current = _ensure_validation_seeded(session, model).all_issues()
  candidate_list = candidate_issues(model, candidate, session.compiled_rules.sources)
  return MetamodelDiffResponse(**model_half(current, candidate_list), structural=structural)
  ```

  Check whether `MetamodelDiffResponse` accepts dumped dicts for `IssueOut` lists. If it does not, `model_half` returns `IssueOut`s and the golden recorder dumps them; the choice must not change the route's JSON.
- [ ] **Step 4: See them pass.** Also run `pixi run -e core-dev pytest tests/api -k "metamodel or commits_metamodel"`.
- [ ] **Step 5: Docs.**
  - `src/data_rover/api/README.md`: lint's `document`, `structural-diff`, and the model half as the engine's oracle.
  - `architecture/program.md` MR-3: "the diff route's model half (`api/metamodel_candidate.py`) and `build_rebind_view` are frozen for behaviour from C's plan 7 on; `diff_metamodels` is not."
- [ ] **Step 6: Tidy, then commit** with the message `Answer the linted metamodel and serve the structural diff alone`.

### Task 2: The `metamodel_candidate` golden family · `critical-implementer`
*Reason: the oracle every engine task replays; the recorder needs a rebind preview it cannot parse today.*

**Files:** Goldens in File Structure.

**Interfaces:**
- Consumes: Task 1's `candidate_issues`, `model_half`.
- Produces: `engine/fixtures/golden/metamodel_candidate.json`, with runs of steps that include two new step kinds:
  - `{do: "candidate", metamodel: <doc>}` → `result` = the `model_half` dict;
  - `{do: "preview_rebind", metamodel: <doc>, ops: [...], strict: bool}` → `result` = the rebind `PreviewResponse` JSON.

  The run's metamodel is the live one, and later steps can hold other candidates.

- [ ] **Step 1: The recorder.** Add two cases to `_apply`:
  - **`candidate`:** `current` comes from the seeded store (the same `_ensure_validation_seeded(...).all_issues()` the route reads, over the Recorder's session), and `candidate_issues(model, Metamodel.model_validate(doc), session.compiled_rules.sources)`; record `model_half(...)`. A step before `seed` is a harness error.
  - **`preview_rebind`:** call `preview_commit` as an OWNER (`SimpleNamespace(role=Role.owner)`) with ops `[{"kind": "metamodel.rebind", "blob": yaml.safe_dump(doc)}, *ops]`, parsed with the route's own op union, not `_MODEL_OPS`. Assert afterwards that the model, the metamodel and the store are unchanged, as `_staged` asserts. If `preview_commit` reaches `db` on the rebind path, give it the smallest stand-in that path reads, and name it in the hand-back.
- [ ] **Step 2: The scenario** (`metamodel_candidate.py`, `@scenario("metamodel_candidate")`).
  - Start from smart-city (`smart_city.py`'s loader) plus one rule set (`rules_step`, a relationship rule and an element rule, one of which names a type candidate 4 removes).
  - `seed`, then one run per candidate, each a `candidate` step:
    1. **`required`:** a new required property on a type with instances.
    2. **`containment`:** containment set on an existing relationship type. Add elements and relationships in the scenario's batch so that it yields a new parent, an element with two parents and a cycle.
    3. **`key`:** an element key added to a type whose instances collide, and one removed from a type that had one; groups merge and split. Include values `1`, `1.0` and `True` in one key property across three elements.
    4. **`removed`:** an element type the model holds is deleted. Its subtype, if any, is re-parented. The rule naming it drifts.
    5. **`pattern`:** a tightened facet pattern.
    6. **`identical`:** the live metamodel itself.
  - Then, in a second run, stage a batch (`create_element` + `update_element`) and record `preview_rebind` for candidates 2 and 4, `strict` true and false.
  - Each candidate is built from the live `Metamodel` by `model_copy(update=…)` or dict edits, then checked by `load_metamodel_str(yaml.safe_dump(doc))` so it is a valid candidate.
  - Assert in the generator that each of candidates 1–5 yields a non-empty `now_failing` and that at least one yields a non-empty `now_passing`.
- [ ] **Step 3: Generate and check.** Run `pixi run golden-fixtures`, then `pixi run -e core-dev pytest tests/golden`. Read the fixture and confirm the six results differ as the cases intend. Record the counts per case in the hand-back.
- [ ] **Step 4: Tidy, then commit** with the message `Record the metamodel candidate golden family`.

### Task 3: The key function and the `Structure` seam · `critical-implementer`
*Reason: touches the live validators' hot path; any drift shows in every validation golden.*

**Files:** `engine/src/model/{uniq-key,structure,indexes,model}.ts`, `engine/src/validation/{pipeline}.ts`, `engine/src/validation/validators/{containment,uniqueness}.ts`, `engine/src/rules/evaluate.ts`, `engine/test/model/structure.test.ts`, `engine/README.md`.

**Interfaces:**
- Produces:
  - `uniqKeyText(mm, parentsOf, el, specs)` and `keyEndpoints(el, keyRel)` (D5);
  - `Structure` and `liveStructure(model)` (D4);
  - `Run.structure`;
  - `validateSplit(model, ids, v, p, rules, structure): {entity: Issue[]; global: Issue[][]}`;
  - `validateScoped(model, ids, v, p, rules = null, structure = liveStructure(model))`.

- [ ] **Step 1: Failing tests** (`structure.test.ts`, over `smartCity()` plus a hand-built model with two colliding keys under `{hashKey: () => 0}`).
  - `liveStructure(model).parentsOf(el) === el.parents`.
  - `groupOf` is null for a singleton, and equals `uniqGroupOf` (as a set) for a duplicate.
  - Under the forced hash, two different keys in one bucket each answer a group of `[el]`, and `Uniqueness` reports nothing for them.
  - `keyOf === indexes.uniqKey`.
  - `validateSplit`'s `entity ++ flat(global)` equals `validateScoped` over the same ids.
  - `validateScoped` with a `Structure` whose metamodel is not the validators' throws.
- [ ] **Step 2: See them fail** (missing exports).
- [ ] **Step 3: Implement.**
  - Move the key code (D5); `IndexSet` delegates, and nothing else in `indexes.ts` changes.
  - Add `structure.ts` with `liveStructure`, memoized in a `WeakMap<Model, Structure>`.
  - `Run` gains `structure`, and the guard becomes `v.metamodel === structure.metamodel && p.metamodel === structure.metamodel`.
  - The model itself stays on `run.model` (`findElement`, adjacency, `countOut` are shared).
  - `Containment` reads `run.structure.parentsOf(el)` in both hooks.
  - `Uniqueness` reads `groupOf` / `keyOf`, keeping its primaries cache per run and its descriptor from its own `mm`.
  - `RulesValidator`'s `evaluateRelationship` takes the metamodel from `run.structure.metamodel` instead of `model.metamodel`.
- [ ] **Step 4: See everything pass.** Run the new tests; `pixi run engine-test` must pass with every validation golden (`kinds`, `steps`, `dirty`, forced-hash variants) green and unchanged.
- [ ] **Step 5: Parity.** `pixi run engine-parity-large` is still equal.
- [ ] **Step 6: Tidy, README** (`engine/README.md`: `Structure`, and the key function's new home), **then commit** with the message `Read containment and uniqueness through a structure view`.

### Task 4: `CandidateStructure` · `critical-implementer`
*Reason: the side maps must reproduce the index's parents order and group identity exactly.*

**Files:** `engine/src/model/structure.ts`, `engine/test/model/structure.test.ts`, `engine/src/index.ts`.

**Interfaces:**
- Consumes: Task 3's `Structure`, `uniqKeyText`.
- Produces: `candidateStructureSteps(model, mm): Steps<Structure>` (M1).

- [ ] **Step 1: Failing tests.**
  - **Equality under the live metamodel.** For every element of `smartCity()` and of the Task 3 collision model (both hash settings), check:
    - `parentsOf` (same records, same order);
    - `groupOf` (same members as a set, or both null / singleton);
    - `keyOf`.
  - **A containment flag turned on** (a candidate `Metamodel.fromJSON` of the live document with one relationship type's `containment: true`):
    - targets gain exactly the relationships of that type, in `ord` order;
    - the live `el.parents` are untouched.
  - **A key changed:**
    - elements differing only in the old key's property now group;
    - `1`, `1.0` and `True` in the key property group together, and `"1"` does not.
  - **Steps.** `drain(candidateStructureSteps(...))` equals a hand-driven iteration, and no single step visits more than 2,048 records.
  - **No mutation.** A record's `parents` array and `uniq` hash are identical (`===` / `==`) before and after the build.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement M1.**
- [ ] **Step 4: See them pass;** `pixi run engine-test` is green.
- [ ] **Step 5: Tidy, then commit** with the message `Derive containment and uniqueness for a candidate metamodel`.

### Task 5: The candidate scan and diff · `critical-implementer`
*Reason: order, key and count semantics must match the oracle exactly.*

**Files:** `engine/src/validation/{candidate,issue,bodies}.ts`, `engine/src/index.ts`, `engine/test/validation/{candidate,candidate.golden}.test.ts`, `engine/test/golden/model-steps.ts`, `engine/README.md`.

**Interfaces:**
- Consumes: Tasks 3 and 4; Task 2's fixture.
- Produces: `candidateKey`, `prepareCandidate`, `candidateScan`, `candidateDiff`, `rebindPreviewBody`, `CandidateDiff` (M2); `PreviewBody` exported from `bodies.ts`.

- [ ] **Step 1: Failing unit tests** (`candidate.test.ts`).
  - `candidateKey` sorts target ids and ignores their order.
  - `candidateDiff`:
    - duplicates on both sides give the first position and the last value;
    - `unchanged_count` counts distinct shared keys;
    - the counts are raw lengths;
    - every issue is `origin: 'on_server'`.
  - `candidateScan` under the live metamodel with the live rules equals the live sweep's issues in Python whole-model order. Build that order independently: one unsliced `validateSplit` over `allIds`, then `entity ++ flat(global)`. Check it with step sizes 1, 7 and 512.
  - `prepareCandidate`:
    - an unusable pattern throws `PatternUnusable`;
    - unreadable rules throw the unreadable marker;
    - a malformed document throws.
- [ ] **Step 2: Failing golden replay** (`candidate.golden.test.ts`).
  - Teach `model-steps.ts` the `candidate` step: `prepareCandidate(step.metamodel, (mm) => compileRuleSets(<the run's working sources>, mm))`, `drain(candidateScan(...))`, then `candidateDiff(<the replay's live store>, …)`. Compare with the fixture:
    - `now_failing` in order;
    - `now_passing` sorted by `candidateKey`, since the stores' orders are their own;
    - the counts exactly.
  - `preview_rebind` is replayed in Task 6.
  - Run the family with the default hash and with `{hashKey: () => 0}`.
  - **The staged variant.** Replay the batch before each `candidate` step as STAGED in a `WorkingCopy` rather than applied. Use the harness's existing staged replay if it has one; otherwise stage through `WorkingCopy` directly in the test. It must give the same answers. A third variant stages the scenario's rule set in the `ArtifactSet` instead of committing it (working rules), and must also give the same answers.
- [ ] **Step 3: See them fail.**
- [ ] **Step 4: Implement M2.**
- [ ] **Step 5: See them pass;** `pixi run engine-test` is green. A mismatch with the fixture is an engine bug: fix the engine, never the fixture.
- [ ] **Step 6: Tidy, README** (`src/validation/candidate.ts`), **then commit** with the message `Validate the working copy under a candidate metamodel`.

### Task 6: `candidateIssues` and the local rebind preview · `critical-implementer`
*Reason: a new wait-then-scan composition in the dispatcher, with restart and cancellation semantics.*

**Files:** `engine/src/service/service.ts`, `engine/test/service/candidate.test.ts`, `engine/test/golden/model-steps.ts` (the `preview_rebind` replay), `architecture/contracts.md` (CT-4), `engine/README.md`.

**Interfaces:**
- Consumes: Task 5.
- Produces: the CT-4 methods `candidateIssues {metamodel}` → `CandidateDiff`, and `previewCommit {base_rev, batch_ids, strict, rebind?: {metamodel}}` → `PreviewBody`.

- [ ] **Step 1: Failing service tests** (`candidate.test.ts`, `openReplica` over `smartCity()`).
  - **Answers.** An identical candidate answers empty `now_failing` / `now_passing` with `unchanged_count` equal to the store's distinct keys. A required-property candidate answers the expected issue.
  - **Refusals:**
    - a malformed document → 422 `metamodel: …`;
    - an unusable candidate pattern → 501 `reaches an unsupported pattern`;
    - an unreadable working rule set → 501 `reaches unreadable rules`.
  - **Staged edits.** With a staged `update_element` that violates the candidate's new required property, it answers the issue in `now_failing`, which the committed model alone would not.
  - **Waits for the sweep.** A call made before the first sweep ends answers only after it (use `fakeHost({tick})`) and equals a call made after.
  - **Review Focus 1.** Hold the scan mid-way with `fakeHost`, post `moveArtifacts` adding a rule that fires, then run to the end. The answer's current side and candidate side both include the new rule, and there is exactly one answer.
  - **Review Focus 6.** Interrupt the scan with a control-lane transition (a feed delta, as `evaluations.test.ts` does). The scan restarts and answers once, reflecting the new rev.
  - **Cancel.** A cancel while waiting, and a cancel mid-scan: no answer either way (the `evaluations.test.ts:137-161` pattern).
  - **`previewCommit` with `rebind`:**
    - `would_block` is false even with `strict` and a staged conformance error;
    - `structural_blockers` holds a containment cycle the candidate creates;
    - it uses the COMMITTED rules: a rule staged but not committed does not fire;
    - it refuses `STALE_BASE` like the plain preview.
  - **Review Focus 4.** A staged `create_element` plus a rebind answers the new element's issues under its `tmp_` id.
- [ ] **Step 2: Golden replay of `preview_rebind`.** Stage the step's ops and call the service's `previewCommit` with `rebind`, or call `rebindPreviewBody(drain(candidateScan(...)))` directly with committed-rule compile if the golden harness has no service. The result must equal the fixture: `issues` in order and the counts exactly.
- [ ] **Step 3: See them fail.**
- [ ] **Step 4: Implement M3** (D9, D10).
- [ ] **Step 5: See them pass;** `pixi run engine-test` is green.
- [ ] **Step 6: CT-4 and README.**
  - `architecture/contracts.md` CT-4: the method, its param, its answer, its waits and refusals, and `previewCommit`'s `rebind`.
  - `engine/README.md`: the service section.
- [ ] **Step 7: Tidy, then commit** with the message `Answer candidate metamodel diffs and rebind previews in the engine`.

### Task 7: Parity and the gate at M · `implementer`
*Reason: scripts and bench rows following existing patterns; numbers only.*

**Files:** `scripts/candidate_large.py`, `pixi.toml`, `engine/bench/{run,parity-large}.ts`, `frontend/bench/{main,run}.ts`.

**Interfaces:**
- Consumes: Task 1's functions; Task 6's service method.
- Produces:
  - `benchmarks/large.candidate.metamodel.json` (the candidate document);
  - `benchmarks/large.candidate.json` (`model_half` over the M model with violations and rules);
  - the pixi task `engine-candidate-oracle`, a dependency of `engine-parity-large` and `engine-bench-browser`.

- [ ] **Step 1: The oracle** (`scripts/candidate_large.py`).
  - Reuse `issues_large.py`'s loaders (import its functions; do not copy) to get the M model with the violation ops applied and the rules compiled.
  - Derive the candidate from the smart-city metamodel:
    - one containment flag turned on;
    - one element key added;
    - one required property added;
    - one required property dropped, so `now_passing` is non-empty.
  - Write both files. Print the counts; each list must be non-empty, otherwise pick other types and say which in the hand-back.
- [ ] **Step 2: Parity** (`parity-large.ts`). After the issue parity, compare `candidateDiff(live.store, drain(candidateScan(wc.model, prepareCandidate(doc, mm => compileRuleSets(<the same sources>, mm)))))` with the oracle, as the goldens compare. Print `equal (N now_failing, M now_passing)`.
- [ ] **Step 3: Bench rows** (`run.ts`: `candidate`, `candidateLongest`, `candidateHeapMb`, and `candidateStructure` for the build alone).
  - Measure over the swept `LiveIssues` of `measureIssues`, with heap sampling in the style of `steppedExport`.
  - Record every row on every pass.
- [ ] **Step 4: The browser row** (`frontend/bench/main.ts`): `timed('candidateIssues', …)` with `ping`'s longest slice, the candidate document loaded by `frontend/bench/run.ts` beside the rules.
- [ ] **Step 5: Run.** Run `pixi run engine-parity-large`, `pixi run engine-bench` and `pixi run engine-bench-browser`. Report the medians and the parity result in the hand-back, for the owner. Optimize nothing.
- [ ] **Step 6: Tidy, then commit** with the message `Measure the candidate diff at M and hold it to the oracle`.

### Task 8: The shell — the `metamodel` surface · `critical-implementer`
*Reason: routing, fallbacks and the shadow on two user flows.*

**Files:** Frontend (Tasks 8, 9) in File Structure, except the e2e spec.

**Interfaces:**
- Consumes: Task 1's lint `document` and `structural-diff`; Task 6's methods.
- Produces:
  - `structuralDiff(body, cfg?)`;
  - `lintMetamodel` answering `document?: unknown | null`;
  - the `metamodel` surface (default `server`);
  - `metamodelIncludesStaged()`.

- [ ] **Step 1: Failing tests.**
  - **`surfaces.test.ts`:** the new list and defaults, and `anyEngineSurface` counts `metamodel` only with staging on the engine.
  - **`metamodel-route.test.ts`** (new, on `issues-engine.ts`'s harness, with a `metamodel` gate and the switch forced to `engine`):
    - `diffMetamodel` joins the engine's model half and `structural-diff`'s answer;
    - it makes no `/metamodel/diff` request;
    - a lint not `ok` rejects with `ApiError` 422;
    - a 501 `reaches an unsupported pattern` falls back to `/metamodel/diff`;
    - with the switch on `server`, only `/metamodel/diff` is requested.
  - **`checkout.test.ts`.** Replace `'a rebind sends every op to the server'` with:
    - a rebind batch previews locally, the `move_node` rest merged from the server;
    - with `local` undefined it is the server's whole;
    - an invalid blob answers the server's 422 (Review Focus 5);
    - a staged create beside a rebind answers locally with the shadow `never` (Review Focus 4).
  - **`shadow.test.ts`:** `present('metamodel', …)` ignores list order and catches a one-issue difference.
  - **`replica.svelte.test.ts`:** `metamodelIncludesStaged()` follows `engineSide('metamodel')` and the staged state, as the `exportsIncludeStaged` tests do.
  - **A `MetamodelTab` test:** the note shows when the helper holds and hides when it does not.
  - **`metamodel-editor.test.ts`:** an `ApiError` 422 from `diffMetamodel` still shows "The candidate metamodel is invalid." (the existing test, kept).
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement D11–D15.**
  - `lintMetamodel`'s schema gains `document: z.unknown().nullable().optional()`.
  - The gate in `installSeam` is the `issues` gate, with `metamodel` added to the gates map.
  - Watch `MetamodelTab.svelte`'s local `SURFACES` name.
- [ ] **Step 4: See them pass.** Run `pixi run frontend-test` and `pixi run frontend-check`.
- [ ] **Step 5: README** (`frontend/src/lib/engine/README.md`: the surface, its gate, the rebind rule, the note), **then commit** with the message `Route metamodel previews through the engine behind a switch`.

### Task 9: e2e, the flip, the documents · `implementer`
*Reason: an e2e spec in the existing style, a one-line default and documents.*

**Files:** `frontend/e2e/eval-metamodel.spec.ts`, `frontend/src/lib/engine/surfaces.ts`, `frontend/src/lib/engine/__tests__/surfaces.test.ts`, `architecture/program.md`, `BACKLOG-ENGINE.md`, the READMEs touched above.

- [ ] **Step 1: The spec** (`eval-metamodel.spec.ts`, serial). Force `dr.surfaces = {metamodel: 'engine'}` as `eval-exports.spec.ts::openReady` does, and use the default owner.
  1. **Nothing staged.** Open the Metamodel tab (`getByRole('button', {name: 'Metamodel'})`) and append a required property to a type in the text editor. Type into CodeMirror's `.cm-content` at the end of the relevant block; find the nearest existing editor-typing helper first. Click `Preview changes`, then assert that the panel lists the new issue in "Now failing" and that `metamodel-staged-note` is absent.
  2. **A staged edit.** Stage an element edit, preview again, and assert the note shows and the counts reflect the staged edit.
  3. **A staged rebind.** With the edited buffer as a staged rebind, open the Commit drawer (`helpers/commit.ts`) and assert its preview answers without a server `/commits/preview` for the rebind. Watch requests with `page.on('request')`; only the rest may go.

  The fixture's shadow watcher must stay silent.
- [ ] **Step 2: Run e2e.** The whole suite must be green except known failures (name them), with no `[shadow]` lines.
- [ ] **Step 3: The flip.** Set `SURFACE_DEFAULTS.metamodel = 'engine'`, update `surfaces.test.ts`, and drop the forcing from the spec. Run `pixi run frontend-test` and the e2e suite again.
- [ ] **Step 4: Documents.**
  - **`architecture/program.md`,** C's status. Plan 7 is built before 6 (it depends on 2 and 3 only). Record what it delivers, and the Task 7 numbers with their date and host.
  - **`BACKLOG-ENGINE.md`:** `K-80`, the server's `/metamodel/diff` stays O(model) under the write mutex and viewer-accessible until F. Add any other item the tasks opened.
  - **READMEs:** make sure they say what is now true.
- [ ] **Step 5: Final verification.** Run each of these and record the results in the hand-back:
  - `pixi run dr-test`;
  - `pixi run dr-tidy`;
  - `pixi run engine-check`;
  - `pixi run frontend-check`;
  - `pixi run sandbox-check`;
  - `pixi run engine-parity-large`;
  - e2e.
- [ ] **Step 6: Commit** with the message `Default metamodel previews to the engine`. Then stop: `engine-migration` is fast-forwarded only with the owner's go-ahead.
