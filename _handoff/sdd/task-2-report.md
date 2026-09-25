# Task 2 report: Port the rules package to the engine

Status: DONE_WITH_CONCERNS (concerns are about plan wording and small interface deviations, none open in the code)
Commit: `ee54e40 Port the rules package to the engine`

## What I implemented

- `engine/src/rules/document.ts`: the AST types (M2), `RulesUnreadable`, `readRuleSet(text)`. The reader is strict against pydantic's grammar:
  - unknown keys, wrong types, zero or two tests (chosen by key presence), `null` on a test other than `equals` / `not_equals`, empty `all` / `any`, `count` with no bound, not exactly one non-null `exists` / `count`, a bad direction, empty `name` / `applies_to` / `property` / `type`, `schema_version` other than 1, more than 200 rules, duplicate names, and nesting past 8 levels (a `where` counts one) all refuse.
  - Depth is checked while reading, so a deeply nested document is refused without deep recursion.
  - It accepts what pydantic accepts: explicit `null` for `to`, `where`, `when`, `message`, a relationship's `exists` / `count` and a count bound, `in: []`, and `{}`.
  - Defaults are filled. Each rule keeps its `identity`: its entry, `pyDumps`-ed with `allowNan`. It equals the server's own text for that rule, and a test asserts this.
- `engine/src/rules/compile.ts`:
  - Types: `RulesParse`, `RuleSource`, `RuleSkip`, `CompiledRule`, `CompiledRules {rules, rulesByType, skipped, evalErrors, total, identities, unreadable}`.
  - `compileRuleSets` is a port of `compile.py` (the drift reasons use `pyRepr`, and a disabled rule is dropped before the drift check).
  - `EMPTY_RULES` and `appliesPopulation`.
- `engine/src/rules/evaluate.ts`: `pyRuleEq`, `evaluateCondition`, and `RulesValidator`, which catches per rule, counts under the rule's check and merges the counts once in its global hook.
- `engine/src/rules/reach.ts`: `derivePaths`, `expandScope` (no far-type filter, the frontier sorted by code point, results in first-seen order).
- `engine/src/rules/sources.ts`: `ruleSources(set, layer)` and `RULES_KIND`.
- `engine/src/artifacts/artifact-set.ts`:
  - The readers take a strict `rules`. On a committed artifact it is a `RulesParse`; absent or `null` means no parse. On a staged create or update it is a `RulesParse` or `'pending'`. A malformed one is a 422 in the engine's words.
  - The set keeps `lastParse` and gains the accessors `ids()`, `committedArtifact()`, `stagedEntry()` and `lastWorkingParse()`.
  - `carriesPayload` is exported from the module only, not from `index.ts`.
- `engine/src/validation/pipeline.ts`: `validateScoped(model, ids, v, p, rules = null)`. With `rules`, a `RulesValidator` runs seventh in every loop and in the globals.
- Value layer:
  - `parseExact(text, {floatConstants})`.
  - `pyDumps(value, indent, {allowNan})`.
  - `pyContains` moved from `search/criteria.ts` to `value/compare.ts`, so rules and criteria share it.
- Recorder (`tests/golden/model_steps.py`):
  - New `rules_step` and `reach_step` helpers.
  - The `rules` step records `parses` (`parse_result(...).model_dump(mode="json")`), `status` (built as the route builds `RulesStatusOut`) and `compiled`. It asserts the sources are sorted by name, then id.
  - `validate` runs `pipeline_for(compiled)` after a `rules` step.
  - `reach` records `expand_scope`.
  - `batch` with `record_dirty` + `expand` records the dirty set widened as `expand_dirty` widens it (it asserts an unseeded recorder).
- Scenarios `rules_compile`, `rules_eval`, `rules_reach` are registered. The engine replay (`engine/test/golden/model-steps.ts`):
  - builds committed `validation_rules` artifacts carrying the recorded parses;
  - reads them through `readArtifacts`, lists them with `ruleSources` and compiles;
  - compares `status` and `compiled` exactly and replays `reach` / `expand`.
- Docs: `engine/README.md` gains a `src/rules/` bullet with the order, the strict text document, the drift check, `pyRuleEq`, reach and its premise, and why `eval_errors` cannot move. The `src/artifacts/`, `src/validation/`, `src/value/` and golden-fixtures bullets are updated.

## Tests and results

- `pixi run engine-test`: 84 files, 1,240 tests passed (baseline 1,214 + 26 new).
- `pixi run -e core-dev pytest tests/golden -q`: 1 passed (staleness; no existing fixture moved).
- `pixi run engine-check`: clean. `pixi run engine-tidy`: clean. `pixi run frontend-check`: 0 errors, 0 warnings.
- `ruff check` / `ruff format` on the 5 Python files: clean / unchanged.
- Mutation check. I broke each of these semantics in turn and confirmed the golden tests go red; each was restored after, verified with `cmp`:
  - naive bigint equality;
  - `??` instead of `or` for the message;
  - a null operand never matching;
  - `to` ignored without `where`;
  - list `contains` as substring;
  - reach filtering on far types;
  - an unsorted frontier.

