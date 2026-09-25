# Navigation, Tables & Diagrams — Mega-Plan Design Spec

Date: 2026-07-05
Status: Approved design (high-level). Each stage gets its own refined spec + plan
before implementation.

## Summary

Three staged features built on one shared foundation:

1. **Stage 1 — Navigation engine + builder.** A generic, backend-evaluated
   element-navigation system: walk chains of relationships from a filtered start
   set, filtering by type/property/condition at every hop. Ships with a frontend
   builder + live chain preview, a project-shared navigation library, the generic
   artifact-storage layer, dynamic workspace tabs, and view-tree placement of
   artifacts.
2. **Stage 2 — Table system.** Customizable tables: rows are elements of chosen
   stereotype(s); columns show properties (blank where a type lacks them) or
   navigation results. Server-side paged evaluation, inline property-cell editing
   through the checkout/commit flow. A navigation rendered "as table" (one column
   per step) replaces a standalone chain viewer.
3. **Stage 3 — Block diagrams.** NoMagic-style diagrams: user-definable diagram
   kinds (palette rules + notation map), notation-rich model-bound blocks
   (compartments, styled edges, containment nesting), free-form annotations,
   populate-from-navigation, and model editing from the canvas via
   checkout/commit + connection rules.

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Navigation shape | Linear chains, stored in a **branch-ready step-tree** format (stage 1 evaluates single-child chains only; branching is additive later, no migration) |
| Navigation evaluation | **Backend-side** against `model.indexes` (80 MB models; client never holds the model) |
| Navigation reuse | **Named library + inline**: consumers reference a saved artifact by id or embed an ad-hoc definition |
| Set operations | **Element-set expressions**: union/intersection/difference/symmetric difference over the element sets navigations reach (terminal step by default, or a chosen step); composites are first-class navigations. Chain-tuple ops are a non-goal |
| Artifact ownership | **Project-shared** (role-gated: viewer read, editor+ write), stored outside the model |
| Artifact storage | One `project_artifacts` DB table + generic CRUD router (ViewRow precedent) |
| Artifact concurrency | Optimistic `artifact_rev` (409 on stale write) + `artifact_event` on the FeedHub; **no leases/commits** for artifact edits |
| Table cells | Property cells **editable from day one** via checkout/commit; derived columns read-only |
| Diagram population | **Both**: user-authored (drag from tree/search) + populate-from-navigation |
| Diagram editing | **Model editing from day one** (create/connect/delete ops via checkout/commit + Phase 6a connection rules) |
| Diagram types | User-definable **diagram kinds** (palette rules + notation map) + built-in Free-form kind + free-form annotation layer (Cameo-style) |
| Diagram edges | **Derived at render time** from model relationships between on-canvas endpoints — never stored in the diagram, never stale |
| Chain viewer | Folded into tables (navigation-as-table preset); stage 1 has a preview panel in the builder |
| Discoverability | Sidebar **artifacts section** (library index) + **view-tree placement**: view folders can reference artifacts alongside elements |
| Opening surface | **Dynamic workspace tabs**: Detail/Graph/Issues stay built-in; tables/diagrams/builder open as closable tabs; open set persists per project |
| Staging | Feature-per-stage (A): engine+builder → tables → diagrams |

## Cross-cutting foundations

### Navigation definition (the shared currency)

One versioned Pydantic schema in `core/navigation/` (`schema_version` field):

- **start**: element scope = element type(s) (subtypes included) + property/
  condition filters.
- **steps**: each `{relationship_type, direction (out|in|either), target_filter,
  children: [...]}`. Stage 1 restricts `children` to 0 or 1 (linear); the tree
  shape means branching later is additive.
- **conditions** reuse the criterion vocabulary from advanced search
  (equals/contains/gt/lt/has-type/…).

A definition is one of two forms:

- **path** — `start` + `steps` as above; evaluates to chains.
- **set expression** — `{op ∈ {union, intersection, difference,
  symmetric_difference}, operands: [...]}` where each operand is a navigation
  ref or inline definition plus an optional step index selecting which step's
  elements it contributes (default: terminal step). Evaluates to an element
  set (conceptually chains of length 1). Expressions nest.

