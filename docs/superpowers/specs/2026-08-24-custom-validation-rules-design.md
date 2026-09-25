# Custom validation rules (P-12) — design

Date: 2026-08-24 · Status: approved design, pre-plan
Backlog: P-12 · Custom advanced validation rules

## 1. Summary

User-defined validation rules, authored as a small **declarative YAML
language** and evaluated **natively in the existing validation pipeline** as a
seventh validator. Rules live in a new `validation_rules` **artifact kind**
(staged, committed, lock-protected, bundle-portable like every other
artifact). Rule issues are always **CONFORMANCE** — counted and surfaced,
never commit-blocking. Incremental freshness comes from **reach-aware dirty
expansion**: because the language is closed, each rule's navigation shape is
statically analyzable, so a mutation's dirty set is expanded backwards along
each rule's reverse paths and the rules re-run on exactly the affected
elements — same liveness as the built-in validators, no background machinery.

Explicitly rejected alternative: Python-snippet rules. They would require a
second async evaluation subsystem (sweep + read-set capture + rev-stamped
caching, the hard half of the table system) and an eventual-consistency
model in the validation UI. A snippet-backed rule kind remains a possible
*future* escape hatch on top of this design's issue plumbing; it is not
designed here.

## 2. The rule language

A rule set is one YAML document:

```yaml
schema_version: 1
rules:
  - name: critical-buildings-have-evacuation   # unique within the set
    description: optional free text
    applies_to: Building        # element stereotype; subtypes included
    severity: error             # "error" | "warning"
    disabled: false             # optional kill-switch, default false
    when: <condition>           # optional guard; omitted = every Building
    then: <condition>           # required assertion
    message: optional custom issue text
```

Semantics: for every element whose type is in the `applies_to` descendant
closure, if `when` matches (or is absent) and `then` fails, one issue is
produced.

### 2.1 Conditions

`<condition>` is exactly one of:

- `all: [<condition>, ...]` — logical AND (non-empty list)
- `any: [<condition>, ...]` — logical OR (non-empty list)
- `not: <condition>`
- a **property atom**
- a **relationship atom**

Combinators nest freely up to the depth cap (§2.4).

### 2.2 Property atom

```yaml
property: <name>
<test>: <value>          # exactly one test
```

Tests: `exists: true|false`, `equals`, `not_equals`, `in: [v, ...]`,
`gt` / `gte` / `lt` / `lte` (numeric), `contains` (substring on strings,
membership on lists).

Pinned edge semantics (the corners where DSLs rot — all deliberate):

- A **missing property** fails every test except `exists: false`. In
  particular `not_equals` on a missing property is **false** (the element
  does not carry a value that differs; use `any:[{exists: false},
  {not_equals: v}]` for "absent or different").
- A **multiplicity-many** (list-valued) property matches a scalar test
  (`equals`, `not_equals`, `in`, comparisons, substring-`contains`) if
  **any** entry matches. `exists` is true iff the list is non-empty.
  `contains` applied to a list value tests **membership of the whole
  value** (`x in list`), not per-entry substring — the one test where the
  list itself is the operand.
- **Type-mismatched comparisons** (e.g. `gt` on a string, `contains` on a
  number) are simply **false**, never an error — the engine stays
  inspectable, a rule never throws on messy data.
- `equals` / `not_equals` / `in` compare scalars by Python equality on the
  stored JSON value (no coercion: `"3"` ≠ `3`).

### 2.3 Relationship atom

```yaml
relationship:
  type: Owns               # relationship stereotype; subtypes included
  direction: outgoing      # "outgoing" | "incoming"
  to: Zone                 # optional far-end stereotype filter; subtypes included
  where: <condition>       # optional condition on the far ELEMENT (recursive)
  exists: true             # or count: — exactly one of the two
  # count: { gte: 1 }      # eq | gte | lte (at least one key)
```

- The atom filters the element's relationships of `type` in `direction`,
  keeps those whose far element passes `to` and `where`, then applies
  `exists` / `count` to the filtered set.
- The far element for `outgoing` is the target, for `incoming` the source.
- A **dangling far endpoint** (id not in the model — the engine stays
  inspectable) is **non-matching**, never an error: it fails `to`/`where`
  filters and is excluded from filtered counts. (An atom with neither `to`
  nor `where` still counts a dangling relationship — the relationship
  itself exists; only far-element tests exclude it.)
