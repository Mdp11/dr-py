# Navigation Composition + Step-Model Redesign — Design Spec

Date: 2026-07-08
Status: Approved design (ready for implementation plan)
Parent: `2026-07-05-stage-1-navigation-engine-builder-design.md` (Stage 1). This
spec reworks two Stage-1 restrictions the user rejected during manual
verification:

1. **Composition required save-then-reference.** To combine navigations you had
   to create one, SAVE it, and reference it from a set expression. This spec
   removes that: a navigation is **self-contained** — you insert navigations
   *inline*, recursively, and choose the combination operator between them.
2. **A step conflated navigation with filtering.** Each step was a relationship
   hop *plus* a target scope (types + criteria). This spec splits steps into two
   kinds: a **relationship step** (a hop) or a **filter step** (N conditions on
   the current frontier).

Branch: continue on `feat/stage1-navigation` (Stage 1 is not merged; this work
reworks Stage-1 UI that hasn't shipped, so it lands together).

## Summary

The core schema *already* supports arbitrarily-nested inline definitions
(`Operand.definition` is a recursive `NavigationDefinition`), and the resolver +
evaluator already recurse through them. The composition half of this feature is
therefore almost entirely a **frontend** rebuild of the set-expression editor
into a recursive, inline-editing tree. The step-model half **does** change the
core (`navigation/schema.py`, `evaluate.py`) and its backend tests. Backend
routes (`routes/artifacts.py`, the evaluate route) and the ref resolver
(`resolve.py`) are unchanged — they operate on whatever the schema parses.

Deliverables:

- **Core:** `schema_version` → **2**; `PathNavigation.steps` becomes a list of
  `RelationshipStep | FilterStep`; the evaluator walks the interleaved item
  list; navigation property criteria gain an **existence gate**.
- **Frontend:** a recursive navigation-node builder (Path leaf / Combine node),
  inline nesting with N-ary operators, per-node collapsible previews, an
  element-start typeahead, Save-as, and the two-kind step editor.

## Key decisions

| Decision | Choice |
|----------|--------|
| Combination model | **Explicit grouping**: each Combine node is one operator over its operands; mixed operators require nesting. No precedence, no ambiguity. |
| Node arity | **N-ary** — one operator over 2+ operands per node (`A∪B∪C` is one node). `difference`/`symmetric_difference` fold left-to-right; `union`/`intersection`/`symmetric_difference` are order-insensitive. |
| Inline vs refs | **Both.** Inline nesting is the primary self-contained path; refs to saved navigations remain supported operands (resolver + cycle detection + library picker already exist). |
| Root shape | A one-block navigation is a bare `PathNavigation`. Adding a 2nd block **auto-wraps** both into `Combine(op="union")`. Reducing a Combine node to one operand **auto-unwraps** it back to that child. Degenerate 1-operand nodes are never persisted. |
| Nested-nav settings | Each inline navigation is fully independent: own `exclude_visited`, own start/steps, own `step_index`. |
| Reorder | Operands within a Combine node are reorderable (↑/↓); this chooses the base for `difference` ("A minus the rest"). |
| Block labels | Auto-derived structural summary (`Component → Uses → Service`, `∪ of 3`, `(ref) "name"`). No schema field. |
| Previews | **Per-node, collapsible.** Each Path leaf and Combine node has an expand chevron; **expanding evaluates** that node's sub-definition, collapsed nodes don't evaluate. Root expanded by default. No tree-size cap (backend per-operand budgets are the only guard). |
| Save-as | Added: `Save as…` forks the current definition into a new library artifact under a new name; the current tab rebinds to the copy, the original is untouched. |
| Start block | Three modes: **Filter** (`Scope`), **Specific element** (typeahead → `Scope` with an id-equals criterion), **Combination** (nested Combine as start). All already schema-supported. |
| Step model | `steps` = ordered `RelationshipStep | FilterStep`. Rel step = hop (rel-type + direction + optional `target_types`). Filter step = `criteria: [Criterion]`, pruning the frontier in place, adding no chain column. |
| Filter vocabulary | Full shared `Criterion` vocabulary (property + name/id + relation-count + orphan + connected-to-type + endpoint-type). Property dropdown scoped (see below). |
| Property scoping | A filter step's property dropdown = **union** of effective (inherited) properties over the *reachable* types = declared `target_types` of the nearest preceding relationship step (subtype-inclusive), or the start types before any hop, or **all** types when target is "any"/indeterminate. |
| Property matching | **Existence-gated** for navigation: a property criterion matches only if the element actually has the property (so offering the union is safe). Intentionally diverges from the shared search matcher (coerce-missing-to-`""`); `/model/search` stays byte-identical. |
| Migration | **None.** `schema_version = 2` only — no v1 dual-read (the user has no saved navigations; nothing old exists to break). |

## 1. Core schema (`src/data_rover/core/navigation/schema.py`)

`SCHEMA_VERSION = 2` (the document version carried by both `PathNavigation` and
`SetExpression`). `Scope`, `Operand`, `SetExpression`, `NavigationDefinition`,
`StartNode` keep their **shape**; only the `schema_version` default follows the
bump to 2. `Step` is replaced by a discriminated step-item union:

```python
class RelationshipStep(BaseModel):
    kind: Literal["relationship"] = "relationship"
    relationship_type: str
    direction: Literal["out", "in", "either"] = "out"
    #: element types the hop may land on (subtype-inclusive; empty = any).
    target_types: list[str] = Field(default_factory=list)
    #: reserved for post-Stage-1 branching; MUST be empty in schema v2.
    children: list["StepItem"] = Field(default_factory=list)

    @model_validator(mode="after")
    def _v2_is_linear(self) -> "RelationshipStep":
        if self.children:
            raise ValueError("branching steps are not supported in schema v2")
        return self

class FilterStep(BaseModel):
    kind: Literal["filter"] = "filter"
    criteria: list[Criterion] = Field(default_factory=list)

StepItem = Annotated[
    Union[RelationshipStep, FilterStep], Field(discriminator="kind")
]
```

`PathNavigation.steps: list[StepItem]`. The step cap counts **total items**
(`len(steps) <= MAX_STEPS`, still 10). `exclude_visited` is unchanged.

Notes:
- The relationship step keeps **only** `target_types` (a plain type filter);
  all property/condition criteria live in filter steps.
- `children` is retained reserved-empty on `RelationshipStep` to preserve the
  branch-ready format posture (mirrors Stage-1 `Step`); `FilterStep` has no
  children (a filter never branches).
- `NAVIGATION_ADAPTER` and `model_rebuild()` wiring update for the new union.

## 2. Core evaluator (`src/data_rover/core/navigation/evaluate.py`)

The evaluator walks the interleaved item list instead of a uniform hop list.

- **Chain model.** Chain width = start + one column per **relationship** step.
  Filter steps add no column — they prune chains whose current endpoint fails
  the criteria. `ChainResult.step_types` = `[relationship_type]` per
  relationship step, in order (filter steps contribute no header). `step_index`
  in set-operand extraction therefore ranges over relationship columns exactly
  as before (`len(inner.step_types)` = relationship-step count).
- **`_walk` rewrite.** DFS keyed by an index into `steps`:
  - `RelationshipStep`: for each `next_id` from `_hop(current, step)` (rel-type
    subtype match + `target_types` filter), guard `exclude_visited` against the
    chain prefix, recurse extending the chain by `next_id`.
  - `FilterStep`: keep the chain iff `current = chain[-1]` matches all criteria
    (existence-gated); recurse at the next index **without** extending the
    chain. Prune otherwise.
  - Terminal (index past the last item): append the chain (respecting
    `max_chains`).
  - Determinism (sorted-id DFS), budget accounting (`max_visited` charged per
    hop), and truncation flags are preserved.
- **`_hop`** (renamed from `_next_ids`) matches rel-type (subtype-inclusive) and
  filters landing elements by `target_types` only (subtype-inclusive; empty =
  any) — **no criteria**.
- **Existence-gated property matching.** Navigation property criteria (filter
  steps **and** the start `Scope`) use a navigation-local matcher that requires
  the property to be present before delegating to the shared property matcher —
  except `exists`/`is_empty`, which handle absence explicitly. All other
  criterion kinds delegate to the shared `match_element` unchanged. `_scope_ids`
  and the filter-step matcher both route through this navigation matcher.
  `core/search/criteria.py` is **not** modified — search semantics are intact.

Set expressions, `_evaluate_set`, `_operand_members`, budgets, and
`resolve_refs` (`resolve.py`) are unchanged.

## 3. Frontend types (`frontend/src/lib/api/types.ts`)

Mirror the schema: `NavStep` → `NavRelationshipStep | NavFilterStep`
(discriminated by `kind`); `PathNavigation.steps` becomes the union array;
`schema_version` default 2 in the transport zod schema; `emptyPath()` yields a
v2 path with no steps. `NavScope`, `NavOperand`, `SetExpression` unchanged. No
migration code (`normalizeDefinition` keeps only the `exclude_visited` default
backfill for robustness; it does not upconvert steps).

## 4. Frontend builder (`frontend/src/lib/components/Navigation/`)

### 4.1 Recursive node component

A single **`NavigationNode.svelte`** renders one node of the definition tree and
is used at the root, for every operand, and for a Path's Combination-start. It
switches on the node kind:

- **Path leaf** (`PathNavigation`): start-mode block + step list + per-path
  `exclude_visited` toggle.
- **Combine node** (`SetExpression`): operator `<select>` + operand list, each
  operand a nested `NavigationNode`, with per-operand ↑/↓ reorder + remove. Its
  actions are **composition** actions: **"+ insert navigation"** (append an empty
  Path operand), **"+ insert group"** (append an empty `Combine(union)`
  operand), and **"+ from library"** (the existing ref picker → a `ref`
  operand). (Relationship/filter steps are Path-leaf actions, §4.3, not
  Combine-node actions.) For a `difference` node, operand 0 is labelled the
  **base** and the rest **subtracted** ("A minus the rest"); the base is chosen
  by reordering, no special pinning. Other operators show no base emphasis.

`NavigationBuilder.svelte` drops the top-level Path/Set-op toggle. Its header
keeps the name input, **Save**, and **Save as…**; its body is the root
`NavigationNode`. Edits flow through a single `updateDefinition(tabId, defn)` as
today (immutable spread updates addressed by node path).

Auto-wrap/unwrap live in the builder's mutators:
- Inserting a 2nd block at a bare-Path root wraps `[oldPath, newPath]` into
  `Combine(union)`.
- Removing operands from a Combine node down to one replaces the node with its
  sole child (root Combine → bare Path).

### 4.2 Start block (three modes)

The Path leaf's start renders a mode selector (**Filter / Element /
Combination**) over the existing `start: NavScope | SetExpression`:

