### Task 1: The wire form of a rule set · `critical-implementer`

**Files:**
- Modify: `src/data_rover/api/schemas.py`, `src/data_rover/api/routes/rules.py`, `src/data_rover/api/routes/artifacts.py`, `src/data_rover/api/README.md`, `tests/api/test_artifact_payloads_route.py`
- Create: `tests/api/test_rules_parse.py`

**Interfaces:**
- Produces:
  - `RulesParseRequest {yaml: str (≤ 64 KiB)}`.
  - `RulesParseOut {ok: bool, document: str | None = None, errors: list[LintErrorOut] = []}`.
  - `ArtifactPayloadOut(ArtifactOut) {rules: RulesParseOut | None = None}`; `ArtifactPayloadListOut.items: list[ArtifactPayloadOut]`.
  - `rules_document(defn) -> str` and `parse_result(yaml) -> RulesParseOut` in `api/routes/rules.py` (M1).
  - `POST /rules/parse`.

- [ ] **Step 1: Cut the branch.** `git switch engine-migration && git switch -c feat/eval-rules`.
- [ ] **Step 2: Write the failing tests** (the `client` fixture, `AUTH_HEADERS`, `seed_default_project`).
  - `test_rules_parse.py`:
    - a set using every feature of fact 1 answers `ok: true` and `errors: []`. Its `document`, read with `json.loads` and re-validated through the rule-set adapter, gives a definition equal to `parse_rule_set(yaml)`, rule for rule and condition for condition, with the same `model_fields_set`. It includes `equals: null`, `in: [1, "1", true, 1.0]`, `gt: 1` (written `1.0`), `count: {eq: true}` (written `1`), `lt: .inf` (written `Infinity`) and `equals: 123456789012345678901` (written exactly);
    - the exact `document` text of one small set, pinned (keys in the model's FIELD order — `name, description, applies_to, …` and `type, direction, to, where, exists, count` — not the author's; `in` and `not` aliased; no defaults the author left out);
    - unparseable YAML answers `ok: false`, `document: null`, and one error with the same message, line and column `/rules/lint` gives for that text;
    - a schema failure answers one error with `line` and `column` null;
    - an empty document answers `ok: true`, `document: "{}"`;
    - `yaml` of 64 KiB + 1 answers 422, and a missing `yaml` 422;
    - a viewer gets 403, as on `/rules/lint`.
  - `test_artifact_payloads_route.py`:
    - a `validation_rules` artifact's item carries `rules` equal to `parse_result` of its YAML;
    - a navigation artifact's item carries `rules: null`;
    - the item's other keys and their order are unchanged.
- [ ] **Step 3: See them fail.** Run `pixi run -e core-dev pytest tests/api/test_rules_parse.py tests/api/test_artifact_payloads_route.py -q`. Expected red: the new tests (404 on the route, a missing `rules` key). Everything else, and `pixi run core-test`, stays green.
- [ ] **Step 4: Implement** per M1. Factor the lint route's error-building into a helper both routes call; the lint route's behaviour is unchanged (its tests prove it).
- [ ] **Step 5: See them pass.** Run `pixi run core-test`, then `pixi run dr-tidy` (ruff, mypy and pyright must pass).
- [ ] **Step 6: Docs.** In `src/data_rover/api/README.md`, the rules section gains `/rules/parse` (what it answers and why the document is text) and the payloads route gains `rules`.
- [ ] **Step 7: Commit:** `Parse rule sets for the engine`.

---

