# Strict Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an owner-controlled, per-project "strict mode" that promotes the entire CONFORMANCE validation tier to a hard commit blocker (422 + rollback), scoped to the commit's dirty set, with rebind exempt.

**Architecture:** A nullable JSON `validation_policy` column on `ModelRow` (`{"strict": bool}`) is the durable source; it is hydrated into the in-memory `Session.strict_mode` flag so the commit path reads it with no DB hit. The commit handler gains a second gate (after the structural gate) that rolls back and 422s when `strict_mode` is on and the scoped conformance list is non-empty. An owner-gated `PATCH /settings` route flips the flag in DB + live Session under the write-mutex. `GET /open` and `POST /commits/preview` expose the policy so the frontend disables "Commit anyway" under strict mode.

**Tech Stack:** Python 3.14 / FastAPI / Pydantic / SQLAlchemy 2.0 / Alembic (backend); SvelteKit + Svelte 5 runes + TypeScript + Zod + Vitest + Playwright (frontend). Everything runs through `pixi`.

## Global Constraints

- **No global `python`/`node`** — always `pixi run`. Backend tests: `pixi run -e core-dev pytest <path>`. Backend lint (all three must pass): `pixi run lint-backend` (ruff + mypy + pyright). Frontend tests: `pixi run -e frontend bash -c 'cd frontend && ./node_modules/.bin/vitest run'` (NOT `npx vitest` — pulls a conflicting v4). Frontend check: `pixi run -e frontend bash -c 'cd frontend && npm run check'`. E2E: `pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`.
- **Python check floor is 3.10** (`pyrightconfig.json`) though runtime is 3.14 — import `Self`/`assert_never` from `typing_extensions`, not `typing`.
- **API tests need no DB service** — `tests/api/conftest.py` runs in-memory SQLite; use the `client` fixture + `seed_default_project`/`AUTH_HEADERS`/`papi` helpers. Every project-scoped request needs an identity header and a seeded `default` project.
- **Tests live in `tests/<area>/`** (backend) mirroring source packages; `pythonpath=src` is set, import `from data_rover.core...` / `from data_rover.api...`. Frontend tests colocate in `__tests__/`.
- **Frontend state/API are re-exported through barrels** `lib/state/index.ts` and `lib/api/index.ts`; every new public store/API function MUST be added to the matching barrel.
- **Editor diagnostics lie** (zod/$state/sqlalchemy "not found"). The authoritative gates are `pixi run lint-backend` and `npm run check` — trust those, not editor squiggles.
- **Worktree (execution):** do this work in a fresh worktree off `main`. Native worktrees live under `.claude/worktrees/` and need `.pixi` symlinked from the main checkout (`ln -s /home/mdp/workspace/data-rover-py/.pixi .pixi`), plus `pixi run frontend-install` inside the worktree for frontend tasks.
- **Commit trailer:** every commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Do not push** — the branch is integrated via finishing-a-development-branch at the end.

## File Structure

- `src/data_rover/api/db_models.py` — add `validation_policy` JSON column to `ModelRow`.
- `alembic/versions/0005_model_validation_policy.py` — new migration (add the column).
- `src/data_rover/api/content.py` — `get_strict_mode` / `set_strict_mode` accessors.
- `src/data_rover/api/session.py` — `Session.strict_mode` field.
- `src/data_rover/api/hydration.py` — load `strict_mode` into the Session.
- `src/data_rover/api/routes/settings.py` — new `GET`/`PATCH /settings` router.
- `src/data_rover/api/main.py` — register the settings router.
- `src/data_rover/api/schemas.py` — `OpenResponse.strict_mode`, `PreviewResponse.would_block`.
- `src/data_rover/api/routes/commits.py` — strict gate in commit; `strict_mode` in `/open`; `would_block` in preview.
- `frontend/src/lib/api/types.ts` — zod `strict_mode`/`would_block`/`ProjectSettings`.
- `frontend/src/lib/api/settings.ts` — `getSettings`/`updateSettings` client.
- `frontend/src/lib/state/checkout.svelte.ts` — track `strict_mode`.
- `frontend/src/lib/components/DiffDrawer.svelte` — strict commit gating.
- `frontend/src/lib/components/SettingsDialog.svelte` + `TopBar.svelte` — owner toggle.
- Tests: `tests/api/test_strict_mode.py`, `tests/api/test_alembic.py` (extend), frontend `__tests__/`, `frontend/e2e/strict-mode.spec.ts`.

---

## Task 1: DB column + content accessors + migration

**Files:**
- Modify: `src/data_rover/api/db_models.py:129-148` (`ModelRow`)
- Create: `alembic/versions/0005_model_validation_policy.py`
- Modify: `src/data_rover/api/content.py` (add accessors near `get_model_row`/`set_model_rev`, ~line 31-59)
- Test: `tests/api/test_strict_mode.py` (create), `tests/api/test_alembic.py` (extend)

**Interfaces:**
- Produces: `content.get_strict_mode(db: SaSession, project_id: str) -> bool` — reads `ModelRow.validation_policy.get("strict", False)`; `False` if no row / NULL policy.
- Produces: `content.set_strict_mode(db: SaSession, project_id: str, strict: bool) -> None` — reassigns a fresh dict (JSON change-tracking needs reassignment, not in-place mutation) + commits; raises `LookupError` if the project has no `ModelRow`.
- Produces: `ModelRow.validation_policy: Mapped[dict | None]` JSON column, nullable, default `None`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_strict_mode.py`:

```python
from __future__ import annotations

from data_rover.api import content, db
from data_rover.api.db_models import MetamodelRow, ModelRow, Project


#: a minimal but VALID metamodel blob — Task 2's hydration test re-parses it
#: via load_metamodel_str, so it must be loadable (not just any string).
_MM_BLOB = "elements:\n  - name: Node\n"


