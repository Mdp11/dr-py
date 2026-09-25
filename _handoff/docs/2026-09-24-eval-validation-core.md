# Validation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine keeps one live issue store over the working copy — a resumable background sweep once the replica is `ready`, incremental revalidation inside every transition, origins by a rewind probe — and answers `getModelIssues`, `validateModel` and the model half of `previewCommit` as the server's routes answer them, behind a new `issues` surface that defaults to the engine once shadow comparison is clean.

**Architecture:** Plan 2 of 8 for sub-project C (`architecture/program.md`). Bottom-up: (1) a port of the six validators and the scoped pipeline, held to a fixture; (2) the dirty sets — the Python hooks fired from the engine's applier, and a neighbourhood rule for rebases — and the issue store, held to the oracle's `_finalize`; (3) `LiveIssues`, which wraps the working copy: the sweep in steps, revalidation per transition, the origin probe, and the three answer bodies; (4) the service: a resumable scheduler slot, the three methods, `issues_version` on `changed`, the refusals, and the sweep benchmark; (5) the shell: the `issues` surface, the sweep gate, the refetch on `issues_version`, and the split preview; (6) the flip, e2e and the documents.

**Tech Stack:** TypeScript 6 (`strict`, erasable syntax, `lib: ["ES2023"]`, no DOM or Node in `engine/src/`), vitest 3, Svelte 5 runes, zod, MSW, Playwright; Python 3.14 (FastAPI, pydantic v2, pytest, ruff); pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-24-evaluation-design.md`. This plan covers §3 without `### Rules`, §2's shadow rules for issues and the preview, §7's plan-2 families and the sweep gate, and §8's plan-2 freeze row. §9 lists the `architecture/` edits that ride with the code. Read first: `architecture/contracts.md` (CT-4, CT-5), `architecture/decisions.md` (AD-8, AD-23, AD-28, AD-29, AD-30, AD-31), `architecture/program.md` (MR-1…MR-4), `architecture/conventions.md`. Then `src/data_rover/core/README.md` (the validation pipeline), `engine/README.md` (`src/steps/`, `src/working/`, `src/ops/`, `src/service/`, golden fixtures), `frontend/src/lib/engine/README.md` (sync, surfaces, seam, shadow) and plan 1 (`docs/superpowers/plans/2026-09-24-eval-artifacts-navigation-search.md`) for the idioms this plan reuses.

**What kind of plan this is.** It gives direction with specifics, as plan 1 did: interfaces, signatures, the test cases and what each asserts, the order, and a full account of the mechanisms that are easy to get wrong. It holds no full code. The expected results of the "see it fail" steps are reasoned from the code, not observed. If one does not appear, trust the run, read the step's intent, and say so in the hand-back. What WAS checked while planning is listed next, each with how.

## What planning found

Facts the plan rests on, checked against the code at `f7c7136` or with throwaway probes (Python 3.14 through `pixi run -e core-dev`, `PYTHONPATH=src`).

1. **The pipeline's order and stamping.** The validators run as `TypeConformance, Multiplicity, Facets, EndpointTyping, Containment, Uniqueness`. A scoped run visits `scope.ids` in insertion order: an element id runs every `validate_element`, a relationship id every `validate_relationship`, and an id that resolves to nothing is skipped. After the entities, each validator's `validate_global` runs, in validator order. `_stamped` sets `check` to the validator's `check_name` where it is empty. *Read:* `core/validation/pipeline.py:320-375`, `:388-395`.
2. **Every built-in issue is an ERROR.** Only three are STRUCTURAL: a dangling reference, a second containment parent, and a containment cycle. Only rules and view warnings can produce warnings. *Read:* every validator file.
3. **The message texts.** *Probe (`scratchpad/probe_msgs*.py`), messages as rendered:*
   - `Blk.n: value 1.0 is not a valid integer`: a float fails `integer`.
   - `n: -3 below min 0.0`, `f: 2.5 above max 2.0`, `n: 100000000000000000000 above max 10.0`, `f: 1e+20 above max 2.0`.
     - The value goes through `str()`.
     - The bound is always a float: `PropertyDef.min` / `max` are `float | None`, so a YAML `5` is `5.0` (probe: `PropertyDef(min=5).min == 5.0`, `min=True` gives `1.0`).
   - `code: 'abcd' does not match pattern '[A-Z]+'`. This is `re.fullmatch`.
   - `code: length 4 exceeds max_length 3`. The length is counted in code points.
   - `Blk.c: value 'blue' is not a valid Color`, `Blk.b: value 1 is not a valid boolean`, `Doc.v: value True is not a valid float`.
   - `Blk.ref: reference 'nope' points to no element` (STRUCTURAL), `Blk.ref: value 5 is not a valid Blk reference`.
   - `R: element e-8 has 0 target(s), violates target multiplicity '1..*'`, `R.lbl: 0 value(s) violates multiplicity '1'`.
   - `M: (P, P) matches no declared (source, target) mapping`. An endpoint that does not exist renders as `None` and counts as conforming.
   - `Element e-8 has 2 containment parents (must have at most one)`, `Containment cycle detected involving element e-8`.
   - `e-10 is an instance of unknown type 'Gad'`. This returns early, before any property check. *Probe:* the metamodel lookups answer `[]` / `None` / `False` for an unknown type, so multiplicity still reports on such an element.
   - `Duplicate K element e-2: matches e-1 (a=('x',), b="it's")`, `(a=(), …)`, `(a=None, …)`, `(v=0.1, out:Lnk→[e-15])`, `(no key — all properties match)`.
     - The descriptor's values are `repr` of the FROZEN value (`core/model/indexes.py:77-83`). A list becomes a tuple, a dict a tuple of `(key, value)` pairs sorted by key, and a missing key `None`.
     - The endpoint list is sorted, by exact relationship type.
     - The em dash is U+2014 and the arrow U+2192.
4. **Enum membership is string equality.** `Metamodel.enums` is `dict[str, list[str]]`, so Python's `value in enum` is true only for a `str` member. `True in ['a', 1]` would be true, but enums hold strings only. *Read:* `core/metamodel/schema.py:364`.
5. **A `date` is `datetime.date.fromisoformat`.** *Probe:*
   - Accepted: `2024-01-01`, `20240101`, `2024-W01`, `2024-W01-1`, `2024W011`, `2024W01`, `0001-01-01`, `9999-12-31`, and `2020-W53-7` (which is 2021-01-03).
   - Refused: `2024-001` (ordinal), `2024-1-1`, `２０２４-01-01`, `2024-01-01 `, `2024-02-30`, `0000-01-01`, `2024-01-01T00:00`, `+2024-01-01`, `2024-W53` (2024 has 52 weeks), `2024-W00-1`, `2024-W01-8`, `2024-01`, `202401`, `2024-0101`.
6. **Uniqueness reads the index.** The primary of a group is its member with the least `element_order`, which is the engine's `ord`.
   - A scoped run reports each scoped id that sits in a group of two or more and is not the primary. The descriptor is built from the id's OWN key.
   - Python groups by `==`, so keyless elements with `v=1`, `v=1.0` and `v=True` share a group (probe).
   - *Read:* `validators/uniqueness.py:294-340`.
7. **Containment in a scoped run** walks each scoped element's first-parent chain and reports every element whose chain reaches a cycle. A full run reports ONE representative and stops, and the server's own sweep never makes a full run. *Read:* `validators/containment.py`, `api/validation_sweep.py:24-27`.
8. **The server's sweep is scoped chunks through `replace`.** It snapshots `elements keys + relationships keys` once. For each chunk of 2,000 ids, under the write mutex, it runs `pipeline.validate(model, Scope(chunk))` and `state.replace(chunk, issues)`. An entity deleted since the snapshot is skipped. Edits and the sweep interleave, and whichever runs second for an entity recomputes it. *Read:* `api/validation_sweep.py:89-128`.
9. **The dirty hooks, op by op.** They are fired through `DirtyCollector`'s wrappers inside `_apply_one` (`api/routes/ops.py:309-519`, `core/validation/dirty.py:99-287`).
   - `create_element`: `after_element_create` adds the id, the sorted group, then the sorted referencers. Then, per property key, the element, its OLD group and its NEW group.
   - `update_element`: per patch key, the element, OLD group and NEW group.
   - `delete_element`: before the cascade, for each closure element: the element; each sorted outgoing relationship with its target; each sorted incoming relationship with its source; the sorted referencers; the sorted group.
   - `create_relationship`: source and target, the target's OLD group if the type is containment, then the relationship and the target's NEW group if containment. Then the relationship id once per property key.
   - `update_relationship`: the relationship id once per key.
   - `delete_relationship`: the relationship, source, target and the target's OLD group if containment, then its NEW group if containment.
   - An `id` hint and restore mode change only which id is used. Sets are `sorted()` by code point.
   - *Probe (`probe_api.py`):* a cascade delete of `e-1` gave `['e-1','e-4','e-2','e-5','e-3']`.
   - The engine applier writes a create's properties one key at a time through `model.setProperty` (`engine/src/ops/apply.ts:118-128`), so the same hook points exist.
