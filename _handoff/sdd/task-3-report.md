# Task 3 report: Evaluate rules in the live issue store

Status: DONE_WITH_CONCERNS (the concerns are notes for Task 4 and on test strength; the code has no open issue)
Commit: `a3e8299 Evaluate rules in the live issue store`

## What I implemented

### `engine/src/validation/live.ts` (M6, M7)
- **Rules.** `LiveIssuesOptions.rules?: LiveRules` (`{working, committed}`, both `EMPTY_RULES` unless given). New members: `rules`, `rulesVersion`, `settled`, `whenSettled()`, `setRules(rules)`. `LiveRules` and `RESCAN_STEP` are exported too.
- **Transitions.** `stage`, `unstage` and `applyDelta` each widen their dirty collector with `expandScope(model, W, dirty.ids)` on the state after the transition, then `revalidate` with W. For a stage the widening comes after the hooks. For a rebase or a coalesced edit it comes after `afterRebase`.
- **`setRules`.**
  - It swaps both compiles, bumps `rulesVersion` and `version`, drops the origins cache and `deltaOf`, and validates nothing.
  - When W's ordered identity list changes (and the store is usable), `appliesPopulation(model, oldW, newW)` is added to the rescan queue after the ids still pending, each id once.
  - A rename that leaves W's rules as they were queues nothing.
- **Sweep slot.**
  - `sweepSteps()` runs any sweep that is due first, reporting progress as before.
  - Then it drains the rescan, `sweepStep` ids per step. Each step is a `revalidate` with the current W and yields the frozen sentinel `RESCAN_STEP` instead of progress.
  - `seeded` still moves only when a sweep ends. `release()` resolves `whenSettled` waiters once the rescan is empty, and `whenSwept` waiters once both the sweep and the rescan are empty. `markUnusable` clears the rescan and releases all waiters.
- **Origins.**
  - Cached per `(rev, stagedVersion, rulesVersion)`. The result is `{hooks, dirty, working, committed, previewDirty, preview}`.
  - Δ is the multiset difference of the rules by identity, taken both ways. ΔPop is `appliesPopulation(model, {rules: Δ})`.
  - S_W = hooks ∪ W-reach ∪ ΔPop.
  - The part of ΔPop inside S_M (hooks ∪ W-reach ∪ C-reach) is validated in the probe. The part outside S_M comes from `deltaOf`: validated once, on the working state, with W and with C. That cache is valid per `(rev, rulesVersion)`, and a transition drops the entries of its dirty ids.
  - S_P = hooks ∪ C-reach, and `preview` is validated with C on the working state. When W and C hold the same identities in the same order, `preview` is `working`.
  - With nothing staged in the model there is no rewind: S_W = ΔPop, or `NOTHING_STAGED` when Δ is empty.

### Bodies, rules and exports
- **`bodies.ts`:**
  - New `RulesStatusBody` and `rulesStatusBody(compiled)`.
  - `storeListBody(store, rev, rulesStatus, tagOf?)`.
  - `issueListBody` fills `rules_status` from W.
  - `previewBody` reads `hooks` and `preview`. `would_block = strict && some conformance issue (owner ∈ hooks || check starts with 'rule:')`.
- **`rules/compile.ts`:** a `RULE_CHECK_PREFIX` constant. `appliesPopulation` takes `Pick<CompiledRules, 'rules'>`, so the probe can pass Δ alone. This is the smallest change the probe needed.
- **`index.ts`:** exports `rulesStatusBody`, `RulesStatusBody`, `RESCAN_STEP` and `LiveRules`.

### Recorder and scenario
- **Recorder (`tests/golden/model_steps.py`):**
  - `seed` sets `session.compiled_rules` to the recorder's compile.
  - A `rules` step on a seeded recorder calls `_swap_rules`. It follows the rules-touched branch of `create_commit`: recompile, `DirtyCollector` ← `applies_population(model, prior, new)`, one `session_pipeline` run over it, `state.replace`, `model_rev += 1`. There is no model op, so reach has nothing to widen.
