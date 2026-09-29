# Compare and Apply-CR (Plan 6b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine answers the Compare/Change-request dialog's compare (`compareModel`: an uploaded model file diffed against the working copy) and apply-CR (`proposeCr`: change requests applied over an overlay of the working copy, answering ops or a conflict), with the Python core as the oracle. Both sit behind a new `compare` surface that ends the plan defaulting to the engine with the dev shadow clean in e2e. In engine mode Replace works while edits are staged. Compare and apply-CR at M are measured in Node and Chromium and reported to the owner. Three small follow-ups from plan 6a's final review ride along first.

**Architecture:** Plan 6b of sub-project C's plan 6 (`architecture/program.md`); plan 6a (download, view warnings) is built. Bottom-up:
1. Shell: plan 6a's follow-ups (views gate close, a visible Export failure, the gate-open test).
2. Python: the `py_eq` and `change_request` golden families, plus the duplicate-delete fix on the Python side.
3. Engine: `pyEq`.
4. Engine: `compareModel` (decode, exact parse with control characters refused, the shape checks, `diffModels`, the CR document).
5. Engine: `proposeCr` (the overlay, Phase A and B, the gate, `opsForChange`).
6. Parity and bench at M.
7. Shell: the `compare` surface, the transfer plumbing, the fallbacks and the shadow digest.
8. Shell: `ModelChangeDialog` in engine mode.
9. e2e, the flip, the documents.

