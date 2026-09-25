# Stage 1 — Navigation Engine + Builder — Design Spec

Date: 2026-07-05
Status: Approved design (ready for implementation plan)
Parent: `2026-07-05-navigation-tables-diagrams-megaplan-design.md` (mega-plan;
this spec refines its Stage 1 and inherits all mega-plan decisions).

## Summary

A generic, backend-evaluated element-navigation system: walk chains of
relationships from a filtered start set, filtering by type/property/condition
at every hop, plus element-set operations (union/intersection/difference/
symmetric difference) between navigation results. Ships with:

- `core/navigation/`: versioned `NavigationDefinition` schema + pure evaluator.
- `project_artifacts` DB table + generic CRUD router (foundation for Stage 2
  tables and Stage 3 diagrams) + `POST /navigations/evaluate`.
- Frontend: dynamic workspace tabs, sidebar Artifacts section, navigation
  builder with live paged chain preview, view-tree artifact placement.

## Key decisions

| Decision | Choice |
|----------|--------|
| Filter vocabulary | Reuse the existing server-side search criteria (`api/search.py`); criterion models are lifted into `core/` and re-exported by `api/search.py` (wire format unchanged) |
| Paging | Offset/limit + total, cap 500 per page (repo convention; no cursors). Deterministic DFS enumeration makes stateless offset paging sound |
| Evaluation caps | `max_steps=10` (schema), `max_visited=100k` hops, `max_chains=5000` → `truncated` flag |
| Cycles | A chain never revisits an element it already contains; cycles across the model are otherwise fine |
| Duplicates | Distinct chains; an element may appear in many chains |
| Dangling artifact refs in views | **Tolerated** (skipped at render, warned by `validate_view`) — follows the element-ref precedent; deviation from the mega-plan's "prune", approved 2026-07-05 |
| Hop pickers | Computed client-side with `metamodel/connection-rules.ts` (client holds the full metamodel); no new metamodel endpoint |
| Preview | Explicit Run button (no auto-run); paged loadFirstPage/loadMore |
| Locks/commits | None — artifact writes are DB-only with optimistic `artifact_rev` (409 stale); evaluation is read-only, no `write_mutex` |

## 1. Core: `NavigationDefinition` + evaluator (`src/data_rover/core/navigation/`)

### Schema (`schema.py`, Pydantic, `schema_version: int = 1`)

Tagged union:

- **Path**: `{kind: "path", start, steps}`.
  - `start`: a **scope** `{types: [str], criteria: [Criterion]}` **or** a
    nested set expression.
  - Step: `{relationship_type, direction: out|in|either,
    target: {types?: [str], criteria?: [Criterion]}, children: [Step]}`.
    A validator enforces `len(children) <= 1` in Stage 1 (branch-ready format,
    linear evaluation) and total depth <= `max_steps` (10).
- **Set expression**: `{kind: "set_op", op: union|intersection|difference|
  symmetric_difference, operands: [Operand]}` with
  `Operand = {ref: artifact_id} | inline definition`, each with optional
  `step_index` (default: terminal step). Nesting allowed. `difference` is a
  left-fold over operands.

`Criterion` models are **lifted from `api/search.py` into
`core/search/criteria.py`** (entity_type, property with ops equals/not_equals/
contains/matches/gt/lt/gte/lte/exists/is_empty, name_id, relation_count,
orphan, connected_to_type, endpoint_type); `api/search.py` re-exports them so
the `/model/search` wire format stays byte-identical. The shared matcher
functions move with them.

### Metamodel cache additions (`core/metamodel/schema.py`, `_Caches`)

Two new lazily-built caches beside `_build_end_constraints`:

- `element_descendants(type_name) -> frozenset[str]` — self + all subtypes
  (today only the ancestor direction is cached).
- `relationship_types_from(type_name) -> list[...]` — relationship types with
  a mapping whose source or target matches the type's ancestor set (drives
  hop validity; the frontend computes the same client-side, this cache serves
  the evaluator).