- **Filter** — `ScopeEditor` (types + criteria), as today.
- **Element** — `ElementStartPicker.svelte`: a debounced typeahead calling
  `listElementsPage({ search, limit })` (the same ranked fuzzy search the
  sidebar uses); picking an element writes
  `Scope{types:[], criteria:[{type:"name_id", field:"id", op:"equals",
  value:<id>}]}` and displays the chosen element's name. On reopen, a scope with
  exactly that shape restores **Element** mode; any other scope shows **Filter**
  mode. (Semantically identical; the mode is a display nicety.)
- **Combination** — a nested `NavigationNode` (Combine) as the start; hops walk
  from the combined set.

### 4.3 Step editor (two kinds)

The Path leaf's step list renders each item by `kind`, with two add buttons:
**"+ relationship step"** and **"+ filter step"**.

- **`RelationshipStepRow.svelte`**: rel-type picker (filtered by reachable types
  via `metamodel/connection-rules`, as today), direction toggle, and an optional
  **target-type multi-pick** (`StereotypePicker` filter mode; empty = Any).
- **`FilterStepRow.svelte`**: a `CriterionRow` list (full vocabulary). Its
  property criteria receive a scoped property list — the **union of effective
  properties** for the reachable types at that point. A new metamodel helper
  (`effectivePropertiesForTypes(mm, typeNames)`) expands each type to its
  subtypes and unions their effective (inherited) properties; `[]`/Any → union
  over all element types. Reachable types are computed by scanning backward from
  the filter step to the nearest preceding `RelationshipStep.target_types` (or
  the start types / element type / all-types for a combination start).
  `CriterionRow` gains an optional `propertyNames` prop to constrain its
  property dropdown; when absent it behaves as today (search usage unaffected).