**Tech Stack:** TypeScript 6 (`strict`, erasable syntax, no DOM or Node in `engine/src/`), vitest 3, Svelte 5 runes, zod, MSW, Playwright; Python 3.14 (pytest, ruff, pydantic 2, FastAPI); pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-29-eval-compare-download-views-design.md` (approved 2026-09-29), sections "What the code says today", "Plan 6b", and the 6b rows of "Oracle, tests, gate", "Freeze and documents" and "Done when". It refines §6 of `docs/superpowers/specs/2026-09-24-evaluation-design.md`.

Read these first:
- `architecture/contracts.md` (CT-4; `downloadModel` and `validateView` are the latest rows and set the style), `architecture/decisions.md` (AD-26), `architecture/program.md` (MR-1…MR-4), `architecture/conventions.md`.
- `engine/README.md` (`src/value/`, `src/working/`, `src/download/`, `src/service/`, golden fixtures, bench, parity).
- `frontend/src/lib/engine/README.md` (surfaces, gates, fallbacks, shadow), and `frontend/README.md` before touching `frontend/src/lib/state/`.
- Plan 6a's plan (`docs/superpowers/plans/2026-09-29-eval-download-views.md`), whose recorder `stage` steps, `scanWorking`, parity rows and e2e `bootstrap` this plan follows.

**What kind of plan this is.** Like plans 1–5, 6a and 7, it gives direction with specifics: interfaces and signatures, the test cases and what each asserts, the order of the work, and a full account of the mechanisms that are easy to get wrong. It gives no full code. The expected results of "see it fail" steps are reasoned from the code, not observed. If one does not appear, trust the run, read the step's intent, and say so in the hand-back.

## What planning found

These facts were checked against the code at `f79d789e` with tracers. Paths without a prefix are under `src/data_rover/`.

1. **`POST /model/compare`** (`api/routes/change_request.py:215-249`).
   - Viewers may call it (`api/authz.py:65`). Order: `require_model` (404s), `read_capped_body` (413 `Request body is too large (limit {limit} bytes)`, `api/deps.py:71-104`), `parse_model_json(body)` (`api/serialize.py:38-56`), `build_model_from_dicts(metamodel, raw, strict=False)` (`api/routes/_snapshot.py:235-331`), `diff_models(session.model, other)`, then `CompareResponse`.
   - `parse_model_json` is `json.loads(bytes, parse_constant=…)`: bare `NaN`, `Infinity`, `-Infinity` become those strings; `1e999` is NOT a constant and becomes float `inf`; the bytes' encoding is detected, so a UTF-8 BOM is stripped and UTF-16/32 are accepted; duplicate keys, last wins (in the first key's place); raw control characters in strings are refused (`strict=True`). A `JSONDecodeError` / `UnicodeDecodeError` is 422 `Request body is not valid JSON: {exc}` with CPython's own suffix.
   - `build_model_from_dicts(strict=False)`, every failure a 422 `{"detail": str}`, in this order:
     1. `raw` not a dict: `Model payload must be a JSON object`.
     2. `raw.get("elements", [])` then `raw.get("relationships", [])` not a list: `Model payload field 'elements' must be a list` (or `'relationships'`). Absent is `[]`; `null` is refused; both are checked before any entity; extra top-level keys are ignored.
     3. Per element `n`, `where = f"elements[{n}]"`: `{where}: must be an object`; `{where}: field 'id' must be a string` (absent too); `{where}: field 'type_name' must be a string`; then `_guard_element` (`:52-92`): `Element id {id!r} uses the reserved 'tmp_' prefix (client-side temporary ids of the ops protocol); loaded models must not contain such ids`; unknown type tolerated (and no abstract check for it); known abstract type `Element type {type_name!r} is abstract and cannot be instantiated`; `Duplicate element id {id!r} in snapshot`; then `properties` (`get("properties")`, absent or `null` is `{}`, a non-dict `{where}: field 'properties' must be an object`), then `rev` (`get("rev", 0)`, a bool or non-int `{where}: field 'rev' must be an integer`; a bigint is accepted).
     4. Per relationship `n`, `where = f"relationships[{n}]"`: not an object; `id`, `type_name`, `source_id`, `target_id` not strings, in that order; the reserved prefix (`Relationship id …`); unknown type tolerated (no abstract check for relationships at all); `Relationship {rid!r} references unknown source {source_id!r}`, then `… unknown target {target_id!r}` (against the payload's own elements); `Duplicate relationship id {rid!r} in snapshot`; then `properties`, then `rev`.
     5. Element and relationship ids are separate sets: sharing one is tolerated. Property keys and values are not checked.
   - **`diff_models(base, other)`** (`core/model/change_request.py:281-315`): identity by id; elements match on `type_name` and `properties` (`_element_matches`, `:85-86`), relationships also on `source_id` and `target_id` (`:89-95`); Python `==`; `rev` ignored. Order: elements added and modified iterating `other`, then elements deleted iterating `base`, then the same for relationships. Added is other's entity (its `rev`), modified is `{id, before: base's, after: other's}`, deleted is base's.
   - **The answer.** `CompareResponse` (`api/schemas.py:911-923`) is `{model_rev, cr, other_element_count, other_relationship_count}` (the file's counts); `model_rev` is `session.model_rev`. `cr` is `_changes_out(base, diff)` (`routes/change_request.py:139-177`, `ChangesOut` at `schemas.py:856-872`):

     ```
     {"format":"datarover.cr/v1","createdAt":…,"baseline":{"filename":null,"elementCount":N,"relationshipCount":M},
      "ops":{"elements":{"added":[E…],"modified":[{"id","before":E,"after":E}…],"deleted":[E…]},
             "relationships":{"added":[R…],"modified":[…],"deleted":[R…]}},
      "complete":true}
     ```

     E is `{id, type_name, properties, rev}`, R is `{id, type_name, source_id, target_id, properties, rev}`. The baseline counts are the session model's. `createdAt` is `_now_iso()` (`routes/read.py:611-613`): `datetime.now(UTC).isoformat(timespec="milliseconds")` with `Z`, the shape of JS `toISOString()`. Starlette writes pydantic's JSON mode: a non-finite float is `null`, a bigint exact, `1.0` as `1.0`.
2. **`POST /model/apply-cr`** (`routes/change_request.py:180-212`).
   - A write route (viewers 403). Body `ProposeCrRequest {crs: list[ChangeRequestIn]}`, 1–20 items (`schemas.py:889-894`). `ChangeRequestIn` (`schemas.py:782-815`): `format` must be `"datarover.cr/v1"`, `createdAt` a required string, `baseline` and `ops` optional, extra keys ignored. Entities: `id`, `type_name` (and `source_id`, `target_id`) required strings; `properties` defaults to `{}` but explicit `null` is refused; `rev` defaults to 0 and is a LAX int (`true`→1, `"3"`→3, `1.0`→1). Modified entries are `{id, before, after}`, keyed on `id`. A validation failure is FastAPI's list-shaped 422.
   - Order: `model_rev = session.model_rev`, then per CR `current = apply_change_request(current, cr.to_core())`; the first `CRConflictError` answers a `JSONResponse(409, {"cr_index", "conflicts": [{kind, entity, id, reason}…], "model_rev"})` (no `detail`). Then `combined = diff_models(base, current)`, `_gate_cr_result`, `ops_for_change`, and `ProposeCrResponse {model_rev, cr: _changes_out(base, combined), ops}` (`schemas.py:897-908`). The answered `cr` is the recomputed combined diff, not the input.
   - **`apply_change_request`** (`core/model/change_request.py:103-273`) is pure: it copies every entity and rebuilds indexes.
     - **Phase A** collects every conflict against the model before that CR, in six buckets: elements added (`id_exists`, `Element {id!r} already exists in the model`), elements modified (`missing`, `Element {id!r} does not exist in the model`; `before_mismatch`, `Element {id!r} does not match the before snapshot`), elements deleted (`missing`, same text; `before_mismatch`, `Element {id!r} does not match the deleted snapshot`), then relationships the same with `Relationship`. `entity` is `element` / `relationship`. Equality ignores `rev`.
     - **Phase B**, elements then relationships, each added then modified then deleted, on the copied dicts: added `d[id] = copy(e)` (the CR's `rev`); modified `d[id] = Entity(after…, rev=d[id].rev + 1)` (keeps its place); deleted `del d[id]` (`:249`, `:266`). Phase A never checks a CR against itself: a duplicate add, last wins at the first's place; a duplicate modify bumps `rev` twice, last `after` wins; modify plus delete ends deleted; a delete and add of one id in one CR is `id_exists`; a modify of an id added in the same CR is `missing`.
     - **The bug.** A duplicate id in `deleted` passes Phase A; the second `del` raises `KeyError`, which `api/errors.py:19-21` turns into 404 `{"error": id}`.
   - **`_gate_cr_result`** (`routes/change_request.py:78-136`), each a 422 string `detail`, first error only:
     1. Added elements, then modified elements' `after`: `Unknown element type {t!r}`, then `Element type {t!r} is abstract and cannot be instantiated`.
     2. Added relationships, then modified relationships' `after`: `Unknown relationship type {t!r}`, then source, then target via `_require_endpoint` against the result's elements: `Relationship {rid!r} references unknown {role} {eid!r}`.
     3. Per deleted element, in combined order: `sorted(base.indexes.outgoing_ids(id) | incoming_ids(id))` (code-point order); each rid that survives in the result is checked source then target, same text. Read `:78-136` for which entity (base or result) each check reads.
   - **`ops_for_change`** (`api/change_request_ops.py:68-154`): scans every modified element first and raises `UnsupportedChangeError` (a `ValueError`, route → 422) on a retype: `Element {id!r} changes type ({before!r} -> {after!r}); element type changes are not supported — delete and re-create it in the CR` (U+2014). Then: `create_element {kind, temp_id, type_name, properties, id}` per added element; `create_relationship {kind, temp_id, type_name, source_id, target_id, properties, id}` per added relationship, ends on added elements as their temp ids; `update_element {kind, id, properties_patch}` per modified element with a non-empty patch; `update_relationship` for modified relationships that are not rewires (`_is_rewire`, `:60-65`: source, target or type changed); `delete_relationship {kind, id}` per deleted relationship; per rewire, in modified order, `delete_relationship` then its `create_relationship` (the next temp id, `id` = `after.id`); `delete_element` per deleted element. One counter, `tmp_1`, `tmp_2`, …, shared by both kinds. `_diff_to_merge_patch` (`:47-57`): after's keys in after's order where absent in before or `before[k] != v`, then before's keys missing from after as `None`. Read the file for the exact key order of each op dict and copy it.
   - **Order is observable.** Python dict order after Phase B flows into the combined diff: a modify keeps its place; an id deleted in one CR and re-added in a later one moves to the end (and, being in base, shows as modified there, or vanishes if equal to base); adds append. That order sets `cr.ops.*.modified`/`added`, the op order and the temp-id numbering.
   - Tests: `tests/model/test_apply_change_request.py`, `tests/model/test_change_request_diff.py`, `tests/api/test_apply_cr_route.py`, `tests/api/test_change_request_ops.py`, `tests/api/test_compare_route.py`, `tests/api/test_request_body_limit.py`. No golden touches CR or compare.
3. **The engine.**
   - `Value` (`engine/src/value/types.ts:14-15`): `number` is always an int, `PyFloat` every float, `bigint` an int past 2^53, dicts plain objects in insertion order (array-index keys cannot keep their place; the loader and the applier refuse them).
   - `parseExact(text, {floatConstants?})` (`value/parse.ts:195-197`): bare constants are strings by default; it accepts raw control characters (no option), does not skip a BOM, keeps a duplicate key's first place with the last value, throws `SyntaxError`.
   - No Python `==` exists. `pyKey` (`value/key.ts:22`) equates a dict with its pair list and NaN with NaN; `pyRuleEq` (`rules/evaluate.ts:37-43`) separates bool from int and takes a scalar operand.
   - `toWire(value)` (`read/wire.ts:32`): `PyFloat` → its number (a non-finite one stays `Infinity`/`NaN`), `bigint` → `Number`. `readOps` (`read/wire.ts:172-181`) round-trips through `JSON.stringify` + `parseJson`.
   - The only UTF-8 decoder is `utf8Decoder()` (`snapshot/utf8.ts:19-23`), `fatal: true, ignoreBOM: true` (it KEEPS a BOM).
   - The model loader (`model/model.ts:299-362`, `model/load.ts`) matches the per-entity texts but also refuses array-index property keys, a relationship id that is an element id, and a bigint `rev`, and has none of the top-level checks. Compare does not use it.
   - `WorkingCopy` (`working/working-copy.ts`): `wc.rev` (`:234`) is the committed rev; `wc.model.elements()` / `relationships()` iterate the working state in `ord` order; `ElementRec {id, typeName, props, rev, ord, out, in, parents}`, `RelRec {…, source: ElementRec, target: ElementRec}` (`model/records.ts`); `model.findElement` / `findRelationship`; `elementCount` / `relationshipCount`. Metamodel: `elementType(name)?.abstract`, `relationshipType(name)` (`metamodel/metamodel.ts:195-203`).
   - There is no overlay or copy-on-write model; writing to `wc.model` outside a transition breaks its contract.
   - The service (`service/service.ts`): `scanWorking(call, run: (wc) => Steps<unknown>)` (`:640-642`) runs a model-lane scan; a control-lane transition restarts `run()` from scratch. `METHODS` (`:309-397`); `receive` (`:516-538`) runs a handler synchronously, so params read at arrival refuse before queueing. An error answer carries `{status, detail}` only; any object can be an ok `result`. `chunk {bytes}` is the only binary input today, transferred by the host (`frontend/src/lib/engine/sync.ts:655`, `:683`).
   - `Steps` / `drain` (`steps/steps.ts`), `Meter` (`navigation/evaluate.ts:90-126`, a tick every 1,024 units). The scan-that-answers-once pattern is `download/model-file.ts:95-104`.
   - Op shapes (`ops/types.ts:9-45`) and the applier's refusals (`ops/apply.ts`, `model/model.ts`) are those the spec's "as today" names.
4. **The golden harness.**
   - Python: `@scenario(name)` (`tests/golden/driver.py:41-48`); scenarios must be imported in `tests/golden/scenarios/__init__.py`. `tagged.py::tag()` encodes values JSON can't hold (`{"t":"int","v":"<text>"}`, `{"t":"float","hex":…}` for `1.0`, `-0.0`, inf, NaN, ordered `dict` pairs). Value-table families: `py_repr`, `json_dumps`, `json_parse`, `frozen_groups` (the closest template), `py_coerce` (records `{"error": …}`).
   - `tests/golden/model_steps.py`: `Recorder._apply` (`:999-1176`), `run()` (`:1178-1220`; an `HTTPException` is recorded as `{status, detail}`), `_dry` (`:868-902`), `_over_stage(step, read)` (`:958-981`, shared by `download` and `validate_view`: with `_stage` it applies the ops inside `_dry`, reads, then rolls back), `_staging(stage)` (`:308-309`), `download_step` / `validate_view_step` (`:312-326`). `tests/golden/scenarios/model_download.py` is the template for a `stage` scenario.
   - Engine: `engine/test/golden/load.ts` (`loadFixture`, `untag`, `sameValue`); `engine/test/golden/model-steps.ts`: `Step` (`:134-191`, `stage?: string[]`), `apply` (`:618-841`), `stagedReplica(model, step, carried)` (`:584-590`), `READ_LIKE` (`:844-860`, compared by `JSON.stringify`, so key order matters), `replaySteps` (`:869-940`; errors map to `StepError` `:899-906`). Value-table replay templates: `engine/test/value/{key,parse,coerce}.golden.test.ts`.
5. **Bench and parity.**
   - `engine/bench/run.ts`: `ROWS` (`:86-158`), `record`, `timed`, `stepped`, `steppedExport` (heap sampling, `:216-243`), `measureDownload` (`:789-797`), `pass()` (`:799-850`). Every row must be recorded on every pass or printing crashes.
   - `engine/bench/parity-large.ts`: required files (`:92-105`), download parity (`:282-321`), `firstDiff` / `around`, `canonical()` (`:423-429`), a final `process.exit(1)` on any failure.
   - Oracle scripts: `scripts/download_large.py` (the loader: `load_metamodel_file`, `parse_model_json`, `build_model_from_dicts(strict=False)`), `scripts/issues_large.py` (`Violations`, deterministic sampling over the raw doc; `_apply_batch`), `scripts/export_large.py` (pins the clock, `_clock`).
   - `pixi.toml`: `engine-download-oracle` (`:142-144`), `engine-bench` (`:313-317`, depends on `engine-candidate-oracle`), `engine-parity-large` (`:324-334`), `engine-bench-browser` (`:336-345`).
   - `frontend/bench/vite.config.ts:10-53` serves inputs from `DATA`; `frontend/bench/run.ts:49-72` checks them; `frontend/bench/main.ts` `ping`, `timed`, the download row (`:316-324`); new rows go before the final wrong-digest delta (`:362-386`).
6. **The shell.**
   - **The dialog** (`frontend/src/lib/components/ModelChangeDialog.svelte`, mounted twice in `TopBar.svelte:389-390`):
     - `bufferDirty = hasStagedOps()` (`:56`); `proceedDisabled = busy || !hasSource || !editable || bufferDirty || tooManyCrs || (compare && swapped)` (`:64-66`); the hint `mcd-gate-hint` says `Commit or discard your staged edits first.` (`:375-378`).
     - `ensureCompared` (`:147-154`) caches `{rev, out}` while `getModelRev()` stands. Preview (`:186-211`) previews the compare `cr` (inverted when swapped) or, in apply-cr mode, `proposeCr(crFiles)`. Replace (`onProceed`, `:237-253`) always calls `proposeCr(crs)`, then `stageProposedOps(res.ops, res.modelRev, crPrestate(res.cr))`; a `!res.ok` shows conflicts via `ProposalPreview.svelte:17-31`.
   - **`lib/api/changeRequest.ts`**: `compareModel(file: Blob, cfg?)` posts the File as the body (`:31-33`); `proposeCr(crs, cfg?)` (`:41-67`) catches `ConflictError` and parses its body with `ProposeCrConflictSchema` into `{ok: false, modelRev, crIndex, conflicts}`, else `{ok: true, modelRev, cr, ops}`. Schemas at `types.ts:248-253`, `:711-779`.
   - **`stageProposedOps`** (`state/stage-proposed.ts:48-156`): refuses `stale` unless `modelRev === getModelRev()`; remaps temp ids; seeds the prestate (`seedElements` / `seedRelationships`, which set the engine store's mirror entries, `model-engine.svelte.ts:634-648`); takes locks; stages one batch.
   - **Routing** (`lib/api/engine-route.ts`): `Surface` (`:10-23`), `route(surface, cfg, engineCall, serverCall, {mark, shadow, recheck, digest, stale})` (`:163-233`); the shadow's `again()` re-runs `engineCall` (`:203`); `FALLBACKS` (`:107-111`) maps exact 501 details; `MOVED` (`:130`). `EngineCall` is `(method, params, signal?)`: **no transfer**, nor in `createEngineSeam.call` (`engine/seam.ts:28-29`) or `ReplicaSync.call` (`engine/sync.ts:115-119`, `:1278`); only the raw client has `transfer` (`engine/client.ts:11`, `:124`).
   - **Surfaces** (`engine/surfaces.ts`): `SURFACES`, `SURFACE_DEFAULTS` (every surface `engine`), `STAGED_ONLY = {issues, metamodel, views}`, the `readSwitches` doc comment (`:54-61`). Gates in `state/replica.svelte.ts::installSeam` (`:269-313`): `views: issues`.
   - **Shadow** (`engine/shadow.ts`): `present()` (`:163-186`), otherwise order-sensitive `deepEqual`; errors compared by status only; `jsonText(params)` in the report.
   - **Harnesses**: `lib/api/__tests__/issues-engine.ts` (`issuesEngine(made, {surfaces, shadow, …})`, `stage(ops)`), `download-route.test.ts`, `views-route.test.ts`, `lib/state/__tests__/support/engine-store.ts`, `components/__tests__/ModelChangeDialog.test.ts` (mocks `$lib/state` and spies the API; no engine).
   - **e2e**: no spec covers the dialog. `e2e/eval-download-views.spec.ts::bootstrap(page, side, view)` and its helpers (`stagedChangeCount`, `discardAll`); `e2e/fixtures.ts` fails a spec on any `[shadow]` line.
7. **Plan 6a's follow-ups.**
   - `replica.svelte.ts` `onStatus` (`:137-143`) and the follower's `onLoaded` (`:482-487`) call `viewsMoved()` only when the views gate opens; `viewsMoved()` (`:456-459`) returns unless `engineSide('views') === 'engine'`. When the gate closes (a resync, a follower stop, `off`), the view store keeps the engine's warnings, which the server's `GET /views/{id}` no longer backs.
   - `TopBar.svelte::onExport` (`:170-181`) only `console.error`s a failed download. The status bar shows `getLockNotice()` (`state/lock-notice.svelte.ts`, `StatusBar.svelte:24`).
   - No test pins the views gate-open recompute (`onStatus` to `ready`, follower `onLoaded`).

## Decisions

- **D1 — `pyEq`.** `engine/src/value/eq.ts`: `export function pyEq(a: Value, b: Value): boolean`, Python `==`:
  - `null` equals only `null`; a string equals a string by code units;
  - bool, int (`number`), `bigint` and `PyFloat` are numbers: `true == 1 == 1.0`, `false == 0 == -0.0`; int against float exact (`2**53 + 1` against `PyFloat(2**53)` is false: compare a `bigint`/int with a float by converting the float to `BigInt` only when it is integral and finite, else false); NaN equals nothing, itself included;
  - a list equals a list of equal length element-wise; a dict equals a dict with the same key set and equal values, in any order; a dict never equals a list;
  - different kinds are unequal (`"1" != 1`).
  - Python's container identity shortcut (`[x] == [x]` for one NaN object) is not reproduced: no two values here share a float object (the file and the model are parsed separately).
- **D2 — Reading the file.** `engine/src/cr/read-file.ts`:
  - `decodeModelFile(bytes: ArrayBuffer): string`: a fatal UTF-8 decode that strips one leading BOM (a new decoder with `ignoreBOM: false`, or strip `﻿` from `utf8Decoder()`'s output).
  - `parseExact` gains `ParseOptions.controlCharacters?: boolean` (default `true`, today's behaviour); `false` throws the parser's `SyntaxError` on a raw U+0000–U+001F inside a string.
  - Any decode or parse failure is `ReadError(501, 'reaches an unreadable file')`. The server answers such a file with its own wording (`Request body is not valid JSON: …`), and accepts UTF-16/32, which the engine sends to it too.
  - `readModelFile(value: Value, metamodel: Metamodel): OtherModel` runs the shape checks of What planning found 1 in their order and texts, each a `ReadError(422, text)`, texts through `pyRepr`. `OtherModel = {elements: Map<string, OtherElement>, relationships: Map<string, OtherRel>}` in file order, `OtherElement = {id, typeName, props: {[k]: Value}, rev: number | bigint}`, `OtherRel = OtherElement & {sourceId, targetId}`. No `Model`, no indexes, no property-key check (array-index keys are tolerated), a `bigint` rev accepted, an element and a relationship may share an id.
- **D3 — `diffModels` and the document.** `engine/src/cr/diff.ts`:
  - `diffSteps(wc: WorkingCopy, other: OtherModel): Steps<Diff>`, `Diff = {elements: {added, modified, deleted}, relationships: {…}}` holding `CrEntity`s (`{id, type_name, properties, rev}` and the relationship shape, in the key order of E and R) and `{id, before, after}`. Identity by id, match on `type_name`, `pyEq` of `properties`, and for relationships the ends; `rev` ignored. Added and modified in the file's order, deleted in `wc.model`'s order, elements first. A `Meter` ticks per entity with steps of 2,048 entities (the spec's number; `Meter` counts 1,024 per tick, so tick every other entity or give `Meter` a unit size).
  - `engine/src/cr/document.ts`: `crDocument(diff, baseline: {elementCount, relationshipCount}, createdAt: string)` writes `_changes_out`'s shape and key order with `filename: null`, `complete: true`. `crWire(value)`: `toWire` with a non-finite float turned into `null`, as pydantic writes it. Every entity leaves through `crWire`.
- **D4 — `compareModel {file, created_at}`.**
  - Params are read at arrival: `file` an `ArrayBuffer` (else 422 `file must be an ArrayBuffer`), `created_at` a non-empty string (else 422 `created_at must be a string`). Kept, not detached, so a restarted scan reads it again.
  - `METHODS.compareModel = (service, call) => service.scanWorking(call, (wc) => compareSteps(wc, params))`. `compareSteps` decodes, parses and runs `readModelFile` in its first block, then yields the diff's steps, then answers `{model_rev: wc.rev, cr, other_element_count, other_relationship_count}`, `baseline` counts `wc.model.elementCount` / `relationshipCount`. The parsed file is cached in the closure across a restart (it does not depend on the model); the shape checks and the diff run again.
- **D5 — The overlay.** `engine/src/cr/overlay.ts`, `class CrOverlay` over a `WorkingCopy`'s model, one per kind:
  - `get(id)`: the overlay's entry (an entity, or `DELETED`), else the working record's image; `has(id)`.
  - `set(id, entity)` keeps the entry's place when the id is present in the current state (a working record not deleted in the overlay, or an overlay entity), else appends a fresh sequence number; `delete(id)` marks `DELETED` and forgets the sequence. That is Python's dict after the same `d[id] = …` / `pop`.
  - `touched()` in current-state order: ids present in the working model and never deleted in the overlay, by `ord`; then every appended id by sequence. Deleted ids come separately, in `ord` order, filtered to those in the working model.
  - O(CR + incident): no model copy, no write to `wc.model`.
- **D6 — `proposeCr {crs, created_at}`.** `engine/src/cr/propose.ts`.
  - **Reading the CRs, at arrival.** `readCrs(raw)`: a `JSON.stringify` + `parseJson` round trip (as `readOps`), then a strict reader: 1–20 CRs; `format === 'datarover.cr/v1'`; `createdAt` a string; `baseline` and `ops` optional (`ops.elements` / `ops.relationships` and each list default to empty); entities with string `id`, `type_name` (and ends), `properties` a dict or absent (`{}`), `rev` an int (`number` or `bigint`) or absent (0); modified entries `{id: string, before, after}`; extra keys ignored. Anything else is `ReadError(501, 'reaches an unreadable change request')`, so the server answers with pydantic's 422 or its lax acceptance (`"3"` as a `rev`), which the engine does not port.
  - **Per CR, Phase A** (What planning found 2) against the overlay before that CR, `pyEq` equality, texts through `pyRepr`. On a conflict the scan answers `{conflict: {cr_index, conflicts, model_rev: wc.rev}}` as an ok result (an engine error carries `detail` only).
  - **Phase B** into the overlay, elements then relationships, each added, modified, deleted: added `set(id, entity)` with the CR's `rev`; modified `set(id, {after…, rev: current rev + 1})` (`number` or `bigint` arithmetic); deleted `delete(id)`, a no-op when already deleted in this CR (the fix).
  - **The combined diff** over `touched()` against the working records (What planning found 2, "Order is observable"), then `_gate_cr_result` (incident relationships of a deleted element from the working record's `out` / `in`, sorted by `cmpCodePoint`), each a `ReadError(422, text)`; then `opsForChange` (`engine/src/cr/ops.ts`), the retype a 422. The answer: `{model_rev: wc.rev, cr: crDocument(combined, working counts, created_at), ops}`, ops in the op dicts' key order, values through `crWire`.
  - `METHODS.proposeCr` reads params at arrival and runs `service.scanWorking`, steps of 2,048 entities over the CRs and the diff.
- **D7 — The golden steps.** Two new recorder steps, each with an optional `stage` (through `_over_stage`) and a recorded `created_at` pinned into `_now_iso`:
  - `{do: 'compare', file: <text>, created_at, stage?}` → `result` = `CompareResponse(...).model_dump(mode='json')`, or the error. `file_b64` replaces `file` for bytes that are not UTF-8 text (a BOM, UTF-16, an invalid byte). `fallback: true` marks a step whose engine answer is the 501 `reaches an unreadable file`, whatever Python answered.
  - `{do: 'apply_cr', crs: [...], created_at, stage?}` → `result` = the `ProposeCrResponse` JSON, or the 409 body as `{status: 409, body}`, or an error. `fallback: true` as above for `reaches an unreadable change request`.
  - Both call the route functions (`compare_model`, `apply_cr` in `routes/change_request.py`) against the recorder's session, as `scripts/export_large.py` calls `export_table`. If a route function cannot be called without a real request, build the smallest Starlette `Request` that works (a `receive` returning the body) and say so in the hand-back.
  - The engine replays each step through `compareSteps` / `proposeSteps` over `stagedReplica(...)` with `JSON.stringify` equality (READ_LIKE), a conflict compared against the recorded 409 body.
- **D8 — The duplicate-delete fix.** `core/model/change_request.py:249` and `:266` delete with `pop(id, None)`. A test in `tests/model/test_apply_change_request.py` and a `change_request` fixture step hold it; `src/data_rover/api/README.md` says so.
- **D9 — The `compare` surface.**
  - `compare` joins `Surface`, `SURFACES`, `SURFACE_DEFAULTS` (`server` until Task 8), the `readSwitches` doc comment and `STAGED_ONLY`; its gate is `issues`'s.
  - **Transfer.** `EngineCall` gains an optional fourth `transfer?: ArrayBuffer[]`, passed through `createEngineSeam.call` and `ReplicaSync.call`'s options to `client.call`'s `transfer`. The shadow's `again()` re-runs `engineCall`, which reads `file.arrayBuffer()` afresh, so a detached buffer is never reused.
  - `compareModel(file, cfg?)`: `route('compare', cfg, async (call) => { const bytes = await file.arrayBuffer(); return parse(await call('compareModel', {file: bytes, created_at: new Date().toISOString()}, undefined, [bytes])) }, server, {shadow: 'unstaged', digest: maskCreatedAt})`.
  - `proposeCr(crs, cfg?)`: both sides answer `ProposeCrResult`. The server side keeps today's catch of `ConflictError`; the engine side turns `{conflict}` into the same `{ok: false, …}` and `{model_rev, cr, ops}` into `{ok: true, …}`. `crs` are sent `asSent(crs)`. So the shadow compares conflicts too, and the dialog sees one shape whichever side answered (the spec's "the same 409" is met at this level).
  - `FALLBACKS` gains `'reaches an unreadable file'` and `'reaches an unreadable change request'`, answered by the server unmarked (as `rules`).
  - `maskCreatedAt(value)`: the value with `cr.createdAt` removed, for both functions.
- **D10 — The dialog in engine mode** (`engineSide('compare') === 'engine'`):
  - `proceedDisabled` drops `bufferDirty`; the hint for it goes away.
  - Preview and Create CR show `Includes staged changes` (the existing wording) when `hasStagedOps()` held at the answer.
  - `ensureCompared` does not cache in engine mode: the answer depends on staged state, and there is no upload to save.
  - Server mode keeps today's rules.
- **D11 — Plan 6a's follow-ups.**
  - `replica.svelte.ts` gains `onViewsClosed(listener)`, fired when `viewsOnEngine` goes from true to false in `onStatus`, in `stopFollower`, and when the follower unloads (find every place the gate's inputs fall). The view store registers `onViewsClosed(() => void refreshView())`, which in server mode takes `GET /views/{id}`'s warnings.
  - `TopBar.svelte::onExport` shows a failure other than `AbortError` with `setLockNotice(\`Export failed: ${message}\`)`.
  - A state test pins the recompute on the gate opening: the replica reaching `ready` with the follower loaded, and the follower's `onLoaded`.
- **D12 — Out of scope:** plan 8; optimizing anything; porting pydantic's lax CR validation (D6 sends it to the server); roles (the dialog already disables apply-CR for viewers, and the engine checks none); the integral-float loss of a CR crossing the frontend as parsed JSON, which both paths share (logged `K-93` in Task 8).

## Global Constraints

- **Environment.** Everything runs through pixi (`PATH=~/.pixi/bin:$PATH`). There is no global `node` or `python`.
- **Branch and commits.**
  - Work on `feat/eval-compare-apply-cr`, at `engine-migration` (`f79d789e`, pushed) plus this plan's commit.
  - One commit per task; fix rounds add commits on top. Never push `engine-migration` or `main`; `engine-migration` is fast-forwarded only with the owner's go-ahead.
- **Freeze (MR-3).**
  - From Task 2 on, `core/model/change_request.py`, `api/change_request_ops.py`, `api/routes/change_request.py`, `api/routes/_snapshot.py::build_model_from_dicts` and `api/serialize.py::parse_model_json` are frozen for behaviour, except D8's fix. `core/model`, `core/metamodel`, the applier and every earlier plan's areas stay frozen.
  - The Python core is the oracle: fix the engine, never a fixture. Fixtures change only through `pixi run golden-fixtures`.
- **Engine `src/` rules.**
  - No DOM, Node built-in, timer, clock, `Math.random`, `Intl` or locale comparison. Erasable syntax, `.ts` specifiers, no `any` in an exported signature.
  - A steps generator publishes nothing before its last step, and `run()` rebuilds from scratch on every start (a cached parse of the uploaded file is the one exception, D4).
  - Nothing writes to `wc.model` outside a transition.
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
- **Commit messages.** Subjects are one imperative sentence, capitalized, with no prefix and no trailing period. The message ends with exactly one trailer line naming the model that wrote the commit, e.g.:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

  (a Sonnet-run agent writes `Claude Sonnet 5.5`).
- **Hand-backs.** Paste the real output of every command you report (test counts, bench lines). A number that no committed code produced is a failure of the task.
- **Ids.** The next free are `AD-34`, `K-92`, `C-24`, `T-11` and `U-11`. Grep before use; K ids are unique across both backlogs.
- **Baseline.** Before Task 1, run `pixi run dr-test` and `pixi run engine-parity-large`, and record the counts in the Task 1 hand-back. As of `f79d789e`: pytest 2626, frontend 3167, engine 1664, sandbox 14.
- **e2e in this environment.**
  1. Run `pixi run sandbox-build` first.
  2. Stop a stale `vite preview` or server on :8000/:5173/:5174 in its own command.
  3. Run `pixi run frontend-test-e2e` with the default `~/.cache/ms-playwright` browsers; do not set `PLAYWRIGHT_BROWSERS_PATH`.
  4. Never edit files mid-run.

  The known failure is T-9 (`snippet-flow`, "stage a snippet edit and commit it").

## Review Focus

These are the five conditions most likely to bite a user that the tasks' ordinary tests would not reach. Each has its test in the task named.

1. **Replace while edits are staged, in engine mode.** A user renames element `a` (staged), then compares against a file where `a` has another name and `b` is deleted, and presses Replace. The staged result equals the file: `a`'s patch is computed from the staged name, nothing double-applies, and `stageProposedOps`' prestate holds the working images. *Tasks 5 (a service test staging a rename, then `proposeCr` over the compare's CR, then staging the ops and reading the working copy back), 8.*
2. **A CR that deletes an id and a later CR that re-adds it.** The re-added entity moves to the end of the combined diff, its temp id numbered after the others, and a re-add identical to the working entity vanishes from the diff. *Tasks 2 (fixture), 5 (overlay unit test against a `Map` with Python dict semantics).*
3. **A peer's commit lands between Compare and Replace.** The engine's `model_rev` is the replica's committed rev; `stageProposedOps` refuses `stale` with "The model changed since the proposal — preview again." rather than staging ops computed on old state. A control-lane transition during the scan restarts it and answers once. *Tasks 4 (service test with `fakeHost({tick})`), 7 (a route test with a peer delta).*
4. **An upload the engine cannot read.** A UTF-16 file, a raw control character, invalid UTF-8, a CR with `rev: "3"`: each goes to the server (501 fallback), which answers as today (UTF-16 and `"3"` accepted, the others 422) — never an engine 422 with different wording, never a crash. A UTF-8 file with a BOM is read by the engine itself. *Tasks 2 (fixtures), 4, 5, 7.*
5. **Python `==` at the edges.** A file whose property is `1.0` where the model holds `1`, `true` where it holds `1`, `{"b":1,"a":2}` where it holds `{"a":2,"b":1}`: none is modified. `2**53 + 1` against `9007199254740992.0` is modified. A file with `1e999` is `inf` in the diff and `null` in the answer, as pydantic writes it. *Tasks 2 (fixtures), 3, 4.*

---

## File Structure

**Shell follow-ups (Task 1)**
- Modify: `frontend/src/lib/state/{replica.svelte,view.svelte}.ts`, `frontend/src/lib/components/TopBar.svelte`.
- Tests: `frontend/src/lib/state/__tests__/view-warnings.engine.test.ts`, `frontend/src/lib/components/__tests__/TopBar.test.ts`.

**Python goldens (Task 2)**
- Modify: `src/data_rover/core/model/change_request.py` (D8 only), `tests/golden/model_steps.py`, `tests/golden/scenarios/__init__.py`, `tests/model/test_apply_change_request.py`, `src/data_rover/api/README.md`, `architecture/program.md` (MR-3 rows).
- Create: `tests/golden/scenarios/{py_eq,change_request}.py`.
- Fixtures (generated): `engine/fixtures/golden/{py_eq,change_request}.json`.

**Engine (Tasks 3, 4, 5)**
- Create: `engine/src/value/eq.ts` (Task 3); `engine/src/cr/{read-file,diff,document,compare}.ts` (Task 4); `engine/src/cr/{overlay,propose,ops}.ts` (Task 5).
- Modify: `engine/src/value/parse.ts`, `engine/src/service/service.ts`, `engine/src/index.ts`, `engine/README.md`, `architecture/contracts.md`.
- Tests: `engine/test/value/eq.{golden.,}test.ts`; `engine/test/cr/{read-file,diff,compare.golden,overlay,propose,propose.golden}.test.ts`; `engine/test/service/cr.test.ts`; `engine/test/golden/model-steps.ts`.

**Bench (Task 6)**
- Create: `scripts/compare_large.py`.
- Modify: `pixi.toml`, `engine/bench/{run,parity-large}.ts`, `frontend/bench/{main,run,vite.config}.ts`.

**Frontend (Tasks 7, 8, 9)**
- Modify: `frontend/src/lib/api/{engine-route,changeRequest,types}.ts`, `frontend/src/lib/engine/{surfaces,seam,sync}.ts`, `frontend/src/lib/state/replica.svelte.ts`, `frontend/src/lib/components/ModelChangeDialog.svelte`, `frontend/src/lib/engine/README.md`, `frontend/README.md` if it describes the dialog.
- Tests: `frontend/src/lib/api/__tests__/compare-route.test.ts` (new), `frontend/src/lib/engine/__tests__/surfaces.test.ts`, any test building a map from `SURFACES`, `frontend/src/lib/components/__tests__/ModelChangeDialog.test.ts`.
- e2e (Task 9): create `frontend/e2e/eval-compare.spec.ts`.

**Documents:** `architecture/contracts.md` (CT-4: Tasks 4, 5), `architecture/program.md` (MR-3: Task 2; C's status: Task 9), `BACKLOG-ENGINE.md` (Task 9).

## Dependency order

```
Task 1 ─────────────────────────────────────────┐
Task 2 ──> Task 3 ──> Task 4 ──> Task 5 ─┬──────> Task 7 ──> Task 8 ──> Task 9
                                          └─> Task 6 (parallel with 7, 8) ──┘
```

- Task 1 is independent of 2–6 but precedes Task 7, which also edits `replica.svelte.ts`.
- Tasks 3, 4 and 5 each edit `engine/src/index.ts`, `engine/README.md` and `engine/test/golden/model-steps.ts`, and 4 and 5 edit `service.ts` and CT-4, so they run in order.
- Task 6 touches none of 7's or 8's files and can run in its own worktree beside them.

---

### Task 1: Plan 6a's follow-ups · `implementer`
*Reason: three small shell changes with their tests, fully specified by D11.*

**Files:** see File Structure, "Shell follow-ups".

**Interfaces:**
- Produces: `onViewsClosed(listener: () => void): () => void` in `replica.svelte.ts`.

- [ ] **Step 0: Baseline.** Run `pixi run dr-test` and `pixi run engine-parity-large`, and record the counts.
- [ ] **Step 1: Failing tests.**
  - In `view-warnings.engine.test.ts` (on `engineStore({surfaces: {views: 'engine'}})`, MSW `GET /views/{id}` returning a sentinel warning):
    - **Gate open, from `ready`:** a store opened with the follower loading shows the server's warnings, then the engine's once the gate opens, with one engine call.
    - **Gate open, from the follower's `onLoaded`:** the same through a follower load that ends after `ready`.
    - **Gate close:** with the engine's warnings shown, force the gate shut (`forceFailed` or a resync, or stop the follower) and see the server's sentinel warning replace them, with one `GET /views/{id}`.
  - In `TopBar.test.ts`: a `downloadModel` that rejects with `new Error('boom')` sets the notice to `Export failed: boom`; an `AbortError` sets none.
- [ ] **Step 2: See them fail** (the close test and the notice test; the two gate-open tests may pass already — say so, they pin existing behaviour).
- [ ] **Step 3: Implement D11.** Keep `replica.svelte.ts` free of any import of `view.svelte.ts`.
- [ ] **Step 4: See them pass.** Run `pixi run frontend-test` and `pixi run frontend-check`.
- [ ] **Step 5: README** (`frontend/README.md`, the view store's warnings: the server's again when the gate closes), **then commit** with the message `Hand view warnings back to the server when the engine gate closes`.

### Task 2: The `py_eq` and `change_request` golden families · `critical-implementer`
*Reason: the oracle every engine task replays, a fix in a frozen area, and route functions driven from the recorder with a pinned clock.*

**Files:** see File Structure, "Python goldens".

**Interfaces:**
- Produces:
  - `engine/fixtures/golden/py_eq.json`: `{"pairs": [{"a": tagged, "b": tagged, "eq": bool}, …]}`.
  - `engine/fixtures/golden/change_request.json`: runs holding `compare` and `apply_cr` steps (D7), `result` the response JSON or an error, `stage` as op lines.
  - `compare_step(file, created_at, stage=None, *, file_b64=None, fallback=False)` and `apply_cr_step(crs, created_at, stage=None, *, fallback=False)` builders in `model_steps.py`.

- [ ] **Step 1: The fix, test first.** Add a test to `tests/model/test_apply_change_request.py`: a CR listing one element id twice in `deleted` (and one relationship id twice) applies as one delete. See it fail with `KeyError`, apply D8, see it pass. Add a route test to `tests/api/test_apply_cr_route.py` that the same CR answers 200 with one `delete_element` op.
- [ ] **Step 2: `py_eq`** (`@scenario("py_eq")`). Build each pair's two sides from separate constructions (a function called twice), so no NaN object is shared. Record `a == b` for:
  - `True`/`1`/`1.0`, `False`/`0`/`-0.0`/`0.0`, `True`/`2`, `None`/`0`, `None`/`None`, `"1"`/`1`, `""`/`None`;
  - `2**53`/`float(2**53)`, `2**53 + 1`/`float(2**53)`, `2**64`/`float(2**64)`, `-(2**63)`/`float(-(2**63))`, `10**400`/`float('inf')`, `float('inf')`/`float('inf')`, `float('nan')`/`float('nan')`, `0.1 + 0.2`/`0.3`;
  - `"NaN"`/`float('nan')`, `"Infinity"`/`float('inf')` (the bare-constant strings);
  - `[1, 2]`/`[1.0, 2]`, `[1]`/`[1, 2]`, `[]`/`{}`, `{"a": 1, "b": [True]}`/`{"b": [1.0], "a": 1}`, `{"a": 1}`/`{"a": 1, "b": None}`, `{"a": 1}`/`[["a", 1]]`, nested three deep with reordered keys;
  - `"é"` precomposed against decomposed (unequal), `"𝄞"` against `"𝄞"` (equal).
- [ ] **Step 3: The recorder steps** (D7). Read `_over_stage`, `run()`'s error recording, and `routes/change_request.py`'s route functions first. Pin `_now_iso` to the step's `created_at` with `unittest.mock.patch` on the name the route module looks up. A 409 is a returned `JSONResponse`: record `{"status": 409, "body": <its JSON>}`.
- [ ] **Step 4: `change_request` scenario** (`@scenario("change_request")`), on smart-city through `batch` steps, seeded. Each case below is one step; the list is the minimum.
  - **Compare, shape refusals:** a top-level list; `elements: null`; `relationships: 5`; an element not an object; `id` absent; `type_name` a number; a `tmp_x` id; an abstract type; a duplicate element id; `properties: []`; `rev: true`; `rev: 1.5`; a relationship with `target_id` absent; a `tmp_` relationship id; an unknown source; an unknown target; a duplicate relationship id; a relationship `rev: "1"`. Order pins: an element with both a duplicate id and bad `properties` (the duplicate wins); a bad `elements[1]` and a bad `relationships[0]` (the element wins).
  - **Compare, tolerated:** unknown element and relationship types; extra keys at every level; an element and a relationship sharing an id; `properties: null`; absent `properties` and `rev`; a bigint `rev`; `relationships` absent; an array-index property key (`{"0": 1}`).
  - **Compare, equality and order:** each Review Focus 5 case; a rev-only difference (no change); a retype and a rewire (modified); added and modified in the file's order when it differs from the model's; deleted in the model's order; `1e999` (`inf` → `null`); bare `NaN` in a property (the string `"NaN"`).
  - **Compare, unreadable (`fallback: true`):** invalid JSON; a raw control character in a string; invalid UTF-8 (`file_b64`); UTF-16 (`file_b64`, Python accepts). **Not fallback:** a UTF-8 BOM (`file_b64`; both read it).
  - **Compare, staged:** one step with a `stage` of a rename, a delete and a create; the diff is against the working state; `model_rev` the committed rev.
  - **Apply-CR:** two CRs where the second modifies what the first added (answers ops); a conflict in each of the six buckets, with several conflicts in one CR and the first conflicting CR at index 1; a delete in CR 0 and a re-add in CR 1 (goes last); a delete and an identical re-add (vanishes); a rewire; a patch removing a key (`null`) and an empty patch (skipped); created relationships on created elements (temp ids); each gate error (unknown element type, abstract type, unknown relationship type, unknown source, unknown target, a deleted element with a surviving incident relationship, two such relationships to pin the code-point order); the retype; duplicate deletes (the fix); duplicate adds and duplicate modifies; a modify and delete of one id.
  - **Apply-CR, unreadable (`fallback: true`):** `crs: []`; 21 CRs; a wrong `format`; `rev: "3"` (pydantic accepts it; the engine sends it to the server); `properties: null`.
  - **Apply-CR, staged:** one step whose `stage` renames an element that the CR then modifies with a `before` equal to the staged state (answers ops), and one whose `before` is the committed state (conflict).
  - Assert in the generator that every conflict kind and every gate text appears at least once.
- [ ] **Step 5: Generate and check.** Run `pixi run golden-fixtures`, then `pixi run -e core-dev pytest tests/golden tests/model tests/api/test_apply_cr_route.py`. Read the fixtures and confirm the cases differ as intended. Paste the list of recorded error details in the hand-back.
- [ ] **Step 6: MR-3 rows** in `architecture/program.md`: the five areas of Global Constraints are frozen for behaviour from C's plan 6b on, and the duplicate-delete fix landed on both sides with a fixture. `src/data_rover/api/README.md`: duplicate ids in a CR's `deleted` are one delete.
- [ ] **Step 7: Tidy, then commit** with the message `Record the Python equality and change request golden families`.

### Task 3: `pyEq` in the engine · `implementer`
*Reason: a pure function fully specified by D1 and held by a value table.*

**Files:** `engine/src/value/eq.ts`, `engine/src/index.ts`, `engine/test/value/eq.test.ts`, `engine/test/value/eq.golden.test.ts`, `engine/README.md`.

**Interfaces:**
- Consumes: Task 2's `py_eq` fixture.
- Produces: `pyEq(a: Value, b: Value): boolean`, exported from `index.ts`.

- [ ] **Step 1: Failing tests.** `eq.golden.test.ts` replays every pair with `untag` (both orders: `pyEq(a, b)` and `pyEq(b, a)` equal `eq`). `eq.test.ts` adds: a dict with an own `__proto__` key; a 10,000-deep nested list (say whether recursion holds; if not, make it iterative); symmetric results for `bigint` against `PyFloat`.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement D1.**
- [ ] **Step 4: See them pass.** Run `pixi run engine-test` and `pixi run engine-check`.
- [ ] **Step 5: Docs** (`engine/README.md`, `src/value/`: `pyEq`), **tidy, then commit** with the message `Compare values as Python does in the engine`.

### Task 4: `compareModel` · `critical-implementer`
*Reason: byte-exact error texts and order, a new binary input, a scan with a cached parse across restarts, and a fallback boundary.*

**Files:**
- `engine/src/value/parse.ts`, `engine/src/cr/{read-file,diff,document,compare}.ts`, `engine/src/service/service.ts`, `engine/src/index.ts`;
- `engine/test/cr/{read-file,diff,compare.golden}.test.ts`, `engine/test/service/cr.test.ts`, `engine/test/golden/model-steps.ts`;
- `engine/README.md`, `architecture/contracts.md`.

**Interfaces:**
- Consumes: `pyEq` (Task 3); the `change_request` fixture's `compare` steps.
- Produces:
  - `ParseOptions.controlCharacters`;
  - `decodeModelFile`, `readModelFile`, `OtherModel` (D2);
  - `diffSteps`, `Diff`, `crDocument`, `crWire` (D3);
  - `compareSteps(wc, {file, created_at}): Steps<CompareAnswer>`, `CompareAnswer = {model_rev, cr, other_element_count, other_relationship_count}`;
  - the CT-4 method `compareModel {file, created_at}` (D4).

- [ ] **Step 1: Failing unit tests.**
  - **`read-file.test.ts`:** `decodeModelFile` strips one BOM and keeps a second; invalid UTF-8 and a lone surrogate byte sequence are 501 `reaches an unreadable file`; `parseExact(text, {controlCharacters: false})` refuses `"a\u0001b"` raw but accepts the escaped `"a\\u0001b"` and a tab between tokens; `readModelFile` answers each shape refusal of Task 2 Step 4 with its exact text (one `it.each` row per case, texts copied from the fixture).
  - **`diff.test.ts`:** over `smartCity()` staged through `workingCopy`: the order cases; the diff is against the WORKING state, so a staged-deleted element present in the file is added and a staged create absent from the file is deleted; a step visits at most 2,048 entities.
  - **Also in `diff.test.ts`:** key order of the document, E and R; `crWire(PyFloat(Infinity))` is `null`; a `bigint` leaves as `Number`.
- [ ] **Step 2: Failing golden replay** (`compare.golden.test.ts`). Teach `model-steps.ts` the `compare` step: bytes from `file` (UTF-8) or `file_b64`; drain `compareSteps(stagedReplica(...), {file, created_at})`; a `fallback: true` step expects `ReadError(501, 'reaches an unreadable file')`; otherwise compare `JSON.stringify` with `result` or the error with `error`. Add it to `READ_LIKE`. Run with the default hash and with `{hashKey: () => 0}`.
- [ ] **Step 3: Failing service tests** (`engine/test/service/cr.test.ts`, after `download.test.ts`).
  - `openReplica` over `smartCity()`, `callAs('c', 'compareModel', {file, created_at}, [file])`: the answer's keys in order; `model_rev` the replica's rev; `created_at` echoed as `createdAt`.
  - `file` not an `ArrayBuffer`, `created_at` absent: 422 at arrival.
  - **Review Focus 3.** Hold the scan with `fakeHost({tick})` after its first block and post a feed delta (control lane): one answer, over the new state, and the file parsed once (count calls through a spy on the exported `decodeModelFile`, or assert through timing-free means you choose and explain).
  - A cancel mid-scan gives no answer.
- [ ] **Step 4: See them fail.**
- [ ] **Step 5: Implement D2–D4.** Read `_snapshot.py:25-331` and `serialize.py:38-56` before `readModelFile`.
- [ ] **Step 6: See them pass.** Run `pixi run engine-test` and `pixi run engine-check`. A golden mismatch is an engine bug.
- [ ] **Step 7: Docs.** `engine/README.md`: a new `src/cr/` entry (the reader, the fallback, the diff, the document) and `parseExact`'s option under `src/value/`. CT-4: `compareModel`, its transferred input, its 501 and 422s, `created_at`.
- [ ] **Step 8: Tidy, then commit** with the message `Compare an uploaded model with the working copy in the engine`.

### Task 5: `proposeCr` · `critical-implementer`
*Reason: an overlay reproducing Python dict order, six conflict buckets, a gate and an op translation, all order-sensitive, over live working records.*

**Files:**
- `engine/src/cr/{overlay,propose,ops}.ts`, `engine/src/service/service.ts`, `engine/src/index.ts`;
- `engine/test/cr/{overlay,propose,propose.golden}.test.ts`, `engine/test/service/cr.test.ts`, `engine/test/golden/model-steps.ts`;
- `engine/README.md`, `architecture/contracts.md`.

**Interfaces:**
- Consumes: `pyEq`, `crDocument`, `crWire`, `Diff` (Tasks 3, 4); the fixture's `apply_cr` steps.
- Produces:
  - `CrOverlay` (D5);
  - `readCrs(raw): ChangeRequest[]`, `proposeSteps(wc, {crs, created_at}): Steps<ProposeAnswer>`, `ProposeAnswer = {model_rev, cr, ops} | {conflict: {cr_index, conflicts, model_rev}}`;
  - `opsForChange(diff): WireOp[]`;
  - the CT-4 method `proposeCr {crs, created_at}` (D6).

- [ ] **Step 1: Failing unit tests.**
  - **`overlay.test.ts`** (Review Focus 2): a random sequence of `set` / `delete` over ids drawn from a small working model and new ids, with a fixed seed from a hand-written LCG (no `Math.random`), checked after every operation against a reference that models a Python dict (a `Map` where `set` of a present key keeps its place and `delete` then `set` appends). `touched()` equals the reference's order restricted to touched ids; deleted ids come in `ord` order.
  - **`propose.test.ts`:** `readCrs` answers 501 `reaches an unreadable change request` for each Task 2 unreadable case and accepts a CR without `baseline` or `ops`; Phase A collects every conflict in bucket order; a modified entity's `rev` is the current rev + 1 (twice for a duplicate modify; `bigint` + 1 stays `bigint`); `opsForChange` numbers temp ids across both kinds and pairs each rewire; the patch puts changed keys in `after`'s order, then removed keys as `null`.
- [ ] **Step 2: Failing golden replay** (`propose.golden.test.ts`): the `apply_cr` step over `stagedReplica(...)`; `{conflict}` compared with the recorded `{status: 409, body}`'s body; a `fallback: true` step expects the 501; else `JSON.stringify` equality. Default hash and `{hashKey: () => 0}`.
- [ ] **Step 3: Failing service tests** (extend `engine/test/service/cr.test.ts`).
  - `proposeCr` answers ops; a conflict answers `{conflict}` as an ok result; a gate error is a 422 error answer.
  - **Review Focus 1.** Stage a rename of `a`; `compareModel` a file where `a` has another name and `b` is gone; `proposeCr` the answer's `cr` (through `JSON.parse(JSON.stringify(...))`, as the shell sends it); `stage` the answered ops with fresh temp ids; the working copy now equals the file (compare again: an empty diff).
  - The scan restarts on a control-lane transition and answers once; `wc.model` is unchanged after a `proposeCr` (its digest and `stagedDiff` equal before and after).
- [ ] **Step 4: See them fail.**
- [ ] **Step 5: Implement D5 and D6.** Read `core/model/change_request.py:103-273`, `routes/change_request.py:78-212` and `api/change_request_ops.py` before writing.
- [ ] **Step 6: See them pass.** Run `pixi run engine-test` and `pixi run engine-check`.
- [ ] **Step 7: Docs.** `engine/README.md` `src/cr/`: the overlay and its order, the phases, the gate, the ops. CT-4: `proposeCr`, the conflict answer, the 501, the 422s.
- [ ] **Step 8: Tidy, then commit** with the message `Propose change request ops over the working copy in the engine`.

### Task 6: Compare and apply-CR parity and bench at M · `implementer`
*Reason: an oracle script and bench rows following the download's pattern; numbers only.*

**Files:** `scripts/compare_large.py`, `pixi.toml`, `engine/bench/{run,parity-large}.ts`, `frontend/bench/{main,run,vite.config}.ts`.

**Interfaces:**
- Consumes: `compareSteps`, `proposeSteps` and the service methods (Tasks 4, 5).
- Produces: `benchmarks/large.compare.model.json`, `benchmarks/large.compare.json` (the `CompareResponse`, `createdAt` pinned to `2026-01-01T00:00:00.000Z`) and `benchmarks/large.apply-cr.json` (the `ProposeCrResponse` of `[that cr]`), written by the new pixi task `engine-compare-oracle`, a dependency of `engine-parity-large`, `engine-bench` and `engine-bench-browser`.

- [ ] **Step 1: The oracle.** `scripts/compare_large.py` loads M with `download_large.py`'s loader (import it), derives the other file deterministically over the raw document in `issues_large.Violations`' style: every 50th element renamed, every 97th element with a property removed, every 200th leaf element deleted with its relationships, every 300th relationship deleted, 500 new elements and 200 new relationships among them; writes it; then calls the compare route function (as Task 2's recorder does, the clock pinned) and writes its JSON; then the apply-cr route function over `[the answer's cr]` as JSON, and writes its JSON. Print the three sizes and the diff's counts.
- [ ] **Step 2: Parity.** In `parity-large.ts`, after the download: `compareSteps` over the working copy with the derived file equals `large.compare.json` (`JSON.stringify` of the engine answer against `JSON.stringify(JSON.parse(oracle))`), then `proposeSteps` with `[cr]` sent through `JSON.parse(JSON.stringify(...))` equals `large.apply-cr.json`. Print `compare equal (…)` and `apply-cr equal (… ops)`; on failure print the first differing path.
- [ ] **Step 3: Bench rows** in `run.ts`: `compareParse` (the decode + parse + shape block), `compare` (total), `compareLongest` (longest step after the parse block), `comparePeakHeapMb` (the parsed file beside the replica, `steppedExport`'s heap sampling), `applyCr` and `applyCrLongest`. Record every row on every pass.
- [ ] **Step 4: Browser rows** in `frontend/bench/main.ts`, before the final delta: `timed('compareModel', …)` (the file fetched from a new `DATA` entry `/data/compare.json`, transferred) and `timed('proposeCr', …)`, each with `ping`'s longest slice. Add the input check to `frontend/bench/run.ts`.
- [ ] **Step 5: Run.** Run `pixi run engine-parity-large`, `pixi run engine-bench` and `pixi run engine-bench-browser`. Paste the medians (host, date), the parity lines and the parsed file's heap beside CN-3's 400 MB in the hand-back, for the owner. Optimize nothing.
- [ ] **Step 6: Tidy, then commit** with the message `Measure compare and apply-CR at M and hold them to the oracle`.

### Task 7: The shell — the `compare` surface · `critical-implementer`
*Reason: routing with a new transfer path through three layers, two fallbacks, a digest shadow, and a result-shape change on the conflict path.*

**Files:**
- `frontend/src/lib/api/{engine-route,changeRequest,types}.ts`, `frontend/src/lib/engine/{surfaces,seam,sync}.ts`, `frontend/src/lib/state/replica.svelte.ts`;
- tests: `frontend/src/lib/api/__tests__/compare-route.test.ts` (new), `frontend/src/lib/engine/__tests__/surfaces.test.ts`, any test building a map from `SURFACES`, a `sync` or `seam` test for the transfer;
- `frontend/src/lib/engine/README.md`.

**Interfaces:**
- Consumes: Tasks 4 and 5's methods; Task 1's `replica.svelte.ts`.
- Produces: the `compare` surface (default `server`, `STAGED_ONLY`, the `issues` gate); `EngineCall`'s `transfer`; `compareModel(file, cfg?)` and `proposeCr(crs, cfg?)` routed; `EngineCompareSchema`, `EngineProposeSchema`.

- [ ] **Step 1: Failing tests.**
  - **`surfaces.test.ts`:** `compare` joins the lists and `STAGED_ONLY`; default `server`.
  - **Transfer:** a `ReplicaSync.call` with `transfer: [buf]` leaves `buf` detached (`byteLength === 0`) after the post.
  - **`compare-route.test.ts`** on `issuesEngine(made, {surfaces: {compare: side}, shadow})`, with MSW `POST /model/compare` and `/model/apply-cr` answering bodies rendered from the engine's own answers (so the pair is equal) and counting requests:
    - engine mode: `compareModel(file)` answers the engine's CompareOut and makes no request; `proposeCr` answers `{ok: true, …}`; a CR that conflicts answers `{ok: false, crIndex, conflicts, modelRev}` from the engine;
    - server mode: only the server is asked;
    - a UTF-16 file and a CR with `rev: "3"`: the server answers (Review Focus 4), unmarked;
    - **Review Focus 3:** after a peer's delta moves the replica's rev, the engine's `modelRev` is the new committed rev, and `stageProposedOps` with the earlier answer's rev refuses `stale`;
    - the engine gone: the server answers;
    - **the shadow:** nothing staged and equal bodies, no report even though `createdAt` differs; a one-field difference in `cr.ops` reports one `[shadow] compare compareModel` line; a conflict list differing in one reason reports on `proposeCr`; with a staged edit, no comparison.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement D9.** Grep every `EngineCall` implementation and caller (`grep -rn "EngineCall\|seam.call\|sync.call" frontend/src`) and keep them compiling. Zod: `EngineCompareSchema` is `CompareOutSchema`; `EngineProposeSchema` is `z.union([ProposeCrOutSchema, z.object({conflict: ProposeCrConflictSchema})])`.
- [ ] **Step 4: See them pass.** Run `pixi run frontend-test` and `pixi run frontend-check`.
- [ ] **Step 5: README** (`frontend/src/lib/engine/README.md`: the surface, its gate, the transfer, the two fallbacks, the masked `createdAt`, the conflict as a result), **then commit** with the message `Route compare and apply-CR through the engine behind a switch`.

### Task 8: `ModelChangeDialog` in engine mode · `implementer`
*Reason: gating and a notice in one component, fully specified by D10, with component tests.*

**Files:** `frontend/src/lib/components/ModelChangeDialog.svelte`, `frontend/src/lib/components/__tests__/ModelChangeDialog.test.ts`, `frontend/README.md` if it describes the dialog.

**Interfaces:**
- Consumes: `engineSide('compare')` and the routed functions (Task 7).

- [ ] **Step 1: Failing tests** (extend `ModelChangeDialog.test.ts`; mock `engineSide` through the module the component imports it from, or install a seam stub with `installEngineSeam`, whichever the file's style allows):
  - engine mode, `hasStagedOps` true: Replace is enabled, no `mcd-gate-hint`, and Preview shows `Includes staged changes`;
  - server mode, `hasStagedOps` true: Replace disabled with `Commit or discard your staged edits first.` (today's test, kept);
  - engine mode: Preview then Replace calls `compareModel` twice (no cache);
  - Replace in engine mode passes `res.modelRev` and `crPrestate(res.cr)` to `stageProposedOps` exactly as in server mode (the working-copy images reach the prestate).
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement D10.**
- [ ] **Step 4: See them pass.** Run `pixi run frontend-test` and `pixi run frontend-check`.
- [ ] **Step 5: Commit** with the message `Let Replace stage over staged edits when compare runs in the engine`.

### Task 9: e2e, the flip, the documents · `implementer`
*Reason: an e2e spec in the existing style, a one-line default and documents.*

**Files:** `frontend/e2e/eval-compare.spec.ts`, `frontend/src/lib/engine/surfaces.ts`, `frontend/src/lib/engine/__tests__/surfaces.test.ts`, `architecture/program.md`, `BACKLOG-ENGINE.md`, the READMEs touched above.

- [ ] **Step 1: The spec** (`eval-compare.spec.ts`, serial, `for (const side of ['engine', 'server'])` wrapping a `describe`, `bootstrap` as `eval-download-views.spec.ts` does with `{compare: side}`). The other file is built in the test: fetch the server's `/model/download`, rename one element, delete one leaf element, add one element, and hand it to the dialog's file input with `setInputFiles({name, mimeType, buffer})`.
  1. **Nothing staged.** Open "Compare…", pick the file, Preview: the preview lists one added, one modified, one deleted element. Replace: the staged change count equals the answer's op count; discard.
  2. **An edit staged.** Stage a property edit on another element, open the dialog, pick the file:
     - engine side: Preview shows `Includes staged changes`; Replace is enabled and stages; the staged state then has the file's names (check the renamed element in the tree or inspector);
     - server side: Replace is disabled with the gate hint.
  3. **Apply CR.** Save a CR with Create CR (the save picker removed, as `bootstrap` does), then open "Apply CR…" with it and Preview: the same counts.
- [ ] **Step 2: Run e2e.** The whole suite must be green except known failures (name them), with no `[shadow]` lines.
- [ ] **Step 3: The flip.** Set `SURFACE_DEFAULTS.compare = 'engine'`, update `surfaces.test.ts`, keep the server-side `describe` forcing `server`. Run `pixi run frontend-test` and the e2e suite again.
- [ ] **Step 4: Documents.**
  - **`architecture/program.md`,** C's status: plan 6b is built, so plans 1–7 of 8 are; record what it delivers and Task 6's numbers with their date and host.
  - **`BACKLOG-ENGINE.md`:** `K-92` if compare's parse block or apply-CR's longest step misses the 16 ms slice bound or the parsed file's heap is large beside CN-3's 400 MB (say which, with the number); `K-93`, a CR crosses the frontend as parsed JSON, so an integral float in an added or modified entity stages as an int on both paths (the file's `1.0` becomes `1`); any other item the tasks opened.
  - **READMEs:** make sure they say what is now true.
- [ ] **Step 5: Final verification.** Run each of these and record the results in the hand-back:
  - `pixi run dr-test`;
  - `pixi run dr-tidy`;
  - `pixi run engine-check`;
  - `pixi run frontend-check`;
  - `pixi run sandbox-check`;
  - `pixi run engine-parity-large`;
  - e2e.
- [ ] **Step 6: Commit** with the message `Default compare and apply-CR to the engine`. Then stop: `engine-migration` is fast-forwarded only with the owner's go-ahead.
