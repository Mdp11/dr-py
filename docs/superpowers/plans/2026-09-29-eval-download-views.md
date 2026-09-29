# Download and View Warnings (Plan 6a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine answers the model download, byte-identical to `GET /model/download` and over committed state, and a view's warnings, over the view as staged, the working model and the working artifacts. The Python core is the oracle. Each answer sits behind its own surface switch (`download`, `views`), and both switches end the plan defaulting to the engine with the dev shadow clean in e2e. The download at M is measured in Node and Chromium and reported to the owner.

**Architecture:** Plan 6a of sub-project C's plan 6 (`architecture/program.md`); plan 6b (compare, apply-CR) follows from the same spec. Bottom-up:
1. Python: the `model_download` and `view_warnings` golden families (recorder steps only; no `src/` change).
2. Engine: an ordered committed iteration on `WorkingCopy`, the model-file writer into 4 MiB parts, and `downloadModel`.
3. Engine: the `validate_view` port and `validateView`.
4. Parity and bench at M for the download.
5. Shell: the `download` surface.
6. Shell: the `views` surface and the view store's recompute.
7. e2e, the flips and the documents.

**Tech Stack:** TypeScript 6 (`strict`, erasable syntax, no DOM or Node in `engine/src/`), vitest 3, Svelte 5 runes, zod, MSW, Playwright; Python 3.14 (pytest, ruff); pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-29-eval-compare-download-views-design.md` (approved 2026-09-29), sections "Plan 6a", "Oracle, tests, gate" and "Freeze and documents". It refines §6 of `docs/superpowers/specs/2026-09-24-evaluation-design.md`.

Read these first:
- `architecture/contracts.md` (CT-4), `architecture/decisions.md` (AD-26), `architecture/program.md` (MR-1…MR-4), `architecture/conventions.md`.
- `engine/README.md` (`src/working/`, `src/export/`, `src/service/`, golden fixtures, bench, parity).
- `frontend/src/lib/engine/README.md` (surfaces, gates, fallbacks, shadow), and `frontend/README.md` ("Named views", "View editing state") before touching `frontend/src/lib/state/`.
- Plan 5's plan (`docs/superpowers/plans/2026-09-26-eval-exports.md`), whose byte transfer, digest shadow and bench rows this plan follows.

**What kind of plan this is.** Like plans 1–5 and 7, it gives direction with specifics: interfaces and signatures, the test cases and what each asserts, the order of the work, and a full account of the mechanisms that are easy to get wrong. It gives no full code. The expected results of "see it fail" steps are reasoned from the code, not observed. If one does not appear, trust the run, read the step's intent, and say so in the hand-back.

## What planning found

These facts were checked against the code at `0523b0bd` with tracers.

1. **The server's download** (`api/routes/model.py:349-380`, `api/serialize.py:64-132`).
   - It serves `iter_model_json(session.model)`, which is committed state. The output:
     - `"{\n"`, the element chunks, `",\n"`, the relationship chunks, `"\n}"`, with no trailing newline;
     - each entity is `json.dumps(entity, indent=2, ensure_ascii=False, allow_nan=False)` with every `"\n"` replaced by `"\n    "`;
     - the first entity is prefixed `'  "<key>": [\n    '`, later ones `",\n    "`, and the list ends `"\n  ]"`; an empty list is `'  "<key>": []'`;
     - elements are `{id, type_name, properties, rev}` and relationships `{id, type_name, source_id, target_id, properties, rev}`, in dict order.
   - Headers: `application/json`, `Content-Disposition: attachment; filename="model.json"`. The UI ignores the header and names the file itself.
   - A lone surrogate or a non-finite float breaks the stream mid-way; there is no clean error.
2. **The server's view warnings** (`core/view/validation.py:15-150`, `api/routes/views.py:55-77`).
   - `validate_view(view, model, known_artifact_ids)` is served only by `GET /views/{id}` (`ViewStateResponse{id, view, warnings, view_rev}`), over the committed view, the committed model and every committed artifact id of the project (`content.list_artifact_ids`).
   - It produces six messages, each `Issue(WARNING, msg, target_ids, check="view")` with category `conformance`. The wire form is `IssueOut`, whose `origin` is `on_server` (`api/schemas.py:131-154`). Every quoted value is `!r`:

     | # | Message | `target_ids` |
     |---|---|---|
     | A | `view {name!r}: {where} references unknown artifact {id!r}; renderers skip it`, where `where` is `folder {path!r}` or the literal `the view root` | `[]` |
     | B | `view {name!r}: duplicate folder {child!r} under {where}; later occurrence ignored`, where `where` is `repr(path)`, or `'/'` for the empty path | `[]` |
     | C | `view {name!r}: folder {path!r} references unknown element {id!r}` | `[id]` |
     | D | `view {name!r}: element {id!r} has a containment parent and cannot be placed in folder {path!r}; placement ignored` | `[id]` |
     | E | `view {name!r}: element {id!r} is placed in multiple folders ({existing!r} and {path!r}); first placement wins` | `[id]` |
     | F | `view {name!r}: duplicate top-level folder {name!r}; later occurrence ignored` | `[]` |

   - **Order.**
     1. For each top-level folder, in list order: F if its name was seen before (its whole subtree is skipped), else `visit(folder, [name])`.
     2. `visit` checks the folder's own artifact refs (A), then each child folder (B if a sibling of that name was seen, skipping its subtree, else recurse), then the folder's own `elements`.
     3. Each element is checked C, then D, then E, stopping at the first that fires. Only an element that passes C and D joins the view-wide `placed` map (element → first path).
     4. The root's artifact refs (A) come last.
   - There is no dedup. An element listed twice in one folder gives E with the same path on both sides. `path` joins folder names with `/`. Name comparison is exact.
3. **The engine.**
   - `WorkingCopy` (`engine/src/working/working-copy.ts`) applies staged ops in place on `readonly model` (`:182`).
     - `committedElements` / `committedRelationships` (`:194-195`, private) hold the first before-image per touched id, `null` for a staged create.
     - `isStaged(id)` (`:257`), `committedElement(id)` (`:291`), `stagedDiff()` (`:242`).
     - `verifyDigestSteps()` (`:319-348`) walks committed state in steps, but not in order.
     - `probeStaged` is synchronous and cannot span scan steps.
   - Images (`engine/src/ops/result.ts:5-13`): `ElementImage = {id, typeName, props, rev, ord}` and `RelImage = ElementImage & {sourceId, targetId}`. Records carry `ord` (sparse, only its order matters). `Model.elements()` and `relationships()` iterate in `ord` order. A staged recreate under a committed id holds a new `ord` in the model, while its image keeps the old one.
   - `pyDumps(value, indent?, {allowNan?})` (`engine/src/value/serialize.ts:68`) is `json.dumps(ensure_ascii=False)` byte for byte. It throws a plain `RangeError('Out of range float values are not JSON compliant')` on a non-finite float.
   - `surrogateRefusal(text, byLine = false): ReadError | null` (`engine/src/export/utf8.ts:23`) gives Python's 422 wording with a code-point position.
   - `PART_BYTES = 4 MiB` (`engine/src/export/route.ts:77`) is not exported. `toParts`, `shipped` and `ExportFileResult` (`{parts, filename, content_type, truncated, script_errors: 0}`) are exported.
   - **The service** (`engine/src/service/service.ts`):
     - `transferOf(result)` (`:258-264`) transfers `result.parts` when every part is an `ArrayBuffer`.
     - `evaluate()` (`:601-631`) runs `EVALUATIONS[method]({model: wc.model, artifacts, placements, working}, params)` as a model-lane scan, with `transferOf`. `EvalContext` carries no `WorkingCopy`.
     - `inspect` (`:293`, `:635`) is a synchronous model-lane read over the `wc`.
     - `Refused` (`:73`) is private; evaluations throw the exported `ReadError(status, detail)`.
     - A control-lane transition interrupts a running scan, and `run()` is called again from scratch (`scheduler.ts:206-208`, `:305-309`). Model-lane transitions cannot run between a scan's steps.
     - `setArtifacts` / `putArtifacts` / `setStagedArtifacts` are `now` methods that can land between steps.
   - `pyRepr(s)` (`engine/src/value/repr.ts:12`). `Issue` / `IssueOut` / `wireIssue(i, origin)` (`engine/src/validation/issue.ts:12-66`); there is no warning constructor.
   - `ArtifactSet.resolve(id)` (`artifact-set.ts:353-373`) answers a staged create and a staged update, and `null` for a staged delete or an unknown id. `ElementRec.parents.length > 0` is Python's `parents_of(id)` truthiness. `model.findElement(id)`.
   - `Steps<T>` / `Progress` / `drain` are in `engine/src/steps/steps.ts`; `Meter` is in `engine/src/navigation/evaluate.ts:90-120` (`tick()` ends a step every 1,024 units).
4. **The golden harness.**
   - Python (`tests/golden/model_steps.py`):
     - `Recorder._apply` (`:942-1098`) switches on `step["do"]`.
     - `run()` (`:1100-1143`) records every key not starting with `_`.
     - `_dry` (`:836-870`) runs a staged dry run and asserts no trace. `_staged` (`:872-896`) uses it for `preview` / `validate_staged`.
     - The `artifacts` step keeps `self._artifacts` (`id → {kind, payload}`).
     - The `view` step (`:1044-1049`) records only placed ids.
     - `@scenario(name)` is in `tests/golden/driver.py:41-48`; scenarios are imported in `tests/golden/scenarios/__init__.py`.
   - Engine (`engine/test/golden/model-steps.ts`):
     - `Step` (`:131-184`), `Carried` (`:293-303`), `apply(...)` (`:583-795`), `READ_LIKE` (`:797-812`);
     - `replaySteps(fixture, options, layer: 'committed' | 'staged')` (`:820-891`), where `layer` stages the ARTIFACTS only;
     - the `preview_rebind` case stages ops on `workingCopy(clone(model, options), rev)` (`:653-654`), from `engine/test/working/helpers.ts`.
     - There is no model-staged replay mode.
   - Template: `engine/test/read/pages.golden.test.ts` (`loadFixture`, `replaySteps`, plus a `{hashKey: () => 0}` variant).
5. **Bench and parity.**
   - `engine/bench/run.ts`: `ROWS`, `record`, `timed`, `stepped`, `steppedExport(total, longest, row, steps)` (`:212-238`, the heap sampling), `pass()` (`:784-836`).
   - `engine/bench/parity-large.ts:189-265` compares export bytes against `benchmarks/large.export.<fmt>`, which `scripts/export_large.py` (task `engine-export-oracle`) writes.
   - `large.model.json` is the committed M. `scripts/bench.py:190-198` already times `iter_model_json` over it.
   - `frontend/bench/main.ts`: `timed(label, run)` (`:224`), `ping(client)` (`:66`), `longest`.
6. **The shell.**
   - **Routing** (`frontend/src/lib/api/engine-route.ts`):
     - the `Surface` union is at `:10-21`;
     - `route(surface, cfg, engineCall, serverCall, {mark, shadow, recheck, digest})` is at `:153-222`;
     - `ShadowWhen` is `unstaged | always | never`; `SKIP` exists;
     - `FALLBACKS` is at `:97-101` and `MOVED` at `:120`.
   - **Switches** (`frontend/src/lib/engine/surfaces.ts`):
     - `SURFACES` and `SURFACE_DEFAULTS` are a full `Record<Surface, Side>`;
     - `STAGED_ONLY = {issues, metamodel}`;
     - `surfaces.test.ts:19-43, 254-293` pins them. `shadow.test.ts:852` and `exports-route.test.ts:92-94` build maps from `SURFACES`.
   - **Shadow** (`frontend/src/lib/engine/shadow.ts`):
     - `always` ignores `staged()` and ends silently on any 409;
     - `present()` (`:162-185`) has no `download` or `views` branch, so arrays are order-sensitive;
     - `digestOf` replaces an ok value with its digest.
   - **Replica store** (`frontend/src/lib/state/replica.svelte.ts`):
     - `installSeam`'s gates are at `:245-286`, where `issues` is `getStagingSide()==='engine' && sync.status().seeded && follower.loaded()`;
     - the shadow's `staged` dep (`:276-279`) is `anyStaged() || getStagedArtifactDepth() > 0 || follower overlay`, with no view ops;
     - `followTables` (`:375-385`) and `onTablesMoved(listener)` (`:361-366`) are the `changed` subscription pattern, keyed `${rev}:${staged_version}:${artifacts_version}`.
   - **View store** (`frontend/src/lib/state/view.svelte.ts`):
     - `_view` / `_warnings` are at `:66-71`, `getViewWarnings()` at `:94`, and the private `setState(view, warnings)` at `:110-113`;
     - `refreshView()` (`:221-274`) replays staged view ops on the committed document and then sets the server's warnings;
     - eleven `stage*` mutators each do `_view = applyViewOp(_view, op)` then `stageViewOp(...)`;
     - hooks: `onViewDiscarded`, `onViewCommitted`, `onCommitEvent` and `onViewEvent`, the latter three registered in `setTimeout(…, 0)` (`:870-881`) because of an import cycle.
     - `view.svelte.ts` imports `replica.svelte.ts`, never the reverse.
   - **View edits** (`view-edits.svelte.ts`) is a leaf module that exports `getStagedViewDepth()` (`:49`).
   - **Schemas and the view API:**
     - `ViewStateResponseSchema` is at `types.ts:230-236`;
     - `IssueSchema` (`types.ts:27-33`) has no `category`, so zod strips it;
     - `viewsApi.getView(viewId, cfg?)` is at `lib/api/views.ts:25-31`.
   - **The download UI:**
     - `TopBar.svelte:150-158` `onExport` calls `downloadModel()` (`lib/api/model-read.ts:351-353`, `apiFetchRaw('/model/download')`) and then `saveResponseToFile(resp, modelFilename ?? 'model.json')` (`util/fileSave.ts:110-146`);
     - `fallbackDownloadBlob` is private;
     - `EngineExportFileSchema` (`types.ts:1227-1233`) requires `truncated`.
   - **Harnesses:**
     - `lib/api/__tests__/issues-engine.ts` (`issuesEngine(made, {surfaces, shadow, …})`, whose MSW has no `/views` or `/model/download` handler);
     - `lib/api/__tests__/exports-route.test.ts` (the digest-shadow test at `:311-353`);
     - `lib/state/__tests__/support/engine-store.ts` (`engineStore({surfaces})`);
     - `lib/state/__tests__/view.test.ts` mocks realtime and spies `getView`.
   - **e2e:**
     - `e2e/eval-exports.spec.ts::openReady` forces `dr.surfaces` and removes `showSaveFilePicker`;
     - `page.waitForEvent('download')`;
     - `e2e/view.spec.ts` has `bootstrap`, `loadView`, the tree and pool locators, `dragRowOnto`, and a view-warning test (`:85-104`);
     - the model menu is `model-menu-trigger` → "Export";
     - `e2e/fixtures.ts` fails a spec on any `[shadow]` line.

## Decisions

- **D1 — The committed iteration.** `WorkingCopy` gains two methods:

  ```ts
  committedElementsInOrder(): IterableIterator<ElementImage>;
  committedRelationshipsInOrder(): IterableIterator<RelImage>;
  ```

  Each is a two-way merge by `ord`:
  - (a) `model.elements()` / `relationships()` skipping every id in the committed map (whatever its current `ord`), yielded as a light image `{id, typeName, props, rev, ord}` (and `sourceId: rel.source.id`, `targetId: rel.target.id`) without copying `props`;
  - (b) the committed map's non-null images, sorted once by `ord` when the iterator starts (O(T log T), T the touched ids).

  Read-only, and valid while the model does not move. A scan guarantees that: a model-lane transition cannot run between its steps, and a control-lane one restarts it.
- **D2 — The model file.** `engine/src/download/model-file.ts`:

  ```ts
  export type ModelFile = { parts: ArrayBuffer[]; filename: 'model.json'; content_type: 'application/json' };
  export function modelFileSteps(wc: WorkingCopy, partBytes?: number): Steps<ModelFile>;
  ```

  - It writes `iter_model_json`'s framing (What planning found 1) over D1's iterators. Each entity is `pyDumps({id, type_name, properties, rev}, 2).replaceAll('\n', '\n    ')`, or the relationship shape; property values are the stored `Value`s as they are.
  - A `Meter` ticks once per entity; the total is the element count plus the relationship count of committed state (live count plus deleted images minus created ones; compute it from D1's sizes or count on the fly).
  - A non-finite float becomes `ReadError(422, 'Out of range float values are not JSON compliant')`.
- **D3 — The part writer.** `engine/src/download/parts.ts`: `class PartWriter { constructor(partBytes = PART_BYTES); write(text: string): void; finish(): ArrayBuffer[] }`.
  - It fills a preallocated `Uint8Array(partBytes)` with `TextEncoder.encodeInto`, continuing from `read` when the destination is full, so a multi-byte character never splits across parts and no string larger than one entity is ever joined.
  - A full part is pushed as is; `finish()` pushes the last part trimmed to its length (a copy on its own buffer).
  - Before encoding, a piece matching `/[\uD800-\uDFFF]/` is checked with `surrogateRefusal`. A refusal is rethrown with the position counted in code points from the document's start: the writer keeps a running code-point count, where a piece without surrogates adds its `length`.
  - `PART_BYTES` becomes an export of `export/route.ts`.
- **D4 — `downloadModel {}`.** A new private `Service.scanWorking(call, run: (wc: WorkingCopy) => Steps<unknown>)` submits a model-lane `{kind: 'scan', run: () => run(this.ready())}` with `transferOf`. `METHODS.downloadModel = (service, call) => service.scanWorking(call, (wc) => modelFileSteps(wc))`. Params are ignored.
- **D5 — The view port.** `engine/src/view/validate.ts`:

  ```ts
  export type ViewDoc = { name: string; folders: FolderDoc[]; artifacts: ArtifactRefDoc[] };
  export type FolderDoc = { id: string; name: string; folders: FolderDoc[]; elements: string[]; artifacts: ArtifactRefDoc[] };
  export type ArtifactRefDoc = { id: string; kind: string };
  export function readViewDoc(value: unknown): ViewDoc;  // ReadError(422, 'view: …')
  export function validateViewDoc(view: ViewDoc, model: Model, known: (id: string) => boolean): Issue[];
  ```

  - `readViewDoc` checks shapes by hand. An absent `folders`, `elements` or `artifacts` is `[]`, as the pydantic defaults give; read `core/view/schema.py` and match its defaults and required fields.
  - `validateViewDoc` follows What planning found 2 exactly. Messages go through `pyRepr`, and a path `p` renders as `pyRepr(p)`, with the empty path rendered `'/'` in B. The traversal is iterative: an explicit stack of frames `{folder, path, phase, childIndex}` that reproduces the recursive order.
  - Issues are `{severity: 'warning', message, targetIds, category: 'conformance', check: 'view'}`.
- **D6 — `validateView {view}`.** An `EVALUATIONS` entry. It reads and checks `view` before its generator starts, then answers in one step: `validateViewDoc(view, ctx.model, (id) => ctx.artifacts.resolve(id) !== null).map((i) => wireIssue(i, 'on_server'))`. An evaluation already runs over the working model and the working `ArtifactSet`.
- **D7 — The golden steps.** Two new recorder steps, each with an optional `stage` op list:
  - `{do: 'download', stage?: ops}` → `result` = `"".join(iter_model_json(model))`. With `stage`, the recorder first checks the ops apply, through `_dry`, and the result is still the committed text.
  - `{do: 'validate_view', view: <doc>, stage?: ops}` → `result` = `[IssueOut.from_core(i).model_dump(mode='json') for i in validate_view(View.model_validate(view), model, known_artifact_ids=set(self._artifacts))]`. With `stage`, it validates inside `_dry` over the model with the ops applied.

  The engine replays each step on `workingCopy(clone(model, options), rev)` with `stage` staged, as `preview_rebind` does. This is the plan's "replayed with staged model ops". The artifacts layer comes from `replaySteps`' existing `layer`.
- **D8 — The download surface.**
  - `download` joins `Surface`, `SURFACES` and `SURFACE_DEFAULTS` (as `server` until Task 7). It has no gate, since committed state needs neither staging nor the follower, and it is not in `STAGED_ONLY`.
  - `downloadModel(cfg?)` now answers `Promise<Blob>` on both paths:
    - the engine path is `new Blob(file.parts, {type: file.content_type})`, parsed by a new `EngineModelFileSchema`;
    - the server path is `(await apiFetchRaw('/model/download', …)).blob()`.
  - Shadow `always`. `downloadDigest(blob)` = `{type: mediaType(blob.type), size: blob.size, sha256: hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))}`.
  - `TopBar` saves through `saveResponseToFile(new Response(blob), name)`. `fileSave.ts` is unchanged.
- **D9 — The views surface.**
  - `views` joins the lists (`server` until Task 7) and `STAGED_ONLY`. Its gate is `issues`'s.
  - `lib/api/views.ts` gains `viewWarnings(viewId, view, cfg?)`:

    ```ts
    route('views', cfg, (call) => call('validateView', {view: asSent(view)}).then(parseIssues),
          () => getView(viewId, cfg).then((r) => r.warnings), {shadow: 'unstaged'})
    ```

  - The shadow compares in order. The seam's `staged` dep adds `getStagedViewDepth() > 0`, imported from the leaf `view-edits.svelte.ts`.
- **D10 — The view store's recompute.**
  - In `view.svelte.ts`, when `engineSide('views') === 'engine'`:
    - `refreshView` keeps setting the view but ignores `res.warnings`;
    - a private `recomputeWarnings()` calls `viewWarnings(activeId, _view)` and sets `_warnings`.
  - Coalescing: one computation in flight; a request made during it sets a flag and runs once more after it. Only the answer for the latest `(activeId, _view)` is applied. No timers.
  - Triggers:
    - the end of `refreshView`;
    - each `stage*` mutator, through one private helper that all eleven use;
    - `onViewsMoved`, a new `replica.svelte.ts` hook modeled on `onTablesMoved`: `followViews` keyed `${rev}:${staged_version}:${artifacts_version}`, firing only while `engineSide('views') === 'engine'`.
  - Server mode is unchanged.
- **D11 — Out of scope:** plan 6b; `K-88` (the placement winner order in `elementHomeFolderId`), logged in Task 7; optimizing anything.

## Global Constraints

- **Environment.** Everything runs through pixi (`PATH=~/.pixi/bin:$PATH`). There is no global `node` or `python`.
- **Branch and commits.**
  - Work on `feat/eval-compare-download-views`, at `engine-migration` (`ca33621a`) plus the design commit `0523b0bd` and this plan's commit.
  - One commit per task. Never push `engine-migration` or `main`; `engine-migration` is fast-forwarded only with the owner's go-ahead.
- **Freeze (MR-3).**
  - From Task 1 on, `iter_model_json`, the download route, `core/view/validation.py` and `GET /views/{id}` are frozen for behaviour. `core/model`, `core/metamodel`, the applier and plans 1–5's and 7's areas stay frozen.
  - `src/data_rover/` does not change in this plan. The Python core is the oracle: fix the engine, never a fixture. Fixtures change only through `pixi run golden-fixtures`.
- **Engine `src/` rules.**
  - No DOM, Node built-in, timer, clock, `Math.random`, `Intl` or locale comparison. Erasable syntax, `.ts` specifiers, no `any` in an exported signature.
  - A steps generator publishes nothing before its last step, and `run()` rebuilds from scratch on every start.
  - Every existing golden and `engine-parity-large` pass unmodified.
- **Tests.**
  - Tests import the engine through `engine/src/index.ts`.
  - Engine and frontend tests run the real engine, never a mock, and without fake timers. Every in-process link is `dispose()`d.
  - A "see it fail" step lists the tests it expects red. Any OTHER red test is a finding to report, not to silence.
- **Lint and checks.**
  - `pixi run engine-tidy` for `engine/`, `pixi run dr-tidy` for the rest.
  - For every file under `tests/` and `scripts/`, run `pixi run -e core-dev ruff check <files>` and `ruff format <files>`.
  - `engine-check`, `frontend-check` and `sandbox-check` pass.
- **Comments and documents.**
  - Comments are concise and present-tense, with no references to specs, plans or `architecture/` ids in code (RC-6).
  - `architecture/`, the READMEs and the backlogs change in the commit of the code they describe (RC-10).
  - `benchmarks/` is git-ignored; never `git add -f`.
- **Commit messages.** Subjects are one imperative sentence, capitalized, with no prefix and no trailing period. The message ends with exactly one trailer line:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

- **Hand-backs.** Paste the real output of every command you report (test counts, bench lines). A number that no committed code produced is a failure of the task.
- **Ids.** The next free are `AD-34`, `K-88`, `C-24`, `T-11` and `U-11`. Grep before use; K ids are unique across both backlogs.
- **Baseline.** Before Task 1, run `pixi run dr-test` and `pixi run engine-parity-large`, and record the counts in the Task 1 hand-back. As of `ca33621a`: pytest 2626, frontend 3136, engine 1612, sandbox 14.
- **e2e in this environment.**
  1. Run `pixi run sandbox-build` first.
  2. Stop a stale `vite preview` or server on :8000/:5173/:5174 in its own command.
  3. Run `pixi run frontend-test-e2e` with the default `~/.cache/ms-playwright` browsers; do not set `PLAYWRIGHT_BROWSERS_PATH`.
  4. Never edit files mid-run.

  The known failure is T-9 (`snippet-flow`, "stage a snippet edit and commit it").

## Review Focus

These are the five conditions most likely to bite a user that the tasks' ordinary tests would not reach. Each has its test in the task named.

1. **A staged delete and re-create under a committed id.** The download emits the committed entity at its original place with its committed properties, never the recreated one at the end. *Task 2* (a `WorkingCopy` test with `delete_element` + `create_element {id}` staged, plus the golden `stage` variant).
2. **A feed delta mid-download.** A peer's commit arrives, as a control-lane transition, while the download scan runs. The scan restarts and answers once, with the new committed state's bytes. *Task 2* (service test with `fakeHost({tick})`).
3. **A staged artifact create or delete named by a view.** The warning follows the working set: no A for a staged create, an A for a staged delete. The shadow stays silent while it is staged. *Tasks 3, 6.*
4. **A peer's model-only commit** deletes an element the open view places. The C warning appears without a view reload. *Task 6* (a state test firing a delta with no view scope).
5. **A multi-byte character or a lone surrogate at a part boundary.** With a tiny `partBytes`, the joined parts decode to the exact text. A lone surrogate is a 422 naming the document position, never a U+FFFD in the file. *Task 2.*

---

## File Structure

**Python goldens (Task 1)**
- Modify: `tests/golden/model_steps.py` (the `download` and `validate_view` steps), `tests/golden/scenarios/__init__.py`.
- Create: `tests/golden/scenarios/model_download.py`, `tests/golden/scenarios/view_warnings.py`.
- Fixtures (generated): `engine/fixtures/golden/{model_download,view_warnings}.json`.

**Engine (Tasks 2, 3, 4)**
- Create:
  - `engine/src/download/{parts,model-file}.ts` (Task 2);
  - `engine/src/view/validate.ts` (Task 3).
- Modify:
  - `engine/src/working/working-copy.ts` (D1);
  - `engine/src/export/route.ts` (export `PART_BYTES`);
  - `engine/src/service/service.ts` (D4);
  - `engine/src/evaluate/index.ts` (D6);
  - `engine/src/index.ts`;
  - `engine/README.md`.
- Tests:
  - `engine/test/download/{parts,model-file,model-download.golden}.test.ts`;
  - `engine/test/view/{validate,view-warnings.golden}.test.ts`;
  - `engine/test/service/download.test.ts`;
  - `engine/test/golden/model-steps.ts`.
- Bench (Task 4):
  - create `scripts/download_large.py`;
  - modify `pixi.toml`, `engine/bench/{run,parity-large}.ts` and `frontend/bench/{main,run}.ts`.

**Frontend (Tasks 5, 6, 7)**
- Modify:
  - `frontend/src/lib/api/{engine-route,model-read,views,types}.ts`;
  - `frontend/src/lib/engine/surfaces.ts`;
  - `frontend/src/lib/state/{replica.svelte,view.svelte,index}.ts`;
  - `frontend/src/lib/components/TopBar.svelte`;
  - `frontend/src/lib/engine/README.md`, `frontend/README.md`.
- Tests:
  - `frontend/src/lib/api/__tests__/{download-route,views-route}.test.ts` (new);
  - `frontend/src/lib/engine/__tests__/{surfaces,shadow}.test.ts`;
  - `frontend/src/lib/state/__tests__/view-warnings.engine.test.ts` (new);
  - `frontend/src/lib/api/__tests__/exports-route.test.ts` and `shadow.test.ts` if their `SURFACES` maps need the new keys.
- Bench (Task 4): `frontend/bench/main.ts`.
- e2e (Task 7): create `frontend/e2e/eval-download-views.spec.ts`.

**Documents:**
- `architecture/contracts.md` (CT-4: Tasks 2, 3);
- `architecture/program.md` (MR-3 rows: Task 1; C's status: Task 7);
- `BACKLOG-ENGINE.md` (Task 7).

## Dependency order

```
Task 1 ─┬─> Task 2 ─┬─> Task 3 ──> Task 6 ─┐
        │           ├─> Task 4 (parallel with 3, 5, 6)
        │           └─> Task 5 ──> Task 6 ─┴─> Task 7
