# Top bar restructure (P-10) + Issues panel filter (U-1) — design

**Date:** 2026-08-18
**Status:** approved by owner (this conversation), pending implementation plan
**Backlog items:** P-10.1, P-10.2, P-10.3, P-10.4, P-10.5, U-1
**Branch:** one feature branch; all five moves land together as a single wave.

## 1. Goal

Main sections move to the top bar and all editing lives inside workspace tabs,
so element browsing and search stay usable while an artifact is being edited.
Concretely: delete the Detail and Graph fixed tabs, turn Issues into a closable
top-bar-opened tab (gaining a per-validator filter, U-1), empty the three-dots
menu into first-class top-bar controls, delete the command palette, and move
the per-artifact bundle-export button from the tab strip into each editor's own
toolbar row.

## 2. Decisions made with the owner

1. **Empty workspace state**: with zero tabs open the workspace renders a quiet
   centered placeholder ("Open an artifact from the sidebar, or Issues from the
   top bar"). Closing the active tab focuses the nearest remaining tab; with
   none left, the placeholder shows. No auto-opened tab.
2. **U-1 filter axis**: validator identity. This adds a small backend field
   (`check` on core `Issue`, threaded through `IssueOut`) rather than filtering
   only on what the wire already carries.
3. **Top bar layout**: all menu items become flat first-class icon+text
   controls styled like the existing Artifacts button. No grouping menus, no
   icon-only compromise.
4. **Keyboard shortcuts**: only Cmd+S (commit drawer) and Cmd+E (validate)
   survive. Cmd+K dies with the palette; Cmd+1/2/3 die with the fixed tabs. No
   new binding for Issues.

## 3. Workspace tab model (P-10.1 + P-10.2)

### Deletions

- `frontend/src/lib/components/Workspace/DetailView.svelte`
- `frontend/src/lib/components/Workspace/GraphView.svelte`
- `frontend/src/lib/components/Workspace/graph-data.ts` + `graph-data.test.ts`
- The three fixed `Tabs.Trigger`/`Tabs.Content` pairs in `Workspace.svelte`.

### `state/workspace.svelte.ts`

- `BUILTIN_TABS` is deleted. `WorkspaceTab` stays `string`.
- `_activeTab` becomes `string | null`, default `null`. `getActiveTab()` /
  `setActiveTab()` signatures widen accordingly; `null` means "no tab open".
- `DynamicTab['kind']` gains `'issues'`. Issues is a **singleton** tab exactly
  like the metamodel tab: fixed id `issues:panel`, `artifactId: null`, title
  "Issues", opened/focused via a new `openIssuesTab()` mirroring
  `openMetamodelTab()` (dedupe by kind). It is persistable (cheap to restore;
  no draft state of its own).
- `closeTab(id)`: when the closed tab was active, focus the **previous tab in
  strip order** (index − 1, else index 0 of what remains); with no tabs left,
  `_activeTab = null`.
- localStorage restore (`initWorkspaceTabs`): a stored `active` that no longer
  resolves — including the legacy `'detail'`/`'graph'`/`'issues'` literals —
  falls back to `null`, not `'detail'`. Same for every internal `'detail'`
  fallback in the module (reset, error paths).

### `Workspace.svelte`

- Tab strip renders only `dynamicTabs`. The Issues tab gets a close arm in the
  per-kind close dispatch (a plain `closeTab` — no editor/lease teardown).
- When `activeTab` is `null` (or resolves to no tab), render the placeholder
  pane instead of `Tabs.Content`.
- The `tab-export` button leaves the strip entirely (see §6).

### Call-site ripples

- `state/validate-action.ts:24`: `setActiveTab('issues')` → `openIssuesTab()`.
- `lib/keyboard.ts`: delete the `tab` and `palette` action kinds and their
  matchers (Cmd+K, Cmd+1/2/3). `keyboard.svelte.ts` drops the corresponding
  switch arms. Cmd+S / Cmd+E unchanged.
- Any other `setActiveTab('detail' | 'graph' | 'issues')` call sites found
  during implementation follow the same rule: detail/graph callers are deleted
  with their feature; issues callers become `openIssuesTab()`.

## 4. Top bar (P-10.3)

The left `nav` in `TopBar.svelte` grows from just **Artifacts** to a flat row,
in this order:

**Artifacts · Issues · Compare · Apply CR · Edit Metamodel · Export · History · Settings**

- Each control is styled like the `ArtifactsMenu` trigger: `h-7`, icon +
  `text-xs` label, ghost hover. Artifacts keeps its dropdown; every other
  control is a plain button (or link, for Compare which navigates to
  `/p/{id}/compare`).
- Actions are the existing ones, relocated verbatim:
  - Issues → `openIssuesTab()`
  - Compare → link to the compare route
  - Apply CR → `applyCrOpen = true`
  - Edit Metamodel → `openMetamodelTab()`, disabled when `metamodel === null`
  - Export → existing `onExport()` (model download), disabled when
    `summary === null`
  - History → `setHistoryDrawerOpen(true)`
  - Settings → `settingsOpen = true`
- Icon suggestions (bikesheddable at implementation): `ListChecks` (Issues),
  `GitCompareArrows` (Compare), `FileInput` (Apply CR), `Shapes` (Edit
  Metamodel), `Download` (Export), `History`, `Settings`.
- **Deleted**: the `Ellipsis` dropdown menu and the `⌘K` kbd hint.
- **Unchanged**, far right, same order: validation status chip, Undo,
  Validate, Commit, Strict badge, changes counter.

## 5. Command palette deletion (P-10.4)

- Delete `CommandPalette.svelte`, `__tests__/CommandPalette.test.ts`, the
  `commandPaletteOpen` state in `ui.svelte.ts`, the mount in
  `routes/+layout.svelte`, and the `state/index.ts` exports.
- **Also delete the `artifactDialogsHosted` flag machinery** in
  `ui.svelte.ts`: the palette is its only reader. `ArtifactsMenu.svelte` drops
  its `setArtifactDialogsHosted` set/clear calls (its INIT-time clearing of the
  export/import open flags stays — that guards project re-entry, not the
  palette).
- Trigger audit (verified during design): every palette `action:*` has a
  surviving trigger — Save → Commit button + Cmd+S; Validate → button + Cmd+E;
  Undo → button; export/import artifacts → Artifacts menu; edit-metamodel →
  new top-bar control; reload → browser refresh; entity search → sidebar
  search. Tab actions die with their tabs. Nothing becomes unreachable.

## 6. Per-artifact export button (P-10.5)

- New shared component `ArtifactExportButton.svelte` (props: `artifactId`,
  `title`), rendering the existing `FileUp` icon button
  (`data-testid="tab-export"` moves with it) and calling
  `openExportArtifacts([artifactId])`. Rendered only when the id is non-null
  and not a temp id — same predicate the tab strip uses today.
- Placed in the toolbar/button row of each artifact-backed editor:
  `Table/TableView.svelte`, `Snippet/SnippetTab.svelte`,
  `Navigation/NavigationBuilder.svelte`, `Export/CustomExportTab.svelte`. The
  metamodel tab gets none (not artifact-backed).
- The tab-strip instance in `Workspace.svelte` is removed.

## 7. U-1: validator identity on the wire + panel filter

### Backend

- `core/validation/issue.py`: `Issue` gains `check: str = ""` — the producing
  validator's stable name. Each validator stamps its own:
  `type_conformance`, `multiplicity`, `facets`, `endpoint_typing`,
  `containment`, `uniqueness` (exact strings = the validator module names).
  Non-validator issue producers (e.g. structural commit-gate call sites inside
  appliers) keep the `""` default; the panel renders those under an "Other"
  chip.
- `api/schemas.py`: `IssueOut.check: str = ""`, populated by `from_core`.
  Additive and defaulted, so previously persisted `Commit.issues` JSON rows
  still parse.

### Frontend

- `api/types.ts`: `IssueSchema` gains `check: z.string().default('')`.
- `IssuesPanel.svelte`: a row of per-check count chips across the top
  (label + count), clickable as a filter, with an "All" chip. The check filter
  **composes** with the existing origin filter (both applied). Client-side
  view warnings are given `check: 'view'` where they are built so they filter
  like everything else. Chip labels are human-readable mappings of the check
  ids (single mapping table in the panel or a small util).
- The existing errors/warnings header summary and section layout stay; counts
  remain scoped to the filtered list as today.

## 8. Testing

TDD per task. New/updated coverage:

- **workspace state**: `openIssuesTab` singleton dedupe; `closeTab` focuses
  the previous tab; last-close yields `null`; restore of a legacy
  `'detail'`/`'graph'` active falls back to `null`; issues tab persists.
- **Workspace.svelte**: placeholder renders at zero tabs; issues tab opens,
  closes, renders `IssuesPanel`.
- **TopBar**: all eight left controls present with correct disabled states;
  three-dots menu and ⌘K hint gone.
- **keyboard**: Cmd+S/Cmd+E still fire; Cmd+K and Cmd+1/2/3 no longer match.
- **ArtifactExportButton**: renders per editor for a committed artifact,
  hidden for temp/draft; tab-strip button gone.
- **backend**: each validator's issues carry the expected `check`;
  `IssueOut` round-trips it; old issue JSON without `check` still parses.
- **IssuesPanel**: chip counts, chip filter, composition with origin filter.
- Deleted features take their tests with them: `CommandPalette.test.ts`,
  `graph-data.test.ts`, keyboard tab/palette cases.
- Gate: `pixi run dr-tidy` + `pixi run dr-test` clean at the end.

## 9. Out of scope

- Any change to the right side of the top bar (validation chip, Undo,
  Validate, Commit, Strict, changes counter).
- U-9 (commit panel overflow) — same DiffDrawer file family, separate item.
- P-19/P-20 (sidebar collapse / staging area) — separate wave.
- e2e coverage (tracked as T-7; unchanged by this wave).
- Server-side `issue_counts` keying (stays as is; the panel derives chip
  counts client-side from the issue list it already holds).
