# Evaluation, plan 7: metamodel candidate — design

Refines §6 "Metamodel candidate" of `2026-09-24-evaluation-design.md` (the binding program-level
spec for C) for its seventh plan. Where this document is silent, that spec holds. Approved in
conversation with the owner on 2026-09-28. Plan 7 is built before plan 6: it depends on plans 2
and 3 only, and nothing in plan 6 (`src/cr/`, `src/view/`, download) depends on it.

## Goal

The metamodel editor's "Preview changes" (`diffMetamodel`) and the commit preview of a staged
`metamodel.rebind` are answered by the replica, over the working copy — staged model edits and
staged rules included, where today the server answers from committed state. Both sit behind a
`metamodel` surface switch with the server as fallback (MR-1) and the dev shadow clean in e2e
(MR-2). The rule "a batch with a rebind sends the whole preview to the server" goes. The
candidate scan at M is measured — total, longest step, extra heap — in Node and Chromium and
reported to the owner before anything is optimized.

## Non-goals

- The structural half (`diff_metamodels`): it stays on the server, not frozen, not ported.
- Capping or paging `now_failing` / `now_passing`: uncapped, as the server answers today.
- Changing who may call what: lint stays owner-only, the rebind preview owner-gated, the diff
  route viewer-accessible.
- Plan 6's surfaces (`compare`, `download`, `views`).
- Optimizing anything before the owner has seen the numbers.

## What the code says today

- **`POST /metamodel/lint`** (`api/routes/metamodel_swap.py`): the body is the candidate, YAML
  or JSON by content type (`_read_metamodel_blob`); `load_metamodel_str` parses and checks it.
  Always 200, `{ok, errors: [{message, line?, column?}]}`; a YAML error carries 1-based
  positions, a `ValueError` or `MetamodelError` the message only. A valid candidate answers
  `{ok: true}` and the parsed `Metamodel` is dropped. No session; not in the read-only-POST
  allowlist, so a viewer is refused 403.
- **`POST /metamodel/diff`**: a bad candidate is 422. `diff_metamodels(current, candidate)`
  gives `structural`. Under the write mutex, the current side is the session's issue store
  (`_ensure_validation_seeded(...).all_issues()`), the candidate side
  `candidate_pipeline(session, candidate).validate(build_rebind_view(model, candidate))` — the
  session's rule sources recompiled under the candidate, a drifted rule skipped whole.
  `_issue_key` is `(category, severity, check, message, tuple(sorted(target_ids)))`; both sides
  go through a dict (the last duplicate wins, at the first one's position); `now_failing` is in
  candidate pipeline order, `now_passing` in issue-store order, `unchanged_count` counts distinct
  shared keys, and `current_error_count` / `candidate_error_count` are raw list lengths,
  warnings included. No cap, no paging. Viewers may call it.
- **`build_rebind_view`** (`core/model/model.py`): a `Model(candidate)` aliasing the live
  `elements` and `relationships`, with a fresh `IndexSet.rebuild()` — containment parents under
  the candidate's flags, uniqueness groups under its key specs, the per-type caches cleared.
- **Python pipeline order:** a whole-model `validate` runs every element (validators in order),
  then every relationship, then each validator's global hook over the whole scope.
- **Rebind preview** (`routes/commits.py`): at most one rebind per batch, owner only. The
  session's metamodel is swapped in place, the batch applied in hoisted order (the rebind
  first), the whole model validated by `candidate_pipeline`, then everything rolled back.
  `structural_blockers` are the STRUCTURAL issues, `conformance_error_count` counts the
  CONFORMANCE ones, `issues` holds all; `would_block` is false for a rebind batch.
- **Engine:** `Metamodel.fromJSON` is pure and cheap to call twice. Containment parents
  (`ElementRec.parents`) and uniqueness buckets (`ElementRec.uniq`, `IndexSet.buckets`,
  `uniqKey`, `uniqGroupOf`) live on the shared records and read `model.metamodel`.
  `validateScoped` throws unless the validators' metamodel is the model's. `Containment` reads
  `el.parents`, `Uniqueness` the model's buckets, and the rules' `evaluateRelationship`
  `model.metamodel`; the other validators read their own `mm`. `issueKey` does not sort
  `targetIds`. No dispatcher method waits for the issue store and then scans.
- **Frontend:** `diffMetamodel` and `lintMetamodel` (`lib/api/metamodel.ts`) are plain
  `apiFetch`es; the only caller is `state/metamodel-editor.svelte.ts`. `previewStaged` →
  `lib/api/checkout.ts` returns `serverPreview(ops)` for any batch with a rebind.
- **Fixtures:** no golden family, oracle task or e2e spec covers the candidate diff or the
  rebind preview.

## 1. Server

- **`POST /metamodel/lint`:** when `ok`, the response gains `document`: the candidate
  `Metamodel` serialized exactly as `GET /metamodel` serializes it (same model, same settings).
  `null` when `ok` is false. Errors, positions, status and access are unchanged.