```

- Task 3 follows Task 2 only because both edit `engine/src/index.ts`, `engine/README.md`, `engine/test/golden/model-steps.ts` and `architecture/contracts.md`.
- Task 6 follows Task 5 because both edit `engine-route.ts`, `surfaces.ts` and their tests.
- Task 4 touches none of 3's, 5's or 6's files and can run in parallel with them in its own worktree.

---

### Task 1: The `model_download` and `view_warnings` golden families · `critical-implementer`
*Reason: the oracle every engine task replays; the view step must record the document and a staged variant through `_dry`.*

**Files:** the Python goldens in File Structure; `architecture/program.md` (MR-3 rows).

**Interfaces:**
- Produces:
  - `engine/fixtures/golden/model_download.json` and `view_warnings.json`, whose runs hold `download` and `validate_view` steps (D7);
  - `result` is a string for `download` and a list of `IssueOut` dicts for `validate_view`;
  - `stage` is recorded as op lines, as `_ops` are.

- [ ] **Step 0: Baseline.** Run `pixi run dr-test` and `pixi run engine-parity-large`, and record the counts.
- [ ] **Step 1: The recorder steps.**
  - Add the `download` and `validate_view` cases to `Recorder._apply` (D7).
  - `validate_view` puts the document under `view` (a recorded key) and `known` is `set(self._artifacts)`.
  - Read `_dry` and `_staged` first and reuse them. If `_dry` cannot run a callback over the applied model, extend it minimally and say how in the hand-back.
  - Add `download_step(stage=None)` and `validate_view_step(view, stage=None)` builders beside `view_step`.
- [ ] **Step 2: `model_download` scenario** (`@scenario("model_download")`).
  - Build a small metamodel-conformant model through `batch` steps, with property values `1.0`, `1e-07`, `-0.0`, `1e16`, `2**64`, `"héllo ✓ 𝄞"`, `"\x7f"`, `" "`, `{}` as an empty properties map, and a nested list and dict. Take a smart-city type set, or the smallest fixture metamodel already used by `model_steps` scenarios that allows free properties; read one first.
  - Record `download` steps:
    1. after the first batch;
    2. after updating one element (it keeps its place);
    3. after deleting one element and re-creating it under the same id (it goes last);
    4. after deleting one relationship and rewiring another;
    5. over a model with no relationships (`"relationships": []`);
    6. over an empty model.
  - Give each of the second through fourth a `stage` list that a naive working walk would change: an update, a delete, a create, a delete + create under a committed id, and a relationship create. Each recorded result must equal its unstaged neighbour; assert that in the generator.
- [ ] **Step 3: `view_warnings` scenario** (`@scenario("view_warnings")`).
  - Use smart-city (it has containment), plus an `artifacts` step with two artifact ids.
  - Record `validate_view` steps that together hit all six messages and the order cases:
    - artifacts before children before elements;
    - root artifacts last;
    - F skipping a subtree whose elements would warn;
    - B nested, with the empty path rendered as `'/'` at the root;
    - C, then D, then E precedence on one element;
    - E with the same path twice;
    - a name containing `'` (repr switches quotes) and one containing `/`;
    - a known and an unknown artifact.
  - Add one step with `stage` deleting a placed element (C appears) and one with `stage` creating a containment relationship onto a placed element (D appears).
  - Assert in the generator that each message kind appears at least once.
