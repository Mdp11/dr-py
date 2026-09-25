# Admin & Project UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix seven project/admin UX gaps: admins can open/act on any project, adding members uses a real user picker, projects can be cloned and deleted from the list, destructive admin actions confirm, a home button exists inside a project, and the obsolete "Load Model" button is removed.

**Architecture:** Two small backend changes (admin bypass in `require_membership`; a new `POST /projects/{id}/clone` that reuses the importer's rev-0-baseline path) plus five focused frontend changes (project API helpers, project-card actions, member picker, delete confirmations, top-bar nav). Each task is independently testable and committed on its own.

**Tech Stack:** FastAPI + SQLAlchemy (Python 3.14, pyright floor 3.10), SvelteKit 5 (runes) + Zod + Vitest/MSW, pytest (in-memory SQLite).

## Global Constraints

- Python: runtime 3.14 but pyright floor is **3.10** — import `Self`/`assert_never` from `typing_extensions`, not `typing`. Not expected to matter here, but honor it if you add typing imports.
- Backend tests need **no** DB service (in-memory SQLite via `tests/api/conftest.py`); data-route tests use `client` + `AUTH_HEADERS` + `papi()` + `seed_default_project()` and the identity provider is pinned to `header`.
- Frontend npm scripts MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test'`.
- All three of ruff, mypy, pyright must pass (`pixi run lint-core`, `pixi run lint-backend`); frontend uses `pixi run -e frontend bash -c 'cd frontend && npm run check'`.
- Preserve the existing dense docstring/comment style when touching backend invariants (`require_membership`, importer).
- Confirmations reuse `window.confirm()` — do NOT introduce a modal component.
- Clone copies current state only (metamodel + model + view → rev-0 baseline); commit history is NOT copied; the cloner becomes owner.

---

### Task 1: Admin can open/act on any project (`require_membership`)

**Files:**
- Modify: `src/data_rover/api/authz.py:57-72`
- Test: `tests/api/test_admin_any_project.py` (create)

**Interfaces:**
- Consumes: `db_models.Membership`, `Role`, `User` (already imported in authz.py).
- Produces: unchanged signature `require_membership(project_id, request, user, db) -> Membership`; new behaviour = returns a transient `Membership(user_id=user.id, project_id=project_id, role=Role.owner)` for admins who are non-members.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_admin_any_project.py`:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Membership, Project, Role, User
from data_rover.api.main import create_app

SIMPLE_MM = "elements:\n  - name: Block\n"


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _seed_project_with_member(pid: str, uid: str) -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, uid) is None:
            s.add(User(id=uid, email=""))
        s.add(Project(id=pid, name=pid))
        s.add(Membership(user_id=uid, project_id=pid, role=Role.owner))
        s.commit()
    finally:
        gen.close()


def _seed_admin(uid: str) -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id=uid, email="admin@example.com", is_admin=True))
        s.commit()
    finally:
        gen.close()


def _h(uid: str) -> dict[str, str]:
    return {"x-user-id": uid}


def test_admin_non_member_can_read_and_write_any_project(client: TestClient) -> None:
    _seed_project_with_member("alpha", "owner1")
    _seed_admin("boss")
    # admin is NOT a member of alpha
    assert client.get("/api/v1/projects/alpha", headers=_h("boss")).status_code == 200
    # and can WRITE (upload a metamodel) despite not being a member
    res = client.post(
        "/api/v1/projects/alpha/metamodel",
        content=SIMPLE_MM,
        headers={"content-type": "application/x-yaml", **_h("boss")},
    )
    assert res.status_code == 200, res.text


def test_non_admin_non_member_still_forbidden(client: TestClient) -> None:
    _seed_project_with_member("alpha", "owner1")
    assert (
        client.get("/api/v1/projects/alpha", headers=_h("stranger")).status_code == 403
    )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_admin_any_project.py -v`
Expected: `test_admin_non_member_can_read_and_write_any_project` FAILS with 403 (admin currently blocked); the second test PASSES.

- [ ] **Step 3: Implement the admin bypass**

In `src/data_rover/api/authz.py`, replace the body of `require_membership` (lines 63-72) with:

```python
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    membership = get_membership(db, user.id, project_id)
    if membership is None:
        # Global admins have implicit owner access to EVERY project so they can
        # open/manage any project without an explicit membership row. This is a
        # transient in-memory Membership (never added to the DB session); it
        # carries the owner role through the request so the viewer-write guard
        # below is naturally satisfied.
        if user.is_admin:
            return Membership(
                user_id=user.id, project_id=project_id, role=Role.owner
            )
        raise HTTPException(status_code=403, detail="not a project member")
    if _is_write(request) and membership.role is Role.viewer:
        raise HTTPException(
            status_code=403, detail="viewer role cannot modify the model"
        )
    return membership
```

Also update the module docstring line about "the current user is a member (403)" to note the admin exception. Change the sentence at lines 3-5 to:

```python
``require_membership`` resolves the ``project_id`` path param, confirms the
project exists (404) and the current user is a member (403 — except global
admins, who get implicit owner access to every project), and rejects writes
by viewers (403). ``require_owner`` further restricts to owners (membership
management). These are wired into every project-scoped route transitively via
``deps.get_request_session`` (Task 8), so route handlers need no changes.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_admin_any_project.py tests/api/test_multi_project.py -v`
Expected: all PASS (multi_project's `test_non_member_cannot_touch_project` still passes — stranger is not admin).

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-backend
cd /home/mdp/workspace/data-rover-py
git add src/data_rover/api/authz.py tests/api/test_admin_any_project.py
git commit -m "feat(authz): grant admins implicit owner access to any project"
```

---

### Task 2: Clone project endpoint (`POST /projects/{id}/clone`)

**Files:**
- Modify: `src/data_rover/api/routes/projects.py` (add import + route)
- Test: `tests/api/test_project_clone.py` (create)

**Interfaces:**
- Consumes: `importer.import_project(...)`, `content.get_model_row`, `content.get_metamodel_row`, `content.get_single_view`, `serialize.iter_model_json`, `session.get_registry`, existing `ProjectOut`.
- Produces: `POST /api/v1/projects/{project_id}/clone` body `{"name"?: str}` → 201 `ProjectOut` (new project id, role `owner`).

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_project_clone.py`:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Membership, Project, Role, User
from data_rover.api.main import create_app

SIMPLE_MM = "elements:\n  - name: Block\n"


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def _seed(pid: str, uid: str, role: Role = Role.owner) -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, uid) is None:
            s.add(User(id=uid, email=""))
        if s.get(Project, pid) is None:
            s.add(Project(id=pid, name=pid))
        s.add(Membership(user_id=uid, project_id=pid, role=role))
        s.commit()
    finally:
        gen.close()


def _h(uid: str) -> dict[str, str]:
    return {"x-user-id": uid}


def _load_content(client: TestClient, pid: str, uid: str) -> None:
    assert client.post(
        f"/api/v1/projects/{pid}/metamodel",
        content=SIMPLE_MM,
        headers={"content-type": "application/x-yaml", **_h(uid)},
    ).status_code == 200
    assert client.post(
        f"/api/v1/projects/{pid}/model",
        json={
            "elements": [{"id": "b1", "type_name": "Block", "properties": {}}],
            "relationships": [],
        },
        headers=_h(uid),
    ).status_code == 200


def test_member_can_clone_and_becomes_owner(client: TestClient) -> None:
    _seed("src", "owner1")
    _load_content(client, "src", "owner1")

    res = client.post("/api/v1/projects/src/clone", json={}, headers=_h("owner1"))
    assert res.status_code == 201, res.text
    body = res.json()
    new_id = body["id"]
    assert new_id != "src"
    assert body["role"] == "owner"
    assert body["name"] == "src (copy)"

    # clone carries the source's current model state...
    summ = client.get(
        f"/api/v1/projects/{new_id}/model/summary", headers=_h("owner1")
    )
    assert summ.status_code == 200
    assert summ.json()["element_count"] == 1
    # ...and starts at a fresh rev-0 (no history copied)
    assert summ.json()["model_rev"] == 0


def test_viewer_can_clone(client: TestClient) -> None:
    _seed("src", "owner1")
    _load_content(client, "src", "owner1")
    _seed("src", "viewer1", role=Role.viewer)

    res = client.post("/api/v1/projects/src/clone", json={"name": "Fork"}, headers=_h("viewer1"))
    assert res.status_code == 201, res.text
    assert res.json()["name"] == "Fork"
    assert res.json()["role"] == "owner"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_project_clone.py -v`
Expected: FAIL with 404/405 (route does not exist).

- [ ] **Step 3: Implement the clone route**

In `src/data_rover/api/routes/projects.py`, add these imports near the top with the existing ones:

```python
from ..serialize import iter_model_json
from .. import content
```

(`importer`, `tenancy`, `uuid`, `ProjectOut`, `require_membership`, `get_current_user`, `get_registry`, `Membership`, `Project`, `Role`, `User` are already imported.)

Add a request body model after `ProjectOut` (near line 52):

```python
class CloneIn(BaseModel):
    name: str | None = None
```

Add the route (after `get_project`, before `delete_project`):

```python
@router.post("/projects/{project_id}/clone", response_model=ProjectOut, status_code=201)
def clone_project(
    project_id: str,
    body: CloneIn | None = None,
    membership: Membership = Depends(require_membership),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectOut:
    """Clone the CURRENT state of a project into a brand-new project owned by
    the caller. Any member may clone (``require_membership``). The clone copies
    metamodel + current model + view as a fresh rev-0 baseline via the importer;
    commit history is NOT carried over."""
    src = db.get(Project, project_id)
    if src is None:  # require_membership already proved existence
        raise HTTPException(status_code=404, detail="project not found")
    model_row = content.get_model_row(db, project_id)
    if model_row is None:
        raise HTTPException(status_code=409, detail="project has no content to clone")
    mm_row = content.get_metamodel_row(db, model_row.metamodel_id)
    if mm_row is None:
        raise HTTPException(status_code=409, detail="project metamodel missing")
    view_row = content.get_single_view(db, project_id)

    # Materialize the source's CURRENT model as save-file JSON from the live
    # session (hydrates on cache-miss); iter_model_json streams entity-by-entity.
    session = get_registry().get(project_id)
    model_json = "".join(iter_model_json(session.model))

    new_name = (body.name if body and body.name else f"{src.name} (copy)")
    new_id = uuid.uuid4().hex
    importer.import_project(
        project_id=new_id,
        name=new_name,
        owner_id=user.id,
        metamodel_yaml=mm_row.blob,
        model_json=model_json,
        view_json=view_row.blob if view_row is not None else None,
    )
    return ProjectOut(id=new_id, name=new_name, role=Role.owner)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_project_clone.py -v`
Expected: both PASS.

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-backend
cd /home/mdp/workspace/data-rover-py
git add src/data_rover/api/routes/projects.py tests/api/test_project_clone.py
git commit -m "feat(projects): add POST /projects/{id}/clone (current-state copy, cloner owns)"
```

---

### Task 3: Frontend project API — `deleteProject` + `cloneProject`

**Files:**
- Modify: `frontend/src/lib/api/projects.ts`
- Test: `frontend/src/lib/api/__tests__/projects.test.ts` (create)

**Interfaces:**
- Consumes: `apiFetch`, `ProjectSummarySchema`.
- Produces: `deleteProject(id: string): Promise<void>` (DELETE `/projects/{id}`); `cloneProject(id: string, name?: string): Promise<ProjectSummary>` (POST `/projects/{id}/clone`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/api/__tests__/projects.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { deleteProject, cloneProject } from '../projects';

const server = setupServer();
server.listen({ onUnhandledRequest: 'error' });
afterEach(() => server.resetHandlers());

describe('project api', () => {
	it('deleteProject issues DELETE', async () => {
		let hit = false;
		server.use(
			http.delete('/api/v1/projects/p1', () => {
				hit = true;
				return new HttpResponse(null, { status: 204 });
			})
		);
		await deleteProject('p1');
		expect(hit).toBe(true);
	});

	it('cloneProject posts and returns the new project', async () => {
		server.use(
			http.post('/api/v1/projects/p1/clone', async ({ request }) => {
				const body = (await request.json()) as { name?: string };
				expect(body.name).toBe('My Fork');
				return HttpResponse.json({ id: 'p2', name: 'My Fork', role: 'owner' });
			})
		);
		const res = await cloneProject('p1', 'My Fork');
		expect(res.id).toBe('p2');
		expect(res.role).toBe('owner');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/projects.test.ts'`
Expected: FAIL — `deleteProject`/`cloneProject` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `frontend/src/lib/api/projects.ts`:

```ts
export function deleteProject(id: string): Promise<void> {
	return apiFetch(`/projects/${id}`, { method: 'DELETE' }, API);
}

export function cloneProject(id: string, name?: string): Promise<ProjectSummary> {
	return apiFetch(
		`/projects/${id}/clone`,
		{ method: 'POST', body: name ? { name } : {}, schema: ProjectSummarySchema },
		API
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/projects.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/mdp/workspace/data-rover-py
git add frontend/src/lib/api/projects.ts frontend/src/lib/api/__tests__/projects.test.ts
git commit -m "feat(frontend/api): add deleteProject + cloneProject"
```

---

### Task 4: Project cards — clone (all), delete (admin), with confirm

**Files:**
- Modify: `frontend/src/lib/components/projects/ProjectCard.svelte`
- Modify: `frontend/src/routes/projects/+page.svelte`
- Test: `frontend/src/lib/components/__tests__/ProjectCard.test.ts` (create)

**Interfaces:**
- Consumes: `deleteProject`, `cloneProject` (Task 3); `isAdmin()` from `$lib/state`.
- Produces: `ProjectCard` props `{ project, onOpen, onChanged }`. `onChanged: () => void` is called by the card after a successful clone or delete so the parent refreshes.

Note: the current card is a single `<button>`. Nested buttons are invalid HTML, so restructure into a container `<div>` with an "open" button plus action buttons.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/__tests__/ProjectCard.test.ts`:

```ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import ProjectCard from '../projects/ProjectCard.svelte';

const state = vi.hoisted(() => ({ admin: false }));
vi.mock('$lib/state', () => ({ isAdmin: () => state.admin }));

const api = vi.hoisted(() => ({
	deleteProject: vi.fn(() => Promise.resolve()),
	cloneProject: vi.fn(() => Promise.resolve({ id: 'p2', name: 'x (copy)', role: 'owner' }))
}));
vi.mock('$lib/api/projects', () => api);

const project = { id: 'p1', name: 'Alpha', role: 'viewer' as const };

beforeEach(() => {
	state.admin = false;
	api.deleteProject.mockClear();
	api.cloneProject.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('ProjectCard', () => {
	it('opens on name click', async () => {
		const onOpen = vi.fn();
		render(ProjectCard, { project, onOpen, onChanged: vi.fn() });
		await fireEvent.click(screen.getByText('Alpha'));
		expect(onOpen).toHaveBeenCalledWith('p1');
	});

	it('clone is available to any member and refreshes', async () => {
		const onChanged = vi.fn();
		render(ProjectCard, { project, onOpen: vi.fn(), onChanged });
		await fireEvent.click(screen.getByRole('button', { name: /clone/i }));
		expect(api.cloneProject).toHaveBeenCalledWith('p1');
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it('delete button is hidden for non-admins', () => {
		render(ProjectCard, { project, onOpen: vi.fn(), onChanged: vi.fn() });
		expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
	});

	it('admin delete confirms then calls api', async () => {
		state.admin = true;
		const onChanged = vi.fn();
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
		render(ProjectCard, { project, onOpen: vi.fn(), onChanged });
		await fireEvent.click(screen.getByRole('button', { name: /delete/i }));
		expect(confirm).toHaveBeenCalled();
		expect(api.deleteProject).toHaveBeenCalledWith('p1');
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it('admin delete aborts when not confirmed', async () => {
		state.admin = true;
		vi.spyOn(window, 'confirm').mockReturnValue(false);
		render(ProjectCard, { project, onOpen: vi.fn(), onChanged: vi.fn() });
		await fireEvent.click(screen.getByRole('button', { name: /delete/i }));
		expect(api.deleteProject).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/ProjectCard.test.ts'`
Expected: FAIL — card has no clone/delete buttons and no `onChanged` prop.

- [ ] **Step 3: Rewrite `ProjectCard.svelte`**

Replace the entire file with:

```svelte
<script lang="ts">
	import type { ProjectSummary } from '$lib/api/projects';
	import { deleteProject, cloneProject } from '$lib/api/projects';
	import { isAdmin } from '$lib/state';

	let {
		project,
		onOpen,
		onChanged
	}: {
		project: ProjectSummary;
		onOpen: (id: string) => void;
		onChanged: () => void;
	} = $props();

	let busy = $state(false);

	async function onClone(): Promise<void> {
		busy = true;
		try {
			await cloneProject(project.id);
			onChanged();
		} finally {
			busy = false;
		}
	}

	async function onDelete(): Promise<void> {
		if (!window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
		busy = true;
		try {
			await deleteProject(project.id);
			onChanged();
		} finally {
			busy = false;
		}
	}
</script>

<div
	class="flex w-full items-center justify-between rounded border border-zinc-800 bg-zinc-900 px-3 py-2 hover:border-zinc-700"
>
	<button class="flex flex-1 items-center justify-between text-left" onclick={() => onOpen(project.id)}>
		<span class="text-sm text-zinc-100">{project.name}</span>
		<span class="ml-2 text-xs text-zinc-400">{project.role}</span>
	</button>
	<div class="ml-3 flex items-center gap-2">
		<button class="text-xs text-zinc-400 hover:text-zinc-100" onclick={onClone} disabled={busy}>
			Clone
		</button>
		{#if isAdmin()}
			<button class="text-xs text-red-400 hover:text-red-300" onclick={onDelete} disabled={busy}>
				Delete
			</button>
		{/if}
	</div>
</div>
```

- [ ] **Step 4: Wire `onChanged` in the projects page**

In `frontend/src/routes/projects/+page.svelte`, change the card usage (line 70) from:

```svelte
				<ProjectCard project={p} onOpen={open} />
```

to:

```svelte
				<ProjectCard project={p} onOpen={open} onChanged={refresh} />
```

(`refresh` is already defined in that file.)

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/ProjectCard.test.ts && npm run check'`
Expected: tests PASS, svelte-check reports no errors.

- [ ] **Step 6: Commit**

```bash
cd /home/mdp/workspace/data-rover-py
git add frontend/src/lib/components/projects/ProjectCard.svelte frontend/src/routes/projects/+page.svelte frontend/src/lib/components/__tests__/ProjectCard.test.ts
git commit -m "feat(projects): clone (all members) + admin delete with confirm on project cards"
```

---

### Task 5: ProjectMembersTab — searchable user picker + remove confirm

**Files:**
- Modify: `frontend/src/lib/components/admin/ProjectMembersTab.svelte`
- Test: `frontend/src/lib/components/__tests__/ProjectMembersTab.test.ts` (extend existing)

**Interfaces:**
- Consumes: `listUsers(q)` (already in `$lib/api/admin`), `addMember`, `removeMember`, `listMembers`.
- Produces: no new exports; internal search state resolves an email to a real `user_id` before `addMember`.

- [ ] **Step 1: Read the existing test file**

Read `frontend/src/lib/components/__tests__/ProjectMembersTab.test.ts` to match its mock/setup style before extending it.

- [ ] **Step 2: Write the failing tests (append)**

Append to `frontend/src/lib/components/__tests__/ProjectMembersTab.test.ts` (adapt imports/mock names to the existing file's conventions — it already mocks `$lib/api/admin` and `$lib/api/projects`):

```ts
describe('ProjectMembersTab user picker', () => {
	it('searches users and posts the selected real user_id (no "unknown user")', async () => {
		// listProjects → one project; listUsers('ann') → a real user; addMember succeeds.
		// (Wire these onto the existing admin-api mock used at the top of this file.)
		// 1. render, wait for the project to load
		// 2. type "ann" into the user search box
		// 3. click the matching "ann@example.com" result
		// 4. click "Add member"
		// 5. expect addMember was called with (projectId, 'user-ann', 'editor')
		//    and NOT with the literal search text.
	});

	it('remove member confirms before calling removeMember', async () => {
		// spy window.confirm → true; click remove; expect removeMember called.
		// spy window.confirm → false; click remove; expect removeMember NOT called.
	});
});
```

Fill these in concretely against the mocks already declared at the top of the file (mirror `UsersTab.test.ts` for the `listUsers` mock shape: it returns `AdminUser[]` with `{ id, email, is_admin, is_active }`). The picker binds the selected user's `id` as `user-ann`, and `addMember` must receive that id.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/ProjectMembersTab.test.ts'`
Expected: new tests FAIL — there is no user search box; the current input binds a raw id and remove has no confirm.

- [ ] **Step 4: Implement the picker + confirm**

In `frontend/src/lib/components/admin/ProjectMembersTab.svelte`:

Add `listUsers` + `AdminUser` to the admin import (line 6) and add search state (near line 12):

```ts
	import { listMembers, addMember, removeMember, listUsers, type Member, type AdminUser } from '$lib/api/admin';
```

```ts
	let userQuery = $state('');
	let userResults = $state<AdminUser[]>([]);
	let selectedUser = $state<AdminUser | null>(null);
	let _searchTimer: ReturnType<typeof setTimeout> | null = null;

	function onUserSearch(): void {
		selectedUser = null;
		if (_searchTimer !== null) clearTimeout(_searchTimer);
		_searchTimer = setTimeout(async () => {
			_searchTimer = null;
			try {
				userResults = await listUsers(userQuery);
			} catch (err) {
				error = errMsg(err);
			}
		}, 250);
	}

	function pickUser(u: AdminUser): void {
		selectedUser = u;
		userQuery = u.email;
		userResults = [];
	}
```

Replace the `add` function so it uses the selected user's id, and guard when none is selected:

```ts
	async function add(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!selectedUser) {
			error = 'Pick a user from the search results first.';
			return;
		}
		error = null;
		busy = true;
		try {
			await addMember(selected, selectedUser.id, newRole);
			userQuery = '';
			selectedUser = null;
			userResults = [];
			members = await listMembers(selected);
		} catch (err) {
			error = errMsg(err);
		} finally {
			busy = false;
		}
	}
```

Wrap `remove` with a confirm at the top of the function body:

```ts
	async function remove(userId: string): Promise<void> {
		if (!window.confirm('Remove this member from the project?')) return;
		error = null;
		busy = true;
		// ...unchanged body...
```

Replace the add-member form's user input (the `<Input placeholder="User id" ... />` block, lines 81-89) with a search box + results list. Also remove the now-unused `newUserId` state (line 12):

```svelte
	<form onsubmit={add} class="flex flex-col gap-1">
		<div class="flex items-end gap-2">
			<div class="relative flex-1">
				<Input placeholder="Search user by email…" bind:value={userQuery} oninput={onUserSearch} />
				{#if userResults.length}
					<ul class="absolute z-10 mt-1 w-full rounded border border-zinc-800 bg-zinc-900">
						{#each userResults as u (u.id)}
							<li>
								<button
									type="button"
									class="block w-full px-2 py-1 text-left text-sm text-zinc-100 hover:bg-zinc-800"
									onclick={() => pickUser(u)}
								>
									{u.email}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<select class="rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-100" bind:value={newRole}>
				<option value="owner">owner</option>
				<option value="editor">editor</option>
				<option value="viewer">viewer</option>
			</select>
			<Button type="submit" size="sm" disabled={busy || !selectedUser}>Add member</Button>
		</div>
	</form>
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/ProjectMembersTab.test.ts && npm run check'`
Expected: PASS, no svelte-check errors (confirm `newUserId` is fully removed).

- [ ] **Step 6: Commit**

```bash
cd /home/mdp/workspace/data-rover-py
git add frontend/src/lib/components/admin/ProjectMembersTab.svelte frontend/src/lib/components/__tests__/ProjectMembersTab.test.ts
git commit -m "fix(admin): searchable user picker for adding members; confirm on remove"
```

---

### Task 6: UsersTab — confirm before deleting a user

**Files:**
- Modify: `frontend/src/lib/components/admin/UsersTab.svelte:93-104`
- Test: `frontend/src/lib/components/__tests__/UsersTab.test.ts` (extend existing)

**Interfaces:**
- Consumes: existing `deleteUser`. No new exports.

- [ ] **Step 1: Write the failing test (append)**

Append to `frontend/src/lib/components/__tests__/UsersTab.test.ts` (match the file's existing mock setup for `$lib/api/admin`; `listUsers` must return one user so a delete button renders):

```ts
describe('UsersTab delete confirmation', () => {
	it('confirms before deleting and aborts on cancel', async () => {
		// render with listUsers → [{ id:'u1', email:'a@b.c', is_admin:false, is_active:true }]
		// spy window.confirm → false; click "delete"; expect deleteUser NOT called
		// spy window.confirm → true;  click "delete"; expect deleteUser called with 'u1'
	});
});
```

Fill it in concretely against the existing mocks in that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/UsersTab.test.ts'`
Expected: the cancel case FAILS — delete currently fires unconditionally.

- [ ] **Step 3: Add the confirm guard**

In `frontend/src/lib/components/admin/UsersTab.svelte`, change the start of `remove` (line 93) to:

```ts
	async function remove(u: AdminUser): Promise<void> {
		if (!window.confirm(`Delete user "${u.email}"? This cannot be undone.`)) return;
		error = null;
		busy = true;
		// ...unchanged body...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/UsersTab.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/mdp/workspace/data-rover-py
git add frontend/src/lib/components/admin/UsersTab.svelte frontend/src/lib/components/__tests__/UsersTab.test.ts
git commit -m "fix(admin): confirm before deleting a user"
```

---

### Task 7: TopBar — home button, remove "Load Model"

**Files:**
- Modify: `frontend/src/lib/components/TopBar.svelte`
- Test: `frontend/src/lib/components/__tests__/TopBar.test.ts` (create, or extend if present)

**Interfaces:**
- Consumes: `goto` from `$app/navigation`, `resolve` from `$app/paths` (already imported), `combinedChanges`/`confirmDiscardChanges` (already in file).
- Produces: no exports; the "Data Rover" label becomes a link to `/projects`; the "Load Model" button and `onLoadClick`/`loadOpen`/`LoadFilesDialog` usages are removed.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/__tests__/TopBar.test.ts`. Mock `$app/navigation`, `$app/paths`, and `$lib/state` (TopBar imports many state getters — return benign defaults: `getActiveProjectId` → `'p1'`, `getMetamodel`/`getModelSummary` → `null`, counts → `0`, `getIssues` → `[]`, booleans → `false`). Then:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import TopBar from '../TopBar.svelte';

const nav = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => nav);
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
// ...mock $lib/state getters with benign defaults (see note above)...

describe('TopBar', () => {
	it('has no "Load Model" button', () => {
		render(TopBar);
		expect(screen.queryByRole('button', { name: /load model/i })).toBeNull();
	});

	it('home link navigates to /projects', async () => {
		render(TopBar);
		await fireEvent.click(screen.getByRole('button', { name: /data rover/i }));
		expect(nav.goto).toHaveBeenCalledWith('/projects');
	});
});
```

If a `TopBar.test.ts` already exists, extend it and reuse its state mock instead of writing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/TopBar.test.ts'`
Expected: FAIL — "Load Model" button still present; "Data Rover" is a `<span>`, not a button.

- [ ] **Step 3: Implement — add home nav, remove Load Model**

In `frontend/src/lib/components/TopBar.svelte`:

Add `goto` import (top of script, after the `resolve` import at line 3):

```ts
	import { goto } from '$app/navigation';
```

Add a `goHome` handler near `confirmDiscardChanges` (after line 82):

```ts
	function goHome(): void {
		if (!confirmDiscardChanges('Leave this project? Unsaved changes may be lost.')) return;
		void goto(resolve('/projects'));
	}
```

Remove `onLoadClick` (lines 84-93) and the `loadOpen` state (line 38). Replace the `Data Rover` span (line 114) with:

```svelte
		<button
			type="button"
			class="font-semibold tracking-tight text-zinc-100 hover:text-white"
			onclick={goHome}
		>
			Data Rover
		</button>
```

Delete the "Load Model" button block (lines 141-144) and the `<LoadFilesDialog ... />` usage wherever it is rendered lower in the file, plus its import (line 33: `import LoadFilesDialog from './LoadFilesDialog.svelte';`) and the now-unused `FolderOpen` import (line 31). Leave `LoadFilesDialog.svelte` on disk.

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/TopBar.test.ts && npm run check'`
Expected: tests PASS; svelte-check reports no unused-import / undefined errors (confirm `loadOpen`, `onLoadClick`, `FolderOpen`, `LoadFilesDialog` are all gone).

- [ ] **Step 5: Commit**

```bash
cd /home/mdp/workspace/data-rover-py
git add frontend/src/lib/components/TopBar.svelte frontend/src/lib/components/__tests__/TopBar.test.ts
git commit -m "feat(topbar): home link to /projects; remove obsolete Load Model button"
```

---

### Task 8: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Backend tests + lint**

Run: `pixi run test-core && pixi run lint-backend`
Expected: all pass.

- [ ] **Step 2: Frontend tests + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: all pass.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Boot backend + frontend (`pixi run start-backend`, `pixi run start-frontend`), log in as the bootstrap admin, and verify: open any project as admin; add a member via search; clone a project from the list; delete a project (confirm dialog); home button returns to `/projects`; no "Load Model" button.

---

## Self-Review

**Spec coverage:**
- #1 admin opens any project → Task 1 (authz bypass, read + write test).
- #2 "unknown user" → Task 5 (searchable picker posts real id).
- #3 delete-project button → Task 4 (admin delete on card; backend already exists).
- #4 confirm on deletions → Task 4 (project), Task 5 (member remove), Task 6 (user).
- #5 home button in project → Task 7.
- #6 remove Load Model button → Task 7.
- #7 clone project → Task 2 (endpoint) + Task 3 (api) + Task 4 (card button, any member).

**Placeholder scan:** Tasks 5, 6, 7 leave test *bodies* to be filled against each file's existing mock conventions (the existing files' mocks vary), but each specifies exact inputs, the id to assert, and the confirm-spy behavior — no logic is left undefined. All implementation steps show complete code.

**Type consistency:** `onChanged: () => void` (Task 4) matches `refresh` in `+page.svelte`. `cloneProject(id, name?)` (Task 3) matches the card's `cloneProject(project.id)` call (Task 4) and the endpoint body `{name?}` (Task 2). `AdminUser` fields `{id,email,is_admin,is_active}` (Task 5) match `admin.ts`. `deleteProject`/`cloneProject` signatures are consistent across Tasks 3–4.