### 4.4 Previews (per-node, collapsible)

`ChainPreview` becomes a per-node panel. Each `NavigationNode` (Path leaf and
Combine) has an expand chevron; expanding evaluates **that node's
sub-definition** via `POST /navigations/evaluate` (a Combine node returns a
single element column; a Path returns chains). Collapsed nodes do not evaluate.
Root expanded by default; nested nodes collapsed by default. Collapsed nodes
show the auto-derived label. Filter steps produce **no** preview column (they
only narrow); relationship steps are the columns.

## 5. Frontend editor state (`frontend/src/lib/state/navigation-editor.svelte.ts`)

The load-bearing invariants (generation guard, debounce, eval-error surfacing —
see the module docstring) are **preserved but re-keyed per node**. Today
`_previews`/`_generations`/`_evalErrors`/`_debounceTimers` are keyed by `tabId`;
they become keyed by a composite **preview key** `${tabId}::${nodePath}`.

**Node addressing (positional).** `NodePath = (number | 'start')[]` — a number
descends into `operands[i].definition`, `'start'` descends into a Path's `start`;
root = `[]`. The Map key is the stringified path (`path.join('.')`, root =
`''`). The same paths drive the immutable tree-update helper
`updateNodeAt(root, path, updater): NavigationDefinition`, which rebuilds
spread-copies along the path (mutators — insert/remove/reorder — are inherently
positional, so they share this addressing). Preview/expanded state is keyed
positionally too: reordering operands shifts which node appears expanded **by
position** — a cosmetic, self-correcting effect (previews re-evaluate on any
edit anyway), accepted in exchange for no per-node ids and no strip-on-save
risk.

