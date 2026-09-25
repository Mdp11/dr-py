# Task 6 report: rule sets in the shell

Status: DONE_WITH_CONCERNS. Commit `7ea350d3` (base `9d42120`), "Hand rule sets to the engine from the shell".

## What I implemented

- `lib/api/types.ts`: `RulesParseSchema` `{ok, document: z.string().nullable(), errors: LintError[] (default [])}`, and `ArtifactPayloadSchema` (`ArtifactSchema` plus `rules: RulesParseSchema.nullable().optional()`) as the payload list's item. `listArtifactPayloads` returns `ArtifactPayload[]`. `getArtifact` and the other routes keep `ArtifactSchema`.
- `lib/api/rules.ts`: `parseRules(yaml, cfg?)` sends `POST /rules/parse`.
- `lib/engine/rules-parse.ts` (new):
  - `engineParse(out)` gives the engine `{ok: true, document}` or `{ok: false, errors}`. The document string is passed on untouched. It returns `null` for a body that is not a parse (`ok` with no document, or a failure with no errors).
  - `createRulesParser(parse)` returns `{attach, onParsed, busy, settled}`, following M10:
    - one parse per distinct text;
    - a non-2xx answer, a network error or a `null` from `engineParse` counts as a failed parse. It is forgotten, never retried by the parser itself and never made up, and the next `attach` of that text asks again;
    - it keeps only the texts named by the last `attach`, and drops a parse that lands for a text no longer named.
- `lib/engine/artifacts.ts` (the follower):
  - new required dep `parser`;
  - `wire()` passes `rules`, and leaves it out when the item carries `null` or a parse the engine cannot use (the engine then refuses with 501 `reaches unreadable rules`);
  - every staged push goes through `parser.attach(overlay, kindOf)`, and `onParsed` goes back through `stagedChanged()`, so a commit's hold still holds it;
  - the follower keeps a `kinds` map and exposes `kindOf(id)`;
  - `settled()` also waits for the parser, looping because a push can start a parse and a parse's landing queues a push.
- `lib/engine/shadow.ts`: the issues normalizer sorts `rules_status.skipped` by `JSON.stringify([artifact_id, rule, reason, set_name])`, through a shared `sortedBy` helper.
- `lib/api/validation.ts`: `ValidateOptions.rulesStaged` forces `shadow: 'never'`.
- `lib/state/artifact-edits.svelte.ts`: `hasStagedRules(kindOf)`.
- `lib/state/model.svelte.ts`: `validateAll` passes `rulesStaged: true`, and only when it is true, so the existing exact-argument tests still hold.
- `lib/state/replica.svelte.ts`: builds the parser over `parseRules`, scoped to the project like `payloads`. It exports `artifactKindOf(id)` and updates the gate comment.
- Test support:
  - `engine/__tests__/support/rules.ts` (new) holds rule sets over the smart-city model;
  - the fake project serves `POST /rules/parse` from `rulesParses`, answers a 422 for a text it has no entry for, and records `rulesParsed`.
- Docs:
  - `frontend/src/lib/engine/README.md`: the follower bullet (parses, `'pending'`, kinds, the rule-set alias rule), a new `rules-parse.ts` bullet (including the 422), the `rules` fallback's new trigger, the shadow rules, the gate, and the test support;
  - `frontend/README.md`: "Validation issues" (staged rule sets show in the panel and in Validate before any commit; the preview uses the committed rules), the fallback, the gate, the shadow, and "The artifacts".

## Deviations from the brief and the plan (each small; please rule on them)

1. **R-a: a created rule set is held under its real id alone during a commit's refresh.** No temp-id copy, no alias. The follower used to hold every create under both ids, so the engine's working set compiled the rule set twice and listed every rule issue twice during the refresh. That breaks Review Focus 4 ("no issue appears twice"). The new replica test catches it: restoring the alias turns that test and the follower test red. Why this is safe:
   - nothing names a rule set by its id;
   - the real-id copy lets `compose` merge an update staged on the real id during the refresh;
   - `stands` is the real id, so a failed refresh still drops it on newer committed news.
   Cost if wrong: a navigation cannot name a rule set anyway.
2. **R-b: `hasStagedRules(kindOf)` takes a kind lookup.** M10 has `hasStagedRules()` reading `header.kind`. But `stageArtifactUpdate` always records `header: null` (no caller passes a header), so a staged rules update would never count. The kind comes from the follower (`artifactKindOf`); a delete's own header still wins.
3. **R-c: the follower re-pushes the staged overlay when a load or an `artifact` event first tells the kind of an id that a staged update was pushed under.** Before that, the update went without `rules`. Once the committed rule set arrived, the engine would have read that as an update with a payload and no parse, i.e. `unreadable`. A commit's refresh now records kinds (`remember`) before it builds its overlay, for the same reason: an update staged on a created rule set's real id during the refresh. Each of the three paths has a test that goes red when the path is removed.
4. **R-d: the parser gained `busy()`** beside M10's three methods. The follower's `settled()` needs a synchronous check to loop correctly.
5. **R-e: the parser drops cached parses for texts the last `attach` did not name.** This bounds memory over a long editing session. The only cost is one extra parse when a text comes back.
6. A payload whose `yaml` is not a string parses `''`. The server validates `yaml` as a string at commit, so no such payload can be committed.

