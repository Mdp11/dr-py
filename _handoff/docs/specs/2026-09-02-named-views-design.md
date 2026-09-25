# Named views — design

A project holds many named views. Each client picks the view it works in;
views are added and deleted from a top-bar menu.

## Goals

- A project stores N named views on the server (the `views` table already
  allows it; today a code convention picks the first row).
- Each client selects its own active view; two editors may work in
  different views at once.
- Add a view by uploading a view JSON document under a required, unique
  name. Delete any loaded view. Switch between loaded views.
- A project may have zero views ("no view" state).

## Non-goals

- Renaming a view.
- Journaling / undo of add and delete (they are direct actions, like a
  metamodel upload).
- Creating an empty view from the UI (upload a `{}` document instead).

## 1. Data and naming

- Alembic migration: unique index on `views (project_id, name)`.
- `ViewRow.name` is authoritative. `POST /views` overwrites the document's
  own `name` with the row name before persisting, so blob and row never
  disagree. Names are trimmed, non-empty, at most 120 characters.
- `content.py`: `list_views`, `get_view`, `create_view` (raises
  `DuplicateViewNameError` → 409), `delete_view`, `upsert_view(view_id, …,
  bump_rev)`. `get_single_view` / `upsert_single_view` are removed.
- `Session.view: View | None` becomes `Session.views: dict[str, View]`,
  keyed by row id. Hydration loads every row and heals folder ids per row
  (`bump_rev=False` on the heal write, as today).
- `clone_project` clones every view. The importer's single `view_json`
  creates one view named after the document's `name`, falling back to
  `"Default"`.

## 2. Op protocol

- Every `view.*` op (`CreateFolderOp` … `MoveArtifactOp`) carries
  `view_id: str = ""`. The default exists ONLY so journal rows written
  before this field parse; `POST /commits` and `POST /commits/preview`
  answer 422 for an empty or unknown `view_id`.
- Commit/preview/undo group view ops by `view_id`, apply each group to
  `session.views[view_id]` with the existing atomic applier, and persist
  only the touched blobs (`content.upsert_view`) on the commit's
  transaction. `CommitResponse.view_rev` becomes `view_revs: dict[view_id,
  rev]`.
- `load_or_create_view` and the `created_view` unwind entry are removed:
  `session.views` is complete after hydration, and an op naming a missing
  view is a client error, not a cold-cache miss.
- Undo of a legacy row (empty `view_id`) resolves to the project's only
  view when exactly one exists; otherwise 409 with push-back, like undo
  across a rebind. `/commits/revert` keeps its 409 across view ops.
- `commit_diff._view_diffs` adds `view_id` to each entry.

## 3. Locks

- New namespace `view:<view_id>` (`VIEW_PREFIX`, `view_resource`,
  `LockTargetIn.type: "view"`). It replaces `folder:root`: root membership
  of view V is a lease on `view:V`.
- `required_locks(model, views, ops)` looks up `views[op.view_id]` for
  subtree expansion; `expand_targets` likewise takes the mapping and
  resolves a `folder` target's view by searching the mapping (folder ids
  are uuids, unique across views).
- Backstop markers become `viewel:<view_id>:<element_id>` and
  `viewart:<view_id>:<artifact_id>`.
- `DELETE /views/{id}` honors leases: 409 while a peer holds `view:<id>` or
  any `folder:` lease on a folder of that view.

## 4. Routes (`routes/views.py`, replaces `routes/view.py`)

| Route | Gate | Behaviour |
|---|---|---|
| `GET /views` | viewer+ | `[{id, name, view_rev}]` sorted by name then id |
| `GET /views/{id}` | viewer+ | `ViewStateResponse` (view, warnings, view_rev); 404 unknown |
| `POST /views` | editor+ | `{name, view}` → 201 `{id, name, view_rev}`; 409 duplicate; 422 malformed |
| `DELETE /views/{id}` | editor+ | 204; 404 unknown; 409 lease held by a peer |

Writers run under `session.write_mutex`, update `session.views`, and
broadcast `view_event(action, view={id, name})` (`action` is `created` or
`deleted`). `GET /model/containment/roots/excluded` gains `view_id`
(absent → every root is returned).

## 5. Frontend

- Top bar order: Metamodel · Model · View · Issues · Artifacts · Settings.
  `ViewMenu.svelte` (the `ArtifactsMenu` pattern): a radio list of loaded
  views (active one checked, "No view" when the list is empty), then
  "Add view…" and "Delete view…" for editors.
- `AddViewDialog`: name field + `.json` file drop (the
  `ImportArtifactsDialog` pattern); name prefilled from the file's `name`;
  the new view becomes active on success.
- `DeleteViewDialog`: select from loaded views, default active, confirm.
- `api/views.ts`: `listViews`, `getView(id)`, `createView`, `deleteView`.
- `state/view.svelte.ts`: `_views: ViewSummary[]`, `_activeViewId`,
  remembered per project in localStorage (`dr:view:<projectId>`). Boot
  lists views, keeps the stored id if it exists, else first by name, else
  null. Stage mutators stamp `view_id`; root leases are `type: 'view'`.
  Switching with staged view edits prompts to discard them. Feed `view`
  events refresh the list; a deleted active view falls back to "no view"
  with a notice.
- Sidebar strip shows "No view" and disables folder editing when there is
  no active view. The excluded-pool fetch passes the active id.

## 6. Testing

- Backend: `tests/api/test_view_routes.py` rewritten for the four routes
  (409 duplicate, 409 lease, 404s, viewer 403 on writes, feed events);
  `test_commits_view_ops.py` / `test_undo_view_ops.py` updated to carry
  `view_id`, plus unknown-id 422 and legacy-empty-id undo fallback;
  `test_locks*` for the `view:` namespace; hydration/clone with two views.
- Frontend: state tests (selection, persistence, feed fallback), menu and
  dialog tests, `e2e/view.spec.ts` updated for the menu.