- Per tab, an **expanded-node set** tracks which node paths are open.
- Expanding a node schedules/starts its evaluate (immediate on expand, debounced
  on subsequent edits to *its own subtree*); collapsing cancels its timer and
  drops its preview key.
- `updateDefinition` bumps the generation for every affected node key (a node
  whose subtree changed) and reschedules the debounced run for expanded affected
  nodes; the `isCurrent(key, gen)` discipline and the fire-time re-read of the
  current draft are unchanged, just per-key.
- `closeDraft`/`resetNavigationEditors` clear all of a tab's node keys and
  cancel all its timers.
- `loadMorePreview` extends a specific node's preview by key.

`frontend/README.md`'s navigation-state section is updated to document the
per-node keying.

## 6. Save-as

`saveAsDraft(tabId, name)`: calls the existing `createArtifact({kind:
"navigation", name, payload})`, binds the current tab to the new id (via
`bindTabToArtifact`), leaves any original artifact untouched, and refreshes the
library. Surfaces the create-path name-clash 409 as a `saveError` (not a rev
conflict), reusing the Stage-1 distinction. `NavigationBuilder` gains a
**Save as…** button that prompts for a name.

## 7. Testing

**Core (`tests/navigation/`):**
- Schema: relationship/filter discrimination, `target_types` optional/multiple,
  full-vocabulary filter criteria, total-item cap, `schema_version == 2`,
  reserved-empty `children` rejects non-empty.
- Evaluator: relationship-only chains (as before, now via `RelationshipStep`),
  filter-step pruning (adds no column), interleaved rel/filter sequences,
  existence-gated property matching (missing property drops the element;
  `is_empty`/`exists` still work), `target_types` type filtering, `step_index`
  over relationship columns, determinism, caps → `truncated`, nested inline
  set-ops over the new path shape.
- Search parity: a guard that `core/search/criteria.py` matching is unchanged
  (existing search tests stay green).

**Frontend (vitest):**
- Builder mutators: auto-wrap on 2nd insert, auto-unwrap on reduce-to-one,
  N-ary operand add/remove/reorder, insert-group, ref operand via library.
- Per-node preview keying + generation-guard interleavings (deferred-promise
  tests, matching the Stage-1 pattern): expand/collapse, stale-response drop,
  edit-during-flight, close/reset.
- Step editor: add relationship vs filter step; target-type pick; filter-step
  property dropdown = union of effective properties for reachable types
  (fixtures with subtype inheritance and an "any" hop → all-types union);
  full-vocabulary criteria round-trip.
- Element-start typeahead → id-equals criterion round-trip + Element/Filter mode
  detection on reload.
- Save-as (create + rebind + name-clash 409 surfaced as saveError).

**e2e (playwright, `navigation.spec.ts` rewritten):** build a Path leaf with a
relationship step + a filter step; insert a 2nd navigation inline → auto-wrapped
Combine; verify the combined root preview; expand a nested node's preview; Save;
Save as…; reopen from the tree and confirm the structure round-trips.

## Non-goals

- Branching evaluation (format stays branch-ready via reserved `children`;
  evaluator/UI later).
- v1 schema migration (no data exists).
- Per-node preview for filter-only intermediate columns (filter steps never
  render a column, by design).
- Save-as into a *different* project; new artifact kinds.
- New backend endpoints (element typeahead reuses `GET /model/elements`;
  evaluate + artifact CRUD unchanged).

## Open items for the implementation plan

- `effectivePropertiesForTypes` location (a `metamodel/` helper) and whether an
  existing effective-properties helper already exists to build on.
- `CriterionRow` `propertyNames` prop plumbing (ensure search callers are
  unaffected).

Resolved during design (recorded here for the plan): node addressing is a
positional `NodePath = (number | 'start')[]` keying both mutators and preview
state (§5); the `difference` base is label-only, chosen by reorder (§4.1).