### Evaluator (`evaluate.py`) — pure over `(metamodel, model)`

- Start set: union of `indexes.elements_by_type` over the scope's types **plus
  descendants** (`elements_by_type` is exact-type only), then criteria filter.
- Hop: per frontier element, `outgoing_ids`/`incoming_ids` → relationship
  lookup → rel-type match (subtype-inclusive) → endpoint element → target
  type/criteria filter. O(reached) per step via `model.indexes`; never scans.
- Chains enumerate depth-first in sorted-id order → deterministic output.
- Set expressions: evaluate operands to `set[str]` (elements at `step_index`),
  combine per op. Artifact refs are resolved by the caller (API layer) before
  evaluation; the evaluator sees fully-inlined definitions.
- Result: `ChainPage(chains: list[list[element_id]], total: int,
  truncated: bool)`; `total` = chains found within caps.
- Read-only; no session coupling; no `write_mutex` (same benign-race stance as
  `read.py`).

## 2. Backend: artifacts + evaluate route

### DB (`db_models.py` + Alembic `0008_project_artifacts.py`)

```
ArtifactRow: id (uuid4 hex PK), project_id FK(projects.id, ondelete=CASCADE),
kind VARCHAR + CHECK (native_enum=False), name, payload JSON,
artifact_rev int default 1, updated_at DateTime(tz),
updated_by FK(users.id, ondelete=SET NULL)
UNIQUE (project_id, kind, name)
```

Service functions in `content.py` (no commits; caller owns the transaction):
`create_artifact`, `get_artifact`, `list_artifacts(project_id, kind=None)`,
`update_artifact` (rev-checked), `delete_artifact`.

### Routes (`routes/artifacts.py`, mounted at the project prefix in `main.py`)

- `GET /artifacts?kind=` → headers only (`id, kind, name, artifact_rev,
  updated_at, updated_by`); no payloads.
- `POST /artifacts` / `GET /artifacts/{id}` (with payload) /
  `PUT /artifacts/{id}` (requires `artifact_rev`; stale → 409 with current
  rev) / `DELETE /artifacts/{id}`.
- Payload validated per kind on write; Stage 1 accepts `kind=navigation` only
  (unknown kinds 422; later stages enable more).
- Authz via `require_membership` (GET viewer-ok, writes editor+). No allowlist
  changes for CRUD.
- `POST /navigations/evaluate`: body `{definition | artifact_id, limit <= 500,
  offset}` → resolves refs recursively (ref cycle → 422), evaluates, returns
  `{steps: [step labels], chains: [[TreeItem, ...]], total, truncated}` with
  the lite `TreeItem` projection (`id, type_name, display_name, child_count`).
  **Added to `authz._READ_ONLY_POST_SUFFIXES`** (read-only POST contract).

### Feed

New `artifact_event(action: created|updated|deleted, artifact: header)`
builder in `feed.py`; broadcast from the three write handlers via
`session.hub.broadcast(...)` (thread-safe; artifact writes don't touch the
model, so no mutex involvement). Clients refresh their library on it.

### View schema extension (`core/view/schema.py`)

`Folder` gains `artifacts: list[ArtifactRef] = []`,
`ArtifactRef = {id, kind}` — additive; old view blobs parse unchanged.
`validate_view` gains a WARNING for artifact refs whose id is not in the
project's artifact table (checked by the route layer that has DB access, or
surfaced client-side; render simply skips unknowns). No pruning on artifact
delete (see Key decisions).

## 3. Frontend

### Dynamic workspace tabs (`state/workspace.svelte.ts`, `Workspace.svelte`)

- Replace the `'detail'|'graph'|'issues'` union with a descriptor model:
  built-ins fixed + dynamic `{kind: 'navigation', artifactId, title}` tabs
  (later: `table`, `diagram`).
- Closable dynamic triggers; open-tab set + active tab persisted to
  localStorage per project under the existing `ui.*` key pattern.
- Cmd+1/2/3 palette bindings unchanged.

### Sidebar Artifacts section