- **Scenario (`validation_steps.py`):** the fixture is now `{"runs": [part 1+2, part 3]}`, the shape `rules_compile` uses. I checked that `runs[0]` equals the previous fixture exactly.
  - Part 3 has its own metamodel: Unit / Port / Hub, with Has (containment), Plugs and Feeds.
  - It has two rule sets, Alpha and Beta, whose atoms reach two hops in both directions. One uses a `when` on `name`, one a custom message, one a description, one a `warning`.
  - Steps: `seed`, `issues`, then six batches, each followed by `issues`:
    - a hub two hops away leaves the core;
    - a unit two hops away grows senior;
    - two more flips, one of them a far element renamed;
    - the middle Port deleted.
  - Then a `rules` step (a rule changed, one removed, one added), then `issues`.
  - Last, `validate_staged` and a strict `preview` over ops whose only issue is a rule issue on the untouched `u-3` (the preview blocks), and over the same ops with a fix (the preview does not block).

### Engine golden harness (`test/golden/model-steps.ts`)
- `seed` validates with the compile.
- A seeded `batch` expands with the rules before it validates.
- A seeded `rules` step does ONE `validateScoped(appliesPopulation(prior, new))` and one `replace`, and bumps rev.
- `issues` passes `rulesStatusBody`.
- `preview` and `validate_staged` build `LiveIssues` with `rules: {working: c, committed: c}` over a copy of the store.

### Tests
- **`steps.golden.test.ts`:** replays both runs.
- **`store.test.ts`:** the new signature, plus a test of `rulesStatusBody`: field order, skips, `eval_errors`.
- **`helpers.ts`:**
  - `sweptFresh(wc, rules?)` and `compileSets`.
  - `CHURN_RULES` and `churnRules(mm)`, the brief's ops_churn atoms. Set a holds seated, fed and named. Set b keeps seated, changes fed, drops named and adds owns. `delta` compiles the rules only one side holds.
  - `classified`, `answered` and `listedTags`: the independent oracle, built from two fresh sweeps.
- **`live.test.ts` ("rules in the store"):**
  - Review Focus 2, over 3 seeds × 1,500 elements. `setRules` is called:
    - mid-sweep, with a staged set;
    - after a staged edit on a rule's owner;
    - mid-rescan, as a second change whose population does NOT cover the first's pending `Other`s;
    - after a delta, as the staged set committed.
    - Random churn runs throughout. After draining, the store equals a fresh sweep under the final rules.
  - The sweep comes first, then rescan steps (`RESCAN_STEP`), and `seeded` never moves on them.
  - `version` moves on a rule-set change, and on exactly the rescan steps that change the store.
  - `settled`, `whenSettled` and `whenSwept` resolve only when the rescan drains.
  - A rename-only change enqueues nothing but still moves both versions.
  - The rescan settles when the store becomes unusable mid-rescan.
- **`probe.test.ts`** (Review Focus 3): C = a, W = b, with the scene's staged edits (the cascade delete among them) and without. Assertions:
  - the new rule's issues are all `uncommitted`, and the unchanged rule has `on_server` issues;
  - `rules_status` is W's;
  - every removed-rule issue is `resolved`;
  - `validateBody` equals the two-fresh-sweeps classification as a multiset;
  - the list tags equal the oracle's;
  - `previewBody` (strict and not) equals the one after `setRules({a, a})`;
  - `observe`, `staged` and `stagedVersion` are unchanged after each body;
  - the cache is hit on a second read and missed after `setRules`.
  - Keystroke test: a spy on `RulesValidator.prototype.validateElement` shows the keystroke's probe validates none of ΔPop∖S_M. After `setRules(live.rules)` clears `deltaOf`, the tags are equal and every such owner is revalidated.
- **`invariants.test.ts`** (Review Focus 1): test 5 now runs with the `churnRules` compile as both W and C. One action in ten swaps the rule set: both W and C in one variant, W alone in the other. There are 60 actions per run (was 40). After each action:
  - the rescan is drained;
  - the store equals a fresh sweep under W;
  - `origins().hooks` equals the one-batch dirty set on a committed clone;
  - `origins().dirty` equals hooks ∪ `expandScope(clone, W, hooks)`, plus ΔPop while W ≠ C;
  - the list tags and `validateBody` equal the two-fresh-sweeps oracle.