Composites are first-class navigations: saveable in the library and usable
anywhere a navigation is — as a table row scope, as another path navigation's
`start` (start = type scope **or** set expression), for diagram population,
and as row-rooted navigation columns (e.g. intersect two navigations from the
same row element).

Evaluation is backend-only, walks `model.indexes` adjacency (O(reached
elements) per step, never model scans), returns **chains** (tuples of element
ids, one per step) as paged result sets with a hard result cap and step-depth
cap. Evaluator is pure/read-only over `(metamodel, model)` — no session
coupling.

### Artifact storage

New DB table `project_artifacts`:
`(id, project_id FK cascade, kind ∈ {navigation, table, diagram, diagram_kind},
name, payload JSON, artifact_rev, updated_at, updated_by)`.

- Generic CRUD router at `/api/v1/projects/{project_id}/artifacts` behind
  `require_membership` (viewer read-only, editor+ write).
- Payloads validated against the kind's schema on write.
- Optimistic concurrency: writes carry `artifact_rev`, stale → 409.
- `artifact_event` broadcast on the existing `FeedHub` so open clients refresh.
- Artifacts survive session eviction (plain DB rows), are deleted with the
  project, and are **never** part of the model or the op journal.

### Consumption rule

Wherever a navigation is used (table column, diagram populate), the reference is
either `{"ref": "<artifact_id>"}` or an inline definition, resolved at
evaluation time — editing a library navigation flows through to every consumer.

### Mutation rule

Editing surfaces (table cells, diagram canvas) never invent a new mutation
path: they stage op batches through the existing checkout flow
(`state/checkout.svelte.ts` → locks → `POST /commits`). Artifact-only changes
(layout, columns, folder placement) are plain artifact/view saves.

### View–artifact integration

View folders can hold **artifact references**
(`{kind, artifact_id}`) alongside element references — additive view-schema
evolution (`schema_version` bump; old view.json files stay valid).

- Placement by drag-and-drop from the sidebar artifacts section into view
  folders (existing tree DnD machinery); an artifact may appear in multiple
  folders (references; the view owns nothing).
- Tree renders artifact nodes with kind-specific icons; the `TreeItem`
  projection gains an artifact variant; double-click opens the workspace tab.
- Deleting an artifact prunes its view references (same pattern as element
  deletion); removing from a folder never deletes the artifact.
- Ships in Stage 1 generically for all kinds.

### Information architecture

- **Sidebar**: new "Artifacts" section (library index) grouping Navigations,
  Tables, Diagrams (by kind) with create/rename/delete actions — plus view-tree
  placement above.
- **Workspace**: `Workspace.svelte` moves from three fixed tabs to a dynamic
  tab strip. Built-ins (Detail, Graph, Issues) stay; opened artifacts add
  closable tabs; multiple open at once; open-tab set + active tab persist per
  project. Lands in Stage 1.

## Stage 1 — Navigation engine + builder

- **Core** (`core/navigation/`): `NavigationDefinition` schema (path + set
  expression forms) + pure evaluator (paged chains, set-expression evaluation
  to element sets, result/depth caps, distinct-chain duplicate policy). Unit
  tests in `tests/navigation/`.
- **API**: `POST /projects/{id}/navigations/evaluate` (inline def or artifact
  ref → page of chains with lite element projections: id/name/type, the
  TreeItem-style shape) + the generic artifacts CRUD router (first kind:
  `navigation`).
- **Frontend**: Navigations library in the sidebar artifacts section; builder
  as a workspace tab — vertical step editor (start scope, then hops offering
  only relationship types valid from the previous step's type, metamodel
  `mappings`-aware, reusing advanced-search picker components) with a live
  paged chain-preview panel; clicking a chain element selects it in the
  Inspector via the existing `select()`. A composite editor covers set
  expressions: pick an operator and operands (library refs or inline), preview
  the resulting element set.
- **Also in this stage**: dynamic workspace tabs, view-schema artifact refs +
  tree rendering + DnD.
- **Testing**: evaluator unit tests; API tests via `client`/`papi` fixtures;
  vitest for builder state; one e2e (build → preview → save → place in view).

