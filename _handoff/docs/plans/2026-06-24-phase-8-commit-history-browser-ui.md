# Commit-History Browser UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a frontend commit-history browser with per-commit diff, any-two-commit diff, and revert-to-commit, backed by one new backend endpoint that reconstructs the model at a historical rev.

**Architecture:** Reuse the existing client-side structural-diff stack (`computeDiff` → `CompareDiff`). Add `GET /commits/{rev}/model` which reconstructs a throwaway model at a rev (nearest snapshot ≤ rev built `strict=False` under the metamodel effective at `rev`, then replay the bounded commit tail). Every diff becomes `computeDiff(model@A, model@B)`. The history list and revert reuse the already-shipped `GET /commits` and `POST /commits/revert`.

**Tech Stack:** Python 3.14 (pyright floor 3.10) / FastAPI / SQLAlchemy 2.0 backend; SvelteKit 5 (runes) / zod / vitest+happy-dom frontend. Everything via `pixi`.

## Global Constraints

- Python runtime is **3.14** but pyright floor is **3.10** — import `Self`/`assert_never` from `typing_extensions`, no stdlib features newer than 3.10.
- Backend lint gate: `pixi run lint-backend` (ruff + mypy + pyright) must pass.
- Backend tests: `pixi run -e core-dev pytest tests/api` (hermetic in-memory SQLite; no DB service).
- Frontend tests: `pixi run -e frontend bash -c 'cd frontend && npx vitest run'`.
- Frontend lint/check: `pixi run -e frontend npm run check` (svelte-check) — note pre-existing eslint/prettier debt in unrelated files (NewRelationshipPicker.svelte, connection-rules.ts); do not introduce NEW lint errors in touched files.
- API tests target the `default` project via `client` fixture + `seed_default_project`/`AUTH_HEADERS`/`papi` from `tests/api/conftest.py`. Use the promoted helpers `model_rev`/`element_count`/`commit_create`/`feed_url` from conftest.
- Reuse Metamodel caches and `model.indexes`; never re-walk `extends`. Property values are replaced wholesale, never mutated in place.
- Commit messages end with the Co-Authored-By trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work happens in a worktree off `main` (set up via using-git-worktrees at execution time). Do NOT push.

---

## File Structure

**Backend (create/modify):**
- Modify `src/data_rover/api/content.py` — add `commits_between`, `first_rebind_after`.
- Modify `src/data_rover/api/hydration.py` — add `reconstruct_model_at`.
- Modify `src/data_rover/api/routes/commits.py` — add `GET /commits/{rev}/model`.
- Test `tests/api/test_content.py` — query tests.
- Test `tests/api/test_reconstruct.py` (new) — `reconstruct_model_at` unit tests.
- Test `tests/api/test_commit_model_at.py` (new) — route tests.

**Frontend (create/modify):**
- Modify `frontend/src/lib/api/types.ts` — `CommitSummarySchema`, `CommitHistoryResponseSchema`, types.
- Create `frontend/src/lib/api/history.ts` — `getCommitHistory`, `getModelAtRev`, `revertToCommit`.
- Test `frontend/src/lib/api/__tests__/history.test.ts`.
- Modify `frontend/src/lib/state/ui.svelte.ts` — history-drawer open-state.
- Modify `frontend/src/lib/state/realtime.svelte.ts` — `onCommitEvent` tap.
- Create `frontend/src/lib/state/history.svelte.ts` — history store + rev→model cache.
- Test `frontend/src/lib/state/__tests__/history.test.ts`.
- Create `frontend/src/lib/components/HistoryDrawer.svelte`.
- Test `frontend/src/lib/components/__tests__/HistoryDrawer.test.ts`.
- Modify `frontend/src/lib/components/TopBar.svelte` — History button.
- Modify `frontend/src/routes/+page.svelte` — mount drawer.
- Modify `frontend/README.md` — document the feature.

---

## Task 1: Backend content queries (`commits_between`, `first_rebind_after`)

**Files:**
- Modify: `src/data_rover/api/content.py`
- Test: `tests/api/test_content.py`

**Interfaces:**
- Consumes: `Commit` ORM, `select` (already imported in content.py).
- Produces:
  - `commits_between(db, project_id, *, after_rev, max_rev) -> list[Commit]` — commits with `after_rev < rev <= max_rev`, ascending.
  - `first_rebind_after(db, project_id, rev) -> Commit | None` — earliest commit with `rev > given` and a non-null metamodel id.

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/test_content.py` (use existing imports there: `content`, `db`, ORM models; mirror existing test style for creating Commit rows):

```python
def test_commits_between_is_bounded_and_ascending() -> None:
    from data_rover.api import content
    from data_rover.api.db import get_db
    from data_rover.api.db_models import Commit, Project
    from data_rover.api.session import DEFAULT_PROJECT_ID

    gen = get_db(); s = next(gen)
    try:
        s.add(Project(id=DEFAULT_PROJECT_ID, name="p"))
        for r in (1, 2, 3, 4):
            s.add(Commit(project_id=DEFAULT_PROJECT_ID, rev=r, commit_id=f"c{r}",
                         author_id=None, ops=[], inverse_ops=[], id_map={}, message=""))
        s.commit()
        out = content.commits_between(s, DEFAULT_PROJECT_ID, after_rev=1, max_rev=3)
        assert [c.rev for c in out] == [2, 3]
    finally:
        gen.close()


def test_first_rebind_after_finds_earliest_rebind() -> None:
    from data_rover.api import content
    from data_rover.api.db import get_db
    from data_rover.api.db_models import Commit, Project
    from data_rover.api.session import DEFAULT_PROJECT_ID

    gen = get_db(); s = next(gen)
    try:
        s.add(Project(id=DEFAULT_PROJECT_ID, name="p"))
        s.add(Commit(project_id=DEFAULT_PROJECT_ID, rev=1, commit_id="c1", author_id=None,
                     ops=[], inverse_ops=[], id_map={}, message=""))
        s.add(Commit(project_id=DEFAULT_PROJECT_ID, rev=2, commit_id="c2", author_id=None,
                     ops=[], inverse_ops=[], id_map={}, message="",
                     from_metamodel_id="m1", to_metamodel_id="m2"))
        s.add(Commit(project_id=DEFAULT_PROJECT_ID, rev=3, commit_id="c3", author_id=None,
                     ops=[], inverse_ops=[], id_map={}, message="",
                     from_metamodel_id="m2", to_metamodel_id="m3"))
        s.commit()
        assert content.first_rebind_after(s, DEFAULT_PROJECT_ID, 0).rev == 2
        assert content.first_rebind_after(s, DEFAULT_PROJECT_ID, 2).rev == 3
        assert content.first_rebind_after(s, DEFAULT_PROJECT_ID, 3) is None
    finally:
        gen.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_content.py -k "commits_between or first_rebind_after" -v`
Expected: FAIL with `AttributeError: module 'data_rover.api.content' has no attribute 'commits_between'`.

- [ ] **Step 3: Implement the queries**

Add to `src/data_rover/api/content.py` (next to `commits_after`; `select` and `Commit` are already imported):

```python
def commits_between(
    db: Session, project_id: str, *, after_rev: int, max_rev: int
) -> list[Commit]:
    """Commits with ``after_rev < rev <= max_rev``, ascending (replay order).

    Bounded variant of ``commits_after`` for historical reconstruction: replay
    only the tail from the chosen snapshot up to (and including) a target rev.
    """
    return list(
        db.execute(
            select(Commit)
            .where(
                Commit.project_id == project_id,
                Commit.rev > after_rev,
                Commit.rev <= max_rev,
            )
            .order_by(Commit.rev)
        ).scalars()
    )