- **`POST /metamodel/structural-diff`** (new): the candidate body as `/metamodel/diff` reads it,
  422 on a bad candidate, answering `MetamodelStructuralDiff` only — `diff_metamodels` outside
  the mutex, no session model touched. Owner-only, as lint. Engine mode calls it instead of
  `/metamodel/diff`, so a preview costs the server no model sweep.
- **`POST /metamodel/diff`** and the rebind preview in `commits.py`: unchanged, frozen, the
  `metamodel` surface's server path.

## 2. Engine

### Structure — `engine/src/validation/structure.ts`

- `interface Structure { metamodel; parentsOf(el): readonly RelRec[]; groupOf(el): readonly
  ElementRec[] | null; keyOf(el): string }` — `groupOf` is `null` for an element alone in its
  group.
- **`LiveStructure`** adapts the model's `IndexSet` and record fields; it answers what the
  validators read today. The model holds one.
- **The key function** leaves `IndexSet.freshKey` / `relEndpoints` for `model/uniq-key.ts`, a
  function of `(metamodel, parentsOf, element)` with a per-call key-spec cache. `IndexSet` calls
  it with the live metamodel and `el.parents`; behaviour and texts unchanged.
- **`CandidateStructure`**, built by resumable steps:
  1. relationships in `ord` order, those whose type the candidate flags containment filling
     `parents: Map<ElementRec, RelRec[]>` in the order `onRelationshipCreated` would;
  2. elements in state order, keyed by the key function over `(candidate, parentsOf)` and
     bucketed;
  3. singletons dropped: only groups of two or more stay.

  Steps of 2,048 records, tuned to the measured step. By-type and adjacency are the model's.

### Pipeline

- `Run` gains `structure`. `validateScoped(model, ids, v, p, rules, structure =
  model.structure)` guards on `v.metamodel === structure.metamodel && p.metamodel ===
  structure.metamodel`.
- `Containment` reads `run.structure.parentsOf`; `Uniqueness` reads `groupOf` and `keyOf`; the
  rules' `evaluateRelationship` reads `run.structure.metamodel`. Live output is unchanged; the
  validation goldens and the M parity run hold it.
- `validateScoped` can return entity-hook issues and each validator's global-hook issues
  separately, so a caller slicing a whole-model run concatenates them in the Python order
  (every entity, then each global over the whole scope). Both global hooks answer per scoped id
  in scope order, so a global run over the union of slices equals its runs over the slices
  concatenated.

### Candidate scan — `engine/src/validation/candidate.ts`

- **Before the first step:** `Metamodel.fromJSON(document)` (422 with its message);
  `FacetPatterns(candidate)` (501 `reaches an unsupported pattern` when unusable);
  `compileRuleSets(ruleSources(artifacts, 'working'), candidate)` (501 when unreadable, as
  `live()`). Drifted rules land in `skipped`.
- **Steps:** build the `CandidateStructure`; validate the working copy's elements then
  relationships in state order, 512 ids a step, with the candidate `Validators` and rules;
  append each slice's global issues to per-validator buffers; at the end, entity issues then the
  global buffers in validator order.
- **Diff** (`candidateIssues` only): `candidateKey` in `validation/issue.ts` — `issueKey` with
  `targetIds` sorted. Both sides into insertion-ordered maps, the last duplicate winning at the
  first one's position. The current side is the live store's issues in `iter()` order.
  `now_failing` in candidate order, `now_passing` in store order, `unchanged_count` the shared
  distinct keys, the two counts raw lengths.
- **Answer:** `{now_failing, now_passing, unchanged_count, current_error_count,
  candidate_error_count, skipped}`, issues in `IssueOut` shape. Plain JSON, nothing transferred.

### Dispatch (CT-4)

- **`candidateIssues {metamodel}`**, `metamodel` the document as `open` takes it. A new method
  kind: parse and compile at arrival; wait for the live store to be settled (409 not-ready while
  unseeded, as issue reads); then submit a model-lane scan. `run()` re-reads `this.live()` on
  every start, so a scan re-queued by a control-lane transition rebuilds from scratch; model-lane
  transitions queue behind it, so the working copy does not move mid-scan. `{cancel}` drops it.
- **`previewCommit {…, rebind: {metamodel}}`**: the model half runs the candidate scan's
  validation (no diff) over the working copy, which already holds the staged model ops — the
  server's hoisted order, the rebind first. `structural_blockers` are the STRUCTURAL issues,
  `conformance_error_count` counts the CONFORMANCE ones, `issues` holds all, `would_block` is
  false. Same refusals as `candidateIssues`.

## 3. Frontend

- **Surface `metamodel`:** added to `Surface`, `SURFACES` and `SURFACE_DEFAULTS`; not in
  `READ_SURFACES`. Gated in `installSeam()` as `issues` is: engine staging, seeded, follower
  loaded. Defaults to `server` until the plan's last task flips it to `engine`, once the shadow
  is clean.