## Stage 2 — Table system

- **Definition** (`kind=table` artifact): `{name, row_scope, columns[]}`.
  `row_scope` = element type(s) + optional filters (same scope vocabulary as a
  navigation start) **or** a navigation reference (path terminal set or set
  expression) — e.g. rows = the intersection of two navigations. Column union:
  - `property` — value of `properties[key]`; blank when the row's type lacks
    the property. Column picker offers the union of effective properties across
    scoped types, flagging which types carry each.
  - `element` — the row element itself (name/type badge; default first column).
  - `navigation` — ref or inline, rooted at the row element (start scope
    implicitly the row); cell renders reached elements as clickable chips, with
    an optional "show step N" to surface an intermediate hop; per-cell result
    cap.
- **API**: `POST .../tables/evaluate` — server-side evaluation of scope + all
  columns for one page of rows (sortable columns, cursor pagination). The
  client never joins data itself.
- **Frontend**: table workspace tab — open/save from the library, column
  manager (add/remove/reorder/rename), virtualized grid. "Open navigation as
  table" generates a transient table (one element column per chain step),
  saveable as a real table artifact.
- **Editing**: property cells inline-editable for editor+ — acquire the
  element's lease, stage `set_property` through checkout state, commit via
  `POST /commits` (same UX as the inspector). Derived columns read-only.
- **Testing**: evaluation API tests (scope, blank cells, nav columns, paging,
  sorting); vitest for column manager + grid state; e2e for edit-cell → commit.

## Stage 3 — Block diagrams

- **`diagram_kind` artifact**: allowed element types (palette filter), allowed
  relationship types, and a **notation map** — per element type: shape, color,
  icon, compartment properties; per relationship type: line style, arrowheads,
  label. One built-in "Free-form" kind (everything allowed, default notation).
- **`diagram` artifact**: kind ref; model-bound nodes (`element_id`, position,
  size, compartment collapsed state); free-form annotations (notes, shapes,
  text — diagram-local, no model identity); edge routing hints. **Edges are
  not stored**: any model relationship whose endpoints are both on canvas is
  drawn per the kind's notation at render time — diagrams never go stale.
- **Canvas**: `@xyflow/svelte` (Svelte Flow) — pan/zoom, custom node/edge
  components for the notation (compartment nodes, containment as nesting),
  manual layout persisted in the artifact, ELK auto-layout for populate flows.
- **Population**: drag from sidebar tree / search results; or
  populate-from-navigation (run nav, place chain elements, auto-layout). Kind
  rules filter what may be placed.
- **Model editing from the canvas**: palette-create → create op; drawing an
  edge offers valid relationship types for the endpoint pair (Phase 6a
  connection-rule machinery) → connect op; delete distinguishes "remove from
  diagram" (artifact-only) vs "delete from model" (op). All model mutations via
  checkout → locks → commit. Commit events over the feed refresh the canvas;
  deleted elements render as ghosts until removed from the diagram.
- **Testing**: kind/notation resolution unit tests; artifact schema tests;
  vitest for canvas state (derived edges, ghost handling); e2e for place →
  connect → commit.

## Non-goals (this mega-plan)

- Branching navigation evaluation (format supports it; evaluator/UI later).
- Graph-pattern (Cypher-like) matching.
- Chain-tuple set operations (same-shape chain algebra); set ops act on
  element sets only.
- Per-user private artifacts / sharing flags (project-shared only).
- Realtime co-editing of the same diagram (last-write-wins + 409 + feed
  refresh; CRDT/merge later if needed).
- Table cell editing beyond scalar property values (no bulk edit, no
  relationship editing from tables).
- Printing/exporting diagrams and tables (PNG/CSV export later).

## Open items for per-stage refinement

- Stage 1: exact criterion operator set; result-cap defaults; cursor encoding;
  builder UX for editing mid-chain steps; set-expression nesting depth and
  step-index selection UX in the composite editor.
- Stage 2: sort semantics for multi-value navigation columns; per-column width/
  format persistence; save-as flow from transient nav-tables.
- Stage 3: notation map schema details; containment nesting vs edge rendering
  rules; ghost-node lifecycle; ELK integration scope.
