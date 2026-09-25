# Task 4 report: Rules in the service, and the gate at M

Commit: `80f6de18 Serve rules from the engine service` (on `feat/eval-rules`, not pushed).

## What I implemented

**Service (`engine/src/service/service.ts`), per M8**
- `becomeReady` compiles W (`ruleSources(set, 'working')`) and C (`'committed'`) against the replica's metamodel and passes them to the `LiveIssues` constructor through `rules`. It never calls `setRules` on a fresh store (carried item 2).
- `moveArtifacts(put)` runs `put`, then recompiles each layer only when its sources changed. Sources are compared as the ordered `(artifactId, name, parse)`; a parse is compared by its `document` text, or by its first error's message. When a layer changed, it calls `live.setRules`, puts the store's steps back in the sweep slot if a rescan is now due, and calls `flushIssues()`, which posts a bare `changed`. The memo lives on the per-store `Issues` record, so it covers the metamodel's identity: a new replica compiles afresh. The `resolvesKind` flip logic is gone, and so is `ArtifactSet.resolvesKind`, which nothing used any more.
- `live()` refuses 501 `reaches unreadable rules` when W or C is `unreadable`. The `reaches validation rules` refusal is deleted.
- Reads wait. A new private `settled(call, run, on?)` runs the answer in a model-lane transition when `live.settled`. Otherwise it registers the call on `whenSettled()` and queues a new transition, which re-checks `settled` and waits again if it is still false. Waiting calls share one set, `waiting` (formerly `validating`), which `dropIssues` and the failed-sweep path refuse, so `close` answers 409. A call that was cancelled or already refused is not run. A call whose store was replaced is refused 409. `check` (stale `base_rev` / batches) runs in the answering transition.
- `validateModel` restarts the sweep and waits on `whenSwept()`, which also covers the rescan. It then goes through the same `settled` path, so it too re-checks.
- The progress callback forwards nothing for rescan steps (carried item 1, type-enforced; see below).

**Rescan steps are a distinct type (carried item 1).** `live.ts` exports `SweepStep = Progress & { readonly rescan?: true }`. `RESCAN_STEP` is `{done: 0, total: 0, rescan: true}`, and `sweepSteps()` is `Generator<SweepStep, boolean, void>`. To let the service's callback receive a `SweepStep`, `BackgroundTask` in `scheduler.ts` became generic (`BackgroundTask<P extends Progress = Progress>`, `setSweep<P>`). That is a 3-line change in a file the plan does not list; it is the smallest change that gives the service the typed discriminant rather than an identity check. Sweep steps stay plain `{done, total}`, so the existing `toEqual` assertions hold.

**R9 (`engine/src/artifacts/artifact-set.ts`)**
- `setCommitted` / `put` keep a committed parse only when no staged entry carrying a payload stands over the id (`keepCommittedParse`).
- `setStaged` keeps a parse only for an entry that carries a payload.
- The discard path is unchanged.

**Frontend (M10 "Route" only)**
- `FALLBACKS`: `'reaches unreadable rules' → 'rules'`. The old entry is removed and the doc comments are adjusted.
- `engine-route.test.ts` names the new text. `replica.svelte.test.ts` and `validation.test.ts` never named the refusal text (grep), so they needed no change and stay green.

**Parity at M**
- `scripts/issues_large.py` has `RULE_SETS`, two sets (`Deployment`, `People`) holding six rules over smart-city:
  - `prod-replicas`: a property test under a `when`;
  - `no-dependency`: a `count` over `DependsOn`, whose subtype `UsesDatabase` is what Microservices hold;
  - `hosted-deployment`: a two-hop path, `DeployedOn` with `to: Node` and a `where` over `HostedIn`;
  - `four-services`: `to: Service`, a subtype of `SystemContainsComponent`'s target, with `count gte 4`;
  - `lead-in-team`: the warning;
  - `server-sizing`: `all`, `not`, `in` and `gt`.
- It writes `benchmarks/large.rules.json`: the payloads-route bodies, each with `parse_result(...).model_dump(mode="json")`, sorted by name then id.
- The session gets `compiled_rules=compile_sources(...)` before the sweep. The script exits non-zero if a rule is skipped or fires on 0 or on all of its population, measured on the swept state after the violations. It prints the rule-issue count.
- `parity-large.ts` reads `large.rules.json` through `readArtifacts` → `ArtifactSet.setCommitted` → `ruleSources` → `compileRuleSets`. It passes `{working, committed}` to `LiveIssues` and prints the rule-issue count.
- `RULE_CHECK_PREFIX` is now exported from `index.ts`, along with `SweepStep`.

