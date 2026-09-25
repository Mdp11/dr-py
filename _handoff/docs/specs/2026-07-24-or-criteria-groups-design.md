# OR-able criteria groups in the shared condition model

**Date:** 2026-07-24
**Status:** Approved

## Goal

Let users express OR between filter conditions ("status = active OR status =
pending", "name contains X OR relation count = 0") everywhere the UI filters
entities by criteria — table scope, navigation start scope, navigation
"Keep only…" steps, and the advanced-search dialog — via **one** change to the
shared condition model, reused by every surface.

## Background — the condition model today

There is exactly one filter vocabulary, `Criterion`, defined twice in
deliberate mirror:

- Backend: `src/data_rover/core/search/criteria.py` (pydantic discriminated
  union on `type`, plus the pure matchers `match_element` /
  `match_relationship` with JS-parity coercion).
- Frontend: `frontend/src/lib/search/types.ts` (TS union) with the client
  reference evaluator `frontend/src/lib/search/evaluate.ts`.

Every surface holds a `list[Criterion]` combined with **AND**:

| Surface | Backend holder | Combined at |
|---|---|---|
| Advanced search (`POST /model/search`) | `AdvancedQuery.criteria` (`api/search.py`) | `all(...)` in `run_advanced_search`; `.every(...)` in `lib/search/evaluate.ts` |
| Navigation start scope | `Scope.criteria` (`core/navigation/schema.py`) | `_matches_criteria` (`core/navigation/evaluate.py`) |
| Navigation "Keep only…" | `FilterStep.criteria` | filter-step `all(...)` in `core/navigation/evaluate.py` |
| Table scope rows | `ScopeRows.criteria` (`core/table/schema.py`) | builds a nav `Scope` (`core/table/evaluate.py` ~line 79) |

Three host components edit criteria, all through the shared row editor
`components/Sidebar/CriterionRow.svelte`:

- `Sidebar/AdvancedSearchDialog.svelte`
- `Navigation/ScopeEditor.svelte` — also serves **table scope**
  (`Table/RowSourceEditor.svelte` embeds it directly)
- `Navigation/FilterStepRow.svelte`

## Decisions (with rationale)

1. **Shape: one OR-group criterion variant** — `{type: "any_of", criteria:
   [...]}`, matching if ANY member matches. The top level stays AND. Rejected
   alternatives: a full recursive boolean tree (heavier UI/evaluator for
   unproven need) and per-criterion multi-value (cannot OR across different
   properties/operators).
2. **Members: any leaf criterion, no nesting.** A group may contain any
   existing criterion type but not another group. Enforced structurally (see
   below), so no custom validator.
3. **Empty group = no-op (matches everything).** An empty group is a
   transient editing state; it must not blank a half-configured table or
   navigation. Same tolerant stance as the unconfigured `NavigationSource`
   and today's "empty criteria list = no filter". This deliberately overrides
   literal `any([]) == False` — both evaluators special-case it.
4. **UX: "Add OR group" button only.** No convert-row↔group affordance.

## Design

### 1. Wire format (the one shared change)

Backend `core/search/criteria.py`:

- Rename the existing `Criterion` union to `LeafCriterion` (same members,
  same discriminator).
- Add:

  ```python
  class AnyOfCriterion(BaseModel):
      type: Literal["any_of"]
      criteria: list[LeafCriterion] = Field(default_factory=list)
  ```

- Redefine `Criterion` as the discriminated union of all leaf members plus
  `AnyOfCriterion` (i.e. today's union widened by one variant, still
  discriminated on `type`).

Frontend `lib/search/types.ts`: the same split — `LeafCriterion` is today's
union; `Criterion = LeafCriterion | { type: 'any_of'; criteria:
LeafCriterion[] }`.

**No-nesting is structural**: members are typed `LeafCriterion`, so a nested
`any_of` fails pydantic validation (422 at every API boundary that parses
criteria) and fails `svelte-check`/TS in the client. No model_validator.

Because `AdvancedQuery`, `Scope`, `FilterStep`, and `ScopeRows` all hold
`list[Criterion]`, all four surfaces accept groups with **zero holder-schema
edits**. **No `schema_version` bumps** (navigation v3, table v1 unchanged):
the change is additive — every previously saved artifact parses unchanged —
and the app is self-contained (frontend and backend ship together), so there
is no old-reader compatibility window.

### 2. Evaluation semantics

- `match_element` / `match_relationship` gain an `AnyOfCriterion` branch:
  `True` if the group is **empty** (decision 3), else `any(match_*(model,
  entity, m) for m in c.criteria)`.
- Navigation existence-gating recurses: `_match_nav_criterion`
  (`core/navigation/evaluate.py`) handles `AnyOfCriterion` itself — empty →
  `True`, else `any(_match_nav_criterion(model, element, m) for m in
  c.criteria)` — so each member is existence-gated exactly as a top-level
  property criterion would be. Table scope inherits this via the nav `Scope`
  path; `api/search.py` inherits the ungated matchers as today.
- Frontend `lib/search/evaluate.ts` mirrors both rules (empty-group no-op,
  any-member match) so backend/client results stay byte-identical — the
  parity contract in `criteria.py`'s docstring extends to groups.
- **Documented quirk, unchanged behavior**: criterion types that do not apply
  to the query target are vacuous-true in the matchers (parity behavior, e.g.
  `orphan` on a relationship). Inside an OR group such a member would make the
  group always-true. We keep matcher parity and prevent the state at the
  editing layer instead: `pruneCriteria` (called on target switch) recurses
  into groups, drops inapplicable members, and drops a group that becomes
  empty by pruning.

### 3. UI

- New `components/Sidebar/CriterionGroupRow.svelte`: renders an "Any of"
  group — header row with remove control, an indented member list reusing
  `CriterionRow` per member (forwarding `target` and `propertyNames`), and an
  "+ add alternative" action (new members default to a fresh `property`
  criterion, matching existing add-criterion defaults).
- Each of the three hosts gets two small edits: a branch in its criteria loop
  (`criterion.type === 'any_of'` → `CriterionGroupRow`, else `CriterionRow`)
  and an "**+ OR group**" button beside its existing add action.
- `lib/search/types.ts` helpers: `newCriterion('any_of')` → `{ type:
  'any_of', criteria: [] }`; `CRITERION_LABELS.any_of = 'Any of'`;
  `criteriaForKind` offers `any_of` for both targets; `pruneCriteria` recurses
  per decision above. `AdvancedSearchDialog`'s invalid/incomplete-criterion
  checks (e.g. the `criteria.some(...)` regex-validity gate) recurse into
  group members.

### 4. Testing

- **Backend matcher tests**: group with a matching member / no matching
  member / empty group (no-op) / mixed member types; nested `any_of` rejected
  with a validation error at the API boundary.
- **Navigation tests**: `FilterStep` and `Scope` with groups, including
  existence-gating of a property member whose property is absent.
- **Table test**: one `ScopeRows` case with a group, through table evaluate.
- **Frontend**: `lib/search/__tests__/evaluate.test.ts` parity cases
  mirroring the backend matcher tests one-for-one; component tests for
  `CriterionGroupRow` (add/edit/remove members) and the add-group flow in one
  host; `pruneCriteria` recursion tests.

## Out of scope

- Nested groups / full boolean trees (structurally rejected; revisit only on
  real demand — the wire format extends by widening the member type).
- NOT / negation groups.
- Convert-row↔group editor affordances.
- Any change to snippet/script filtering (snippets do not consume criteria).
