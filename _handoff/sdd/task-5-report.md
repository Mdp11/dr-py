# Task 5 report — the sweep's first step, key texts and the panel's probe

Status: DONE_WITH_CONCERNS · commit `2851f483` on `feat/eval-rules` (one commit, not pushed).

## What I implemented

**K-59 (M9, sweep listing in steps)**
- `Model.orderEpoch` (`engine/src/model/model.ts`). It moves whenever `elements()` / `relationships()` re-sorts a map.
- `LiveIssues.sweepSteps()` (`engine/src/validation/live.ts`):
  - The first step only takes `total = elementCount + relationshipCount` and yields `{done: 0, total}`, which costs O(1). The service tests assert `sweeps[0]` is `done: 0`, so the wire protocol stays as it was.
  - Each later step pulls up to `sweepStep` entities (elements in state order, then relationships) from a live iterator per map. Each map has a `Cursor {iter, epoch, ord (max seen), ended}`.
  - An entity is pulled only when its `ord` is greater than the maximum handed out so far. Anything else it passes over, at most `sweepSkip` a step. The new option `sweepSkip` defaults to 16 × `sweepStep`, which is 8,192 at M.
  - When the epoch has moved, the step takes a fresh iterator.
  - `done` counts pulled entities and is capped at `total - 1` until the last step, which alone yields `done === total`.
  - `restartSweep()` builds a fresh cursor.
- `frontend/bench/main.ts` runs one ping loop at a time: the first until the digest check ends, the second from then until the sweep ends. There is a new count row. If the sweep ends first, the row reads NaN.

**K-60 (M9, cached key texts)**
- `IndexSet.keyText: Map<ElementRec, string>` holds exactly the members of buckets of two or more:
  - `addToGroup(el, text = freshKey(el))` stores the text, and fills the first member's entry when a bucket turns shared.
  - `removeFromGroup` deletes the entry, and deletes the last member's entry when the bucket is back to one.
  - `rekey` computes `freshKey` first and writes it into the cache *before* its unchanged-hash early return (the K-60 constraint).
  - `rebuildSteps` clears the map.
- A private `freshKey` does the computing, and `uniqKey` reads the cache first. `uniqGroupOf`, `uniqGroups` and the uniqueness validator therefore read cached texts.
- `uniqueness.ts` needed no change: it already goes through `uniqKey` / `uniqGroupOf`.
- `verifyConsistent` compares the cached texts (sorted by id) before and after its in-place rebuild. The check is named `key texts`.

**K-61 (M9, incremental tags)**
- `LiveIssues.tagScope(): ReadonlyMap<owner, readonly Issue[]>` returns the kept scope when it holds. Otherwise it builds the scope from `origins()` (every id of `dirty`, with its committed issues) and keeps it if it holds.
- "Holds" means all of the following: seeded, `rescan === null`, same `wc.rev`, same `rulesVersion`, and W's identities equal to C's.
- `keepTags(ids)` runs from `reach()`, which only `stage`, `unstage` and `applyDelta` call, so it runs for transitions only and never for the sweep or a rescan. It runs before `revalidate`'s `replace`:
  - if the scope no longer holds, it drops it;
  - otherwise each dirty id without an entry gets `store.issuesOf(id)`, the issues from before the transition. Store arrays are never mutated in place, so the reference is safe.
- `setRules` and `markUnusable` drop the scope.
- `resetTagScope()` is the test-only reset.
- `probes` counts fresh `origins()` computations.
- `issueListBody` (`bodies.ts`) tags through `tagScope()`: an owner absent from the scope is `on_server`; otherwise its issue is matched against the scope's committed multiset. `validateBody` and `previewBody` still call `origins()`.
- **Change the spec did not anticipate: `engine/src/service/service.ts`.**
  - Why: `answer()` called `live.origins()` before every body, so `getModelIssues` would still have probed on every keystroke.
  - What changed: `answer()` now runs the body inside the try/catch and restarts the digest check when `live.probes` moved with batches staged. That is the old condition, "another origins than the last one read", restated.
  - `Issues.probed` is removed.
  - This was the smallest change that makes K-61 reach the service.
- I did not split `live.ts`. It is now about 790 lines; the origins, `deltaOf` and tags parts could move to their own module later.