def first_rebind_after(db: Session, project_id: str, rev: int) -> Commit | None:
    """Earliest rebind commit with ``rev > given`` (or None).

    A rebind commit carries a non-null ``from_metamodel_id``/``to_metamodel_id``.
    Used to resolve the metamodel effective AT ``rev``: the pre-swap
    ``from_metamodel_id`` of the first rebind after ``rev``.
    """
    return db.execute(
        select(Commit)
        .where(
            Commit.project_id == project_id,
            Commit.rev > rev,
            Commit.from_metamodel_id.is_not(None),
        )
        .order_by(Commit.rev)
        .limit(1)
    ).scalar_one_or_none()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_content.py -k "commits_between or first_rebind_after" -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-backend
git add src/data_rover/api/content.py tests/api/test_content.py
git commit -m "feat(api): commits_between + first_rebind_after content queries

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend `reconstruct_model_at` helper

**Files:**
- Modify: `src/data_rover/api/hydration.py`
- Test: `tests/api/test_reconstruct.py` (new)

**Interfaces:**
- Consumes: `content.get_model_row`, `content.get_metamodel_row`, `content.latest_snapshot(max_rev=)`, `content.commits_between`, `content.first_rebind_after` (Task 1), `load_metamodel_str`, `build_model_from_dicts`, `replay_commits_into`, `get_snapshot_store`, `db_session`, core `Model`, core `Session`.
- Produces: `reconstruct_model_at(project_id: str, rev: int) -> Model | None` — returns the core `Model` at `rev`, or `None` for a contentless project. Does NOT touch the live registry session.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_reconstruct.py`:

```python
"""Unit tests for hydration.reconstruct_model_at (historical model state)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from data_rover.api.hydration import reconstruct_model_at
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from tests.api.conftest import (
    AUTH_HEADERS,
    commit_create,
    model_rev,
    papi,
    seed_default_project,
)

_MM = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""


def _client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.post(papi("/metamodel"), content=_MM,
                  headers={"content-type": "application/x-yaml"}).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def test_reconstruct_at_mid_rev_excludes_later_commits() -> None:
    c = _client()
    commit_create(c, "A")          # rev R1
    r1 = model_rev(c)
    commit_create(c, "B")          # rev R2
    m_at_r1 = reconstruct_model_at(DEFAULT_PROJECT_ID, r1)
    m_at_head = reconstruct_model_at(DEFAULT_PROJECT_ID, model_rev(c))
    assert m_at_r1 is not None and m_at_head is not None
    assert len(m_at_r1.elements) == 1     # only A
    assert len(m_at_head.elements) == 2   # A + B


def test_reconstruct_survives_eviction() -> None:
    from data_rover.api.session import get_registry

    c = _client()
    commit_create(c, "A")
    r1 = model_rev(c)
    commit_create(c, "B")
    get_registry().evict(DEFAULT_PROJECT_ID)
    m = reconstruct_model_at(DEFAULT_PROJECT_ID, r1)
    assert m is not None and len(m.elements) == 1


_MM_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Contains
    containment: true
    source: Widget
    target: Widget
"""


def test_reconstruct_before_a_rebind_uses_prior_metamodel() -> None:
    """A rev BEFORE a metamodel swap reconstructs against the pre-swap
    metamodel (first_rebind_after -> from_metamodel_id) and tolerates the
    now-removed 'Node' type via strict=False."""
    c = _client()
    commit_create(c, "A")          # Node element under the original metamodel
    r1 = model_rev(c)
    rebind = c.post(
        papi("/metamodel/rebind") + f"?base_rev={model_rev(c)}&message=swap",
        content=_MM_RENAMED, headers={"content-type": "application/x-yaml"},
    )
    assert rebind.status_code == 200, rebind.text
    # reconstructing at r1 (pre-swap) must still yield the Node element and not
    # raise, even though the CURRENT metamodel no longer defines 'Node'.
    m = reconstruct_model_at(DEFAULT_PROJECT_ID, r1)
    assert m is not None and len(m.elements) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_reconstruct.py -v`
Expected: FAIL with `ImportError: cannot import name 'reconstruct_model_at'`.

- [ ] **Step 3: Implement `reconstruct_model_at`**

Add to `src/data_rover/api/hydration.py` (after `hydrate_session`; imports `Model`, `load_metamodel_str`, `content`, `db_session`, `get_snapshot_store`, `Session`, `json` are already present):

```python
def reconstruct_model_at(project_id: str, rev: int) -> Model | None:
    """Build the model as it existed at ``rev`` (Phase 8 history diffs).

    Mirrors ``hydrate_session`` but bounded to ``rev`` and returning a
    THROWAWAY core ``Model`` — it never touches the registry session or any
    snapshot writes. The base snapshot is built ``strict=False`` under the
    metamodel effective at ``rev`` (see ``first_rebind_after``), so a snapshot
    from a different metamodel era across a rebind still loads; ``computeDiff``
    on the client is purely structural, so the diff stays well-defined.

    Returns ``None`` for a contentless project (no ``ModelRow``).
    """
    with db_session() as s:
        model_row = content.get_model_row(s, project_id)
        if model_row is None:
            return None
        # metamodel effective AT rev: the from-side of the first rebind after
        # rev, else the current binding.
        rebind = content.first_rebind_after(s, project_id, rev)
        mm_id = (
            rebind.from_metamodel_id
            if rebind is not None and rebind.from_metamodel_id is not None
            else model_row.metamodel_id
        )
        mm_row = content.get_metamodel_row(s, mm_id)
        assert mm_row is not None
        snap = content.latest_snapshot(s, project_id, max_rev=rev)
        tail = (
            content.commits_between(s, project_id, after_rev=snap.rev, max_rev=rev)
            if snap is not None
            else []
        )
        snap_key = snap.key if snap is not None else None

    metamodel = load_metamodel_str(mm_row.blob)
    if snap_key is None:
        model = Model(metamodel)
    else:
        from .routes._snapshot import build_model_from_dicts

        raw = json.loads(get_snapshot_store().get(snap_key))
        model = build_model_from_dicts(metamodel, raw, strict=False)

    throwaway = Session(metamodel=metamodel, model=model)
    throwaway.model_rev = rev
    replay_commits_into(throwaway, tail)
    assert throwaway.model is not None
    return throwaway.model
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_reconstruct.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Lint + commit**

