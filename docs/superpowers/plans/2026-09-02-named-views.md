# Named Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project holds many named views; each client picks its own active view; views are added (JSON upload + name), switched and deleted from a top-bar "View" menu.

**Architecture:** `Session.view` becomes `Session.views: dict[id, View]` hydrated from every `ViewRow`; every `view.*` op carries `view_id`; `routes/views.py` exposes list/get/create/delete as direct (non-journaled) actions broadcasting a `view` feed event; root-membership locks move from `folder:root` to a `view:<id>` namespace. The frontend keeps a per-project `activeViewId` in localStorage and stamps it on staged ops.

**Tech Stack:** Python 3.14 / FastAPI / SQLAlchemy / Alembic / pytest; SvelteKit 5 / zod / vitest / playwright. Everything runs through `pixi run`.

**Spec:** `docs/superpowers/specs/2026-09-02-named-views-design.md`

## Global Constraints

- All three of `ruff --fix`, `mypy`, `pyright` must pass (`pixi run core-lint`, `pixi run backend-lint`); frontend `pixi run frontend-check` + `frontend-test`.
- Comments: concise, present tense, only for invariants/contracts. No history narration.
- Every project-scoped API test uses `client` + `seed_default_project` + `AUTH_HEADERS` + `papi` from `tests/api/conftest.py`.
- View name: trimmed, non-empty, ≤ 120 chars, unique per project (DB index + 409).
- `view_id` on ops: `str = ""` default for journal parse; commit/preview 422 on empty/unknown.
- Lock namespaces: `folder:<uuid>` unchanged; `view:<view_id>` replaces `folder:root`; markers `viewel:<view_id>:<eid>`, `viewart:<view_id>:<aid>`.

---

## File map

Backend
- Modify `alembic/versions/0014_views_unique_name.py` (create) — unique index `(project_id, name)`.
- Modify `src/data_rover/api/db_models.py:179-195` — `UniqueConstraint("project_id","name")` on `ViewRow`.
- Modify `src/data_rover/api/content.py:239-275` — replace single-view helpers with `list_views/get_view/create_view/delete_view/upsert_view`, `DuplicateViewNameError`.
- Modify `src/data_rover/api/session.py:73` — `views: dict[str, View]`.
- Modify `src/data_rover/api/hydration.py:218-231,264` — load all rows.
- Modify `src/data_rover/api/importer.py:190-201`, `routes/projects.py:187,220` — create/clone views.
- Modify `src/data_rover/api/schemas.py:428-515` — `view_id` on every view op; `LockTargetIn.type` gains `"view"`; new `ViewSummaryOut`, `CreateViewIn`; `CommitResponse.view_rev` → `view_revs`.
- Modify `src/data_rover/api/locking.py` — `VIEW_PREFIX`, `view_resource`, `expand_targets`/`required_locks` over a views mapping.
- Modify `src/data_rover/api/view_ops.py` — drop `load_or_create_view`; `resolve_view`/`group_by_view`; markers scoped by view; `view_op_folder_ids` per view.
- Modify `src/data_rover/api/routes/commits.py` (preview 563-586, resolve 1025-1048, apply 1149-1172, persist 1364-1372, unwind ledger) and `routes/ops.py` undo (833-865, 953-964, 1056-1061).
- Modify `src/data_rover/api/commit_diff.py:342-434` — `view_id` on diff entries.
- Modify `src/data_rover/api/routes/read.py:550-575` — `view_id` query param.
- Create `src/data_rover/api/routes/views.py` (delete `routes/view.py`); `main.py:319`.
- Modify `src/data_rover/api/feed.py` — `view_event`.
- Modify `src/data_rover/api/authz.py` — nothing (writes detected by method).
- Tests: `tests/api/test_view_routes.py` (rewrite), `test_commits_view_ops.py`, `test_undo_view_ops.py`, `test_view_ops_apply.py`, `test_view_op_schemas.py`, `tests/api/conftest.py` (`create_folder_via_commit`), lock tests, hydration/clone tests.

Frontend
- Create `frontend/src/lib/api/views.ts` (delete `api/view.ts`); `api/types.ts` (`ViewSummarySchema`, `view_rev`).
- Modify `frontend/src/lib/state/ops.ts` — `view_id` on `ViewOp` members; `viewResource`; `LockTargetIn.type` `'view'`.
- Modify `frontend/src/lib/state/view.svelte.ts`, `view-edits.svelte.ts`, `checkout.svelte.ts:170-185,740-800`, `edit-gate.ts:88-120`, `realtime.svelte.ts` (`view` event), `api/model-read.ts:203-240`, `Sidebar/ContainmentTree.svelte`, `Sidebar/ViewSelector.svelte`.
- Create `frontend/src/lib/components/ViewMenu.svelte`, `AddViewDialog.svelte`, `DeleteViewDialog.svelte`; modify `TopBar.svelte:190-227`.
- Tests: `state/__tests__/view*.test.ts`, `components/__tests__/ViewMenu.test.ts`, `e2e/view.spec.ts`.

---

### Task 1: Content layer + schema constraint

