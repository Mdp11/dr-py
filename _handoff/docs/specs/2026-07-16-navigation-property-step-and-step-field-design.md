# Navigation improvements: "Go to property" step + "Return elements from step" field — design

Date: 2026-07-16
Status: approved-by-request (user asked to plan + execute; open questions resolved from the codebase, decisions recorded here)

## Scope

Three user-requested improvements to the navigation feature:

1. A new step kind **"Go to property"**: navigate from the current frontier
   elements to the element(s) referenced by a named property (element-reference
   properties — a property whose `datatype` names an element type; values are
   element ids). Property picked with autocompletion like the existing
   "Keep only" step. If the chosen property is **not** element-typed, the chain
   is **blocked** after that step (nothing to navigate from).
2. Rename the numeric **"step"** label to **"Return elements from step"** with
   placeholder **"End of chain"** when empty.
3. **Constrain** that numeric field to the actual number of steps in the chain.

### Finding: where the "step" field lives

Checked (user asked): the bare numeric `step` field exists **only in the table
editors** —
`frontend/src/lib/components/Table/NavigationColumnEditor.svelte:305-313`
(`column.step_index`) and
`frontend/src/lib/components/Table/RowSourceEditor.svelte:161-169`
(`rowSource.step_index`, only for the `navigation` row-source kind).
The standard navigation builder exposes the same `step_index` concept only via
the **FeedsChip** popover on set-operation operands
(`Navigation/FeedsChip.svelte`), which already has descriptive labels and a
finite option list — no rename or constraint needed there (it gains property
steps in its option list automatically via `chainColumns`).

So items 2 and 3 apply to the two table editors only.

## 1. PropertyStep — backend

### Schema (`src/data_rover/core/navigation/schema.py`)

New step kind alongside `RelationshipStep` / `FilterStep`:

```python
class PropertyStep(BaseModel):
    """A hop through an element-reference property: for each frontier element,
    follow `property_name`'s value(s) — element ids — to the referenced
    elements. Adds ONE chain column (like a RelationshipStep). Per element,
    the hop applies only when the element's EFFECTIVE property def exists and
    its datatype is an element type; otherwise that chain is pruned (graceful
    — the engine never raises on odd models). Dangling ids are skipped."""

    kind: Literal["property"] = "property"
    property_name: str
    comment: Optional[str] = None
```

- `StepItem = Union[RelationshipStep, FilterStep, PropertyStep]`
  (discriminated on `kind`). `MAX_STEPS` cap already counts all step items.
- Field is `property_name` (not `property` — avoids shadowing the builtin).
- CHAIN CONVENTION update (module docstring): a chain column is added by a
  relationship step **or a property step**; filter steps still add none.
- No `SCHEMA_VERSION` bump: adding a union member is backward-compatible for
  existing payloads.

### Evaluator (`src/data_rover/core/navigation/evaluate.py`)

- `_walk`: `PropertyStep` behaves like `RelationshipStep` — computes
  continuations via a new `_hop_property`, extends the chain by one element,
  honors `exclude_visited` and the budget/chain caps.
- `_hop_property(metamodel, model, element_id, step, budget)`:
  - Look up the element's **effective** property def for `property_name` via
    the metamodel's cached effective-property lookup (never re-walk `extends`).
  - If the def is missing or `metamodel.is_element_type(def.datatype)` is
    false → return `[]` (chain pruned). No error: mirrors the filter step's
    existence-gated semantics and the engine's never-raise philosophy.
  - Value handling: a `str` value is one candidate id; a `list` value
    contributes each `str` item (multiplicity-many reference properties store
    lists of ids). Non-string items and ids that don't resolve via
    `model.elements.get` (dangling) are skipped.
  - Charge the budget with the number of candidate ids examined; return the
    sorted deduped resolved ids (determinism, matching `_hop`).
- `evaluate`'s `step_types`: one entry per chain column — the relationship
  type for a relationship step, **the property name for a property step**
  (preserving step order, i.e. build it in a single pass over `defn.steps`
  instead of the current relationship-only comprehension). This automatically
  keeps `_operand_members`' `n_steps = len(inner.step_types)` range check and
  the table evaluator's chain-length math correct.

Table evaluation (`core/table/evaluate.py`) needs **no change**: it consumes
`evaluate()`'s chains/step_types.

## 2. PropertyStep — frontend

### Types (`frontend/src/lib/api/types.ts`)

```ts
export interface NavPropertyStep {
    kind: 'property';
    property_name: string;
    comment?: string | null;
}
export type NavStepItem = NavRelationshipStep | NavFilterStep | NavPropertyStep;
```

### Tree helpers (`frontend/src/lib/navigation/tree.ts`)

- `chainColumns`: a property step adds a column — `label: step.property_name
  || 'unset step'`, `sub: 'property'` (the pure helper has no metamodel, so no
  target-type list). Feeds the editor rail badges, results-dock headers, and
  the FeedsChip options — all automatic once this changes.
- `nodeLabel`: include property hops in the summary (`… → .propertyName`).
- `isRunnable`: false while any property step has an empty `property_name`
  (mirrors the relationship-type check).