## Tests and results

| Suite | Result |
|---|---|
| `pixi run engine-test` | 1,314 passed in 85 files (Task 4's head: 1,299 in 84) |
| `pixi run engine-check` | clean |
| `pixi run engine-tidy` (and `check_only=true`) | clean |
| `pixi run frontend-test` | 3,008 passed in 283 files |
| `pixi run frontend-tidy` (svelte-check 0 errors) | clean |
| `pixi run sandbox-test` | 14 passed |
| `pixi run engine-parity-large` | "Parity: the two multisets are equal", 18,523 issues (10,815 from rules) on both sides |

No golden, service or shell test was changed. `test/validation/live.test.ts`'s existing sweep assertions (`{done: 0, total: 4500}`, `reports[0] === 0`, `reports.at(-1) === 600`) still hold unchanged.

## TDD evidence (step 3, on Task 4's code)

Expected red, and red:

- `test/model/indexes.test.ts` (new): all 10 failed with `TypeError: model.indexes.keyText is not iterable` or `Cannot read properties of undefined (reading 'size')`. The cases:
  - churn with the real hash (×3);
  - churn under `hashKey: () => 0` (×3);
  - property edit, re-parent and key relationship under one hash;
  - a bucket back to one member;
  - `uniqGroupOf` against the uncached groups (×2).
- `live.test.ts`, "the sweep lists in steps", seeds 1 and 2: `expected 4500 to be less than or equal to 1097` in the final run's parameters. The first red run, with skip 300, read `≤ 397`.
- `live.test.ts`, "reports done === total at its last step only": `expected 600 to be less than or equal to 50`, the first step pulling every entity.
- `live.test.ts`, "the panel's tags", keystroke case: `expected "probeStaged" to not be called at all, but actually been called 1 times`.
- `live.test.ts`, "probe again after a delta, …": `expected "probeStaged" to be called 1 times, but got 2 times`.
- `invariants.test.ts`, the 16 seeded "rules swapped" runs: `TypeError: live.resetTagScope is not a function`. The `probedListBody` comparison passed on the old code up to that point, as it should, since it is the old algorithm.

No other test went red.

Mutation checks, run after implementing and then reverted:
- Dropping the refresh in `rekey`'s early return: 5 `indexes.test.ts` cases (hash-0 churn ×3, the explicit re-parent case, one `uniqGroupOf` case) plus the invariants runs failed.
- Removing `keepTags`: 15 failures (invariants + live).
- Removing the rev check from `tagsHold`: 18 failures.
- Removing the `ord` filter in `pull`: the sweep never ended within 1,000 steps and the test failed on `ended`. It no longer hangs; the loop is bounded.

## Numbers

Model M: 170,340 elements and 126,820 relationships. All values are medians of 3 passes in ms. "Before" is Task 4's code with the new rows added; "after" is this commit. The two runs are separate sessions.

### Engine bench (`pixi run engine-bench`)

| Row | Before | After | Target (K item) |
|---|---|---|---|
| sweep the issue store | 843 | 841 | |
| its first step (was "every id listed") | **13** | **0.0** | K-59: ≤ 8 ms slice target — met |
| its longest step after the first | 6.0 | 6.3 | ≤ 8 |
| sweep again with 20,000 duplicates | 1,956 | 989 | |
| its longest step after the first | **39** | **7.9** [7.6 8.1 7.9] | K-60 (27 ms/step in the backlog): ≤ 8 ms step target — met, one pass at 8.1 |
| uniqGroupOf over a 20,000-member group (new) | **23** | **1.7** | K-60 |
| stage 1,000 ops + revalidation | 82 | 54 | |
| unstage all + revalidation | 95 | 85 | |
| origin probe (100 staged batches) | 30 | 31 | unchanged (exact probe) |
| delta over 100 staged + revalidation | 15 | 18 | noise |
| getModelIssues after a coalesced keystroke, 100 batches (new) | **7.6** | **0.0** | K-61: no probe per keystroke — met |
| getModelIssues after a coalesced keystroke, 1,000 batches (new) | **258** | **0.0** | K-61 — met |
| rules rescan | 109 | 112 | |
| its longest step | 4.7 | 4.7 | |
| sweep with rules | 870 | 902 | noise ([833 1111 870] vs [839 912 902]) |
| its longest step after the first | 6.0 | 6.7 | |
| stage 1,000 ops + revalidation with reach | 81 | 58 | |
| origin probe, 100 staged + a staged rule change | 196 | 205 | |
| the changed rule's population, once (new) | 2.1 | 2.1 | Task 3 note |
| open the snapshot | 2,561 | 2,442 | |
| heap after GC, MB | 236 | 236 | |

The remaining rows (open, parse, index, digest, search, criteria, navigation, stage/unstage/rebase/delta without the store) moved only by noise. Both raw outputs are in the scratchpad (`bench-before-engine.txt`, `bench-after-engine.txt`).

### Browser bench (`pixi run engine-bench-browser`, ping loops separated in both runs)

| Row | Before | After | Target |
|---|---|---|---|
| sweep (ready → seeded) | 796 | 858 | |
| longest slice while sweeping (the check ended) | **9.7** [9.7 20 9.5] | **9.7** [9.7 10 9.7] | K-59: ≤ 16 ms (CN-3) — met |
| round trips once the digest check ended | 36 | 40 | |
| longest staged round trip during the digest check | 12 [11 12 17] | 11 [12 11 11] | ≤ 16 — met |
| its moment, after ready | 26 | 151 | the early spike (the sweep's first step) is gone |
| digest check: ready to its last progress | 477 | 502 | |
| cold open | 1,815 | 2,052 | noise: load average 1.9 before vs 2.3 after |
| longest round trip during the open | 49 | 56 | pre-existing, the open's parse; not K-59 |
| worker heap, MB | 116 | 116 | |
| stage 1,000 update_element ops | 64 | 67 | |
| unstage all | 84 | 89 | |
| the first listElementsPage after the re-sort | 18 | 24 | |
| broadest scan | 362 | 380 | |
| stage 100 single-op batches | 25 | 29 | |
| applyDelta over 100 staged | 15 | 16 | |

The after run was slower across the board, the open included, because the machine was more loaded. Compare within a run only.

The digest check ends about 480 ms after ready, while the sweep takes about 800 ms. So with the loops separated, the sweep's *first* step always lands inside the check's window, and the "while sweeping" row never saw it, even before the fix. Its effect shows in the check's row: its longest trip was posted 26 ms after ready before, and 151 ms after.

### appliesPopulation (Task 3's note)

The changed rule's population costs 2.1 ms of the 196–205 ms probe with a staged rule change, about 1%. Recomputing it per probe does not matter at M.

## Parity

`pixi run engine-parity-large`: the multisets are equal over 18,523 issues (10,815 from 6 rules), the same count as Task 4.

## Files changed

- `/home/mdp/workspace/data-rover-py/engine/src/model/model.ts`: `orderEpoch`.
- `/home/mdp/workspace/data-rover-py/engine/src/model/indexes.ts`: `keyText`, `freshKey`, `rekey` refresh.
- `/home/mdp/workspace/data-rover-py/engine/src/debug/verify-consistent.ts`: the key-text check.
- `/home/mdp/workspace/data-rover-py/engine/src/validation/live.ts`: sweep cursors, `sweepSkip`, `tagScope`, `resetTagScope`, `probes`.
- `/home/mdp/workspace/data-rover-py/engine/src/validation/bodies.ts`: `issueListBody` goes through `tagScope`.
- `/home/mdp/workspace/data-rover-py/engine/src/service/service.ts`: `answer()` detects a probe by the counter; `probed` removed.
- `/home/mdp/workspace/data-rover-py/engine/test/model/indexes.test.ts`: new.
- `/home/mdp/workspace/data-rover-py/engine/test/validation/live.test.ts`: the K-59 and K-61 cases, `pullCounter`, `linked()`.
- `/home/mdp/workspace/data-rover-py/engine/test/validation/helpers.ts`: `probedListBody`.
- `/home/mdp/workspace/data-rover-py/engine/test/working/invariants.test.ts`: Focus 5.
- `/home/mdp/workspace/data-rover-py/engine/bench/run.ts`: the new rows; `measureKeystrokes`.
- `/home/mdp/workspace/data-rover-py/frontend/bench/main.ts`: ping loops separated.
- `/home/mdp/workspace/data-rover-py/engine/README.md`, `/home/mdp/workspace/data-rover-py/BACKLOG-ENGINE.md`: docs.

## Self-review and invariants checked

- **No answer changes.**
  - Goldens, service tests, the frontend (3,008) and the sandbox are untouched and green.
  - The sweep's progress protocol is unchanged: `done: 0` first, `done === total` only last.
  - Parity is equal.
- **K-60 cache invariant: an entry exists exactly for the members of shared buckets, and each entry equals `freshKey`.**
  - `verifyConsistent` checks it against a rebuild after every batch of the new churn tests. The churn covers the real hash and `hashKey: () => 0`, restores at old places through stage/unstage, key relationships and re-parenting.
  - Every seeded invariants run calls `verifyConsistent`.
  - I traced every mutation path: `setProperty`, `deleteProperty` and `overwrite` go through `onPropertyChanged`, and so does containment through `onRelationship*`, key relationships and deleting an element. Each ends in `rekey`, `addToGroup` or `removeFromGroup`. `deleteCascade` disconnects while the element is still present.
- **K-59: the order-epoch guard, and a bounded pull per step.**
  - Tested with restores at old places and forced re-sorts between steps: each step's pulls stay within `sweepStep + sweepSkip`, the store equals a fresh sweep, and the epoch moved. The `ord` filter is shown load-bearing by mutation.
- **K-61 exactness (Review Focus 5).**
  - After every action of 16 seeded runs (rule sets swapped both ways, deltas, own commits, unstages, merged edits), the incremental `issueListBody` deep-equals a body tagged through `origins()` (`probedListBody`, which leaves the scope alone) and the existing independent fresh-sweep oracle (`listedTags`).
  - Every fifth action, it also equals the list read after `resetTagScope()`, and the model is unchanged.
  - The store's containment-cycle staleness did not show a difference in these runs.
- **Fills happen for transitions only.** `keepTags` is called only from `reach()`, and only `stage`, `unstage` and `applyDelta` call that. `previewCommit` and `validateModel` still read `origins()`.
- RC-6 comments: no plan or spec references. No DOM or timers in `src/`.

## Concerns

1. **Sweep progress under frequent re-sorts.**
   - After a re-sort, the sweep passes back over what it had already handed out, 8,192 entities a step: up to about 37 steps at M.
   - If re-sorts came more often than that, the sweep would never end. My first test parameters (a re-sort every 6 steps, skip 300 at step 97) livelocked.
   - The old id list was immune to this. In practice a re-sort needs an ordered read after a restore at an old place, and a re-sort itself costs about 50 ms at M, so it cannot happen often.
   - This is recorded in the README and in K-59's Done note. I did not optimize it.
2. **K-60's server half, re-scoped more accurately than the backlog's text.**
   - The old text claimed the Python core "has the same shape" (re-keying). It does not: `uniq_key_of` / `uniq_groups` are already keyed by the frozen key.
   - What the server does pay: a `min` over the whole group per scoped member (`validators/uniqueness.py:54`, O(k × group) per chunk), and `sorted(group)` in `add_uniqueness_group_of` on every call.
   - The re-scoped K-60 (title changed, `open`) says this. `core/` is untouched.
3. **K-61: the scope grows** with every transition's dirty ids (neighbourhoods included) until a delta or a rule change resets it. It is bounded by the model's size, and `[...scope.values()].flat()` is rebuilt on every list read, O(scope). At the bench sizes this cost did not register (0.0 ms).
4. **Service change** (above). I also removed `Issues.probed`.
5. **Existing live-test sweep assertions** were not edited, but `done` is now "entities validated", capped at total−1 before the last step. The scripted `listed[done + 400]` offsets in "an edit during the sweep" keep their meaning, since elements come first in state order.

---

## Fix round 1: stopped, the argument fails (no code change, no commit)

The finding was that replayed staged creates keep the sweep chasing them. Ruling R11: cap the pull at each kind's greatest `ord` at the start, then end with a bounded revalidation of the staged-created ids that are still alive. R11 asked me to first check that the epoch-guard and skip logic still holds. It does not, and the failure is independent of the cap. As instructed, I stopped rather than improvise a different design.

**Counterexample: a refused batch puts an unswept entity back past the cursor, and no transition validates it.**
- A batch is refused (`OpError`) after an op that deleted something. `applyBatch` then rewinds it (`ops/apply.ts:284-285` → `ops/rewind.ts`).
- The rewind re-inserts each deleted entity with `insertElement(…, image.ord)` / `insertRelationship(…, image.ord)`. The record keeps its old `ord` but is appended to the end of the `Map`.
- `LiveIssues.stage` propagates the `OpError` from `wc.stage` before `reach` / `revalidate`, so nothing validates the restored entity.
- The sweep's live iterator then:
  1. passes the entity's old place, where it is now gone;
  2. reaches it at the end of the map;
  3. finds its `ord` at or below the greatest handed out, and skips it.
- A re-sort in between changes nothing once the cursor has passed that `ord`.
- The entity existed at the start, so only the sweep would ever validate it. It ends up missing from the store for good: the store is not equal to a fresh sweep.
- Plan 2's id list was immune, because the id was listed at the start.

**Reproduced** at `2851f483` with the real engine:
- Setup: 300 elements, `b-x` (a `Blk` with `n: 9`) at position 150, `sweepStep: 20`.
- Two steps, then `live.stage([delete b-x, delete 'gone'])`, which throws `OpError`, and `b-x` is back.
- After draining the sweep, the store is `[]`. A fresh sweep gives `[["b-x", ["…facets…n: 9 above max 5.0…"]]]`.
- The test is `/tmp/claude-1000/-home-mdp-workspace-data-rover-py/41598b5f-98cb-4324-aff3-c4573c0338d9/scratchpad/refused-counterexample.test.ts`. It was moved out of the repo; drop it into `engine/test/validation/` to run it.

**Why R11 does not cover it.**
- The restored entity's `ord` is below the start cap and it is not a staged create, so the final staged-create step never names it.
- The premise shared by M9 and my Task 5 docstrings is false for refused batches: "an entity put back at its old place was validated by the transition that did it". The same claim appears in `pull`'s docstring and `engine/README.md:21`.
- The seeded tests did not catch it. A refused `Churn` batch must delete an unswept entity that has an issue, ahead of the cursor. The seeded runs apparently never produced that combination.

**Other R11 checks, for the ruling:**
- Staged-created ids are not exposed cheaply today. They are the ids with a `null` first-touch image in the working copy's entries (`beforeElements` / `beforeRelationships`), and would need a new `WorkingCopy` accessor. `touchedIds()` lists every touched id, not only the created ones.
- Unstage and a peer delta's rebase re-create staged creates with fresh ords. Their dirty sets (the `touchedIds()` neighbourhoods, before and after) do name those ids, so rebases are covered.
- The probe (`origins()`) re-creates them with no validation. The reviewer's chase holds, and R11's final step would cover it.

**Decision needed (the controller's).** Some options, none built:
- (a) `LiveIssues.stage` validates what a refused batch's rewind restored (the batch's touched ids) before rethrowing. This makes "restored at an old place implies validated by a transition" true again. Every other rewind outside a probe already runs inside a transition that validates the touched ids.
- (b) The sweep keeps a set of ids validated since it started, instead of the `ord ≤ max` rule. That costs O(model) memory during the sweep.
- (c) Return to plan 2's id list for correctness and accept the first step's 13 ms, or build that list in steps before validating anything.

With R11's cap and final step on top, (a) would close both the chase and this hole. That still needs checking against the probe's own replay-failure path (`reinstate` after a failed replay).

State of the branch: HEAD is `2851f483`, unchanged. Nothing was committed in this round.

---

## Fix round 2 (ruling R12): track the sweep's validated ids — commit `abae7201`

**What changed**
- `engine/src/validation/live.ts`:
  - `Sweep` gains `validated: Set<string>`, holding element and relationship ids.
  - `Cursor` loses `ord`.
  - `pull` passes over an entity whose id is in the set, at most `sweepSkip` a step. It validates any other entity and adds it to the set.
  - The live iterator, the `orderEpoch` guard and the bounded skip per step are kept.
  - `done` and `total` are unchanged: `total` is taken at the start, and `done` is capped at `total - 1` until the last step.
  - The docstrings no longer claim that an entity put back at its old place was validated by a transition.
- Nothing from R11 was started: no cap, no staged-creates step.
- `engine/README.md` and K-59 in `BACKLOG-ENGINE.md` are corrected:
  - An entity the map holds between two steps is reached before the iterator ends, wherever it sits: one made by a transition, put back by an unstage, put back at the map's end by a refused batch's rewind (which validates nothing), or made again by a probe's replay.
  - The real bound: the walk ends as long as each step's `sweepSkip` outruns what lands behind the iterator between two steps. That is one entry per staged create for each replay (probe or rebase), or the whole map after a re-sort.

**Tests** (`engine/test/validation/live.test.ts`, "the sweep lists in steps")
- "reaches what a refused batch puts back at the end of the maps, unswept":
  - 300 `Other`s, plus `b-x` (a Blk with `n: 9`) at index 150, plus its `Link` `l-x` without `lbl`; `sweepStep` 20.
  - After two steps, `stage([delete b-x, delete 'gone'])` throws `OpError`.
  - The drained store must equal a fresh sweep.
- "ends while every few steps a probe makes the staged creates again, past what it has pulled" (the reviewer's scenario):
  - 1,000 elements + 500 relationships, 600 staged `create_element`s, `sweepStep` 50; one stage plus `origins()` every 5 steps.
  - `listed` = ⌈2,100 / 50⌉ + 2 = 44. The loop is capped at 3 × `listed`.
  - The test asserts fewer than 2 × `listed` steps, then `seeded`, and a store equal to a fresh sweep.
- The existing re-sort tests are unchanged and green.

**Red on 2851f48's `pull`, then green**
- Refused batch: `expected [ [ 'l-x', …(1) ] ] to deeply equal [ [ 'b-x', …(1) ], [ 'l-x', …(1) ] ]`. `b-x` was never validated.
- Chase: `expected 132 to be less than 88`. It hit the 3 × `listed` cap without ending.
- After the fix both pass. The chase ends in 44 steps, the same count as the id list.

**Commands and output**
- `npx vitest run test/validation test/working test/service`: 22 files, 379 tests passed.
- `pixi run engine-test`: 85 files, 1,316 tests passed.
- `pixi run engine-check`: clean. `pixi run engine-tidy`: clean.
- `pixi run engine-parity-large`: "Parity: the two multisets are equal." (18,523 issues).

**Numbers** (`pixi run engine-bench`, median of 3). Two runs; the machine was loaded, load average 2.9–3.1 against about 2 earlier.

| Row | Task 4 | 2851f48 | abae720, run 1 | abae720, run 2 |
|---|---|---|---|---|
| sweep, total | 843 | 841 | 1,035 | 986 |
| its first step | 13 | 0.0 | 0.0 | 0.0 |
| its longest step after the first | 6.0 | 6.3 | **10.0** | **14** |
| sweep with 20,000 duplicates | 1,956 | 989 | 1,205 | 1,170 |
| its longest step | 39 | 7.9 | 12 | 13 |
| sweep with rules, longest step | 6.0 | 6.7 | 14 | 10 |
| getModelIssues after a keystroke, 1,000 batches | 258 | 0.0 | 0.0 | — |

**Concern: the validated-id set pushes later steps past the 8 ms target.**
- Measured in isolation (Node 22, 300,000 ids, adds in groups of 512):
  - growing one `Set` costs 40–80 ms in total;
  - its rehash near 262,144 entries costs 8–20 ms inside a single step.
- That rehash is the new longest step: 6.3 → 10–14 ms, past the scheduler's 8 ms slice target, though under CN-3's 16 ms.
- Sharding the ids over 16 `Set`s cut the worst add-only step to about 5.7 ms, which on top of about 6 ms of validation is still past 8 ms.
- The first-step fix holds (0.0 ms), and the sweep is now correct.
- Following "if a target is still missed, report it and go no further", I did not optimize this.
- Options for the controller:
  - a set per map;
  - marks on the records, plus a set only for ids whose records were re-made;
  - accept the regression.
- The browser bench was not re-run in this round (the ruling asked for `engine-bench` only). Its K-59 numbers in the backlog are marked as taken before the set.
