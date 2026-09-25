# Artefacts Phase 3 — frontend import/export UI (design)

Date: 2026-08-09
Status: approved (brainstormed with the user this session)
Backend contract: `CLAUDE.md` "Import/export (artefacts revamp Phase 3)" bullet;
routes in `src/data_rover/api/routes/artifact_bundle.py`; wire types in
`src/data_rover/api/artifact_bundle.py`. The backend contract is FROZEN — this
slice builds to it. The single sanctioned backend change is the
`ProjectOut.skipped_artifacts` addition (§5).

## Goal

A user can export a chosen set of artifacts to a downloaded
`datarover.artifact-bundle/v1` file, import a bundle back with per-artifact
create/reuse/copy decisions, and supply a bundle when creating a project via
the New Project wizard — with skipped artifacts made visible everywhere.

Out of scope (standing user declines — do not revisit): placing imported
artifacts in the view; stateful/staged import; bundle folder placements;
Phase 4 (metamodel lease + structural metamodel diff).

## 1. Toolbar & entry points

- `TopBar.svelte`'s left cluster (logo + info icon) gains a **toolbar region**:
  a vertical divider after the info icon, then a `<nav aria-label="Toolbar">`
  flex container intended to accumulate feature buttons over time. This slice
  adds exactly one occupant.
- **`components/ArtifactsMenu.svelte`** — a ghost button (package icon,
  "Artifacts", chevron) opening a shadcn `DropdownMenu`:
  - **Export…** — always rendered (viewer-allowed route).
  - **Import…** — rendered only when `canEdit()` (hide-not-disable, the
    `ArtifactsSection` convention). Planning is part of the write flow;
    a viewer must see no import affordance.
- Both dialogs are mounted once inside `ArtifactsMenu`, but their open state
  lives in `lib/state/ui` (the `setDiffDrawerOpen` pattern):
  `openExportArtifacts(seedRootIds?: string[])` and `openImportArtifacts()` —
  because three surfaces share them (menu, command palette, workspace tab
  button). Dialog *contents* stay component-local.
- CommandPalette registers "Export artifacts…" and "Import artifacts…"
  (import gated on `canEdit()` the same way), opening the same dialogs.
- **Workspace tab export button**: when the active dynamic tab is a SAVED
  artifact (`tab.artifactId !== null` and not a temp id), the workspace tab
  strip renders a small icon button at its right end ("Export {title}…",
  viewer-allowed) calling `openExportArtifacts([tab.artifactId])` — the
  export dialog opens with that artifact pre-checked as the root, closure
  preview and all. One implementation point in `Workspace.svelte` covers
  navigation, table and snippet tabs; drafts and temp-id staged creates show
  no button (no server row to export).

## 2. API client — `lib/api/artifact-bundle.ts`

Sibling of the read-only `lib/api/artifacts.ts`. Zod schemas mirroring the
Python wire types: `ArtifactBundle` (format literal
`datarover.artifact-bundle/v1`, `source_project {id, name}`, `exported_at`,
`roots`, `artifacts[{id, kind, name, payload}]`), `ExportPreviewResponse`
(`artifacts[{id, kind, name}]`, `dangling_refs`), `ImportPlan`
(`entries[PlanEntry]`, `skipped[SkippedEntry]`), `PlanEntry` (`bundle_id`,
`kind`, `name`, `action: create|reuse|copy`, `existing_id?`, `copy_name?`),
`SkippedEntry` (`bundle_id`, `reason`), `ImportConfirmResponse` (`rev: number
| null`, `created[{bundle_id, id, name}]`, `reused[{bundle_id, existing_id}]`,
`skipped`).

Functions (all through `apiFetchRaw`-based client, project-scoped base URL):

- `exportPreview(rootIds: string[]): Promise<ExportPreviewResponse>` —
  `POST /artifacts/export/preview`.
- `exportBundle(rootIds: string[]): Promise<Response>` —
  `POST /artifacts/export`; returns the raw `Response` for
  `saveResponseToFile` (filename from Content-Disposition, fallback
  `artifacts.bundle.json`). The server re-derives the closure from roots.
