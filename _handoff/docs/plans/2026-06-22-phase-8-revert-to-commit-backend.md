# Phase 8 (backend) — Revert-to-commit + durable commit history — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable commit-history list endpoint and a revert-to-commit endpoint to the FastAPI backend, reusing the existing compensating-commit machinery.

**Architecture:** Revert applies the `inverse_ops` of every commit after the target, newest-first, in restore mode, recorded as one new forward commit (the proven `POST /model/undo` shape, generalized to a range). History is a paged read over the durable `commits` table. Backend-only; no frontend.

**Tech Stack:** Python 3.14 runtime (pyright floor 3.10), FastAPI, SQLAlchemy 2.0 (sync), Pydantic v2, pytest with in-memory SQLite (`tests/api/conftest.py`). Everything runs through `pixi`.

## Global Constraints

- Run everything through **pixi** — no global `python`. Tests: `pixi run -e core-dev pytest tests/api/<file>::<test> -v`. Lint/type: `pixi run lint-backend` (ruff + mypy + pyright — all three must pass).
- **Python floor is 3.10** for pyright even though runtime is 3.14 — import `Self`/`assert_never` from `typing_extensions`, not `typing`. Use `X | None` unions (fine on 3.10).
- API tests need **no DB service** — `tests/api/conftest.py` forces in-memory SQLite, `MemorySnapshotStore`, idle-evict + lock-sweep disabled, dev-seed off.
- Data-route tests use the `client` fixture + `AUTH_HEADERS` / `papi(...)` / `seed_default_project()` helpers from `tests/api/conftest.py`. The test user `test-user` is an **owner** of the `default` project.
- **No Alembic migration** — every column read/written already exists on `commits` (revisions 0001–0003).
- Preserve the codebase's dense "why" docstrings on invariant-carrying code (mutation boundary, append-only journal, in-place rollback).
- Commit message trailer: end each commit body with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File map

- `src/data_rover/api/content.py` — **modify**: add `list_commits(...)` query (sibling of `commits_after`).
- `src/data_rover/api/schemas.py` — **modify**: add `CommitSummaryOut`, `CommitHistoryResponse`, `RevertRequest`.
- `src/data_rover/api/routes/commits.py` — **modify**: add `GET /commits` (history), `POST /commits/revert`, and the module-private `_affected_ids(...)` helper.
- `tests/api/test_commit_history.py` — **create**: history-list tests.
- `tests/api/test_commits_revert.py` — **create**: revert tests.
- `tests/api/test_content.py` — **modify or create**: unit test for `content.list_commits` (if the file does not exist, create it).

---

### Task 1: `content.list_commits` query

**Files:**
- Modify: `src/data_rover/api/content.py`
- Test: `tests/api/test_content.py`

**Interfaces:**
- Consumes: `Commit` ORM model (`src/data_rover/api/db_models.py`), `Session` (SQLAlchemy).
- Produces: `content.list_commits(db: Session, project_id: str, *, before_rev: int | None, limit: int) -> list[Commit]` — commits for the project in **rev-descending** order; when `before_rev` is set, only commits with `rev < before_rev`; at most `limit` rows.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_content.py` (or append if it exists):

```python
from __future__ import annotations

from data_rover.api import content, db
from data_rover.api.db_models import Commit, Project


def _seed_project_with_commits(n: int) -> None:
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(Project(id="p1", name="P1"))
        for rev in range(1, n + 1):
            s.add(
                Commit(
                    project_id="p1",
                    rev=rev,
                    commit_id=f"c{rev}",
                    author_id=None,
                    ops=[{"kind": "delete_element", "id": f"e{rev}"}],
                    inverse_ops=[],
                    id_map={},
                    message=f"commit {rev}",
                )
            )
        s.commit()
    finally:
        gen.close()


def test_list_commits_is_rev_descending_and_limited() -> None:
    _seed_project_with_commits(5)
    gen = db.get_db()
    s = next(gen)
    try:
        rows = content.list_commits(s, "p1", before_rev=None, limit=3)
    finally:
        gen.close()
    assert [r.rev for r in rows] == [5, 4, 3]


def test_list_commits_before_rev_cursor() -> None:
    _seed_project_with_commits(5)
    gen = db.get_db()
    s = next(gen)
    try:
        rows = content.list_commits(s, "p1", before_rev=3, limit=10)
    finally:
        gen.close()
    assert [r.rev for r in rows] == [2, 1]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_content.py -v`
Expected: FAIL with `AttributeError: module 'data_rover.api.content' has no attribute 'list_commits'`.

- [ ] **Step 3: Write minimal implementation**

In `src/data_rover/api/content.py`, near `commits_after` (use the existing import style — the file already imports `select` and `Commit`):

```python
def list_commits(
    db: Session, project_id: str, *, before_rev: int | None, limit: int
) -> list[Commit]:
    """Durable commit history for a project, newest-first.

    The page-by cursor is ``before_rev`` (exclusive): pass the smallest ``rev``
    of the previous page to fetch the next, older page. Distinct from
    ``commits_after`` (ascending replay tail used by hydration) — this is the
    descending read for a history browser.
    """
    q = select(Commit).where(Commit.project_id == project_id)
    if before_rev is not None:
        q = q.where(Commit.rev < before_rev)
    q = q.order_by(Commit.rev.desc()).limit(limit)
    return list(db.execute(q).scalars())
