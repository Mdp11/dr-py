# Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine compiles, reaches and evaluates the project's custom validation rules — committed and staged — inside its live issue store, so the Issues panel, Validate and the model half of the commit preview answer with rules from the engine exactly as the server's routes do; the server parses rule YAML once, for the engine, through `POST /rules/parse` and a `rules` field on `GET /artifacts/payloads`. The plan also folds in three performance items the owner scheduled here: K-59 (the sweep's first step), K-60 (`uniqGroupOf` re-keying) and K-61 (a probe on every refetch).

**Architecture:** Plan 3 of 8 for sub-project C (`architecture/program.md`). Bottom-up: (1) the server's wire form of a rule set — a normalized JSON document sent as text — behind `/rules/parse` and the payloads route; (2) an engine port of the rules package, `src/rules/` (document reader, compile with its drift check, reach, evaluation), held to three golden families; (3) rules inside `LiveIssues`: a seventh validator, reach joined to every dirty set, a committed and a working compile, a background rescan when a rule set changes, and origins across a staged rule-set change; (4) the service: rule sets follow the artifact methods, the `reaches validation rules` 501 goes, the issue methods wait for a rescan, the parity run at M carries rules; (5) the three performance items, each measured before and after; (6) the shell: the parse result travels with committed and staged artifacts, the fallback and the shadow follow; (7) e2e and the documents.

**Tech Stack:** TypeScript 6 (`strict`, erasable syntax, `lib: ["ES2023"]`, no DOM or Node in `engine/src/`), vitest 3, Svelte 5 runes, zod, MSW, Playwright; Python 3.14 (FastAPI, pydantic v2, PyYAML, pytest, ruff); pixi for every command.

**Spec:** `docs/superpowers/specs/2026-09-24-evaluation-design.md`. This plan covers §3 `### Rules`, §1's `document` and `/rules/parse`, §3 "Origins" for `artifacts_version` (settled differently here, D10), §7's plan-3 families, and §8's plan-3 freeze row. §7's Python test "the lint route's candidate document" is `/metamodel/lint`'s, and so plan 7's, not this plan's. §9 lists the `architecture/` edits that ride with the code. Read first: `architecture/contracts.md` (CT-4, CT-5), `architecture/decisions.md` (AD-22, AD-26, AD-28, AD-30, AD-31, AD-32), `architecture/program.md` (MR-1…MR-4), `architecture/conventions.md`. Then `src/data_rover/core/README.md` (rules in the pipeline), `src/data_rover/api/README.md` (rules, artifacts), `engine/README.md` (`src/validation/`, `src/artifacts/`, `src/service/`, golden fixtures), `frontend/src/lib/engine/README.md` (surfaces, the `issues` gate, fallbacks, shadow) and plan 2 (`docs/superpowers/plans/2026-09-24-eval-validation-core.md`), whose store, dirty rules and probe this plan extends.

**What kind of plan this is.** It gives direction with specifics, as plans 1 and 2 did: interfaces, signatures, the test cases and what each asserts, the order, and a full account of the mechanisms that are easy to get wrong. It holds no full code. The expected results of the "see it fail" steps are reasoned from the code, not observed. If one does not appear, trust the run, read the step's intent, and say so in the hand-back. What WAS checked while planning is listed next, each with how.

## What planning found

Facts the plan rests on, checked against the code at `2cca78a` or with throwaway probes (Python 3.14 through `pixi run -e core-dev`, `PYTHONPATH=src`; the probes are in the planning session's scratchpad, `probe_doc.py`, `probe_sem.py`, and the tracers' `trace-server-rules.md`, `trace-shell-rules.md`).

1. **The grammar and its caps** (`core/validation/rules/schema.py`).
   - A rule set is `RuleSetDefinition {schema_version: 1, rules: Rule[]}`, at most 200 rules, names unique. A `Rule` is `{name, description = "", applies_to, severity = "error" | "warning", disabled = false, when = null, then, message = null}`.
   - A condition is `{all: [...]}`, `{any: [...]}`, `{not: …}`, a property atom or `{relationship: {type, direction, to?, where?, exists? | count?}}`, disambiguated by keys (`extra="forbid"`). Nesting is at most 8 levels (`condition_depth`), `where` counting one.
   - A property atom has `property` and EXACTLY one test among `exists, equals, not_equals, in, gt, gte, lt, lte, contains`, chosen by `model_fields_set`. Only `equals` and `not_equals` may be `null`.
   - `count` needs at least one of `eq`, `gte`, `lte` (ints ≥ 0). A relationship atom needs exactly one of `exists` / `count`.
   - The YAML is loaded by a `SafeLoader` that refuses aliases; an empty document is an empty set; 64 KiB is the cap (`RULES_MAX_YAML_BYTES`).
   - *Probe:* pydantic coerces `gt: 1` → `1.0`, `lt: true` → `1.0`, `count: {eq: true}` → `1`; `in: [1, "1", true, 1.0, 1.5]` keeps each type.
2. **The document the engine can receive.** *Probe (`probe_doc.py`):*
   - `model_dump(mode="json")` — spec §3's wording — is NOT a usable wire form. It writes the keys `in_` and `not_`, writes every unset test as `null` (so `equals: null`, a real test, reads as "unset"), and fails re-validation.
   - `model_dump_json(...)` writes `inf` as `null`.
   - `json.dumps(defn.model_dump(mode="python", by_alias=True, exclude_unset=True))` round-trips: re-validating it gives an equal definition with the same `model_fields_set` (a `NaN` operand aside, since `nan != nan`). It keeps `Infinity` / `NaN` as bare literals, integers past 2^53 exact, and floats with their `.0`. Defaults the author did not write are absent (`schema_version`, `description`, `severity`, `disabled`, `when`, `message`).
3. **Compile** (`rules/compile.py`).
   - Sources compile in order. A source whose YAML fails to parse gives ONE diagnostic `{artifact_id, set_name, rule: "", reason: str(RuleSetError)}`; the lint route's `errors[0].message` is the same `str(exc)`.
   - A disabled rule is dropped BEFORE the drift check: it is neither counted nor listed.
   - The drift check walks `when` then `then` and stops at the first mismatch: `unknown stereotype {applies_to!r}`; `stereotype {context!r} has no property {property!r}` against the DECLARED type's effective properties (not the subtype union); `unknown relationship type {type!r}`; `unknown stereotype {to!r}`. A `where` is checked against `to`'s properties, and not at all when `to` is absent. The reasons use `repr`.
   - A compiled rule is `{artifact_id, rule, applies_types = element_descendants(applies_to), check = "rule:<name>", paths}`. `rules_by_type[t]` lists the compiled rules applying to `t` in compile order. `total` is the number of compiled rules.
