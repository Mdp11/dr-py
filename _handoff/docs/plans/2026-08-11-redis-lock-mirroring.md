# Redis Lock Mirroring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resource leases survive a backend restart (write-through mirror to Redis + restore at session hydration) with zero change to lock semantics and zero hard runtime dependency.

**Architecture:** `LockTable` stays the only conflict authority and is mirror-unaware (one additive `seed` method). A new two-method `LeaseMirror` seam (`write`/`load`, whole-set JSON per project) gets a write-through call after each of five lease mutation sites; the registry's hydration loader seeds restored leases back. Redis impl is optional and degrade-graceful (timeouts + cooldown); Null impl when unconfigured; Memory impl for hermetic tests. Spec: `docs/superpowers/specs/2026-08-11-redis-lock-mirroring-design.md`.

**Tech Stack:** Python 3.14, FastAPI, redis-py (new dep), pixi toolchain, pytest.

## Global Constraints

- **All commands through pixi** — there is no global `python`/`node`. Tests: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v` (or `pixi run core-test` for the full suite). Lint/format/typecheck: `pixi run dr-tidy` (ruff + mypy + pyright must ALL pass).
- **Python 3.14 idioms** — PEP 604 unions, `from __future__ import annotations`, dataclasses; ruff `UP` rules are enforced.
- **Conventional commits, NO trailers** (no Co-Authored-By).
- **Never push to origin. Never commit anything under `docs/superpowers/` or `.superpowers/`** (gitignored).
- **The Phase 1–5 backend wire contract is frozen — ADD only.** This plan adds no routes and changes no response shapes; it only adds side effects.
- **Degraded, never failed:** no lock route, commit, sweep, or hydration may ever fail because of the mirror. Every mirror interaction is wrapped.
- **Dense docstrings** stating *why* invariants exist — house style; the code blocks below include them, keep them.
- API tests: use `tests/api/conftest.py` helpers (`client`-style fixtures, `seed_default_project`, `AUTH_HEADERS`, `papi`). Every project-scoped request needs `AUTH_HEADERS`.

---

### Task 0: Branch

**Files:** none (git only)

- [ ] **Step 1: Create the feature branch off main**

```bash
cd /home/mdp/workspace/data-rover-py
git checkout main && git status --short   # must be clean
git checkout -b feat/redis-lock-mirroring
```

---

### Task 1: `lock_mirror.py` core — seam, impls, clock conversion, setting

**Files:**
- Create: `src/data_rover/api/lock_mirror.py`
- Modify: `src/data_rover/api/settings.py` (add `redis_url` after `storage_emulator_host`, ~line 72)
- Create: `tests/api/test_lock_mirror.py`

**Interfaces:**
- Consumes: `locking.Lease`, `locking.LockMode`, `locking.LockIntent`, `locking.LockTable` (existing).
- Produces (used by Tasks 2–4):
  - `MirroredLease` frozen dataclass: `(resource_id: str, mode: str, holder: str, token: str, intent: str, expires_at_epoch: float, holder_email: str = "")`
  - `LeaseMirror` Protocol: `write(project_id: str, leases: list[MirroredLease]) -> None`, `load(project_id: str) -> list[MirroredLease]`
  - `NullLeaseMirror`, `MemoryLeaseMirror` (extra test hook: `.load()` returns copies)
  - `get_lease_mirror() -> LeaseMirror`, `set_lease_mirror(mirror: LeaseMirror | None) -> None`
  - `build_mirror_from_settings(settings: Settings) -> LeaseMirror`
  - `to_mirrored(leases: list[Lease], *, mono_now: float, wall_now: float) -> list[MirroredLease]`
  - `to_leases(mirrored: list[MirroredLease], *, mono_now: float, wall_now: float) -> list[Lease]`
  - `mirror_session_leases(project_id: str, session: Session) -> None`
  - `restore_leases(project_id: str, table: LockTable) -> None`
  - Constants: `ENVELOPE_VERSION = 1`, `KEY_TTL_SLACK_S = 60.0`, `lease_key(project_id) -> str` (`dr:leases:{project_id}`)
  - `Settings.redis_url: str = ""` (`DATA_ROVER_REDIS_URL`)

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_lock_mirror.py`:

```python
"""Lease mirror (Phase 7, scoped): seam, clock conversion, write-through,
restore-on-hydrate, degradation. Redis itself is only touched by the
integration-marked test in test_lock_mirror_redis.py."""

from __future__ import annotations

import time

from data_rover.api.lock_mirror import (
    MemoryLeaseMirror,
    MirroredLease,
    NullLeaseMirror,
    build_mirror_from_settings,
    to_leases,
    to_mirrored,
)
from data_rover.api.locking import Lease, LockIntent, LockMode
from data_rover.api.settings import Settings


def _lease(rid: str = "e1", *, expires_at: float, token: str = "tok1") -> Lease:
    return Lease(
        resource_id=rid,
        mode=LockMode.EXCLUSIVE,
        holder="test-user",
        token=token,
        intent=LockIntent.EDIT,
        expires_at=expires_at,
        holder_email="test@example.com",
    )


def test_round_trip_preserves_identity_and_remaining_ttl() -> None:
    mono, wall = 1000.0, 5000.0
    src = _lease(expires_at=mono + 120.0)
    [m] = to_mirrored([src], mono_now=mono, wall_now=wall)
    assert m.expires_at_epoch == wall + 120.0
    assert (m.resource_id, m.mode, m.holder, m.token, m.intent, m.holder_email) == (
        "e1", "exclusive", "test-user", "tok1", "edit", "test@example.com",
    )
    # restore into a "restarted" process: different monotonic origin, +10s wall
    [back] = to_leases([m], mono_now=50.0, wall_now=wall + 10.0)
    assert back.expires_at == 50.0 + 110.0  # remaining shrank by wall elapsed
    assert back.token == "tok1" and back.mode is LockMode.EXCLUSIVE
    assert back.intent is LockIntent.EDIT and back.holder == "test-user"


def test_expired_entries_dropped_on_both_conversions() -> None:
    mono, wall = 1000.0, 5000.0
    assert to_mirrored([_lease(expires_at=mono - 1.0)], mono_now=mono, wall_now=wall) == []
    stale = MirroredLease("e1", "exclusive", "u", "t", "edit", wall - 1.0)
    assert to_leases([stale], mono_now=mono, wall_now=wall) == []


def test_memory_mirror_write_load_and_empty_deletes() -> None:
    m = MemoryLeaseMirror()
    lease = MirroredLease("e1", "exclusive", "u", "t", "edit", time.time() + 60)
    m.write("p1", [lease])
    assert m.load("p1") == [lease]
    m.write("p1", [])
    assert m.load("p1") == []
    assert m.load("never-written") == []


def test_null_mirror_is_inert() -> None:
    n = NullLeaseMirror()
    n.write("p1", [MirroredLease("e1", "exclusive", "u", "t", "edit", 1.0)])
    assert n.load("p1") == []


def test_build_from_settings_empty_url_is_null() -> None:
    s = Settings(redis_url="")
    assert isinstance(build_mirror_from_settings(s), NullLeaseMirror)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'data_rover.api.lock_mirror'`

- [ ] **Step 3: Add the setting**

In `src/data_rover/api/settings.py`, directly after the `storage_emulator_host` field (~line 72), add:

```python
    #: Redis URL for the lease mirror (Phase 7, scoped), e.g.
    #: ``redis://localhost:6379/0``. Empty (the default) disables mirroring
    #: entirely (NullLeaseMirror): locks are in-process only — exactly the
    #: pre-mirror behavior. When set, mirroring is still best-effort: a down
    #: Redis degrades (warn + cooldown), it never fails a lock operation.
    redis_url: str = ""
```

- [ ] **Step 4: Write `src/data_rover/api/lock_mirror.py`**