```bash
pixi run lint-backend
git add src/data_rover/api/hydration.py tests/api/test_reconstruct.py
git commit -m "feat(api): reconstruct_model_at — historical model state at a rev

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Backend route `GET /commits/{rev}/model`

**Files:**
- Modify: `src/data_rover/api/routes/commits.py`
- Test: `tests/api/test_commit_model_at.py` (new)

**Interfaces:**
- Consumes: `reconstruct_model_at` (Task 2), `ModelOut` (schemas), `content.get_model_row`, `get_request_session`, `get_db`, `JSONResponse`.
- Produces: `GET /api/v1/projects/{project_id}/commits/{rev}/model` → `ModelOut` (200) | 422 out-of-range.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_commit_model_at.py`:

```python
"""Tests for GET /commits/{rev}/model — historical model reconstruction."""

from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from data_rover.api.main import create_app
from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member
from tests.api.conftest import (
    AUTH_HEADERS,
    commit_create,
    model_rev,
    papi,
    seed_default_project,
)

_MM = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.post(papi("/metamodel"), content=_MM,
                  headers={"content-type": "application/x-yaml"}).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def test_model_at_rev_returns_historical_state(client: TestClient) -> None:
    commit_create(client, "A")
    r1 = model_rev(client)
    commit_create(client, "B")
    at_r1 = client.get(papi(f"/commits/{r1}/model"), headers=AUTH_HEADERS)
    assert at_r1.status_code == 200, at_r1.text
    assert len(at_r1.json()["elements"]) == 1
    at_head = client.get(papi(f"/commits/{model_rev(client)}/model"), headers=AUTH_HEADERS)
    assert len(at_head.json()["elements"]) == 2


def test_model_at_rev_out_of_range_422(client: TestClient) -> None:
    commit_create(client, "A")
    r = client.get(papi("/commits/999/model"), headers=AUTH_HEADERS)
    assert r.status_code == 422
    assert r.json()["detail"] == "rev out of range"


def test_model_at_negative_rev_422(client: TestClient) -> None:
    commit_create(client, "A")
    r = client.get(papi("/commits/-1/model"), headers=AUTH_HEADERS)
    assert r.status_code == 422


def test_model_at_rev_readable_by_viewer(client: TestClient) -> None:
    commit_create(client, "A")
    r1 = model_rev(client)
    gen = db.get_db(); s = next(gen)
    try:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    finally:
        gen.close()
    r = client.get(papi(f"/commits/{r1}/model"),
                   headers={"x-user-id": "vw", "x-user-email": "vw@example.com"})
    assert r.status_code == 200
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commit_model_at.py -v`
Expected: FAIL (404 from unknown route, so assertions on 200/422 fail).

- [ ] **Step 3: Implement the route**

In `src/data_rover/api/routes/commits.py`: add `reconstruct_model_at` to the hydration import and `ModelOut` is already imported from `..schemas`. Add the route after `list_commits`:

```python
@router.get("/commits/{rev}/model", response_model=None)
def model_at_rev(
    rev: int,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ModelOut | JSONResponse:
    """Reconstruct the FULL model as it existed at ``rev`` (Phase 8 diffs).

    Read endpoint — any member (history is readable by viewers). O(model)
    response, like GET /model and the /compare page; the client diffs two of
    these with ``computeDiff``. Reconstruction reads durable content directly,
    so it is correct for cold/evicted projects.
    """
    model_row = content.get_model_row(db, project_id)
    head = model_row.model_rev if model_row is not None else 0
    if rev < 0 or rev > head:
        return JSONResponse(
            status_code=422,
            content={"detail": "rev out of range", "model_rev": head},
        )
    model = reconstruct_model_at(project_id, rev)
    if model is None:
        return ModelOut(elements=[], relationships=[])
    return ModelOut.from_core(model)
```

Update the hydration import line to include the new helper:
```python
from ..hydration import deserialize_ops, reconstruct_model_at
```
Add `ModelOut` to the `..schemas` import block if not already present (it is present per Task setup; verify).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_commit_model_at.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Full backend suite + lint + commit**

```bash
pixi run -e core-dev pytest tests/api -q
pixi run lint-backend
git add src/data_rover/api/routes/commits.py tests/api/test_commit_model_at.py
git commit -m "feat(api): GET /commits/{rev}/model — historical model endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Expected: all api tests pass; lint clean.

---

## Task 4: Frontend API client `history.ts` + zod types

**Files:**
- Modify: `frontend/src/lib/api/types.ts`
- Create: `frontend/src/lib/api/history.ts`
- Test: `frontend/src/lib/api/__tests__/history.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `ClientConfig` (from `./client`), `ModelOutSchema`/`ModelOut` and `CommitResponseSchema`/`CommitResponse` (from `./types`).
- Produces:
  - types: `CommitSummary`, `CommitHistoryResponse`.
  - `getCommitHistory(opts?: {limit?: number; beforeRev?: number}, cfg?: ClientConfig): Promise<CommitHistoryResponse>`
  - `getModelAtRev(rev: number, cfg?: ClientConfig): Promise<ModelOut>`
  - `revertToCommit(req: {targetRev: number; baseRev: number; message?: string}, cfg?: ClientConfig): Promise<CommitResponse>`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/api/__tests__/history.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getCommitHistory, getModelAtRev, revertToCommit } from '../history';

function jsonFetch(captured: { path?: string; body?: unknown }, payload: unknown) {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		captured.path = String(input);
		captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	};
}