```

If `content.py` does not already import `select`/`Commit`, add them to the existing imports (check the top of the file — `commits_after` already uses both, so they are present).

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_content.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/content.py tests/api/test_content.py
git commit -m "feat(api): content.list_commits — descending paged history query"
```

---

### Task 2: `GET /commits` durable history endpoint

**Files:**
- Modify: `src/data_rover/api/schemas.py`
- Modify: `src/data_rover/api/routes/commits.py`
- Test: `tests/api/test_commit_history.py`

**Interfaces:**
- Consumes: `content.list_commits(...)` (Task 1); the `commits` router mounted under `/api/v1/projects/{project_id}` (existing).
- Produces:
  - `schemas.CommitSummaryOut` — fields `rev: int`, `commit_id: str`, `author_id: str | None`, `ts: datetime`, `message: str`, `validation_error_count: int`, `op_count: int`, `is_rebind: bool`.
  - `schemas.CommitHistoryResponse` — `commits: list[CommitSummaryOut]`, `has_more: bool`.
  - `GET /api/v1/projects/{project_id}/commits?limit&before_rev` → `CommitHistoryResponse`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_commit_history.py`:

```python
"""Tests for GET /commits — durable commit history list."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
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
    assert c.post(
        papi("/metamodel"), content=_MM,
        headers={"content-type": "application/x-yaml"},
    ).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def _commit_create(c: TestClient) -> None:
    """Append a commit via the legacy ops path (also writes a Commit row)."""
    r = c.post(
        papi("/model/ops"),
        json={
            "base_rev": _rev(c),
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_n",
                 "type_name": "Node", "properties": {}}
            ],
        },
    )
    assert r.status_code == 200, r.text


def test_history_lists_commits_newest_first(client: TestClient) -> None:
    _commit_create(client)
    _commit_create(client)
    r = client.get(papi("/commits"), headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    body = r.json()
    revs = [c["rev"] for c in body["commits"]]
    assert revs == sorted(revs, reverse=True)
    assert revs[0] == _rev(client)
    top = body["commits"][0]
    assert top["op_count"] == 1
    assert top["is_rebind"] is False
    assert "author_id" in top and "ts" in top and "message" in top


def test_history_pagination_has_more(client: TestClient) -> None:
    for _ in range(3):
        _commit_create(client)
    page1 = client.get(papi("/commits"), params={"limit": 2}, headers=AUTH_HEADERS).json()
    assert len(page1["commits"]) == 2
    assert page1["has_more"] is True
    cursor = page1["commits"][-1]["rev"]
    page2 = client.get(
        papi("/commits"), params={"limit": 2, "before_rev": cursor}, headers=AUTH_HEADERS
    ).json()
    assert all(c["rev"] < cursor for c in page2["commits"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commit_history.py -v`
Expected: FAIL — 404 from the missing route (assertion on `status_code == 200`).

- [ ] **Step 3a: Add the schemas**

In `src/data_rover/api/schemas.py` (the file already imports `datetime` for other Out models — if not, add `from datetime import datetime`):

```python
class CommitSummaryOut(BaseModel):
    """One row in the durable commit-history list (GET /commits)."""

    rev: int
    commit_id: str
    author_id: str | None
    ts: datetime
    message: str
    validation_error_count: int
    op_count: int
    is_rebind: bool


class CommitHistoryResponse(BaseModel):
    commits: list[CommitSummaryOut]
    has_more: bool
```

- [ ] **Step 3b: Add the route**

In `src/data_rover/api/routes/commits.py`: add `from .. import content` to the imports, extend the `schemas` import block with `CommitHistoryResponse, CommitSummaryOut`, and add the handler (place it above `create_commit`):

```python
@router.get("/commits", response_model=None)
def list_commits(
    project_id: str,
    limit: int = 50,
    before_rev: int | None = None,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> CommitHistoryResponse:
    """Durable commit history, newest-first (distinct from GET /model/changes,
    which reports the capped in-memory op_log). Read endpoint — any member."""
    limit = max(1, min(limit, 200))
    rows = content.list_commits(db, project_id, before_rev=before_rev, limit=limit + 1)
    has_more = len(rows) > limit
    rows = rows[:limit]
    return CommitHistoryResponse(
        commits=[
            CommitSummaryOut(
                rev=r.rev,
                commit_id=r.commit_id,
                author_id=r.author_id,
                ts=r.ts,
                message=r.message,
                validation_error_count=r.validation_error_count,
                op_count=len(r.ops),
                is_rebind=(r.from_metamodel_id is not None
                           or r.to_metamodel_id is not None),
            )
            for r in rows
        ],
        has_more=has_more,
    )
```

Note: the route depends on `get_request_session`, which depends on `require_membership` — so a read is authorized for any member. No write-allowlist change needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_commit_history.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the rebind + viewer tests**

Append to `tests/api/test_commit_history.py`:

```python
_MM_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Contains
    containment: true
    source: Widget
    target: Widget
"""


