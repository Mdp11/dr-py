# Task 1 report: The wire form of a rule set

Status: DONE_WITH_CONCERNS (the concerns are pre-existing or about docs placement; the task itself is complete)
Commit: `8bbe97c Parse rule sets for the engine` on `feat/eval-rules`

## What I implemented

- `src/data_rover/api/schemas.py`
  - `RulesParseRequest {yaml: str (max_length=RULES_MAX_YAML_BYTES)}`.
  - `RulesParseOut {ok: bool, document: str | None = None, errors: list[LintErrorOut] = []}`.
  - `ArtifactPayloadOut(ArtifactOut) {rules: RulesParseOut | None = None}`. `ArtifactPayloadListOut.items` is now `list[ArtifactPayloadOut]`. No other route's body changes.
- `src/data_rover/api/routes/rules.py`
  - `_lint_error(exc: RuleSetError) -> LintErrorOut`, the lint route's old inline error-building moved into a helper. Both routes call it.
  - `rules_document(defn) -> str`: `json.dumps(defn.model_dump(mode="python", by_alias=True, exclude_unset=True), ensure_ascii=False, separators=(",", ":"))`. `allow_nan` keeps its default.
  - `parse_result(yaml) -> RulesParseOut`. On success: `ok=True`, the document, `errors=[]`. On `RuleSetError`: `ok=False`, `document=None`, `[_lint_error(exc)]`.
  - `POST /rules/parse`. It depends on `require_membership` only, not on `get_request_session`, so it never hydrates the session and reads no metamodel (M1: "reads no model and no session state"). It is not in the read-only allowlist, so a viewer gets 403.
  - The module docstring gained a paragraph on the parse route.
- `src/data_rover/api/routes/artifacts.py`
  - `_with_rules(row)` builds an `ArtifactPayloadOut` from the header, the payload and `rules`.
  - For a `validation_rules` row, `rules` is `parse_result(str(payload.get("yaml", "")))`, with a non-dict payload read as `{}`, the same way `rules.rule_sources` reads it. For any other kind, `rules` is `None`.
  - The payloads route uses it. `rules` is the last key.
- `src/data_rover/api/README.md`
  - The payloads bullet now describes `rules`.
  - A new `POST /rules/parse` bullet says what the route answers, why `document` is text, the 422/403 behaviour and that it doesn't hydrate.

## Invariants checked, and how

1. **The document round-trips exactly.** It uses the same `model_fields_set`, the same scalar types and exact numbers.
   - `test_the_document_round_trips_every_feature` re-validates the document and compares recursively: model type, `model_fields_set`, and every field, checking `type(a) is type(b)` for scalars. Plain `==` would miss this, because `1 == 1.0 == True`.
   - It also asserts these exact substrings: `"equals":null`, `"in":[1,"1",true,1.0]`, `"gt":1.0`, `"count":{"eq":1,`, `"lt":Infinity`, `"equals":123456789012345678901` and `"not_equals":null`.
2. **Field order, aliases and no unwritten defaults.** `test_the_document_text_is_pinned` pins the whole text for a set whose author wrote the keys out of order.
3. **Lint and parse errors can't drift apart.** Both routes build the error through `_lint_error`.
   - The tests compare `/rules/parse` errors with `/rules/lint` errors for the same text: an unclosed flow sequence, an alias refusal (both have a line and column), and a schema failure (line and column null).
4. **Lint route behaviour is unchanged.** Its logic moved into the helper unchanged. All of `test_rules_lint.py` passes.
5. **Payload items keep their other keys and their order.** `test_rules_is_the_last_key_and_the_rest_is_unchanged` checks two things for a rules artifact and a navigation artifact:
   - the item's keys equal `GET /artifacts/{id}`'s keys, plus `rules` at the end;
   - the other values are equal.
6. **The route answers exactly `parse_result`.** `test_the_route_answers_parse_result` checks this. The payloads test checks the same for the payload item.
7. **The envelope and authz.**
   - 64 KiB + 1 answers 422, and a missing `yaml` answers 422.
   - A viewer gets 403.
   - An empty document answers `{"ok": true, "document": "{}", "errors": []}`.
