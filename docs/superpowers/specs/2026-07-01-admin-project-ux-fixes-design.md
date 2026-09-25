# Admin & Project UX Fixes — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming) — ready for implementation plan

## Problem

Seven independent gaps in the project/admin/tenancy UX:

1. Admins can *see* every project in the picker but get **403** when they try to
   open one they are not a member of — they cannot actually open any project.
2. Adding a user to a project via the admin console always fails with
   **"unknown user"**: the add-member form asks for a raw user id, but the
   backend looks the user up by primary key, so any human-entered value (email,
   name) 404s.
3. There is no way to delete a project from the UI, even though the backend
   already supports admin-gated project deletion.
4. Admin deletions (user, project member, and now project) happen immediately
   with **no confirmation**.
5. Once inside a project (`/p/[projectId]`) there is no button back to the
   projects list — the global `AppHeader` is hidden there and the `TopBar` logo
   is inert text.
6. The `TopBar` "Load Model" button is obsolete (content now arrives via the New
   Project wizard / importer) and should be removed.
7. A user with access to a project cannot clone/copy it.

These are decided design choices (from brainstorming):

- **#2** — replace the raw id field with a **searchable user picker** (query
  `GET /admin/users?q=`, select a real user id).
- **#7** — **any member** (viewer and up) can clone; the clone copies the
  **current state** (metamodel + model + view) as the new project's rev-0
  baseline; the cloner becomes **owner**; commit history is NOT copied.
- **#4** — reuse `window.confirm()` (matches the existing element/view/folder
  delete pattern), no new modal component.
- **#3 / #7 buttons** — live on the **project list cards**, keeping project-level
  actions together.
- **#1** — `require_membership` synthesizes an **owner** membership for admins
  (full access, not read-only).
- **#5** — `TopBar` logo becomes a link to `/projects`, guarded by
  `window.confirm()` when there are pending changes.
- **#6** — remove only the button/handler; leave `LoadFilesDialog.svelte` in the
  tree, unreferenced.

## Backend changes (`src/data_rover/api/`)

### A. Admin can open/act on any project (#1)

In `authz.py::require_membership`, after the project-exists (404) check, if
`get_membership(...)` returns `None` **and** `user.is_admin`, return a transient
`Membership(user_id=user.id, project_id=project_id, role=Role.owner)` rather than
raising 403. Because every project-scoped router depends on `require_membership`
(get_project, model ops, commits, locks, feed, …), this single change grants
admins full access everywhere. The viewer-write guard is bypassed naturally
because the synthesized role is `owner`.

- The transient `Membership` is **not** added to the DB session (never
  committed); it is a plain in-memory ORM instance used only to carry the role
  through the request.
- Existing 404-project-not-found behaviour is preserved (it is checked first).

### B. Add member resolves a real user (#2)

No new endpoint is strictly required: the UI picker (F) resolves email → id via
`GET /admin/users?q=` and posts the real `user_id` to the existing
`POST /admin/projects/{project_id}/members`. The current 404 "unknown user"
remains as a safety net for a genuinely missing id. (Backend left unchanged
except tests.)

### C. Clone project (#7)

New route `POST /projects/{project_id}/clone`:

- **Auth:** `require_membership` (any member of the source project; admins pass
  via change A).
- **Body:** optional `{ "name": str }`; default name `"<source name> (copy)"`.
- **Behaviour:** read the source project's current content — metamodel (YAML),
  model (current materialized state), view — and write them as a **rev-0
  baseline** for a newly created project, reusing the same content-write path the
  importer uses (`content.py` / `hydration.persist_baseline`). Create the new
  `Project`, make the caller **owner** (`tenancy.create_project` +
  `add_member` as needed), and return `ProjectOut` for the clone.
- **Not copied:** commit history / op journal (fresh rev-0 only).
- **Source hydration:** ensure the source session is hydrated (registry `.get`)
  so current state is captured, mirroring how other content reads work.

## Frontend changes (`frontend/src/`)

### D. Delete-project button on cards (#3, #4)

`lib/components/projects/ProjectCard.svelte` gains a trash action, shown to
admins (guard on `isAdmin()`; delete is admin-gated server-side regardless).
Handler: `window.confirm("Delete project '<name>'? This cannot be undone.")` →
`DELETE /projects/{id}` (new `deleteProject` in `lib/api/projects.ts`) →
parent refresh callback.

### E. Clone button on cards (#7)

`ProjectCard.svelte` gains a "Clone" action, shown for **every** visible card
(any member). Handler: `cloneProject(id)` (new in `lib/api/projects.ts`,
`POST /projects/{id}/clone`) → refresh list. Navigation to the new project after
clone is optional polish (return the new id; can `goto('/p/<newid>')`).

### F. Searchable user picker (#2)

`lib/components/admin/ProjectMembersTab.svelte`: replace the free-text user-id
input with a debounced search box that calls `listUsers(q)` (already in
`lib/api/admin.ts`), lists matching emails, and binds the selected user's real
`user_id`. Role dropdown unchanged. Add flow then always posts a valid id,
eliminating the normal "unknown user" path.

### G. Confirmations on admin deletes (#4)

Wrap the delete-user handler in `UsersTab.svelte` and the remove-member handler
in `ProjectMembersTab.svelte` with `window.confirm()` before the API call.

### H. Home button inside a project (#5)

`lib/components/TopBar.svelte`: turn the "Data Rover" text into a
`<button>`/link that navigates to `/projects`. When there are pending changes,
`window.confirm("Leave this project? Unsaved changes may be lost.")` first.

### I. Remove "Load Model" button (#6)

`TopBar.svelte`: remove the "Load Model" button and its `onLoadClick`/confirm
handler and the `LoadFilesDialog` trigger state. `LoadFilesDialog.svelte` stays
in the repo, unreferenced.

## Testing

**Backend (pytest, `tests/api/`, `client`/`papi`/`AUTH_HEADERS` fixtures):**

- Admin (non-member) can `GET /projects/{id}` and perform one write route
  (e.g. a model op / commit) — was 403, now succeeds.
- Non-admin non-member still gets 403 (guard unchanged for them).
- `POST /projects/{id}/clone`: creates a new project; caller is owner; clone's
  current model/metamodel/view match the source; clone starts at rev-0 with no
  copied history; a viewer of the source can clone.

**Frontend (vitest, happy-dom + MSW):**

- `ProjectCard`: delete button visible to admins, fires confirm + API; clone
  button visible and fires API.
- `ProjectMembersTab`: picker searches users, selecting an email posts the real
  id (no "unknown user"); remove-member prompts confirm.
- `UsersTab`: delete-user prompts confirm.
- `TopBar`: home/projects link present and navigates; "Load Model" button gone.

## Out of scope

- No new modal/confirm component (window.confirm reused).
- No copying of commit history on clone.
- No change to the swap-metamodel flow or `LoadFilesDialog` internals.
- Durable-persistence internals of clone beyond writing a rev-0 baseline.
