# Phase 6A — Metamodel-driven connection-rules editing UX

**Status:** design approved, pending implementation plan
**Scope:** Phase 6, half A (the connection-rules editing UX). Half B (metamodel
sandbox-validate + non-destructive rebind) is deliberately split into its own
later spec — see *Out of scope* below.

## 1. Why

The metamodel already defines, per relationship type, the allowed `(source,
target)` endpoint pairs (`mappings`) and end multiplicities
(`source_multiplicity`, `target_multiplicity`). Today the "New relationship"
picker only honors a naive single-pair shorthand (`isSubtype(source.type,
rt.source)`), ignores the full `mappings[]`, offers no escape hatch, and has no
multiplicity awareness. This phase turns the picker into a faithful,
metamodel-driven guardrail: offer only the relationship types the metamodel
permits from the selected source, let the user deliberately bypass that filter
(soft-typing stays available), and gray out types whose source-side multiplicity
is already maxed.

The backend stays **soft regardless** — this is a UI guardrail (defense in
depth), never enforcement. Over-multiplicity and off-metamodel edits remain
possible and surface as soft conformance issues at commit time (per the
collaborative-architecture design §8/§10).

## 2. Scope decision

Phase 6 splits into two largely independent halves; this spec is **half A only**:

- **A (this spec):** connection-rules editing UX — filtered relationship picker,
  always-available escape hatch, source-side multiplicity gray-out. Pure
  frontend, no backend changes.
- **B (separate later spec):** metamodel swap — read-only sandbox conformance
  diff + non-destructive journaled rebind, superseding the current destructive
  `session.set_metamodel()` / `POST /metamodel`.

Confirmed scope cuts for A (from brainstorming):