**Bench (`engine/bench/run.ts`)**
- `BENCH_RULES` is five rules as document text, with the replica bound spliced in as a float literal.
- `rules rescan (population of the rule over the largest type)` (+ its longest step) runs on the plain store after its edits: one rule over every element of the largest type, where there was none.
- A new `measureRules`:
  - `sweep with rules` (+ its longest step after the first);
  - `stage 1,000 ops + revalidation with reach`;
  - `origin probe, 100 staged batches + a staged rule change`: W's `prod-replicas` bound changed, the rescan drained untimed first, then the first probe, which pays ΔPop, is timed.

**Docs**
- `engine/README.md`:
  - `src/artifacts/`: R9;
  - `src/validation/`: `SweepStep`;
  - `src/service/`: rules follow the `now` artifact methods, the memo, `issues_version`, the refusals, reads wait and re-check, 409 on close, cancelled never answered;
  - the bench and parity paragraphs.
- The sentence naming the old refusal is updated in `frontend/src/lib/engine/README.md` and `frontend/README.md` (RC-10, since `engine-route.ts` changed). See Concerns.

## Tests and results

- `pixi run engine-check`: clean.
- `pixi run engine-test`: **84 files, 1,299 tests passed**. Of these, 26 are in `issues.test.ts`: 13 before, minus 2 deleted, plus 15 new. `sources.test.ts` has 8: 6 before plus 2 new, and one existing case adjusted for R9.
- `pixi run frontend-test`: **283 files, 3,008 tests passed**. The MSW "no matching handler" and `ECONNREFUSED 127.0.0.1:3000` stderr lines are pre-existing. I checked this on a stash of the baseline: 26 ECONNREFUSED on both, MSW 11 against 9, which varies by timing.
- `pixi run frontend-check`: 0 errors, 0 warnings.
- `pixi run engine-tidy`: clean. `ruff check` and `ruff format` on `scripts/issues_large.py`: clean.
- `issues.test.ts` ran 5 times in a row: 26/26 each time.

## TDD evidence

RED (`pixi run engine-test -- test/service/issues.test.ts test/rules/sources.test.ts`, before implementing):
```
   × ruleSources > keeps a staged payload's parse under 'pending' when the committed artifact lands again
   × ruleSources > records no parse from an update that carries no payload
   × rules > compiles the rule sets set before open with the store: the first read lists their issues
   × rules > answers a read posted with a rule set that lands after the sweep only after its rescan, which reports no progress
   × rules > lists a staged rule set's issues 'uncommitted', and drops them with the entry
   × rules > keeps the committed rules under a 'pending' update, and applies the parse the next push brings
   × rules > names a staged rule the metamodel drifts in rules_status.skipped
   × rules > reads a committed staged create 'on_server' under its real id, each issue once
   × rules > previews with the committed rules alone, a staged rule set aside
   × rules > answers 501 'reaches unreadable rules' to all three over a document it cannot read, committed or staged
   × rules > answers 501 'reaches unreadable rules' over a rule set that arrived without its parse
   × rules > moves issues_version when the rule sets change, and not when a push leaves them as they were
   × rules > answers validateModel posted during a rescan after both the sweep it restarts and the rescan
   × rules > answers 409 'replica is not ready' to a read waiting for a rescan when the replica closes
   × rules > makes a read wait again when a second rescan starts after the first settled, before its answer
   × rules > never answers a waiting read that was cancelled
   × rules > compiles afresh against the metamodel of a replica opened again, the artifacts unmoved
 Test Files  2 failed (2)
      Tests  17 failed | 17 passed (34)
```
- Exactly the expected reds. There were no other reds.
- Plan 2's two `reaches validation rules` cases (`answers 501 to all three while a validation_rules artifact resolves`, `posts a bare changed … whenever the rules start or stop resolving`) were deleted before this run, per Step 3. The second is replaced by `moves issues_version when the rule sets change, and not when a push leaves them as they were`.

GREEN (same command, after implementing): `Test Files 2 passed (2) / Tests 34 passed (34)`.

Two mutations checked that the tests discriminate: forwarding rescan steps as progress, and not re-waiting in the answering transition. Result: `× answers a read posted … only after its rescan, which reports no progress` and `× makes a read wait again when a second rescan starts …`, 2 failed / 24 passed. I restored the code afterwards.

## Numbers