describe('history api', () => {
	it('getCommitHistory passes limit + before_rev as query', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await getCommitHistory(
			{ limit: 2, beforeRev: 5 },
			{ fetch: jsonFetch(cap, { commits: [], has_more: false }) }
		);
		expect(cap.path).toContain('/commits');
		expect(cap.path).toContain('limit=2');
		expect(cap.path).toContain('before_rev=5');
		expect(res.has_more).toBe(false);
	});

	it('getModelAtRev hits /commits/{rev}/model', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await getModelAtRev(3, {
			fetch: jsonFetch(cap, { elements: [], relationships: [] })
		});
		expect(cap.path).toContain('/commits/3/model');
		expect(res.elements).toEqual([]);
	});

	it('revertToCommit maps camelCase to snake_case body', async () => {
		const cap: { path?: string; body?: unknown } = {};
		await revertToCommit(
			{ targetRev: 2, baseRev: 7, message: 'undo' },
			{
				fetch: jsonFetch(cap, {
					model_rev: 8, id_map: {}, changed_elements: [], changed_relationships: [],
					deleted_element_ids: [], deleted_relationship_ids: [],
					issues_removed_owner_ids: [], issues_added: [], issue_counts: {},
					commit_id: 'c', message: 'undo', validation_error_count: 0
				})
			}
		);
		expect(cap.path).toContain('/commits/revert');
		expect(cap.body).toMatchObject({ target_rev: 2, base_rev: 7, message: 'undo' });
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/history.test.ts'`
Expected: FAIL (cannot resolve `../history`).

- [ ] **Step 3: Add zod schemas/types, then the client**

Append to `frontend/src/lib/api/types.ts` (it already imports `z` and defines `ModelOutSchema`, `CommitResponseSchema`):

```typescript
export const CommitSummarySchema = z.object({
	rev: z.number(),
	commit_id: z.string(),
	author_id: z.string().nullable(),
	ts: z.string(),
	message: z.string(),
	validation_error_count: z.number(),
	op_count: z.number(),
	is_rebind: z.boolean()
});
export type CommitSummary = z.infer<typeof CommitSummarySchema>;

export const CommitHistoryResponseSchema = z.object({
	commits: z.array(CommitSummarySchema),
	has_more: z.boolean()
});
export type CommitHistoryResponse = z.infer<typeof CommitHistoryResponseSchema>;
```

Create `frontend/src/lib/api/history.ts`:

```typescript
import { apiFetch, type ClientConfig } from './client';
import {
	CommitHistoryResponseSchema,
	CommitResponseSchema,
	ModelOutSchema,
	type CommitHistoryResponse,
	type CommitResponse,
	type ModelOut
} from './types';

/** GET /commits — durable commit history, newest-first, paged. */
export function getCommitHistory(
	opts?: { limit?: number; beforeRev?: number },
	cfg?: ClientConfig
): Promise<CommitHistoryResponse> {
	return apiFetch(
		'/commits',
		{
			method: 'GET',
			query: { limit: opts?.limit, before_rev: opts?.beforeRev },
			schema: CommitHistoryResponseSchema
		},
		cfg
	);
}

/** GET /commits/{rev}/model — full model as it existed at `rev`. */
export function getModelAtRev(rev: number, cfg?: ClientConfig): Promise<ModelOut> {
	return apiFetch(`/commits/${rev}/model`, { method: 'GET', schema: ModelOutSchema }, cfg);
}

/** POST /commits/revert — revert-to-commit. Throws ConflictError (409:
 * stale rev / rebind / peer lock) or ValidationError (422: structural). */
export function revertToCommit(
	req: { targetRev: number; baseRev: number; message?: string },
	cfg?: ClientConfig
): Promise<CommitResponse> {
	return apiFetch(
		'/commits/revert',
		{
			method: 'POST',
			body: { target_rev: req.targetRev, base_rev: req.baseRev, message: req.message },
			schema: CommitResponseSchema
		},
		cfg
	);
}
```

Note: confirm `apiFetch` supports a `query` option (model-read.ts uses `query:` — see `listElementRelationships`). If the option name differs, match model-read.ts exactly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/history.test.ts'`
Expected: PASS (3 passed).

- [ ] **Step 5: Check + commit**

```bash
pixi run -e frontend npm run check
git add frontend/src/lib/api/types.ts frontend/src/lib/api/history.ts frontend/src/lib/api/__tests__/history.test.ts
git commit -m "feat(frontend): history API client + commit-summary zod types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend state — UI open-state, commit tap, history store

**Files:**
- Modify: `frontend/src/lib/state/ui.svelte.ts`
- Modify: `frontend/src/lib/state/realtime.svelte.ts`
- Create: `frontend/src/lib/state/history.svelte.ts`
- Test: `frontend/src/lib/state/__tests__/history.test.ts`

**Interfaces:**
- Consumes: `getCommitHistory`, `getModelAtRev` (Task 4); `computeDiff` (`$lib/state/diff`); `handleFeedEvent` dispatch (realtime).
- Produces:
  - ui: `getHistoryDrawerOpen()`, `setHistoryDrawerOpen(open)`.
  - realtime: `onCommitEvent(cb: () => void): () => void` (fired on `commit`/`rebind` feed events).
  - history store (`history.svelte.ts`):
    - `loadFirstPage(): Promise<void>`, `loadMore(): Promise<void>`
    - `getCommits(): CommitSummary[]`, `getHasMore(): boolean`, `getLoading(): boolean`
    - `modelAt(rev: number): Promise<ModelOut>` (cached via `Map<number, ModelOut>`)
    - `resetHistory(): void`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/state/__tests__/history.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/api/history', () => ({
	getCommitHistory: vi.fn(),
	getModelAtRev: vi.fn()
}));
import { getCommitHistory, getModelAtRev } from '$lib/api/history';
import {
	loadFirstPage,
	loadMore,
	getCommits,
	getHasMore,
	modelAt,
	resetHistory
} from '../history.svelte';

function summary(rev: number) {
	return {
		rev, commit_id: `c${rev}`, author_id: null, ts: '2026-01-01T00:00:00Z',
		message: `m${rev}`, validation_error_count: 0, op_count: 1, is_rebind: false
	};
}

beforeEach(() => {
	resetHistory();
	vi.clearAllMocks();
});

describe('history store', () => {
	it('loadFirstPage populates commits + has_more', async () => {
		vi.mocked(getCommitHistory).mockResolvedValue({
			commits: [summary(3), summary(2)], has_more: true
		});
		await loadFirstPage();
		expect(getCommits().map((c) => c.rev)).toEqual([3, 2]);
		expect(getHasMore()).toBe(true);
	});

	it('loadMore appends using before_rev cursor of the last row', async () => {
		vi.mocked(getCommitHistory)
			.mockResolvedValueOnce({ commits: [summary(3), summary(2)], has_more: true })
			.mockResolvedValueOnce({ commits: [summary(1)], has_more: false });
		await loadFirstPage();
		await loadMore();
		expect(getCommits().map((c) => c.rev)).toEqual([3, 2, 1]);
		expect(getHasMore()).toBe(false);
		expect(vi.mocked(getCommitHistory).mock.calls[1][0]).toMatchObject({ beforeRev: 2 });
	});

	it('modelAt caches by rev (one fetch per rev)', async () => {
		vi.mocked(getModelAtRev).mockResolvedValue({ elements: [], relationships: [] });
		await modelAt(5);
		await modelAt(5);
		expect(vi.mocked(getModelAtRev)).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/history.test.ts'`
Expected: FAIL (cannot resolve `../history.svelte`).

- [ ] **Step 3a: Add UI open-state**

Append to `frontend/src/lib/state/ui.svelte.ts` (mirror `_diffDrawerOpen`):

```typescript
let _historyDrawerOpen: boolean = $state(false);

export function getHistoryDrawerOpen(): boolean {
	return _historyDrawerOpen;
}

export function setHistoryDrawerOpen(open: boolean): void {
	_historyDrawerOpen = open;
}
```

- [ ] **Step 3b: Add the commit tap to realtime**

In `frontend/src/lib/state/realtime.svelte.ts`, mirror `_lockTaps`/`onLockEvent`:

```typescript
const _commitTaps = new Set<() => void>();

/** Register a tap fired after every commit/rebind feed event (the history
 * drawer uses this to refetch the first page while open). Returns unsubscribe. */
export function onCommitEvent(cb: () => void): () => void {
	_commitTaps.add(cb);
	return () => _commitTaps.delete(cb);
}
```

Fire it at the end of the `commit` and `rebind` cases in `handleFeedEvent` (after the existing body of each case):

```typescript
			for (const tap of _commitTaps) tap();
```

Add `_commitTaps.clear();` inside `resetRealtime()` next to the existing `_lockTaps.clear();`.

- [ ] **Step 3c: Create the history store**

Create `frontend/src/lib/state/history.svelte.ts`:

```typescript
/**
 * History store for the commit-history browser (Phase 8). Holds the loaded
 * commit page(s), the paging cursor, and a rev->ModelOut reconstruction cache
 * so flipping between diffs does not refetch a rev already materialized.
 */
import { getCommitHistory, getModelAtRev } from '$lib/api/history';
import type { CommitSummary, ModelOut } from '$lib/api/types';

const PAGE = 50;

let _commits: CommitSummary[] = $state([]);
let _hasMore = $state(false);
let _loading = $state(false);
const _modelCache = new Map<number, ModelOut>();

export function getCommits(): CommitSummary[] {
	return _commits;
}
export function getHasMore(): boolean {
	return _hasMore;
}
export function getLoading(): boolean {
	return _loading;
}

export async function loadFirstPage(): Promise<void> {
	_loading = true;
	try {
		const res = await getCommitHistory({ limit: PAGE });
		_commits = res.commits;
		_hasMore = res.has_more;
	} finally {
		_loading = false;
	}
}

export async function loadMore(): Promise<void> {
	if (!_hasMore || _commits.length === 0) return;
	_loading = true;
	try {
		const cursor = _commits[_commits.length - 1].rev;
		const res = await getCommitHistory({ limit: PAGE, beforeRev: cursor });
		_commits = [..._commits, ...res.commits];
		_hasMore = res.has_more;
	} finally {
		_loading = false;
	}
}

/** Model at `rev`, cached. rev < 0 resolves to the empty model (for rev-1 of
 * the baseline commit). */
export async function modelAt(rev: number): Promise<ModelOut> {
	if (rev < 0) return { elements: [], relationships: [] };
	const hit = _modelCache.get(rev);
	if (hit) return hit;
	const m = await getModelAtRev(rev);
	_modelCache.set(rev, m);
	return m;
}

export function resetHistory(): void {
	_commits = [];
	_hasMore = false;
	_loading = false;
	_modelCache.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/history.test.ts'`
Expected: PASS (3 passed).

- [ ] **Step 5: Check + commit**

```bash
pixi run -e frontend npm run check
git add frontend/src/lib/state/ui.svelte.ts frontend/src/lib/state/realtime.svelte.ts frontend/src/lib/state/history.svelte.ts frontend/src/lib/state/__tests__/history.test.ts
git commit -m "feat(frontend): history store + drawer open-state + commit feed tap

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `HistoryDrawer` list mode + TopBar button + mount + live refresh

**Files:**
- Create: `frontend/src/lib/components/HistoryDrawer.svelte`
- Modify: `frontend/src/lib/components/TopBar.svelte`
- Modify: `frontend/src/routes/+page.svelte`
- Test: `frontend/src/lib/components/__tests__/HistoryDrawer.test.ts`

**Interfaces:**
- Consumes: history store (Task 5), `onCommitEvent`, `getHistoryDrawerOpen`/`setHistoryDrawerOpen`, `Dialog` ui primitives, `Button`.
- Produces: `HistoryDrawer.svelte` (default export) with `open` bindable prop; list mode rendering one row per commit. Diff + revert added in Tasks 7–8.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/__tests__/HistoryDrawer.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import HistoryDrawer from '../HistoryDrawer.svelte';

vi.mock('$lib/state/history.svelte', () => ({
	loadFirstPage: vi.fn(async () => {}),
	loadMore: vi.fn(async () => {}),
	getCommits: vi.fn(() => [
		{ rev: 2, commit_id: 'c2', author_id: 'u', ts: '2026-01-01T00:00:00Z',
		  message: 'second', validation_error_count: 0, op_count: 1, is_rebind: false },
		{ rev: 1, commit_id: 'c1', author_id: 'u', ts: '2026-01-01T00:00:00Z',
		  message: 'first', validation_error_count: 2, op_count: 3, is_rebind: true }
	]),
	getHasMore: vi.fn(() => false),
	getLoading: vi.fn(() => false),
	modelAt: vi.fn(),
	resetHistory: vi.fn()
}));
vi.mock('$lib/state/realtime.svelte', () => ({ onCommitEvent: vi.fn(() => () => {}) }));
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return { ...actual, getRole: vi.fn(() => 'owner'), getModelRev: vi.fn(() => 2),
		getStagedDepth: vi.fn(() => 0), getLockState: vi.fn(() => new Map()) };
});

import { loadFirstPage } from '$lib/state/history.svelte';

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

describe('HistoryDrawer list', () => {
	it('loads + lists commits with rebind/issue badges when open', async () => {
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(loadFirstPage).toHaveBeenCalled();
		expect(document.body.textContent).toContain('second');
		expect(document.body.textContent).toContain('first');
		expect(document.body.textContent?.toLowerCase()).toContain('rebind');
		unmount(c);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/HistoryDrawer.test.ts'`
Expected: FAIL (cannot resolve `../HistoryDrawer.svelte`).

- [ ] **Step 3: Implement the drawer (list mode only)**

Create `frontend/src/lib/components/HistoryDrawer.svelte`. (Uses the same `Dialog` primitive pattern as `SwapMetamodelDrawer`; modes `commit-diff`/`compare` are stubbed here and filled in Tasks 7–8.)

```svelte
<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import {
		loadFirstPage,
		loadMore,
		getCommits,
		getHasMore,
		getLoading,
		resetHistory
	} from '$lib/state/history.svelte';
	import { onCommitEvent } from '$lib/state/realtime.svelte';
	import { GitCommitVertical, RefreshCw, AlertTriangle } from '@lucide/svelte';

	type Props = { open: boolean };
	let { open = $bindable(false) }: Props = $props();

	// Load the first page whenever the drawer opens; subscribe to commit feed
	// events for live refresh while open.
	let unsub: (() => void) | null = null;
	$effect(() => {
		if (open) {
			resetHistory();
			loadFirstPage();
			unsub = onCommitEvent(() => loadFirstPage());
		} else {
			unsub?.();
			unsub = null;
		}
		return () => {
			unsub?.();
			unsub = null;
		};
	});

	function fmtTs(ts: string): string {
		const d = new Date(ts);
		return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Commit history</Dialog.Title>
		</Dialog.Header>

		{#if getLoading() && getCommits().length === 0}
			<p class="py-6 text-center text-sm text-zinc-400">Loading…</p>
		{:else if getCommits().length === 0}
			<p class="py-6 text-center text-sm text-zinc-400">No commits yet.</p>
		{:else}
			<ul class="max-h-[60vh] divide-y divide-zinc-800 overflow-y-auto">
				{#each getCommits() as c (c.rev)}
					<li class="flex items-start gap-3 px-1 py-2 text-sm">
						<GitCommitVertical class="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="font-mono text-xs text-zinc-500">r{c.rev}</span>
								<span class="truncate text-zinc-200">{c.message || '(no message)'}</span>
								{#if c.is_rebind}
									<span class="rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-200"
										>rebind</span
									>
								{/if}
								{#if c.validation_error_count > 0}
									<span
										class="flex items-center gap-1 rounded bg-yellow-900/40 px-1.5 py-0.5 text-[10px] text-yellow-200"
									>
										<AlertTriangle class="h-3 w-3" />{c.validation_error_count}
									</span>
								{/if}
							</div>
							<div class="text-[11px] text-zinc-500">
								{c.author_id ?? 'unknown'} · {fmtTs(c.ts)} · {c.op_count}
								{c.op_count === 1 ? 'op' : 'ops'}
							</div>
						</div>
					</li>
				{/each}
			</ul>

			{#if getHasMore()}
				<div class="pt-2 text-center">
					<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => loadMore()}>
						<RefreshCw class="mr-1 h-3 w-3" /> Load more
					</Button>
				</div>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>
```

- [ ] **Step 4: Wire TopBar button + page mount**

In `frontend/src/lib/components/TopBar.svelte`: import the setter and mount-side button. Add to the script imports (alongside `setDiffDrawerOpen`): `setHistoryDrawerOpen` from `$lib/state` (re-export it from `state/index.ts` first — add `getHistoryDrawerOpen`/`setHistoryDrawerOpen` to the ui re-export block). Add a button next to the Commit button:

```svelte
		<Button
			variant="ghost"
			size="sm"
			class="h-7 text-xs focus-visible:ring-2 focus-visible:ring-indigo-500"
			onclick={() => setHistoryDrawerOpen(true)}
		>
			History
		</Button>
```

In `frontend/src/routes/+page.svelte`: mirror the `DiffDrawer` mount. Add import `import HistoryDrawer from '$lib/components/HistoryDrawer.svelte';`, import `getHistoryDrawerOpen`/`setHistoryDrawerOpen`, add a derived mirror like `drawerOpen`:

```svelte
	let historyOpen = $derived(getHistoryDrawerOpen());
	$effect(() => {
		if (historyOpen !== getHistoryDrawerOpen()) setHistoryDrawerOpen(historyOpen);
	});
```

and near `<DiffDrawer ... />`:

```svelte
<HistoryDrawer bind:open={historyOpen} />
```

(Confirm the exact `$derived`/`$effect` mirroring matches how `drawerOpen` is wired in the same file; copy that idiom.)

- [ ] **Step 5: Run test + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/HistoryDrawer.test.ts'`
Expected: PASS (1 passed).

Run: `pixi run -e frontend npm run check`
Expected: no new errors in touched files.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/HistoryDrawer.svelte frontend/src/lib/components/__tests__/HistoryDrawer.test.ts frontend/src/lib/components/TopBar.svelte frontend/src/routes/+page.svelte frontend/src/lib/state/index.ts
git commit -m "feat(frontend): HistoryDrawer list mode + TopBar History button

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Diff modes (per-commit + two-commit compare)

**Files:**
- Modify: `frontend/src/lib/components/HistoryDrawer.svelte`
- Test: `frontend/src/lib/components/__tests__/HistoryDrawer.test.ts`

**Interfaces:**
- Consumes: `modelAt` (Task 5), `computeDiff` (`$lib/state/diff`), `CompareDiff.svelte`.
- Produces: drawer modes `commit-diff` (`diff(modelAt(rev-1), modelAt(rev))`) and `compare` (`diff(modelAt(a), modelAt(b))`), with a rebind banner when the span crosses a rebind, and a Back control.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/components/__tests__/HistoryDrawer.test.ts`. Extend the `$lib/state/history.svelte` mock's `modelAt` and import `computeDiff` is real (do not mock it). Add:

```typescript
import { modelAt } from '$lib/state/history.svelte';

describe('HistoryDrawer diff', () => {
	it('shows a per-commit diff when a row is clicked', async () => {
		vi.mocked(modelAt).mockImplementation(async (rev: number) =>
			rev <= 1
				? { elements: [], relationships: [] }
				: {
						elements: [
							{ id: 'e1', type: 'Node', properties: { label: 'A' } }
						],
						relationships: []
					}
		);
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		// click the "Diff" action on the rev-2 row
		const btn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Diff')
		)!;
		btn.click();
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(modelAt).toHaveBeenCalledWith(2);
		expect(modelAt).toHaveBeenCalledWith(1);
		expect(document.body.textContent).toContain('added');
		unmount(c);
	});
});
```

(Element/relationship shapes must match the `Element`/`Relationship` types in `$lib/api/types`; verify field names — likely `{ id, type, properties }` for elements and `{ id, type, source_id, target_id, properties }` for relationships.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/HistoryDrawer.test.ts'`
Expected: FAIL (no Diff button / mode not implemented).

- [ ] **Step 3: Implement diff modes**

In `HistoryDrawer.svelte` script, add mode state and diff computation:

```typescript
	import CompareDiff from './CompareDiff.svelte';
	import { computeDiff, type Diff } from '$lib/state/diff';
	import { modelAt, getCommits as _allCommits } from '$lib/state/history.svelte';
	import { ArrowLeft } from '@lucide/svelte';

	type Mode = 'list' | 'diff';
	let mode = $state<Mode>('list');
	let diff = $state<Diff | null>(null);
	let diffTitle = $state('');
	let diffError = $state<string | null>(null);
	let spanRebind = $state(false); // does the current diff span a rebind commit?
	let compareFrom = $state<number | null>(null); // selected first rev for 2-commit compare

	function spanCrossesRebind(lo: number, hi: number): boolean {
		return _allCommits().some((c) => c.is_rebind && c.rev > lo && c.rev <= hi);
	}

	async function showDiff(fromRev: number, toRev: number, title: string): Promise<void> {
		mode = 'diff';
		diff = null;
		diffError = null;
		diffTitle = title;
		spanRebind = spanCrossesRebind(fromRev, toRev);
		try {
			const [from, to] = await Promise.all([modelAt(fromRev), modelAt(toRev)]);
			diff = computeDiff(from, to);
		} catch (e) {
			diffError = e instanceof Error ? e.message : 'Failed to load diff';
		}
	}

	function diffCommit(rev: number): void {
		showDiff(rev - 1, rev, `Changes in r${rev}`);
	}

	function pickCompare(rev: number): void {
		if (compareFrom === null) {
			compareFrom = rev;
		} else {
			const lo = Math.min(compareFrom, rev);
			const hi = Math.max(compareFrom, rev);
			compareFrom = null;
			showDiff(lo, hi, `r${lo} → r${hi}`);
		}
	}

	function backToList(): void {
		mode = 'list';
		diff = null;
		compareFrom = null;
		spanRebind = false;
	}
```

Add, per row in the list, two actions (a `Diff` button calling `diffCommit(c.rev)` and a `Compare` toggle button calling `pickCompare(c.rev)` whose label shows "Select B" when `compareFrom !== null && compareFrom !== c.rev`, or "Selected" when `compareFrom === c.rev`). Render a diff view block when `mode === 'diff'`:

```svelte
{#if mode === 'diff'}
	<div class="space-y-2">
		<button class="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200" onclick={backToList}>
			<ArrowLeft class="h-3 w-3" /> Back
		</button>
		<h3 class="text-sm text-zinc-200">{diffTitle}</h3>
		{#if spanRebind}
			<div class="rounded border border-amber-700 bg-amber-900/30 px-2 py-1 text-[11px] text-amber-200">
				These revisions use different metamodels; the diff is structural.
			</div>
		{/if}
		{#if diffError}
			<p class="text-sm text-red-300">{diffError}</p>
		{:else if diff === null}
			<p class="text-sm text-zinc-400">Computing diff…</p>
		{:else}
			<CompareDiff {diff} unchangedHidden={0} />
		{/if}
	</div>
{:else}
	<!-- existing list markup -->
{/if}
```

The rebind banner is gated on `spanRebind`, set in `showDiff` via `spanCrossesRebind(fromRev, toRev)` and cleared in `backToList`. Confirm `CompareDiff` prop names against the component (`diff`, `unchangedHidden`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/HistoryDrawer.test.ts'`
Expected: PASS (all in file).

- [ ] **Step 5: Check + commit**

```bash
pixi run -e frontend npm run check
git add frontend/src/lib/components/HistoryDrawer.svelte frontend/src/lib/components/__tests__/HistoryDrawer.test.ts
git commit -m "feat(frontend): per-commit + two-commit diff in HistoryDrawer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Revert flow (gating, confirm, error mapping)

**Files:**
- Modify: `frontend/src/lib/components/HistoryDrawer.svelte`
- Test: `frontend/src/lib/components/__tests__/HistoryDrawer.test.ts`

**Interfaces:**
- Consumes: `revertToCommit` (Task 4), `getRole`/`getModelRev`/`getStagedDepth`/`getLockState`/`applyDelta` (`$lib/state`), `ConflictError`/`ValidationError` (`$lib/api`).
- Produces: a gated "Revert to here" action per row → confirmation → `revertToCommit` → `applyDelta` + back to list; error mapping for 409/422.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/components/__tests__/HistoryDrawer.test.ts`. Add a mock for `$lib/api/history`'s `revertToCommit` and `$lib/api`'s error classes (use the real classes — `vi.mock` only the history module):

```typescript
vi.mock('$lib/api/history', async (orig) => {
	const actual = await orig<typeof import('$lib/api/history')>();
	return { ...actual, revertToCommit: vi.fn() };
});
import { revertToCommit } from '$lib/api/history';
import { applyDelta, getStagedDepth } from '$lib/state';
import { ConflictError } from '$lib/api';

describe('HistoryDrawer revert', () => {
	it('reverts to a rev, applies the delta, returns to list', async () => {
		vi.mocked(getStagedDepth).mockReturnValue(0);
		vi.mocked(revertToCommit).mockResolvedValue({
			model_rev: 3, id_map: {}, changed_elements: [], changed_relationships: [],
			deleted_element_ids: [], deleted_relationship_ids: [],
			issues_removed_owner_ids: [], issues_added: [], issue_counts: {},
			commit_id: 'c3', message: 'Revert to rev 1', validation_error_count: 0
		});
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync(); await Promise.resolve(); flushSync();
		// open revert confirm on the rev-1 row, then confirm
		const revertBtn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Revert'))!;
		revertBtn.click(); flushSync();
		const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.trim() === 'Revert' || b.textContent?.includes('Confirm'))!;
		confirmBtn.click();
		await Promise.resolve(); flushSync();
		expect(revertToCommit).toHaveBeenCalled();
		expect(applyDelta).toHaveBeenCalled();
		unmount(c);
	});

	it('blocks revert when there are staged edits', async () => {
		vi.mocked(getStagedDepth).mockReturnValue(2);
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync(); await Promise.resolve(); flushSync();
		const revertBtn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Revert'))!;
		revertBtn.click(); flushSync();
		expect(document.body.textContent?.toLowerCase()).toContain('commit or discard');
		expect(revertToCommit).not.toHaveBeenCalled();
		unmount(c);
	});
});
```

(Adjust the confirm-button matcher to whatever label the implementation uses; keep it consistent between test and component.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/HistoryDrawer.test.ts'`
Expected: FAIL (no revert action).

- [ ] **Step 3: Implement the revert flow**

In `HistoryDrawer.svelte` add imports and state:

```typescript
	import { revertToCommit } from '$lib/api/history';
	import { getRole, getModelRev, getStagedDepth, getLockState, applyDelta } from '$lib/state';
	import { ConflictError, ValidationError } from '$lib/api';

	const canWrite = $derived(getRole() === 'owner' || getRole() === 'editor');
	const quiet = $derived(getStagedDepth() === 0 && getLockState().size === 0);

	let confirmRev = $state<number | null>(null);
	let revertMsg = $state('');
	let reverting = $state(false);
	let revertError = $state<string | null>(null);

	function askRevert(rev: number): void {
		revertError = null;
		if (!quiet) {
			revertError = 'Commit or discard your changes first.';
			confirmRev = rev; // still surface the notice in the dialog
			return;
		}
		confirmRev = rev;
		revertMsg = `Revert to rev ${rev}`;
	}

	async function doRevert(): Promise<void> {
		if (confirmRev === null || !quiet) return;
		reverting = true;
		revertError = null;
		try {
			const res = await revertToCommit({
				targetRev: confirmRev,
				baseRev: getModelRev(),
				message: revertMsg || undefined
			});
			applyDelta(res);
			confirmRev = null;
			backToList();
		} catch (e) {
			if (e instanceof ConflictError) {
				const body = e.body as { detail?: string; rebind_rev?: number; conflicts?: unknown[] };
				if (body?.rebind_rev !== undefined)
					revertError = `Can't revert across a metamodel swap (rev ${body.rebind_rev}).`;
				else if (body?.conflicts) revertError = 'A peer holds a lock on an affected resource.';
				else revertError = 'History moved — reload and retry.';
			} else if (e instanceof ValidationError) {
				revertError = 'Revert would leave a structural error and was rejected.';
			} else {
				revertError = e instanceof Error ? e.message : 'Revert failed.';
			}
		} finally {
			reverting = false;
		}
	}