def test_history_marks_rebind_commit(client: TestClient) -> None:
    _commit_create(client)
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={_rev(client)}&message=swap",
        content=_MM_RENAMED, headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    body = client.get(papi("/commits"), headers=AUTH_HEADERS).json()
    top = body["commits"][0]
    assert top["is_rebind"] is True


def test_history_readable_by_viewer(client: TestClient) -> None:
    from data_rover.api import db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    finally:
        gen.close()
    r = client.get(
        papi("/commits"),
        headers={"x-user-id": "vw", "x-user-email": "vw@example.com"},
    )
    assert r.status_code == 200
```

(Verify `add_member`'s real name/signature against `src/data_rover/api/tenancy.py` before running — it is the member-create service function. If the signature differs, adapt the call. The same `add_member` import is reused in Task 8's viewer test.)

- [ ] **Step 6: Run the full history test file**

Run: `pixi run -e core-dev pytest tests/api/test_commit_history.py -v`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/commits.py tests/api/test_commit_history.py
git commit -m "feat(api): GET /commits — durable commit-history list"
```

---

### Task 3: `_affected_ids` helper + `RevertRequest` schema

**Files:**
- Modify: `src/data_rover/api/schemas.py`
- Modify: `src/data_rover/api/routes/commits.py`
- Test: `tests/api/test_commits_revert.py`

