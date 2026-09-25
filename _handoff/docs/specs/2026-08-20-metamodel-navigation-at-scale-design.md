# Metamodel navigation at scale — design

**Date:** 2026-08-20
**Status:** approved (brainstorm 2026-08-20)
**Backlog:** P-17 (unbounded zoom-out + level-of-detail), P-18 (hover
highlighting), plus two new owner requests filed in the same session:
collapsible side panel (sections + whole-panel), and type search with
autocomplete that navigates the canvas to the selected type.

## 1. Goal

A metamodel that stays comfortable to consult, navigate and edit however big
it gets. Four features, one surface: the metamodel diagram tab
(`frontend/src/lib/components/Metamodel/`). Everything here is **frontend-only
presentation work** — no backend routes, no wire schema, no lease/commit/staging
changes, no `yaml-edit.ts` changes.

## 2. Current state (verified against `main`, 2026-08-20)

- `MetamodelDiagram.svelte:373` renders `<SvelteFlow>` with **no `minZoom`**,
  so xyflow's default floor of `0.5` applies — a big metamodel cannot be
  zoomed out far enough to see everything (P-17's confirmed cause).
- A `Find type…` input exists in the toolbar (`:326-334` / `findAndCenter`
  `:211-224`): Enter pans to the **first** substring match at zoom 1.2 and
  selects it. No dropdown, no keyboard navigation, element/enum/assoc boxes
  only (it matches `built.nodes`, so relationships without an assoc box are
  unfindable).
- Per-node collapse plus Collapse all / Expand all already exist
  (`view.collapsed`, `toggleNodeCollapsed`, `setAllCollapsed`).
- `MetamodelFormPanel.svelte` is a fixed 320px `aside`
  (`MetamodelDiagram.svelte:410-412`). Its no-selection overview lists
  **enums** and **mapless relationships** only — no element-type list, no
  full relationship list, nothing collapsible, and the panel itself cannot be
  hidden.
- Click-selection of a relationship already highlights **all** of its edges
  (`MetamodelDiagram.svelte:181-200`), which the hover and search features
  below extend rather than replace.
- `buildDiagram` (`metamodel/diagram-build.ts`) derives every edge's
  endpoints from `rel.mappings`; `nodeSize` is the single source of a box's
  footprint. Both stay untouched in shape — this design only adds a derived
  adjacency index beside them.

## 3. Architecture decision: how hover + LOD reach the node/edge components

**Chosen: a shared reactive hover/LOD store, rebuild-free.**

Hover state and the LOD boolean live in the diagram state module
(`state/metamodel-diagram.svelte.ts`), exposed through the existing
`getMetamodelDiagramView()`-style accessors (or a small sibling accessor —
implementer's choice, but ONE module owns it). Each node/edge component reads
them directly and computes its own dim/highlight/simplified classes.

Why not the existing `specToNode` pattern (folding hover into node `data`
like `collapsed` is today): every hover-move would rebuild both
`flowNodes`/`flowEdges` arrays and re-diff the whole flow. Fine at 20 nodes,
wrong at 300 — and "wrong at 300" is the entire premise of this feature set.
The LOD flag is different: it flips only at a zoom threshold crossing
(rarely), so it MAY ride the rebuild path if that is simpler; hover MUST NOT.

Why not pure CSS (`data-hover-rel` on the wrapper + selectors): the adjacency
"edges incident to this node" is not expressible in CSS, so it degenerates
into the chosen approach anyway.

### 3.1 The hover store

```ts
type DiagramHover =
  | { kind: 'node'; id: string }        // a box (element / enum / assoc class)
  | { kind: 'rel'; name: string }       // any edge of a relationship type
  | null;
```

Written by `onmouseenter`/`onmouseleave` (or xyflow's
`onnodepointerenter`-family events) from the node/edge components or the
canvas wrapper; read by every node/edge component and by the LOD tooltip
overlay. It also carries the last cursor position (canvas-relative) for the
tooltip; cursor position updates only need to be tracked while the tooltip is
visible (LOD mode + hovering something), never unconditionally.

### 3.2 The adjacency index

Derived once per `buildDiagram` result (either returned alongside
`{nodes, edges}` or computed in a `$derived` beside `built` — implementer's
choice; it must be O(edges) and rebuilt only when the parsed metamodel
changes):

```ts
interface DiagramAdjacency {
  relEndpoints: Map<string, Set<string>>; // rel name -> node ids it touches
  nodeRels: Map<string, Set<string>>;     // node id -> incident rel names
  nodeNeighbors: Map<string, Set<string>>; // node id -> node ids one edge away
}
```

**Generalization edges participate**: hovering a type highlights its
parent/child links too. Generalization has no relationship *name*, so either
the maps key them under a reserved synthetic key per edge (e.g. the edge id)
or `nodeNeighbors`/an edge-id-level index covers them — the invariant is:
hovering a node must highlight every incident edge of BOTH kinds and each
edge's other endpoint; hovering a generalization edge highlights that edge
and its two boxes.

## 4. Feature 1 — Unbounded zoom + level-of-detail (P-17)

- `minZoom={0.05}` on `<SvelteFlow>` (effectively unbounded for any real
  metamodel; xyflow needs a nonzero floor).
- One viewport subscriber (a single `onviewportchange`/store subscription in
  `MetamodelDiagram`, NOT per-node) derives `lod: boolean` with
  **hysteresis**: enter simplified mode when zoom drops below ~`0.4`, leave
  when it rises above ~`0.5`. Exact numbers are tuned during implementation
  against `examples/smart-city.metamodel.yaml`; the two thresholds MUST
  differ so the boundary cannot flicker.
- **LOD render** (in `ElementTypeNode`, `EnumTypeNode`, `AssocClassNode`):
  name-only — the title at a larger relative font, property/literal rows not
  rendered. Edges keep their lines but drop floating labels/multiplicity
  text (`AssociationEdge`).
- **Box footprint is identical in both modes.** `nodeSize` is not consulted
  about LOD and does not change: elk layout, stored positions and edge
  anchors never move when the mode flips — only box contents change. This is
  the load-bearing simplification: no reflow class of bugs, no layout/LOD
  interaction.
- LOD does not touch collapse state; the two compose (a collapsed box in LOD
  mode is just a name-only box that stays name-only when zooming back in).
- **Cursor tooltip in LOD mode**: hovering a box or edge shows a small
  tooltip near the cursor with its name (edges: `RelName` plus
  `Source → Target` for the hovered mapping). ONE absolutely-positioned
  overlay owned by `MetamodelDiagram`, fed by the hover store — not a
  per-node tooltip, not `title=` attributes. Hidden outside LOD mode (full
  detail renders names in the boxes already).

## 5. Feature 2 — Hover highlighting (P-18)

- Hover a **node** → that node, every incident edge (associations AND
  generalizations), and each such edge's other endpoint **highlight**;
  everything else **dims** to ~0.25 opacity.
- Hover an **edge** → all edges of that relationship name (consistent with
  the existing click-selection semantics — one relationship reads as one
  thing) plus every endpoint box highlight; rest dims. A generalization edge
  highlights itself and its two boxes.
- **Transitions**: CSS opacity transition ~120ms, with a short delay
  (~100-150ms) before dimming engages, so sweeping the cursor across the
  canvas does not strobe. Un-hover restores promptly.
- **Selection composes**: the shipped selection highlight stays; hover layers
  on top and wins visually while active (a selected-but-dimmed box must not
  occur — selected elements are exempt from dimming, or hover simply
  overrides while it lasts; implementer picks, tests pin it).
- Implementation is class toggling inside each node/edge component off the
  hover store + adjacency index — no array rebuilds (§3).

## 6. Feature 3 — Search with autocomplete

- The toolbar `Find type…` input grows a **dropdown**, mirroring
  `Sidebar/Search.svelte`'s typeahead (same visual treatment, debounce,
  keyboard model: ↑/↓ move, Enter selects, Esc closes; match substring
  highlighted in each row).
- **Coverage**: element types, enums, AND relationship types (including
  mapless ones), each row badged/grouped by kind.
- **Matching**: case-insensitive substring over names, purely client-side on
  the parsed draft (`view.mm`) — no API call; the metamodel is already fully
  client-side. Ranking: prefix matches before mid-string, then alphabetical.
- **On select** — one shared `revealSelection(sel: DiagramSelection)` helper
  used by BOTH search and the panel TOC (§7) so the two cannot drift:
  - element / enum → `setCenter` on the box (existing `findAndCenter` math:
    stored position + `nodeSize`, so it works for never-rendered nodes) +
    `selectDiagramNode`, opening its form.
  - relationship **with mappings** → `fitBounds` over the union of all its
    endpoint boxes' rects (positions + `nodeSize`; its assoc-class box, when
    it has one, is included in the union), then select — all its edges
    highlight and every stereotype pair it connects is on screen.
  - relationship **with no mappings** → select only, no pan (nothing is
    drawn; the form panel is the destination, as today).