- `where` takes the full condition language recursively — multi-hop
  conditions come from nesting relationship atoms inside `where`, with no
  special path syntax.
- v1 has **no property tests on the relationship itself** — `where` is
  about the far element (§11 lists this as an extension).

### 2.4 Bounds (schema caps, `SNIPPET_MAX_CODE_BYTES` tradition)

Enforced by the payload schema wherever the payload parses (artifact save,
bundle import, lint) — never as an evaluation-time business rule:

- YAML text ≤ **64 KiB** (`RULES_MAX_YAML_BYTES`)
- ≤ **200 rules** per set (`MAX_RULES_PER_SET`)
- condition nesting ≤ **8** levels (`MAX_CONDITION_DEPTH`; combinators and
  `where` both count a level)
- rule `name`: non-empty, unique within the set (case-sensitive)

## 3. Storage: the `validation_rules` artifact kind

- New `ArtifactKind.validation_rules` enum member (`api/db_models.py`;
  the column is `native_enum=False`, so this is a code-level change — the
  plan must check whether any CHECK constraint pins the value list and add
  an Alembic revision only if so).
- One new `ArtifactKindSpec` entry in `api/artifact_kinds.py` with a
  `RULESET_ADAPTER`. The generic `extract_deps`/`rewrite_refs` walk applies
  unchanged (the payload has no `"ref"` keys; stereotype names travel as
  plain strings, which is correct — bundles are metamodel-relative anyway).
- Payload shape: `{schema_version: 1, yaml: "<verbatim YAML text>"}` —
  the **text**, not parsed JSON, metamodel-editor style: the author's
  comments and formatting are part of the artifact.
- **Save-time validation** (the adapter): the `yaml` field must parse as
  YAML and validate against the rule schema (§2), caps included — a set
  that cannot parse cannot evaluate, so invalid structure 422s at save like
  any artifact payload. **Metamodel drift** (unknown stereotype /
  relationship type / property name) is *not* save-blocking — the metamodel
  can change underneath a committed set regardless, so drift is a
  degradation (§7), not invalidity.
- Everything else rides existing machinery with zero changes: staged
  `create/update/delete_artifact` ops through `POST /commits`, `art:<id>`
  leases, legacy `PUT`/`DELETE /artifacts/{id}` honoring peer leases,
  bundle export/import (plan/confirm, duplicate-name skip, importer),
  multiple rule sets per project, artifact listing.

## 4. Compilation and the session cache

New core package `core/validation/rules/`:

- `schema.py` — Pydantic AST (`RuleSetDefinition`, `Rule`, the condition
  union) + `RULES_ADAPTER` + the caps.
- `compile.py` — `compile_rule_sets(sets, metamodel) -> CompiledRules`:
  parses each set's YAML, validates, resolves per-rule descendant closures
  (`applies_to`, relationship `type`, `to`) against the metamodel, builds
  the type→rules dispatch map, and computes per-rule **drift verdicts**
  (§7). Pure and cheap; recompiling on demand is fine.

The background sweep runs without DB access, so compiled rules live on the
`Session`:

