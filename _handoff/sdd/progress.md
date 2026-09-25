# SDD ledger — plan: docs/superpowers/plans/2026-09-25-eval-rules.md

Spec: docs/superpowers/specs/2026-09-24-evaluation-design.md (reachable). Branch feat/eval-rules cut from engine-migration @ 2cca78a (controller did Task 1 Step 1). Ids AD-33, K-65, K-66, C-24, T-11, U-11 free (grepped).

## Preflight scan

### Pairs sharing a file or interface
| Tasks | Produces → consumes | Found |
|---|---|---|
| T1→T2 | `parse_result` (api/routes/rules.py) → golden recorder `parses` | consistent; recorder is under tests/, freeze allows |
| T2→T3 | CompiledRules, validateScoped(rules), expandScope, EMPTY_RULES → LiveIssues | consistent |
| T2↔T3 | tests/golden/model_steps.py: T2 adds rules/reach/expand; T3 adds rules on seeded recorder + rules_status in issues | additive, consistent |
| T2→T4 | ruleSources(set, layer), WireArtifact.rules → service rulesMoved | consistent; ruleSources has no unit test in T2 Step 1 (see ruling R2) |
| T3→T4 | setRules/settled/whenSettled/rulesVersion → M8 reads wait | consistent |
| T3↔T5 | live.ts/bodies.ts/invariants.test.ts: T5's committedOf layers on T3's origins | consistent; T5 must keep T3's exact probe for preview/validate |
| T4↔T5 | engine/bench/run.ts rows (rules rows / K-59,K-61 rows) | additive |
| T4↔T6 | engine-route.ts FALLBACKS + replica.svelte.test.ts :2040/2064/2082: T4 renames refusal, T6 rewrites cases | consistent; T6's engine-route test "already moved in T4" |
| T5↔T7 | BACKLOG-ENGINE.md: K-59/60/61 (T5) vs R-3/K-65/K-66 (T7) | disjoint entries |
| T2..T5,T7 | engine/README.md bullets | each task owns its bullet |
| T6→T7 | shell parse → e2e | consistent |

### Each task against itself
| Task | Found |
|---|---|
| T1 | tests ↔ M1 consistent; empty doc → "{}" requires T2's reader to accept `{}` (defaults) — carried to T2 |
| T2 | Step 3 requires readArtifacts to refuse a malformed `rules` (422) but Step 1 lists no test for it; ruleSources untested — ruling R2 |
| T3 | storeListBody signature change matched by store.test.ts in Files; S_W assertions match M7 |
| T4 | Step 2 expects plan-2 `reaches validation rules` cases red then deleted — consistent with M10 Route |
| T5 | "changes no answer" consistent with its tests |
| T6 | Files list api/artifacts.ts and model.svelte.ts without M10 naming their change — implementer's call |
| T7 | Step 8 includes the fast-forward — needs owner go-ahead (ruling R3) |
| All | "one commit per task" vs fix-round commits — ruling R1 |

### Rulings
- Ruling R0: no git worktree; the branch lives in the main checkout — the owner's plan and handoff cut feat/eval-rules there and pixi envs/e2e servers live there — cost if wrong: none beyond a dirty main checkout during the build.
- Ruling R1: fix rounds commit as separate commits; once a task's review is clean the controller squashes BASE..HEAD into the one task commit (`git reset --soft BASE && git commit` with the task's subject) — the plan wants one commit per task and the branch is unpushed — cost if wrong: fix-round history lost from the log (reflog keeps it).
- Ruling R2: Task 2's implementer adds a readArtifacts test (malformed `rules` → refused) and a ruleSources unit test (layering, 'pending' fallback, discard, unreadable) — Step 3 and M3 mandate the behaviour, only the test list omits it — cost if wrong: a few extra tests.
- Ruling R3: Task 7 stops at its commit; the fast-forward of engine-migration is left to finishing-a-development-branch with the owner's go-ahead — handoff requires explicit go-ahead — cost if wrong: none.

