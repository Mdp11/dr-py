# Phase 1 — SessionRegistry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the process-wide `Session` singleton with a `SessionRegistry` that holds one independent in-memory `Session` per project id, selected per-request, so a single backend can serve multiple isolated projects.

**Architecture:** Introduce `SessionRegistry` (a lazily-populated `dict[project_id, Session]`) in `src/data_rover/api/session.py`, replacing the module-global `_session`. The no-arg `get_session()` is retained for internal/test use and returns the **default project's** session, so all existing call sites and tests keep working unchanged. Routes resolve the active project from an `X-Project-Id` request header (defaulting to the default project) via a new `get_request_session` dependency in `deps.py`. Path-segment project routing and membership authorization are deferred to Phase 2.

**Tech Stack:** Python 3.14 (pyright floor 3.10), FastAPI, pytest, pixi (`core-dev` env for lint/test). Reference: `docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md` §3, §6, §11.

**Scope note:** This is one phase of an 8-phase architecture spec. It is self-contained, leaves the system fully green at every commit, and ships value on its own (multi-project isolation on a single instance). Tenancy, auth, durable persistence, and locking are later phases — do **not** pull them in here.

---

### Task 1: `SessionRegistry` class (pure unit, TDD)

Adds the registry to `session.py` (same module as `Session` to avoid a circular import — `Session` and the registry are tightly coupled and the file is small). No FastAPI involved yet.

**Files:**
- Modify: `src/data_rover/api/session.py` (add `DEFAULT_PROJECT_ID` + `SessionRegistry`)
- Test: `tests/api/test_session_registry.py` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_session_registry.py`:

```python
from __future__ import annotations

from data_rover.api.session import (
    DEFAULT_PROJECT_ID,
    Session,
    SessionRegistry,
)


def test_get_creates_session_on_first_access() -> None:
    reg = SessionRegistry()
    assert isinstance(reg.get("p1"), Session)


def test_get_returns_same_instance_for_same_id() -> None:
    reg = SessionRegistry()
    assert reg.get("p1") is reg.get("p1")


def test_distinct_ids_get_distinct_sessions() -> None:
    reg = SessionRegistry()
    assert reg.get("p1") is not reg.get("p2")


def test_sessions_are_isolated() -> None:
    reg = SessionRegistry()
    reg.get("p1").model_rev = 5
    assert reg.get("p2").model_rev == 0


def test_evict_drops_session_so_next_get_is_fresh() -> None:
    reg = SessionRegistry()
    first = reg.get("p1")
    reg.evict("p1")
    assert reg.get("p1") is not first


def test_evict_unknown_id_is_noop() -> None:
    reg = SessionRegistry()
    reg.evict("never-created")  # must not raise


def test_reset_drops_all_sessions() -> None:
    reg = SessionRegistry()
    first = reg.get("p1")
    reg.reset()
    assert reg.get("p1") is not first


def test_default_project_id_is_a_nonempty_str() -> None:
    assert isinstance(DEFAULT_PROJECT_ID, str) and DEFAULT_PROJECT_ID
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_session_registry.py -v`
Expected: FAIL — `ImportError: cannot import name 'SessionRegistry'` (and `DEFAULT_PROJECT_ID`).

- [ ] **Step 3: Implement `DEFAULT_PROJECT_ID` and `SessionRegistry`**

In `src/data_rover/api/session.py`, replace the trailing singleton block (the `_session = Session()`, `get_session`, and `reset_session` definitions, lines ~112–129) with the registry. First add the class **above** the module-level wiring (right after the `Session` class, before any module-level instance):

```python
#: Project id used when a request carries no ``X-Project-Id`` header. Phase 1
#: keeps a single implicit project so existing single-project clients and the
#: whole test-suite behave exactly as before the registry was introduced.
DEFAULT_PROJECT_ID = "default"


