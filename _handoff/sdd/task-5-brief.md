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