def _seed_model_row(s) -> None:
    s.add(Project(id="p1", name="P1"))
    s.add(MetamodelRow(id="mm1", name="mm", version=1, blob=_MM_BLOB))
    s.add(ModelRow(id="m1", project_id="p1", metamodel_id="mm1", name="model"))
    s.commit()


def test_strict_mode_defaults_false_and_roundtrips() -> None:
    db.init_engine("sqlite://")
    db.create_all()
    gen = db.get_db()
    s = next(gen)
    try:
        _seed_model_row(s)
        assert content.get_strict_mode(s, "p1") is False  # NULL policy
        content.set_strict_mode(s, "p1", True)
        assert content.get_strict_mode(s, "p1") is True
        content.set_strict_mode(s, "p1", False)
        assert content.get_strict_mode(s, "p1") is False
        assert content.get_strict_mode(s, "missing") is False  # no row
    finally:
        gen.close()
        db.drop_all()
```

Confirm the `MetamodelRow` constructor args (`grep -n "class MetamodelRow" -A 12 src/data_rover/api/db_models.py`) and adjust the `version`/`blob` kwargs if the real signature differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_strict_mode.py -q`
Expected: FAIL — `AttributeError: module 'data_rover.api.content' has no attribute 'get_strict_mode'` (and/or `validation_policy` unknown).

- [ ] **Step 3: Add the ORM column**

In `db_models.py`, inside `class ModelRow` (after the `model_rev` column at line 143), add:

```python
    #: Per-project validation policy (strict-mode feature). JSON so it can grow
    #: into per-category promotion flags without a schema migration. v1 shape:
    #: ``{"strict": bool}``. NULL / missing key reads as strict=false (the
    #: inspectable default).
    validation_policy: Mapped[dict | None] = mapped_column(JSON, nullable=True)
```

`JSON` and `Mapped`/`mapped_column` are already imported (`db_models.py:19,25`).

- [ ] **Step 4: Add the content accessors**

In `content.py`, after `set_model_rev` (~line 59), add:

```python
def get_strict_mode(db: Session, project_id: str) -> bool:
    """Read the project's strict-mode flag. False if no model row or NULL
    policy (the inspectable default)."""
    row = get_model_row(db, project_id)
    if row is None or row.validation_policy is None:
        return False
    return bool(row.validation_policy.get("strict", False))


def set_strict_mode(db: Session, project_id: str, strict: bool) -> None:
    """Set the project's strict-mode flag. Reassigns a fresh dict so
    SQLAlchemy's JSON change-tracking fires (in-place mutation is not
    detected). Raises LookupError if the project has no model row."""
    row = get_model_row(db, project_id)
    if row is None:
        raise LookupError(f"project {project_id!r} has no model row")
    policy = dict(row.validation_policy or {})
    policy["strict"] = strict
    row.validation_policy = policy
    db.commit()
```