- `importPlan(bundle: ArtifactBundle): Promise<ImportPlan>` —
  `POST /artifacts/import/plan`.
- `importConfirm({bundle, decisions, copyNames, message}): Promise<ImportConfirmResponse>`
  — `POST /artifacts/import`.

**409 discrimination** (importConfirm): a 409 body carrying `plan` is thrown
as a typed `StalePlanImportError { detail, plan }` (client MUST re-render from
`body.plan`, never the submitted plan); a `create_commit`-shaped 409
(`{detail, model_rev}`, no `plan`) is thrown as a plain conflict error. Both
are distinguishable by the caller without string matching.

Bundle files are parsed client-side with the zod `ArtifactBundle` schema at
file-pick time, so a malformed file fails in the dialog rather than as a
server 422.

## 3. Export dialog — `ExportArtifactsDialog.svelte`

Component-local state; no global store.

- **Source rows**: `getCommittedArtifactHeaders()` — committed truth only.
  Temp-id staged creates are excluded (a temp root would 404 the closure).
  When `getStagedArtifactDepth() > 0`, show a muted note: "uncommitted
  artifact changes are not exported".
- **Selection UI**: rows grouped under the sidebar's three kind sections
  (Navigations / Tables / Snippets, same icons). Checkbox per row,
  per-section select-all, global Select all.
- **Name filter**: a search input at the top of the list (autofocused,
  "Filter artifacts…") narrows the visible rows by case-insensitive substring
  match on name, across all sections (a section with no match collapses).
  Selection state PERSISTS for filtered-out rows — the footer count reflects
  the true selection, and when checked rows are hidden by the filter a muted
  "+N selected not shown" hint appears. Client-side only: all committed
  headers are already loaded, so no server fuzzy call (unlike element search).
- **Seeded open**: `openExportArtifacts(seedRootIds)` pre-checks the given
  ids (ignoring any that are not committed headers) and triggers the first
  preview immediately.
- **Live closure preview**: every selection change schedules a debounced
  (300 ms) generation-guarded `exportPreview(checkedIds)` call. Render:
  - checked rows: normal;
  - rows in the preview closure but NOT checked: "dependency" badge,
    included-but-disabled checkbox styling;
  - `dangling_refs`: warning line ("⚠ N dangling reference(s) — these ids are
    referenced but not part of this project; they export as-is").
- **Footer**: "N artifacts · ⚠ M dangling refs" summary; Cancel;
  **Export bundle** — disabled while the selection is empty. Export posts the
  **checked roots only** and pipes the response through `saveResponseToFile`;
  dialog closes on success. A user-aborted file save (AbortError) is silent.
- Errors: inline alert inside the dialog; the dialog stays open.

## 4. Import dialog — `ImportArtifactsDialog.svelte`

Three phases in one dialog, component-local.

**Pick** — file input + drop zone (`.json`). Parse with the zod
`ArtifactBundle` schema; malformed / wrong-format shows an inline error. On
success: `importPlan(bundle)` → review phase.

**Review** —
- Header: bundle filename, "from *{source_project.name}*", `exported_at`.
- Plan table, one row per `PlanEntry`: kind icon, name, action `Select`
  restricted to the row's **legal set** (matrix proven against
  `build_import_ops`):
  - plan `create` → Create (default) | Copy;
  - plan `reuse` → Reuse existing (default) | Copy;
  - plan `copy`  → Copy (default) | Reuse existing.
  Create is never offered on a clash row (server raises `StalePlanError`);
  Reuse is never offered without an `existing_id`.
- Copy rows reveal an inline name input pre-filled `copy_name ?? name`. The
  value is sent in `copy_names[bundle_id]` **only when user-edited**; an
  untouched proposal is omitted so the server's dedupe stays authoritative.
- Row hints: reuse → "identical already exists"; copy → "differs from
  existing".