- [ ] **Step 4: Generate and check.** Run `pixi run golden-fixtures`, then `pixi run -e core-dev pytest tests/golden`. Read both fixtures and confirm the cases differ as intended. Paste the list of `validate_view` messages in the hand-back.
- [ ] **Step 5: MR-3 rows** in `architecture/program.md`: `iter_model_json`, the download route, `core/view/validation.py` and `GET /views/{id}` are frozen for behaviour from C's plan 6a on.
- [ ] **Step 6: Tidy, then commit** with the message `Record the model download and view warnings golden families`.

### Task 2: Committed iteration, the model file and `downloadModel` · `critical-implementer`
*Reason: committed state order, byte exactness at part boundaries and a new scan path in the dispatcher.*

**Files:**
- `engine/src/working/working-copy.ts`, `engine/src/export/route.ts`;
- `engine/src/download/{parts,model-file}.ts`;
- `engine/src/service/service.ts`, `engine/src/index.ts`;
- `engine/test/download/*`, `engine/test/service/download.test.ts`, `engine/test/golden/model-steps.ts`;
- `engine/README.md`, `architecture/contracts.md`.

**Interfaces:**
- Consumes: Task 1's `model_download` fixture.
- Produces:
  - `WorkingCopy.committedElementsInOrder()` / `committedRelationshipsInOrder()` (D1);
  - `PartWriter` and `PART_BYTES` (D3);
  - `modelFileSteps(wc, partBytes?)` and `ModelFile` (D2);
  - the CT-4 method `downloadModel {}` → `ModelFile`, with its parts transferred (D4).