**Interfaces:**
- Consumes: `Commit` ORM rows (with `.ops` as a list of JSON op dicts).
- Produces:
  - `schemas.RevertRequest` — `target_rev: int`, `base_rev: int`, `message: str | None = None`.
  - `routes.commits._affected_ids(commits: list[Commit]) -> set[str]` — every element/relationship id named by the forward `ops` of the given commits (reads `id`, `temp_id`, `source_id`, `target_id`; canonical ops store **real** ids in all of these — a create op's `temp_id` field holds the assigned canonical id).

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_commits_revert.py` with just the helper test for now:

```python
"""Tests for POST /commits/revert and the _affected_ids helper."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.db_models import Commit
from data_rover.api.main import create_app
from data_rover.api.routes.commits import _affected_ids

from .conftest import AUTH_HEADERS, papi, seed_default_project


def test_affected_ids_collects_real_ids_from_forward_ops() -> None:
    commits = [
        Commit(
            project_id="p", rev=1, commit_id="c1", author_id=None,
            ops=[{"kind": "create_element", "temp_id": "E1",
                  "type_name": "Node", "properties": {}}],
            inverse_ops=[], id_map={}, message="",
        ),
        Commit(
            project_id="p", rev=2, commit_id="c2", author_id=None,
            ops=[{"kind": "create_relationship", "temp_id": "R1",
                  "type_name": "Contains", "source_id": "E1",
                  "target_id": "E2", "properties": {}},
                 {"kind": "delete_element", "id": "E9"}],
            inverse_ops=[], id_map={}, message="",
        ),
    ]
    assert _affected_ids(commits) == {"E1", "E2", "E9", "R1"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -v`
Expected: FAIL with `ImportError: cannot import name '_affected_ids'`.

- [ ] **Step 3a: Add the schema**

In `src/data_rover/api/schemas.py`:

```python
class RevertRequest(BaseModel):
    """Revert the model to the state at ``target_rev`` (Phase 8).

    ``base_rev`` is the client's last-seen ``model_rev`` for optimistic-
    concurrency (409 on mismatch). ``target_rev`` must be in ``[0, model_rev]``.
    """

    target_rev: int
    base_rev: int
    message: str | None = None
```

- [ ] **Step 3b: Add the helper**

In `src/data_rover/api/routes/commits.py` (after the imports, before the routes):

```python
#: op-dict keys that carry a resource id. In CANONICAL stored ops every one of
#: these holds a real id — a create op's ``temp_id`` was rewritten to the
#: assigned canonical id at apply time (see session.py / _apply_one).
_ID_KEYS = ("id", "temp_id", "source_id", "target_id")


def _affected_ids(commits: list[Commit]) -> set[str]:
    """Resource ids touched by the forward ops of these commits.

    Used by revert's peer-lock guard: any active lease over one of these ids
    means a peer is mid-edit on something the revert would change, so the
    revert is refused (409) rather than stomping their uncommitted work.
    """
    ids: set[str] = set()
    for c in commits:
        for op in c.ops:
            for key in _ID_KEYS:
                v = op.get(key)
                if isinstance(v, str):
                    ids.add(v)
    return ids
```

Add `from ..db_models import Commit` to the existing `db_models` import line (it currently imports `Membership, User`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -v`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/commits.py tests/api/test_commits_revert.py
git commit -m "feat(api): RevertRequest schema + _affected_ids helper"
```

---

### Task 4: `POST /commits/revert` — core happy path

**Files:**
- Modify: `src/data_rover/api/routes/commits.py`
- Test: `tests/api/test_commits_revert.py`

**Interfaces:**
- Consumes: `content.commits_after`, `content.list_commits` (Task 1/2); `_affected_ids` + `RevertRequest` (Task 3); from `routes/ops.py`: `_apply_batch`, `_rollback`, `_ensure_validation_seeded`, `_persist_commit`, `_maybe_periodic_snapshot`; from `..hydration`: `deserialize_ops`; `default_pipeline`, `IssueCategory`; `session.record_batch`, `AppliedBatch`; `state.replace`.
- Produces: `POST /api/v1/projects/{project_id}/commits/revert` (body `RevertRequest`) → `CommitResponse`. This task implements the **happy path only** (no guards beyond what the happy path needs; guards are Tasks 5–7, broadcast is Task 8).

Append the shared client fixture + revert helpers to `tests/api/test_commits_revert.py` first (used by Tasks 4–8):

```python
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
    assert c.post(
        papi("/metamodel"), content=_MM,
        headers={"content-type": "application/x-yaml"},
    ).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def _count(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["element_count"]


def _commit_create(c: TestClient, label: str) -> str:
    """Create a Node via the legacy ops path; return its canonical id."""
    r = c.post(
        papi("/model/ops"),
        json={
            "base_rev": _rev(c),
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_n",
                 "type_name": "Node", "properties": {"label": label}}
            ],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id_map"]["tmp_n"]
```

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_commits_revert.py`:

```python
def test_revert_restores_earlier_state(client: TestClient) -> None:
    a = _commit_create(client, "A")        # rev 1
    target = _rev(client)                  # == 1
    b = _commit_create(client, "B")        # rev 2
    assert _count(client) == 2
    r = client.post(
        papi("/commits/revert"),
        headers=AUTH_HEADERS,
        json={"target_rev": target, "base_rev": _rev(client)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_rev"] == 3          # revert is itself a new commit
    assert _count(client) == 1             # B removed, A kept
    assert b in body["deleted_element_ids"]
    assert a not in body["deleted_element_ids"]


def test_revert_the_revert_returns_to_head(client: TestClient) -> None:
    _commit_create(client, "A")            # rev 1
    target = _rev(client)
    _commit_create(client, "B")            # rev 2
    head_count = _count(client)            # 2
    revert = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": target, "base_rev": _rev(client)},
    )
    assert revert.status_code == 200, revert.text
    assert _count(client) == 1
    # revert the revert: target = the revert's pre-state is rev 2, so revert
    # back to rev 2's content by reverting to... revert to rev 2 (the state
    # before the first revert). target_rev = 2.
    r2 = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": 2, "base_rev": _rev(client)},
    )
    assert r2.status_code == 200, r2.text
    assert _count(client) == head_count    # back to 2 elements
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -v`
Expected: FAIL — 404 (route missing) → assertion on `status_code == 200`.

- [ ] **Step 3: Write the route**

In `src/data_rover/api/routes/commits.py`:
- Add to imports: `from ..hydration import deserialize_ops`; extend the `schemas` import block with `RevertRequest`.
- Add the handler (place after `create_commit`):

```python
@router.post("/commits/revert", response_model=None)
def revert_commit(
    payload: RevertRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CommitResponse | JSONResponse:
    """Revert the model to the state at ``target_rev`` (Phase 8 spec §3.2).

    Mechanism (the proven POST /model/undo compensating-commit shape, applied
    to a *range*): apply the inverse_ops of every commit after target_rev,
    newest-first, in restore mode, recorded as ONE new forward commit. The
    journal stays append-only; model_rev only moves forward; the revert is
    itself revertible.

    Guards (Tasks 5–7) are layered on top of this core; broadcast is Task 8.
    """
    _, model = require_model(session)
    state = _ensure_validation_seeded(session, model)
    with session.write_mutex:
        commits = content.commits_after(db, project_id, payload.target_rev)
        # apply inverse_ops newest-first; deserialize the stored JSON op dicts
        combined = deserialize_ops(
            [op for c in reversed(commits) for op in c.inverse_ops]
        )
        res = _apply_batch(model, combined, restore=True)
        scoped = default_pipeline().validate(model, res.dirty.to_scope())
        structural = [i for i in scoped if i.category is IssueCategory.STRUCTURAL]
        if structural:
            _rollback(model, res.inverse_units)
            return JSONResponse(
                status_code=422,
                content={
                    "detail": "structural validation blocker",
                    "structural_blockers": [
                        IssueOut.from_core(i).model_dump() for i in structural
                    ],
                },
            )
        conformance = [i for i in scoped if i.category is IssueCategory.CONFORMANCE]
        delta = state.replace(res.dirty.ids, scoped)
        session.model_rev += 1
        session.record_batch(
            AppliedBatch(
                ops=res.canonical_ops,
                inverse_ops=res.inverse_ops(),
                id_map=dict(res.id_map),
            )
        )
        commit_id = uuid.uuid4().hex
        message = payload.message or f"Revert to rev {payload.target_rev}"
        issues_json = [IssueOut.from_core(i).model_dump() for i in conformance]
        try:
            persisted = _persist_commit(
                db, project_id, rev=session.model_rev, author_id=user.id, res=res,
                _commit_id=commit_id, _message=message,
                _validation_error_count=len(conformance), _issues=issues_json,
            )
        except Exception as exc:
            _rollback(model, res.inverse_units)
            session.model_rev -= 1
            session.op_log.pop()
            db.rollback()
            raise HTTPException(
                status_code=500, detail="failed to persist commit"
            ) from exc
        if persisted:
            try:
                _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
            except Exception:
                logger.warning(
                    "post-revert snapshot failed for project %s at rev %s; "
                    "commit is durable, hydration will rebuild",
                    project_id, session.model_rev, exc_info=True,
                )
    return CommitResponse(
        model_rev=session.model_rev,
        id_map=dict(res.id_map),
        changed_elements=[
            ElementOut.from_core(model.elements[eid])
            for eid in res.changed_element_ids
        ],
        changed_relationships=[
            RelationshipOut.from_core(model.relationships[rid])
            for rid in res.changed_relationship_ids
        ],
        deleted_element_ids=list(res.deleted_element_ids),
        deleted_relationship_ids=list(res.deleted_relationship_ids),
        issues_removed_owner_ids=delta.removed_owner_ids,
        issues_added=[IssueOut.from_core(i) for i in delta.added],
        issue_counts=state.counts(),
        commit_id=commit_id,
        message=message,
        validation_error_count=len(conformance),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -v`
Expected: PASS (helper test from Task 3 + the two new revert tests).

- [ ] **Step 5: Add the journal-correctness (eviction) + DB-failure tests**

Append to `tests/api/test_commits_revert.py`:

```python
def test_revert_survives_eviction(client: TestClient) -> None:
    from data_rover.api.session import get_registry
    from data_rover.api.session import DEFAULT_PROJECT_ID

    _commit_create(client, "A")            # rev 1
    target = _rev(client)
    _commit_create(client, "B")            # rev 2
    assert client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": target, "base_rev": _rev(client)},
    ).status_code == 200
    assert _count(client) == 1
    get_registry().evict(DEFAULT_PROJECT_ID)        # snapshot-then-drop
    assert _count(client) == 1                       # re-hydrate from journal


def test_revert_db_failure_rolls_back_in_memory(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import data_rover.api.routes.commits as commits_mod

    _commit_create(client, "A")            # rev 1
    target = _rev(client)
    _commit_create(client, "B")            # rev 2
    before_rev = _rev(client)
    before_count = _count(client)

    def _boom(*a: object, **k: object) -> None:
        raise RuntimeError("db down")

    monkeypatch.setattr(commits_mod, "_persist_commit", _boom)
    r = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": target, "base_rev": before_rev},
    )
    assert r.status_code == 500
    assert _rev(client) == before_rev       # model_rev unchanged
    assert _count(client) == before_count   # in-memory model intact
```

- [ ] **Step 6: Run tests**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -v`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/routes/commits.py tests/api/test_commits_revert.py
git commit -m "feat(api): POST /commits/revert — compensating-commit revert (core)"
```

---

### Task 5: Revert guards — stale base_rev, target bounds, no-op

**Files:**
- Modify: `src/data_rover/api/routes/commits.py`
- Test: `tests/api/test_commits_revert.py`

**Interfaces:**
- Consumes: the `revert_commit` handler (Task 4); `OpsResponse`-style fields on `CommitResponse`.
- Produces: stale `base_rev` → 409; `target_rev` out of `[0, model_rev]` → 422; `target_rev == model_rev` → 200 no-op (empty-delta `CommitResponse`, no new commit).

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_commits_revert.py`:

```python
def test_revert_stale_base_rev_409(client: TestClient) -> None:
    _commit_create(client, "A")
    r = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": 0, "base_rev": 999},
    )
    assert r.status_code == 409
    assert r.json()["model_rev"] == _rev(client)


def test_revert_target_out_of_range_422(client: TestClient) -> None:
    _commit_create(client, "A")
    r = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": 999, "base_rev": _rev(client)},
    )
    assert r.status_code == 422


def test_revert_noop_at_head_records_no_commit(client: TestClient) -> None:
    _commit_create(client, "A")
    head = _rev(client)
    r = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": head, "base_rev": head},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_rev"] == head        # unchanged — no new commit
    assert body["changed_elements"] == []
    assert body["deleted_element_ids"] == []
    # history length unchanged
    hist = client.get(papi("/commits"), headers=AUTH_HEADERS).json()
    assert hist["commits"][0]["rev"] == head
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -k "stale or out_of_range or noop" -v`
Expected: FAIL — stale gives 200 (no guard), out-of-range 500/200, no-op records a phantom commit / wrong model_rev.

- [ ] **Step 3: Add the guards**

In `revert_commit`, insert **before** `state = _ensure_validation_seeded(...)`:

```python
    if payload.base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={"detail": "stale base_rev", "model_rev": session.model_rev},
        )
```

Then insert **after** the `state = _ensure_validation_seeded(...)` line and **before** `with session.write_mutex:`:

```python
    if payload.target_rev < 0 or payload.target_rev > session.model_rev:
        return JSONResponse(
            status_code=422,
            content={"detail": "target_rev out of range",
                     "model_rev": session.model_rev},
        )
    if payload.target_rev == session.model_rev:
        # no-op: nothing to revert. Mirror the empty-batch path in apply_ops —
        # return current state WITHOUT bumping model_rev or recording a commit.
        return CommitResponse(
            model_rev=session.model_rev,
            id_map={},
            changed_elements=[],
            changed_relationships=[],
            deleted_element_ids=[],
            deleted_relationship_ids=[],
            issues_removed_owner_ids=[],
            issues_added=[],
            issue_counts=state.counts(),
            commit_id="",
            message="",
            validation_error_count=0,
        )
```

(`issues_removed_owner_ids` / `issues_added` types: pass `[]`. If `CommitResponse` requires a specific empty type and rejects a bare list, mirror the field types used in `create_commit`'s return — both are lists.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/routes/commits.py tests/api/test_commits_revert.py
git commit -m "feat(api): revert guards — stale base_rev, target bounds, no-op"
```

---

### Task 6: Revert refuses across a metamodel-swap commit

**Files:**
- Modify: `src/data_rover/api/routes/commits.py`
- Test: `tests/api/test_commits_revert.py`

**Interfaces:**
- Consumes: the `commits` range loaded in `revert_commit`; `Commit.from_metamodel_id` / `Commit.to_metamodel_id`.
- Produces: if any commit in the revert range is a rebind (either swap column set) → 409 `{detail, rebind_rev}`. No mutation occurs.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_commits_revert.py`:

```python
_MM_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Contains
    containment: true
    source: Widget
    target: Widget
"""


def test_revert_across_rebind_409(client: TestClient) -> None:
    _commit_create(client, "A")            # rev 1
    target = _rev(client)                  # 1
    rebind = client.post(
        papi("/metamodel/rebind") + f"?base_rev={_rev(client)}&message=swap",
        content=_MM_RENAMED, headers={"content-type": "application/x-yaml"},
    )
    assert rebind.status_code == 200, rebind.text
    rebind_rev = _rev(client)              # 2
    r = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": target, "base_rev": _rev(client)},
    )
    assert r.status_code == 409
    assert r.json()["rebind_rev"] == rebind_rev
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -k across_rebind -v`
Expected: FAIL — without the guard the revert proceeds (200) or errors deserializing the rebind's inverse ops.

- [ ] **Step 3: Add the guard**

In `revert_commit`, immediately after `commits = content.commits_after(...)` inside the mutex, before building `combined`:

```python
        for c in commits:
            if c.from_metamodel_id is not None or c.to_metamodel_id is not None:
                return JSONResponse(
                    status_code=409,
                    content={
                        "detail": "revert across a metamodel swap is not yet "
                                  "supported",
                        "rebind_rev": c.rev,
                    },
                )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -v`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/routes/commits.py tests/api/test_commits_revert.py
git commit -m "feat(api): revert refuses across a metamodel-swap commit (409)"
```