- `session.compiled_rules: CompiledRules` — built at **hydration** (DB in
  hand: read the project's `validation_rules` artifact rows), rebuilt when
  a commit **touches a `validation_rules` artifact** (create/update/delete —
  the commit route already splits artifact ops), and **recompiled on
  metamodel rebind** (same commit path; drift recomputed against the new
  schema).
- Sessions with no rule artifacts (legacy `get_session()` setups, tests,
  fresh projects) get an empty `CompiledRules` — the validator is a no-op
  and behavior is byte-identical to today.

## 5. Evaluation: a seventh validator

`core/validation/rules/validator.py` — `RulesValidator(EntityValidator)`,
constructed per pipeline from a `CompiledRules`:

- `validate_element`: dispatch via the precomputed type→rules map; for each
  matching enabled, non-drifted rule evaluate `when` then `then` against
  `model.indexes` adjacency + metamodel caches. O(entity-neighborhood) per
  rule — honors the pipeline's per-entity cost contract. No
  `validate_global` work in v1.
- Issue construction on a failed `then`:
  - `severity` from the rule; `category` **always CONFORMANCE** — there is
    deliberately no opt-in to STRUCTURAL (P-12's foot-gun rationale:
    a user rule must never be able to block every commit).
  - `target_ids[0]` = the evaluated element (the store's owner contract);
    far elements that witnessed the failure appended as context where
    cheaply available.
  - `check` = `"rule:<rule-name>"`, set at construction (the pipeline's
    `_stamped` only fills unset fields) — the Issues panel's per-check chip
    filter gets one chip per rule with no UI work.
  - `message` = the rule's `message`, else generated:
    `"<rule-name>: <failed-assertion summary>"`.
- Any **unexpected evaluation error** on an entity: the rule is skipped for
  that entity, counted in `rules_status` (§7), never raised — no 500, no
  phantom issue.

Pipeline construction seam: `default_pipeline()` stays pure-core and
rule-free. New `api/rules.py` provides:

- `session_pipeline(session) -> ValidationPipeline` — `default_pipeline()`
  plus a `RulesValidator(session.compiled_rules)`;
- `expand_scope(model, compiled, dirty_ids) -> list[str]` (§6).

The ~8 API call sites that build pipelines move to `session_pipeline`
(commits apply/preview, ops, undo, CR-apply, scoped + full validate route,
validation sweep). The sweep takes the session it already holds;
`migration/legacy.py` keeps `default_pipeline()` (no session, no rules).

## 6. Incremental freshness: reach-aware dirty expansion

The built-in dirty machinery (`core/validation/dirty.py`) cannot know a
custom rule's cross-element reach. Because the language is closed, we derive
it statically:

- `core/validation/rules/reach.py` — from each compiled rule, its
  **reverse paths**: for every relationship atom at nesting depth k, the
  chain of (relationship type closure, reversed direction, stereotype
  filter) steps leading back up to an `applies_to`-typed element. `when`
  and `then` both contribute (a guard flip changes verdicts too).
- `expand_scope(model, compiled, dirty_ids)`: for each dirty **element**,
  walk every reverse-path suffix it could sit on (its type matches the
  path's stereotype filter at that step, checked via the compiled
  closures), stepping through `model.indexes`
  incoming/outgoing adjacency, and add every reached `applies_to`-typed
  element. Dirty **relationship** ids contribute their endpoints (already
  in the base dirty set, so in practice no extra handling). Bounded by
  rule nesting depth × adjacency degree.
- **Over-approximation is explicitly safe** (same stance as `dirty.py`'s
  documented over-approximations); a too-small expansion is the only
  correctness hazard. The full sweep re-runs rules over everything and is
  the healing backstop for any expansion bug — degradation is temporary
  staleness, never permanent wrongness.
- Hook point: the same call sites that adopt `session_pipeline` wrap their
  scoped runs as
  `Scope(dirty + expand_scope(model, compiled, dirty))`. The full-model
  paths (`Scope.all()`, the sweep, rebind's full splice) need no expansion.

**Rule-set edits.** When a commit touches a `validation_rules` artifact,
after recompiling the session cache the commit's validation splice widens
to include every element whose type is in the `applies_to` closure of any
rule in the **old ∪ new** versions of the touched sets (old covers deleted/
renamed rules whose issues must drop; `ValidationState.replace` handles the
drop by owner). Synchronous under the commit mutex; bounded by those
populations — strictly cheaper than the rebind precedent's full sweep, and
rule edits are rare.

**Undo** replays artifact inverses through the same commit-side machinery,
so a rules-artifact undo re-triggers recompile + the same widened splice.

## 7. Drift and degradation

A rule referencing an unknown stereotype, relationship type, or a property
not declared (effective) on the relevant stereotype is **skipped whole** at
compile time — never evaluated half-blind. Unknown-property detection uses
the metamodel's effective-property caches; `where` conditions are checked
against the far-end stereotype when one is named, and only `exists`-level
checks apply where no stereotype context exists.

Skipped status must NOT enter the issue store: issues require an entity
owner (`issue_owner`'s non-empty `target_ids` contract), and an
artifact-owned pseudo-issue could never be cleaned up incrementally.
Instead:

- `CompiledRules` carries per-set, per-rule diagnostics
  (`skipped: [{set_artifact_id, set_name, rule, reason}]` + counts).
- `GET /model/issues` gains a `rules_status` field carrying those
  diagnostics (cheap — read off the session, no model touch).
- The Issues panel renders a banner ("2 rules skipped — schema mismatch")
  from `rules_status`; the rule editor's lint (§8) shows the same
  diagnostics inline per rule.
- Per-entity evaluation errors (§5) are counted into `rules_status` the
  same way (`evaluation_errors` per rule, capped reporting).

Severity of the stance: degraded-not-failed, uniformly — no rules-related
condition may ever 5xx a validation path or block a commit.

## 8. API surface

- **No new artifact routes** — CRUD/commits/locks/bundles are generic over
  the registry.
- `POST /projects/{id}/rules/lint` — sibling of `/metamodel/lint`: body
  `{yaml: str}`, parses + schema-validates + drift-checks against the
  session metamodel; always **200** `{ok, errors[], warnings[]}` with
  line/column from the YAML `problem_mark` where available (schema errors
  map to the closest rule index; drift diagnostics are warnings). Gated
  like `/metamodel/lint`: NOT in `authz._READ_ONLY_POST_SUFFIXES`, so
  viewers 403 — only the editing flow lints. Needs the session's metamodel
  (hydrating) but no mutex and no model iteration — debounce-cheap.
- `GET /model/issues` response: adds `rules_status` (§7). `counts` remain
  exact and include rule issues; `ISSUES_RESPONSE_MAX` applies unchanged.
- `POST /model/validate` (explicit full run) includes rules via
  `session_pipeline`. `POST /commits/preview` reports rule issues inside
  `conformance_error_count`/`issues` automatically — and never inside
  `structural_blockers`.
- `/model/ops`, guest-proposed snippet ops, view/metamodel op families:
  unaffected — rules are artifacts, not ops, and arrive through the
  existing artifact op family.

## 9. Frontend

Pattern-following; no new concepts:

- Register the kind in `artifacts/kinds.ts` (label "Rules", icon, section)
  — list/tab/DiffDrawer/staging pick it up via the existing generic paths.
- Rule-set editor tab cloned from the metamodel editor skeleton: CodeMirror
  YAML, localStorage draft, debounced `POST /rules/lint` with gutter
  markers (errors) and squiggles/panel (drift warnings), Save staging
  `update_artifact` through the normal checkout/commit flow, `art:` lease
  via the existing checkout layer, `ensure*Draft` following the current
  editor family pattern (F-12's shared close-race fix stays a separate
  item; the new editor inherits whichever state the family is in).
- Issues panel: per-rule chips arrive free via `check`; add the
  skipped-rules banner off `rules_status`.

## 10. Testing

- **Core** (`tests/validation/rules/`):
  - schema: accept/reject tables, caps, duplicate names, depth.
  - semantics: one table-driven suite per atom covering §2.2/§2.3 edge
    semantics (missing property, many-valued, type mismatch, dangling far
    endpoint, empty filters, count boundaries) — these pinned semantics are
    the spec's contract.
  - compile: closure resolution, drift verdicts, dispatch map.
  - reach: per-shape reverse-path derivation; and the keystone property
    test — random small model + random mutation sequences: *base dirty +
    expansion + scoped rerun ≡ full rerun* for rule issues (the same
    equivalence the dirty machinery is trusted on).
- **API** (`tests/api/`): artifact save 422s (parse/schema/caps) vs drift
  saves fine; commit-splice liveness (edit a far element → owning
  element's rule issue appears/clears without full validate); rule-set
  edit/delete revalidation (stale issues drop); rebind → recompile + drift
  banner; lint route (viewer 403, line/column, warnings); sweep includes
  rules; `rules_status` on `GET /model/issues`; preview counts; undo of a
  rules-artifact commit.
- **Frontend**: kinds registration, editor draft/lint/save unit tests,
  issues-banner rendering. e2e joins the T-7 list (not in scope here).

## 11. Out of scope / future directions (recorded, not designed)

- `else` branches (expressible today as two rules with mirrored guards).
- Rules on relationships (`applies_to` a relationship type).
- Property tests on the relationship itself inside a relationship atom.
- Comparing two navigated values against each other (join-style rules).
- A snippet-backed rule kind (Python escape hatch) reusing this design's
  issue plumbing — priced separately if the declarative wall is ever hit.
- Severity override / muting of individual rule instances per element.
- STRUCTURAL user rules: permanently out, by decision (§5).
