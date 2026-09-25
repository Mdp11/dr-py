# Metamodel diagram editor — design

**Date:** 2026-08-13
**Backlog:** P-9 (metamodel visualization and UI-assisted editing — supersedes the
Phase 5 "raw-YAML-only" deferral, per the owner's 2026-08-12 notes)
**Status:** approved design, pre-implementation

## Summary

The metamodel tab gains a second view: an **editable UML class diagram** of the
metamodel, alongside the existing raw-YAML editor. Topology is edited on the
canvas (add types, draw `extends` and mappings); attributes are edited in a
selection-bound form panel (properties, facets, keys, enums — full metamodel
coverage, including the `out:`/`in:` key DSL). Both views edit the **same YAML
draft buffer**, so the entire existing lifecycle — localStorage draft, debounced
lint, exclusive `mm` lease on first divergent edit, Preview, owner-gated Rebind —
is shared unchanged. Diagram edits are applied as **comment-preserving surgical
YAML edits**; the author's comments and formatting survive.

Node positions are **shared server-side** (one canonical layout per project), with
a permanent **Auto-arrange** button (elkjs). Layout is presentation: last-write-wins,
no lease, no commit journal entry.

## Decisions (settled during brainstorming)

| Question | Decision |
|---|---|
| Visualization vs forms | One surface: editable diagram for topology + selection-bound form panel for attributes |
| Relationship to YAML tab | One tab, two views (YAML \| Diagram toggle); shared draft/lint/preview/rebind/lease |
| YAML fidelity on UI edits | Comment-preserving surgical edits (`yaml` npm package Document API) |
| Layout persistence | Shared, server-side, one layout per project |
| Coverage | Full — everything in the metamodel is UI-editable, incl. key DSL builder |
| Notation | Strict UML semantics, modern ergonomics (collapsible compartments) |
| Aesthetics | App-native: sage-dark glass nodes, hairline borders, Outfit names, jade/gold accents (mockups in `.superpowers/brainstorm/25414-1786618301/content/`) |
| Core architecture | YAML string stays canonical; parsed `Document` is a companion (approach A) |
| Auto-arrange | Permanent toolbar button, not just first-open |
| Layout concurrency | No `mm` lease, no commit; last-write-wins (owner-approved exception) |

## 1 · Surface & roles

- Segmented **YAML | Diagram** toggle in the metamodel tab toolbar; choice
  persisted per project in localStorage (`ui.metamodel.view.<projectId>`).
- Shared across views: draft buffer, dirty/lease state, lint results, Preview,
  commit message, Rebind, Discard. The existing toolbar is untouched; the toggle
  swaps only the surface below it.
- Diagram layout: Svelte Flow canvas center; **form panel docked right**
  (Inspector grammar); canvas toolbar (Auto-arrange, fit view, collapse/expand
  all, search-to-focus, + Element type, + Enum).
- Roles (corrected 2026-08-13 against the code: buffer editing is
  **owner-only** today — `metamodel-editor.svelte.ts`'s `isEditBlocked()`
  checks `getRole() !== 'owner'`): **owner** edits (first divergent edit
  acquires the exclusive `mm` lease, as today) and rebinds. **Editors and
  viewers** get the read-only canvas + read-only forms, no lease, no lint
  calls. Exception: **layout saves** (`PUT /metamodel/layout`) are editors+ —
  presentation, not content (§5).

## 2 · Canvas rendering (strict UML, app-native)

- **Element type** → class card: Outfit name header; collapsible attribute
  compartment (property-count chip when collapsed; collapse state personal, in
  localStorage). Abstract → italic name + dashed border. Attributes:
  `name: type [mult]`, `{id}` in gold for key properties, compact facet chips.
- **`extends`** → solid edge, hollow triangle marker (generalization).
- **Mapping** → association line: name label, open arrowhead toward target, end
  multiplicities. **Containment** → filled diamond at the source end. A
  relationship type with N mappings renders N same-named lines; selecting any
  line selects the type and highlights all its lines.
- **Association class** — a relationship type with properties or in an `extends`
  hierarchy gets a small class box tethered to its line(s) by a dashed edge;
  generalization triangles between relationship types connect these boxes. An
  abstract relationship type with no mappings renders as a floating italic box.
- **Enum** → `«enumeration»` card, gold accent, literals listed, collapsible.
- **Element-typed properties** render as attributes only — no extra edge per
  reference (UML permits either; this keeps edge count sane).
- Implementation: three custom Svelte Flow node types (element, enum,
  association-class) + two custom edge types (generalization, association).
  `@xyflow/svelte` is already a dependency.

## 3 · Interaction & editing

- **Selection** → form panel binds to the selected node/line/box. Deselected →
  metamodel-level panel (enum list, orphaned abstract relationship types, counts,
  creation entry points for undrawable things).
- **Create**: toolbar buttons for element types and enums (node lands near
  viewport center, name focused). **Drawing a connection** between two element
  nodes opens a popover with the three meanings a drawn edge can have: new
  relationship type (name + containment), add mapping to an existing compatible
  relationship type, or set `extends` (offered only when acyclic).
- **Edit** in the form panel: name, abstract, extends, containment, end
  multiplicities, property list (add/remove/reorder; datatype picker over
  primitives ∪ enums ∪ element types; multiplicity; min/max/pattern/max_length),
  enum literals, and the key builder — plain property entries plus `out:`/`in:`
  DSL rows (direction + relationship-type picker).
- **Rename** cascades through every in-draft reference: `extends` pointers,
  mapping endpoints, element-typed property datatypes, key DSL entries. Passive
  reminder in the form: rebind treats rename as remove+add for instance data
  (existing differ semantics; Preview shows it).
- **Delete** → confirmation popover listing consequences. Auto-fixed: mappings
  involving the type removed, `extends` pointers to it cleared. Deliberately not
  auto-fixed (left for lint to flag, same contract as hand-deleting the YAML
  block): element-typed properties, key entries naming a deleted relationship.
- **Undo**: YAML view keeps CodeMirror history. Diagram view keeps a bounded
  undo stack of buffer snapshots (metamodel is tens of KB; snapshots are cheap).
  Ctrl+Z pops one; it arrives in the YAML view as an external replace.

## 4 · YAML writeback — `frontend/src/lib/metamodel/yaml-edit.ts`

New pure module on the `yaml` npm package's Document API (new runtime
dependency; round-trips comments and formatting):