- **Escape hatch:** an always-available "Show all types" toggle in the picker.
  Strict-mode (the doc's alternative gating) stays deferred/TBD — we do **not**
  introduce a strict-mode flag here.
- **Multiplicity gray-out:** **source-side, type-level only** — gray out a
  relationship *type* when the source is already at its `target_multiplicity`
  upper bound. Target-side over-multiplicity (`source_multiplicity` on the chosen
  target) is **not** enforced in the picker; per architecture §8 it can't be
  lock-protected under concurrent connects and stays a soft commit-time flag.
- **Gesture scope:** the inspector `NewRelationshipPicker` only. Other connect
  gestures (containment-tree drag-connect, any `DetailView` connect path) are
  noted as follow-up, not touched here.

## 3. Multiplicity semantics (grounding)

From `core/validation/validators/multiplicity.py`, confirmed exactly:

- **`target_multiplicity`** bounds `count_out(element, rel_type)` — how many
  outgoing edges of a type an element acting as **source** may have. Violation
  reads "element X has N target(s), violates target multiplicity". This is the
  bound the picker enforces (the source's own out-degree — knowable and
  lock-protectable).
- **`source_multiplicity`** bounds `count_in(element, rel_type)` — how many
  incoming edges an element acting as **target** may have. The picker does **not**
  enforce this (best-effort only; soft commit-time flag).

So when creating an outgoing relationship of type `T` from `source`, the
relevant guardrail is: would `count_out(source, T) + 1` exceed `T`'s
`target_multiplicity` upper bound?

## 4. Count source — client relationship cache (no backend endpoint)

The picker lives inside the optimistic checkout/staging flow, so the gray-out
must reflect **staged-but-uncommitted** edits, not just committed server state.
The client already keeps a reactive relationship cache (`getCachedRelationships`)
that includes optimistic emits; that is the staging-correct source for
out-counts.

- No new backend route. A server-side `out-degree` endpoint was considered and
  rejected: it would ignore staged edits and add a round-trip + route + tests
  for a count the client already holds.
- Practically exact: multiplicity upper bounds are tiny (usually 1 or a few), so
  the 500-row seed cap never limits "at max" detection.
- The doc's large-metamodel fallback (`GET /metamodel/connections`) stays
  unbuilt — YAGNI while the metamodel is small and shipped whole.

## 5. Components

### 5.1 New pure module `frontend/src/lib/metamodel/connection-rules.ts`

Svelte-free, unit-tested alongside `helpers.ts`. Reuses `isSubtype`,
`relationshipType`, `parseMultiplicity` from `helpers.ts`. Mirrors backend
mapping + end-constraint semantics.

```ts
/** Distinct mapping targets whose mapping source is a supertype-or-equal of
 *  sourceType. Falls back to [rt.target] (single-pair shorthand) when
 *  rt.mappings is empty. */
function allowedTargetTypes(mm: Metamodel, sourceType: string, rt: RelationshipType): string[];

/** Non-abstract relationship types creatable from sourceType, each paired with
 *  its allowed target types. Replaces the picker's naive single-pair filter. */
function relationshipTypesFromSource(
  mm: Metamodel,
  sourceType: string,
): { rt: RelationshipType; targetTypes: string[] }[];

/** True when rt.target_multiplicity has a finite upper bound and the source
 *  already has >= upper outgoing edges of this type. Matches the
 *  MultiplicityValidator target-end check. */
function targetMultiplicityExceeded(rt: RelationshipType, currentOutCount: number): boolean;
```

Notes:
- `allowedTargetTypes` matches a mapping when `isSubtype(sourceType,
  mapping.source)` — inheritance on the source end, mirroring backend
  `endpoint_typing`. (Target-end subtype expansion for *candidate fetching* is
  already handled downstream by `fetchElementsOfType`.)
- Empty-`mappings` fallback keeps the helper robust even though the backend keeps
  `mappings` populated and `source`/`target` in sync with `mappings[0]`.

### 5.2 `NewRelationshipPicker.svelte` rework

Four changes, all local to this component:

1. **Mappings-aware type list.** Replace `availableTypes` with
   `relationshipTypesFromSource(mm, source.type_name)`. Each entry carries its
   `targetTypes` for candidate fetching.

2. **Escape-hatch toggle.** A `showAll` boolean (default `false`), surfaced as a
   "Show all types" checkbox/toggle in the expanded panel.
   - `showAll === false`: only mapping-allowed types listed.
   - `showAll === true`: all non-abstract relationship types listed;
     mapping-disallowed types appear under a muted "off-metamodel" subheading (or
     with a muted marker) but remain selectable — backend stays soft.

3. **Source-side multiplicity gray-out.** For each candidate type compute
   `currentOutCount` from cached outgoing relationships of `sourceId` grouped by
   `type_name`. When `targetMultiplicityExceeded(rt, currentOutCount)`:
   - default (filtered) mode: render the `<option>` **disabled** with a tooltip
     `"{sourceName} already has {n}/{max} {rt.name} target(s)"`.
   - `showAll` mode: downgrade to a **non-disabling warning** (muted style +
     tooltip, still selectable) so the escape hatch overrides the guardrail
     consistently with bypassing the type filter.

4. **Multi-target candidates.** Fetch candidates across the **union** of
   `allowedTargetTypes(mm, sourceType, chosenType)` (today only
   `chosenType.target`), merged and capped at `TARGET_CAP` (200). Preserve the
   existing "showing first N of M (+)" truncation messaging; the truncation flag
   is the OR of per-type truncation.

To feed change 3, the picker seeds the source's outgoing relationships on expand
via the same `listElementRelationships(sourceId, { direction: 'out', limit:
... })` call `RelationshipsList` uses, then `seedRelationships(...)`. Counts then
derive reactively from `getCachedRelationships()`, so optimistic/staged emits
update the gray-out live (e.g. creating a `0..1` edge immediately disables that
type for a second add before commit).

The existing `connectLock(sourceId, target)` gate on `create()` is unchanged —
locking behavior is orthogonal to this phase.

### 5.3 Untouched

- Backend: no route, schema, or core changes.
- `metamodel.svelte.ts` store and `helpers.ts`: reused as-is (new module imports
  from `helpers.ts`).
- Other connect gestures and `RelationshipsList.svelte` (display-only): untouched.

## 6. Data flow

```
source element selected in Inspector
  -> NewRelationshipPicker expands
     -> seed source's outgoing relationships (listElementRelationships, direction=out)
     -> relationshipTypesFromSource(mm, source.type)         [mappings + inheritance]
     -> per type: currentOutCount = cached out-rels grouped by type_name
                  disabled/warn = targetMultiplicityExceeded(rt, currentOutCount)
  user toggles "Show all types"  -> widen type list, downgrade gray-out to warning
  user picks a type
     -> fetch candidates over union(allowedTargetTypes(mm, source.type, type))  [capped]
  user picks a target, clicks Create
     -> connectLock(...) -> emit create_relationship (optimistic; staged)
     -> cached out-rels update -> gray-out recomputes live
```

## 7. Error / edge handling

- **Unknown / abstract source type** (`elementType` returns undefined): empty
  type list (existing "(no valid relationships from this type)" message). Show-all
  still lists all concrete types so the user is never fully blocked.
- **Malformed multiplicity spec:** `parseMultiplicity` already returns `0..*`
  (never exceeded) on bad input → type stays enabled. No throw.
- **Source with huge out-degree (> seed cap):** count is a lower bound; only
  affects implausible cases where the multiplicity upper also exceeds the cap.
  Acceptable; documented in the helper.
- **`mappings` empty:** single-pair fallback keeps behavior identical to today
  for such types.
- **Candidate fetch failure per target type:** existing try/catch path; a failed
  sub-fetch contributes nothing to the merged list and logs, rather than blanking
  the whole list.

## 8. Testing

- **Unit (vitest)** — `connection-rules.test.ts`:
  - `allowedTargetTypes`: multi-mapping selection, source inheritance match,
    empty-mappings fallback, no-match → `[]`.
  - `relationshipTypesFromSource`: excludes abstract types, excludes types with
    no allowed target, dedupes target types.
  - `targetMultiplicityExceeded`: `0..1`, `1..*` (no upper → never), exact `N`,
    `*`, malformed spec, boundary at exactly `upper`.
- **Component (vitest + happy-dom)** — `NewRelationshipPicker`:
  - filtered list vs show-all list membership;
  - maxed type rendered `disabled` with tooltip in filtered mode, selectable
    warning in show-all mode;
  - multi-target union populates candidates from >1 target type;
  - optimistic count update: after emitting a `0..1` edge, the type disables
    without a refetch.
- **E2e (playwright)** — extend an existing inspector smoke: select element →
  New relationship → observe filtered types → toggle Show all → more types
  appear → pick target → Create succeeds.

## 9. Out of scope (explicit)

- **Phase 6B:** metamodel sandbox conformance diff + non-destructive rebind.
  Separate spec/plan.
- **Strict-mode** flag/setting (deferred open question §5 of the architecture
  doc).
- **Target-side (`source_multiplicity`) enforcement** in the picker — stays a
  soft commit-time flag.
- **Other connect gestures** (containment-tree drag, DetailView).
- **`GET /metamodel/connections`** large-metamodel fallback endpoint.
- Any backend route/schema/core change.

## 10. Acceptance

- Picker lists exactly the mapping-allowed (source-inheritance-aware,
  multi-mapping) relationship types by default; "Show all" reveals the rest.
- A relationship type whose source is at `target_multiplicity` max is grayed out
  with an explanatory tooltip in the default view, and selectable-with-warning
  under "Show all".
- Target candidates span all allowed target types for the chosen type.
- Gray-out reflects staged (uncommitted) edits live.
- No backend changes; all three test layers green; `npm run check` clean.