- `skipped` entries listed below with `reason`, excluded from counts.
- Footer: optional commit-message input (placeholder mirrors the server
  default "Imported N artifacts from {source}"), summary
  ("X to create, Y to reuse, Z skipped"), Cancel, **Import (N)** where
  N = create+copy count. All-reuse plans keep Import enabled (a reuse-only
  confirm is a legitimate no-op).

**Result** — on 200: created (final names), reused, skipped lists.
`rev: null` renders "Nothing to import — everything already exists" as a
SUCCESS state. On any success fire `loadArtifacts()` (deterministic library
refresh; the feed echo also arrives but is not relied on). Close button.

**Conflict handling** —
- `StalePlanImportError`: re-enter review rendering the **fresh plan from the
  error body**, warning banner with `detail`. Prior decisions re-seed per
  `bundle_id` where still legal for the fresh entry, else drop to the fresh
  default. Copy-name edits re-seed the same way (only onto rows still
  offering Copy).
- Plain conflict 409 (no plan): re-run `importPlan(bundle)` from the held
  bundle, re-enter review with a "project changed concurrently" banner.
- Neither path retries automatically; the dialog stays open.

**No clean-buffer gate**: unlike History revert, import only creates
fresh-id rows, so staged work is unaffected. The one edge — a staged create
whose (kind, name) collides with an imported name — surfaces at the user's own
later commit as the same recoverable 422 a peer could cause; rename-and-retry.

## 5. Wizard slot + skip-list gap (the one backend change)

- **Backend**: `routes/projects.py`'s `ProjectOut` gains
  `skipped_artifacts: list[SkippedArtifactOut] = []`
  (`{bundle_id, reason}` — mirrors the importer's `SkippedEntry`). Only the
  create route populates it, from `import_project`'s hitherto-discarded return
  value; list/get/clone keep the empty default.
- **Frontend**: `NewProjectWizard` gains a fourth optional `FileSlot`
  "Artifacts bundle (optional)" → multipart part `artifacts`.
  `createProject` in `lib/api/projects.ts` accepts the file and its response
  schema gains `skipped_artifacts`. If non-empty after creation, the wizard
  shows a non-blocking warning list ("N artifacts were skipped:" + per-entry
  reason) — the project is still created and entered as today.
- A 422 from a malformed bundle envelope surfaces as the wizard's existing
  per-slot error path (backend already avoids orphan projects).

## 6. Error handling & testing

- Network/5xx in either dialog: inline alert, retriable, no global notice.
- **Vitest** (happy-dom + MSW, existing conventions):
  - api client: schema round-trips; both 409 shapes throw distinct types.
  - Export dialog: debounce fires one preview per settle; dependency badges;
    dangling-ref warning; export posts checked roots only; empty selection
    disables Export.
  - Import dialog: per-row legal action sets; copy-name only-when-edited
    rule; stale-plan 409 re-renders from `body.plan` (never the stale one);
    plain 409 re-plans from the held bundle; `rev: null` renders the success
    copy; skipped list rendering.
  - ArtifactsMenu: viewer sees Export only.
  - Export dialog filter: narrows rows, selection persists when hidden,
    "+N selected not shown" hint.
  - Workspace tab button: rendered only for a saved-artifact active tab
    (absent for drafts/temp ids), opens the export dialog pre-checked.
  - Wizard: artifacts part sent; skipped warning rendered.
- **Pytest**: create-project response carries `skipped_artifacts` (populated
  on a bundle with a skippable artifact; `[]` on list/get/clone).
- Gates: `pixi run core-test`; `pixi run frontend-test`;
  `cd frontend && pixi run -e frontend npm run lint` and `npm run check`.

## Process

Branch `feature/artefacts-phase-3-frontend` off `main`; plan via
`superpowers:writing-plans`; execute with
`superpowers:subagent-driven-development` (fresh implementer per task, review
per task); final whole-branch review on the most capable model; ONE fix wave;
merge `--no-ff` to local `main`; delete branch. Push only if asked.