```python
"""Write-through lease mirror (Phase 7, scoped): leases survive a backend
restart and are observable from outside the process (redis-cli).

``LockTable`` (locking.py) stays the ONLY authority for conflict decisions;
the mirror never participates in one. After each successful lease mutation the
caller mirrors the project's ENTIRE live lease set wholesale
(:func:`mirror_session_leases`); on session hydration the fresh table is
seeded back (:func:`restore_leases`) with the ORIGINAL tokens, so a client
that outlived the restart keeps renewing the token it already holds. Whole-set
rewrite is idempotent and self-healing: a mirror that lagged truth during an
outage re-converges on the next mutation, and the client renew heartbeat
guarantees one within ttl/2 for any lease still held.

Clock mapping: ``Lease.expires_at`` is ``time.monotonic()`` — meaningless
across processes. Conversion to/from wall clock (``time.time()``) happens in
:func:`to_mirrored` / :func:`to_leases` and nowhere else.

One Protocol, three impls: ``RedisLeaseMirror`` (lock_mirror_redis.py — the
real one, import isolated like storage_gcs), :class:`MemoryLeaseMirror`
(hermetic tests) and :class:`NullLeaseMirror` (``redis_url`` unset). The
active mirror is a process-global behind a getter/setter seam, mirroring
``storage.get_snapshot_store`` / ``set_snapshot_store``.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from .locking import Lease, LockIntent, LockMode, LockTable

if TYPE_CHECKING:
    from .session import Session
    from .settings import Settings

logger = logging.getLogger(__name__)

#: Redis key holding one project's mirrored lease set (JSON envelope).
_LEASE_KEY = "dr:leases:{project_id}"
#: Envelope schema version; unknown versions load as empty (forward safety).
ENVELOPE_VERSION = 1
#: Slack added to the Redis key TTL past the latest lease expiry, so an
#: orphaned mirror (backend gone for good) self-cleans shortly after the
#: last lease would have expired anyway.
KEY_TTL_SLACK_S = 60.0


def lease_key(project_id: str) -> str:
    return _LEASE_KEY.format(project_id=project_id)


@dataclass(frozen=True)
class MirroredLease:
    """Wire form of a lease: enum values as strings, expiry as WALL clock."""

    resource_id: str
    mode: str  #: LockMode.value
    holder: str
    token: str
    intent: str  #: LockIntent.value
    expires_at_epoch: float  #: time.time()-based, NOT monotonic
    holder_email: str = ""


class LeaseMirror(Protocol):
    """Two methods only, on purpose: the mirror receives snapshots of truth
    and answers them back. It has no acquire/release/renew vocabulary and
    never participates in a conflict decision — which is what keeps it
    trivially correct and what the future ownership-lease work (full HA
    phase) extends rather than fights."""

    def write(self, project_id: str, leases: list[MirroredLease]) -> None: ...
    def load(self, project_id: str) -> list[MirroredLease]: ...


class NullLeaseMirror:
    """No-op mirror: ``redis_url`` unset. Locks are in-process only."""

    def write(self, project_id: str, leases: list[MirroredLease]) -> None:
        return None

    def load(self, project_id: str) -> list[MirroredLease]:
        return []


class MemoryLeaseMirror:
    """Dict-backed mirror for hermetic tests (cf. MemorySnapshotStore)."""

    def __init__(self) -> None:
        self._sets: dict[str, list[MirroredLease]] = {}

    def write(self, project_id: str, leases: list[MirroredLease]) -> None:
        if leases:
            self._sets[project_id] = list(leases)
        else:  # empty set == delete, matching the Redis impl's DEL
            self._sets.pop(project_id, None)

    def load(self, project_id: str) -> list[MirroredLease]:
        return list(self._sets.get(project_id, ()))


def to_mirrored(
    leases: list[Lease], *, mono_now: float, wall_now: float
) -> list[MirroredLease]:
    """Monotonic → wall clock; already-expired leases are dropped."""
    out: list[MirroredLease] = []
    for le in leases:
        remaining = le.expires_at - mono_now
        if remaining <= 0:
            continue
        out.append(
            MirroredLease(
                resource_id=le.resource_id,
                mode=le.mode.value,
                holder=le.holder,
                token=le.token,
                intent=le.intent.value,
                expires_at_epoch=wall_now + remaining,
                holder_email=le.holder_email,
            )
        )
    return out


def to_leases(
    mirrored: list[MirroredLease], *, mono_now: float, wall_now: float
) -> list[Lease]:
    """Wall clock → monotonic; entries that expired while we were down are
    dropped here rather than restored-then-swept, so a restored table never
    contains a lease the conflict matrix would have to re-check."""
    out: list[Lease] = []
    for m in mirrored:
        remaining = m.expires_at_epoch - wall_now
        if remaining <= 0:
            continue
        out.append(
            Lease(
                resource_id=m.resource_id,
                mode=LockMode(m.mode),
                holder=m.holder,
                token=m.token,
                intent=LockIntent(m.intent),
                expires_at=mono_now + remaining,
                holder_email=m.holder_email,
            )
        )
    return out


_mirror: LeaseMirror | None = None


def get_lease_mirror() -> LeaseMirror:
    """Process-global mirror, built from settings on first use."""
    global _mirror
    if _mirror is None:
        from .settings import get_settings

        _mirror = build_mirror_from_settings(get_settings())
    return _mirror


def set_lease_mirror(mirror: LeaseMirror | None) -> None:
    """Swap the mirror (``None`` resets to a settings-built default on next
    get). Tests MUST reset on teardown — process-global singleton; the API
    conftest does this automatically."""
    global _mirror
    _mirror = mirror


def build_mirror_from_settings(settings: Settings) -> LeaseMirror:
    if not settings.redis_url:
        return NullLeaseMirror()
    from .lock_mirror_redis import RedisLeaseMirror

    return RedisLeaseMirror(settings.redis_url)


def mirror_session_leases(project_id: str, session: Session) -> None:
    """Best-effort write-through: snapshot the live lease set and mirror it.

    Call AFTER the mutating ``with session.write_mutex:`` block has exited —
    this helper briefly takes the (non-reentrant) mutex itself for a coherent
    snapshot, then does mirror I/O OUTSIDE it so a slow Redis never extends a
    lock route's critical section. Two racing calls can write out of order;
    that is accepted (spec: the mirror may briefly lag truth) because the
    next mutation — at latest the renew heartbeat at ttl/2 — re-converges it.

    Never raises: a mirror failure must not fail a lock operation."""
    try:
        mono_now = time.monotonic()
        with session.write_mutex:
            leases = session.lock_table.active_leases(mono_now)
        payload = to_mirrored(leases, mono_now=mono_now, wall_now=time.time())
        get_lease_mirror().write(project_id, payload)
    except Exception:
        logger.warning(
            "lease mirror write failed for project %s", project_id, exc_info=True
        )


def restore_leases(project_id: str, table: LockTable) -> None:
    """Seed a freshly hydrated session's LockTable from the mirror.

    Runs inside the registry loader BEFORE the session serves any request, so
    no locking around ``table`` is needed. Restored leases keep their
    original tokens — token continuity across restart is the point of the
    mirror. Never raises: a mirror failure degrades to today's cold start
    (empty table)."""
    try:
        mirrored = get_lease_mirror().load(project_id)
        if not mirrored:
            return
        leases = to_leases(
            mirrored, mono_now=time.monotonic(), wall_now=time.time()
        )
        table.seed(leases)
        if leases:
            logger.info(
                "restored %d mirrored lease(s) for project %s",
                len(leases),
                project_id,
            )
    except Exception:
        logger.warning(
            "lease mirror load failed for project %s", project_id, exc_info=True
        )
```

Note: `restore_leases` calls `table.seed(...)`, which does not exist yet — it is added in Task 3. That is fine for this task's tests (nothing calls `restore_leases` yet); if you prefer green-per-commit strictness, pyright will not flag it either way only once Task 3 lands, so run only this file's tests here.

**Correction:** to keep every commit fully lint-clean, add the `seed` method NOW as part of this task (it is two lines and mirror-unaware). In `src/data_rover/api/locking.py`, after the `active_leases` method (~line 271):

```python
    def seed(self, leases: list[Lease]) -> None:
        """Bulk-install restored leases (hydration-time mirror restore ONLY).

        No conflict checking on purpose: the mirror holds a snapshot of a
        table that was internally consistent when written, and seeding runs
        inside the registry loader before the session serves any request —
        there is nothing to conflict with yet."""
        for le in leases:
            self._by_resource.setdefault(le.resource_id, []).append(le)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v`
Expected: 5 passed

- [ ] **Step 6: Lint/typecheck and commit**