## Tests and results
- `pixi run engine-test`: 84 files, 1,282 tests passed (was 1,240).
- `pixi run -e core-dev pytest tests/golden -q`: 1 passed (staleness).
- `pixi run engine-check`: clean. `pixi run frontend-check`: 0 errors, 0 warnings.
- `pixi run engine-tidy`: clean.
- `ruff check` and `ruff format` on the two Python files: clean, formatted.
- Engine test output is pristine: no stderr, stdout or warn lines.
- **Mutation checks.** Each was applied to the final code, then restored and verified with `cmp`. The red counts are from `test/validation` + `invariants`.

  | Mutation | Red tests |
  |---|---|
  | no reach in transitions | 8 (invariants, 4 seeds × 2 variants) |
  | preview validated with W | 8 |
  | no rescan enqueued | 23 |
  | ΔPop∖S_M dropped from origins | 23 |
  | ΔPop left out of `dirty` | 15 |
  | a second `setRules` loses the pending queue | 3 (live Focus-2 test, after I made the populations disjoint) |
  | rescan settles after its first step | 6 |
  | rescan validates with C | 24 |
  | would_block without the `rule:` clause | 1 (golden) |
  | S_P built with W's reach | 1 (`probe.test.ts:263`, the preview comparison; the golden harness always has W = C) |

## TDD evidence
- **RED:** `pixi run golden-fixtures`, which changed only `validation_steps.json`. Then `pixi run engine-test`: `Test Files 5 failed | 79 passed (84)`, `Tests 51 failed | 1218 passed (1269)`.
  - The new cases in `live.test.ts`, `probe.test.ts` and `invariants.test.ts` failed, with part 3 of `steps.golden.test.ts`.
  - `store.test.ts` failed at module level, and so did plan 2's two `steps.golden` cases. The cause was `TypeError: (0, rulesStatusBody) is not a function`, from the harness and the test calling the new export. This is not a behaviour red: the brief expected plan 2's cases to stay green, and they did once the export existed, over a byte-identical `runs[0]`. No other red.
- **GREEN:** after the implementation, `pixi run engine-test` gave 84 files and 1,282 tests passed.

## Files changed
- `engine/src/validation/live.ts`, `engine/src/validation/bodies.ts`, `engine/src/rules/compile.ts`, `engine/src/index.ts`
- `engine/test/golden/model-steps.ts`
- `engine/test/validation/{helpers,live.test,probe.test,steps.golden.test,store.test}.ts`, `engine/test/working/invariants.test.ts`, `engine/test/service/issues.test.ts` (reads `runs[0]`)
- `tests/golden/model_steps.py`, `tests/golden/scenarios/validation_steps.py`
- `engine/fixtures/golden/validation_steps.json` (generated)
- `engine/README.md`: the `src/validation/` bullet and the golden-fixtures bullet.

## Self-review findings (fixed before the commit)
- **Preview order when the rule sets are only reordered.** I first shared `preview = working` whenever Δ was empty. With the same rules in a different order, that gives W's issue order, not C's. Now `working` is shared only when the identity lists are equal in order; otherwise the preview is validated with C over hooks ∪ C-reach.
- **Dropping `deltaOf` entries by C's reach.** I first also dropped the entries the committed rules reach from a transition's dirty set. On reflection this is unnecessary:
  - an entry is found only for an owner outside S_M, where its working-state issues equal its committed ones;
  - it is used only while the owner is again outside S_M;
  - so it holds for a fixed `(rev, rules)` whatever transitions happen between.
  - I kept M7's own drop of the transition's dirty ids and removed the extra walk.
  - Mutations that remove the drop, or the rev check, are therefore not observable. Only both together would be, and the rev check covers deltas.
- **Weak fixtures.**
  - The first churn rules gave no `named` or `owns` issues on some seeds. I changed `owns` to "owns a Part owning at most one", dropped `named`'s `when`, and committed a coded Slot in the probe scene.
  - The keystroke test over the full scene was vacuous: the staged edits' reach covered every ΔPop owner. It now uses a replica with nothing else staged plus the typing element.