- New collapsible section in `Sidebar.svelte` between Search and the tree;
  groups by kind (Stage 1: Navigations); rows = kind icon + name.
- Actions: New, Rename, Delete (gated by `canEdit()`), double-click opens the
  builder tab.
- New `state/artifacts.svelte.ts` (accessor convention; reset fn hooked into
  `boot()`/reload) + `api/artifacts.ts` (+ `api/index.ts` export). Library
  refreshes on `artifact` feed events via the `realtime.svelte.ts` reducer.

### Navigation builder (`components/Navigation/`, `state/navigation-editor.svelte.ts`)

- Vertical step editor. Start block: type multi-pick (`StereotypePicker`
  filter mode) + criteria rows (reusing the `CriterionRow` property/op/value
  model — `search/types.ts` criteria are already wire-compatible).
- Hop rows: relationship-type picker filtered by validity from the previous
  step's types (client-side via `metamodel/connection-rules.ts`:
  `relationshipTypesFromSource`, `allowedTargetTypes`); direction toggle;
  target type pick constrained to the mapping's other end; optional criteria.
  Editing a mid-chain step re-filters downstream pickers and invalidates the
  preview.
- Composite editor (set-expression form): operator select + operand list
  (library picks via searchable popover, or the current draft inline);
  nesting via refs to saved composites only (no inline nesting UI in Stage 1).
- Preview panel: explicit **Run**; paged via the `loadFirstPage`/`loadMore`
  pattern against `POST /navigations/evaluate`; chains render as rows of
  element chips (one column per step, headers = step labels); chip click →
  `select({kind:'element', id})`; `truncated` shows a capped-results notice.
- Save / Save-as into the library; 409-on-stale → reload-and-retry toast.

### View-tree artifact placement

- Frontend `FolderSchema` mirrors the `artifacts` field; `view-tree.ts` gains
  an `'artifact'` node kind (icons per kind); `buildUnifiedTree`, DnD
  legality, and `view.svelte.ts` mutators get artifact variants
  (`placeArtifact`, `removeArtifact`).
- Drag source: Artifacts-section rows via the existing `tree-drag.svelte.ts`
  singleton handoff.
- Unknown artifact ids are skipped at render; double-click opens the tab.

## 4. Testing

- **Core** (`tests/navigation/`): schema validation (linear-only children,
  step cap, version); evaluator — directions, subtype-inclusive start/rel
  matching, criteria at start and hops, cycle guard, determinism, caps →
  `truncated`, each set op (incl. left-fold difference, `step_index`),
  nested expressions; new metamodel caches (descendants,
  `relationship_types_from`).
- **API**: `test_artifacts_routes.py` — CRUD lifecycle, 409 rev conflict,
  409 name uniqueness, viewer read/write-403 (allowlist check), unknown-kind
  422, evaluate inline + ref + ref-cycle 422, paging/truncation, feed
  broadcast; `test_content.py` additions; `test_alembic.py` 0008 check;
  search wire-format guard stays green after the criteria lift.
- **Frontend**: vitest — workspace tabs (dynamic + persistence), artifacts
  store (MSW CRUD + feed refresh), navigation editor (step consistency,
  run/paging), view-tree artifact nodes; e2e — create → build 2 hops → run →
  save → drag into view folder → reopen from tree.

## Non-goals (Stage 1)

- Branching evaluation (format ready; evaluator/UI later).
- Inline nesting UI for set expressions (refs to saved composites only).
- Auto-run preview; result export; navigation-as-table (Stage 2).
- Pruning view refs on artifact delete (tolerate + warn).
- New metamodel endpoints (hop validity computed client-side).

## Open items for the implementation plan

- Exact `ArtifactRow.kind` enum listing (include future kinds now vs add per
  stage — suggest adding all four now since it's VARCHAR+CHECK either way).
- Step-label derivation for preview headers (rel type + direction glyph).
- localStorage key names for tab persistence.
- Whether `validate_view` artifact-ref warnings run server-side (needs DB in
  the validation path) or client-side only in Stage 1.