**Files:** `db_models.py`, `content.py`, `alembic/versions/0014_views_unique_name.py`, `tests/api/test_content_views.py` (create)

**Produces:**
```python
class DuplicateViewNameError(Exception): ...
def list_views(db, project_id) -> list[ViewRow]            # ordered by name, id
def get_view(db, project_id, view_id) -> ViewRow | None
def create_view(db, project_id, *, name, blob) -> ViewRow   # view_rev=0; raises DuplicateViewNameError
def delete_view(db, project_id, view_id) -> bool
def upsert_view(db, project_id, view_id, *, blob, bump_rev=True) -> ViewRow  # raises KeyError if missing
```

- [ ] Test: create two views, list sorted by name; duplicate name raises; delete returns True then False; upsert bumps rev only when `bump_rev`.
- [ ] Implement `content.py` functions; remove `get_single_view`/`upsert_single_view`; add `UniqueConstraint("project_id", "name", name="uq_views_project_name")` to `ViewRow.__table_args__`; write migration 0014 (`op.create_unique_constraint` / batch for SQLite not needed — Postgres only).
- [ ] `pixi run -e core-dev pytest tests/api/test_content_views.py`; commit.

### Task 2: Session, hydration, importer, clone

**Files:** `session.py`, `hydration.py`, `importer.py`, `routes/projects.py`, `tests/api/test_hydration_views.py` (create)

- [ ] `Session.views: dict[str, View] = field(default_factory=dict)`; remove `view`. Fix every `session.view` reference the type checker reports (leave commits/ops/read/view routes for later tasks but keep them compiling: replace with `session.views` lookups where trivial).
- [ ] Hydration: iterate `content.list_views`, parse, heal per row via `upsert_view(bump_rev=False)`, install dict.
- [ ] Importer: `content.create_view(name=view.name.strip() or "Default", blob=...)`; set `view.name` to that name first.
- [ ] Clone: loop `list_views`, pass `views=[(name, blob)]`… simplest: `import_project` gains `view_jsons: list[tuple[str, str]] | None` replacing `view_json`; CLI passes one.
- [ ] Test: seed two views for the default project, evict, `GET /views` returns both (after Task 5 — until then assert on `registry.get(...).views`).
- [ ] Commit.

### Task 3: Schemas + locking + view_ops

**Files:** `schemas.py`, `locking.py`, `view_ops.py`, `tests/api/test_view_op_schemas.py`, `tests/api/test_locks_view_namespace.py` (create)

**Produces:**
```python
# schemas.py: every view op class gains `view_id: str = ""`
class ViewSummaryOut(BaseModel): id: str; name: str; view_rev: int
class CreateViewIn(BaseModel): name: str (min 1, max 120, strip); view: dict[str, Any]
LockTargetIn.type: Literal["element","artifact","metamodel","folder","view"]
# locking.py
VIEW_PREFIX = "view:"; def view_resource(view_id) -> str
def container_resource(view_id: str, folder_id: str) -> str  # VIEW_ROOT_ID -> view_resource(view_id) else folder_resource(folder_id)
def expand_targets(model, views: Mapping[str, View], ...)   # folder arm finds the owning view by searching the mapping
def required_locks(model, views: Mapping[str, View], ops)   # uses views.get(op.view_id)
# view_ops.py
class UnknownViewError(Exception): view_id
def group_by_view(ops: Sequence[ViewOpIn]) -> dict[str, list[ViewOpIn]]  # preserves order; "" stays a key
def view_touched_resources(op) -> set[str]                  # container_resource + scoped markers
def view_op_folder_ids(view, ops) unchanged signature
```

- [ ] Tests: schema round-trip with/without `view_id`; `required_locks` for `create_folder(parent=root, view_id=V)` yields `view:V` CREATE_CHILD; `delete_folder` expands through the right view when two views exist; markers scoped.
- [ ] Implement; delete `load_or_create_view`; `pixi run backend-lint`; commit.

### Task 4: Commit / preview / undo / diff / read

**Files:** `routes/commits.py`, `routes/ops.py`, `commit_diff.py`, `routes/read.py`, `tests/api/conftest.py`, `tests/api/test_commits_view_ops.py`, `tests/api/test_undo_view_ops.py`

- [ ] `conftest.create_folder_via_commit(client, view_id, ...)` gains `view_id`; add `conftest.create_view(client, name="Default", doc=None) -> str` (POST /views once Task 5 lands; until then insert via `content.create_view` + `session.views[...]`).
- [ ] Preview: `for vid, group in group_by_view(view_ops).items(): validate_view_ops(_resolve(session, vid), group)` where `_resolve` raises 422 `f"unknown view {vid!r}"` (empty → `"view op without view_id"`).
- [ ] Commit: remove auto-create + `created_view`; `required_locks(model, session.views, payload.ops)`; apply per group → `view_results: dict[str, ViewBatchResult]`; unwind rolls back each; persist each touched view via `upsert_view`; response `view_revs: dict[str, int]`.
- [ ] Undo: group inverses; `""` → sole view or 409 `{"detail": "undo of a view change that predates named views needs exactly one view", ...}`; per-view apply/persist/rollback.
- [ ] `commit_diff.ViewDiffEntryOut.view_id: str`.
- [ ] `list_excluded_roots(view_id: str | None = Query(None))`: `session.views.get(view_id)`.
- [ ] Update the two big test files: every op carries `view_id`; delete the auto-create tests (`test_commit_view_ops_without_existing_view_autocreates`, `..._hydrates_durable_view_not_an_empty_one`, `..._leaves_view_null`) and replace with `test_commit_unknown_view_id_422`, `test_commit_two_views_persist_independently`, `test_undo_legacy_empty_view_id_resolves_to_sole_view`, `test_undo_legacy_empty_view_id_409_with_two_views`.
- [ ] `pixi run core-test`; commit.