10. **`_finalize`** (`ops.py:630-675`): `expand_dirty` (a no-op with no rules), then a scoped validation of `res.dirty` with a fresh pipeline, then `state.replace(res.dirty.ids, scoped)`.
    - `replace` pops each dirty owner in order and appends the new issues under their owners. A new owner lands at the END.
    - `counts()` is `{severity: n}` in first-seen order, and `{}` when the store is empty.
11. **`GET /model/issues`** answers `{model_rev, issues, counts, truncated, rules_status}`.
    - Issues come in store order (owners in insertion order), capped at 5,000; `truncated` is true past it, and `counts` stays exact.
    - Every `origin` is `on_server`. `rules_status` is `{total, skipped, eval_errors}`; with no rules it is `{"total":0,"skipped":[],"eval_errors":{}}`.
    - An issue is `{severity, message, target_ids, category, check, origin}`.
    - *Probe (exact body):* `{"model_rev":6,"issues":[{"severity":"error","message":"n: 9 above max 5.0","target_ids":["e-5"],"category":"conformance","check":"facets","origin":"on_server"},…],"counts":{"error":2},"truncated":false,"rules_status":{"total":0,"skipped":[],"eval_errors":{}}}`.
12. **`POST /model/validate`** (`routes/validation.py:132-228`).
    - With `ops`, it applies them, expands, validates the dirty scope and rolls back. It answers `classify_issue_origins(committed, working)`:
      - `working` is the committed issues whose owner is not dirty, followed by the scoped ones.
      - Each working issue is `on_server` while a committed issue with the same `(severity, message, tuple(target_ids), category)` key is left unmatched, and `uncommitted` otherwise. `check` is not part of the key.
      - The unmatched committed issues follow, as `resolved`, in committed order.
    - With no ops it runs a FULL run (one cycle representative) and replaces the server's store, all `on_server`.
    - `ops: []` takes the full branch.