class SessionRegistry:
    """Holds one live :class:`Session` per project id, created on first access.

    Replaces the former process-wide singleton. Each project gets an
    independent in-memory ``Session`` (metamodel + model + view + validation
    baseline + op_log + model_rev), so mutating one project never affects
    another. Sessions are created lazily by :meth:`get`; :meth:`evict` drops a
    single project; :meth:`reset` drops them all (test isolation). Later phases
    add durable hydration-on-miss and idle eviction here without changing
    callers.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}

    def get(self, project_id: str) -> Session:
        session = self._sessions.get(project_id)
        if session is None:
            session = Session()
            self._sessions[project_id] = session
        return session

    def evict(self, project_id: str) -> None:
        self._sessions.pop(project_id, None)

    def reset(self) -> None:
        self._sessions.clear()

    def project_ids(self) -> list[str]:
        return list(self._sessions)
```

Leave the old `_session` / `get_session` / `reset_session` block in place for now — Task 2 rewires it. (The new tests only need the class + constant.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_session_registry.py -v`
Expected: PASS (8 passed).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/session.py tests/api/test_session_registry.py
git commit -m "feat(api): add SessionRegistry for per-project sessions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Back `get_session`/`reset_session` with the registry (remove the singleton)

Rewire the module so the registry is the single source of sessions. `get_session()` stays **no-arg** and returns the default project's session, so every existing route (`Depends(get_session)`) and every test (`get_session()`, `reset_session()`) keeps working with zero changes.

**Files:**
- Modify: `src/data_rover/api/session.py` (replace `_session`/`get_session`/`reset_session`)
- Test: `tests/api/test_session_registry.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_session_registry.py`:

```python
def test_get_session_returns_default_project_session() -> None:
    from data_rover.api.session import (
        DEFAULT_PROJECT_ID,
        get_registry,
        get_session,
        reset_session,
    )

    reset_session()
    assert get_session() is get_registry().get(DEFAULT_PROJECT_ID)


def test_get_session_is_stable_across_calls() -> None:
    from data_rover.api.session import get_session, reset_session

    reset_session()
    assert get_session() is get_session()


def test_reset_session_clears_all_projects() -> None:
    from data_rover.api.session import get_registry, get_session, reset_session

    reset_session()
    before = get_session()
    get_registry().get("other").model_rev = 9
    reset_session()
    assert get_session() is not before
    assert get_registry().get("other").model_rev == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_session_registry.py -k "registry or default_project" -v`
Expected: FAIL — `ImportError: cannot import name 'get_registry'`.

- [ ] **Step 3: Replace the singleton wiring**

In `src/data_rover/api/session.py`, delete the old block:

```python
_session = Session()


def get_session() -> Session:
    return _session


def reset_session() -> None:
    """Reset the process-wide session to a fresh default state.

    Field-agnostic on purpose: every dataclass field is copied from a newly
    constructed ``Session`` so adding a field can never silently leak state
    across resets through a hand-maintained list here.
    """
    fresh = Session()
    for f in fields(Session):
        setattr(_session, f.name, getattr(fresh, f.name))
```

Replace it with:

```python
_registry = SessionRegistry()


def get_registry() -> SessionRegistry:
    """Return the process-wide session registry."""
    return _registry


def get_session() -> Session:
    """Return the DEFAULT project's session.

    Kept no-arg for internal callers and tests that have no request context.
    Request-scoped routes resolve the active project via
    ``deps.get_request_session`` instead.
    """
    return _registry.get(DEFAULT_PROJECT_ID)


def reset_session() -> None:
    """Drop all per-project sessions (test isolation).

    A fresh ``Session`` is created on the next ``get`` for any id, so this is
    field-agnostic — adding a ``Session`` field can never leak across resets.
    """
    _registry.reset()
```

The `fields` import (`from dataclasses import dataclass, field, fields`) is now unused — change that import line to `from dataclasses import dataclass, field`.

- [ ] **Step 4: Run the full API suite to verify nothing regressed**

Run: `pixi run -e core-dev pytest tests/api -q`
Expected: PASS (all existing api tests + the new registry tests). The no-arg `get_session()` now resolves to the default project, which is exactly the session the routes mutate when no header is sent.

- [ ] **Step 5: Lint/typecheck**

Run: `pixi run lint-backend`
Expected: ruff, mypy, and pyright all pass (confirms the removed `fields` import is clean).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/session.py tests/api/test_session_registry.py
git commit -m "refactor(api): back get_session with the registry, drop singleton

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Per-request project resolution + switch routes to it

Add a request-scoped dependency that reads the `X-Project-Id` header (default = default project) and returns that project's session. Point every route at it. Because a header-less request resolves to the default project, the existing test-suite (which sends no header) stays green.

**Files:**
- Modify: `src/data_rover/api/deps.py` (add `get_request_session`, export it)
- Modify (mechanical): `src/data_rover/api/routes/{model,ops,read,view,metamodel,elements,relationships,validation,change_request}.py` (swap the dependency)

- [ ] **Step 1: Add `get_request_session` to `deps.py`**

Edit `src/data_rover/api/deps.py`. Change the imports:

```python
from fastapi import HTTPException, Request

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model

from .session import DEFAULT_PROJECT_ID, Session, get_registry, get_session
from .settings import get_settings
```

Extend `__all__`:

```python
__all__ = [
    "Session",
    "get_request_session",
    "get_session",
    "require_allowed_origin",
    "require_metamodel",
    "require_model",
]
```

Add the dependency (place it after `require_allowed_origin`, before `require_metamodel`):

```python
def get_request_session(request: Request) -> Session:
    """Resolve the active project's :class:`Session` from the request.

    Phase 1: the project id is taken from the ``X-Project-Id`` header,
    defaulting to ``DEFAULT_PROJECT_ID`` when absent — this preserves the
    behavior of every existing single-project client and the test-suite while
    making the backend able to hold multiple isolated projects at once. Later
    phases replace the header with a ``/projects/{id}`` path segment guarded by
    membership authorization.
    """
    project_id = request.headers.get("x-project-id", DEFAULT_PROJECT_ID)
    return get_registry().get(project_id)
```

`get_session` stays imported/exported (still used internally and by tests).

- [ ] **Step 2: Write the failing test**

Append to `tests/api/test_session_registry.py`:

```python
def test_get_request_session_uses_header_project() -> None:
    from starlette.requests import Request

    from data_rover.api.deps import get_request_session
    from data_rover.api.session import get_registry, reset_session

    reset_session()

    def make_request(headers: list[tuple[bytes, bytes]]) -> Request:
        return Request({"type": "http", "headers": headers})

    s_a = get_request_session(make_request([(b"x-project-id", b"proj-a")]))
    s_b = get_request_session(make_request([(b"x-project-id", b"proj-b")]))
    s_default = get_request_session(make_request([]))

    assert s_a is get_registry().get("proj-a")
    assert s_b is get_registry().get("proj-b")
    assert s_a is not s_b
    assert s_default is get_registry().get("default")
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_session_registry.py::test_get_request_session_uses_header_project -v`
Expected: FAIL — `ImportError: cannot import name 'get_request_session'` (run before Step 1 if you prefer strict red; otherwise this passes once Step 1 is in — in that case proceed, the value is the regression guard).

- [ ] **Step 4: Switch every route from `get_session` to `get_request_session`**

In each of the nine route files below, the dependency is used two ways: in the import line (`from ..deps import ... get_session ...`) and at call sites (`Depends(get_session)`). Replace **only the dependency-injection usage**, not any direct `get_session()` calls (routes have none — all route usage is via `Depends`).

Apply this exact transformation to each file:

```bash
for f in model ops read view metamodel elements relationships validation change_request; do
  sed -i 's/Depends(get_session)/Depends(get_request_session)/g' \
    "src/data_rover/api/routes/$f.py"
done
```

Then fix the imports in each file so `get_request_session` is imported. The import lines currently read variously, e.g. `from ..deps import Session, get_session, require_model`. Update each to import `get_request_session` instead of (or in addition to) `get_session`. Concretely, run:

```bash
for f in model ops read view metamodel elements relationships validation change_request; do
  sed -i 's/\bget_session\b/get_request_session/g' \
    "src/data_rover/api/routes/$f.py"
done
```

This second pass also rewrites the import token. After running it, **verify no `get_session` token remains in the routes** (only `get_request_session` should appear):

```bash
grep -rn "get_session" src/data_rover/api/routes/ || echo "clean: no get_session left in routes"
```

Note `model.py` imports `get_session` on its own line inside a multi-line import (line ~20) — the `\bget_session\b` substitution handles it. Open `src/data_rover/api/routes/model.py` and confirm the import now reads `get_request_session`.

- [ ] **Step 5: Run the full API suite**

Run: `pixi run -e core-dev pytest tests/api -q`
Expected: PASS. Tests send no `X-Project-Id` header → routes resolve the default project → identical to before.

- [ ] **Step 6: Lint/typecheck**

Run: `pixi run lint-backend`
Expected: ruff, mypy, pyright all pass.

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/deps.py src/data_rover/api/routes tests/api/test_session_registry.py
git commit -m "feat(api): resolve per-request project via X-Project-Id header

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: End-to-end multi-project isolation test

Prove the whole point of Phase 1 through the HTTP layer: two projects selected by header are fully isolated.

**Files:**
- Test: `tests/api/test_multi_project.py` (create)

- [ ] **Step 1: Write the test**

Create `tests/api/test_multi_project.py`:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import reset_session

SIMPLE_MM = """
elements:
  - name: Block