- The existing Enter-pans-to-first-match behaviour is subsumed: Enter with
  the dropdown open selects the active row.

## 7. Feature 4 — Side panel: TOC sections + whole-panel collapse

### 7.1 Sections

The no-selection overview in `MetamodelFormPanel` becomes a table of
contents with four parts:

1. the existing header counts (unchanged);
2. **Element types** — new; currently the overview has no element-type list
   at all;
3. **Relationship types** — ALL of them (replacing today's mapless-only
   list), with mapless ones badged (e.g. "no mappings") since they remain
   reachable only here and via search;
4. **Enums** — as today.

Every row is click-to-select **and pans**, via the same `revealSelection`
helper as search (§6). Each section header is a collapse toggle using the
`Sidebar/StagedSection.svelte:134-147` header-button idiom; collapsed state
persists per-section in the existing `ui.*` localStorage prefs (one key per
section, e.g. `ui.mmPanelSections`). Long lists just scroll — no paging;
this is parsed client-side data and a few hundred text rows render fine.

### 7.2 Whole-panel collapse

- A chevron control on the `aside` border collapses the whole 320px column;
  the canvas takes the full width. State persisted in `ui.*` localStorage.
- When a selection lands while the panel is collapsed:
  - selection made via **search or the TOC** (which implies wanting the
    form/panel) → the panel **reopens**;
  - selection made by **clicking the canvas** → the panel stays collapsed,
    and the chevron shows a subtle indicator that a selection is waiting.