(`Session` here is the SQLAlchemy session alias already imported at the top of `content.py`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_strict_mode.py -q`
Expected: PASS.

- [ ] **Step 6: Write the migration**

Create `alembic/versions/0005_model_validation_policy.py`:

```python
"""model validation_policy (strict mode)

Revision ID: 0005
Revises: 0004
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "models",
        sa.Column("validation_policy", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("models", "validation_policy")
```

Verify `0004`'s `revision` string matches `down_revision` here (`grep -n "^revision" alembic/versions/0004_*.py`).

- [ ] **Step 7: Extend the alembic test**

In `tests/api/test_alembic.py`, add (mirror `test_migration_creates_content_tables` for the Config/upgrade boilerplate):

```python
def test_migration_adds_validation_policy_column(tmp_path: Path) -> None:
    db_path = tmp_path / "t.db"
    url = f"sqlite:///{db_path}"
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)

    command.upgrade(cfg, "head")
    engine = create_engine(url)
    cols = {c["name"] for c in inspect(engine).get_columns("models")}
    assert "validation_policy" in cols

    command.downgrade(cfg, "0004")
    cols = {c["name"] for c in inspect(engine).get_columns("models")}
    assert "validation_policy" not in cols
```

- [ ] **Step 8: Run migration + full api suite**

Run: `pixi run -e core-dev pytest tests/api/test_alembic.py tests/api/test_strict_mode.py -q`
Expected: PASS.

- [ ] **Step 9: Lint + commit**

Run: `pixi run lint-backend`
Expected: clean (0 errors).

```bash
git add src/data_rover/api/db_models.py src/data_rover/api/content.py alembic/versions/0005_model_validation_policy.py tests/api/test_strict_mode.py tests/api/test_alembic.py
git commit -m "feat(api): validation_policy column + strict-mode content accessors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `Session.strict_mode` field + hydration

**Files:**
- Modify: `src/data_rover/api/session.py:49-86` (`Session` dataclass fields)
- Modify: `src/data_rover/api/hydration.py:153-200` (`hydrate_session`)
- Test: `tests/api/test_strict_mode.py`

**Interfaces:**
- Consumes: `content.get_strict_mode` (Task 1).
- Produces: `Session.strict_mode: bool` (default `False`), set during `hydrate_session` from the project's `ModelRow.validation_policy`.

- [ ] **Step 1: Write the failing test**

Add to `tests/api/test_strict_mode.py`:

```python
def test_hydrate_session_loads_strict_mode() -> None:
    import json

    from data_rover.api import hydration
    from data_rover.api.storage import (
        MemorySnapshotStore,
        get_snapshot_store,
        set_snapshot_store,
    )

    db.init_engine("sqlite://")
    db.create_all()
    set_snapshot_store(MemorySnapshotStore())
    gen = db.get_db()
    s = next(gen)
    try:
        _seed_model_row(s)
        # a baseline snapshot so hydration has a model to load
        key = get_snapshot_store().put(
            json.dumps({"elements": [], "relationships": []}).encode()
        )
        content.record_snapshot(s, "p1", rev=0, key=key)
        content.set_strict_mode(s, "p1", True)
    finally:
        gen.close()

    session = hydration.hydrate_session("p1")
    assert session.strict_mode is True
    set_snapshot_store(None)
    db.drop_all()
```

Confirm `MemorySnapshotStore`/`set_snapshot_store`/`get_snapshot_store` import paths (`grep -n "class MemorySnapshotStore\|def set_snapshot_store\|def get_snapshot_store\|def put" src/data_rover/api/storage.py`) and the `record_snapshot` signature (Task 1 context shows `content.record_snapshot(db, project_id, *, rev, key)`); adjust `store.put` if it returns/takes different args.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_strict_mode.py::test_hydrate_session_loads_strict_mode -q`
Expected: FAIL — `AttributeError: 'Session' object has no attribute 'strict_mode'`.

- [ ] **Step 3: Add the Session field**

In `session.py`, inside `class Session`, after the `hub` field (line 86), add:

```python
    #: per-project strict-mode policy (strict-mode feature). When True the
    #: commit path promotes scoped CONFORMANCE issues to a hard 422 reject.
    #: Loaded from ModelRow.validation_policy during hydration; flipped by the
    #: owner-gated PATCH /settings route under the write-mutex. Default False
    #: keeps the engine's inspectable behaviour for every untouched project.
    strict_mode: bool = False
```

- [ ] **Step 4: Load it during hydration**

In `hydration.py` `hydrate_session`, the `with db_session() as s:` block already fetches `model_row` (line 158). Inside that block, after `model_rev = model_row.model_rev` (line 163), capture the flag:

```python
        strict_mode = bool((model_row.validation_policy or {}).get("strict", False))
```

Then after the session is built and before `return session` (line 199), set it:

```python
    session.strict_mode = strict_mode
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_strict_mode.py -q`
Expected: PASS (all three tests).

- [ ] **Step 6: Lint + commit**

Run: `pixi run lint-backend`
Expected: clean.

```bash
git add src/data_rover/api/session.py src/data_rover/api/hydration.py tests/api/test_strict_mode.py
git commit -m "feat(api): Session.strict_mode hydrated from validation_policy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Owner-gated `GET`/`PATCH /settings` route

**Files:**
- Create: `src/data_rover/api/routes/settings.py`
- Modify: `src/data_rover/api/main.py:168-182` (register router)
- Test: `tests/api/test_strict_mode.py`

**Interfaces:**
- Consumes: `Session.strict_mode` (Task 2), `content.set_strict_mode` (Task 1), `require_membership`/`require_owner` (`authz.py:13,75`), `get_request_session` (`deps.py`).
- Produces: `GET /api/v1/projects/{project_id}/settings -> {"strict_mode": bool}` (any member); `PATCH .../settings {"strict_mode": bool} -> {"strict_mode": bool}` (owner only; 409 if the project has no model row).

- [ ] **Step 1: Write the failing test**

Add to `tests/api/test_strict_mode.py` (uses the HTTP `client` fixture + helpers). These need a model row, so seed a metamodel first via the upload route. Check how an existing test uploads a metamodel (`grep -n "def _upload_metamodel\|/metamodel\b" tests/api/test_commits.py tests/api/test_commit_history.py`) and reuse that helper shape; the sketch below assumes a `papi("/metamodel")` POST that creates the `ModelRow`.

```python
from .conftest import AUTH_HEADERS, papi  # if not already imported

# Strict-mode tests need ops that DO and DON'T conform. A required `name`
# property (multiplicity "1") makes "create a Node with no name" a CONFORMANCE
# (multiplicity) violation — and crucially NOT a structural one. Mirror the
# upload shape of tests/api/test_commits_route.py's `client` fixture.
_MM_STRICT = """
elements:
  - name: Node
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""

# create_element ops (free-floating creates need NO lock, so lock_tokens=[]).
VIOLATING_OPS = [
    {"kind": "create_element", "temp_id": "tmp_bad", "type_name": "Node", "properties": {}}
]
CLEAN_OPS = [
    {"kind": "create_element", "temp_id": "tmp_ok", "type_name": "Node",
     "properties": {"name": "ok"}}
]


def _make_owner_with_model(client) -> None:
    """Upload the strict metamodel + an empty model (creates the ModelRow).
    The conftest `client` is already an owner of the default project."""
    r = client.post(
        papi("/metamodel"), content=_MM_STRICT,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = client.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text


def _rev(client) -> int:
    return client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_settings_get_defaults_false(client) -> None:
    _make_owner_with_model(client)
    r = client.get(papi("/settings"), headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.json() == {"strict_mode": False}


def test_owner_can_enable_strict_mode(client) -> None:
    _make_owner_with_model(client)
    r = client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    assert r.status_code == 200
    assert r.json() == {"strict_mode": True}
    assert client.get(papi("/settings"), headers=AUTH_HEADERS).json()["strict_mode"] is True


def test_editor_cannot_toggle_strict_mode(client) -> None:
    _make_owner_with_model(client)
    from data_rover.api import db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="ed", email="ed@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "ed", Role.editor)
        s.commit()
    finally:
        gen.close()
    ed = {"x-user-id": "ed", "x-user-email": "ed@example.com"}
    r = client.patch(papi("/settings"), headers=ed, json={"strict_mode": True})
    assert r.status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_strict_mode.py -k settings -q`
Expected: FAIL — 404 (route not mounted).

- [ ] **Step 3: Create the router**

Create `src/data_rover/api/routes/settings.py`:

```python
"""Project settings — the strict-mode policy toggle.

GET is readable by any member; PATCH is owner-only (mirrors membership
management). The flag is written to the durable ``ModelRow.validation_policy``
AND the live in-memory ``Session`` under the project write-mutex, so a policy
change cannot interleave inconsistently with a concurrent commit.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from sqlalchemy.orm import Session as DbSession

from .. import content
from ..authz import require_membership, require_owner
from ..db import get_db
from ..deps import get_request_session
from ..session import Session

router = APIRouter()


class ProjectSettings(BaseModel):
    strict_mode: bool


@router.get("/settings", response_model=ProjectSettings)
def read_settings(
    session: Session = Depends(get_request_session),
    _member=Depends(require_membership),
) -> ProjectSettings:
    return ProjectSettings(strict_mode=session.strict_mode)


@router.patch("/settings", response_model=ProjectSettings)
def update_settings(
    body: ProjectSettings,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    _owner=Depends(require_owner),
) -> ProjectSettings:
    with session.write_mutex:
        try:
            content.set_strict_mode(db, project_id, body.strict_mode)
        except LookupError as exc:
            raise HTTPException(
                status_code=409, detail="project has no model; upload one first"
            ) from exc
        session.strict_mode = body.strict_mode
    return ProjectSettings(strict_mode=session.strict_mode)
```

Verify the `get_request_session` import path (`grep -rn "def get_request_session" src/data_rover/api/deps.py`) and the `require_membership`/`require_owner` import path against `authz.py`. Match whatever `routes/commits.py` imports for the same deps.

- [ ] **Step 4: Register the router**

In `main.py`, add the import alongside the other route imports and register it after `commits` (line 181):

```python
    app.include_router(settings.router, prefix=proj, tags=["settings"])
```

Add `settings` to the route-module import block at the top of `main.py` (mirror how `commits` is imported there).

- [ ] **Step 5: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_strict_mode.py -k settings -q`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

Run: `pixi run lint-backend`
Expected: clean.

```bash
git add src/data_rover/api/routes/settings.py src/data_rover/api/main.py tests/api/test_strict_mode.py
git commit -m "feat(api): owner-gated GET/PATCH /settings strict-mode toggle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Enforcement — strict gate in the commit handler

**Files:**
- Modify: `src/data_rover/api/routes/commits.py:264-266` (after the `conformance` split, before `delta = state.replace(...)`)
- Test: `tests/api/test_strict_mode.py`

**Interfaces:**
- Consumes: `Session.strict_mode` (Task 2), the existing `_rollback`, `IssueCategory`, `IssueOut`, `res.inverse_units` in scope at the commit site.
- Produces: a 422 `{"detail": "strict-mode conformance blocker", "conformance_blockers": [...]}` on a strict-blocked commit, with the model fully rolled back and `model_rev`/`op_log` unchanged.

- [ ] **Step 1: Write the failing test**

Both batches are **free-floating creates**, which require no lock (see `test_commit_creates_freefloating_without_lock` in `tests/api/test_commits_route.py`) — so `lock_tokens: []`. `VIOLATING_OPS` (defined in Task 3 Step 1) creates a `Node` with no `name`, tripping the required-property multiplicity rule (CONFORMANCE, not structural). Add to `tests/api/test_strict_mode.py`:

```python
def test_strict_mode_blocks_conformance_commit(client) -> None:
    _make_owner_with_model(client)
    # sanity: without strict mode the SAME batch is allowed (counted, not blocked)
    ok = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": VIOLATING_OPS, "message": "soft", "lock_tokens": [],
    })
    assert ok.status_code == 200, ok.text  # default (non-strict) path

    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    rev_before = _rev(client)
    r = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": rev_before, "ops": VIOLATING_OPS, "message": "x", "lock_tokens": [],
    })
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "strict-mode conformance blocker"
    assert len(r.json()["conformance_blockers"]) >= 1
    assert _rev(client) == rev_before  # rolled back, no rev bump


def test_strict_mode_allows_clean_commit(client) -> None:
    _make_owner_with_model(client)
    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    r = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": CLEAN_OPS, "message": "ok", "lock_tokens": [],
    })
    assert r.status_code == 200, r.text


def test_strict_mode_ignores_preexisting_issues_outside_dirty_set(client) -> None:
    # Land a non-conforming element while NON-strict, then turn strict on and
    # commit an UNRELATED clean element. Scoped enforcement => the second commit
    # succeeds even though the model still holds the first element's issue.
    _make_owner_with_model(client)
    client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": VIOLATING_OPS, "message": "soft", "lock_tokens": [],
    })
    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    r = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": CLEAN_OPS, "message": "clean", "lock_tokens": [],
    })
    assert r.status_code == 200, r.text  # pre-existing issue is outside this dirty set
```

(`VIOLATING_OPS`, `CLEAN_OPS`, `_make_owner_with_model`, `_rev` all live in `test_strict_mode.py` from Task 3 Step 1.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_strict_mode.py -k "blocks_conformance or allows_clean or preexisting" -q`
Expected: `test_strict_mode_blocks_conformance_commit` FAILS — the violating commit returns 200 (strict gate not yet present). (The other two may already pass; the blocker test is the red one.)

- [ ] **Step 3: Add the strict gate**

In `commits.py`, the accept block currently reads (line 264-267):

```python
        # d. commit accepted: splice issues, bump rev, record batch
        conformance = [i for i in scoped if i.category is IssueCategory.CONFORMANCE]
        delta = state.replace(res.dirty.ids, scoped)
```

Insert the gate **between** the `conformance` assignment and `delta = state.replace(...)`:

```python
        conformance = [i for i in scoped if i.category is IssueCategory.CONFORMANCE]
        # strict-mode gate: an owner-enabled project promotes scoped conformance
        # issues to a hard reject (spec: strict mode). Scoped to res.dirty only —
        # pre-existing issues elsewhere never trip this. Rebind has its own route
        # and does not pass through here, so it stays exempt by construction.
        if session.strict_mode and conformance:
            _rollback(model, res.inverse_units)
            return JSONResponse(
                status_code=422,
                content={
                    "detail": "strict-mode conformance blocker",
                    "conformance_blockers": [
                        IssueOut.from_core(i).model_dump() for i in conformance
                    ],
                },
            )
        delta = state.replace(res.dirty.ids, scoped)
```

The gate sits before `state.replace`, the `model_rev` bump, and `record_batch`, so a rejected commit leaves all session bookkeeping untouched — identical rollback semantics to the structural gate just above it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_strict_mode.py -q`
Expected: PASS (all strict-mode tests).

- [ ] **Step 5: Run the full commits suite (no regression)**

Run: `pixi run -e core-dev pytest tests/api/test_commits.py -q`
Expected: PASS (non-strict path byte-for-byte unchanged — `strict_mode` defaults False).

- [ ] **Step 6: Lint + commit**

Run: `pixi run lint-backend`
Expected: clean.

```bash
git add src/data_rover/api/routes/commits.py tests/api/test_strict_mode.py
git commit -m "feat(api): strict-mode commit gate (422 + rollback on scoped conformance)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Expose policy via `/open` + preview `would_block`; rebind-exempt test

**Files:**
- Modify: `src/data_rover/api/schemas.py:528-539` (`OpenResponse`), `:547-550` (`PreviewResponse`)
- Modify: `src/data_rover/api/routes/commits.py` (`open_project`, `preview_commit`)
- Test: `tests/api/test_strict_mode.py`

**Interfaces:**
- Produces: `OpenResponse.strict_mode: bool` (default `False`); `PreviewResponse.would_block: bool` (default `False`, = `strict_mode and conformance_error_count > 0`).

- [ ] **Step 1: Write the failing test**

Add to `tests/api/test_strict_mode.py`:

The rebind-exempt test mirrors `test_rebind_succeeds_and_journals` in `tests/api/test_metamodel_rebind.py`: rebind the model onto a metamodel that **renames** `Node` → `Widget`, so the existing element becomes a non-conforming instance — yet the rebind still lands (200). The point: with strict mode ON it must *still* land, because rebind never routes through the `/commits` strict gate.

```python
# rebind target: renames Node -> Widget so the existing element no longer conforms
_MM_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Contains
    containment: true
    source: Widget
    target: Widget
"""


def test_open_reports_strict_mode(client) -> None:
    _make_owner_with_model(client)
    assert client.get(papi("/open"), headers=AUTH_HEADERS).json()["strict_mode"] is False
    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    assert client.get(papi("/open"), headers=AUTH_HEADERS).json()["strict_mode"] is True


def test_preview_reports_would_block(client) -> None:
    _make_owner_with_model(client)
    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    r = client.post(papi("/commits/preview"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": VIOLATING_OPS,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["conformance_error_count"] >= 1
    assert body["would_block"] is True


def test_rebind_exempt_from_strict_mode(client) -> None:
    _make_owner_with_model(client)
    # land an element so the rename produces a conformance issue post-rebind
    client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": CLEAN_OPS, "message": "n", "lock_tokens": [],
    })
    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    before = _rev(client)
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={before}&message=swap",
        content=_MM_RENAMED, headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text  # rebind exempt even under strict mode
    assert r.json()["validation_error_count"] >= 1
```

Confirm the rebind route's query-param shape (`base_rev`/`message`) against `tests/api/test_metamodel_rebind.py` before relying on it.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_strict_mode.py -k "open_reports or would_block or rebind_exempt" -q`
Expected: FAIL — `KeyError: 'strict_mode'` / `'would_block'` (fields absent).

- [ ] **Step 3: Add schema fields**

In `schemas.py` `OpenResponse` (after `lock_ttl_seconds`, line 539):

```python
    #: project strict-mode policy; clients disable "commit anyway" when on.
    strict_mode: bool = False
```

In `schemas.py` `PreviewResponse` (after `issues`, line 550):

```python
    #: true when strict mode is on AND there are conformance errors — i.e. this
    #: batch would be hard-rejected by the commit strict gate. Lets the client
    #: gate the commit button without re-deriving policy.
    would_block: bool = False
```

- [ ] **Step 4: Populate them in the handlers**

In `commits.py` `open_project`, add to the `OpenResponse(...)` constructor:

```python
        strict_mode=session.strict_mode,
```

In `commits.py` `preview_commit`, the return currently computes `conformance`. Change the return to:

```python
    return PreviewResponse(
        conformance_error_count=len(conformance),
        structural_blockers=[IssueOut.from_core(i) for i in structural],
        issues=[IssueOut.from_core(i) for i in scoped],
        would_block=session.strict_mode and len(conformance) > 0,
    )
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_strict_mode.py -q`
Expected: PASS.

- [ ] **Step 6: Lint + run full api suite + commit**

Run: `pixi run lint-backend && pixi run -e core-dev pytest tests/api -q`
Expected: clean + all pass.

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/commits.py tests/api/test_strict_mode.py
git commit -m "feat(api): expose strict_mode on /open + would_block on preview

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Frontend — zod fields, settings API client, checkout state

**Files:**
- Modify: `frontend/src/lib/api/types.ts:227-234` (`OpenResponseSchema`), `:262-267` (`PreviewResponseSchema`); add `ProjectSettingsSchema`
- Create: `frontend/src/lib/api/settings.ts`
- Modify: `frontend/src/lib/api/index.ts` (barrel)
- Modify: `frontend/src/lib/state/checkout.svelte.ts:59-72` (state + `setProjectInfo` + `getStrictMode`), `:194-196` (`loadProjectInfo`)
- Modify: `frontend/src/lib/state/index.ts` (barrel, if `getStrictMode` is exported there)
- Test: `frontend/src/lib/api/__tests__/settings.test.ts` (create)

**Interfaces:**
- Produces: `getSettings(cfg?) -> Promise<ProjectSettings>`, `updateSettings(strict: boolean, cfg?) -> Promise<ProjectSettings>` where `ProjectSettings = {strict_mode: boolean}`.
- Produces: `getStrictMode(): boolean` and `setStrictMode(v: boolean): void` in checkout state; `setProjectInfo` accepts an optional `strictMode` field.
- Consumes: backend `GET`/`PATCH /settings`, `OpenResponse.strict_mode`, `PreviewResponse.would_block`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/api/__tests__/settings.test.ts` (mirror the MSW setup of `frontend/src/lib/api/__tests__/model-delta.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { getSettings, updateSettings } from '../settings';

const BASE = 'http://localhost/api/v1/projects/default';
const server = setupServer();
// follow the existing test's beforeAll/afterEach/afterAll(server) lifecycle

describe('settings api', () => {
	it('getSettings parses strict_mode', async () => {
		server.use(http.get(`${BASE}/settings`, () => HttpResponse.json({ strict_mode: true })));
		expect((await getSettings()).strict_mode).toBe(true);
	});

	it('updateSettings PATCHes strict_mode', async () => {
		let body: unknown;
		server.use(
			http.patch(`${BASE}/settings`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json({ strict_mode: false });
			})
		);
		const res = await updateSettings(false);
		expect(body).toEqual({ strict_mode: false });
		expect(res.strict_mode).toBe(false);
	});
});
```

Copy the exact `server` lifecycle hooks (`beforeAll`/`afterEach`/`afterAll`) and any `apiFetch` base-URL setup from `model-delta.test.ts` so the harness matches.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && ./node_modules/.bin/vitest run src/lib/api/__tests__/settings.test.ts'`
Expected: FAIL — cannot resolve `../settings`.

- [ ] **Step 3: Add zod schemas**

In `types.ts`, add `strict_mode` to `OpenResponseSchema` (inside the object, after `lock_ttl_seconds`):

```ts
	strict_mode: z.boolean().default(false)
```

Add `would_block` to `PreviewResponseSchema` (after `issues`):

```ts
	would_block: z.boolean().default(false)
```

Add a new schema + type (near the other response schemas):

```ts
export const ProjectSettingsSchema = z.object({
	strict_mode: z.boolean()
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
```

- [ ] **Step 4: Create the API client**

Create `frontend/src/lib/api/settings.ts` (mirror `frontend/src/lib/api/checkout.ts` import + `apiFetch` style):

```ts
import { apiFetch, type ClientConfig } from './client';
import { ProjectSettingsSchema, type ProjectSettings } from './types';

/** GET /settings — current project policy (any member). */
export function getSettings(cfg?: ClientConfig): Promise<ProjectSettings> {
	return apiFetch('/settings', { method: 'GET', schema: ProjectSettingsSchema }, cfg);
}

/** PATCH /settings — owner-only strict-mode toggle. */
export function updateSettings(strict: boolean, cfg?: ClientConfig): Promise<ProjectSettings> {
	return apiFetch(
		'/settings',
		{ method: 'PATCH', body: { strict_mode: strict }, schema: ProjectSettingsSchema },
		cfg
	);
}
```

Verify `apiFetch`'s body-option name (`body` vs `json`) against `frontend/src/lib/api/checkout.ts`'s mutating calls and match it.

- [ ] **Step 5: Add to the API barrel**

In `frontend/src/lib/api/index.ts`, add (mirror the existing `export * as ...` / named-export style):

```ts
export * as settings from './settings';
```

- [ ] **Step 6: Wire checkout state**

In `checkout.svelte.ts`, add state near `_role` (line 58):

```ts
let _strictMode = $state(false);
```

Extend `setProjectInfo` (line 66) to accept and store it:

```ts
export function setProjectInfo(info: { role: string; lockTtlSeconds: number; strictMode?: boolean }): void {
	_role = info.role;
	_lockTtlSeconds = info.lockTtlSeconds > 0 ? info.lockTtlSeconds : _lockTtlSeconds;
	if (info.strictMode !== undefined) _strictMode = info.strictMode;
}

export function getStrictMode(): boolean {
	return _strictMode;
}

/** Direct setter used by the owner Settings toggle (Task 8) after a successful
 * PATCH /settings, so the DiffDrawer gate reflects the new policy immediately. */
export function setStrictMode(v: boolean): void {
	_strictMode = v;
}
```

Update `loadProjectInfo` (line 195-196) to pass it through:

```ts
	setProjectInfo({ role: info.role, lockTtlSeconds: info.lock_ttl_seconds, strictMode: info.strict_mode });
}
```

Reset `_strictMode = false` wherever the other module state is reset (the same place line 154 resets `_lockTtlSeconds`).

- [ ] **Step 7: Export `getStrictMode` via the state barrel**

If checkout exports flow through `frontend/src/lib/state/index.ts`, add `getStrictMode` and `setStrictMode` to the re-export list there (match how `getRole` is exported).

- [ ] **Step 8: Run tests + check**

Run: `pixi run -e frontend bash -c 'cd frontend && ./node_modules/.bin/vitest run src/lib/api/__tests__/settings.test.ts && npm run check'`
Expected: PASS + no new check errors in touched files.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/settings.ts frontend/src/lib/api/index.ts frontend/src/lib/state/checkout.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/api/__tests__/settings.test.ts
git commit -m "feat(frontend): settings API client + strict-mode in checkout state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Frontend — DiffDrawer strict commit gating

**Files:**
- Modify: `frontend/src/lib/components/DiffDrawer.svelte:101-103` (`commitBlocked`), `:308-326` (banners), `:391-397` (button)
- Test: `frontend/src/lib/components/__tests__/DiffDrawer.strict.test.ts` (create) — or extend an existing DiffDrawer test if present

**Interfaces:**
- Consumes: `PreviewResponse.would_block` (Task 6) via the existing `preview` state in DiffDrawer.

- [ ] **Step 1: Write the failing test**

First check for an existing DiffDrawer test (`ls frontend/src/lib/components/__tests__/ | grep -i diff`). If one exists, add a case there; otherwise create `DiffDrawer.strict.test.ts` mirroring the render/MSW setup of `frontend/src/lib/components/__tests__/HistoryDrawer.test.ts`. The test mounts DiffDrawer with a non-empty staged diff, makes the preview endpoint return `{conformance_error_count: 2, structural_blockers: [], issues: [], would_block: true}`, and asserts:

```ts
// the commit button is disabled and a strict-mode blocker message is shown
expect(screen.getByRole('button', { name: /commit/i })).toBeDisabled();
expect(screen.getByText(/strict mode/i)).toBeInTheDocument();
```

Mirror the existing component test's harness exactly (render helper, MSW handlers for `/commits/preview`, fake checkout state). Do not invent a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && ./node_modules/.bin/vitest run src/lib/components/__tests__/DiffDrawer.strict.test.ts'`
Expected: FAIL (button enabled / no strict message).

- [ ] **Step 3: Extend the commit-blocked derivation**

In `DiffDrawer.svelte`, add a `wouldBlock` derived value next to `errorCount` (line 101) and fold it into `commitBlocked` (line 103):

```ts
	const errorCount = $derived(preview?.conformance_error_count ?? 0);
	const structuralBlockers = $derived(preview?.structural_blockers ?? []);
	const wouldBlock = $derived(preview?.would_block ?? false);
	const commitBlocked = $derived(structuralBlockers.length > 0 || wouldBlock);
```

- [ ] **Step 4: Add the strict-mode banner + adjust the amber banner**

In the banner block (line 308-326), gate the existing amber "you can commit anyway" banner on `!wouldBlock`, and add a red strict banner. Replace the `{#if errorCount > 0}` block with:

```svelte
				{#if errorCount > 0 && !wouldBlock}
					<div
						class="flex items-center gap-1.5 rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200"
					>
						<AlertTriangle class="h-3 w-3" />
						<span
							>{errorCount} validation {errorCount === 1 ? 'issue' : 'issues'} — you can commit anyway
							or review on the Issues tab.</span
						>
					</div>
				{/if}
				{#if wouldBlock}
					<div
						class="rounded border border-red-900 bg-red-950/40 px-2 py-1 text-[11px] text-red-200"
						role="alert"
					>
						Strict mode is on: {errorCount} validation {errorCount === 1 ? 'issue' : 'issues'} must be
						resolved before committing.
					</div>
				{/if}
```

- [ ] **Step 5: Adjust the commit button label**

In the button (line 391-397), the button is already `disabled` via `commitBlocked`. Update the label so a blocked button never says "Commit anyway":

```svelte
					{committing
						? 'Committing…'
						: errorCount > 0 && !commitBlocked
							? `Commit anyway (${total})`
							: `Commit (${total})`}
```

- [ ] **Step 6: Run test + check**

Run: `pixi run -e frontend bash -c 'cd frontend && ./node_modules/.bin/vitest run src/lib/components/__tests__/DiffDrawer.strict.test.ts && npm run check'`
Expected: PASS + no new check errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/DiffDrawer.svelte frontend/src/lib/components/__tests__/DiffDrawer.strict.test.ts
git commit -m "feat(frontend): DiffDrawer disables commit under strict-mode block

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Frontend — owner-gated strict-mode toggle UI

**Files:**
- Create: `frontend/src/lib/components/SettingsDialog.svelte`
- Modify: `frontend/src/lib/components/TopBar.svelte` (Settings button + dialog mount)
- Modify: `frontend/src/lib/state/ui.svelte.ts` (settings-dialog open-state — mirror the history-drawer open-state)
- Test: `frontend/src/lib/components/__tests__/SettingsDialog.test.ts` (create)

**Interfaces:**
- Consumes: `getSettings`/`updateSettings` (Task 6), `getStrictMode`/`setProjectInfo` (Task 6), `getRole` (`checkout.svelte.ts:71`).
- Produces: a dialog with an owner-only strict-mode switch; non-owners see the state read-only/disabled.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/__tests__/SettingsDialog.test.ts` mirroring `SwapMetamodelDrawer.test.ts` (it already exercises the owner/non-owner `getRole` gating pattern). Assert:
- as `owner`: the switch is enabled; toggling it calls `PATCH /settings` (MSW handler captures the body) and updates the displayed state.
- as `viewer`: the switch is disabled / shows read-only text "Only an owner can change this."

```ts
// owner case
expect(screen.getByRole('switch')).toBeEnabled();
await fireEvent.click(screen.getByRole('switch'));
// assert PATCH body was { strict_mode: true } via the MSW handler capture

// viewer case (re-render with role 'viewer')
expect(screen.getByText(/only an owner/i)).toBeInTheDocument();
```

Mirror `SwapMetamodelDrawer.test.ts`'s harness (how it stubs `getRole`, how it mounts, its MSW server) exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && ./node_modules/.bin/vitest run src/lib/components/__tests__/SettingsDialog.test.ts'`
Expected: FAIL — cannot resolve `SettingsDialog.svelte`.

- [ ] **Step 3: Add the UI open-state**

In `frontend/src/lib/state/ui.svelte.ts`, add a settings-dialog open flag mirroring the existing history-drawer open-state (find it: `grep -n "history" frontend/src/lib/state/ui.svelte.ts`). Add the parallel `settingsOpen` getter/setter/toggle and export through the state barrel if the history one is.

- [ ] **Step 4: Build the dialog**

Create `frontend/src/lib/components/SettingsDialog.svelte`. Mirror `SwapMetamodelDrawer.svelte` for the `Dialog` shell + `isOwner = $derived(getRole() === 'owner')` gate. On open, call `getSettings()` to seed the switch; on toggle (owner only) call `await updateSettings(next)` then `setStrictMode(res.strict_mode)` (the checkout setter from Task 6) so the DiffDrawer gate updates immediately. Show a short explanation: "When on, commits with validation errors are blocked (rebind is exempt)." Non-owners get the disabled switch + "Only an owner can change this."

- [ ] **Step 5: Mount it from TopBar**

In `TopBar.svelte`, add a "Settings" button (mirror the existing "History" button wiring — `grep -n "History\|history" frontend/src/lib/components/TopBar.svelte`) that toggles `settingsOpen`, and mount `<SettingsDialog />` alongside the other dialogs.

- [ ] **Step 6: Run test + check**

Run: `pixi run -e frontend bash -c 'cd frontend && ./node_modules/.bin/vitest run src/lib/components/__tests__/SettingsDialog.test.ts && npm run check'`
Expected: PASS + no new check errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/SettingsDialog.svelte frontend/src/lib/components/TopBar.svelte frontend/src/lib/state/ui.svelte.ts frontend/src/lib/state/checkout.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/components/__tests__/SettingsDialog.test.ts
git commit -m "feat(frontend): owner-gated strict-mode toggle in Settings dialog

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: E2E smoke + README

**Files:**
- Create: `frontend/e2e/strict-mode.spec.ts`
- Modify: `frontend/README.md` (document strict mode)
- Test: the e2e spec itself

**Interfaces:**
- Consumes: the whole stack (Tasks 1-8) end to end.

- [ ] **Step 1: Write the e2e smoke**

Mirror `frontend/e2e/history.spec.ts`'s setup (load metamodel from file → empty model → make an edit). Add `frontend/e2e/strict-mode.spec.ts` that: opens Settings, enables strict mode (toggle), makes an edit that produces a validation error, opens the commit diff, asserts the commit button is disabled with the strict-mode message, then disables strict mode and asserts the same batch can now commit (button enabled / "Commit anyway"). Reuse the existing spec's selectors/utilities; do not invent a new harness.

- [ ] **Step 2: Run the e2e smoke**

Run: `rm -f /tmp/data-rover-e2e.db && pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'`
Expected: PASS (existing + new smoke green). (The `rm` works around the known pre-existing sqlite/MemorySnapshotStore cross-restart flake.)

- [ ] **Step 3: Update README**

In `frontend/README.md`, under "Architecture" / "Where to find things", document: a **Settings** dialog (TopBar) with an owner-gated **strict-mode** toggle (`GET`/`PATCH /settings`); strict mode promotes the conformance tier to a hard commit blocker (scoped to the dirty set, rebind exempt); the DiffDrawer disables "Commit anyway" when preview reports `would_block`. Add `SettingsDialog.svelte` and `api/settings.ts` to the file map.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/strict-mode.spec.ts frontend/README.md
git commit -m "test(frontend): e2e smoke for strict-mode gate; README

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `pixi run -e core-dev pytest tests/ -q` — all pass (1 integration test may be deselected).
- [ ] `pixi run lint-backend` — ruff + mypy + pyright clean.
- [ ] `pixi run -e frontend bash -c 'cd frontend && ./node_modules/.bin/vitest run'` — all pass.
- [ ] `pixi run -e frontend bash -c 'cd frontend && npm run check'` — no new errors in touched files.
- [ ] `rm -f /tmp/data-rover-e2e.db && pixi run -e frontend bash -c 'cd frontend && npm run test:e2e'` — all pass.
- [ ] Manual (optional): `pixi run start-backend` + `pixi run start-frontend`; enable strict mode as owner; attempt a non-conforming commit (blocked); verify a rebind still lands; disable strict; commit succeeds.

## Notes for the implementer

- **The strict-mode tests use free-floating creates on purpose.** A `create_element` with no existing resource id needs **no lock** (`test_commit_creates_freefloating_without_lock` in `tests/api/test_commits_route.py`), so the plan's commit tests pass `lock_tokens: []` and never touch the lock API. The conformance violation comes from a required `name` property (multiplicity `"1"`) in `_MM_STRICT` — creating a `Node` with `{}` trips multiplicity (CONFORMANCE), not structure. If you ever extend these tests to lock-requiring ops (e.g. `set_property` on an existing element), copy the `_lock()` helper from `tests/api/test_commits_route.py` — do not hand-roll lock acquisition.
- **The strict gate is scoped by construction** — it inspects `res.dirty` only (via `scoped`), so enabling strict mode on an already-non-conforming model is safe and instant; no whole-model sweep is ever added.
- **Rebind exemption is structural, not conditional** — rebind has its own route (`routes/metamodel_swap.py`) and never calls the `/commits` handler, so it needs no explicit `if`. The Task 5 rebind-exempt test guards against a future refactor accidentally routing rebind through the gate.
- **JSON change-tracking:** always reassign `row.validation_policy = <new dict>` (Task 1) — mutating it in place will not be persisted by SQLAlchemy.
- **Revert is not separately gated, and that is correct.** The spec (§6) notes revert "is subject to strict mode" but observes "restoring a prior clean state will not trip it." `POST /commits/revert` is its own route and does not pass through the `/commits` strict gate, so this plan adds no gate there. That is behaviourally faithful: revert restores *previously-committed (already-accepted)* state, and the only way prior state is non-conforming under the *current* metamodel is across a rebind — which revert already refuses with 409 (`b0caf7e`/`ad75988`). So revert cannot introduce a new conformance violation that strict mode would need to catch. If a future change makes revert able to produce fresh conformance issues, replicate the Task 4 gate in the revert handler.
- **Do not push;** finish via finishing-a-development-branch.
```