13. **`POST /commits/preview`** (`routes/commits.py:516-650`):
    - `split_ops` separates model, artifact, view and metamodel ops.
    - Artifact and view ops are checked DRY only: they can raise a 422 or 409 and contribute no issue.
    - A rebind swaps the candidate in and validates `Scope.all()`.
    - Otherwise it runs `_apply_batch(model_ops)`, takes `base_dirty = set(res.dirty.ids)`, expands, validates the dirty scope and rolls back.
    - The answer:
      - `conformance_error_count` is the number of CONFORMANCE issues, warnings included.
      - `structural_blockers` holds the STRUCTURAL issues.
      - `issues` holds all of them in pipeline order, every one `on_server`.
      - `would_block = strict_mode and no rebind and any(owner in base_dirty or check starts with "rule:")`.
    - It never reads the store. A stale `base_rev` is a 409.
    - It MINTS real ids for staged creates and does not give them back (probe: a preview's create drew `e-7`, and the next real create `e-8`).
14. **An `id` hint survives the preview.** A `create_element` whose `temp_id` starts with `tmp_` and that carries `id` is created under that id (`ops.py:309-324`, `_reject_reserved_hint`). The engine's applier honours hints too. A fixture can therefore hold creates to the same ids on both sides.
15. **The golden recorder has no session.** `batch` steps call `_apply_batch` on the recorder's own `Model`, with no `DirtyCollector` read, no `_finalize` and no store. A `read` step builds a fresh `Session` per call. `preview_commit` can be called directly with `db=None` for model-only ops, but it advances the recorder's `_ids`, which must be reset after it, as the refused-batch path does. *Read:* `tests/golden/model_steps.py:258-445`. *Probe:* `probe_api.py`.
16. **The engine as it stands** (`scratchpad/trace-engine.md`):
    - `ChangeSet` holds ids only. Each staged entry keeps its `BatchResult` (first-touch before-images, per-op inverse units). Committed writes (`commit`) record no before-images.
    - The scheduler has ONE background slot, which empties when its task finishes. The only restart is `service.changed()`.
    - `countOut` / `countIn` match the exact type. `uniqGroupOf(element)` exists, but there is no `uniq_key_of` map and no `duplicate_keys` set.
    - `Model.elements()` re-sorts after a restore at an old `ord`, so no iterator survives a transition.
    - `adoptStaged` emits no `changed`. No `artifacts_version` exists.
    - `invariants.test.ts` test 5 runs 40 random actions per seed.
17. **The frontend** (`scratchpad/trace-frontend.md`):
    - `getModelIssues()` (`lib/api/validation.ts:66`) has one caller, `refetchIssues` (`model-shared.svelte.ts:287-302`, which swallows errors and guards on generation).
    - `validateModel(options?)` has one production caller, `validateAll`, which sends `{ops, base_rev}` when anything is staged.
    - `previewCommit(baseRev, ops)` has one caller, `previewStaged`, which sends metamodel, model, artifact and view ops in that order. `DiffDrawer` reads only `conformance_error_count`, `structural_blockers.length` and `would_block`.
    - Refetch triggers: the feed's `snapshot` / `reset` / `commit` (a 300 ms debounce, `realtime.svelte.ts:172-185`), boot, the two reloads, the end of the server's sweep (`open-progress.svelte.ts:60-66`), and an own rebind. An own ordinary commit splices the response's issue delta (`applyDeltaShared`).
    - `adoptIssues` accepts an equal `model_rev` and clears the Validate overlay.
    - `changed` reaches only `attachEngine` (engine staging).
    - The sync forwards `progress` only while opening (plus `verify`).
    - `shadow.ts`'s `deepEqual` is order-sensitive. Its staged probe is set only by engine staging.
    - Tests spy on `$lib/api/validation` and `$lib/api/checkout`, so routing stays inside those functions.
    - Strict mode is `getStrictMode()` (`lib/state/checkout.svelte.ts:145`).
    - Model op kinds are the six `create/update/delete_element|relationship`. The metamodel ops are `metamodel.rebind` and `metamodel.move_node`.

## Decisions

Taken with the owner (spec "Decisions" 3, 8; handoff): one live issue store in the engine over the working copy; strict enforcement and `validation_error_count` stay server-side until F; the artifact and view half of the preview stays a server call until F; a staged `metamodel.rebind` sends the whole preview to the server until plan 7.

Taken by this plan. Each is small and reversible at review; say so if one is wrong:

- **D1. Scoped runs only.** The engine ports `Scope` runs, not `Scope.all()`.
  - The sweep is the server's sweep: scoped steps spliced through `replace` (fact 8).
  - Nothing in plan 2 makes a full run. Plan 7 decides for the candidate validation.
  - Cost: `validateModel` with nothing staged reports a cycle once per element whose chain reaches it, where the server's full branch names one representative. The server's own store already disagrees with its full branch in the same way. This is logged as `C-23`.
- **D2. Order is held where the oracle is deterministic.**
  - The store keeps Python's owner order and per-owner order, so the fixtures compare bodies exactly, `JSON.stringify` for `JSON.stringify`.
  - Shadow and the large-model parity compare multisets keyed `(severity, category, check, message, target_ids)`, as the spec says.
- **D3. Three dirty rules** (M3):
  - `stage` fires the Python hooks from the applier: the exact dirty set `_finalize` would see.
  - A coalesced stage takes the hooks of its trial run: the same op on the same state.
  - A rebase — `unstage` or `applyDelta` — takes the neighbourhood of every id it may touch, before and after. That over-approximates. It has no Python counterpart, and the seeded invariants hold it.
- **D4. The sweep.**
  - It steps in 512 ids. Each step validates and splices at once, so no transition lands inside one.
  - The id snapshot is taken at its first step. It runs in a new resumable scheduler slot, taking turns with the digest check.
  - A re-sweep (`validateModel`) re-validates in place; the store is never emptied.
  - `SWEEP_STEP` is tuned only if the longest step at M passes 8 ms.
- **D5. `issues_version`** is a per-service counter. It moves when a splice changes the store's content (not merely re-sets it), and on every delta that moves `rev` (origins can change). It rides the transition's `changed`. The sweep emits a bare `changed` (no ids, `structural: false`) at most once per slice.
- **D6. Origins by probe, cached per `(rev, staged_version)`.** The probe is M5.
  - `artifacts_version` is NOT added in plan 2. Nothing it validates reads an artifact.
  - Plan 3 adds it with rules, and the key widens then.
- **D7. Three bodies, three origin rules:**
  - `getModelIssues` answers the WORKING issues, tagged `uncommitted` or `on_server`, with no `resolved`. The live panel and the tree must not mark a fixed issue.
  - `validateModel` answers today's list, `resolved` included.
  - `previewCommit` tags everything `on_server`, as the oracle does (fact 13). This overrides spec §3's "issues with origins".
- **D8. The preview splits in the api function** (M8).
  - The engine answers the model half from ITS staged batches. It checks `base_rev` and the batch ids the shell would send, and a mismatch is a 409 `stale staged batches`, which the function answers from the server whole.
  - Artifact, view and `metamodel.move_node` ops go to the server's preview on their own, and the halves are merged.
  - A rebind sends everything to the server. The shell passes `strict`.
- **D9. What the engine refuses, with 501, answered by the server** (`route()`'s fallback):
  - `reaches an unsupported pattern` when a facet pattern is not `ok` for `translatePyRegex(…, 'fullmatch')` (checked when the store is built). A host `RangeError` or `SyntaxError` while testing one mid-transition is the same refusal, and sticky.
  - `reaches validation rules` while any `validation_rules` artifact resolves. Rules are plan 3, which deletes this refusal.
  - Neither is marked: in both cases the server answers exactly as today.
- **D10. The `issues` surface is gated.** It is the engine's only with `staging: engine` (the engine does not hold legacy-staged edits) AND once the replica's first sweep is complete. Before that, the server answers, as today.
  - The gate's opening schedules a refetch.
  - The engine answers a partial store only to a direct call.
- **D11. The server's refetch triggers keep firing.** They route through the surface, so in engine mode they read the engine, and the debounce folds them with the `issues_version` trigger.
  - The own-commit splice stays. It is a transient, which the refetch after the replica applies the commit replaces.
  - This is how the spec's "stand down" is met, with no second code path.
- **D12. The open journey is unchanged.** The engine's `sweep` progress feeds the gate, not the progress bar. The workspace opens at `ready` (AD-25), and the gate covers the seeding gap. This refines spec §3's "replaces `/model/status`'s validation progress". Update the local spec in Task 6.
- **D13. The shadow rules.**
  - `getModelIssues` is compared only while nothing is staged.
  - `validateModel` and `previewCommit` are compared WITH staged ops, since they send them to the server, unless a staged op creates an entity: the server mints ids the engine never sees (fact 13).
  - Everything is compared as multisets (D2).
- **D14. Scope.** K-49…K-57 are left where they are: plan 2 touches no artifact path. The doc slips left after plan 1 are fixed in Task 6.
- **D15. The method kinds.**
  - `getModelIssues` and `previewCommit` may run the probe, a rewind and replay, so they are model-lane TRANSITION jobs that emit no `changed`. They are never reads, which a scan's slice boundary may run between its steps.
  - `validateModel` is a transition that restarts the sweep. It is answered after the sweep completes, by a second transition that builds the body. A replica discarded or diverged meanwhile answers it 409 `replica is not ready`.
- **D16. A Python bug found while porting lands on both sides with a fixture step** (MR-3). None is known.

## Global Constraints

- Everything runs through pixi. There is no global `node` or `python`: use `pixi run <task>`, `pixi run -e core-dev …`, `pixi run -e frontend …`.
- **Branch and commits.** Work on `feat/eval-validation`, cut from `engine-migration`. Task 1 cuts it, and Task 6 fast-forwards `engine-migration` to it, with the owner's go-ahead. Never touch `main`, never push. **Commit only with the owner's go-ahead for this plan's execution.** One commit per task.
- **Freeze (MR-3).**
  - `core/model`, `core/metamodel` and the model-op applier stay frozen.
  - From Task 1 on, `core/validation` minus `rules/`, `api/validation_sweep.py` and the preview's conformance half (`routes/commits.py::preview_commit` model half, `api/rules.py::attributable_issues`) are frozen for behaviour too. So are the frozen areas of plan 1.
  - This plan changes NO file under `src/data_rover/` unless D16 fires.
  - The Python core is the oracle: fix the engine, never a fixture. Fixtures change only through `pixi run golden-fixtures`.
- **Engine `src/` rules:**
  - No DOM, no Node built-in, no timer or clock, no `Math.random`, no `Intl`, and no locale comparison (RC-4, RC-5).
  - Erasable syntax only, `.ts` import specifiers, and no `any` in an exported signature.
  - Strings compare by `cmpCodePoint`. Lengths Python counts are counted in code points.
  - `repr` is `pyRepr` / `pyFloatRepr` / `pyReprValue`.
- Tests import the engine through `engine/src/index.ts` only. Engine and frontend tests run the real engine, never a mock, without fake timers. Every in-process link is `dispose()`d.
- A steps generator publishes nothing before its last step, EXCEPT the sweep. Each sweep step is a complete splice, and the sweep holds no iterator across a yield.
- A transition runs to completion. Its incremental revalidation is part of it (AD-23). Nothing live leaves the service: results go through `toWire` / the `wire*` functions.
- **Lint and checks.**
  - `pixi run engine-tidy` for `engine/`, and `pixi run dr-tidy` for the rest.
  - On every file under `tests/`, run `pixi run -e core-dev ruff check <files>` and `ruff format <files>` by hand.
  - `pixi run engine-check` and `pixi run frontend-check` must pass.
- A "see it fail" step lists the tests it expects red. Any OTHER red test is a finding to report, not to silence.
- Comments and docstrings: concise, present-tense, only for what the code cannot say. No references to specs, plans or `architecture/` ids in code (RC-6).
- `architecture/`, the READMEs and `BACKLOG-ENGINE.md` change in the commit of the code they describe (RC-10). `docs/` and `benchmarks/` are git-ignored: never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, with no prefix and no trailing period. The message ends with the session's `Co-Authored-By` line.
- Ids: the next free are `AD-32`, `K-58`, `C-23`, and `T-10` in `BACKLOG.md`.
- **Baseline** at `f7c7136`:
  - engine: 1,089 tests in 70 files (re-run 2026-09-24);
  - core: 2,571 passed / 34 deselected;
  - frontend: 2,954 tests in 283 files;
  - sandbox: 14 tests;
  - e2e: 62 passed and 2 failed; the two failures are the pre-existing T-8 and T-9.

## Review Focus

These are the five conditions most likely to bite a user that the tasks' ordinary tests would not reach. Each has its test in the task named.

1. **An edit during the sweep.** A transition between sweep steps can delete an entity the snapshot still lists, create one it does not, re-create one under the same id, or change one already swept. The finished store must still equal a fresh sweep of the final state. *Task 3.*
2. **The origin probe leaves no trace.** The staged set may include a cascade delete, a create under a `tmp_` id, a coalesced edit and a parked batch. After a probe the entity lines, the index dump, the digest, `staged()`, `conflicts()` and `staged_version` are all unchanged, and the next `stage` behaves as if no probe ran. *Task 3.*
3. **The commit window.**
   - After the user's own commit lands, its issues read `on_server` instead of `uncommitted`, and no issue appears twice.
   - The panel's list after the refetch is the engine's, never a splice of the server's delta into it.
   - *Task 3 (the tracker), Task 5 (the shell).*
4. **A new replica mid-session** (a divergence, a dead worker, a rebind reload).
   - The gate closes, the server answers, and the gate reopens only when the new replica's sweep completes, with one refetch.
   - A partial engine list is never adopted.
   - *Task 5.*
5. **A project the engine cannot validate** — a facet pattern outside the translator's subset, or a rules artifact. Every issues call reaches the server, and nothing half-validated is shown. *Task 4 (the 501s), Task 5 (the fallback reaches MSW).*

---

## File Structure

```
tests/golden/model_steps.py                  + `validate`, `issues`, `preview`, `validate_staged`, `seed` steps;
                                               `record_dirty` / `finalize` on `batch`; a persistent Session
tests/golden/scenarios/validation_kinds.py   (new) every violation kind, scoped runs, dates
tests/golden/scenarios/validation_dirty.py   (new) dirty sets per op kind
tests/golden/scenarios/validation_steps.py   (new) store after each batch; preview and staged-validate bodies
tests/golden/scenarios/__init__.py           registers the three

engine/src/validation/issue.ts               (new) Issue, severities, categories, issueKey, wireIssue
engine/src/validation/values.ts              (new) valueConforms, pyIsoDate, pyStrNumber, pyReprFrozen
engine/src/validation/validators/*.ts        (new) the six validators
engine/src/validation/pipeline.ts            (new) FacetPatterns, validateScoped
engine/src/validation/dirty.ts               (new) DirtyCollector (hooks), addNeighbourhood
engine/src/validation/store.ts               (new) IssueStore
engine/src/validation/live.ts                (new) LiveIssues: sweep, transitions, probe, cache
engine/src/validation/bodies.ts              (new) storeListBody (Task 2); issueListBody, validateBody, previewBody (Task 3)
engine/src/ops/apply.ts                      + `dirty` option firing the hooks
engine/src/working/working-copy.ts           + `stage(…, {dirty})`, `touchedIds()`, `probeStaged(…)`
engine/src/service/scheduler.ts              + the resumable sweep slot
engine/src/service/service.ts                + LiveIssues lifecycle, the three methods, issues_version, sweep progress
engine/src/service/types.ts                  + `issues_version` on changed; the method params
engine/src/index.ts                          exports
engine/bench/run.ts                          + sweep, probe and revalidation rows
engine/bench/parity-large.ts                 (new) engine sweep vs the oracle's at M
scripts/issues_large.py                      (new) the oracle's sweep at M as a multiset file
engine/test/validation/*.test.ts             (new) kinds.golden, values, dirty.golden, steps.golden, live, probe
engine/test/working/invariants.test.ts       + the store invariant
engine/test/service/issues.test.ts           (new)
engine/test/service/scheduler.test.ts        + the sweep slot

frontend/src/lib/api/validation.ts           getModelIssues, validateModel routed
frontend/src/lib/api/checkout.ts             previewCommit routed and split
frontend/src/lib/api/engine-route.ts         Surface + 'issues'; 'reaches validation rules'; shadow option
frontend/src/lib/engine/surfaces.ts          SURFACES + issues (default server until Task 6)
frontend/src/lib/engine/sync.ts              sweep progress → seeded; status field
frontend/src/lib/engine/shadow.ts            multiset normalizer for issues
frontend/src/lib/state/replica.svelte.ts     the issues gate; changed → refetch; seeded → refetch
frontend/src/lib/state/model-shared.svelte.ts   scheduleIssuesRefetch lives here (moved from realtime)
frontend/src/lib/state/checkout.svelte.ts    previewStaged passes strict and batch ids
frontend/src/lib/state/model.svelte.ts       validateAll passes batch ids
frontend tests under the touched modules' __tests__/; frontend/e2e/eval-issues.spec.ts (new);
frontend/bench/ + the sweep rows

pixi.toml                                    + engine-parity-large
architecture/{contracts,decisions,program}.md, engine/README.md, frontend/src/lib/engine/README.md,
frontend/README.md (issues section), BACKLOG-ENGINE.md, CLAUDE.md (the new command)
```

`src/validation/` depends on `src/model/`, `src/metamodel/`, `src/value/`, `src/steps/`, `src/ops/` (types) and `src/working/`. The service imports `live.ts` and `bodies.ts` only.

## Mechanisms

The tasks refer to these. Read them before the task that uses them.

**M1 — Values in messages and conformance** (`values.ts`).

- `valueConforms(value, datatype, mm)`:
  - enum → `typeof value === 'string'` and a member;
  - `string` → a string;
  - `boolean` → a boolean;
  - `integer` → a `number` or `bigint` (a `PyFloat` is not);
  - `float` → a `number`, `bigint` or `PyFloat`, or the strings `Infinity` / `-Infinity`;
  - `date` → a string that `pyIsoDate` accepts;
  - anything else → false.
- `pyIsoDate(s)` is `date.fromisoformat` over ASCII digits only (fact 5):
  - `YYYY-MM-DD`, `YYYYMMDD`, `YYYY-Www[-D]`, `YYYYWww[D]`;
  - year 1–9999; month and day checked against the calendar, leap years included;
  - the ISO week number 1–52, or 53 when the year has it (its 1 January is a Thursday, or a Wednesday in a leap year); weekday 1–7;
  - no other form.
- `pyStrNumber(v)` is `str()` of a number: an int (`number` / `bigint`) in decimal, and a `PyFloat` through `pyFloatRepr`.
- A facet bound is always a float (fact 3), so it goes through `pyFloatRepr(bound)`.
- `pyReprFrozen(v)` is `repr(_frozen(v))`: `None`, `True` / `False`, an int, a float through `pyFloatRepr`, a string through `pyRepr`, a list as a tuple (`()`, `('x',)`, `('a', 'b')`), and a dict as a tuple of `(key, value)` tuples sorted by key with `cmpCodePoint`. It recurses.

**M2 — The validators and the scoped pipeline** (`validators/*.ts`, `pipeline.ts`). Each is a line-for-line port under Python's name in camelCase, with its `check_name`, its messages (fact 3, M1) and its order:

- type conformance: properties in property order;
- multiplicity: property multiplicities in effective order, then end constraints in `endConstraints` order;
- facets: facet properties in effective order, list items in order;
- endpoint typing: the allowed types `sorted` by code point and joined with `', '`.

Memos per type name are plain `Map`s on a `Validators` object built for one metamodel instance. `LiveIssues` builds one per replica, because the replica's metamodel is fixed until it re-bootstraps.

- **Uniqueness.** For a scoped id whose `uniqGroupOf(el)` has two or more members, the primary is the member with the least `ord`. An id that is not the primary is reported, with the descriptor built from the id's own properties (`pyReprFrozen` per key property) and its own key relationships' endpoint ids sorted by code point, of the exact type.
- **Containment.**
  - `validateElement`: `el.parents.length > 1`.
  - The scoped global walks the first-parent chain (`parents[0].source…`) with a shared `safe` set, per scoped element that exists, as `_walk_reaches_cycle`.
- `validateScoped(model, ids, validators, patterns)` runs every id once, the first occurrence winning. It skips ids that resolve to nothing, runs the globals after the entities, and stamps `check`.
- `FacetPatterns` compiles every distinct facet pattern of the metamodel once, with `translatePyRegex(p, 'fullmatch')`, and warms each on `''` and `'Ā'` as `compileCriteria` does. `unsupported` or `invalid` (unreachable, since `check_metamodel` refuses an invalid pattern, AD-22) makes it `unusable`. A `RangeError` or `SyntaxError` thrown by a pattern's `test` marks it `unusable` from then on, and the throw becomes `PatternUnusable`, which `LiveIssues` catches (M4).

**M3 — Dirty sets** (`dirty.ts`, `apply.ts`).

- `DirtyCollector` is an ordered set (`add`, `update`, `ids`) with the Python hooks under camelCase names: `afterElementCreate`, `beforeElementPropsChange`, `afterElementPropsChange`, `beforeElementDelete`, `beforeConnect`, `afterConnect`, `beforeDisconnect`, `afterDisconnect`, `afterRelationshipPropsChange`, `addUniquenessGroupOf`. Each adds exactly what fact 9 lists, in that order, and sorts every set it takes from the index by code point.
- `beforeElementDelete` uses the applier's `containmentClosure`, whose order must be Python's (`containment_closure`: a pop-based walk over sorted outgoing ids). The fixture holds it.
- `applyBatch(model, ops, {…, dirty?})` fires the hooks exactly where `_apply_one` does (fact 9): around `createElement` / `restoreElement`, each `setProperty` / `deleteProperty` of a create or an update, `connect`, `disconnect` and `deleteElement`. With no `dirty`, nothing changes and nothing is paid. A refused batch's collector is discarded by its caller.
- `addNeighbourhood(model, ids, into)` is the rebase rule. For each id, in order:
  - an element that exists adds itself, then its sorted uniqueness group, its sorted referencers, each sorted outgoing relationship and its target, and each sorted incoming relationship and its source;
  - a relationship that exists adds itself, its source and its target, and its target's sorted group when its type is containment;
  - an id that resolves to nothing adds itself.
- A rebase's dirty set is `N(before, P) ∪ N(after, P ∪ T)`, where:
  - `P` is `wc.touchedIds()` (every staged entry's before-image keys, elements then relationships, entry order), plus, for a delta, every id it names or deletes, read before anything moves;
  - `T` is the ids of the `ChangeSet` it returns.

  A verdict depends on the entity, its uniqueness group, its references, its incident relationships and its endpoints. Every input a rebase can change is an entity it touches, so both states' neighbourhoods cover every entity whose inputs moved. The containment chain beyond the first parent is the exception Python shares (`dirty.py:61-68`).

**M4 — `LiveIssues`** (`live.ts`). It is built by the service when a replica becomes `ready`, over its `WorkingCopy`, and dropped with it.

- **State.** An `IssueStore`, `version`, `seeded`, `unusable: 'pattern' | null`, and the sweep cursor `{ids, at, generation, waiters}`.
- **`IssueStore`**: `Map<owner, Issue[]>`, with `replace(dirty, issues) → boolean` (true when content moved), `iter()`, `counts()` (first-seen severity order, kept incrementally), `size` and `owners()`. Content equality per owner compares `issueKey` lists.
- **Transitions.** Each returns what the working copy returns, and splices before it returns:
  - `stage(ops, {coalesce})` passes a `DirtyCollector` to `wc.stage`, which hands it to the applied batch, or to the trial run of a merge (fact 16).
  - `unstage(what)`, `applyDelta(delta, own)`: `P` before, the call, then `N` over `P ∪ T` after (M3).
  - Then `validateScoped(dirty)` and `store.replace(dirty, issues)`. If the store moved, or a delta moved `rev`, `version++`.
- **Sweep.** `sweepSteps()` is a `Steps` generator.
  - At its first step it copies the ids: every element id in state order, then every relationship id.
  - Each step takes `SWEEP_STEP` (512) ids from the cursor, runs `validateScoped` over them and `replace`s them in the same step.
  - At the end it sets `seeded`, resolves the waiters and ends.
  - `restartSweep()` bumps `generation`, and the next step takes a fresh snapshot. The store is kept.
  - It holds no iterator, so it resumes across any transition.
- **`PatternUnusable`.** Caught in a transition or a sweep step, it sets `unusable = 'pattern'`, clears the store, ends the sweep and moves `version`. The transition itself succeeds. The three bodies then refuse (M7).

**M5 — The origin probe** (`WorkingCopy.probeStaged`, `LiveIssues.origins()`).

- `wc.probeStaged(onWorking: (dirty: readonly string[]) => W, onCommitted: () => C): {dirty: string[]; working: W; committed: C}` works in six steps:
  1. Rewind every staged entry, newest first.
  2. Replay each batch in order through `applyBatch` with ONE shared `DirtyCollector` (identity `idFor`, as a rebase does). This gives `S`, the dirty set the server's preview computes for these ops on committed state (fact 13).
  3. Run `onWorking(S)`.
  4. Rewind again.
  5. Run `onCommitted()`.
  6. Replay, rebuilding the entries and the committed images through `keep`, never through `tracked`, so `stagedVersion` does not move.
- Parked batches are not applied, so they are not touched.
- A replay cannot be refused: it replays the same batches on the same states. If one ever is, the probe restores the entries, parked list and version it saved and throws a plain `Error` (a 500). A test holds that it never happens across the seeded runs.
- `LiveIssues.origins()` returns, from a cache keyed `(rev, stagedVersion)`: `S`, `workingS` (a fresh `validateScoped(S)` on the working state) and `committedS` (the same on committed state).
- The service restarts the digest check after a probe (it rebuilt the committed images the check walks), and emits no `changed`.
- **Tagging** is `classify_issue_origins`, restricted to `S`. Owners outside `S` are equal by construction.
  - A multiset of `committedS` is keyed `(severity, message, target_ids, category)`.
  - Each working issue of an owner in `S`, in order, is `on_server` while a committed match remains, which it consumes, and `uncommitted` otherwise.
  - The unmatched remainder, in `committedS` order, is `resolved`.

**M6 — The sweep slot and the service** (`scheduler.ts`, `service.ts`).

- **Scheduler.**
  - `setSweep(task | null)` fills a second background slot. It has the same shape as `setBackground`, and `restartBackground` does not touch it.
  - When idle and open, `unit()` gives the digest slot and the sweep slot one step each in turn.
  - A slot empties when its task ends, as today. `setOpen(false)` pauses both.
- **Lifecycle.**
  - `becomeReady(wc)` builds `LiveIssues(wc)` and sets the sweep task (`start: () => live.sweepSteps()`, `progress → progress('sweep', done, total)`).
  - `discard()` and `diverge()` drop it, and answer any pending `validateModel` 409 `replica is not ready`.
- **Transitions.**
  - `stage`, `unstage` and `applyDelta` on a `ready` replica go through `live`.
  - While opening, `adoptStaged` and the tail go straight to `wc`, as today: the first sweep covers everything.
  - `changed` gains `issues_version: live?.version ?? 0`, from a per-service counter that never resets (each `version++` bumps it).
  - At `onSliceEnd`, if `issues_version` moved since the last `changed` posted, post a bare `changed` with the current `rev` and `staged_version`, empty id lists and `structural: false`. This emission neither restarts the digest check nor goes through `service.changed()`.
- **Methods.**
  - `getModelIssues {}` and `previewCommit {base_rev, batch_ids, strict}` are model-lane transition jobs without `changed` (D15).
  - `validateModel {batch_ids}` is a model-lane transition that checks `batch_ids` and calls `live.restartSweep()`. Its answer is posted from the sweep's completion, through a second model-lane transition that builds the body.
  - All three first check D9's refusals: `live.unusable` → 501 `reaches an unsupported pattern`; any resolvable `validation_rules` artifact → 501 `reaches validation rules`.
  - `batch_ids` must equal `wc.staged().map(b => b.id)`, and `base_rev` must equal `wc.rev`. Otherwise the answer is a 409: `stale staged batches` or `stale base_rev`.

**M7 — The bodies** (`bodies.ts`), each in the route's field order:

- `issueListBody(live)` → `{model_rev: <the committed rev>, issues, counts, truncated, rules_status: {total: 0, skipped: [], eval_errors: {}}}`.
  - The first 5,000 store issues, in store order, through `wireIssue` with D7's tags.
  - `truncated` is `size > 5000`, and `counts` is `store.counts()`.
- `validateBody(live)` → every store issue, tagged by M5 (`resolved` appended), as `IssueOut[]`.
- `previewBody(live, strict)` → `{conformance_error_count, structural_blockers, issues, would_block}` over `workingS`, in `S` order, every origin `on_server`.
  - `conformance_error_count` counts CONFORMANCE issues of any severity.
  - `would_block = strict && workingS.some(i => i.category === 'conformance' && S.has(owner(i)))`. No rule issue exists in plan 2.
- `wireIssue` → `{severity, message, target_ids, category, check, origin}`.

**M8 — The shell.**

- **`issues` surface.**
  - `Surface` gains `'issues'` and `SURFACES` lists it, with default `server` until Task 6. It is not in `READ_SURFACES`.
  - `FALLBACKS` gains `'reaches validation rules' → 'rules'`, and the fallback reason union gains `'rules'`.
- **Sync.**
  - A `progress` event with task `sweep` is taken in any phase: `done === total` sets `status.seeded = true`, and a `done: 0` report sets it false.
  - A new replica — a new run, a resync or a re-bootstrap — starts `seeded: false`.
  - `status` changes are published as today.
- **Gate.** In `replica.svelte.ts`, `issues: () => getStagingSide() === 'engine' && sync.status.seeded` goes beside plan 1's `navigation` gate. When it goes from false to true, `scheduleIssuesRefetch()` runs.
- **Refetch.**
  - `scheduleIssuesRefetch` moves to `model-shared.svelte.ts`, and `realtime.svelte.ts` imports it.
  - `startReplica` subscribes `sync.on('changed', e => …)`: when `e.issues_version` differs from the last one seen, it calls `scheduleIssuesRefetch()`.
  - `stopReplica` / `resetReplica` unsubscribe.
- **`getModelIssues(cfg?)`** → `route('issues', cfg, call => call('getModelIssues', {}).then(IssueListOutSchema.parse), server, {shadow: 'unstaged'})`.
- **`validateModel(options?, cfg?)`.**
  - `inline` or `scope` → the server.
  - Otherwise, with the new `options.batchIds` (the batches `options.ops` came from), `route('issues', …, call => call('validateModel', {batch_ids}), server, {shadow: comparableWhileStaged(ops)})`.
  - An engine 409 `stale staged batches` → the server.
- **`previewCommit(baseRev, ops, cfg?, local?: {strict: boolean; batchIds: readonly number[]})`.**
  - With no `local`, a `metamodel.rebind` op, or the surface on `server` → the server with every op.
  - Otherwise, the engine's `previewCommit {base_rev, batch_ids, strict}`.
    - If any op is not a model op, the server's preview of just those ops runs too, and the halves merge: the counts summed, `structural_blockers` and `issues` concatenated (engine first), `would_block` OR-ed.
    - An engine 409 `stale staged batches` → the server with every op.
  - Shadow: compared while staged, per D13.
- **Callers.** `previewStaged` passes `{strict: getStrictMode(), batchIds: captureStaged().batchIds}`, and `validateAll` passes `batchIds`.
- **`route` options.** `shadow?: 'unstaged' | 'always' | 'never'`, default `'unstaged'` (today's rule). `comparableWhileStaged(ops)` is `'always'` unless an op is a `create_element` / `create_relationship`, when it is `'never'`.
- **`shadow.ts`.** `present('issues', value)` sorts `issues` (a list body), the bare list (validate), and `structural_blockers` and `issues` (preview) by `JSON.stringify([severity, category, check, message, target_ids, origin])`.

---

### Task 1: The validators and the scoped pipeline · `critical-implementer`

**Files:**
- Create: `engine/src/validation/{issue,values,pipeline}.ts`, `engine/src/validation/validators/{type-conformance,multiplicity,facets,endpoint-typing,containment,uniqueness}.ts`, `tests/golden/scenarios/validation_kinds.py`, `engine/test/validation/kinds.golden.test.ts`, `engine/test/validation/values.test.ts`
- Generated: `engine/fixtures/golden/validation_kinds.json`
- Modify: `tests/golden/model_steps.py` (a `validate` step), `tests/golden/scenarios/__init__.py`, `engine/test/golden/model-steps.ts` (replays it), `engine/src/index.ts`, `engine/README.md`

**Interfaces:**
- Produces:
  - `type Severity = 'error' | 'warning'`; `type Category = 'structural' | 'conformance'`; `type Issue = {severity; message; targetIds: readonly string[]; category; check: string}`; `issueOwner(i)`; `issueKey(i): string` (the multiset key, `check` included); `wireIssue(i, origin): IssueOut`.
  - `valueConforms`, `pyIsoDate`, `pyStrNumber`, `pyReprFrozen` (M1).
  - `class Validators` (per metamodel, the six in order); `class FacetPatterns { constructor(mm); readonly unusable: boolean }`; `class PatternUnusable extends Error`; `validateScoped(model: Model, ids: Iterable<string>, v: Validators, p: FacetPatterns): Issue[]` (M2).
- Recorder step: `{"do": "validate", "scope": [ids] | "all_ids"}` runs `ValidationPipeline(default_validators()).validate(model, Scope(ids))`. `"all_ids"` means `list(elements) + list(relationships)`, which is exactly the sweep's order. It records the issues as `IssueOut.from_core(...).model_dump(mode="json")`. It does not change the model.
- **Fixture `validation_kinds.json`.**
  - **Metamodel:**
    - an enum;
    - every scalar datatype;
    - facets `min` / `max` (an int bound in YAML, to show `5.0`), a `pattern` inside the translator's subset, and `max_length`;
    - a property multiplicity of `1`, `0..1` and `1..*`;
    - an element-typed property, single and list;
    - an element subtype chain;
    - a relationship with two mappings (so the pair check can fail alone) and end multiplicities;
    - a containment type;
    - a keyless type and a keyed type (property keys, a list-valued key, an `out:` key and an `in:` key).
  - **Model:**
    - one violation of every message in fact 3;
    - a `1.0` on an integer and a `True` on a float;
    - dates from fact 5 (both lists);
    - a string needing `repr`'s double quotes, and a non-ASCII string past `max_length`;
    - `10**20` and `1e20` against a max, and NaN is not possible in JSON;
    - a dangling reference and a mistyped one;
    - a missing endpoint;
    - two containment parents;
    - a containment cycle with elements hanging below it;
    - duplicate groups: keyless `1` / `1.0` / `True`, keyed with list and dict values, and an out-key;
    - an element and a relationship of a type the metamodel lacks, inserted through `insert_element` / `insert_relationship`.
  - **Steps:**
    - `validate` over `all_ids`;
    - over several subsets in orders unlike state order (unknown ids included, the same id twice, a dup without its primary, a cycle member alone);
    - then a few `batch`es that move group membership, each followed by `validate` again.
  - Everything is under 500 entities.

- [ ] **Step 1: Ask, then cut the branch.** Ask the owner whether commits are pre-approved. Then `git switch engine-migration && git switch -c feat/eval-validation`.
- [ ] **Step 2: Write the scenario, the recorder step and the failing tests.**
  - `kinds.golden.test.ts` replays `validation_kinds` twice, the second time with `hashKey: () => 0`.
  - `values.test.ts`:
    - `pyIsoDate` against both lists of fact 5, plus the leap days `2024-02-29` (accepted) and `2023-02-29` (refused), and `2020-W53` (accepted) and `2021-W53` (refused);
    - `pyReprFrozen` of `[]`, `['x']`, `{'b': 1, 'a': [1, 2]}` → `(('a', (1, 2)), ('b', 1))`;
    - `pyStrNumber` of a `PyFloat(1e20)` → `1e+20`;
    - `FacetPatterns` over a metamodel with `(?x)a` is `unusable`, and over `[A-Z]+` it is not.
- [ ] **Step 3: See them fail.** Run `pixi run golden-fixtures`, then `pixi run engine-test`. Expected red: the two new files, at import. Everything else stays green.
- [ ] **Step 4: Implement** per M1 and M2.
- [ ] **Step 5: See them pass.** Then run `pixi run -e core-dev pytest tests/golden -q` (staleness) and `pixi run engine-check`.
- [ ] **Step 6: Lint.** Run `pixi run engine-tidy`, and ruff check and format on the Python files.
- [ ] **Step 7: Docs.** In `engine/README.md`, add a `src/validation/` bullet: the port and its order, scoped runs only (D1), the message rules (`repr` of frozen values, float bounds, code-point lengths, `date.fromisoformat`), and facet patterns through the translator with `unusable` as the one way out.
- [ ] **Step 8: Commit** (with the go-ahead): `Port the six validators to the engine`.

---

### Task 2: Dirty sets and the issue store · `critical-implementer`

**Files:**
- Create: `engine/src/validation/{dirty,store}.ts`, `tests/golden/scenarios/validation_dirty.py`, `tests/golden/scenarios/validation_steps.py`, `engine/test/validation/dirty.golden.test.ts`, `engine/test/validation/steps.golden.test.ts`, `engine/test/validation/store.test.ts`
- Generated: `engine/fixtures/golden/validation_dirty.json`, `engine/fixtures/golden/validation_steps.json`
- Modify: `engine/src/ops/apply.ts` (+ `dirty`), `tests/golden/model_steps.py`, `tests/golden/scenarios/__init__.py`, `engine/test/golden/model-steps.ts`, `engine/src/index.ts`, `engine/README.md`

**Interfaces:**
- Consumes: `validateScoped`, `Validators`, `FacetPatterns`, `Issue` (Task 1); `applyBatch`, `containmentClosure`.
- Produces:
  - `class DirtyCollector` (M3), with `ids: readonly string[]` in insertion order; `addNeighbourhood(model, ids, into: DirtyCollector): void`.
  - `ApplyOptions.dirty?: DirtyCollector`.
  - `class IssueStore { replace(dirty: Iterable<string>, issues: readonly Issue[]): boolean; iter(): IterableIterator<Issue>; counts(): {[severity: string]: number}; get size(): number; issuesOf(owner): readonly Issue[] }`.
  - `storeListBody(store, rev, tagOf?: (i: Issue) => string)` in `bodies.ts` — the `GET /model/issues` body over a store, every origin `on_server` unless `tagOf` says otherwise. Task 3's `issueListBody(live)` calls it.
- **Recorder.**
  - `batch` steps gain `"record_dirty": true`, which adds `"dirty": list(res.dirty.ids)` to the result.
  - `Recorder` gains an optional persistent `Session(metamodel, model)`, made by a `{"do": "seed"}` step that runs `start_validation_sweep(session, sync=True)`.
  - After `seed`, every `batch` bumps `session.model_rev` and calls `_finalize(...)` with the step's result, as `/model/ops` does.
  - `{"do": "issues"}` records `routes.validation.get_model_issues(session=session)` (the real route function, every argument passed), `model_dump(mode="json")`.
  - Existing fixtures do not change. The staleness test proves it.
- **Fixtures.**
  - `validation_dirty`: one `batch` per op kind of fact 9, with `record_dirty`, over a model where each hook has something to add. That means groups of two or more, referencers, containment re-parenting, a cascade three levels deep with incident relationships at every level, an update of several keys at once, a create with properties that move it through two groups, and an `id` hint.
  - `validation_steps`, part 1: `seed`, `issues`, then about 20 `batch`es, each followed by `issues`. They create and fix every kind of fact 3 (a duplicate appearing and resolving, a cycle made then broken, a reference dangling then healed), plus a refused batch, which must leave the store as it was.

- [ ] **Step 1: Write the scenarios, the recorder changes and the failing tests.**
  - `dirty.golden.test.ts` replays `validation_dirty`, applying each batch with a `DirtyCollector` and comparing `ids` to `dirty` in order.
  - `steps.golden.test.ts` builds, over the fixture's model, the session equivalent: a model, `Validators`, `FacetPatterns` and an `IssueStore`.
    - `seed` → `validateScoped(all ids in state order)`, then `replace`.
    - `batch` → `applyBatch` with a collector (minted ids, as the replay's `mint`), then `validateScoped(dirty)` and `replace`.
    - `issues` → `storeListBody` compared by `JSON.stringify`.
  - `store.test.ts`:
    - `replace` returns false when the new issues equal the old per owner, and true when one differs;
    - a new owner lands last;
    - `counts` is `{}` on an empty store, in first-seen order otherwise;
    - `addNeighbourhood` of a deleted id adds the id alone, and of an element with a group, referencers and relationships adds each once, in M3's order.
- [ ] **Step 2: See them fail.** Run `golden-fixtures` then `engine-test`. Expected red: the three new files. Everything else, and `pixi run core-test`, stays green.
- [ ] **Step 3: Implement** per M3 and `storeListBody`.
- [ ] **Step 4: See them pass.** Run the staleness test and `engine-check`. The engine's existing golden and invariant suites must stay green: the hooks do nothing without `dirty`.
- [ ] **Step 5: Lint** as before.
- [ ] **Step 6: Docs.** In `engine/README.md`, the `src/validation/` bullet gains the collector (the hooks fired from the applier, exactly Python's), the neighbourhood rule and the store; the `src/ops/` bullet gains the `dirty` option; the golden-fixtures bullet gains `validate`, `seed`, `issues` and `record_dirty`.
- [ ] **Step 7: Commit:** `Collect dirty sets and keep an issue store in the engine`.

---

### Task 3: Live issues over the working copy · `critical-implementer`

**Files:**
- Create: `engine/src/validation/{live,bodies}.ts` (`bodies.ts` exists from Task 2 and gains these), `engine/test/validation/live.test.ts`, `engine/test/validation/probe.test.ts`
- Modify: `engine/src/working/working-copy.ts` (`stage(…, {dirty})`, `touchedIds()`, `probeStaged`), `tests/golden/model_steps.py` (`preview`, `validate_staged` steps), `tests/golden/scenarios/validation_steps.py` (part 2), `engine/test/validation/steps.golden.test.ts`, `engine/test/working/invariants.test.ts`, `engine/src/index.ts`, `engine/README.md`
- Generated: `engine/fixtures/golden/validation_steps.json`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `WorkingCopy.stage(ops, {coalesce?, dirty?})`; `touchedIds(): string[]`; `probeStaged(onWorking, onCommitted)` (M5).
  - `class LiveIssues { constructor(wc: WorkingCopy); stage(ops, options); unstage(what); applyDelta(delta, own?); sweepSteps(): Steps<boolean>; restartSweep(): void; whenSwept(): Promise<void>; origins(): Origins; readonly store; readonly version: number; readonly seeded: boolean; readonly unusable: 'pattern' | null }` (M4).
  - `issueListBody(live)`, `validateBody(live)`, `previewBody(live, strict)` (M7).
- **Recorder steps.**
  - `{"do": "preview", "ops", "strict"}` sets `session.strict_mode`, calls `preview_commit(PreviewRequest(base_rev=session.model_rev, ops=ops), project_id="p", session=session, db=None, membership=SimpleNamespace(role=Role.editor))`, records `model_dump(mode="json")`, and resets `_ids.drawn`.
  - `{"do": "validate_staged", "ops"}` calls the validate route's staged branch the same way. Both leave the model and the store as they were: the recorder checks it.
  - Creates in these ops carry `id` hints (fact 14).
- **Part 2 of `validation_steps`** (after part 1's batches): `preview` and `validate_staged` cases over staged ops that:
  - fix a committed issue;
  - make a new one;
  - duplicate an existing element through a hinted create;
  - cascade-delete a primary;
  - touch an entity that has a pre-existing issue;
  - run with `strict` true and false, with and without an attributable issue;
  - stage nothing at all (preview of `[]`).

- [ ] **Step 1: Write the failing tests.**
  - `steps.golden.test.ts` gains the two steps. For each, clone the current model into a `WorkingCopy` (`test/working/helpers.ts`' `clone`) and give its `LiveIssues` a copy of the harness's store, marked seeded. Stage the ops as ONE batch, then compare `previewBody(live, strict)` and `validateBody(live)` by `JSON.stringify`.
  - `probe.test.ts` (**Review Focus 2**): over seeded random staged sets that include a cascade delete, a `tmp_` create, a coalesced update and a parked batch (a delta that refuses one):
    - `probeStaged` leaves `observe()` (lines, index dump, digest), `staged()`, `conflicts()`, `stagedVersion` and `committedElement` of every touched id as they were;
    - a following `stage` gives the state a fresh working copy gives;
    - `S` equals the `dirty` of applying `staged().flatMap(b => b.ops)` as one batch to a clone of committed state.
  - `live.test.ts`:
    - **Review Focus 1:** drain `sweepSteps()` one step at a time over a 3,000-element seeded model with `SWEEP_STEP` lowered, and between steps stage, unstage and apply deltas. Include deleting a listed id, creating a new one, re-creating one under its id, and editing one already swept. The finished store equals a fresh `LiveIssues` swept over the final state, as `(owner → issue keys)`, with containment-cycle messages excluded.
    - `restartSweep` keeps the store populated throughout.
    - `version` moves on a real change and not on a no-op edit (renaming to the same value). It moves on an applied delta that changes no issue.
    - **Review Focus 3:** an own commit through `applyDelta(delta, own)` turns the staged create's `uncommitted` issue into `on_server`, and `issueListBody` lists it once.
    - Tags: `getModelIssues` never lists `resolved`, and `validateBody` appends them.
    - A pattern that throws `RangeError` mid-stage sets `unusable` and the stage still answers.
  - `invariants.test.ts`: test 5's 40 actions go through a `LiveIssues` (swept once at the start). After each action the store equals a fresh sweep's (cycle messages excluded), and `probeStaged` leaves `observe()` equal.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement** per M3's rebase rule, M4, M5 and M7.
- [ ] **Step 4: See them pass.** Run the staleness test, `engine-check`, and the whole `engine-test`.
- [ ] **Step 5: Lint** as before.
- [ ] **Step 6: Docs.**
  - `engine/README.md`: `src/working/` gains `touchedIds` and the probe's contract; `src/validation/` gains `LiveIssues` (the sweep that resumes across transitions, the three dirty rules, `version`, `unusable`), the probe and the tags, and the three bodies.
  - `BACKLOG-ENGINE.md`: `C-23`, the full branch's single cycle representative against the sweep's per-element reporting (D1).
- [ ] **Step 7: Commit:** `Keep a live issue store over the working copy`.

---

### Task 4: The service, the sweep slot and the gate at M · `critical-implementer`

**Files:**
- Create: `engine/test/service/issues.test.ts`, `engine/bench/parity-large.ts`, `scripts/issues_large.py`
- Modify: `engine/src/service/{scheduler,service,types}.ts`, `engine/test/service/scheduler.test.ts`, `engine/bench/run.ts`, `pixi.toml` (`engine-parity-large`), `CLAUDE.md` (the command list), `engine/src/index.ts`, `engine/README.md`

**Interfaces:**
- Consumes: `LiveIssues`, the bodies (Task 3).
- Produces:
  - `Scheduler.setSweep(task: BackgroundTask | null)`.
  - The methods `getModelIssues {}`, `validateModel {batch_ids}` and `previewCommit {base_rev, batch_ids, strict}`, with the refusals of M6 and the 501s of D9.
  - `changed` with `issues_version: number`, and `progress` with task `sweep`.
  - `WireChanged` in `types.ts` gains the field.
- `pixi run engine-parity-large`:
  - `scripts/issues_large.py` loads `benchmarks/large.model.json` with its metamodel, runs `start_validation_sweep(sync=True)`, and writes `benchmarks/large.issues.json`: the sorted `issueKey`s, in the engine's key format.
  - `engine/bench/parity-large.ts` opens the same model, drains `LiveIssues.sweepSteps()`, and compares the two multisets, printing the first 20 differences. It fails on any difference.

- [ ] **Step 1: Write the failing tests.**
  - `scheduler.test.ts`:
    - the sweep slot runs while idle and open, taking turns with the digest slot;
    - `restartBackground` leaves it alone;
    - a transition between two sweep steps does not drop it;
    - `setOpen(false)` pauses it, and it resumes where it was.
  - `issues.test.ts`, over the port pair:
    - after `applyTail`, `progress sweep` goes from `done 0` to `done === total`, and `getModelIssues` answers the fixture's body;
    - a `stage` that makes an issue posts `changed` with a new `issues_version` before its answer, and a following `getModelIssues` lists it as `uncommitted`;
    - with a slow clock the sweep emits a bare `changed` at most once per slice;
    - `validateModel {batch_ids}` answers after a fresh sweep, and a wrong `batch_ids` is 409 `stale staged batches`;
    - `previewCommit` with a stale `base_rev` is 409 `stale base_rev`;
    - `close` during a pending `validateModel` answers it 409;
    - **Review Focus 5:** a metamodel with a facet `(?x)a` makes all three methods answer 501 `reaches an unsupported pattern`, and a `setArtifacts` holding a `validation_rules` artifact makes them answer 501 `reaches validation rules`;
    - a probe (`getModelIssues` with something staged) restarts the digest check, which still ends true;
    - a `getModelIssues` queued behind a running scan waits for it, and is not answered at a slice boundary.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement** per M6.
- [ ] **Step 4: See them pass.** Run `engine-check` and `engine-test`.
- [ ] **Step 5: Bench and parity.**
  - `bench/run.ts` gains stepped rows `sweep` / `sweep (longest step)`, and timed rows `stage 1,000 ops + revalidation`, `unstage all + revalidation`, `delta over 100 staged + revalidation` and `origin probe (100 staged batches)`.
  - Run `pixi run engine-bench`, after `engine-bench-data` once. Then `pixi run engine-parity-large`.
  - Report the numbers and any parity difference to the owner through the hand-back. **Optimize nothing** except `SWEEP_STEP` (D4), and fix a parity difference in the engine.
- [ ] **Step 6: Lint.** Run `engine-tidy`, and ruff on `scripts/issues_large.py`.
- [ ] **Step 7: Docs.**
  - `engine/README.md`, `src/service/`: the sweep slot, `LiveIssues`' lifecycle, the three methods and their kinds (D15), `issues_version` and the bare `changed`, `progress sweep`, and the two 501s.
  - `bench/run.ts`: the new rows and the parity task.
  - `CLAUDE.md`'s command block gains `pixi run engine-parity-large   # engine sweep vs the oracle at M (after engine-bench-data)`.
- [ ] **Step 8: Commit:** `Serve the issue store from the engine service`.

---

### Task 5: The `issues` surface in the shell · `critical-implementer`

**Files:**
- Modify: `frontend/src/lib/api/{validation,checkout,engine-route,types}.ts`, `frontend/src/lib/engine/{surfaces,sync,shadow}.ts`, `frontend/src/lib/state/{replica,model-shared,realtime,checkout,model}.svelte.ts` (and `model.svelte.ts`' `validateAll`)
- Modify, tests: `lib/api/__tests__/{validation,checkout,engine-route}.test.ts`, `lib/engine/__tests__/{surfaces,shadow,sync-events}.test.ts`, `lib/state/__tests__/{replica.svelte,realtime,adopt-issues,validate-staged,checkout.commit}.test.ts`
- Modify, docs: `frontend/src/lib/engine/README.md`, `frontend/README.md` ("Validation issues")

**Interfaces:**
- Consumes: the three engine methods, `changed.issues_version` and `progress sweep` (Task 4).
- Produces:
  - `Surface` with `'issues'`; `RouteOptions.shadow`.
  - `SyncStatus.seeded: boolean`.
  - `validateModel(options?: ValidateOptions & {batchIds?: readonly number[]}, cfg?)`; `previewCommit(baseRev, ops, cfg?, local?: {strict: boolean; batchIds: readonly number[]})`; `scheduleIssuesRefetch()` exported from `model-shared.svelte.ts` (M8).

- [ ] **Step 1: Write the failing tests.** They run in-process with MSW for the server side.
  - `surfaces`: `issues` defaults to `server`, and `staging: engine` does not force it.
  - `engine-route`: `reaches validation rules` falls back to the server, without a mark; `shadow: 'always'` compares while staged; `'never'` never compares.
  - `validation` tests:
    - with the surface on `engine` and the gate open, `getModelIssues` answers the engine's body, and a staged facet violation is listed `uncommitted` (MSW is never asked);
    - with the gate closed (not seeded), MSW answers;
    - `validateModel({ops, batchIds})` answers the engine's list with `resolved` tags;
    - `inline` goes to MSW;
    - **Review Focus 5:** an engine whose metamodel has `(?x)a` sends all three to MSW.
  - `checkout` tests:
    - `previewCommit` with model ops only is the engine's answer;
    - with an artifact op, the engine half is merged with MSW's preview of the artifact op alone (assert MSW's request body holds only that op);
    - with `metamodel.rebind`, MSW gets every op;
    - an engine 409 `stale staged batches` falls back to MSW with every op;
    - `strict` reaches the engine.
  - `sync-events`: `progress sweep` after ready sets `seeded`, and a new link starts unseeded.
  - `replica.svelte` tests:
    - a `changed` with a new `issues_version` schedules ONE refetch after 300 ms, and a same-version `changed` schedules none;
    - the gate opening schedules one refetch;
    - **Review Focus 4:** after the link dies and a new one is adopted, `getModelIssues` goes to MSW until the new engine's sweep ends, then to the engine; no refetch adopts a list from the unseeded engine.
  - `realtime`: the feed triggers still schedule the (moved) refetch.
  - `checkout.commit` (**Review Focus 3**): after an own commit the panel's issues are the engine's list once the refetch lands, with no issue twice.
  - `shadow`: two issue lists in different orders are the same, and two differing in one `check` are not.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement** per M8.
- [ ] **Step 4: See them pass.** Run `pixi run frontend-test` and `pixi run frontend-check`.
- [ ] **Step 5: Lint.** Run `pixi run dr-tidy`.
- [ ] **Step 6: Docs.**
  - `frontend/src/lib/engine/README.md`, "Surfaces": `issues`, the gate (staging and seeded), the third fallback, and the split preview. "Shadow comparison": the multiset normalizer and the `shadow` option. The sync gains `seeded`.
  - `frontend/README.md`, "Validation issues": in engine mode the live list is the working copy's, refetched on `issues_version`; the own-commit splice is a transient. Also correct the stale sentence about the metamodel editor adopting the rebind response's issue list (nothing does).
- [ ] **Step 7: Commit:** `Route issues and the commit preview through the engine`.

---

### Task 6: The flip, e2e and the documents · `implementer`

**Files:**
- Create: `frontend/e2e/eval-issues.spec.ts`
- Modify: `frontend/src/lib/engine/surfaces.ts` (default), its test, `frontend/e2e/engine-mode.spec.ts` (if it lists surfaces), `frontend/bench/` (sweep rows), `architecture/contracts.md`, `architecture/decisions.md`, `architecture/program.md`, `BACKLOG-ENGINE.md`, `engine/README.md`, `frontend/src/lib/engine/README.md`, `engine/src/navigation/route.ts` (a docstring), `docs/superpowers/specs/2026-09-24-evaluation-design.md` (local)

- [ ] **Step 1: Flip.** `SURFACE_DEFAULTS.issues` becomes `engine`, and the surfaces test follows.
- [ ] **Step 2: e2e.** Write `eval-issues.spec.ts`, importing from `e2e/fixtures.ts` (engine mode, shadow on; a `[shadow]` line fails the test). Cover:
  - a staged edit that breaks a facet shows its issue in the Issues panel before any commit, and Discard removes it;
  - in strict mode the commit dialog blocks a staged violation;
  - Validate shows the overlay with the staged issue marked "new";
  - after the commit, the issue stays, now "on server".

  Stop any stale `vite preview` on :5174 first, then run `pixi run sandbox-build` and `pixi run frontend-test-e2e`. The whole suite must stay free of `[shadow]` lines, with T-8 and T-9 the only failures.
- [ ] **Step 3: Browser bench.** `frontend/bench/` gains `sweep (ready → seeded)` and `longest slice while sweeping` (the `staged` ping loop across the sweep). Run `pixi run engine-bench-browser` and report the numbers with Task 4's.
- [ ] **Step 4: `architecture/`.**
  - CT-4:
    - `getModelIssues`, `validateModel {batch_ids}` and `previewCommit {base_rev, batch_ids, strict}` (the model half) among the methods;
    - the third 501, `reaches validation rules`, until rules are ported;
    - `issues_version` on `changed`, moved when the issue store changes or `rev` does, and posted bare by the sweep;
    - the `sweep` progress task.
  - `decisions.md`: `AD-32 · One live issue store over the working copy; origins by rewind probe`.
    - Why: the panel reads staged edits live; one source; the probe is O(staged).
    - Rejected: an engine overlay on the server's issues; validation on demand only; a second, committed store.
    - Consequences: the sweep resumes across transitions; the three dirty rules; the gate.
    - Cite it in CT-4.
  - `program.md`: C's status becomes `in progress — plan 2 of 8 built (live issues and the model half of the commit preview served by the engine)`. Also correct the plan-1 slips named in the handoff: the MR-3 text ends bug parity "until F", not at plans 4–5; `api/search.py` and the route functions stay frozen as the 501 fallback's server side; name sub-project C where it says "plans 4–5" and "plan 1".
- [ ] **Step 5: Backlog and slips.**
  - `BACKLOG-ENGINE.md`:
    - R-3: plan 2's status and the freeze sentence (`core/validation` minus `rules/`, `api/validation_sweep.py` and the preview's conformance half frozen, and out of the freeze for features now that `issues` defaults to the engine; a bug lands on both sides until F), with the same corrections as `program.md`;
    - K-55's citation → `criteria.ts:258-259`;
    - K-53's path → `frontend/src/lib/engine/artifacts.ts`;
    - K-49…K-57's "Suggested fix:" → "Fix direction:".
  - `decisions.md` AD-31: when both loads fail, the startup window stays open until the next feed snapshot.
  - `engine/src/navigation/route.ts:95-100`: the docstring names the script refusal before pattern translation, as the code does.
- [ ] **Step 6: Spec.** In the local spec: §3 "Event" — D12 (the journey is unchanged; the sweep feeds the gate); §3 "Surface `issues`" — D7 (preview issues are `on_server`, as the oracle); §3 "Origins" — the cache key is `(rev, staged_version)` until plan 3 adds `artifacts_version`.
- [ ] **Step 7: Everything green.** Run `pixi run dr-test`, `pixi run dr-tidy true`, `pixi run engine-check`, `pixi run frontend-check`, `pixi run sandbox-check` and `pixi run engine-parity-large`.
- [ ] **Step 8: Commit:** `Serve live issues from the engine by default`. Then, with the owner's go-ahead, fast-forward `engine-migration` to `feat/eval-validation`.

## After this plan

Plan 3 (rules) starts from here:
- a `LiveIssues` whose pipeline takes a seventh validator;
- dirty rules to which `expand_scope` joins;
- a probe cache key waiting for `artifacts_version`;
- the `reaches validation rules` refusal to delete.

Open from this plan: `C-23`.