## TDD evidence

- RED: `pixi run golden-fixtures` (existing fixtures unchanged), then `pixi run engine-test`. Output: `Test Files 6 failed | 77 passed (83)`, `Tests 24 failed | 1214 passed (1238)`.
  - Failing: every test in `test/rules/{compile.golden,eval.golden,reach.golden,document,sources}.test.ts`, plus the two new `reading artifacts` tests (ruling R2a).
  - Expected, because the rules exports did not exist.
  - They failed at the first call (`TypeError: (0, ruleSources) is not a function`), not at import: vitest's transform tolerates a missing named export. Everything else stayed green.
- GREEN: `npx vitest run test/rules test/artifacts`: 40 passed. Then the whole suite: 1,240 passed.

## Files changed

- New:
  - `engine/src/rules/{document,compile,evaluate,reach,sources}.ts`
  - `engine/test/rules/{compile.golden,eval.golden,reach.golden,document,sources,validator}.test.ts`
  - `engine/fixtures/golden/rules_{compile,eval,reach}.json` (52 KB / 400 KB / 40 KB)
  - `tests/golden/scenarios/rules_{compile,eval,reach}.py`
- Modified:
  - `engine/src/artifacts/artifact-set.ts`, `engine/src/index.ts`, `engine/src/validation/pipeline.ts`
  - `engine/src/value/{parse,serialize,compare}.ts`, `engine/src/search/criteria.ts`
  - `engine/test/artifacts/artifact-set.test.ts`, `engine/test/golden/model-steps.ts`
  - `engine/README.md`
  - `tests/golden/model_steps.py`, `tests/golden/scenarios/__init__.py`

## Self-review findings (fixed before the commit)

- `??` defaults would have accepted `rules: null`, `severity: null` and `disabled: null`, which pydantic refuses. They now default only on absence, and the tests cover it.
- A second parameter on `parseJson` broke `lines.map(parseJson)` (tsc error; at runtime the index would have been passed as the options). `parseJson` is back to its old signature, and the reader calls `parseExact` with the option.
- `compileRuleSets` with a nullable metamodel just to build `EMPTY_RULES` was replaced by a literal empty compile.
- I added `validator.test.ts`, because no golden reaches `appliesPopulation` or the eval-error catch-and-merge path. It tests `appliesPopulation`'s code-point ordering across compiles, and a throwing rule counted per element, merged once per run and cumulative.

## Issues and concerns

1. **Plan wording vs the oracle: a `null` operand DOES match.** M4 says "a `null` operand never matches". Fact 6 says "`equals: null` never holds for a present value; `not_equals: null` always does".
   - Python's `_eq(None, None)` is `True`, and a list value is tested item by item. So `equals: null` holds for `[None]` and `[None, 1]`, and `not_equals: null` FAILS for `[None]`.
   - I ported Python: `pyRuleEq(null, null) === true`. `rules_eval` holds both values, and a mutation to "never matches" turns the golden red.
   - This is not a Python bug (the semantics are consistent), so D18 does not apply. Task 3 should not rely on the plan's sentence.
2. **`parseJson` cannot read a rule document.** The exact parser keeps bare `NaN` / `Infinity` as their TEXT (as `parse_model_json` does). The server writes `"equals":NaN` and `"equals":"Infinity"`, and `parseJson` makes both the string. So `readRuleSet` uses `parseExact(text, {floatConstants: true})`, a new option; M2 said `parseJson`. Identities need `pyDumps(…, {allowNan: true})`, because `pyDumps` throws on non-finite floats.
3. **Interface deviation: `RuleSource.parse` is `RulesParse | null`** (the brief says `RulesParse`). `null` means "arrived without its parse" and makes the compile `unreadable`, which M3 requires to flow from `ruleSources` through `compileRuleSets`. Task 3/4 call `compileRuleSets(ruleSources(set, layer), mm)` unchanged.
4. **Last-parse semantics (decision left open for Task 3/4):** per M3's wording, every committed arrival with a parse (`setArtifacts`, `putArtifacts`) overwrites the id's last parse, even an identical re-send.
   - So if a committed re-send lands while a staged update is `'pending'`, W stands on the committed parse until the new parse lands, not on the last staged one. This is transient and correct in the end, but may cost one extra rescan.
   - An entry that stops carrying a payload (a discard, or a rename-only update) resets the last parse to the committed one. An id gone from both layers is forgotten, so a `'pending'` create re-staged under a dropped temp id is left out.
5. The reader is stricter than the brief's list in ways only a skewed server could hit: bounds must be floats (the server always writes `1.0`) and counts must be integers. These refuse (→ 501 → the server answers) rather than coerce.
6. `rules_eval.json` is 400 KB: 28 property tests × 24 values, validated over `all_ids` twice, plus the relationship web. That is within the range of the existing fixtures (`search_criteria.json` is 583 KB).
7. No Python-side bug found (D18).