`pixi run engine-bench` (Node v22.22.3, median of 3 passes [each pass]), the new rows, then the rows around them for context:
```
rules rescan (population of the rule over the largest type)                 110   [109 154 110]
  its longest step                                                          5.4   [5.4 7.7 4.6]
sweep with rules                                                            917   [917 808 1096]
  its longest step after the first                                          6.3   [6.3 4.9 7.1]
stage 1,000 ops + revalidation with reach                                    84   [84 79 104]
origin probe, 100 staged batches + a staged rule change                     199   [199 185 237]
```
```
sweep the issue store: every entity validated, in steps                     862   [862 1165 858]
  its first step: every id listed                                            15   [15 18 7.8]
  its longest step after the first                                          8.9   [12 8.9 6.4]
stage 1,000 ops + revalidation                                               86   [86 117 83]
origin probe (100 staged batches)                                            32   [32 38 32]
heap after GC with one replica open, MB                                     236   [234 236 236]
open: 2541 of 3000 ms, within budget; heap: 236 of 400 MB, within budget
```
- The largest type at M is `Person`: 27,200 elements.
- The staged rule change's ΔPop is the Microservice population, 13,600. The probe row is the first probe after the change (it pays ΔPop).
- Nothing was optimized.

`pixi run engine-parity-large`:
```
wrote …/large.violations.ops.json: 7,306 ops; …/large.rules.json: 6 rules; …/large.issues.json: 18,523 issues, 10,815 of them the rules', over 300,449 entities, swept in 5.6 s
  rule:prod-replicas: fires on 453 of 13,600
  rule:no-dependency: fires on 2,712 of 13,600
  rule:hosted-deployment: fires on 2,550 of 20,400
  rule:four-services: fires on 1,360 of 5,440
  rule:server-sizing: fires on 1,190 of 15,300
  rule:lead-in-team: fires on 2,550 of 30,100
Model M: 170,340 elements, 126,820 relationships, 7,306 violating ops applied. 6 rules. Engine: 18,523 issues, 10,815 of them the rules', swept in 1066 ms; oracle: 18,523 issues.
Parity: the two multisets are equal.
```
There is no parity difference. The built-in issues are 7,708, as at the baseline, plus 10,815 rule issues.

## Files changed

- `engine/src/service/service.ts`, `engine/src/service/scheduler.ts`, `engine/src/validation/live.ts`, `engine/src/artifacts/artifact-set.ts`, `engine/src/rules/sources.ts` (doc comment), `engine/src/index.ts`
- `engine/test/service/issues.test.ts`, `engine/test/rules/sources.test.ts`
- `engine/bench/run.ts`, `engine/bench/parity-large.ts`, `scripts/issues_large.py`
- `engine/README.md`
- `frontend/src/lib/api/engine-route.ts`, `frontend/src/lib/api/__tests__/engine-route.test.ts`, `frontend/src/lib/engine/README.md`, `frontend/README.md`
- `benchmarks/large.rules.json` is written by the script. It is git-ignored and not committed.

## Self-review findings (fixed before commit)

- `ArtifactSet.resolvesKind` had no caller left, so I removed it.
- The `workingParse` doc in `sources.ts` still said "last parse that arrived". It now names `lastWorkingParse`.
- `sources.test.ts`'s "a newer committed parse is the last one received" asserted the pre-R9 behaviour: a put landing over a staged payload overwrote the kept parse. I adjusted it so the put lands after a discard, and added the R9 case itself.

## Issues or concerns

- **Docs outside the brief's list.**
  - I updated one sentence each in `frontend/src/lib/engine/README.md` and `frontend/README.md`, because they describe the `FALLBACKS` entry this task changes (RC-10).
  - `architecture/contracts.md` (CT-4, around lines 154 and 177) and `BACKLOG-ENGINE.md` (around line 69) still describe `reaches validation rules` and the resolves-flip `issues_version`. Following the plan, I left them for Task 7, the documents. RC-10 says they ride with this commit, so that is the controller's call.
- **The scheduler signature change** (the generic `BackgroundTask`) is outside the plan's file list. It is 3 lines and changes no behaviour.
- **The 'rescan' timing test** relies on `fakeHost({tick: 10})` making each unit its own slice, and on `blocks(1000)` being exactly two rescan steps at `SWEEP_STEP` 512. If `SWEEP_STEP` changes, the turn count in that test must follow.
- **Leftover `awaiting` entries.** A cancelled waiting call stays in the service's `awaiting` map. `validateModel` already did this before. It is harmless, since ids are not reused.