## Progress
Task 1: dispatched (BASE 2cca78a, critical-implementer id a78752ef432f2fc2c)
Task 1: implementer DONE_WITH_CONCERNS at 8bbe97c (core 2588 passed)
- Ruling R4: bad YAML scalar (`x: 2001-13-45`, `!!float abc`) raises an unwrapped ValueError in frozen `parse_rule_set`, so /rules/lint and /rules/parse answer 422 not `ok:false` — pre-existing server bug, core/validation/rules frozen and outside Task 1's allowed files, the engine has no YAML side — recorded as a new K item in Task 7's backlog step, not fixed — cost if wrong: such YAML 422s both routes and the shell's parse retries it as a failed parse (the set stays 'pending').
- Ruling R5: /rules/parse is documented only in api/README.md (core/README.md carries /rules/lint but is outside Task 1's allowed files; Task 7 edits core/README.md anyway) — cost if wrong: one doc line in the wrong README until Task 7.
Task 1: minor (deferred): /rules/parse (and /rules/lint) answer 422 on a PyYAML constructor ValueError (`!!float abc`, `2001-13-45`); api/README.md:19 claims "200 for any string" — fold the K item + README correction into Task 7 (see R4); Task 6's parser must treat a non-2xx parse as failed (M10: dropped, retried at next attach)
Task 1: minor (deferred): api/README.md:19 /rules/parse bullet sits under "Replica routes"; core/README.md:24 (lint) does not point to it — Task 7 touches core/README.md
Task 1: minor (deferred): artifacts.py:99-103 `_with_rules` non-dict fallback is unreachable (ArtifactPayloadOut.payload is a dict); comment overstates
Task 1: complete (commits 2cca78a..8bbe97c, review clean)
Task 2: dispatched (BASE 8bbe97c, critical-implementer id a8bb88fc78937e72b)
Task 2: implementer DONE_WITH_CONCERNS at ee54e40 (engine 1,240 in 84 files)
- Ruling R6: pyRuleEq follows Python's `_eq`, where a None operand equals a None list item (`equals: null` holds on `[None]`), not M4's "a null operand never matches" — the Python core is the oracle and the fixture pins it — cost if wrong: none on the server side; the plan sentence is wrong.
- Ruling R7: accept the additive `parseExact(text, {floatConstants})` / `pyDumps(…, {allowNan})` options and moving `pyContains` into value/compare.ts — M2's `parseJson` cannot tell `Infinity` from `"Infinity"`, and the options are opt-in so existing callers keep their answers — cost if wrong: a touched plan-1 area; the golden staleness and value tests guard it.
- Ruling R8: `RuleSource.parse` is `RulesParse | null` (null = arrived without a parse → unreadable), not the brief's `RulesParse` — M3 needs that state carried — cost if wrong: an interface rename for Task 4.
- Ruling R9: a committed parse re-arriving becomes the "last parse" a 'pending' staged entry falls back to, as M3's text says ("written whenever a committed artifact or a staged entry arrives with a parse") — literal plan; only a peer's payload refetch during a pending staged edit reaches it, and reads wait for the rescan — cost if wrong: one extra rescan, and working rules showing the committed set until the staged parse lands.
- Ruling R9 (revised): a committed (re-)arrival does NOT overwrite the last parse while the id's staged entry carries a payload, and setStaged keeps a parse only for an entry that carries a payload (`carriesPayload`) — D7's "'pending' keeps the last parse received for that id" means the staged edit's parse; the literal M3 wording causes a transient wrong W and two rescans. Carried into Task 4's dispatch (artifact-set.ts:224/232/247) with tests — cost if wrong: a pending staged edit stands on an older staged parse instead of the committed one until its parse lands.
Task 2: minor (deferred): engine/test/rules/document.test.ts:285-292 100k-deep case is refused by parseExact's stack overflow, not the reader's depth check — relabel or drop
Task 2: minor (deferred): type-level import cycle artifacts/artifact-set.ts:2 ↔ rules/sources.ts (RulesParse could live beside WireArtifact)
Task 2: minor (deferred): EMPTY_RULES singleton holds mutable Maps (compile.ts:46-54); ReadonlyMap or a factory
Task 2: complete (commits 8bbe97c..ee54e40, review clean)
Task 3: dispatched (BASE ee54e40, critical-implementer id a50855e411a29cd6c)
Task 3: implementer DONE_WITH_CONCERNS at a3e8299 (engine 1,282 in 84 files; M5 premise held; RESCAN_STEP sentinel for Task 4)
Task 3: review Needs fixes — Important: Focus-1 invariants test stays green with reach removed from unstage/applyDelta (review head a3e8299)
Task 3: minor (deferred): appliesPopulation recomputed per probe while W≠C (live.ts:551,569) — measure at M
Task 3: minor (carried to Task 4): RESCAN_STEP {done:0,total:0} satisfies done===total; service must filter by identity (distinct yield type preferred)
Task 3: minor (carried to Task 4): setRules before the sweep lists its ids queues a redundant full-population rescan — service should pass rules to the LiveIssues constructor at ready
Task 3: minor (deferred): engine/test/golden/model-steps.ts:258 rulesStatus duplicates rulesStatusBody
Task 3: minor (deferred): Focus-2 test's staged edit on a rule's owner vs later setRules not pinned (live.test.ts seeds 1–3)
Task 3: minor (deferred): live.ts 627 lines; origins/deltaOf a natural seam before Task 5
Task 3: fix round 1 dispatched (resume implementer)
Task 3: fix round 1/5 (1 addressed, 0 open; commits a3e8299..c957bfa)
Task 3: complete (commits ee54e40..51c17911, review clean; squashed a3e8299+c957bfa per R1)
Task 4: dispatched (BASE 51c1791, critical-implementer id af5fbec78178f582f; carries R9-revised, RESCAN_STEP filter, rules via constructor at ready)
Task 4: implementer DONE_WITH_CONCERNS at 80f6de1 (engine 1,299/84, frontend 3,008/283). Bench: rescan 110 ms (longest step 5.4); sweep with rules 917 (longest step after first 6.3); stage 1,000 ops + reach 84; origin probe 100 batches + staged rule change 199. Parity equal over 18,523 issues (10,815 rules, 6 rules).
- Ruling R10: CT-4 and BACKLOG-ENGINE.md's `reaches validation rules` text stays until Task 7, which the plan schedules to edit CT-4 — the plan puts those doc edits in Task 7 explicitly — cost if wrong: two commits where architecture/ lags the code.
Task 4: minor (deferred, recommend fixing before merge): after a sweep step throws mid-rescan (service.ts:651-659, scheduler.ts:311-326) live.rescan stays non-null and no slot is set, so later issue reads wait on whenSettled forever (until close/validateModel/rule change) — refuse or re-set the slot in settled()
Task 4: minor (deferred, recommend fixing before merge): second-rescan test (issues.test.ts ~1700-1729) goes vacuous if SWEEP_STEP shrinks; size from exported SWEEP_STEP and assert settlement at the checkpoint
Task 4: minor (deferred): cancelled-read test only proves registration; cancelled waiting calls linger in `awaiting`/`waiting` until dropIssues
Task 4: minor (deferred): BackgroundTask<P> type distinction relies on method bivariance (optional flag, not enforced)
Task 4: minor (deferred): frontend/README.md one re-flowed ~110-char line; frontend-test stderr MSW/ECONNREFUSED noise pre-existing
Task 4: complete (commits 51c1791..80f6de1, review clean)
Task 5: dispatched (BASE 80f6de1, critical-implementer id ae6aaec4d040a95d4)
Task 5: implementer DONE_WITH_CONCERNS at 2851f48 (engine 1,314/85). K-59 first step 13→0.0 ms, browser longest slice sweeping 9.7→9.7, digest 12→11; K-60 uniqGroupOf 20k 23→1.7 ms, sweep step with group 39→7.9; stage 1,000 ops 82→54; K-61 getModelIssues after keystroke 7.6→0.0 (100 batches), 258→0.0 (1,000). Parity equal 18,523. Concerns: sweep re-walks after each re-sort (8,192/step skip) — frequent re-sorts could starve it; K-60 server half re-scoped (min over group + sort per call); service.ts answer() probe counter (outside file list); live.ts ~790 lines.
Task 5: review Needs fixes (head 2851f48) — Important: sweep chase — every probe/rebase replay recreates staged creates at fresh ords above the cursor, so the live iterator re-pulls them; with many staged creates and steady activity during the initial sweep, `seeded` is held off (repro: 600 staged creates, sweepStep 50, probe every 5 steps → >3,000 steps vs ~42). Docs misname the trigger. Partly plan-mandated (M9 "entities created during the sweep are pulled too").
- Ruling R11: fix without touching the frozen op applier/model: the sweep caps its pull at the max ord per kind taken when it starts, and ends with a bounded step revalidating the currently-alive staged-created ids (the only entities a replay moves past the cap; those created by a transition are validated by it) — M9's "created during the sweep are pulled too" is what makes the chase unbounded, and the plan's intent (K-59: bounded first step, a sweep that ends) wins over that sentence — cost if wrong: an entity past the cap that is neither a staged create nor validated by its transition would be missed; the invariants tests guard it.
Task 5: minor (deferred, recommend before merge): no test covers tagsHold's `seeded` guard (live.ts:734) — a mid-sweep read/stage/read vs probedListBody would catch it
Task 5: minor (deferred): sweepSkip ≤ 0 makes the sweep never end (live.ts:555, option unvalidated :288)
Task 5: minor (deferred): tag scope only grows until delta/rule change; list read rebuilds O(scope) (bodies.ts:102-103)
Task 5: minor (deferred): browser "longest slice while sweeping" row does not show K-59's fix; the claim should rest on the digest-check row
Task 5: fix round 1 dispatched (resume implementer)
Task 5: fix round 1/5 (0 addressed, 1 open — BLOCKED: R11's premise fails; a refused batch rewinds a deleted entity to the map's end at its old ord, `stage` rethrows before validating, and the ord≤max skip drops it — an existing correctness hole at 2851f48; no commit)
- Ruling R12 (supersedes R11): the sweep replaces the `ord ≤ max` skip with a set of the ids it has validated since it started (elements and relationships), keeping the live iterator, the epoch guard and the bounded skip — the set is O(model) like plan 2's id list, so memory does not regress, and it is immune to both rewind-at-old-ord (refused batches) and replayed creates; options (a) validating refused batches touches stage's failure semantics and the probe's replay-failure path, (c) reverts K-59 — cost if wrong: O(model) ids held for a sweep's life (same as plan 2), and the iterator still walks re-appended entries as cheap skips.
Task 5: fix round 2 dispatched (resume implementer, R12)
Task 5: fix round 2 at abae720 — validated-id set; refused-batch and chase tests red on 2851f48, green now (chase ends in 44 steps); engine 1,316; parity equal 18,523. K-59 rows: first step 0.0; sweep total 841 → 986–1,035 ms; longest step after first 6.3 → 10–14 ms (Set growth/rehash near 262k ids).
- Ruling R13: accept the longest-step regression (10–14 ms, over the 8 ms slice target, under CN-3's 16 ms) without further optimization — the plan's Task 5 Step 6 says "if a target is still missed, report it; do not go further" and the owner asked for numbers before any optimization beyond Task 5 — cost if wrong: one sweep slice per rehash can overrun 8 ms at M until a follow-up (options: a set per map; record marks plus a set for re-made records); Task 7's browser bench will show whether it reaches CN-3.
Task 5: fix round 2/5 (2 addressed, 0 open — chase + refused-batch hole; commits 2851f48..abae720)
Task 5: minor (deferred): a probe over a staged delete of a committed entity marks the map for re-sort (rewind.ts:36/41 → model.ts:240); the next ordered read moves orderEpoch and the initial sweep re-walks ~37 skip steps at M — docs name re-sorts but not this trigger
Task 5: minor (deferred, pre-existing): a non-PatternUnusable throw in revalidate leaves pulled ids marked validated
Task 5: minor (deferred): live.ts sweepSteps docstring line overlong
Task 5: complete (commits 80f6de1..9d421207, review clean; squashed 2851f48+abae720 per R1)
Task 6: dispatched (BASE 9d42120, critical-implementer id a0273cd62b4a8bd9e; carries /rules/parse 422 → failed parse)