- [ ] **Step 1: Failing unit tests.**
  - **`parts.test.ts`:**
    - with `partBytes` 7, text mixing ASCII, `é`, `✓` and `𝄞` joins back to the exact UTF-8, and no part exceeds 7 bytes;
    - an exact multiple of `partBytes` gives no empty trailing part;
    - empty input gives zero parts (the writer's contract; a model file is never empty);
    - a lone surrogate in the third piece throws a `ReadError` 422 whose position counts code points from the document start (a preceding `𝄞` counts as one) — Review Focus 5.
  - **`working-copy` tests** (extend `engine/test/working/working-copy.test.ts` or create `committed-order.test.ts`). For each staged shape, the committed iteration equals the ids, `ord`, `props` and ends that a rewound clone yields: build the clone by `workingCopy(clone(model))`, stage, then compare against `probeStaged`'s committed side collected synchronously. The shapes:
    - an update;
    - a delete;
    - a create;
    - a delete + create under the same id (Review Focus 1);
    - a relationship rewire (delete + create);
    - two batches touching one id.
  - **`model-file.test.ts`:**
    - `drain(modelFileSteps(wc))`'s joined parts equal a hand-written expected text for a two-element, one-relationship model (the framing, the four-space re-indent, no trailing newline, `"relationships": []` when empty);
    - `partBytes` 16 gives the same bytes;
    - a `PyFloat(Infinity)` property is a 422;
    - no step visits more than 1,024 entities.
- [ ] **Step 2: Failing golden replay** (`model-download.golden.test.ts`).
  - Teach `model-steps.ts` the `download` step. With `stage`, stage the ops on `workingCopy(clone(model, options), rev)`. Drain `modelFileSteps`, join the parts, and compare with the UTF-8 bytes of `result` (byte equality; print the first difference with context on failure).
  - Add the step to `Step`, and to `READ_LIKE` only if the comparison fits it.
  - Run the family with the default hash and with `{hashKey: () => 0}`.
- [ ] **Step 3: Failing service tests** (`engine/test/service/download.test.ts`, after `exports.test.ts:154-201`).
  - `openReplica` over `smartCity()`, then `callAs<ModelFile>('d', 'downloadModel', {})`:
    - the key order is `parts, filename, content_type`;
    - the parts are the transfer list (`recording` / `answerPost`);
    - the bytes equal `modelFileSteps` over the same state.
  - With a staged `update_element` (the `stage` method), the answer is the committed bytes.
  - **Review Focus 2.** Hold the scan with `fakeHost({tick})` and post a feed delta (a control-lane transition, as `evaluations.test.ts` does). The scan restarts and there is exactly one answer, which holds the delta.
  - A cancel mid-scan gives no answer.
- [ ] **Step 4: See them fail** (missing exports, unknown method, unknown step).
- [ ] **Step 5: Implement D1–D4.** Keep `committedElements` / `committedRelationships` private; the new methods read them.
- [ ] **Step 6: See them pass.** Run `pixi run engine-test` and `pixi run engine-check`. A golden mismatch is an engine bug: fix the engine, never the fixture.
- [ ] **Step 7: Docs.**
  - `engine/README.md`: `src/working/` gets the committed iteration; a new `src/download/` entry covers the writer, parts and refusals.
  - CT-4 in `architecture/contracts.md`: `downloadModel`, its answer and its transfer.
- [ ] **Step 8: Tidy, then commit** with the message `Write the committed model file in the engine`.

### Task 3: View warnings in the engine · `implementer`
*Reason: a port whose texts and order are fully specified and held by the golden family.*

**Files:**
- `engine/src/view/validate.ts`, `engine/src/evaluate/index.ts`, `engine/src/index.ts`;
- `engine/test/view/{validate,view-warnings.golden}.test.ts`, `engine/test/golden/model-steps.ts`;
- `engine/README.md`, `architecture/contracts.md`.

**Interfaces:**
- Consumes: Task 1's `view_warnings` fixture; the harness's `stage` handling from Task 2.
- Produces:
  - `ViewDoc`, `FolderDoc`, `ArtifactRefDoc`, `readViewDoc` and `validateViewDoc` (D5);
  - the `EVALUATIONS` entry `validateView {view}` → `IssueOut[]` (D6).

- [ ] **Step 1: Failing unit tests** (`validate.test.ts`, over `smartCity()`).
  - One test per message kind asserting the exact text, `targetIds`, `severity: 'warning'`, `category: 'conformance'` and `check: 'view'`.
  - The order cases from Task 1 Step 3, asserted as the message sequence.
  - A 2,000-deep folder chain with an unknown element at the bottom yields one C, without a stack overflow.
  - `readViewDoc`: absent lists become `[]`, and a non-string `name` or a non-array `folders` is a 422 `view: …`.
  - **Review Focus 3.** An `ArtifactSet` with a staged create of `a1` and a staged delete of committed `a2`: a view naming both warns for `a2` only.
- [ ] **Step 2: Failing golden replay** (`view-warnings.golden.test.ts`).
  - Teach `model-steps.ts` the `validate_view` step, with `stage` handled as in Task 2. Call `EVALUATIONS.validateView({model, artifacts, placements}, {view: step.view})` and drain it. Compare with `result` in order.
  - Run committed, staged artifacts (`layer 'staged'`) and `{hashKey: () => 0}`.
- [ ] **Step 3: See them fail.**
- [ ] **Step 4: Implement D5 and D6.** Before writing `readViewDoc`, read `core/view/schema.py` for the defaults.
- [ ] **Step 5: See them pass.** Run `pixi run engine-test` and `pixi run engine-check`.
- [ ] **Step 6: Docs.** `engine/README.md` gets a new `src/view/` entry. CT-4 gets `validateView`.
- [ ] **Step 7: Tidy, then commit** with the message `Check views for warnings in the engine`.

### Task 4: Download parity and bench at M · `implementer`
*Reason: an oracle script and bench rows that follow the export rows' pattern; numbers only.*

**Files:** `scripts/download_large.py`, `pixi.toml`, `engine/bench/{run,parity-large}.ts`, `frontend/bench/{main,run}.ts`.

**Interfaces:**
- Consumes: Task 2's `modelFileSteps` and `downloadModel`.
- Produces:
  - `benchmarks/large.download.json`, written by the new pixi task `engine-download-oracle`;
  - `engine-download-oracle` is a dependency of `engine-parity-large` and `engine-bench-browser`.

- [ ] **Step 1: The oracle.** `scripts/download_large.py` loads `benchmarks/large.model.json` as `scripts/export_large.py` loads it (import its loader; do not copy it) and writes `"".join(iter_model_json(model)).encode("utf-8")`. Print the byte count.
- [ ] **Step 2: Parity.** In `parity-large.ts`, after the export parity:
  - compare `modelFileSteps(workingCopy)`'s joined parts with the oracle bytes, using `firstDiff` / `around`, and print `download equal (N bytes)`;
  - then stage one `update_element` on the working copy, download again, assert the bytes are still equal, and unstage.
- [ ] **Step 3: Bench rows** in `run.ts`: `download`, `downloadLongest` and `downloadPeakHeapMb`, through `steppedExport`, or a twin of it if its `ExportRow` typing refuses a `ModelFile`. Record every row on every pass.
- [ ] **Step 4: Browser row** in `frontend/bench/main.ts`: `timed('downloadModel', …)` with `ping`'s longest slice; name the new input in `frontend/bench/run.ts` if the bench checks its inputs.
- [ ] **Step 5: Run.** Run `pixi run engine-parity-large`, `pixi run engine-bench` and `pixi run engine-bench-browser`. Paste the medians (host, date) and the parity line in the hand-back, for the owner. Optimize nothing.
- [ ] **Step 6: Tidy, then commit** with the message `Measure the model download at M and hold it to the oracle`.

### Task 5: The shell — the `download` surface · `critical-implementer`
*Reason: routing, a digest shadow in `always` mode, and a return-type change on a user flow.*

**Files:**
- `frontend/src/lib/api/{engine-route,model-read,types}.ts`, `frontend/src/lib/engine/surfaces.ts`, `frontend/src/lib/components/TopBar.svelte`;
- tests: `frontend/src/lib/api/__tests__/download-route.test.ts`, `frontend/src/lib/engine/__tests__/surfaces.test.ts`, and any test building a map from `SURFACES`;
- `frontend/src/lib/engine/README.md`.

**Interfaces:**
- Consumes: Task 2's `downloadModel`.
- Produces:
  - the `download` surface (default `server`);
  - `downloadModel(cfg?): Promise<Blob>`;
  - `downloadDigest(blob)`;
  - `EngineModelFileSchema`.

- [ ] **Step 1: Failing tests.**
  - **`surfaces.test.ts`:** the new list and defaults; `download` is not staged-only; staging does not force it, and `dr.surfaces` moves it.
  - **`download-route.test.ts`** (new). Base it on `exports-route.test.ts::over` with an MSW `/model/download` handler serving the server's bytes, which are the engine's own bytes re-rendered via a direct call.
    - With the switch on `engine`: the Blob's bytes equal the engine's, and no `/model/download` request is made.
    - With the switch on `server`: only the server is asked.
    - The engine gone: the server answers.
    - **The shadow:**
      - with a staged edit and identical bytes, no report (`always`);
      - a one-byte difference gives one `[shadow] download downloadModel` line;
      - a 409 on the server ends the comparison silently.
  - **A `TopBar` test** (or its existing test file): Export saves the Blob under `modelFilename`.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement D8.**
  - Add `download` to `Surface`, `SURFACES` and `SURFACE_DEFAULTS`.
  - `EngineModelFileSchema` is `z.object({parts: z.array(z.instanceof(ArrayBuffer)), filename: z.string(), content_type: z.string()})`.
  - Find every caller of `downloadModel` (`grep -rn "downloadModel" frontend/src`) and update it. If a caller needs the `Response`, wrap the Blob.
- [ ] **Step 4: See them pass.** Run `pixi run frontend-test` and `pixi run frontend-check`.
- [ ] **Step 5: README** (`frontend/src/lib/engine/README.md`: the surface, no gate, `always`, the digest), **then commit** with the message `Route the model download through the engine behind a switch`.

### Task 6: The shell — the `views` surface and the recompute · `critical-implementer`
*Reason: a state-store change across an import cycle, with coalesced async recompute and the shadow's staged rule.*

**Files:**
- `frontend/src/lib/api/{engine-route,views}.ts`, `frontend/src/lib/engine/surfaces.ts`;
- `frontend/src/lib/state/{replica.svelte,view.svelte,index}.ts`;
- tests: `frontend/src/lib/api/__tests__/views-route.test.ts`, `frontend/src/lib/engine/__tests__/{surfaces,shadow}.test.ts`, `frontend/src/lib/state/__tests__/view-warnings.engine.test.ts`;
- `frontend/src/lib/engine/README.md`, `frontend/README.md`.

**Interfaces:**
- Consumes: Task 3's `validateView`; Task 5's surface edits.
- Produces:
  - the `views` surface (default `server`, `STAGED_ONLY`, the `issues` gate);
  - `viewWarnings(viewId, view, cfg?)`;
  - `onViewsMoved(listener) => unsubscribe`;
  - the seam's `staged` counting staged view ops.

- [ ] **Step 1: Failing tests.**
  - **`surfaces.test.ts`:** `views` joins the lists and `STAGED_ONLY`; `anyEngineSurface` counts it only with staging on the engine.
  - **`views-route.test.ts`** (on `issuesEngine`, with a `views` gate and MSW `GET /views/{id}` returning the server's warnings):
    - engine mode answers the engine's issues and makes no `/views` request;
    - server mode answers `GET`'s warnings;
    - a one-message difference is reported by the shadow when nothing is staged;
    - with a staged view op, no comparison runs.
  - **`view-warnings.engine.test.ts`** (on `engineStore({surfaces: {views: 'engine'}})`, with MSW for `/views`):
    - after `refreshView`, the warnings are the engine's, and the server's `warnings` (seeded with a sentinel message) are not shown;
    - a `stage*` mutator that places a containment child in a folder makes the D warning appear without a server call;
    - **Review Focus 4:** a delta that deletes a placed element and carries no view scope makes the C warning appear;
    - **Review Focus 3 (shell half):** a staged artifact delete of a referenced artifact gives an A warning;
    - five mutators in quick succession give at most two engine calls, and the final warnings match the final view;
    - the switch on `server` keeps today's behaviour: the server's warnings, no engine call.
  - **`shadow.test.ts`** (or the replica test that covers `installSeam`): with only a staged view op, `staged()` is true.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement D9 and D10.**
  - Keep `replica.svelte.ts` free of any import of `view.svelte.ts`; the view store subscribes through `onViewsMoved`.
  - Register the subscription where the other replica taps are registered, minding the `setTimeout` cycle note at `view.svelte.ts:870-881`.
  - Re-export `onViewsMoved` from `state/index.ts` only if a component needs it.
- [ ] **Step 4: See them pass.** Run `pixi run frontend-test` and `pixi run frontend-check`.
- [ ] **Step 5: READMEs.**
  - `frontend/src/lib/engine/README.md`: the surface, its gate, the staged rule.
  - `frontend/README.md` "Named views" / "View editing state": warnings are recomputed from the staged view in engine mode.
- [ ] **Step 6: Commit** with the message `Compute view warnings in the engine behind a switch`.

### Task 7: e2e, the flips, the documents · `implementer`
*Reason: an e2e spec in the existing style, two one-line defaults and documents.*

**Files:** `frontend/e2e/eval-download-views.spec.ts`, `frontend/src/lib/engine/surfaces.ts`, `frontend/src/lib/engine/__tests__/surfaces.test.ts`, `architecture/program.md`, `BACKLOG-ENGINE.md`, the READMEs touched above.

- [ ] **Step 1: The spec** (`eval-download-views.spec.ts`, serial). Force `dr.surfaces = {download: 'engine', views: 'engine'}` and remove `showSaveFilePicker`, as `eval-exports.spec.ts::openReady` does.
  1. **Download, nothing staged.** Use `model-menu-trigger` → "Export" and `waitForEvent('download')`. The file's bytes equal `page.request.get('/api/v1/projects/{id}/model/download')`'s body.
  2. **Download, an edit staged.** Stage a property edit and download again. The bytes still equal the server's committed download, and the shadow is compared (`always`) with no `[shadow]` line.
  3. **View warnings.** Load a view referencing an unknown element (as `view.spec.ts:85-104`) and see the warning in the Issues tab. Stage a view op that adds a warning (drag a contained element into a folder with `dragRowOnto`), and see the `ViewSelector` badge count rise before any commit.

  Run the same three with the shadow on and the switches on `server` (a `describe` per side) to pair the paths.
- [ ] **Step 2: Run e2e.** The whole suite must be green except known failures (name them), with no `[shadow]` lines.
- [ ] **Step 3: The flips.** Set `SURFACE_DEFAULTS.download = 'engine'` and `SURFACE_DEFAULTS.views = 'engine'`, update `surfaces.test.ts`, and keep the server-side `describe` forcing `server`. Run `pixi run frontend-test` and the e2e suite again.
- [ ] **Step 4: Documents.**
  - **`architecture/program.md`,** C's status: plan 6a is built. Record what it delivers, and Task 4's numbers with their date and host.
  - **`BACKLOG-ENGINE.md`:** `K-88`, the frontend's `elementHomeFolderId` checks a folder's own elements before its descendants, while `validate_view` checks descendants first, so the two can name different winners for one element. Add any other item the tasks opened, including a measured number over its budget.
  - **READMEs:** make sure they say what is now true.
- [ ] **Step 5: Final verification.** Run each of these and record the results in the hand-back:
  - `pixi run dr-test`;
  - `pixi run dr-tidy`;
  - `pixi run engine-check`;
  - `pixi run frontend-check`;
  - `pixi run sandbox-check`;
  - `pixi run engine-parity-large`;
  - e2e.
- [ ] **Step 6: Commit** with the message `Default the model download and view warnings to the engine`. Then stop: `engine-migration` is fast-forwarded only with the owner's go-ahead.
