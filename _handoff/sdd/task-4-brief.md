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