8. **Degrade parity with `rule_sources`.** `test_a_rules_payload_without_yaml_parses_as_empty` inserts a row directly, with no `yaml`, and gets back `document: "{}"`.
9. **Lone surrogates can't reach the document.**
   - A YAML escape `"\ud800"` in a rule field is refused by pydantic's str validation, so it becomes a `RuleSetError`. The message is `repr`-escaped ASCII.
   - A JSON request carrying a lone surrogate is a 422.
   - So `document` is always valid Unicode and `ensure_ascii=False` is safe (probed).

## TDD evidence

RED 1: `pixi run -e core-dev pytest tests/api/test_rules_parse.py tests/api/test_artifact_payloads_route.py -q`
- Both files failed at collection: `ImportError: cannot import name 'parse_result' from 'data_rover.api.routes.rules'`.
- Expected: both test files import `parse_result` at top level.

RED 2: I added the schemas and `parse_result` / `rules_document`, but not the route or the payload field. Then I ran the same command plus `test_rules_lint.py`.
- `test_rules_parse.py`: all 10 new tests failed with 404 (`assert 404 == 200 / 403 / 422`). This is the expected "404 on the route".
- `test_artifact_payloads_route.py`: every test failed with `TypeError: Object of type ArtifactOut is not JSON serializable`. The list schema already expected `ArtifactPayloadOut` while the route still built `ArtifactOut`. This is a mid-step artifact of changing the schema first, not the brief's "missing `rules` key" red. I say so because it differs from the brief's expectation.
- `test_rules_lint.py`: green throughout.

GREEN:
- Focused run: `pixi run -e core-dev pytest tests/api/test_rules_parse.py tests/api/test_artifact_payloads_route.py tests/api/test_rules_lint.py -q` gave `31 passed`.
- `pixi run core-test` gave `2588 passed, 34 deselected in 207.39s`. That is the baseline of 2,575 plus 13 new tests.
- `pixi run dr-tidy`: ruff "All checks passed!", mypy "no issues found" (core 70 files, API 79 files), pyright "0 errors" for both packages.
- `pixi run -e core-dev ruff check` and `ruff format` on both test files: passed, and one file was reformatted before the commit.

## Files changed

- `/home/mdp/workspace/data-rover-py/src/data_rover/api/schemas.py`
- `/home/mdp/workspace/data-rover-py/src/data_rover/api/routes/rules.py`
- `/home/mdp/workspace/data-rover-py/src/data_rover/api/routes/artifacts.py`
- `/home/mdp/workspace/data-rover-py/src/data_rover/api/README.md`
- `/home/mdp/workspace/data-rover-py/tests/api/test_artifact_payloads_route.py` (3 tests added)
- `/home/mdp/workspace/data-rover-py/tests/api/test_rules_parse.py` (new, 10 tests)

## Self-review findings

- I first built the payload item with `ArtifactPayloadOut(**_full(row).model_dump(), rules=...)`. That validated and dumped every payload twice, so I changed it to build from `_header(row)` plus `row.payload`, mirroring `_full`.
- I added the missing-`yaml` degrade test, which the brief did not list. It covers D7's "parses `""`" branch. A non-dict payload can't be tested through this route, because `ArtifactOut.payload: dict` would already refuse it.

## Concerns

1. **Pre-existing, in frozen core.** Some YAML makes PyYAML's constructors raise a bare `ValueError` that `parse_rule_set` doesn't wrap: `x: 2001-13-45` (a bad timestamp) and `x: !!float abc`.
   - The global handler turns it into a 422. So `/rules/lint` and now `/rules/parse` both answer 422 instead of `200 ok:false`. Probed: both routes answer 422, so they are consistent with each other.
   - `compile_rule_sets` catches only `RuleSetError`, so such text would also escape a compile. A stored payload can't hold it, because save-time `RULES_ADAPTER` validation wraps the `ValueError` into a 422. The payloads route is therefore unaffected.
   - I didn't fix it: `core/validation/rules/` is frozen and D18 routes a Python bug through both sides with a fixture. Whether to record it as a K item is the controller's call.
2. **Docs placement.** `/rules/lint` is documented in `src/data_rover/core/README.md`, and `api/README.md` has no rules section. The freeze allowed only `api/README.md`, so the parse route is documented there, next to the payloads bullet in the replica-routes list. `core/README.md` does not mention `/rules/parse`.
3. **The payloads route now parses every rules YAML on every call.** Each is capped at 64 KiB. This is intended by D7, but it is new per-request CPU on a viewer-allowed GET.