---

### Task 7: Revert refuses when a peer holds a lock on an affected resource

**Files:**
- Modify: `src/data_rover/api/routes/commits.py`
- Test: `tests/api/test_commits_revert.py`

**Interfaces:**
- Consumes: `_affected_ids` (Task 3); `session.lock_table.active_leases(now)` (returns `Lease` objects with `.resource_id`, `.holder`, `.mode`); `time.monotonic()` (already imported).
- Produces: if any active lease covers an affected id → 409 `{detail, conflicts: [{resource_id, holder_id, mode}]}`. No mutation occurs.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_commits_revert.py`:

```python
def test_revert_refuses_when_peer_holds_lock(client: TestClient) -> None:
    a = _commit_create(client, "A")        # rev 1
    target = _rev(client)
    _commit_create(client, "B")            # rev 2 (will be reverted)
    # lock element A (touched by the rev-1 commit, which revert-to-0 would undo)
    lk = client.post(
        papi("/locks"), headers=AUTH_HEADERS,
        json={"targets": [{"resource_id": a, "mode": "exclusive"}],
              "intent": "edit"},
    )
    assert lk.status_code == 200, lk.text
    token = lk.json()["token"]
    r = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": 0, "base_rev": _rev(client)},
    )
    assert r.status_code == 409
    assert any(cf["resource_id"] == a for cf in r.json()["conflicts"])
    # releasing the lock lets the revert through
    assert client.post(
        papi("/locks/release"), headers=AUTH_HEADERS, json={"token": token}
    ).status_code == 200
    assert client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": 0, "base_rev": _rev(client)},
    ).status_code == 200