```bash
pixi run dr-tidy
git add src/data_rover/api/lock_mirror.py src/data_rover/api/settings.py \
        src/data_rover/api/locking.py tests/api/test_lock_mirror.py
git commit -m "feat(api): LeaseMirror seam - clock-mapped lease snapshots, Null/Memory impls"
```

---

### Task 2: Write-through at the five mutation sites

**Files:**
- Modify: `src/data_rover/api/routes/locks.py` (acquire ~line 66, release ~116, renew ~129)
- Modify: `src/data_rover/api/routes/commits.py` (`create_commit`, after the write-mutex block, ~line 1107 `return CommitResponse(`)
- Modify: `src/data_rover/api/main.py` (`_sweep_expired_locks`, ~line 127)
- Modify: `tests/api/conftest.py` (install/reset `MemoryLeaseMirror` in `_fresh_db`)
- Test: `tests/api/test_lock_mirror.py` (extend)

**Interfaces:**
- Consumes (Task 1): `mirror_session_leases(project_id, session)`, `get_lease_mirror()`, `set_lease_mirror(...)`, `MemoryLeaseMirror`.
- Produces: after any successful acquire / release / renew / commit-release / sweep, `get_lease_mirror().load(project_id)` reflects the session's live lease set (tokens included).

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_lock_mirror.py` (route-level; fixture pattern copied from `tests/api/test_locks_route.py`):

```python
import pytest
from fastapi.testclient import TestClient