"""


@pytest.fixture
def client() -> TestClient:
    reset_session()
    return TestClient(create_app())


def test_metamodel_loaded_in_one_project_is_invisible_to_another(
    client: TestClient,
) -> None:
    # Load a metamodel into project "alpha".
    res = client.post(
        "/api/v1/metamodel",
        content=SIMPLE_MM,
        headers={"content-type": "application/x-yaml", "x-project-id": "alpha"},
    )
    assert res.status_code == 200, res.text

    # Project "alpha" sees it.
    res_alpha = client.get("/api/v1/metamodel", headers={"x-project-id": "alpha"})
    assert res_alpha.status_code == 200, res_alpha.text

    # Project "beta" has nothing loaded.
    res_beta = client.get("/api/v1/metamodel", headers={"x-project-id": "beta"})
    assert res_beta.status_code == 404, res_beta.text

    # The header-less default project is also independent of "alpha".
    res_default = client.get("/api/v1/metamodel")
    assert res_default.status_code == 404, res_default.text


def test_models_in_two_projects_do_not_share_state(client: TestClient) -> None:
    for pid in ("alpha", "beta"):
        res = client.post(
            "/api/v1/metamodel",
            content=SIMPLE_MM,
            headers={"content-type": "application/x-yaml", "x-project-id": pid},
        )
        assert res.status_code == 200, res.text

    # Put one Block element into "alpha" only.
    res = client.post(
        "/api/v1/model",
        json={
            "elements": [{"id": "b1", "type_name": "Block", "properties": {}}],
            "relationships": [],
        },
        headers={"x-project-id": "alpha"},
    )
    assert res.status_code == 200, res.text

    # "alpha" has the element; "beta" has an empty model.
    summary_alpha = client.get(
        "/api/v1/model/summary", headers={"x-project-id": "alpha"}
    ).json()
    summary_beta = client.get(
        "/api/v1/model/summary", headers={"x-project-id": "beta"}
    ).json()
    assert summary_alpha["element_count"] == 1, summary_alpha
    assert summary_beta["element_count"] == 0, summary_beta
```

- [ ] **Step 2: Confirm endpoint paths/shape match the codebase**

Before running, verify the two read endpoints used above exist with these response shapes:

Run: `grep -rn "summary\|element_count" src/data_rover/api/routes/read.py | head`
Expected: a `GET /model/summary` route returning a `ModelSummary` with an `element_count` field. If the field name differs (e.g. `n_elements`), update the assertions in the test to match the actual `ModelSummary` schema in `src/data_rover/api/schemas.py` — do **not** change the route.

- [ ] **Step 3: Run the test**

Run: `pixi run -e core-dev pytest tests/api/test_multi_project.py -v`
Expected: PASS (2 passed).

- [ ] **Step 4: Run the full suite + lint once more**

Run: `pixi run -e core-dev pytest tests/api -q && pixi run lint-backend`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add tests/api/test_multi_project.py
git commit -m "test(api): assert per-project session isolation over HTTP

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria

- The module-global `Session` singleton is gone; `SessionRegistry` is the only source of sessions.
- `get_session()` / `reset_session()` keep their signatures and semantics for tests and internal use (default project).
- Every route resolves its session per-request via `X-Project-Id` (default project when absent).
- Two projects are provably isolated end-to-end over HTTP.
- Full `tests/api` suite green; `pixi run lint-backend` green.

## Out of scope (later phases — do NOT add here)

- `/projects/{id}` path-segment routing and the `Project`/`User`/`Membership` tables (Phase 2).
- Authentication seam / authorization on project access (Phase 2).
- Durable hydration-on-miss and idle eviction inside `SessionRegistry` (Phase 3).
- Per-project write-mutex / concurrency serialization (Phase 4 — current tests are single-threaded; the registry is not yet thread-safe, which is acceptable until then).

---

## Self-review

**Spec coverage (against spec §6 "Runtime — Session singleton → SessionRegistry"):**
- "Un-singleton `Session` → `SessionRegistry` keyed by `project_id`" → Tasks 1–2. ✓
- "routes carry project_id" → Task 3 (header form; path-segment form explicitly deferred to Phase 2 per the spec's phasing table, which lists tenancy/auth in Phase 2). ✓
- "hydrate on cache-miss / evict on idle" → explicitly out of scope (Phase 3); `get` create-on-miss is the seam where hydration later lands. ✓ (noted)
- Isolation (the reason for the change) → Task 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✓

**Type/name consistency:** `SessionRegistry.get/evict/reset/project_ids`, `DEFAULT_PROJECT_ID`, `get_registry`, `get_session`, `get_request_session` are used identically across Tasks 1–4 and the `deps.py`/route edits. The Task 4 test depends only on existing endpoints (`POST /api/v1/metamodel`, `POST /api/v1/model`, `GET /api/v1/metamodel`, `GET /api/v1/model/summary`), with Step 2 guarding the one uncertain field name (`element_count`). ✓

**Green-at-every-commit check:** Task 1 adds unused-by-routes code (green). Task 2 keeps `get_session()` no-arg → default project, so all header-less tests stay green. Task 3 makes routes header-aware but header-less requests still hit the default project, so tests stay green. Task 4 only adds tests. ✓