```

Before running, verify the `POST /locks` request/response shape and `POST /locks/release` body against `src/data_rover/api/routes/locks.py` / `tests/api/test_locks_route.py` (the lease request uses `targets: [{resource_id, mode}]` + `intent`; the response carries `token`). Adapt field names if they differ.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -k peer_holds_lock -v`
Expected: FAIL — without the guard the first revert returns 200.

- [ ] **Step 3: Add the guard**

In `revert_commit`, after the rebind-boundary loop (Task 6) and before building `combined`:

```python
        affected = _affected_ids(commits)
        held = [
            le
            for le in session.lock_table.active_leases(time.monotonic())
            if le.resource_id in affected
        ]
        if held:
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "resource locked by a peer",
                    "conflicts": [
                        {"resource_id": le.resource_id, "mode": le.mode.value,
                         "holder_id": le.holder}
                        for le in held
                    ],
                },
            )
```

(`Lease` attribute names: confirm `.resource_id`, `.mode` (an enum with `.value`), `.holder` against `src/data_rover/api/locking.py` — the commit route's lock-release block uses exactly `le.resource_id`, `le.mode.value`, `le.holder`, so these are correct.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -v`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/routes/commits.py tests/api/test_commits_revert.py
git commit -m "feat(api): revert refuses when a peer holds a lock on an affected resource (409)"
```

---

### Task 8: Feed broadcast + viewer-403 + conformance-count

**Files:**
- Modify: `src/data_rover/api/routes/commits.py`
- Test: `tests/api/test_commits_revert.py`

**Interfaces:**
- Consumes: `session.hub.broadcast`, `feed.commit_event` (already imported in `commits.py`); `res.changed_element_ids` / `res.deleted_element_ids` etc.
- Produces: a successful revert broadcasts one `commit` event (built exactly like `create_commit`'s); a viewer gets 403; a revert that lands conformance issues records the count on its commit row.

- [ ] **Step 1: Write the failing test (broadcast)**

Append to `tests/api/test_commits_revert.py`. Mirror the broadcast assertion style in `tests/api/test_feed_ws.py` (open a WS to `/feed`, drain the initial snapshot, perform the revert, expect a `commit` event). If `test_feed_ws.py` exposes a reusable helper or pattern, follow it; otherwise use the `TestClient.websocket_connect` form it uses. Concretely:

```python
def test_revert_broadcasts_commit_event(client: TestClient) -> None:
    _commit_create(client, "A")            # rev 1
    target = _rev(client)
    _commit_create(client, "B")            # rev 2
    with client.websocket_connect(
        papi("/feed") + f"?x-user-id={AUTH_HEADERS['x-user-id']}"
        f"&x-user-email={AUTH_HEADERS['x-user-email']}"
    ) as ws:
        ws.receive_json()                  # initial snapshot
        assert client.post(
            papi("/commits/revert"), headers=AUTH_HEADERS,
            json={"target_rev": target, "base_rev": _rev(client)},
        ).status_code == 200
        evt = ws.receive_json()
        assert evt["type"] == "commit"
        assert evt["rev"] == _rev(client)
```

Confirm the WS auth query-param names and the snapshot/commit event `type`/field names against `src/data_rover/api/routes/feed.py`, `src/data_rover/api/feed.py`, and `tests/api/test_feed_ws.py`; adapt if they differ.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -k broadcasts -v`
Expected: FAIL — no event arrives (revert doesn't broadcast yet); `ws.receive_json()` times out / errors.

- [ ] **Step 3: Add the broadcast**

In `revert_commit`, inside the `with session.write_mutex:` block, after the snapshot step and before the block ends (mirror `create_commit` steps g/h, minus the lock-release — revert holds no locks):

```python
        changed_elements = [
            ElementOut.from_core(model.elements[eid]).model_dump()
            for eid in res.changed_element_ids
        ]
        changed_relationships = [
            RelationshipOut.from_core(model.relationships[rid]).model_dump()
            for rid in res.changed_relationship_ids
        ]
        session.hub.broadcast(
            commit_event(
                rev=session.model_rev,
                commit_id=commit_id,
                author_id=user.id,
                message=message,
                validation_error_count=len(conformance),
                changed_elements=changed_elements,
                changed_relationships=changed_relationships,
                deleted_element_ids=list(res.deleted_element_ids),
                deleted_relationship_ids=list(res.deleted_relationship_ids),
            )
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py -k broadcasts -v`
Expected: PASS.

- [ ] **Step 5: Write the viewer-403 + conformance tests**

Append to `tests/api/test_commits_revert.py`:

```python
def test_revert_forbidden_for_viewer(client: TestClient) -> None:
    from data_rover.api import db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    _commit_create(client, "A")
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    finally:
        gen.close()
    r = client.post(
        papi("/commits/revert"),
        headers={"x-user-id": "vw", "x-user-email": "vw@example.com"},
        json={"target_rev": 0, "base_rev": _rev(client)},
    )
    assert r.status_code == 403


def test_revert_records_conformance_count(client: TestClient) -> None:
    # Create a relationship with a bad endpoint type so reverting to the
    # state that contains it lands a conformance issue. Simpler: rely on a
    # revert that reconstructs a clean state -> count 0; assert the field is
    # present and an int on the new commit row.
    _commit_create(client, "A")
    target = _rev(client)
    _commit_create(client, "B")
    r = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": target, "base_rev": _rev(client)},
    )
    assert r.status_code == 200, r.text
    assert isinstance(r.json()["validation_error_count"], int)
    top = client.get(papi("/commits"), headers=AUTH_HEADERS).json()["commits"][0]
    assert top["validation_error_count"] == r.json()["validation_error_count"]
```

(`add_member` name/signature: confirm against `src/data_rover/api/tenancy.py`. The conformance test asserts the field plumbs through; a non-zero scenario is exercised by the existing rebind tests and is out of scope to reconstruct here.)

- [ ] **Step 6: Run the full revert + history suites**

Run: `pixi run -e core-dev pytest tests/api/test_commits_revert.py tests/api/test_commit_history.py tests/api/test_content.py -v`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/routes/commits.py tests/api/test_commits_revert.py
git commit -m "feat(api): revert broadcasts commit event; viewer-403 + conformance-count tests"
```

---

### Task 9: Full verification + lint/type gate

**Files:** none (verification only).

- [ ] **Step 1: Run the whole backend test suite**

Run: `pixi run test-core` and `pixi run -e core-dev pytest tests/api -v`
Expected: all pass (336+ existing + the new tests).

- [ ] **Step 2: Lint + types (all three must pass)**

Run: `pixi run lint-backend`
Expected: ruff clean, mypy clean, pyright clean. Fix any issues (common: unused import, missing return-type annotation, `X | None` not `Optional`).

- [ ] **Step 3: Final commit (only if Step 2 required fixes)**

```bash
git add -A
git commit -m "chore(api): lint/type fixes for revert + history"
```

---

## Self-review notes (author)

- **Spec coverage:** §3.1 GET /commits → Task 2; §3.2 revert flow → Tasks 4 (core) + 5 (stale/bounds/no-op) + 6 (rebind) + 7 (peer-lock) + 8 (broadcast); §3.3 list_commits → Task 1; §3.4 schemas → Tasks 2/3; §3.5 _affected_ids → Task 3; §3.6 authz viewer → Task 8 test (behavior is automatic); §3.7 no migration → honored; §5 error table → Tasks 4–7 cover every row; §6 testing → Tasks 1–9 (eviction roundtrip in Task 4, revert-the-revert in Task 4, all 409/422 paths, DB-failure, broadcast, viewer).
- **Deferred (spec §7), no task:** strict-mode, metamodel-swap revert, frontend, partial revert — correctly absent.
- **Type consistency:** `_affected_ids(list[Commit]) -> set[str]` used identically in Task 3 (def) and Task 7 (call). `RevertRequest{target_rev, base_rev, message}` consistent across Tasks 3/4/5. `revert_commit` returns `CommitResponse | JSONResponse` throughout. `content.list_commits(..., before_rev, limit)` signature identical in Tasks 1/2.
- **Verify-before-run flags planted** at the few cross-module seams whose exact names this plan asserts but should be double-checked by the implementer: `tenancy.add_member`, the `POST /locks` + `/locks/release` request/response shapes, the `/feed` WS auth params + event field names, and that `Lease` exposes `.resource_id/.mode/.holder` (the last is confirmed by the existing lock-release block in `create_commit`).
```