from data_rover.api.lock_mirror import get_lease_mirror, set_lease_mirror
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
    r = c.post(
        papi("/metamodel"), content=_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary")).json()["model_rev"]


def _create_element(c: TestClient) -> str:
    r = c.post(
        papi("/model/ops"),
        json={
            "base_rev": _rev(c),
            "ops": [{"kind": "create_element", "temp_id": "tmp_n",
                     "type_name": "Node", "properties": {}}],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id_map"]["tmp_n"]


def _acquire(c: TestClient, eid: str) -> str:
    r = c.post(
        papi("/locks"),
        json={"targets": [{"resource_id": eid, "mode": "exclusive"}],
              "intent": "edit"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_acquire_release_write_through(client: TestClient) -> None:
    eid = _create_element(client)
    token = _acquire(client, eid)
    mirrored = get_lease_mirror().load("default")
    assert [(m.resource_id, m.token, m.mode) for m in mirrored] == [
        (eid, token, "exclusive")
    ]
    r = client.post(papi("/locks/release"), json={"token": token})
    assert r.status_code == 200 and r.json()["released"] == 1
    assert get_lease_mirror().load("default") == []


def test_renew_write_through_extends_epoch(client: TestClient) -> None:
    eid = _create_element(client)
    _acquire(client, eid)
    [before] = get_lease_mirror().load("default")
    token = before.token
    r = client.post(papi("/locks/renew"), json={"token": token})
    assert r.status_code == 200 and r.json()["ok"] is True
    [after] = get_lease_mirror().load("default")
    assert after.expires_at_epoch >= before.expires_at_epoch


def test_commit_release_write_through(client: TestClient) -> None:
    # stage an update to an existing element: needs an edit lease, and the
    # commit (sent the token) must release it in the mirror too
    eid = _create_element(client)
    token = _acquire(client, eid)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "update_element", "id": eid,
                     "properties_patch": {}}],
            "message": "noop-ish edit",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    assert get_lease_mirror().load("default") == []


def test_mirror_failure_never_fails_the_route(client: TestClient) -> None:
    class ExplodingMirror:
        def write(self, project_id, leases):  # noqa: ANN001
            raise RuntimeError("redis is on fire")

        def load(self, project_id):  # noqa: ANN001
            raise RuntimeError("redis is on fire")

    eid = _create_element(client)
    set_lease_mirror(ExplodingMirror())
    token = _acquire(client, eid)  # 200 despite the exploding mirror
    r = client.post(papi("/locks/release"), json={"token": token})
    assert r.status_code == 200
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v -k "write_through or never_fails"`
Expected: the three `write_through` tests FAIL (mirror stays empty — no write-through yet); `never_fails` may already pass (nothing calls the mirror yet) — that is fine, it pins the contract for the wiring you are about to add.

- [ ] **Step 3: Install the Memory mirror in the API conftest**

In `tests/api/conftest.py`: extend the imports block (~line 38) and the `_fresh_db` fixture (~lines 50 and 59):

```python
from data_rover.api.lock_mirror import MemoryLeaseMirror, set_lease_mirror  # noqa: E402
```

In `_fresh_db`, next to `set_snapshot_store(MemorySnapshotStore())`:

```python
    set_lease_mirror(MemoryLeaseMirror())
```

and in the `finally:` block, next to `set_snapshot_store(None)`:

```python
    set_lease_mirror(None)
```

- [ ] **Step 4: Wire the three lock routes**

In `src/data_rover/api/routes/locks.py`:

Add the import:

```python
from ..lock_mirror import mirror_session_leases
```

`acquire_locks` — add `project_id: str` to the signature (FastAPI binds it from the router prefix `/api/v1/projects/{project_id}`) and call the helper after the success broadcast:

```python
@router.post("/locks", response_model=None)
def acquire_locks(
    project_id: str,
    payload: LockRequest,
    session: Session = Depends(get_request_session),
    user: User = Depends(get_current_user),
) -> LockResponse | JSONResponse:
```

and, replacing the final two lines of the function:

```python
    session.hub.broadcast(lock_event("acquired", _lease_event_dicts(leases)))
    mirror_session_leases(project_id, session)
    return LockResponse(token=token, leases=[_lease_out(le) for le in leases])
```

`release_locks` — same signature addition (`project_id: str` first), and:

```python
    if released:
        session.hub.broadcast(lock_event("released", _lease_event_dicts(released)))
        mirror_session_leases(project_id, session)
    return {"released": len(released)}
```

`renew_locks` — same signature addition, and:

```python
    with session.write_mutex:
        ok = session.lock_table.renew(user.id, payload.token, now=now, ttl=ttl)
    if ok:
        mirror_session_leases(project_id, session)
    return RenewResponse(ok=ok)
```

- [ ] **Step 5: Wire the commit release**

In `src/data_rover/api/routes/commits.py`, add to the imports:

```python
from ..lock_mirror import mirror_session_leases
```

In `create_commit` (which already has `project_id: str`), immediately after the `with session.write_mutex:` block dedents and before `return CommitResponse(` (~line 1107):

```python
    # write-through the post-release lease set (outside the mutex: the helper
    # re-takes it briefly for the snapshot; Redis I/O must not sit inside a
    # commit's critical section)
    if released:
        mirror_session_leases(project_id, session)
    return CommitResponse(
```

- [ ] **Step 6: Wire the sweeper**

In `src/data_rover/api/main.py`, add to the imports (near `from .storage import ...`):

```python
from .lock_mirror import mirror_session_leases
```

In `_sweep_expired_locks` (~line 127), the loop currently reads `for _pid, session in get_registry().warm_items():` — rename `_pid` to `pid` and, inside the existing `if expired:` block after the broadcast, add:

```python
            mirror_session_leases(pid, session)
```

- [ ] **Step 7: Run the full mirror test file, then the API suite**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v`
Expected: all pass.
Run: `pixi run -e core-dev pytest tests/api -q`
Expected: no regressions (the Memory mirror is inert for every other test).

- [ ] **Step 8: Lint/typecheck and commit**

```bash
pixi run dr-tidy
git add src/data_rover/api/routes/locks.py src/data_rover/api/routes/commits.py \
        src/data_rover/api/main.py tests/api/conftest.py tests/api/test_lock_mirror.py
git commit -m "feat(api): write-through lease mirroring at all five lock mutation sites"
```

---

### Task 3: Restore at session hydration

**Files:**
- Modify: `src/data_rover/api/session.py` (`install_persistent_registry`, ~line 435)
- Test: `tests/api/test_lock_mirror.py` (extend)

**Interfaces:**
- Consumes (Task 1): `restore_leases(project_id, table)`, `MirroredLease`, `get_lease_mirror()`, `set_lease_mirror(...)`; (existing) `session.reset_session()`, `LockTable.seed`.
- Produces: any session hydrated through the persistent registry loader starts with the mirror's still-live leases installed (original tokens).

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_lock_mirror.py`:

```python
import time as _time

from data_rover.api.lock_mirror import MirroredLease
from data_rover.api.session import reset_session

OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


def _add_member(user_id: str, email: str) -> None:
    from data_rover.api import db as _db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = _db.get_db()
    s = next(gen)
    try:
        s.add(User(id=user_id, email=email))
        s.commit()
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role.editor)
    finally:
        gen.close()


def test_leases_survive_restart(client: TestClient) -> None:
    """The point of the phase: acquire -> 'restart' -> same token still works,
    peers still conflict."""
    eid = _create_element(client)
    token = _acquire(client, eid)

    # simulate a backend restart: drop every in-memory session; the process-
    # global MemoryLeaseMirror survives (it plays the role of Redis)
    reset_session()

    # next request re-hydrates through the persistent loader -> restore
    r = client.post(papi("/locks/renew"), json={"token": token})
    assert r.status_code == 200 and r.json()["ok"] is True

    listed = client.get(papi("/locks")).json()["leases"]
    assert [(le["resource_id"], le["token"]) for le in listed] == [(eid, token)]

    # a peer editor still conflicts with the restored exclusive lease
    _add_member("user-2", "user2@example.com")
    r = client.post(
        papi("/locks"),
        json={"targets": [{"resource_id": eid, "mode": "exclusive"}],
              "intent": "edit"},
        headers=OTHER_HEADERS,
    )
    assert r.status_code == 409, r.text
    assert r.json()["conflicts"][0]["resource_id"] == eid


def test_expired_mirrored_lease_not_restored(client: TestClient) -> None:
    eid = _create_element(client)
    _acquire(client, eid)
    # rewrite the mirror entry as long-expired, then "restart"
    get_lease_mirror().write(
        "default",
        [MirroredLease(eid, "exclusive", "test-user", "tok-old", "edit",
                       _time.time() - 5.0)],
    )
    reset_session()
    assert client.get(papi("/locks")).json()["leases"] == []


def test_restore_failure_degrades_to_cold_start(client: TestClient) -> None:
    class ExplodingLoad:
        def write(self, project_id, leases):  # noqa: ANN001
            return None

        def load(self, project_id):  # noqa: ANN001
            raise RuntimeError("redis is on fire")

    eid = _create_element(client)
    _acquire(client, eid)
    set_lease_mirror(ExplodingLoad())
    reset_session()
    # hydration succeeds; table is simply empty (today's cold start)
    assert client.get(papi("/locks")).json()["leases"] == []
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v -k "restart or not_restored or degrades_to_cold"`
Expected: `test_leases_survive_restart` FAILS (renew answers `ok: false` — nothing restores leases yet). The other two may pass vacuously; they pin the degradation contract.

- [ ] **Step 3: Compose the restore into the persistent loader**

In `src/data_rover/api/session.py`, `install_persistent_registry` (~line 435) currently does `_registry.set_loader(hydrate_session)`. Replace the function body's loader wiring:

```python
def install_persistent_registry() -> None:
    """Wire the process-global registry to durable hydration + snapshot-evict.

    Called at app startup (and by the API test conftest). Kept here — not at
    import time — so importing ``session`` never pulls in the storage/DB stack
    (``hydration`` imports both); unit tests that want the empty-Session
    fallback simply don't call this."""
    from .hydration import hydrate_session, write_snapshot
    from .lock_mirror import restore_leases

    def _load(project_id: str) -> Session:
        sess = hydrate_session(project_id)
        # Phase 7 (scoped): re-install still-live mirrored leases so tokens
        # survive a restart. Best-effort — a mirror failure is a cold start.
        restore_leases(project_id, sess.lock_table)
        return sess

    def _evict(project_id: str, sess: Session) -> None:
        if sess.model is not None:
            write_snapshot(project_id, sess, sess.model_rev)

    _registry.set_loader(_load)
    _registry.set_evict_hook(_evict)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v`
Expected: all pass.
Run: `pixi run -e core-dev pytest tests/api -q`
Expected: no regressions.

- [ ] **Step 5: Lint/typecheck and commit**

```bash
pixi run dr-tidy
git add src/data_rover/api/session.py tests/api/test_lock_mirror.py
git commit -m "feat(api): restore mirrored leases at session hydration - tokens survive restart"
```

---

### Task 4: `RedisLeaseMirror` + dependency + integration test

**Files:**
- Create: `src/data_rover/api/lock_mirror_redis.py`
- Modify: `pixi.toml` (`[feature.api.dependencies]`, ~line 21)
- Create: `tests/api/test_lock_mirror_redis.py`
- Test: `tests/api/test_lock_mirror.py` (one hermetic degradation test)

**Interfaces:**
- Consumes (Task 1): `MirroredLease`, `ENVELOPE_VERSION`, `KEY_TTL_SLACK_S`, `lease_key`; `build_mirror_from_settings`'s redis branch (already written) imports `RedisLeaseMirror` from this module.
- Produces: `RedisLeaseMirror(url: str, *, cooldown_s: float = 30.0, socket_timeout_s: float = 1.0)` satisfying `LeaseMirror`.

- [ ] **Step 1: Add the dependency**

In `pixi.toml` under `[feature.api.dependencies]` (after `argon2-cffi = "23.*"`):

```toml
redis-py = ">=5,<7"
```

Then solve the lockfile:

```bash
pixi install -e core-dev
pixi run -e core-dev python -c "import redis; print(redis.__version__)"
```

Expected: a version prints. (If the conda-forge name resolution fails, the package is `redis-py` on conda-forge — the import name is `redis`.)

- [ ] **Step 2: Write the failing tests**

Create `tests/api/test_lock_mirror_redis.py`:

```python
"""RedisLeaseMirror against a real Redis (integration-marked; needs the
compose service: `pixi run services-start`). Deselected by default via
pytest.ini's `-m "not integration"`, run explicitly with `-m integration`.
Mirrors the fake-gcs pattern in test_storage_gcs.py."""

from __future__ import annotations

import time
import uuid

import pytest

from data_rover.api.lock_mirror import MirroredLease, lease_key
from data_rover.api.lock_mirror_redis import RedisLeaseMirror

pytestmark = pytest.mark.integration

_URL = "redis://localhost:6379/0"


@pytest.fixture
def raw_redis():
    redis = pytest.importorskip("redis")
    client = redis.Redis.from_url(_URL, socket_connect_timeout=1)
    try:
        client.ping()
    except Exception:
        pytest.skip("redis not reachable on localhost:6379")
    return client


def test_write_load_roundtrip_ttl_and_delete(raw_redis) -> None:
    mirror = RedisLeaseMirror(_URL)
    pid = f"it-{uuid.uuid4().hex[:8]}"
    lease = MirroredLease(
        resource_id="e1", mode="exclusive", holder="u1", token="tok1",
        intent="edit", expires_at_epoch=time.time() + 120.0,
        holder_email="u1@example.com",
    )
    try:
        mirror.write(pid, [lease])
        assert mirror.load(pid) == [lease]
        # key TTL: bounded by remaining lease lifetime + slack (60s)
        ttl = raw_redis.ttl(lease_key(pid))
        assert 0 < ttl <= 120 + 61
        mirror.write(pid, [])  # empty set deletes the key
        assert raw_redis.get(lease_key(pid)) is None
        assert mirror.load(pid) == []
    finally:
        raw_redis.delete(lease_key(pid))


def test_load_tolerates_unknown_envelope_version(raw_redis) -> None:
    mirror = RedisLeaseMirror(_URL)
    pid = f"it-{uuid.uuid4().hex[:8]}"
    try:
        raw_redis.set(lease_key(pid), '{"v": 999, "leases": []}')
        assert mirror.load(pid) == []
    finally:
        raw_redis.delete(lease_key(pid))
```

Append to `tests/api/test_lock_mirror.py` (hermetic — connection refused is instant, no service needed):

```python
def test_unreachable_redis_degrades_without_raising() -> None:
    from data_rover.api.lock_mirror_redis import RedisLeaseMirror

    # port 1 refuses instantly; cooldown makes the second call a pure no-op
    mirror = RedisLeaseMirror("redis://127.0.0.1:1/0", socket_timeout_s=0.2)
    lease = MirroredLease("e1", "exclusive", "u", "t", "edit", _time.time() + 60)
    mirror.write("p1", [lease])   # must not raise
    assert mirror.load("p1") == []  # must not raise
    mirror.write("p1", [lease])   # inside cooldown: skipped, still no raise
```

- [ ] **Step 3: Run the hermetic test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v -k unreachable`
Expected: FAIL — `ModuleNotFoundError: No module named 'data_rover.api.lock_mirror_redis'`

- [ ] **Step 4: Write `src/data_rover/api/lock_mirror_redis.py`**

```python
"""Redis ``LeaseMirror`` — isolates the ``redis`` import the way
``storage_gcs.py`` isolates ``google-cloud-storage``.

Degrade-graceful by construction (spec posture: optional mirror): short
socket timeouts so a down Redis costs at most ~1s once, then a cooldown so it
costs nothing for the next ~30s; up→down and down→up transitions each log
exactly once, never per call. Errors are swallowed HERE as well as in the
``mirror_session_leases`` catch-all — two layers on purpose, so neither a
route nor hydration can ever fail because of the mirror.

Data model: one key per project (``dr:leases:{project_id}``) holding a JSON
envelope ``{"v": 1, "leases": [...]}`` written wholesale, with a key TTL of
(latest lease expiry - now) + 60s slack so an orphaned mirror self-cleans; an
empty set is a DEL. Leases are TTL-bounded (<= lock_ttl_seconds), so Redis
persistence is deliberately not required — a Redis restart is
indistinguishable from ordinary lease expiry."""

from __future__ import annotations

import json
import logging
import math
import time
from dataclasses import asdict

from .lock_mirror import ENVELOPE_VERSION, KEY_TTL_SLACK_S, MirroredLease, lease_key

logger = logging.getLogger(__name__)


class RedisLeaseMirror:
    def __init__(
        self,
        url: str,
        *,
        cooldown_s: float = 30.0,
        socket_timeout_s: float = 1.0,
    ) -> None:
        import redis

        self._errors: tuple[type[Exception], ...] = (redis.RedisError, OSError)
        self._client = redis.Redis.from_url(
            url,
            socket_timeout=socket_timeout_s,
            socket_connect_timeout=socket_timeout_s,
            decode_responses=True,
        )
        self._cooldown_s = cooldown_s
        self._down_until = 0.0  # monotonic; 0 == not in cooldown
        self._down = False

    # ---- degradation bookkeeping -----------------------------------------

    def _in_cooldown(self) -> bool:
        return time.monotonic() < self._down_until

    def _mark_down(self, exc: Exception) -> None:
        self._down_until = time.monotonic() + self._cooldown_s
        if not self._down:
            self._down = True
            logger.warning("lease mirror: Redis unavailable, degrading: %s", exc)

    def _mark_up(self) -> None:
        if self._down:
            self._down = False
            logger.info("lease mirror: Redis recovered")

    # ---- LeaseMirror ------------------------------------------------------

    def write(self, project_id: str, leases: list[MirroredLease]) -> None:
        if self._in_cooldown():
            return
        key = lease_key(project_id)
        try:
            if not leases:
                self._client.delete(key)
            else:
                ttl = (
                    max(le.expires_at_epoch for le in leases)
                    - time.time()
                    + KEY_TTL_SLACK_S
                )
                if ttl <= 0:
                    self._client.delete(key)
                else:
                    payload = json.dumps(
                        {
                            "v": ENVELOPE_VERSION,
                            "leases": [asdict(le) for le in leases],
                        }
                    )
                    self._client.set(key, payload, ex=math.ceil(ttl))
            self._mark_up()
        except self._errors as exc:
            self._mark_down(exc)

    def load(self, project_id: str) -> list[MirroredLease]:
        if self._in_cooldown():
            return []
        try:
            raw = self._client.get(lease_key(project_id))
            self._mark_up()
        except self._errors as exc:
            self._mark_down(exc)
            return []
        if raw is None:
            return []
        try:
            doc = json.loads(raw)
            if doc.get("v") != ENVELOPE_VERSION:
                logger.warning(
                    "lease mirror: unknown envelope version %r for project %s",
                    doc.get("v"),
                    project_id,
                )
                return []
            return [MirroredLease(**entry) for entry in doc["leases"]]
        except (ValueError, TypeError, KeyError) as exc:
            logger.warning(
                "lease mirror: undecodable payload for project %s: %s",
                project_id,
                exc,
            )
            return []
```

- [ ] **Step 5: Run the hermetic test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v`
Expected: all pass (including `test_unreachable_redis_degrades_without_raising`).

- [ ] **Step 6: Run the integration test (requires the Redis service — added to compose in Task 5; if compose is not yet updated, run Redis ad hoc or defer this step to Task 5's verification)**

```bash
docker run --rm -d -p 6379:6379 --name tmp-redis redis:7   # if no local redis yet
pixi run -e core-dev pytest tests/api/test_lock_mirror_redis.py -m integration -v
docker stop tmp-redis
```

Expected: 2 passed (or SKIPPED with a clear reason if Redis is unavailable — that is the designed behavior; do not mark this task done without one green run).

- [ ] **Step 7: Lint/typecheck and commit**

```bash
pixi run dr-tidy
git add src/data_rover/api/lock_mirror_redis.py pixi.toml pixi.lock \
        tests/api/test_lock_mirror.py tests/api/test_lock_mirror_redis.py
git commit -m "feat(api): RedisLeaseMirror - timeouts, cooldown, TTL'd whole-set JSON"
```

---

### Task 5: Compose service + docs (+ separate stale-docs correction commit)

**Files:**
- Modify: `docker-compose.yml`
- Modify: `QUICKSTART.md` (services mention)
- Modify: `CLAUDE.md` (locking bullet; then, in a SECOND commit, the two stale frontend-migration claims)

**Interfaces:** none (infra + docs).

- [ ] **Step 1: Add the Redis service to `docker-compose.yml`**

After the `fake-gcs` service, add:

```yaml
  # Coordination plane (Phase 7, scoped): the backend mirrors resource leases
  # here (DATA_ROVER_REDIS_URL=redis://localhost:6379/0) so they survive a
  # backend restart. Deliberately volume-less: every lease is TTL-bounded
  # (<= lock_ttl_seconds), so a Redis restart is indistinguishable from
  # ordinary lease expiry and persistence would buy nothing.
  redis:
    image: redis:7
    container_name: data-rover-redis
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 3s
      retries: 30
```

Also extend the file's header comment sentence "Postgres (tenancy + content + commit journal, schema owned by Alembic) and a GCS-protocol blob store (fake-gcs-server) for model snapshots" to mention Redis as the (optional) lease-mirror coordination plane.

Verify: `docker compose -f docker-compose.yml config -q` (exit 0).

- [ ] **Step 2: QUICKSTART + CLAUDE.md mirror documentation**

- `QUICKSTART.md`: where the compose services are introduced, add one sentence: Redis backs the optional lease mirror; set `DATA_ROVER_REDIS_URL=redis://localhost:6379/0` to enable it — the backend runs fine without it (locks are then in-process only).
- `CLAUDE.md`, the `locking.py` bullet in the Phase 4 section: append —

```
Leases are best-effort write-through mirrored to Redis (`lock_mirror.py` seam: Redis/Memory/Null impls, `DATA_ROVER_REDIS_URL`, empty ⇒ disabled; `lock_mirror_redis.py` isolates the client with 1s timeouts + 30s cooldown) and restored at session hydration with their ORIGINAL tokens, so a client's heartbeat keeps working across a backend restart. The mirror never participates in a conflict decision; a mirror failure degrades (warn), never fails a lock route.
```

- [ ] **Step 3: Commit the feature docs**

```bash
pixi run dr-tidy
git add docker-compose.yml QUICKSTART.md CLAUDE.md
git commit -m "feat(infra)+docs: redis compose service; document the lease mirror"
```

- [ ] **Step 4: Separate commit — fix the stale frontend-migration claims in CLAUDE.md**

Two corrections (verified this session: `checkout.svelte.ts` + staged buffers commit through `POST /commits`; `applyOps`/`undoOps` in `frontend/src/lib/api/model-ops.ts` have zero non-test callers):

1. The sentence `The frontend mirrors all of this client-side (optimistic ops, serialized flushes, conflict recovery).` → `The frontend now edits through the check-out/commit flow (staged-edit buffers committed via POST /commits — see frontend/README.md "State model"); the op shapes below are shared by both paths.`
2. In the Phase 4 section, the bullet ``- **`/model/ops` + `/model/undo`** remain the **legacy unlocked** path until the frontend migrates to the check-out/commit flow (separate follow-up plan, pairs with Phase 5 realtime).`` → ``- **`/model/ops` + `/model/undo`** remain mounted as the **legacy unlocked** path, but the frontend has fully migrated to the check-out/commit flow and no longer calls them (its `applyOps`/`undoOps` wrappers are test-only dead code); they persist for tests/scripts pending a retirement phase.``

```bash
git add CLAUDE.md
git commit -m "docs: the frontend is fully on the check-out/commit flow; /model/ops is legacy-only"
```

---

### Task 6: Full verification

**Files:** none.

- [ ] **Step 1: Full quality gate**

```bash
pixi run dr-tidy          # ruff + mypy + pyright, all three must pass
pixi run core-test        # full backend suite (expect ~1728+ passed)
pixi run frontend-test    # untouched by this plan; must stay at 1863 passed
```

- [ ] **Step 2: Integration re-run against the compose service**

```bash
pixi run services-start
pixi run -e core-dev pytest tests/api/test_lock_mirror_redis.py -m integration -v
```

Expected: 2 passed (compose now provides Redis on 6379).

- [ ] **Step 3: Manual smoke (optional but recommended)**

Boot the backend with `DATA_ROVER_REDIS_URL=redis://localhost:6379/0`, open a project, take a lock (edit an element), then `redis-cli GET "dr:leases:<project-id>"` shows the lease JSON; restart the backend; the frontend's existing heartbeat keeps the lease alive (no re-login, no lost checkout).

- [ ] **Step 4: Hand off to branch finishing**

Implementation complete. Use superpowers:finishing-a-development-branch (merge `--no-ff` into local `main`, delete the branch, never push).

---

## Self-review notes

- **Spec coverage:** seam + impls (Task 1), five call sites (Task 2 — acquire/release/renew/commit/sweeper), restore + token continuity + conflict fidelity (Task 3), Redis impl with timeouts/cooldown/TTL/envelope-version (Task 4), settings (Task 1), compose/dep/docs + stale-docs correction (Task 5), hermetic + integration tests (Tasks 1–4). `LockTable` gains only the mirror-unaware `seed` (spec deviation noted inline: folded into Task 1 for lint-clean commits).
- **Type consistency:** `mirror_session_leases(project_id: str, session: Session)`, `restore_leases(project_id: str, table: LockTable)`, `MirroredLease` field order used identically in Tasks 1–4.
- **`_time` alias** in tests: Task 3's step imports `time as _time`; Task 4's hermetic test uses `_time.time()` — consistent within the single test file.
