# Artefacts Phase 2 — Frontend Rewire (view ops through commits) — Design

Date: 2026-08-07. Parent spec: `2026-07-29-artefacts-revamp-design.md` (§Phase 2, lines 71-77).
Backend counterpart: merged at `main@bbf53e6` (`docs/superpowers/plans/2026-08-07-artefacts-phase-2-view-backend.md`).
Structural precedent: `docs/superpowers/plans/2026-08-06-artefacts-phase-1-frontend-rewire.md`.

## Mission

Move the SvelteKit client's view editing off the whole-document `PUT /view/snapshot` and onto
the lock→edit→commit flow: folder mutations emit `view.*` ops into a staged buffer, `folder:`
leases are acquired fail-fast at the gesture, and `POST /commits` lands model + artifact + view
changes atomically. Frontend only — the backend is done and fixed; any backend change is a
scope change to surface, not make.

## Decisions (settled in brainstorming; do not re-litigate without the user)

1. **Stage everything.** Every view gesture (folder create/rename/move/delete, element/artifact
   placement) stages a `view.*` op and updates the local `_view` optimistically. Nothing reaches
   the server until the DiffDrawer commit — the same mental model as Phase 1 artifacts (Save =
   stage, commit = DiffDrawer) and the element flow. The sidebar is dirty-until-commit; staged
   view edits are lost on reload (same as staged model ops).
2. **Lease timing: drop-time + dialog-open.** DnD acquires ONE all-or-nothing lease set covering
   exactly the folders the op needs at DROP time — grant ⇒ stage; 409 ⇒ toast "locked by X",
   stage nothing. No lease is held during the drag; a cancelled drag needs no cleanup. Dialog
   edits (rename, new folder, delete confirm) acquire when the dialog opens, so denial arrives
   before the user types — mirroring artifact editors' lease-on-open. Granted leases are held
   until commit/discard.
3. **Clear view = staged delete-all batch.** ViewSelector's Clear stages deletion of every
   top-level folder + removal of every root artifact ref (one all-or-nothing subtree lease
   acquire). `DELETE /view` loses its last frontend caller. The empty view renders identically
   to no-view (all elements unplaced).
4. **The two Phase 1 denied-tab gaps are fixed here.** A lock-denied artifact editor tab becomes
   read-only (disabled inputs, holder banner) and offers "Save as copy" (existing save-as fork →
   staged create; a temp id needs no lease). Denied folder gestures have no such gap by
   construction (nothing stages), and a denied rename dialog is read-only with the same banner.
5. **Buffer shape: ordered op journal + optimistic local view** (chosen over baseline-diffing —
   which would resurrect the name-path diffing folder ids were built to kill — and over a
   command-pattern with client-computed inverses, rejected as YAGNI). View ops are
   order-dependent (create folder → place into it → move it), so the buffer is an ordered
   journal like the model store's queued ops, NOT a coalescing per-id map like the artifact
   buffer. Consequence: **no per-gesture selective revert** — the DiffDrawer's View section
   discards all-or-nothing.