- `parseDraft(buffer)` → `{ doc: Document, mm: Metamodel, errors }` — `mm` is
  the existing zod `Metamodel` shape (`api/types.ts`) for rendering.
- `applyEdit(doc, command)` — one handler per semantic command (`renameType`,
  `setAbstract`, `setExtends`, `addProperty`, `updateProperty`, `removeProperty`,
  `setFacet`, `setKey`, `addMapping`, `removeMapping`, `setContainment`,
  `setEndMultiplicity`, `addType`, `removeType`, `addEnum`, `renameEnum`,
  `setEnumLiterals`, `removeEnum`, …) mutating only the touched YAML nodes.
- `doc.toString()` → written into the shared buffer through the existing
  `setBuffer` path. Dirty flag, lease acquisition, localStorage draft, and
  debounced lint all trigger automatically — **no lifecycle code changes**; the
  diagram is just another producer of buffer text.
- Parse runs on view switch and (debounced ~500 ms, alongside lint) while the
  Diagram view is visible. Unparseable buffer → canvas replaced by a
  "draft has syntax errors — fix in YAML" state with a jump button; the last
  good canvas is never silently shown.
- Lint-error attribution: the Document knows each type block's line range, so a
  lint error's line maps to its enclosing type → red badge on that node;
  unmappable errors → toolbar badge.

## 5 · Layout, Auto-arrange, backend

- **Auto-arrange**: permanent toolbar button running **elkjs** (`layered`
  algorithm; new runtime dependency, client-side only). First open with no
  stored layout runs it automatically; afterwards stored positions win and the
  button re-runs on demand. Re-arrange participates in the diagram undo stack
  (it is destructive to hand-tuning).
- **Storage**: new table `metamodel_layouts` — `project_id` (PK, FK → projects,
  ON DELETE CASCADE), `blob` JSON, `updated_at`. Alembic migration `0010`.
- **Routes** (project prefix): `GET /metamodel/layout` (any member),
  `PUT /metamodel/layout` (write → editors+; viewers 403 via existing
  method-based authz). Last-write-wins; **no lease** — layout is presentation,
  not content (owner-approved). No feed events; peers pick positions up on open.
- **Blob**: `{ "positions": { "el:<name>": {"x","y"}, "enum:<name>": …,
  "rel:<name>": … } }` — kind-prefixed **name** keys (the metamodel's only
  identity). Collapse state and viewport stay personal (localStorage).
- Saves debounced after drag/auto-arrange; viewers never PUT.
- Unpositioned nodes (peer added a type you haven't seen; type added by a YAML
  edit) get free-area placement near their nearest connected node — never a
  full implicit re-layout.
- **Rename wrinkle**: a draft rename must NOT rewrite the shared layout key
  immediately — peers' canvases still render baseline names, and the draft may
  be discarded. The renamer's client maps old-key positions onto renamed nodes
  locally while the draft lives; the key rewrite is PUT only after a successful
  Rebind.

## 6 · Locking, commit, validation semantics

- **Content edits** (either view): exclusive `mm` lease on first divergent edit;
  the change lands as a journaled commit at Rebind (new `MetamodelRow`,
  `Commit` row with `from_metamodel_id`/`to_metamodel_id`, `model_rev` bump,
  feed rebind event). All existing behavior, inherited by construction.
- **Layout edits**: no lease, no commit, last-write-wins (see §5).
- **Validation**: metamodel well-formedness after every edit via the existing
  debounced `POST /metamodel/lint` (both views, same buffer). Instance-impact
  validation only on explicit Preview (`POST /metamodel/diff`) and at Rebind —
  per the repo rule that full O(model) validation never runs on a non-explicit
  path.

## 7 · Testing

- **`yaml-edit.ts`** carries the densest suite: every command against fixture
  YAML, plus comment/format-preservation assertions (edit one type; every other
  line byte-identical). This module is the correctness core.
- Component tests (vitest + happy-dom): selection→form binding, connection
  popover flows, delete-cascade confirmation, rename cascade, syntax-error
  fallback, viewer read-only rendering, view-toggle persistence.
- Backend (`tests/api/`): layout route matrix (member/viewer/403, unknown
  project 404, upsert, delete-cascade with project).
- e2e: folds into the existing T-7 gap; not a blocker for this feature.

## 8 · Non-goals

- No live sync of peer canvas activity (no feed events for layout).
- One layout per project — no named/multiple diagrams (adjacent to P-8, kept
  separate).
- No instance-level (model) diagrams — that is P-7.
- No image/SVG export of the canvas.
- No comment authoring from the Diagram view — comments remain a YAML-view
  concern; the Diagram only preserves them.
