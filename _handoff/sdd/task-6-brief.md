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