6. **Post-commit reconciliation is a refetch, not a remap.** After any commit (ours or a
   peer's) whose scope includes `"view"`, the store refetches `GET /view` once — server truth,
   temp folder ids concretized. No client-side `id_map` application to `_view`.
7. **Artifact delete scrubs placements in-batch.** Staging an artifact DELETE also acquires
   leases on every folder holding it and stages the matching `remove_artifact` ops in the same
   batch. A peer's folder lock therefore blocks deleting an artifact placed there — correct,
   since the delete edits that folder's contents; the all-or-nothing acquire fails predictably
   with the holder's name. The commit-time `onArtifactCommit` scrub (`scrubArtifactFromView`)
   is deleted.
8. **No per-op OCC precondition** (`view_rev` is never sent) — the lease is the concurrency
   control, exactly as `UpdateArtifactOp.artifact_rev` is never sent (Phase 1 Decision 3).
9. **Never send an empty commit** (Phase 1 Decision 6) — the backend's empty-batch early return
   orphans sent lock tokens until TTL.
10. **Folder tokens are always sent at commit** — the element rule ("commit ends the editing
    session"), not the artifact keep-open rule: folders have no long-lived editor surface, only
    transient dialogs. Only artifact tokens with open editors survive a commit.

## Fixed wire contract (backend, merged — mirror exactly, rename nothing)

Ops (`api/schemas.py`): `create_folder {temp_id, parent_id, name, index?}`,
`rename_folder {id, name}`, `move_folder {id, to_parent_id, index?}`, `delete_folder {id}`,
`place_element {element_id, folder_id, index?}`, `remove_element {element_id, folder_id}`,
`move_element {element_id, from_folder_id, to_folder_id, index?}`,
`place_artifact {artifact_id, artifact_kind, folder_id, index?}`,
`remove_artifact {artifact_id, folder_id}`,
`move_artifact {artifact_id, from_folder_id, to_folder_id, index?}`.
Lock target `type: "folder"` (bare folder id in the request; granted leases come back
canonicalized `folder:<id>`); root membership = `folder:root`; commit scope string `"view"`.
Element placements never target the root (`VIEW_ROOT_ID = "root"`): "move to root" is
`remove_element`; placing an element at root 422s. Artifacts have a real root list.
Backend lock derivation (`locking.py::required_locks`): create_folder → EXCLUSIVE CREATE_CHILD
on parent; rename → EXCLUSIVE EDIT on the folder; move_folder → EXCLUSIVE EDIT on the source's
CURRENT container + the destination parent; delete_folder → EXCLUSIVE DELETE over the whole
subtree; place/remove element|artifact → EXCLUSIVE EDIT on the containing folder; moves →
EXCLUSIVE EDIT on both endpoints. Folder temp ids flow into the commit's shared `id_map`
(`api/view_ops.py`). `index` is carried but sibling-FOLDER order is not user-controlled (tree
renders folders alphabetically); element order inside a folder IS user-meaningful — send what
the user did.

## Architecture

### 1. Wire layer (`ops.ts`, `types.ts`)

- `ops.ts`: ten-op `ViewOp` union mirroring the contract above; `Op = ModelOp | ArtifactOp |
  ViewOp`; `FOLDER_RESOURCE_PREFIX = 'folder:'`, `folderResource(id)`, `isFolderResource(rid)`,
  `VIEW_ROOT_ID = 'root'` — beside the existing `art:` helpers.
- `types.ts`: `Folder` gains required `id: string` (the server heals ids on every read, so it is
  always present; locally-staged folders carry `tmp_` ids). `LockTargetIn.type` gains
  `'folder'`. Zod const ordering (TDZ) respected when blocks move.

### 2. Staged view buffer (`lib/state/view-edits.svelte.ts`, new)

Ordered journal of `{op: ViewOp, label: string}` — `label` is the human-readable review-row
summary captured AT STAGE TIME (after local apply, the prior name is gone and ids alone cannot
render "Renamed folder \"A\" → \"B\""). Surface: `stageViewOp(op, label)`,
`getStagedViewOps()`, `getStagedViewEntries()`, `getStagedViewDepth()`, `clearStagedView()`
(commit-success path, silent), `discardStagedView()` (user-discard path). No listener
registries and no per-entry revert (Decision 5). Barrel-exported via `lib/state/index.ts`.

### 3. View store rewrite (`view.svelte.ts`, `view-ops.ts`)

- Every mutator becomes: `ensureCheckout(targets, intent)` → on grant, apply the op to `_view`
  via pure helpers → `stageViewOp`; on conflict, toast the holder and change nothing.
- `view-ops.ts` helpers move from name-path to folder-id addressing (`findFolderById`,
  `folderSubtreeIds`, id-based ancestor/cycle check, id-addressed place/move/remove appliers).
- Retired: `pushView`, `_baseline`, `setViewBaseline`, `getViewChanges`/`getViewChangesCount`,
  all of `view-diff.ts`, `view-change-format.ts` (superseded by stage-time labels), and the
  `putViewSnapshot` API wrapper (deleted grep-clean; `GET /view` stays).
- `refreshView` keeps `GET /view` for boot; a new commit-tap subscription refetches once after
  any commit whose `scope` includes `"view"` (ours lands via `commitStaged` success; peers via
  the realtime tap). Refetch failure tolerated: stale tree until the next event.
- `dropView` → `stageClearView()` per Decision 3.
- `artifacts.svelte.ts`: the `onArtifactCommit` scrub call is deleted; the sidebar's artifact
  delete surface acquires folder leases + stages `remove_artifact` ops per Decision 7.

### 4. Tree + DnD re-keying (`view-tree.ts`, `ContainmentTree.svelte`, `TreeRow.svelte`)

- Folder node keys become id-based (`folderKey(id)`); `folderPathFromKey` and friends retire in
  favor of id lookups; the DnD folder payload carries the folder id; `resolveElementDrop` /
  drop targets resolve to folder ids; the "Move to folder…" picker lists `{id, label}`.
- The drop handler keeps the capture-payload → `endGesture()` → await-mutator ordering (the
  known trap at `ContainmentTree.svelte:1162`); mutators now lease+stage instead of PUT.
- Peer `folder:` leases from realtime `_lockState` render as lock badges on folder rows (same
  idiom as element badges).
- Duplicate-sibling-name skip logic in `ingestFolder` remains (server enforces uniqueness; the
  client keeps its guards), but keys no longer collide on rename since identity is the id.

### 5. Checkout integration (`checkout.svelte.ts`, `realtime.svelte.ts`)

- `previewStaged`/`commitStaged` concatenate three buffers in order: model, artifact, view.
- `lockedResourcesNeededBy` gains the view-op arm mirroring the backend derivation (create →
  parent; rename → the folder; move_folder → current container (via `_view`) + destination;
  delete_folder → subtree ids via `_view`; placements → containing folder(s); temp ids skipped).
  Results under the canonical `folder:` prefix.
- `canonicalResource` maps `type: 'folder'` → `folder:<id>`; `alreadyHeld`/`ensureCheckout`
  work unchanged on top.
- Commit token partition: folder tokens are ALWAYS sent (Decision 10); the artifact keep-open
  rule is unchanged. Commit success clears the view journal silently (before `applyDelta`,
  same ordering discipline as the other two buffers) and triggers the view refetch.
- `discardAll` also discards the view journal and releases folder tokens (none are keep-open).
- `realtime.svelte.ts`: `hasModelLocks` excludes `folder:` resources like `art:`.

### 6. UI surfaces

- **DiffDrawer**: View section renders journal labels in order; one "Discard view changes"
  all-or-nothing action; view entries count into the commit gate's `total`; commit message flow
  unchanged. History rendering of view commits stays on the Phase 1 stance (message/op-count;
  consuming `GET /commits/{rev}/diff` is a separate follow-up slice).
- **TopBar**: "View: y" becomes the journal depth.
- **ViewSelector**: Clear → staged clear-all (Decision 3), confirm dialog reworded to say the
  change is staged until commit.
- **Denied-tab fixes** (Decision 4): lock-denied artifact editors read-only + holder banner +
  "Save as copy"; denied rename/new-folder dialogs read-only with the same banner.

## Error handling

- Lease acquire 409 → toast with holder (from the conflicts body), nothing staged, nothing
  applied locally — fail-fast.
- Commit-time 409 (stale rev / lock verification) and 422 → existing DiffDrawer conflict
  recovery paths, unchanged.
- `GET /view` refetch failure → keep current `_view` (stale until next event); boot failure
  keeps today's null-view behavior.
- Revert across view commits: the backend answers 409 by design — no UI may imply otherwise.

## Testing

- Vitest: rewritten `view-tree-build` / `view-tree-dnd` / `view-tree-window` suites (id
  addressing); new `view-edits` journal suite; `view-ops` id-addressed helper suite; checkout
  suites for the view arm of `lockedResourcesNeededBy`, `canonicalResource`, token partition,
  and three-buffer concatenation; MSW round-trip of a mixed model+artifact+view commit incl.
  `id_map` folder temp ids and post-commit refetch; DiffDrawer View section + TopBar counter;
  denied-tab read-only/save-as-copy tests; artifact-delete scrub-in-batch tests.
- `pixi run frontend-test` + `pixi run frontend-check` green per task; Playwright
  (`pixi run frontend-test-e2e`) at the end.

## Out of scope (deferred, per handoff/spec)

- Retiring `PUT /view/snapshot` and `DELETE /view` server-side (backend cleanup AFTER this
  lands; both stay functional throughout).
- View-scoped feed events for the legacy PUT; renaming the view / multiple named views;
  revert across view ops; OCC on view ops; consuming `GET /commits/{rev}/diff` in the
  HistoryDrawer; Phases 3 and 4.
- Backend known issues: cold-view `expand_targets` degradation; `DELETE /view` durability;
  `create_commit` refactor.
