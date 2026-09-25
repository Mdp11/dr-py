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