- I removed unused imports and a stray spy block, and dropped an unnecessary `RULE_CHECK_PREFIX` export from `index.ts`.

## Issues and concerns
1. **For Task 4: `RESCAN_STEP` is a frozen `{done: 0, total: 0}` sentinel.** The service's sweep `progress` callback (`service.ts` `sweep()`) must skip it by identity (`p === RESCAN_STEP`). If it were forwarded, `done === total` could read as "swept".
   - Nothing in this commit calls `setRules` from the service, so no rescan occurs yet.
   - Note that `whenSwept()` now also waits for the rescan, so `validateModel`'s existing wait covers it.
2. **The seeded invariants rarely hit a reach-only flip.** With the brief's four atoms over `ops_churn`, most verdict changes are already covered by the hooks and neighbourhoods. I measured, with reach disabled, about one reach-dependent action per 40.
   - I raised the rules variant of test 5 to 60 actions. With reach disabled it now fails in 4 of 8 seeds (both variants).
   - Denser churn would make it stronger, but I kept to the brief's atoms and left `random-ops.ts` unchanged.
3. **M5's premise held.** There were no counterexamples in the seeded runs, including the tag/validate oracle checks after every action.
4. **`live.ts` grew from 358 to about 620 lines.** Everything the plan assigns to it (W/C, setRules, rescan, reach, settled, origins with Δ, `deltaOf`) is in it. I did not split it; Task 5 adds `committedOf` there too.
5. **The `validation_steps` fixture changed shape to `{runs: [...]}`.** `issues.test.ts` and `live.test.ts` read `runs[0]`.
6. **`validateBody` order when W ≠ C.** The probe part's issues come first, then the cached ΔPop∖S_M part. So the `working` order is not one `validateScoped(S_W)` run's order. No oracle defines this case (the server has no staged rules), and tags and multisets are unaffected.
7. **No Python bug found** (D18).

## Fix round 1

Finding: Review Focus 1's seeded test did not catch reach missing from a rebase alone. Replacing `this.reach(dirty)` with `dirty.ids` in `unstage` and `applyDelta` only, while keeping reach in `stage`, left `test/validation` and `invariants.test.ts` green. My mutation table measured only the all-transitions mutation.

### What changed
- `engine/test/working/invariants.test.ts`: a new `describe('reach through a rebase')`. The committed chain is Part `p {name: 'x'}` –Seats→ `s1` –Feeds→ `s2 {code: 1}`, under `churnRules(mm).a` as both W and C. `p` passes `rule:seated` at the start, and the test asserts it.
  - **Delta:** a peer commit sets `s2.code = 0` and the replica applies the delta. Now `p` holds `rule:seated`, and the store equals `sweptFresh`.
  - **Unstage:** a staged `s2.code = 0` makes `p` fail, through the stage's reach. After `unstage('all')`, `p` passes again, and the store equals `sweptFresh`.
  - `addNeighbourhood` reaches one hop from `s2` (to `s1`), so only reach finds `p`.
- Report correction: the "S_P built with W's reach" mutation is caught by `probe.test.ts:263`, the preview comparison, not by the golden test. The golden harness always has W = C. The table row is fixed above.

### Evidence
- Green on the real code: `pixi run -e frontend npx vitest run test/working/invariants.test.ts test/validation` (from `engine/`) gave `Test Files 8 passed (8)`, `Tests 197 passed (197)`.
- Red under the rebase-only mutation, with only `live.ts`'s `unstage` and `applyDelta` lines changed. The same command gave `Tests 2 failed | 195 passed (197)`:
  - `reach through a rebase > a delta that moves a property two hops from the owner revalidates the owner`: `AssertionError: expected false to be true`
  - `reach through a rebase > an unstage that moves a property two hops from the owner revalidates the owner`: `AssertionError: expected true to be false`
  - The mutation was reverted afterwards; `git diff --quiet src/validation/live.ts` was clean.
- `pixi run engine-check`: clean. `pixi run engine-tidy`: clean.
- Commit: `Test reach through unstage and delta`.