- **`diffMetamodel(body)`** through `route('metamodel', …)`, keeping its name. The engine call:
  `lintMetamodel(body)` (not `ok` → the same "invalid candidate" failure the 422 gives); then,
  in parallel, `candidateIssues {metamodel: document}` and `POST /metamodel/structural-diff`,
  joined into `MetamodelDiff`. The server call is today's `/metamodel/diff`. 501s go to the
  server unmarked; 409 not-ready and `gone` go to the server.
- **Staged rebind preview** (`lib/api/checkout.ts`): the early return goes. With a rebind and
  staging on the engine, the rebind's `blob` is linted and the model half is `previewCommit
  {…, rebind: {metamodel: document}}` under `route('metamodel', …)`; the non-model rest
  (`metamodel.move_node`, artifact and view ops) goes to the server alone and is merged by
  `mergePreviews`, as today. The server path, and the answer to a lint failure, is today's
  whole-batch server preview.
- **Shadow:** `shadow: 'unstaged'`. `present('metamodel', …)` sorts `now_failing` and
  `now_passing` by the diff key, as `issues` does; counts and `structural` compare exactly.
- **UI:** `MetamodelPreviewPanel` shows "Includes staged changes" while the `metamodel` surface
  is `engine` and the replica holds staged model ops or staged artifacts. Nothing else changes.

## 4. Oracle, tests, gate

- **Golden family `metamodel_candidate`** (`tests/golden/scenarios/`): steps call the diff
  route's model half — `candidate_pipeline` over `build_rebind_view`, keyed as the route keys —
  on smart-city, with no frozen route changed. Candidates:
  1. a new required property;
  2. containment turned on for an existing relationship type (new parents, a cycle, an element
     with two parents);
  3. a changed element key (duplicate groups merge and split);
  4. an element type removed (unknown-type issues, a drifted rule);
  5. a tightened facet pattern;
  6. the identical metamodel.

  Recorded: the full response, the lint `document`, and for 2 and 4 a staged batch's rebind
  preview. Replayed with staged model ops and a staged rule set as well. The engine matches
  `now_failing` in order and counts exactly; `now_passing` as a key-sorted list, since the two
  stores' orders depend on their own histories.
- **Engine tests:** `CandidateStructure` built under the live metamodel equals `LiveStructure`
  for every element (parents, group, key); the sliced run equals an unsliced `validateScoped`;
  the refusals; a cancelled and a re-queued scan; the existing validation goldens unchanged.
- **Python tests:** lint's `document` equals `GET /metamodel`'s body after a rebind to the same
  blob; `structural-diff` equals `/metamodel/diff`'s `structural`; its 422 and its owner-only
  refusal.
- **Frontend tests** (in-process engine, MSW for the server): `diffMetamodel` in engine mode
  joins both halves; a 501 and a lint failure fall back; the staged-rebind local preview and
  its merge with the rest; the staged-changes note; the shadow catches a one-issue difference.
  The tests pinning "a rebind is the server's whole" are updated.
- **Parity at M:** the bench-data script writes a candidate derived from the M metamodel (one
  containment flag flipped, one key added, one required property added); a new
  `engine-parity-oracle-candidate` task writes the Python diff for it to `benchmarks/`;
  `engine-parity-large` compares the engine's answer as the goldens do.
- **Bench** (`engine-bench`, `engine-bench-browser`, medians of 3): `candidateIssues` at M —
  total, longest step, and extra heap above the settled baseline, sampled per step as the export
  rows are. No budget; reported to the owner.
- **e2e** (`eval-metamodel.spec.ts`, engine mode, shadow on): Preview changes with nothing
  staged and with a staged edit (the note shows); a DiffDrawer preview of a staged rebind.

## 5. Freeze and documents

- **Freeze during the build:** the diff route's model half and `build_rebind_view` (row 7);
  plans 1–5's areas, `core/model`, `core/metamodel` and the applier stay frozen.
  `diff_metamodels` is not frozen.
- **CT-4:** `candidateIssues`, `previewCommit`'s `rebind` param.
- **`program.md`:** C's status (plan 7 built before 6, and why); MR-3 gains row 7.
- **READMEs:** `engine/README.md` (`Structure`, the candidate scan, the method);
  `frontend/src/lib/engine/README.md` (the `metamodel` surface, the rebind rule);
  `src/data_rover/api/README.md` (lint's `document`, `structural-diff`).
- **`BACKLOG-ENGINE.md`:** the server's `/metamodel/diff` stays O(model) under the write mutex
  and viewer-accessible until F.

## Done when

- `metamodel` defaults to the engine with the shadow clean in e2e; the server path works behind
  the switch.
- `metamodel_candidate` passes; `engine-parity-large` shows the candidate diff at M equal.
- `pixi run dr-test`, `dr-tidy`, `engine-check`, `frontend-check`, `sandbox-check` and
  `engine-parity-large` are green; e2e shows no `[shadow]` lines.
- Bench numbers are reported to the owner.
- `architecture/`, the READMEs and the backlog say what is now true.
- `engine-migration` is fast-forwarded only with the owner's go-ahead.