## Tests and results

- `pixi run frontend-test`: 284 files, 3,044 passed (baseline 3,008 in 283; +36 new).
- `pixi run frontend-check`: 0 errors, 0 warnings.
- `pixi run dr-tidy`: clean.
- `engine/` untouched, so the engine tests were not rerun.
- stderr: the same pre-existing noise as the baseline (26 → 24 lines; the timing-dependent replica tests vary). 11 unhandled `GET /model/issues` warnings against 13 in the baseline. My tests add no new stderr: none names a new test, `/rules/parse` or rules-parse.

### TDD evidence

RED, before the implementation: `pixi run frontend-test <9 files>` gave `Test Files 7 failed | 2 passed (9); Tests 9 failed | 163 passed`. Every red was expected:
- `rules-parse.test.ts`, `artifacts.test.ts`, `validation.test.ts`: the whole file, because `../rules-parse` was missing;
- the `hasStagedRules` ×4 tests;
- the shadow `skipped` ordering test;
- the validate-staged staged-rules test;
- the three replica rules cases.

Two notes on that run:
- The `api/rules.test.ts` parse tests were red in the baseline run (`parseRules is not a function`) and green once `parseRules` landed.
- The new engine-route test is green by design: Task 4 moved `FALLBACKS`.

GREEN:
- After the implementation, 3 reds remained, all test-design errors, fixed in the tests:
  - an intermediate `attach` in the `kindOf` test removed B from the wanted set, which the pruning rule then correctly dropped;
  - the pruning test awaited `settled()` while a parse it held back was still out, so it deadlocked;
  - the expected Validate order was my guess; the engine interleaves differently, so the test now compares by origin.
- Final run: 9 files, 230 passed. Full suite: 3,044 passed.
- Mutation checks, each restored afterwards:
  - remember after the overlay: 1 red;
  - no re-push on an event: 1 red;
  - no re-push on a load: 1 red;
  - `settled` ignoring the parser: 4 red;
  - rule-set alias restored: 2 red, including the replica commit test.

## Invariants checked

- **The document is never parsed or re-serialized in the shell.** The zod schema keeps it a `string`. `engineParse` copies the string reference. The `rules.test` case serves a document holding `1.0` and 9007199254740993 and gets it back byte-equal.
- **A 422 or a network error is a failed parse.** Covered by a parser test over MSW with a 422 (no second request until the next `attach`, `onParsed` never fires) and by the follower test "a parse not answered…". Nothing is made up and there is no retry loop: a retry happens only through an `attach` from a staged push.
- **Types-only engine imports in production code.** `rules-parse.ts` and `artifacts.ts` import `type` from `$engine`, and ESLint passed in dr-tidy.
- **Real engine, no fake timers, every link disposed.** The follower tests use `syncOver`. The validation tests put `follower.stop` into `made`. The replica tests use the store's teardown.
- **Review Focus 4:**
  - rules arriving after the sweep keep the gate closed until the load, then exactly one refetch from the engine lists the rule issues;
  - the commit of a staged rules create lists each issue once, `uncommitted` through the refresh window (a manual refetch during the held fetch) and `on_server` after, never back to `uncommitted`.
- **Review Focus 6.** An unreadable document sends getModelIssues, validateModel and previewCommit to MSW, unmarked. A committed item with `rules: null` makes the engine refuse.
- **The shadow (D14).** `validateModel` is not compared while `rulesStaged`, and is compared without it. `previewCommit` is unchanged. `getModelIssues` stays `'unstaged'` (the buffer's depth already stops it).

## Files

Created:
- /home/mdp/workspace/data-rover-py/frontend/src/lib/engine/rules-parse.ts
- /home/mdp/workspace/data-rover-py/frontend/src/lib/engine/__tests__/rules-parse.test.ts
- /home/mdp/workspace/data-rover-py/frontend/src/lib/engine/__tests__/support/rules.ts

Modified:
- frontend/src/lib/api/{types,rules,artifacts,validation}.ts
- frontend/src/lib/engine/{artifacts,shadow}.ts
- frontend/src/lib/state/{artifact-edits,replica,model}.svelte.ts
- the tests: `api/__tests__/{rules,validation,engine-route}`, `engine/__tests__/{artifacts,shadow,support/project-server}`, `state/__tests__/{artifact-edits,replica.svelte,validate-staged}`
- frontend/README.md and frontend/src/lib/engine/README.md

`engine-route.ts` itself is unchanged (Task 4). `sync-call.test.ts` is unchanged: it builds its own navigation artifacts and asserts no rules shape.

## Concerns

- **Validate right after a Save can race the parse.** `validateAll` waits for the staged model edits, not for a rules parse still out. A Validate clicked within the parse's round trip of a rules Save uses the last parse the engine had: the committed rules for an update, none for a create. The panel's refetch catches up once the parse lands. Waiting for the follower in `validateAll` would close this, but the plan does not ask for it.
- **Stale in-flight parse.** A parse still in flight when its text stops being wanted is not cancelled; its answer is dropped. Harmless.
- **`onEvent` copies the kinds map (O(artifacts)) per fetched event.** Cheap at realistic artifact counts.
- **e2e not run.** Per the plan, `eval-rules.spec.ts` is Task 7.