```

Add a per-row "Revert" button gated by `{#if canWrite}` calling `askRevert(c.rev)`. Render a confirm panel when `confirmRev !== null`:

```svelte
{#if confirmRev !== null}
	<div class="mt-2 rounded border border-zinc-700 bg-zinc-900/60 p-3 text-sm">
		<p class="text-zinc-200">
			Revert to rev {confirmRev}? Revisions after r{confirmRev} are discarded as state
			(history is preserved).
		</p>
		{#if revertError}
			<p class="mt-1 text-xs text-red-300">{revertError}</p>
		{/if}
		{#if quiet}
			<input
				class="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
				bind:value={revertMsg}
				placeholder="Commit message"
			/>
		{/if}
		<div class="mt-2 flex justify-end gap-2">
			<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => (confirmRev = null)}>
				Cancel
			</Button>
			<Button
				size="sm"
				class="h-7 text-xs"
				disabled={!quiet || reverting}
				onclick={() => doRevert()}
			>
				Revert
			</Button>
		</div>
	</div>
{/if}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/__tests__/HistoryDrawer.test.ts'`
Expected: PASS (all in file).

- [ ] **Step 5: Full frontend suite + check + commit**

```bash
pixi run -e frontend bash -c 'cd frontend && npx vitest run'
pixi run -e frontend npm run check
git add frontend/src/lib/components/HistoryDrawer.svelte frontend/src/lib/components/__tests__/HistoryDrawer.test.ts
git commit -m "feat(frontend): revert-to-commit flow in HistoryDrawer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Expected: full vitest suite green; svelte-check clean on touched files.

---

## Task 9: E2E smoke + README

**Files:**
- Modify: `frontend/e2e/` (add a smoke spec next to the existing one) or extend the existing smoke.
- Modify: `frontend/README.md`

**Interfaces:**
- Consumes: the running backend + dev server (Playwright config boots both).
- Produces: a smoke verifying History → list → diff → revert; README docs.

- [ ] **Step 1: Add the Playwright smoke**

Locate the existing e2e spec (`frontend/e2e/*.spec.ts`) and mirror its setup (load metamodel from file → empty model → add element → commit). Add a test that: opens the History drawer (click "History"), asserts at least one commit row is visible, clicks a row's "Diff" and asserts the CompareDiff header renders ("added"/"modified"/"deleted"), then clicks "Revert" + "Revert" confirm and asserts the model reflects the reverted state. Use the existing spec's selectors/utilities; do not invent a new harness.

- [ ] **Step 2: Run the e2e smoke**

Run: `pixi run -e frontend bash -c 'cd frontend && npx playwright install chromium && npm run test:e2e'`
Expected: PASS (existing + new smoke green).

- [ ] **Step 3: Update README**

In `frontend/README.md`, under "Architecture" / "Where to find things", document: a **History** drawer (TopBar) browsing durable commits (`GET /commits`), per-commit and any-two-commit diffs via historical model reconstruction (`GET /commits/{rev}/model` + `computeDiff`/`CompareDiff`), and revert-to-commit (`POST /commits/revert`) gated on a clean staged buffer. Add `HistoryDrawer.svelte` and `state/history.svelte.ts` to the file map.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e frontend/README.md
git commit -m "test(frontend): e2e smoke for history browser + revert; README

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `pixi run -e core-dev pytest tests/api -q` — all pass.
- [ ] `pixi run -e core-dev pytest tests/ -q` — core unaffected.
- [ ] `pixi run lint-backend` — ruff + mypy + pyright clean.
- [ ] `pixi run -e frontend bash -c 'cd frontend && npx vitest run'` — all pass.
- [ ] `pixi run -e frontend npm run check` — no NEW errors in touched files.
- [ ] Manual (optional): `pixi run start-backend` + `pixi run start-frontend`, open History, diff a commit, compare two commits, revert, confirm live model update.

## Notes for the implementer

- The historical-model endpoint is **O(model)** — same tradeoff the `/compare` page already documents. Do not optimize prematurely; the client rev→model cache (Task 5) covers repeat fetches.
- `computeDiff`'s second arg is typed `Snapshot`, but `ModelOut` is structurally compatible (both `{elements[], relationships[]}`) — the `/compare` page already passes a `ModelOut` there. Follow that precedent.
- Verify `apiFetch`'s query-param option name against `model-read.ts` before relying on `query:` (Task 4 Step 3).
- Confirm `Element`/`Relationship` field names in `$lib/api/types` before writing diff-mode test fixtures (Task 7).
- Do not push; the branch is integrated via finishing-a-development-branch at the end.
```