### Task 5: Routes + feed

**Files:** `routes/views.py` (create), delete `routes/view.py`, `main.py`, `feed.py`, `tests/api/test_view_routes.py` (rewrite)

**Produces:**
```
GET    /views              -> list[ViewSummaryOut]
GET    /views/{view_id}    -> ViewStateResponse (404)
POST   /views              -> 201 ViewSummaryOut (409 duplicate, 422 bad doc/name)
DELETE /views/{view_id}    -> 204 (404; 409 peer lease on view:<id> or any folder: in it)
feed: view_event(action: "created"|"deleted", view: {"id","name"}) -> {"type":"view", ...}
```

- [ ] Tests: CRUD happy path; duplicate 409; bad JSON body 422; blank name 422; viewer 403 on POST/DELETE; delete while peer holds `view:` lease → 409 and while peer holds a `folder:` lease inside → 409; own lease does not block; deleted view's `folder:`/`view:` leases released; feed event captured via `session.hub` monkeypatch (see `test_commit_event_scope_includes_view` for the pattern).
- [ ] Implement: under `write_mutex`; `View.model_validate(doc)` → 422 on `ValidationError`; set `view.name = name`; `ensure_folder_ids`; `content.create_view`; `session.views[row.id] = view`; broadcast. Delete: check `session.lock_table.active_leases()` for `view:<id>` or `folder:<fid>` with `fid in iter_folders(view)` held by another user → 409; `content.delete_view`; `session.views.pop`; broadcast.
- [ ] `pixi run core-test` + `pixi run backend-lint`; commit.

### Task 6: Frontend API + ops + state

**Files:** `api/views.ts`, `api/types.ts`, `state/ops.ts`, `state/view.svelte.ts`, `state/view-edits.svelte.ts`, `state/checkout.svelte.ts`, `state/edit-gate.ts`, `state/realtime.svelte.ts`, `api/model-read.ts`, `state/index.ts`, tests under `state/__tests__/`

**Produces:**
```ts
// api/views.ts
listViews(): Promise<ViewSummary[]>; getView(id): Promise<ViewStateResponse>
createView({name, view}): Promise<ViewSummary>; deleteView(id): Promise<void>
// state/view.svelte.ts
getViews(): readonly ViewSummary[]; getActiveViewId(): string | null
selectView(id: string | null): Promise<void>   // prompts discard if staged view ops
refreshViews(): Promise<void>                    // list + reconcile active
addView(name, doc): Promise<void>; removeView(id): Promise<void>
// ops.ts
viewResource(id) = 'view:' + id; each ViewOp gains view_id: string
```

- [ ] Tests: `selectView` persists to localStorage key `dr:view:<pid>`; boot picks stored → first → null; feed `view deleted` of active → null + notice; stage mutators stamp `view_id`; `lockedResourcesNeededBy(create_folder parent root)` → `view:<id>`.
- [ ] Implement; `folderTargets` maps `'root'` → `{type:'view', resource_id: activeViewId}`; `realtime` `case 'view'` → tap → `refreshViews()`; `listExcludedRoots` passes `view_id`.
- [ ] `pixi run frontend-test`, `frontend-check`; commit.

### Task 7: Frontend UI

**Files:** `components/ViewMenu.svelte`, `AddViewDialog.svelte`, `DeleteViewDialog.svelte`, `TopBar.svelte`, `Sidebar/ViewSelector.svelte`, `components/__tests__/ViewMenu.test.ts`, `e2e/view.spec.ts`

- [ ] Top bar nav order: Metamodel, Model, View, Issues, Artifacts, Settings.
- [ ] `ViewMenu`: `DropdownMenu.RadioGroup` of views (`value = activeViewId`), "No view" disabled item when empty, separator, Add…/Delete… when `canEdit()`.
- [ ] `AddViewDialog`: name input + file drop (`.json`), reads file, `JSON.parse`, prefill name from `doc.name`, submit → `addView`; error text from 409/422 detail.
- [ ] `DeleteViewDialog`: select (default active) + destructive confirm → `removeView`.
- [ ] `ViewSelector`: "No view" state; hide Clear when no view.
- [ ] Component test: radio list renders names, selecting calls `selectView`; e2e: add a view via menu, switch, delete.
- [ ] `pixi run frontend-test`; `frontend-test-e2e` for `view.spec.ts`; commit.

### Task 8: Docs

- [ ] Update `CLAUDE.md` "View ops" paragraph and `frontend/README.md` view section for named views; commit.
