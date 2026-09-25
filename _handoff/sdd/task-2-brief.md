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