- The read-only note and all form behaviour inside the panel are unchanged.

## 8. Non-goals / untouched

- No backend or wire changes. No changes to `yaml-edit.ts`, leases, staging,
  the commit flow, or `metamodel.move_node` semantics.
- `nodeSize` and elk auto-arrange untouched (LOD is render-only, §4).
- Existing per-node collapse, Collapse/Expand all, auto-arrange: unchanged
  and composable with everything above.
- Viewer/read-only gates: all four features are **read affordances** and are
  available to viewers; nothing here consults `readOnly`/`canDragLayout`.
- e2e coverage stays out of scope, consistent with the standing T-7 gap —
  note the addition there rather than blocking this work.

## 9. Testing

Unit / component (vitest, happy-dom):

- **Adjacency index**: nodes→rels, rels→endpoints, generalization
  participation, assoc-class tether halves belonging to one relationship.
- **LOD hysteresis**: crossing down flips at the low threshold, crossing up
  at the high one, values between thresholds keep the current mode.
- **Search**: matching/ranking (prefix before substring), kind coverage
  (element/enum/relationship incl. mapless), keyboard flow
  (↑/↓/Enter/Esc), and the three on-select behaviours — setCenter args for a
  box, fitBounds rect for a multi-mapping relationship (the bounding-box
  math), select-only for mapless.
- **Hover**: hover store transitions; a node/edge component's
  highlight/dim class derivation against the index; selection-vs-hover
  composition rule.
- **Panel**: TOC sections render only their own kind, rows call
  `revealSelection`, per-section collapse persists, whole-panel collapse
  persists, reopen-on-search/TOC-selection vs stay-collapsed-on-canvas-click.

## 10. Backlog bookkeeping

On completion: mark P-17 and P-18 `done` in `BACKLOG.md`, and record the two
new features (panel collapsibility, search autocomplete) as shipped in the
same entry family; add the metamodel-navigation surface to T-7's e2e-gap
list.