4. **Where rule sets come from and in what order.** `rule_sources` lists `validation_rules` rows in `content.list_artifacts` order, which is `ORDER BY kind, name` with no tie-break (`api/content.py:463`); artifact names are not unique (no constraint in `db_models.py`). The YAML is `payload["yaml"]`; a non-dict payload degrades to `""`, an empty set. Postgres sorts `name` by its collation, SQLite by code point.
5. **Reach** (`rules/reach.py`).
   - `derive_paths` gives, per relationship atom, a root-first path of steps `{rel_types = relationship_descendants(type), direction, far_types}`, a `where` extending its atom's path as a prefix; property atoms add none.
   - `expand_scope(model, compiled, dirty_ids)`: seeds are the dirty ids that are CURRENT elements (relationship ids and deleted ids drop out). For each rule, each path, each depth `d`, it walks `steps[d-1] … steps[0]` backwards (an `outgoing` step through the frontier's incoming relationships, of a type in `rel_types`, to their sources; `incoming` the other way). The far types are never used to filter. Each reached element whose type is in the rule's `applies_types` is kept, the frontier sorted. The output is the kept ids, first-seen order.
   - *Probe (`probe_sem.py`):* with a rule `B –R→ C where s exists` and a rule `B ←R–`, reach from `c1` is `['e1']`, and from `e1` `['e3', 'c1']`.
6. **Evaluation** (`rules/validator.py`). *Probe (`probe_sem.py`), each against one element:*
   - `_eq` is Python `==` with a guard: a `bool` never equals a non-`bool`. `n: 1.0` equals `1`, `n: True` does not equal `1`, `2**60` does not equal `2**60 + 1`.
   - A value is missing when absent, `None` or `[]` (a `{}` is present). Missing fails every test except `exists` — `not_equals` included.
   - `equals: null` never holds for a present value; `not_equals: null` always does.
   - A list value holds if ANY item passes (`in: [x, 2]` holds for `['x', 'ab']` and for `[2.0]`); `contains` on a list is membership by `_eq` (`contains: a` fails on `['x', 'ab']`); `contains` on a string is a substring test and needs a string operand.
   - `gt / gte / lt / lte` need an `int` or `float` value that is not a `bool`; anything else fails.
   - A relationship atom counts the element's outgoing (or incoming) relationships whose type is in `relationship_descendants(type)`; with `to` or `where`, the far element must be of a type in `element_descendants(to)` and pass `where` (evaluated on the far element). `exists: b` is `(n > 0) is b`; `count` is the conjunction of its bounds.
   - The issue is `{severity, message, target_ids: [el.id], category: CONFORMANCE, check: "rule:<name>"}`, the message `rule.message` or `Rule '<name>' violated` plus `: <description>` when there is one. The quotes are literal, not `repr`.
7. **`eval_errors` cannot move.** The validator catches an exception per rule, counts it under its check and merges the counts into the compile once per run (`validate_global`), cumulatively for the life of the `CompiledRules` — `reset_eval_errors` has no caller. No evaluation path raises: every comparison is total, the depth is capped at 8, and **a model cannot hold a dangling relationship** (`Model.insert_relationship` and the loader refuse a missing end, `core/model/model.py:201-204`, `api/routes/_snapshot.py:126-133`), so the "dangling far end" skip is unreachable too. On both sides `eval_errors` is always `{}`.
8. **The pipeline with rules.** `pipeline_for(compiled)` is `[*default_validators(), RulesValidator(compiled)]`, one per run: the rules validator is the seventh, has no relationship hook, stamps its own checks, and its global hook returns nothing.
9. **The server's rule-set lifecycle** (`trace-server-rules.md`).
   - Hydration compiles the sources, then the sweep runs with them (and rebuilds its pipeline if the compile changes mid-sweep).
   - `POST /commits` step b4 recompiles BEFORE validating when the batch rebinds or `rules_touched` (a rules artifact created, changed or deleted). A non-rebind batch then runs `expand_dirty`, adds `applies_population(model, prior, new)` (sorted types, each type's ids sorted), validates that scope with the NEW rules and splices it — synchronously, under the write mutex (`routes/commits.py:1104-1151`).
   - The strict gate is `attributable_issues(conformance, base_dirty)`: an issue owned by an entity the batch touched (before any widening), or any `rule:` issue anywhere in the scope — warnings included, since there is no severity filter (`:1185-1188`).
   - `POST /commits/preview` never assigns the compiled rules: it always validates with the COMMITTED rules, and a staged rules artifact contributes nothing (`:590-598`). So on a strict project, staging a rule that fails on existing elements, the preview says `would_block: false` and the commit answers 422. `POST /model/validate` with ops uses the committed rules too.
   - `/model/ops` is model-only. Its `_finalize` runs `expand_dirty` then a scoped `session_pipeline` pass.
   - `/model/undo` recompiles too and adds the population before `_finalize` (`routes/ops.py:1205-1212`). The engine sees an undo as a delta plus an artifact event, so K-66 covers its window.
   - The legacy artifact CRUD routes never recompile (a change waits for rehydration).
10. **`rules_status`.** `RulesStatusOut {total, skipped: RuleSkipOut[], eval_errors: {check: n}}`, `RuleSkipOut {artifact_id, set_name, rule, reason}` (`api/schemas.py:156-174`), filled by `GET /model/issues` from the session's compile. There is no `applying` field.
11. **The lint route** (`api/routes/rules.py`). `POST /rules/lint {yaml}` (≤ 64 KiB, else 422) answers 200 `{ok, errors: [{message, line, column}], warnings: [{rule, message}]}`: one error on a parse failure, `line` / `column` 1-based from the YAML mark or `null`; drift is a warning with `ok` true. Viewers get 403: the route is not in the read-only POST allowlist, and a test holds it.
12. **`GET /artifacts/payloads`** answers `{items: [ArtifactOut]}` (header + `payload` as stored); a rules payload is `{schema_version: 1, yaml}`. Nothing parsed rides along.
13. **The engine as it stands.**
    - `setArtifacts`, `putArtifacts`, `setStagedArtifacts` are `now` methods (answered at once, in any state); `moveArtifacts` moves `issues_version` and posts a bare `changed` only when `resolvesKind('validation_rules')` flips (`service/service.ts:628-638`); `live()` refuses 501 `reaches validation rules` while such an artifact resolves (`:511`).
    - `readArtifacts` / `readStagedArtifacts` re-read what the shell hands in through `JSON.stringify` and the exact parser: a number inside `payload` has already lost its `1.0` in the shell. A document sent as a STRING field survives untouched.
    - `RelRec.source` / `target` are `ElementRec`s: the engine cannot hold a dangling end either.
    - `bodies.ts` hard-codes `rules_status: {total: 0, skipped: [], eval_errors: {}}`.
    - `LiveIssues.sweepSteps()` lists every id in its first step (K-59: 13 ms at M); `IndexSet.uniqGroupOf` computes `uniqKey` for every bucket member on every call (K-60); `origins()` probes once per `(rev, stagedVersion)` (K-61).
    - `Model.elements()` re-sorts the map (clear and refill) on the first ordered read after a restore at an old `ord`; a live `Map` iterator that crosses that re-reads everything (`engine/README.md`, `src/service/`).
14. **The shell as it stands** (`trace-shell-rules.md`).
    - `ArtifactSchema` strips unknown top-level keys (`payload` is a `z.record`); the follower's `wire()` sends `{id, kind, name, artifact_rev, payload}` (`lib/engine/artifacts.ts:54-60`); `compose()` merges an update into the create or update under it before the overlay is pushed.
    - Staged YAML is never parsed. The rules editor lints through `POST /rules/lint`, debounced 500 ms; Save is disabled only while the LAST lint answer has errors, so YAML saved inside the debounce can be unparseable.
    - `FALLBACKS` maps `reaches validation rules` → `'rules'`, answered by the server unmarked and never shadowed.
    - The shadow compares every non-list key of an issues body deep, `rules_status` included. `IssuesPanel` reads only `rules_status.skipped` (the banner).
    - The `issues` gate is `staging: engine && seeded && follower.loaded()`. `seeded` is set by the first `sweep` progress with `done === total` after `ready`; a later `done: 0` does not unset it.
    - The follower swallows every send's error (`sync.ts:548-550`): a 422 from the engine leaves its old artifacts in place silently.
    - The shadow's `staged()` is true while the model or the artifact buffer holds anything, or the follower holds an overlay.

## Decisions

Taken with the owner (2026-09-25):

- **D1. The preview's model half uses the COMMITTED rules**, exactly as the server's preview does (fact 9). A staged rule set shows in the Issues panel and in Validate, not in the preview. The server's gap — a preview that says "lands" before a strict commit that 422s on a staged rule — stays on both sides and is recorded as `K-65`, for a later fix on both sides.
- **D2. An issues read waits for a rule-set change to be applied.** The rescan runs in the background; `getModelIssues`, `validateModel` and `previewCommit` are answered once it has ended, as `validateModel` already waits for a sweep. Typing is never blocked. There is no `rules_status.applying` field (spec §3's is dropped).
- **D3. Origins are exact across a staged rule-set change.** The probe also validates the changed rules' population on both states (M7). The cost is O(changed-rule population) once per change: the part outside the model-dirty set is cached per `(rev, rulesVersion)` (M7), so a keystroke does not pay it again. It is reported at M.
- **D4. K-59, K-60 and K-61 are fixed in this plan** (Task 5), each measured before and after.
- **D5. Strict enforcement, `validation_error_count`, the artifact and view half of the preview, and rebind previews** stay as plan 2 left them (server-side until F; rebinds until plan 7).

Taken by this plan. Each is small and reversible at review; say so if one is wrong:

- **D6. The document crosses as text.** `/rules/parse` and the payloads route carry one object per rule set, `RulesParseOut {ok, document, errors}`:
  - `document` is `json.dumps(defn.model_dump(mode="python", by_alias=True, exclude_unset=True), ensure_ascii=False, separators=(",", ":"))` — a STRING (fact 2), `null` when `ok` is false. The shell never parses it; the engine reads it with `parseJson`. This is AD-26's rule extended to rule sets: `JSON.parse` would lose `1.0` and integers past 2^53.
  - `errors` is the lint route's one `LintErrorOut` on a parse failure, `[]` otherwise.
  - Rejected: `document` as a JSON object (the shell's `JSON.parse` and the engine's re-serialization lose exactness), `model_dump(mode="json")` (fact 2), a YAML parser in the engine (spec decision 4).
- **D7. Where it rides.**
  - Payloads: each item gains `rules: RulesParseOut | null` — the parse of `payload["yaml"]` (a non-dict payload parses `""`, as `rule_sources` does) for a `validation_rules` row, `null` for any other kind. A new `ArtifactPayloadOut(ArtifactOut)` carries it, so no other route's body changes.
  - Staged entries: a create, or an update with a `payload`, of a rules artifact carries `rules: RulesParseOut | 'pending'`. The shell parses through `/rules/parse` and pushes the entry as `'pending'` until the answer lands (spec §1).
  - `'pending'` keeps the last parse the engine received for that id — for an update, the committed one at first; for a create, none, so the set contributes nothing yet.
- **D8. Two compiles: committed (C) and working (W).** C compiles the committed layer's rule sets; W compiles the working view (the staged overlay laid over it). Sources compile in name order by code point, then by id (fact 4). This matches the server wherever the server's order is defined; with equal names, or under a Postgres collation, only the order of one owner's issues can differ, and nothing compares it.
- **D9. A rule-set change.**
  - The artifact methods stay `now` methods (spec §1 left this to plan 3). A `now` method never interleaves with a transition, and each sweep step reads the compile afresh.
  - After an artifact method, and when a replica becomes `ready`, the service compiles W and C from the `ArtifactSet`. It does so only when their inputs changed: the ordered `(id, name, rules)` of the sets.
  - When W's ORDERED list of rule identities changes, `applies_population(old W ∪ new W)` joins a rescan queue. A rule's identity is its document entry as the exact serializer writes it. The rescan queue is drained by the sweep slot after any full sweep; it reports no progress.
  - A change of W or of C moves `LiveIssues.version`, and so `issues_version`: `rules_status` or the tags may have moved.
- **D10. The probe's cache key is `(rev, stagedVersion, rulesVersion)`.** `rulesVersion` moves whenever W or C changes. The spec's `artifacts_version` is NOT added here: only rules reach the store, and a table edit (which pushes `setStagedArtifacts` on every change) must not re-probe. Plan 4 adds `artifacts_version` for its table cache.
- **D11. Reach joins every dirty set.** The expansion always runs on the AFTER state, with W's paths:
  - stage: after the hooks (Python's `_finalize` order);
  - rebase and coalesced edit: after the neighbourhoods;
  - probe: after the replay's hooks.

  The premise, which the seeded invariants hold (Task 3), is M5's.
- **D12. `rules_status` comes from W.** With nothing staged W equals C, so it equals the server's. Each compile keeps its own `eval_errors`, merged once per run by the runs that used it. It is always `{}` (fact 7), and the catch stays so that a user rule can never break validation.
- **D13. A document the engine cannot read refuses, it does not guess.** The engine's reader is strict. A document it refuses — only a server and a sandbox bundle of different versions could produce one — makes the issue methods answer 501 `reaches unreadable rules`, which the shell maps to its `'rules'` fallback (the server answers). The flag clears when the set changes. `reaches validation rules` is deleted.
- **D14. The shadow.**
  - `validateModel` is not compared while a staged rules entry exists (the server knows no staged rules).
  - `previewCommit` keeps plan 2's rule: both sides use the committed rules (D1).
  - `getModelIssues` keeps `'unstaged'`, which already covers the artifact buffer (fact 14).
  - The issues normalizer also sorts `rules_status.skipped` (D8's order is not the server's under Postgres).
- **D15. K-60 on the engine side only.** The fix caches key texts; behaviour is unchanged, so no fixture moves. The Python core's same shape (the server's sweep) stays in K-60, re-scoped to the server; `core/model` is frozen.
- **D16. K-61: the Issues panel's refetch stops re-probing per keystroke.** `getModelIssues` tags through an incremental origin set (M9). `previewCommit` and `validateModel`, explicit actions, keep the exact probe.
- **D17. K-59: the sweep lists in steps.** It uses a live iterator guarded by the model's order epoch (M9). The browser bench's two ping loops are separated before the row is read again.
- **D18. A Python bug found while porting lands on both sides with a fixture step** (MR-3, ruling R18). None is known. The server-side additions of Task 1 are new routes, not changes to frozen behaviour.

## Global Constraints

- Everything runs through pixi. There is no global `node` or `python`: use `pixi run <task>`, `pixi run -e core-dev …`, `pixi run -e frontend …`.
- **Branch and commits.** Work on `feat/eval-rules`, cut from `engine-migration`. Task 1 cuts it, and Task 7 fast-forwards `engine-migration` to it, with the owner's go-ahead. Never touch `main`, never push. Commit per the owner's answer at plan approval (recorded in the build handoff). One commit per task.
- **Freeze (MR-3).**
  - `core/model`, `core/metamodel` and the model-op applier stay frozen. So do plan 1's and plan 2's areas.
  - From Task 1 on, `core/validation/rules/` and `api/rules.py` are frozen too (spec §8's plan-3 row): no behaviour change; a bug lands on both sides with a fixture (D18).
  - `src/data_rover/` changes only in Task 1, and only in `api/routes/rules.py`, `api/routes/artifacts.py` (the payloads route) and `api/schemas.py`, plus their tests and `api/README.md`.
  - The Python core is the oracle: fix the engine, never a fixture. Fixtures change only through `pixi run golden-fixtures`.
- **Engine `src/` rules:**
  - No DOM, no Node built-in, no timer or clock, no `Math.random`, no `Intl`, and no locale comparison (RC-4, RC-5).
  - Erasable syntax only, `.ts` import specifiers, and no `any` in an exported signature.
  - Strings compare by `cmpCodePoint`. A substring test is `pyContains`.
  - `repr` is `pyRepr` / `pyFloatRepr` / `pyReprValue`.
- Tests import the engine through `engine/src/index.ts` only. Engine and frontend tests run the real engine, never a mock, without fake timers. Every in-process link is `dispose()`d.
- A steps generator publishes nothing before its last step, EXCEPT the sweep. Each sweep or rescan step is a complete splice. The sweep may hold an iterator across a yield only under M9's order-epoch guard.
- A transition runs to completion. Its incremental revalidation, reach included, is part of it (AD-23). Nothing live leaves the service: results go through `toWire` / the `wire*` functions.
- **Lint and checks.**
  - `pixi run engine-tidy` for `engine/`, and `pixi run dr-tidy` for the rest.
  - On every file under `tests/` and `scripts/`, run `pixi run -e core-dev ruff check <files>` and `ruff format <files>` by hand.
  - `pixi run engine-check` and `pixi run frontend-check` must pass.
- A "see it fail" step lists the tests it expects red. Any OTHER red test is a finding to report, not to silence.
- Comments and docstrings: concise, present-tense, only for what the code cannot say. No references to specs, plans or `architecture/` ids in code (RC-6).
- `architecture/`, the READMEs, `BACKLOG.md` and `BACKLOG-ENGINE.md` change in the commit of the code they describe (RC-10). `docs/` and `benchmarks/` are git-ignored: never `git add -f`.
- Commit subjects: one imperative sentence, capitalized, with no prefix and no trailing period. The message ends with the session's `Co-Authored-By` line.
- Ids: the next free are `AD-33`, `K-65`, `C-24`, `T-11` and `U-11` (grep before use; K ids are unique across both backlogs).
- **Baseline** at `2cca78a` (2026-09-25):
  - core: 2,575 passed / 34 deselected;
  - frontend: 3,008 tests in 283 files;
  - engine: 1,214 tests in 78 files;
  - sandbox: 14 tests;
  - e2e: 63 passed and 2 failed; the two failures are the pre-existing T-8 and T-9, with no `[shadow]` lines;
  - `pixi run engine-parity-large`: equal over 7,708 injected issues.

## Review Focus

These are the six conditions most likely to bite a user that the tasks' ordinary tests would not reach. Each has its test in the task named.

1. **Reach through a rebase.** An unstage or a delta moves a relationship, or a property two hops from a rule's owner. The owner's verdict must be revalidated in the same transition, though no Python hook names it. The store must equal a fresh sweep after every action of the seeded runs, with multi-hop rules in play. *Task 3.*
2. **A rule-set change while things move.** A rules artifact is staged, re-staged, committed or deleted mid-sweep, mid-rescan, with model edits staged, and during a delta. The finished store must equal a fresh sweep under the final rules, and an issues read posted meanwhile must answer the final state, never a half-rescanned one. *Tasks 3 and 4.*
3. **Origins across a staged rule set.** With a staged rule set and staged edits:
   - a new rule's issues read `uncommitted`, an unchanged rule's `on_server`;
   - Validate lists the removed rule's issues as `resolved`;
   - the preview matches the server's (committed rules);
   - the probe leaves no trace.

   *Task 3.*
4. **The startup and commit windows.**
   - Artifacts arrive after the first sweep: the gate stays closed until the follower has loaded, and the first engine read waits for the rescan.
   - The user commits a staged rules create: its `tmp_` id becomes a real one, the overlay is held until the fetch lands, and no issue appears twice or flips back to `uncommitted`.

   *Tasks 4 and 6.*
5. **The panel's tags without a probe per keystroke** (K-61). After every action of the seeded runs, the incrementally tagged list must equal the list an exact probe tags. *Task 5.*
6. **A project the engine cannot read.** A document the engine's reader refuses, or a facet pattern outside the translator, sends every issues call to the server. Nothing half-validated is shown. *Tasks 4 and 6.*

---

## File Structure

```
src/data_rover/api/schemas.py                 + RulesParseRequest, RulesParseOut, ArtifactPayloadOut
src/data_rover/api/routes/rules.py            + POST /rules/parse, rules_document(), parse_result()
src/data_rover/api/routes/artifacts.py        payloads items carry `rules`
src/data_rover/api/README.md                  the two routes
tests/api/test_rules_parse.py                 (new) the route, the document's round trip, 403, 422
tests/api/test_artifact_payloads_route.py     + `rules` on rules rows, `null` on others

tests/golden/model_steps.py                   + `rules`, `reach` steps; `expand` on `batch`; rules in
                                                `validate`, `seed`
tests/golden/scenarios/rules_compile.py       (new) parse bodies, compiles, drift, disabled, order
tests/golden/scenarios/rules_eval.py          (new) every semantic of fact 6
tests/golden/scenarios/rules_reach.py         (new) expand_scope and dirty sets widened by it
tests/golden/scenarios/validation_steps.py    + part 3: a seeded session with rules
tests/golden/scenarios/__init__.py            registers the three

engine/src/rules/document.ts                  (new) RuleSetDoc AST, readRuleSet (strict)
engine/src/rules/compile.ts                   (new) RuleSource, CompiledRules, compileRuleSets,
                                                appliesPopulation, ruleIdentity
engine/src/rules/evaluate.ts                  (new) pyRuleEq, evaluateCondition, RulesValidator
engine/src/rules/reach.ts                     (new) derivePaths, expandScope
engine/src/rules/sources.ts                   (new) rule sources of an ArtifactSet (committed, working)
engine/src/artifacts/artifact-set.ts          `rules` on wire artifacts and staged entries; committed view
engine/src/validation/pipeline.ts             validateScoped(…, rules)
engine/src/validation/live.ts                 rules: W and C, setRules, rescan, reach, origins, settled
engine/src/validation/bodies.ts               rules_status; preview on C with hooks as base_dirty
engine/src/validation/validators/uniqueness.ts  reads cached key texts (K-60)
engine/src/model/indexes.ts                   key texts cached for shared buckets (K-60)
engine/src/model/model.ts                     orderEpoch (K-59)
engine/src/service/service.ts                 rules follow the artifacts; refusals; reads wait
engine/src/index.ts                           exports
engine/bench/run.ts                           + rules rows; K-59/K-61 rows
engine/bench/parity-large.ts                  + rules
scripts/issues_large.py                       + a rule set over M
engine/test/rules/*.test.ts                   (new) compile.golden, eval.golden, reach.golden, document
engine/test/validation/{live,probe,steps.golden}.test.ts  + rules
engine/test/working/invariants.test.ts        + rules, rule-set changes, K-61 tags
engine/test/service/issues.test.ts            + rules
engine/test/model/indexes.test.ts             + cached key texts
engine/test/golden/model-steps.ts             replays the new steps

frontend/src/lib/api/types.ts                 RulesParseSchema; payload items' `rules`
frontend/src/lib/api/rules.ts                 + parseRules
frontend/src/lib/api/engine-route.ts          FALLBACKS: 'reaches unreadable rules' → 'rules'
frontend/src/lib/api/validation.ts            validateModel's shadow with staged rules
frontend/src/lib/engine/rules-parse.ts        (new) the parse cache and `attachRules`
frontend/src/lib/engine/artifacts.ts          wire() passes `rules`; staged pushes attach parses
frontend/src/lib/engine/shadow.ts             sorts rules_status.skipped
frontend/src/lib/state/artifact-edits.svelte.ts  hasStagedRules()
frontend/src/lib/state/replica.svelte.ts      the follower gets the parser
frontend tests under the touched modules' __tests__/; frontend/e2e/eval-rules.spec.ts (new);
frontend/bench/main.ts                        the two ping loops separated (K-59)

architecture/{contracts,decisions,program}.md, engine/README.md, frontend/src/lib/engine/README.md,
frontend/README.md (issues and rules), src/data_rover/core/README.md (the freeze note),
BACKLOG.md, BACKLOG-ENGINE.md
```

`src/rules/` depends on `src/model/`, `src/metamodel/`, `src/value/` and `src/artifacts/` (types). `src/validation/` imports `src/rules/`. The service imports `live.ts`, `bodies.ts` and `rules/sources.ts`.

## Mechanisms

The tasks refer to these. Read them before the task that uses them.

**M1 — The wire form of a rule set** (server, Task 1).

- `rules_document(defn: RuleSetDefinition) -> str` is D6's `json.dumps(…)`, with `allow_nan` left at its default, so `Infinity` and `NaN` are written bare.
- `parse_result(yaml: str) -> RulesParseOut`:
  - on success, `ok=True, document=rules_document(parse_rule_set(yaml)), errors=[]`;
  - on `RuleSetError`, `ok=False, document=None, errors=[<the lint route's one LintErrorOut>]`.

  The lint route's error-building is factored into a helper both routes call, so the texts and positions cannot drift.
- `POST /rules/parse {yaml}` → `RulesParseOut`: 200 for any string `yaml`; 422 for a malformed envelope or `yaml` past 64 KiB (`RulesParseRequest`'s `max_length`, as `RulesLintRequest`); 403 for viewers (not added to the read-only allowlist). It reads no model and no session state.
- `GET /artifacts/payloads`: each item is an `ArtifactPayloadOut` — `ArtifactOut` plus `rules` (D7). The field goes last, so existing key order holds.

**M2 — Reading a document** (`rules/document.ts`).

- `readRuleSet(text: string): RuleSetDoc` parses with `parseJson`, then walks the value strictly. It throws `RulesUnreadable` (a plain `Error` subclass) on anything the grammar of fact 1 does not allow: an unknown key, a wrong type, zero or two tests, a `null` on a test other than `equals` / `not_equals`, an empty `all` / `any`.
- **Presence as pydantic reads it.** A property atom's test is chosen by KEY presence (`model_fields_set`): `equals: null` is a test. Everywhere else a validator checks `is None`, so an explicit `null` equals absence:
  - "exactly one of `exists` / `count`" counts the non-null ones;
  - a `count` needs one non-null bound among `eq` / `gte` / `lte`;
  - `to`, `where`, `when` and `message` accept `null`;
  - `in: []` is valid (it never holds).

  *Probe (reviewer):* `{"relationship":{"type":"R","direction":"outgoing","to":null,"where":null,"exists":null,"count":{"eq":null,"gte":1}}}` passes pydantic. A reader stricter than pydantic would refuse a legitimate project for good (D13), so `document.test.ts` holds these cases.
- Absent defaults are filled in as pydantic does: `description` `""`, `severity` `'error'`, `disabled` false, `when` / `message` / `to` / `where` `null`.
- The AST:
  - `PropertyAtom {property, test}`, where `test` is `{op: 'exists', value: boolean}`, `{op: 'equals' | 'not_equals', value: Scalar | null}`, `{op: 'in', values: Scalar[]}`, `{op: 'gt' | 'gte' | 'lt' | 'lte', bound: PyFloat}` or `{op: 'contains', value: Scalar}`. `Scalar` is `string | boolean | number | bigint | PyFloat`, as the exact parser gives them: floats are always `PyFloat`, and integers past 2^53 are `bigint`.
  - `RelationshipAtom {type, direction, to, where, exists: boolean | null, count: {eq, gte, lte} | null}`.
  - `{all}`, `{any}`, `{not}`, and `Rule`.
- The reader keeps, per rule, its `identity`: the rule's entry as `pyDumps` writes the parsed value, compact (D9).

**M3 — Compile** (`rules/compile.ts`, `rules/sources.ts`). A line-for-line port of `compile.py`.

- `RuleSource {artifactId, name, parse: RulesParse}`, where `RulesParse` is `{ok: true, document: string} | {ok: false, errors: {message: string}[]}`.
- `compileRuleSets(sources, mm): CompiledRules`:
  - `ok: false` gives one skip `{artifact_id, set_name, rule: '', reason: errors[0].message}`.
  - An unreadable document (M2) sets `unreadable: true` on the compile and contributes nothing else.
  - Disabled rules are dropped before the drift check. The drift reasons are fact 3's, with `pyRepr`.
  - `appliesTypes` is `mm.elementDescendants(appliesTo)`, `check` is `rule:<name>`, and `paths` comes from M5.
  - `rulesByType` is a `Map<type, CompiledRule[]>` in compile order.
  - `evalErrors` is a `Map<check, number>`, `total` is `rules.length`, and the identities are the ordered list of the compiled rules' `identity`.
- `appliesPopulation(model, ...compiled)`: the union of the applies types, sorted by code point; for each, the element ids of exactly that type, sorted by code point; deduped in first-seen order.
- `ruleSources(set: ArtifactSet, layer: 'committed' | 'working'): RuleSource[]` — every id that resolves in that layer to kind `validation_rules`, in name order by code point, then id (D8).
  - Committed: the committed artifact's `rules`.
  - Working: the staged entry's `rules` when it carries a payload, `'pending'` falling back to the last parse received for that id (D7); otherwise the committed one. The `ArtifactSet` keeps that `Map<id, RulesParse>`, written whenever a committed artifact or a staged entry arrives with a parse. An id's staged parse is dropped from it when its staged entry goes (a discard), so `'pending'` after a discard falls back to the committed parse, the compile the engine last had. Reading sources never writes it.
  - A `validation_rules` artifact that arrives with no parse — a committed one with `rules` absent or `null`, a staged create or update-with-payload with `rules` absent — marks that layer's compile `unreadable` (D13). Only an older shell or a skewed bundle sends one; answering without its rules would be a guess.
  - A `'pending'` create with no earlier parse is left out: the shell will send its parse (D7).

**M4 — Evaluation** (`rules/evaluate.ts`).

- `pyRuleEq(value: Value, operand: Scalar | null): boolean` is `_eq` as fact 6 has it:
  - a `null` operand never matches;
  - a boolean operand matches only a boolean, `===`;
  - a string operand matches only a string, `===`;
  - a numeric operand (`number`, `bigint`, `PyFloat`) matches a numeric value that is not a boolean when the two are mathematically equal. Unwrap `PyFloat`; compare a `bigint` and a `number` with `==`, which JavaScript defines exactly; `NaN` never matches;
  - a list or a dict never matches.
- `testScalar(test, value)` follows `_test_scalar`. `not_equals` is `!pyRuleEq`, so a list item passes it. `contains` needs both sides to be strings and uses `pyContains`. The bounds need a numeric non-boolean value and compare exactly (a `bigint` against a `PyFloat` bound, `NaN` false, `Infinity` total).
- `evaluateProperty(el, atom)` follows `_eval_property`:
  - present is `value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)`;
  - `exists` compares presence;
  - missing fails;
  - a list value is membership for `contains`, and any item otherwise.
- `evaluateRelationship(el, atom)`:
  - it walks `el.out` or `el.in`, keeping the relationships whose type is in the atom's memoized `relationshipDescendants(type)`;
  - with `to` or `where`, it filters the far element by `elementDescendants(to)` and by `where`;
  - it counts;
  - `exists` compares `n > 0`, and `count` compares each present bound as a mathematical value.
- `class RulesValidator implements Validator` has `checkName: ''`, built per run over one compile.
  - `validateElement` runs `rulesByType.get(el.typeName)` in order. For each rule: skip it when `when` fails; push the issue when `then` fails. Any throw is caught and counted under the rule's check.
  - `validateGlobal` merges the run's counts into `compile.evalErrors` once.
  - The issue is fact 6's. The custom message is used when it is truthy (Python's `or`): an empty `message` falls back to `Rule '<name>' violated`. Not `??`.

**M5 — Reach** (`rules/reach.ts`).

- `derivePaths(rule, mm)` and `expandScope(model, compiled, dirtyIds): string[]` port `reach.py` line for line (fact 5): seeds filtered to current elements, the backward walk with no far-type filter, applies-type kept, frontier sorted by code point, first-seen order. An `outgoing` step walks `el.in`, an `incoming` step `el.out`.
- **The premise.** A rule's verdict on owner O reads O's properties and O's paths: chains of relationships of the path's types and the properties of the elements along them. Take a transition from state A to state B. If O's verdict changes, then on A or on B some path of O first meets an element that moved: an element whose properties changed, or whose incident relationships changed.
  - The dirty set of every transition holds each such element: the stage hooks add both ends of every relationship they create or delete, and every element they update or delete; the neighbourhood rule adds the ends of every relationship it touches, on both sides.
  - The prefix of O's path up to that element did not move, so it exists on B too, and walking back from the element on B reaches O. This holds whether the path is A's or B's.
  - `expandScope` on the AFTER state, over the dirty set, therefore reaches every owner whose verdict may have flipped, whichever state the path was on. The far types are ignored on the way, so a retype on the path cannot hide an owner.
  - Plan 2's first premise was wrong and only seeded invariants caught it, so Task 3 holds this one the same way: multi-hop rules over the seeded churn, the store checked against a fresh sweep after every action.

**M6 — Rules in `LiveIssues`** (`live.ts`, `pipeline.ts`).

- `validateScoped(model, ids, v, p, rules: CompiledRules | null)` runs a `RulesValidator(rules)` seventh, after the six, in every loop and in the globals.
- **State.** `LiveIssues` gains:
  - `rules: {working: CompiledRules; committed: CompiledRules}`, both empty compiles by default;
  - `rulesVersion`;
  - `rescan: {ids: string[]; at: number} | null`;
  - `settleWaiters`.

  `LiveIssuesOptions` gains `rules`.
- **`setRules({working, committed})`.**
  - It swaps both compiles. If W's identity list changed, it appends `appliesPopulation(model, oldW, newW)` to `rescan`. The ids already queued but not yet done stay, and a new id is appended once, so a second change mid-rescan loses nothing.
  - It bumps `rulesVersion` and `version`, and drops the origins cache.
  - It never validates.
- **Transitions.**
  - `stage`: the collector's hooks, then `dirty.update(expandScope(model, W, dirty.ids))`, then `revalidate` with W.
  - `unstage`, `applyDelta` and a coalesced `stage`: after `afterRebase`, the same expansion over the whole collector.
- **The sweep slot's generator** (`sweepSteps`) drains two things:
  - the full sweep, when one is due, first. Its progress is reported as today;
  - then the rescan queue, `sweepStep` ids a step, each step a `revalidate` with W. Its steps report no progress: the service forwards nothing for them, so the shell's `seeded` never moves on a rescan (fact 14). How the generator marks such a step is the implementer's choice.

  The generator ends when both are empty. `seeded` still means that a full sweep has ended.
- **`settled`** is `rescan === null`. `whenSettled(): Promise<void>` resolves when the queue empties, or when the store becomes unusable. `whenSwept` also waits for the rescan, since `validateModel`'s answer must reflect the rules.
- The sweep and the rescan read `this.rules` at every step, never a copy taken earlier.

**M7 — Origins and bodies with rules** (`live.ts`, `bodies.ts`).

- **Δ.** When W ≠ C, the changed rules Δ are the multiset difference of their identity lists, both ways. `ΔPop = appliesPopulation(working model, ΔW ∪ ΔC)`. An owner that exists on the committed side only is a staged delete, and it is in the hooks.
- **`origins()`** is cached per `(rev, stagedVersion, rulesVersion)`. It returns `{hooks, dirty, working, committed, previewDirty, preview}`:
  - `hooks` — the replay's collector, before any expansion: Python's `base_dirty`.
  - `dirty` — S_W = hooks ∪ `expandScope(working, W, hooks)` ∪ ΔPop. `working` is `validateScoped(S_W, working state, W)`. `committed` is `validateScoped(S_W, committed state, C)`, from `probeStaged`'s committed callback.
  - `previewDirty` — S_P = hooks ∪ `expandScope(working, C, hooks)`. `preview` is `validateScoped(S_P, working state, C)`. When W's identities equal C's, S_P = S_W and `preview` IS `working`, with no second run.
  - With nothing staged in the model, no rewind happens: `hooks` is empty and both halves run on the one state (S_W = ΔPop; empty when W = C).
- **The ΔPop part is cached.** The origins cache key moves with every keystroke (`stagedVersion`), so ΔPop must not be revalidated per probe.
  - Split ΔPop by S_M = hooks ∪ `expandScope(W, hooks)` ∪ `expandScope(C, hooks)`, the model-dirty part.
  - An owner of ΔPop inside S_M is validated in the probe as above.
  - An owner outside S_M has the same inputs on both states, for every rule of W and of C and for the six. So its issues are computed on the WORKING state alone, with W and with C, with no rewind. They are kept in `deltaOf: Map<owner, {working, committed}>`, valid per `(rev, rulesVersion)`.
  - A transition drops the entries of its dirty ids; the next probe recomputes them.
  - So while a rule set is staged, a keystroke's probe costs O(staged + the dirty sets since), and O(ΔPop) is paid once per rule-set change (D3).
- **Why S_W is enough.**
  - An owner outside S_W is not reachable from the hooks along W's paths, so every rule in both W and C gives it the same verdict on both states.
  - A rule in only one of them has its whole population in ΔPop.
  - The six built-in validators see the same state for it, as in plan 2.
- **Bodies.**
  - `issueListBody` tags as today over `dirty` / `committed`, and fills `rules_status` from W: `{total, skipped: [{artifact_id, set_name, rule, reason}], eval_errors: {…}}`, in the route's field order.
  - `validateBody` is as today over `dirty`, `working` and `committed`.
  - `previewBody(live, strict)` reads `previewDirty` / `preview`. `conformance_error_count` counts the conformance issues. `would_block = strict && preview.some(i => i.category === 'conformance' && (hooks.has(owner(i)) || i.check.startsWith('rule:')))` — `attributable_issues`, with no severity filter (fact 9).
  - `storeListBody` takes `rules_status` as a parameter; the plan-2 constant goes.

**M8 — The service** (`service.ts`).

- **Rules follow the artifacts.** `moveArtifacts(put)` runs `put`, then `rulesMoved()`:
  - if a `LiveIssues` exists, compile W and C from `ruleSources` over `wc.model.metamodel` when their inputs changed (D9), and `live.setRules(…)`. The inputs include the metamodel's identity: artifacts outlive `close` / `open`, and a reopen after a rebind brings a new metamodel whose drift results differ. `becomeReady` always compiles afresh;
  - if a rescan is now due, put the store's generator back in the sweep slot (`this.sweep(live)`);
  - `flushIssues()` then posts a bare `changed` if the version moved.

  `becomeReady` compiles before it builds `LiveIssues` and passes `rules`. The `resolvesKind` flip logic goes.
- **Refusals.** `live()` answers 501 `reaches unreadable rules` while W or C is `unreadable`, beside `reaches an unsupported pattern`. The `reaches validation rules` refusal is deleted.
- **Reads wait.** `issues(call, body, check)` and `validateModel` run their transition at once when `live.settled`. Otherwise they register on `whenSettled()` and submit the transition then, as `validateModel`'s second transition does today:
  - the answering transition checks `settled` AGAIN and re-registers if it is false. A `now` artifact method can land between the promise resolving and the transition running, and start a new rescan (Review Focus 2);
  - a waiting read joins the set that `dropIssues`, `diverge` and the failed-sweep path refuse (`service.ts:604-612`, `:733-738`), as `validating` does, so `close` answers it 409 instead of leaving it hanging;
  - still refused 409 `replica is not ready` if the store was replaced meanwhile;
  - never answered if cancelled;
  - `check` (stale `base_rev`, stale batches) runs in the transition that answers.
- **`issues_version`** moves through `live.version`, which a rule-set change moves (D9) and each rescan step that changes the store moves, at most one bare `changed` a slice, as the sweep's.

**M9 — The performance items** (Task 5).

- **K-59, listing in steps.**
  - `Model` gains `orderEpoch`, bumped by `byOrd` whenever it re-sorts either map.
  - The sweep holds an element iterator and a relationship iterator with the epoch it took them at. A step pulls up to `sweepStep` entries and records the MAXIMUM `ord` seen per kind. It is not the last: a restored entity sits at the map's end with a small `ord` until the next re-sort, and resuming from its `ord` would re-pull almost the whole model.
  - When the epoch moved, the step takes a fresh iterator and skips entries with `ord ≤` that maximum, a bounded number per step, yielding while it skips.
  - Correct because a `Map` iterator skips entries deleted before it reaches them and visits entries added before it ends. An entity restored at an old `ord` below the cursor, or created since, was validated by the transition that restored or created it.
  - The first step no longer copies every id: `total` is `elementCount + relationshipCount` at the start, and `done` counts entities pulled.
  - Entities created during the sweep are pulled too, so `done` can reach `total` early. The shell seeds the gate on the first `done === total` (fact 14). So `done` is capped at `total - 1` until the last step, which alone reports `done === total`.
- **K-60, cached key texts.**
  - `IndexSet` keeps `keyText: Map<ElementRec, string>` for the members of buckets holding two or more. `addToGroup` already computes the key: it stores it when the bucket is or becomes shared, and fills the first member's entry when a bucket turns shared. `removeFromGroup` deletes the entry, and deletes the last member's when the bucket returns to one.
  - **`rekey` refreshes the entry before its early return.** `rekey` returns early when the hash is unchanged (`indexes.ts:307-312`: "An unchanged hash is an unchanged bucket, whatever the key texts are"). A property edit, a containment re-parent (the owner is part of the key, `:256-258`) or a key-relationship change can move the text without moving the hash, and under `hashKey: () => 0` every rekey takes that return. So `rekey` computes the fresh text, bypassing the cache, and writes it into `keyText` when the element's bucket is shared. `rebuildSteps` clears the map with `buckets`.
  - A private `freshKey(el)` does the computing. `uniqKey(el)` reads the map first and falls back to it. `uniqGroupOf` and the uniqueness validator compare cached texts.
  - Memory is O(members of shared buckets). `verifyConsistent` gains a check that every cached text equals `freshKey`.
- **K-61, incremental tags for the panel.**
  - `LiveIssues` keeps `committedOf: Map<owner, Issue[]>`: the owner's COMMITTED issues, for the owners that may differ between the two states. It is valid for one `(rev, C identity)` and only while W = C.
  - **Filled by the exact probe.** Every owner of its S_W gets an entry, an empty list when it has no committed issue. The incremental mode starts there: it is off until the first exact probe after a reset.
  - **Filled by transitions.** In `revalidate`, before `replace`, each dirty id with no entry gets the store's CURRENT issues for it. Transitions only, never the sweep or a rescan, and only while the store is seeded and settled.
  - **Tagging.** `issueListBody` tags an issue `on_server` when its owner has no entry, and otherwise matches it against the entries as the committed multiset, as today.
  - **Resets.** A move of `rev` or of C, or W ≠ C, clears the map and falls back to the exact probe. So does a store not yet seeded or settled.
  - Why it is exact:
    - An owner with no entry was outside the last exact probe's S_W, so its working issues equalled its committed ones then. No transition has dirtied it since, so its verdict has not moved (the dirty sets are exact: plan 2's rules plus M5), and the committed state has not moved either. So its working issues still equal its committed ones.
    - An owner that got its entry from a transition had, just before that transition, working issues equal to committed (the same argument). So the store's issues at that moment ARE its committed issues, and they stay so while `rev` and C hold.
    - Scoped runs give each owner's issues independently of the rest of the scope: the entity hooks are per entity, uniqueness and containment report only the scoped id itself, and rules are per element. So an entry per owner is well defined.
    - The argument does not need the incremental set to contain the exact S. It could not: a replay's hooks see different groups than the hooks at stage time.
  - A keystroke that coalesces into an already-staged element adds entries for its neighbourhood, taken from the store, and runs no probe.
  - `previewCommit` and `validateModel` keep `origins()`: their S is part of their answer.

**M10 — The shell.**

- **Types.** `RulesParseSchema = {ok: boolean, document: string | null, errors: LintError[]}`; the payload item schema gains `rules: RulesParseSchema.nullable().optional()`.
- **`parseRules(yaml, cfg?)`** in `lib/api/rules.ts` → `POST /rules/parse`.
- **`rules-parse.ts`** — `createRulesParser(parse: (yaml: string) => Promise<RulesParse>)`:
  - `attach(entries, kindOf: (id) => string | undefined)` returns the entries with `rules` set on every create, or update-with-payload, whose kind is `validation_rules`: the cached parse of `payload.yaml`, or `'pending'`. A pending one starts a single parse per distinct text.
  - `onParsed(listener)` fires when a parse lands.
  - `settled()` resolves once no parse is out.
  - A failed parse is dropped from the cache and retried at the next `attach` of that text.
- **Follower** (`lib/engine/artifacts.ts`).
  - `wire()` passes `rules`.
  - Every staged push — `setStagedArtifacts` and `putArtifacts`' `staged` — goes through `parser.attach(compose(…), kindOf)`, `kindOf` reading the committed set it keeps. `onParsed` pushes the overlay again.
  - The follower's `settled()` also waits for the parser.
  - `replica.svelte.ts` builds the parser over `parseRules`, scoped to the project like `payloads`.
- **Route.** `FALLBACKS`: `'reaches unreadable rules' → 'rules'`; the `reaches validation rules` entry goes. This lands in Task 4, with the refusal it mirrors. Until Task 6 the shell sends no parse, so a rules project answers `reaches unreadable rules` (M3) and still reaches the server, and the frontend suite stays green in between.
- **Shadow.** `validateModel` passes `shadow: 'never'` while `hasStagedRules()` (a staged create of kind `validation_rules`, or a staged update or delete whose `header.kind` is), else plan 2's rule. `shadow.ts`' issues normalizer sorts `rules_status.skipped` by `JSON.stringify([artifact_id, rule, reason, set_name])`.

---

### Task 1: The wire form of a rule set · `critical-implementer`

**Files:**
- Modify: `src/data_rover/api/schemas.py`, `src/data_rover/api/routes/rules.py`, `src/data_rover/api/routes/artifacts.py`, `src/data_rover/api/README.md`, `tests/api/test_artifact_payloads_route.py`
- Create: `tests/api/test_rules_parse.py`

**Interfaces:**
- Produces:
  - `RulesParseRequest {yaml: str (≤ 64 KiB)}`.
  - `RulesParseOut {ok: bool, document: str | None = None, errors: list[LintErrorOut] = []}`.
  - `ArtifactPayloadOut(ArtifactOut) {rules: RulesParseOut | None = None}`; `ArtifactPayloadListOut.items: list[ArtifactPayloadOut]`.
  - `rules_document(defn) -> str` and `parse_result(yaml) -> RulesParseOut` in `api/routes/rules.py` (M1).
  - `POST /rules/parse`.

- [ ] **Step 1: Cut the branch.** `git switch engine-migration && git switch -c feat/eval-rules`.
- [ ] **Step 2: Write the failing tests** (the `client` fixture, `AUTH_HEADERS`, `seed_default_project`).
  - `test_rules_parse.py`:
    - a set using every feature of fact 1 answers `ok: true` and `errors: []`. Its `document`, read with `json.loads` and re-validated through the rule-set adapter, gives a definition equal to `parse_rule_set(yaml)`, rule for rule and condition for condition, with the same `model_fields_set`. It includes `equals: null`, `in: [1, "1", true, 1.0]`, `gt: 1` (written `1.0`), `count: {eq: true}` (written `1`), `lt: .inf` (written `Infinity`) and `equals: 123456789012345678901` (written exactly);
    - the exact `document` text of one small set, pinned (keys in the model's FIELD order — `name, description, applies_to, …` and `type, direction, to, where, exists, count` — not the author's; `in` and `not` aliased; no defaults the author left out);
    - unparseable YAML answers `ok: false`, `document: null`, and one error with the same message, line and column `/rules/lint` gives for that text;
    - a schema failure answers one error with `line` and `column` null;
    - an empty document answers `ok: true`, `document: "{}"`;
    - `yaml` of 64 KiB + 1 answers 422, and a missing `yaml` 422;
    - a viewer gets 403, as on `/rules/lint`.
  - `test_artifact_payloads_route.py`:
    - a `validation_rules` artifact's item carries `rules` equal to `parse_result` of its YAML;
    - a navigation artifact's item carries `rules: null`;
    - the item's other keys and their order are unchanged.
- [ ] **Step 3: See them fail.** Run `pixi run -e core-dev pytest tests/api/test_rules_parse.py tests/api/test_artifact_payloads_route.py -q`. Expected red: the new tests (404 on the route, a missing `rules` key). Everything else, and `pixi run core-test`, stays green.
- [ ] **Step 4: Implement** per M1. Factor the lint route's error-building into a helper both routes call; the lint route's behaviour is unchanged (its tests prove it).
- [ ] **Step 5: See them pass.** Run `pixi run core-test`, then `pixi run dr-tidy` (ruff, mypy and pyright must pass).
- [ ] **Step 6: Docs.** In `src/data_rover/api/README.md`, the rules section gains `/rules/parse` (what it answers and why the document is text) and the payloads route gains `rules`.
- [ ] **Step 7: Commit:** `Parse rule sets for the engine`.

---

### Task 2: The rules package in the engine · `critical-implementer`

**Files:**
- Create: `engine/src/rules/{document,compile,evaluate,reach,sources}.ts`, `tests/golden/scenarios/{rules_compile,rules_eval,rules_reach}.py`, `engine/test/rules/{compile.golden,eval.golden,reach.golden,document}.test.ts`
- Generated: `engine/fixtures/golden/{rules_compile,rules_eval,rules_reach}.json`
- Modify: `engine/src/artifacts/artifact-set.ts` (`rules` read on committed artifacts and staged entries; `lastWorkingParse`), `engine/src/validation/pipeline.ts` (`rules` parameter), `tests/golden/model_steps.py`, `tests/golden/scenarios/__init__.py`, `engine/test/golden/model-steps.ts`, `engine/src/index.ts`, `engine/README.md`

**Interfaces:**
- Consumes: Task 1's `parse_result`.
- Produces:
  - `readRuleSet`, `RulesUnreadable`, the AST types (M2).
  - `RuleSource`, `RulesParse`, `CompiledRules {rules, rulesByType, skipped, evalErrors, total, identities, unreadable}`, `compileRuleSets`, `appliesPopulation`, `EMPTY_RULES` (M3).
  - `ruleSources(set, layer)` (M3).
  - `pyRuleEq`, `evaluateCondition`, `RulesValidator` (M4).
  - `derivePaths`, `expandScope` (M5).
  - `validateScoped(model, ids, v, p, rules?)`.
  - `WireArtifact.rules?: RulesParse | null`; staged create and update entries `rules?: RulesParse | 'pending'`.
- **Recorder** (`model_steps.py`).
  - `{"do": "rules", "sources": [{"artifact_id", "name", "yaml"}]}` sets the recorder's sources and compiles them against its metamodel. It records:
    - `parses`: `parse_result(yaml).model_dump(mode="json")` per source, the route function's body;
    - `status`: a `RulesStatusOut` of the compile;
    - `compiled`: per rule `{artifact_id, check, applies_types: sorted, paths: [[{rel_types: sorted, direction, far_types: sorted | null}]]}`, and `rules_by_type` as `{type: [check, …]}` with the types sorted.

    The sources are sorted as D8 says before compiling, and the fixture says so, so both sides compile the same order.
  - `validate` runs `pipeline_for(compiled)` when the recorder has sources, `default_validators()` otherwise (existing fixtures unchanged).
  - `{"do": "reach", "ids": [...]}` records `expand_scope(model, compiled, ids)`.
  - `batch` with `"record_dirty": true, "expand": true` records the dirty set after `expand_scope` has widened it, as `expand_dirty` does (`dirty.update(extra)`).
- **Fixtures.**
  - `rules_compile`, over a metamodel with an element chain (abstract root, two levels), relationship subtypes and properties of each datatype:
    - sources: a set using every construct; a set with a parse failure (bad YAML, and one schema failure); each drift reason of fact 3, the first-mismatch order included (`when` before `then`, a `where` under `to`, a `where` without `to` naming anything); a disabled rule that would drift; rules whose `applies_to` is abstract; two sets with the same name; an empty set;
    - two `rules` steps against two metamodels, so the same YAML drifts differently.
  - `rules_eval`:
    - a model holding every value kind of fact 6 — `int`, `float` (integral and not), `bool`, `str`, a list of each, a nested list, a dict, `[]`, an absent key — and an integer past 2^53 and its neighbour;
    - a relationship web with subtype edges, self-loops, parallel edges, multi-level `to` subtypes and nested `where` (a relationship atom inside a `where`);
    - rules covering every test against every kind, `when` / `then`, both severities, custom `message`, `description`, names needing no `repr` (quote and non-ASCII), `Infinity` and `NaN` bounds, and two sets applying to the same type (the order of one owner's issues);
    - steps: `rules`, `validate` over `all_ids`, over subsets (an unknown id, a relationship id, the same id twice), a few `batch`es, then `validate` again.
  - `rules_reach`:
    - paths of depth 1–3 in both directions, with `to` on intermediate hops of a type other than the element met (the far type is not filtered), `where` prefixes, and owners outside `applies_types` (dropped);
    - `reach` from elements, relationship ids, deleted ids and unknown ids;
    - `batch`es with `record_dirty` and `expand` for each op kind: a far property edit, a middle relationship deleted, a middle element cascade-deleted, a create that links two paths.
  - Every fixture is under 400 entities.

- [ ] **Step 1: Write the scenarios, the recorder steps and the failing tests.**
  - `compile.golden.test.ts`: for each `rules` step, build `RuleSource`s from `sources` and the recorded `parses`, compile against the fixture's metamodel, and compare `status` and `compiled` exactly.
  - `eval.golden.test.ts` replays `rules_eval`: `validate` runs `validateScoped(…, compiled)`, compared by `JSON.stringify` (order included), twice, the second time with `hashKey: () => 0`.
  - `reach.golden.test.ts` replays `rules_reach`: `reach` against `expandScope`; `batch` with `expand` applies with a collector and widens it, compared to `dirty` in order.
  - `document.test.ts`:
    - `readRuleSet` of each recorded document equals the AST expected field by field for three rules (defaults filled, `bigint` and `PyFloat` operands);
    - it refuses, with `RulesUnreadable`, a document with an unknown key, two tests, `gt: null`, `count: {}`, `exists` and `count` both non-null, an empty `all`, and a non-object;
    - it ACCEPTS what pydantic accepts (M2): `"exists": null` beside a `count`, `"count": {"eq": null, "gte": 1}`, `"to": null`, `"where": null`, `"when": null`, `"message": null` and `"in": []`;
    - `pyRuleEq` tabulated: `true` vs `1`, `1` vs `PyFloat(1)`, `2n**60n` vs `2**60` and vs `2n**60n + 1n`, `NaN`, `[1]` vs `1`, `'1'` vs `1`, `null` operand.
- [ ] **Step 2: See them fail.** Run `pixi run golden-fixtures`, then `pixi run engine-test`. Expected red: the four new files, at import. Everything else stays green, and the staleness test proves the existing fixtures did not move.
- [ ] **Step 3: Implement** per M2–M5. `readArtifacts` / `readStagedArtifacts` read `rules` strictly (a malformed `rules` object refuses the list, 422, as any malformed field does); the document text inside is not parsed there.
- [ ] **Step 4: See them pass.** Then run `pixi run -e core-dev pytest tests/golden -q` (staleness) and `pixi run engine-check`.
- [ ] **Step 5: Lint.** Run `pixi run engine-tidy`, and ruff check and format on the Python files.
- [ ] **Step 6: Docs.** `engine/README.md` gains a `src/rules/` bullet: the port and its order, the document read as text (strict, `unreadable` as the one way out), the drift check, `pyRuleEq`, reach and its premise (M5), and that `eval_errors` cannot move (fact 7). The golden-fixtures bullet gains `rules`, `reach` and `expand`. The `src/artifacts/` bullet gains `rules`.
- [ ] **Step 7: Commit:** `Port the rules package to the engine`.

---

### Task 3: Rules in the live issue store · `critical-implementer`

**Files:**
- Modify: `engine/src/validation/{live,bodies}.ts`, `engine/src/index.ts`, `engine/test/validation/store.test.ts` (its `storeListBody(store, 6, tagOf)` calls take the new `rulesStatus` parameter), `tests/golden/model_steps.py` (`rules` on a seeded recorder; `issues` carries `rules_status`), `tests/golden/scenarios/validation_steps.py` (part 3), `engine/test/validation/{steps.golden,live,probe}.test.ts`, `engine/test/validation/helpers.ts` (`sweptFresh` with rules), `engine/test/working/invariants.test.ts`, `engine/test/working/random-ops.ts` (if the rules need more properties), `engine/README.md`
- Generated: `engine/fixtures/golden/validation_steps.json`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `LiveIssuesOptions.rules?: {working: CompiledRules; committed: CompiledRules}`.
  - `LiveIssues.setRules(rules)`, `.rules`, `.rulesVersion`, `.settled`, `.whenSettled()`.
  - `Origins` gains `hooks`, `previewDirty` and `preview` (M7).
  - `storeListBody(store, rev, rulesStatus, tagOf?)`, `rulesStatusBody(compiled)`.
- **Recorder.**
  - `seed` sets `session.compiled_rules` to the recorder's compile when it has one.
  - A `rules` step on a seeded recorder does what `create_commit` does for an artifact-only batch that touches rules (`routes/commits.py:1104-1160`, read it again when implementing): recompile, `dirty = applies_population(model, prior, new)`, a scoped `session_pipeline` run, and `state.replace(dirty, scoped)`, bumping `model_rev`.
  - `batch` after `seed` already runs `_finalize`, which expands. `preview` and `validate_staged` already use the session's rules.
- **Part 3 of `validation_steps`** — a new recorder in the same family, over a metamodel with multi-hop rules:
  - `rules` (two sets), then `seed` and `issues`;
  - `batch`es that flip a rule two hops away, rename a far element's property, and delete a middle element, each followed by `issues`;
  - a `rules` step that changes one rule, removes another and adds a third, then `issues`;
  - `preview` with `strict` true over staged ops whose only issue is a rule issue on an element the ops never touch (`would_block` true), and over ops fixing it;
  - `validate_staged` over the same.

- [ ] **Step 1: Write the failing tests.**
  - `steps.golden.test.ts`, part 3:
    - the harness keeps a compile beside its store;
    - `rules` recompiles and revalidates `appliesPopulation` in ONE `validateScoped` + `replace`, the oracle's shape;
    - `seed` and `batch` use the compile;
    - `issues` compares `storeListBody` with `rules_status`;
    - `preview` / `validate_staged` build a `LiveIssues` with `rules: {working: c, committed: c}` over a copy of the store.
  - `live.test.ts`:
    - **Review Focus 2:** over a seeded model, `setRules` between sweep steps, during a rescan (a second change before the first ends), with a staged edit on a rule's owner, and after a delta. After draining, the store equals a fresh `LiveIssues` swept under the final rules (`byOwner`).
    - `version` moves on a rule-set change and on each rescan step that changes the store.
    - `settled` is false from `setRules` until the rescan is drained, and `whenSettled` resolves then.
    - A rename-only change of a set (same rules) enqueues nothing.
    - `seeded` does not move during a rescan.
  - `probe.test.ts`, **Review Focus 3:** W = C plus a new rule, a changed rule and a removed rule, with staged edits (a cascade delete among them) and without.
    - `issueListBody` tags the new rule's issues `uncommitted` and an unchanged rule's `on_server`.
    - `validateBody` lists the removed rule's issues `resolved`.
    - `previewBody` equals the preview of a `LiveIssues` whose W is C.
    - `observe()`, `staged()` and `stagedVersion` are unchanged after each.
    - The cache is hit on a second read and missed after `setRules`.
    - While a rule set is staged (W ≠ C), a keystroke's probe revalidates no ΔPop owner outside S_M (M7's `deltaOf`; a spy on the ids validated), and its tags equal those of a probe with `deltaOf` cleared.
  - `invariants.test.ts`, **Review Focus 1:** the metamodel of `ops_churn` with a rule set of multi-hop atoms:
    - `Part –Seats→ Slot` whose `Feeds` count is ≥ 1 where `code` ≥ 1;
    - `Slot ←Feeds–` from a `Slot` whose `holder` exists;
    - a `when` on `name`;
    - an `Owns` atom (so `Seats`, its subtype, counts).

    Test 5 runs through a `LiveIssues` holding that compile as both W and C, and one action in ten swaps both between two variants of the rule set with `setRules`. After each action, drain the rescan, and the store equals a fresh sweep under the current rules. The probe's `S_W` equals the dirty set of `staged().flatMap(b => b.ops)` applied as one batch to a clone of committed state, widened by `expandScope` with W. A second variant of the test swaps W alone: then `S_W` is that set plus ΔPop.
- [ ] **Step 2: See them fail.** Run `pixi run golden-fixtures`, then `pixi run engine-test`. Expected red: the new cases above. Plan 2's existing cases stay green: with no rules, W and C are empty and nothing changes.
- [ ] **Step 3: Implement** per M6 and M7.
- [ ] **Step 4: See them pass.** Run the staleness test, `engine-check` and the whole `engine-test`.
- [ ] **Step 5: Lint** as before.
- [ ] **Step 6: Docs.** The `engine/README.md` `src/validation/` bullet gains:
  - the two compiles;
  - reach joined to every dirty set, and the premise;
  - the rescan (its queue, its place in the sweep slot, no progress);
  - `settled`;
  - origins with Δ and the preview on C;
  - `rules_status`.
- [ ] **Step 7: Commit:** `Evaluate rules in the live issue store`.

---

### Task 4: Rules in the service, and the gate at M · `critical-implementer`

**Files:**
- Modify: `engine/src/service/service.ts`, `engine/test/service/issues.test.ts`, `engine/bench/run.ts`, `engine/bench/parity-large.ts`, `scripts/issues_large.py`, `engine/src/index.ts`, `engine/README.md`
- Modify (the shell's side of the refusal, M10 "Route"): `frontend/src/lib/api/engine-route.ts`, `frontend/src/lib/api/__tests__/engine-route.test.ts`, and the rules cases of `frontend/src/lib/state/__tests__/replica.svelte.test.ts` (`:2040/2064/2082`) and `lib/api/__tests__/validation.test.ts` that name `reaches validation rules`. They still assert the server answers; only the refusal's text changes.

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - rule sets that follow `setArtifacts`, `putArtifacts` and `setStagedArtifacts`;
  - the 501 `reaches unreadable rules`;
  - issue methods that wait for `settled` (M8);
  - `pixi run engine-parity-large` with rules.
- **Parity at M.**
  - `scripts/issues_large.py` writes a fixed rule set over the smart-city types: at least five rules, among them one with a property test on a `when`, one `count` over a relationship subtype, one two-hop path with `where`, one `to` subtype filter and one warning.
  - It checks that every rule fires on at least one element of M and on fewer than all of its population, and exits non-zero otherwise.
  - It writes `benchmarks/large.rules.json`: the sources with their `parse_result` bodies.
  - The oracle's session compiles them before its sweep.
  - `parity-large.ts` hands the same sources to `LiveIssues` through `rules`.
  - The multiset now includes the rule issues; the script prints how many there are.

- [ ] **Step 1: Write the failing tests** (`issues.test.ts`, over the port pair).
  - A `setArtifacts` holding a rules artifact before `open`: after `applyTail`, the first `getModelIssues` lists its rule issues, with `rules_status.total` right. Nothing is refused.
  - **Review Focus 4** (the startup window): `setArtifacts` with a rules artifact AFTER the sweep ended. A `getModelIssues` posted at once is answered only after the rescan, with the rule issues. A bare `changed` with a new `issues_version` is posted in between.
  - `setStagedArtifacts` with a rules create: the next `getModelIssues` lists its issues `uncommitted`. `setStagedArtifacts([])` removes them.
  - `rules: 'pending'` on an update keeps the committed rules; the next push with the parse applies it.
  - A staged update of a rules payload with a skip-worthy rule: `rules_status.skipped` names it.
  - **Review Focus 4** (the commit window): `putArtifacts {changed: [the created set under its real id], deleted_ids: [], staged: []}` after the create was staged. The issues read `on_server`, listed once.
  - `previewCommit` with a staged rules create and a model edit reports only the committed rules' issues (D1).
  - **Review Focus 6:** a document the reader refuses, committed or staged, makes all three methods answer 501 `reaches unreadable rules`. A readable replacement makes them answer again.
  - `validateModel` posted during a rescan answers after both the re-sweep and the rescan.
  - `close` while a read waits for a rescan answers it 409.
  - A `setStagedArtifacts` that starts a second rescan after the first has settled, but before the waiting read's transition runs, makes the read wait again: its answer holds the second rule set's issues.
  - A committed `validation_rules` artifact sent without `rules` (an older shell) answers 501 `reaches unreadable rules`.
  - `close`, then `open` of the same project under a metamodel where one rule drifts: the new replica's `rules_status.skipped` names it, though the artifacts did not move.
  - A cancelled waiting read is never answered.
- [ ] **Step 2: See them fail.** Expected red: the cases above. Plan 2's `reaches validation rules` cases fail too; delete them in Step 3, as the refusal they assert is gone.
- [ ] **Step 3: Implement** per M8.
- [ ] **Step 4: See them pass.** Run `engine-check` and `engine-test`, then `pixi run frontend-test` and `pixi run frontend-check`: the frontend runs the real engine, so a rules project must still reach the server through `reaches unreadable rules`.
- [ ] **Step 5: Bench and parity.**
  - `bench/run.ts` gains:
    - `sweep with rules` (and its longest step);
    - `rules rescan (population of the rule over the largest type)`;
    - `stage 1,000 ops + revalidation with reach`;
    - `origin probe, 100 staged batches + a staged rule change`.
  - Run `pixi run engine-bench`, then `pixi run engine-parity-large`.
  - Report the numbers and any parity difference to the owner through the hand-back. Fix a parity difference in the engine. Optimize nothing here: Task 5 is where K-59/60/61 are addressed.
- [ ] **Step 6: Lint.** Run `engine-tidy`, and ruff on `scripts/issues_large.py`.
- [ ] **Step 7: Docs.** The `engine/README.md` `src/service/` bullet:
  - rules follow the artifact methods, which stay `now`;
  - the refusals (`reaches unreadable rules` replaces `reaches validation rules`);
  - the issue methods wait for a rescan;
  - the parity task with rules.
- [ ] **Step 8: Commit:** `Serve rules from the engine service`.

---

### Task 5: The sweep's first step, key texts and the panel's probe · `critical-implementer`

**Files:**
- Modify: `engine/src/model/model.ts` (`orderEpoch`), `engine/src/model/indexes.ts`, `engine/src/model/verify.ts` (or wherever `verifyConsistent` lives), `engine/src/validation/{live,bodies}.ts`, `engine/src/validation/validators/uniqueness.ts`, `engine/test/model/indexes.test.ts`, `engine/test/validation/live.test.ts`, `engine/test/working/invariants.test.ts`, `engine/bench/run.ts`, `frontend/bench/main.ts`, `engine/README.md`, `BACKLOG-ENGINE.md`

**Interfaces:**
- Consumes: Task 4.
- Produces:
  - `Model.orderEpoch`;
  - cached key texts in `IndexSet` (M9);
  - `LiveIssues`' incremental `tagScope` / `committedOf`.
- None of this changes an answer: every golden, service and shell test stays as it is.

- [ ] **Step 1: Measure before.**
  - Add the rows first and run them on Task 4's code:
    - `sweep first step`;
    - `uniqGroupOf over a 20,000-member group`;
    - `getModelIssues after a coalesced keystroke, 100 / 1,000 staged batches`.
  - In `frontend/bench/main.ts`, separate the two ping loops (`:150-156` today; K-59's text cites a stale `:521-532`) so `longest slice while sweeping` times the sweep alone.
  - Run `pixi run engine-bench` and `pixi run engine-bench-browser`, and keep the numbers for the hand-back.
- [ ] **Step 2: Write the failing tests.**
  - `live.test.ts`:
    - drain `sweepSteps()` over a 3,000-element model with a small step. Between steps, restore an entity at an old `ord` (unstage a staged delete), then read `model.elements()` to force the re-sort. The finished store equals a fresh sweep, and no step pulled more than `sweepStep` entities plus the bounded skip;
    - the first step no longer lists everything: its `done` is at most `sweepStep`.
  - `indexes.test.ts`:
    - after a random churn of creates, updates, key-relationship connects and deletes, every cached key text equals a fresh `uniqKey`;
    - the same churn under `hashKey: () => 0`, where every rekey keeps its hash: property edits, re-parenting and key-relationship changes still leave every cached text fresh;
    - a bucket back to one member holds no cached text;
    - `uniqGroupOf` equals the uncached computation.
  - `invariants.test.ts`, **Review Focus 5:** after every action, `issueListBody(live)` (incremental) equals `issueListBody` of the same state computed through an exact probe. Build the exact one by clearing the tag scope, which a test-only reset allows: it must not change the working copy. Rule-set swaps are included.
  - `live.test.ts`:
    - `getModelIssues` after a coalesced edit on an already-staged element with relationships and referencers runs no probe (a spy on `probeStaged` through the working copy). Its neighbourhood takes its entries from the store;
    - after a delta, or a change of C, the next read runs one.
- [ ] **Step 3: See them fail.** Expected red: the new cases.
- [ ] **Step 4: Implement** per M9.
- [ ] **Step 5: See them pass.** Run the whole `engine-test`, `engine-check`, and `pixi run engine-parity-large`, which must still be equal.
- [ ] **Step 6: Measure after.** Re-run both benches. Report before and after for each row through the hand-back. If a target is still missed, report it; do not go further.
- [ ] **Step 7: Docs.**
  - `engine/README.md`: the sweep's listing and its epoch guard, the cached key texts, and the panel's incremental tags.
  - `BACKLOG-ENGINE.md`:
    - K-59 and K-61 `done`, with the numbers;
    - K-60 `done` for the engine, its text re-scoped to the server's half (D15), which stays open.
- [ ] **Step 8: Commit:** `List the sweep in steps, cache key texts and tag the panel incrementally`.

---

### Task 6: Rule sets in the shell · `critical-implementer`

**Files:**
- Create: `frontend/src/lib/engine/rules-parse.ts`, `frontend/src/lib/engine/__tests__/rules-parse.test.ts`
- Modify: `frontend/src/lib/api/{types,rules,artifacts,engine-route,validation}.ts`, `frontend/src/lib/engine/{artifacts,shadow}.ts`, `frontend/src/lib/state/{artifact-edits,replica,model}.svelte.ts`
- Modify, tests: `lib/api/__tests__/{rules,artifacts,engine-route,validation}.test.ts`, `lib/engine/__tests__/{artifacts,shadow}.test.ts`, `lib/state/__tests__/replica.svelte.test.ts` (its rules cases at `:2040/2064/2082` assert the old fallback), `lib/engine/__tests__/sync-call.test.ts` (if it asserts the artifact wire shape)
- Modify, docs: `frontend/src/lib/engine/README.md`, `frontend/README.md`

**Interfaces:**
- Consumes: Tasks 1 and 4.
- Produces:
  - `parseRules(yaml, cfg?)`;
  - `createRulesParser` (M10);
  - `hasStagedRules()`;
  - the payload items' `rules`.

- [ ] **Step 1: Write the failing tests** (in-process engine, MSW for the server side).
  - `rules-parse`:
    - `attach` marks a rules create `'pending'` and starts one parse for two entries with the same text;
    - when it lands, `onParsed` fires and the next `attach` carries the parse;
    - a failed parse is retried at the next `attach`;
    - non-rules entries and deletes pass through unchanged;
    - an update's kind comes from `kindOf`.
  - `artifacts` (the follower):
    - committed rules artifacts reach the engine with `rules`;
    - a staged rules update is pushed `'pending'`, then again with its parse;
    - `settled()` waits for the parse;
    - the own-commit overlay carries the parse.
  - `validation`:
    - with the gate open and a committed rules artifact, `getModelIssues` answers the engine's body with its rule issues and `rules_status`, and MSW is never asked;
    - staging a rules update through the artifact buffer lists its new issues `uncommitted` after the parse lands;
    - a document the engine refuses sends the call to MSW, unmarked;
    - `validateModel` with staged model ops and a staged rules entry is not shadowed.
  - `engine-route` (already moved in Task 4): a project whose shell now sends parses reaches the server only for an unreadable document.
  - `shadow`: two bodies differing only in the order of `rules_status.skipped` are the same.
  - `replica.svelte` (**Review Focus 4**):
    - the old "rules flip → server" cases become: a rules artifact arriving after the sweep keeps the gate closed until the follower's load, then the engine answers with the rule issues after one refetch;
    - after the user commits a staged rules create, the panel lists each rule issue once, `on_server`.
- [ ] **Step 2: See them fail.**
- [ ] **Step 3: Implement** per M10.
- [ ] **Step 4: See them pass.** Run `pixi run frontend-test` and `pixi run frontend-check`.
- [ ] **Step 5: Lint.** Run `pixi run dr-tidy`.
- [ ] **Step 6: Docs.**
  - `frontend/src/lib/engine/README.md`: the parse result travels with committed and staged artifacts, `'pending'` and the parser, the `rules` fallback's new trigger, and the shadow rules.
  - `frontend/README.md`, "Validation issues": in engine mode, staged rule sets show in the panel and in Validate before any commit, while the commit preview uses the committed rules (as the server's does).
- [ ] **Step 7: Commit:** `Hand rule sets to the engine from the shell`.

---

### Task 7: e2e and the documents · `implementer`

**Files:**
- Create: `frontend/e2e/eval-rules.spec.ts`
- Modify: `architecture/contracts.md`, `architecture/decisions.md`, `architecture/program.md`, `architecture/system.md`, `BACKLOG.md`, `BACKLOG-ENGINE.md`, `src/data_rover/core/README.md` (the freeze note, no code), `engine/README.md`, `docs/superpowers/specs/2026-09-24-evaluation-design.md` (local)

- [ ] **Step 1: e2e.** Write `eval-rules.spec.ts`, importing from `e2e/fixtures.ts` (engine mode, shadow on; a `[shadow]` line fails the test). Cover:
  - in the Rules tab, a new rule set whose rule fails on existing elements is saved and staged; the Issues panel shows its issues before any commit, marked new, and a drifted rule in the skipped banner; Discard removes both;
  - the set committed, its issues stay, now on the server;
  - a model edit two hops from a rule's owner (the path's far property) makes the owner's issue appear live, and undoing the edit clears it;
  - in strict mode, with the rule committed, staging an edit that violates it blocks the commit dialog.

  Stop any stale `vite preview` on :5174 first, then run `pixi run sandbox-build` and `pixi run frontend-test-e2e`. The whole suite must stay free of `[shadow]` lines, with T-8 and T-9 the only failures.
- [ ] **Step 2: Browser bench.** Run `pixi run engine-bench-browser` and report the sweep rows with rules beside Task 5's.
- [ ] **Step 3: `architecture/`.**
  - **CT-4:**
    - the artifact wire form gains `rules` (committed: `RulesParse | null`; staged: `RulesParse | 'pending'`), the document as text;
    - the refusal `reaches unreadable rules` replaces `reaches validation rules`;
    - the issue methods wait for a rule-set change to be applied;
    - `issues_version` also moves on a rule-set change.
  - **`decisions.md`:** `AD-33 · Rules reach the engine as parsed text; the engine compiles, reaches and evaluates them`.
    - Why: AD-22 extended (YAML and its grammar stay on the server); exactness (AD-26); the store sees staged rule sets.
    - Rejected: a YAML parser in the engine; a server compile per candidate; the document as a JSON object; answering reads mid-rescan.
    - Consequences: two compiles and the rescan; reach joins every dirty set, with M5's premise; the preview reads the committed rules, as the server's does, until `K-65`; origins across a staged rule set.
    - Cite it in CT-4, and extend AD-32's consequences: the gate no longer reads rules as unsupported.
  - **CT-5:** item 5 — the artifact family carries each rule set's parse (`rules`) beside its payload.
  - **`system.md`:** Current → target gains the rules parse (server), as spec §9 lists.
  - **`program.md`:** C's status becomes `in progress — plan 3 of 8 built (custom rules evaluated in the engine, staged rule sets included)`.
- [ ] **Step 4: Backlog.**
  - `BACKLOG-ENGINE.md`:
    - R-3: plan 3's status, and the freeze sentence gains `core/validation/rules` and `api/rules.py` (frozen from plan 3; a bug or a feature lands on both sides until F);
    - `K-65`: the server's preview ignores a staged rule set while a strict commit enforces it, so the preview says it lands and the commit 422s. The engine mirrors the server (D1). Fix on both sides with a fixture: the preview compiles the staged rule sets, and its dirty set adds their population;
    - `K-66`: a peer's rules commit reaches the engine as a model delta first and as a payload fetch after. In between, the engine answers with the old rules while the server has the new ones. A dev-shadow line is possible in that window; a single-user e2e cannot reach it.
  - `BACKLOG.md`: nothing, unless the owner schedules U-9.
- [ ] **Step 5: `core/README.md`.** One line in the rules section: the engine ports this package, so it is frozen (MR-3); a change lands on both sides with a fixture.
- [ ] **Step 6: Spec** (local):
  - §1: `document` travels as text inside `rules`; `artifacts_version` moves to plan 4; the artifact methods stay `now` (D9).
  - §3 "Origins": the cache key is `(rev, staged_version, rules_version)` (D10).
  - §3 "Rules": reads wait for the rescan, with no `applying` field (D2); the preview uses the committed rules (D1); `document`'s exact form (D6).
- [ ] **Step 7: Everything green.** Run `pixi run dr-test`, `pixi run dr-tidy true`, `pixi run engine-check`, `pixi run frontend-check`, `pixi run sandbox-check` and `pixi run engine-parity-large`.
- [ ] **Step 8: Commit:** `Serve custom rules from the engine`. Then, with the owner's go-ahead, fast-forward `engine-migration` to `feat/eval-rules`.

## After this plan

Plan 4 (tables) starts from here:
- an `ArtifactSet` whose `artifacts_version` does not exist yet, and which the table order cache needs (D10);
- `ruleSources`' layering (committed, working, `'pending'`) as the model for any other artifact the engine must read in two layers.

Open from this plan: `K-65`, `K-66`, K-60's server half, and plan 2's `C-23`, `K-58`, `K-62`, `K-63` and `T-10`.