- `precedingTargetTypes` (pure, no metamodel): when scanning backward, a
  property step yields **`[]` ("any type")** — the conservative fallback.

### Metamodel-aware frontier types (`frontend/src/lib/metamodel/helpers.ts`)

New helper `frontierTypesAt(mm, node, index)` used by `PathCard` in place of
raw `precedingTargetTypes` for `sourceTypesFor`/`propertyNamesFor`: walk
`steps[0..index-1]` like `precedingTargetTypes`, but on hitting a property
step nearest to `index`, resolve its property across the frontier types
*before it* (recursively / iteratively): collect the `datatype`s of the
matching effective property defs that are element types; if exactly ≥1 element
type resolves, that set is the frontier; otherwise `[]` (any). Also export
`propertyStepDatatypes(mm, node, index)` (or equivalent) so the UI can tell
whether the property at step `index` is element-typed (drives blocking).

### UI (`frontend/src/lib/components/Navigation/`)

- New `PropertyStepRow.svelte`: sentence-style row like the other step rows —
  chain-column badge (it advances the chain, use `columnFor(i)` like
  `RelationshipStepRow`), text "Go to property", a **property picker with
  autocompletion reusing the same machinery as Keep only** (`PropertyPicker` /
  `propertyItemsFor` scoped to the effective properties of the frontier types
  at that step), the datatype shown, remove button, comment affordance if the
  other rows have one.
  - When the selected property is **not element-typed** (resolved kind ≠
    'element' via `resolvePropertyKind`, or unknown): show an inline notice on
    the row — e.g. "not an element property — navigation ends here".
- `PathCard.svelte`:
  - `+ Go to property…` trailing add button next to "+ Follow a relationship"
    / "+ Keep only…", and a `+ property` button in the hover insert zones.
  - **Blocking**: compute the first index `b` (if any) where a property step's
    property is non-element-typed. For positions after `b`: hide/disable the
    insert zones and the trailing add buttons for **relationship and property
    steps** ("Keep only" is also pointless past a dead end — block all three;
    simplest and matches "navigation is blocked"). If steps already exist
    after `b` (user changed a property to a non-element one later), render
    them with a muted warning ("unreachable — the chain is blocked above")
    rather than deleting them.
  - `columnFor(i)` counts relationship **and property** steps.
- `FeedsChip` / `ResultsDock` / results headers: no direct edits expected —
  they read `chainColumns` and the server's `step_types`.
- Draft normalization in `navigation-editor.svelte.ts` (`ensureEmbeddedDraft`
  normalize path): make sure property steps pass through unchanged.

## 3. Table editors: rename + placeholder + constraint

Both `NavigationColumnEditor.svelte` and `RowSourceEditor.svelte`:

- Label text `step` → **`Return elements from step`**.
- Input `placeholder="End of chain"` (shown when `step_index` is null/empty —
  empty already means "last step" in both backends).
- **Constraint**: `min="0"`, `max={maxStepIndex}`, and the change handlers
  clamp the parsed number into `[0, maxStepIndex]` (empty string still maps to
  `null`). `maxStepIndex` = the navigation's chain-column count − 1 (i.e. the
  number of relationship+property steps; 0 = start), computed from the
  **effective definition**:
  - inline definition → `chainColumns(defn).length - 1` when the definition is
    a path; a `set_op` root has a single implicit column → max 0.
  - saved **ref** → fetch the artifact payload (`api.getArtifact`, cached per
    ref id in the component) and compute the same; while loading/unknown, the
    input stays unconstrained (backend still 422s out-of-range).
- **Re-clamp on chain shrink**: when the effective definition changes and the
  stored `step_index` exceeds the new max, write the clamped value (`max`)
  back so the stored definition stays evaluable.

## Tests

Backend (`tests/navigation/`, `tests/table/`):
- `test_schema.py`: PropertyStep parses; discriminator round-trip; MAX_STEPS
  counts property steps.
- `test_evaluate_path.py`: property hop (single ref), list-valued ref
  (multiplicity many), dangling id skipped, property absent on element →
  pruned, non-element datatype → pruned, inherited (effective) property
  resolves, `exclude_visited` honored, `step_types` contains the property name
  in order, mixed relationship/filter/property chains.
- `test_evaluate_sets.py`: operand `step_index` addressing a property-step
  column.
- Table: a navigation column whose inline definition uses a property step.

Frontend (vitest):
- `tree.test.ts`: `chainColumns`/`nodeLabel`/`isRunnable`/`precedingTargetTypes`
  with property steps.
- Metamodel helpers: `frontierTypesAt` across relationship→property chains.
- `PropertyStepRow` + `path-card` tests: add button, autocompletion source,
  non-element notice, blocked add buttons.
- Table editor tests: new label text, placeholder, min/max + clamping, ref
  fetch path, re-clamp on shrink.

E2E: not required this iteration (unit + component coverage above; the
existing navigation e2e keeps passing).

## Out of scope (YAGNI)

- Reverse property navigation ("which elements reference X") — not requested;
  the reference index (`_element_refs`) exists if wanted later.
- Returning non-element property *values* from a navigation (chains stay
  element-id tuples).
- Branching (`children`) on property steps.
