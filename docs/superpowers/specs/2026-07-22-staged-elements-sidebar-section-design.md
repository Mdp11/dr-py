# Staged elements sidebar section — design

**Date:** 2026-07-22
**Status:** Approved (brainstorm with user)

## Problem

Elements created and staged via a code snippet run (`snippet-stage.ts` →
`emit()`) are unreachable in the UI until commit. The containment tree renders
only server-paged rows (roots/children pages), so client-only temp elements
never appear there; DiffDrawer rows are inert except for their discard button.
The Inspector/DetailView *can* display and edit a temp element — manual
creation relies on it by calling `select()` immediately — but there is no
navigation path to a staged element once it is not selected. The gap affects
snippet-staged and manually created elements alike, in both view and no-view
mode.

## Decision

Add a **"Staged elements"** collapsible section to the sidebar, below
"Not in view" (in no-view mode it is the only extra section). It lists every
element touched by the staged-ops buffer, purely from client state. Rejected
alternatives: clickable DiffDrawer rows only (flat op-level list doesn't scale
to script-generated batches); merging staged rows into the containment levels
(touches the server-paged tree's paging/windowing/view-overlay/drag logic —
highest risk for the same reachability payoff).

## Behaviour

### Section

- Hidden entirely when no element is touched by staged ops.
- Header: `Staged elements · <count>` (total touched elements).
- Collapsible; collapse state persisted to localStorage (same pattern as the
  "Not in view" pool: `ui.treePoolCollapsed` sibling key).
- Present in both view mode and no-view mode.

### Rows

One row per touched element — display name + type styled like tree rows, with
a status badge:

- **New** — element has a staged `create_element` (temp id). Later
  `update_element` ops on the same temp id keep it **New**.
- **Modified** — real (server-known) element with staged `update_element`
  ops, **or** appearing as source/target of any staged relationship op
  (`create_relationship`/`update_relationship`/`delete_relationship`).
- **Deleted** — staged `delete_element`. Rendered strikethrough; display
  name/type come from the pre-delete snapshot in the optimistic journal (the
  element is gone from `_elements` after the optimistic apply).

Sort: New → Modified → Deleted; alphabetical by display name within each
group.

### Interactions

- Clicking a New or Modified row calls `select({kind: 'element', id})`; the
  existing Inspector/DetailView opens and edits it (already works for temp
  elements). Deleted rows are not selectable.
- Every row has a small **revert** button that fully reverts that element's
  staged changes (un-create / un-edit / restore). Revert semantics: remove and
  roll back all staged element ops targeting the id **plus all staged
  relationship ops whose source or target is that element**. The relationship
  cascade is mandatory for New rows: reverting a created element while a
  staged relationship still references its temp id would leave a dangling temp
  ref that 422s at commit. Accepted side effect: reverting element A may
  demote element B from Modified to untouched when their only staged link was
  a shared relationship op.

## Data flow

A pure derivation over the staged queue (`getStagedOps()` plus the journal's
recorded pre-state) yields `{id, status, display_name, type_name}` rows:

- Reactive: rows appear on staging, vanish on revert/discard, and the section
  empties on commit (queue clears; committed elements then surface in the real
  tree via the normal acknowledged-delta refetch path — temp ids remap to
  canonical ids through the existing machinery).
- No server calls and no paging for the section itself. Modified rows whose
  display data is uncached reuse the existing `ensureTreeItems` lite-row
  fetch.
- The cascade revert extends `revertStagedFor` (today it filters the queue by
  `queuedTargetId === id` only) — either a new
  `revertStagedForElement(id)` that also matches relationship ops by
  source/target, or an extension of the existing function; decided in the
  implementation plan.

## Out of scope

- Rows for relationships themselves (the Inspector's incident-relationship
  view and the DiffDrawer cover them; endpoint elements appear as Modified).
- Clickable DiffDrawer rows (possible later follow-up; independent).
- Placing staged elements inside the containment hierarchy proper (the
  rejected high-risk alternative; this section makes it unnecessary for
  reachability).
- Drag-and-drop from/into the section.

## Testing

- Vitest on the row-derivation function: status assignment (New wins over
  Modified for temp ids), endpoint-modified rule, dedupe across multiple ops,
  deleted-row name/type sourced from the journal snapshot, sort order.
- Vitest on cascade revert: created element with attached staged
  relationships reverts atomically; Modified-via-relationship demotion.
- Component test: section hidden when empty, renders badged rows, click
  selects (deleted rows inert), revert button wiring.
