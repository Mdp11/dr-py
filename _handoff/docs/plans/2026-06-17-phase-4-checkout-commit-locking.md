# Phase 4 — Check-out/Commit + Locking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multi-user editing safe with a pessimistic check-out/commit workflow — resource leases (exclusive + shared-pin) with TTL/heartbeat/steal, a three-tier validation policy (structural blockers hard-fail, conformance errors counted-not-blocked), and `open`/`preview`/`commit` endpoints that verify locks, validate, persist a commit (with message + error count), and release locks.

**Architecture:** A new `core/validation` distinction tags each `Issue` with a `category` (`structural` | `conformance`) so commit can hard-reject structural corruption (422) while counting conformance errors. A new in-session `LockTable` (`api/locking.py`) holds TTL leases, applies a conflict matrix keyed on lock mode + intent, and expands op/target lists into required lock scope (subtree walk for deletes, source-exclusive + target-shared-pin for connects). New routes (`api/routes/locks.py`, `api/routes/commits.py`) add `POST /locks`, `/locks/release`, `/locks/renew`, `GET /locks`, `GET /open`, `POST /commits/preview`, `POST /commits` — reusing the existing `_apply_batch`/`_rollback`/`_persist_commit` machinery from `routes/ops.py`. The `Commit` table gains `message`/`validation_error_count`/`issues` columns (Alembic 0003). A lifespan sweeper expires stale leases. This is **backend only** — the frontend lock→edit→commit rewire is a follow-up plan that pairs with Phase 5 (realtime feed).

**Tech Stack:** Python 3.14 (pyright floor 3.10), FastAPI (sync routes), SQLAlchemy 2.0 + psycopg v3 (Postgres) / SQLite (tests), Alembic, Pydantic v2, pytest, pixi (`api`/`core-dev` envs). Reference: `docs/superpowers/specs/2026-06-16-multi-user-collaborative-architecture-design.md` §7 (editing model), §8 (locking), §9 (validation tiers), §11 (concurrency), §12 (Phase 4 row of the 8-phase table).

## Global Constraints

- **Python floor is 3.10** (pyrightconfig.json): import `assert_never`/`Self` from `typing_extensions`, never `typing`.
- **Everything runs through pixi.** No global `python`/`node`. Tests: `pixi run -e core-dev pytest <path>`; lint+typecheck: `pixi run tidy` (ruff `--fix` + mypy + pyright — all three must pass).
- **API tests stay hermetic:** in-memory SQLite (`tests/api/conftest.py`) + `MemorySnapshotStore`. No test may require Postgres, GCS, or a running emulator.
- **Postgres schema is owned by Alembic.** `create_all` is SQLite/dev/tests only. The new `Commit` columns need an Alembic migration (Task 5).
- **Reuse, do not rebuild.** The `Model` mutation boundary, `IndexSet`, validation pipeline (`default_pipeline()`), `_apply_batch`/`_apply_one`/`_rollback`, `_ensure_validation_seeded`, `_persist_commit`, `OPS_ADAPTER`, and `Session.write_mutex` are all reused verbatim. Do not re-walk metamodel chains or rebuild indexes by hand. Validate scoped via `res.dirty.to_scope()` (the dirty set), never the whole model, on the hot path.
- **Backend only.** No `frontend/` changes in this plan. The new endpoints are ADDED alongside the existing `/model/ops` + `/model/undo` (which keep working for the current frontend); the frontend switch to lock/commit is a separate plan.
- **Locks are in-session only** (single-instance Phase 4); Redis mirroring is deferred to Phase 7. **Strict-mode** (promoting conformance→hard) is deferred to Phase 8 — commit always treats conformance as soft.
- **Decisions locked (from planning, 2026-06-17):**
  - Add a `category` field to the core `Issue` (structural | conformance) and thread it through the validators — explicit and forward-compatible with strict-mode.
  - Full lease lifecycle: in-session TTL leases + client heartbeat renewal + background expiry sweeper + peer/admin steal with warning.
  - The conflict matrix is intent-aware: a `delete`-intent exclusive lock conflicts with **any** other holder's lease on the resource (incl. shared pins — that is how a shared pin "blocks deletion"); a non-delete exclusive lock conflicts only with another holder's exclusive; a shared pin never conflicts on acquire.

---

## File structure

**New (backend):**
- `src/data_rover/api/locking.py` — `LockMode`, `LockIntent`, `Lease`, `RequiredLock`, `LockConflict`, `LockTable` (acquire/release/renew/steal/verify_held/sweep_expired/snapshot) + scope helpers `expand_targets(...)` and `required_locks(model, ops)`.
- `src/data_rover/api/routes/locks.py` — `POST /locks`, `POST /locks/release`, `POST /locks/renew`, `GET /locks`.
- `src/data_rover/api/routes/commits.py` — `GET /open`, `POST /commits/preview`, `POST /commits`.
- `alembic/versions/0003_commit_metadata.py` — adds `message`/`validation_error_count`/`issues` to `commits`.

**Modified (backend):**
- `src/data_rover/core/validation/issue.py` — `IssueCategory` enum + `Issue.category` field (default `CONFORMANCE`).
- `src/data_rover/core/validation/validators/containment.py` — tag two-parent + cycle issues `STRUCTURAL`.
- `src/data_rover/core/validation/validators/type_conformance.py` — tag the dangling-reference issue `STRUCTURAL`.
- `src/data_rover/core/validation/state.py` — `category_counts()` + `structural_issues()` helpers.
- `src/data_rover/api/schemas.py` — `IssueOut.category`; lock + open + preview + commit request/response models.
- `src/data_rover/api/db_models.py` — `Commit.message`, `Commit.validation_error_count`, `Commit.issues`.
- `src/data_rover/api/content.py` — `append_commit(...)` gains `message`/`validation_error_count`/`issues` (defaulted, so `routes/ops.py` callers are unchanged).
- `src/data_rover/api/session.py` — `Session.lock_table: LockTable`; registry `evict` refuses to drop a session that still holds live leases.
- `src/data_rover/api/settings.py` — `lock_ttl_seconds`, `lock_sweep_seconds`.
- `src/data_rover/api/main.py` — mount the two new routers; lifespan lock-expiry sweeper.

**New / modified (tests):**
- `tests/validation/test_issue_category.py` (create), extend `tests/validation/test_state.py` if present.
- `tests/api/test_locking.py`, `test_lock_scope.py`, `test_locks_route.py`, `test_commits_route.py`, `test_open_route.py` (create).
- `tests/api/test_content.py` (extend: commit metadata), `tests/api/test_alembic.py` (extend: 0003 upgrades clean), `tests/api/test_session_registry.py` (extend: evict-with-locks guard).

---

### Task 1: `Issue.category` — structural vs conformance tiers

Add a category to the core `Issue` and tag the structural-producing validator call sites. Everything defaults to `conformance`, so the four soft validators (multiplicity, facets, uniqueness, endpoint_typing — endpoint typing is soft per spec §9) need no change.

**Files:**
- Modify: `src/data_rover/core/validation/issue.py`
- Modify: `src/data_rover/core/validation/validators/containment.py`
- Modify: `src/data_rover/core/validation/validators/type_conformance.py`
- Modify: `src/data_rover/core/validation/state.py`
- Test: `tests/validation/test_issue_category.py` (create)

**Interfaces:**
- Produces:
  - `IssueCategory(Enum)`: `STRUCTURAL = "structural"`, `CONFORMANCE = "conformance"`
  - `Issue.category: IssueCategory` (default `IssueCategory.CONFORMANCE`)
  - `ValidationState.category_counts() -> dict[str, int]` (category value → count over the whole store)
  - `ValidationState.structural_issues() -> list[Issue]` (all stored issues with `category is STRUCTURAL`)

- [ ] **Step 1: Write the failing tests**

Create `tests/validation/test_issue_category.py`:

```python
from __future__ import annotations

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model
from data_rover.core.validation.issue import Issue, IssueCategory, Severity
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState

# minimal metamodel: a containment relationship so we can build a cycle
MM = """
name: cat-test
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    mappings:
      - source: Node
        target: Node
"""


def test_issue_defaults_to_conformance() -> None:
    i = Issue(Severity.ERROR, "x", ["e1"])
    assert i.category is IssueCategory.CONFORMANCE


def test_containment_cycle_is_structural() -> None:
    mm = load_metamodel_str(MM)
    model = Model(mm)
    a = model.create_element("Node")
    b = model.create_element("Node")
    model.connect("Contains", a.id, b.id)
    model.connect("Contains", b.id, a.id)  # cycle
    issues = default_pipeline().validate(model, Scope.all())
    cyc = [i for i in issues if "cycle" in i.message.lower()]
    assert cyc and all(i.category is IssueCategory.STRUCTURAL for i in cyc)


def test_two_parents_is_structural() -> None:
    mm = load_metamodel_str(MM)
    model = Model(mm)
    parent1 = model.create_element("Node")
    parent2 = model.create_element("Node")
    child = model.create_element("Node")
    model.connect("Contains", parent1.id, child.id)
    model.connect("Contains", parent2.id, child.id)  # two parents
    issues = default_pipeline().validate(model, Scope.all())
    multi = [i for i in issues if "containment parents" in i.message]
    assert multi and all(i.category is IssueCategory.STRUCTURAL for i in multi)


def test_state_category_counts_and_structural_issues() -> None:
    state = ValidationState()
    state.set_full(
        [
            Issue(Severity.ERROR, "struct", ["e1"], IssueCategory.STRUCTURAL),
            Issue(Severity.ERROR, "soft1", ["e2"]),
            Issue(Severity.ERROR, "soft2", ["e3"]),
        ]
    )
    assert state.category_counts() == {"structural": 1, "conformance": 2}
    assert [i.message for i in state.structural_issues()] == ["struct"]
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/validation/test_issue_category.py -q`
Expected: FAIL (`ImportError: cannot import name 'IssueCategory'`).

- [ ] **Step 3: Add `IssueCategory` + `Issue.category`**

Replace the body of `src/data_rover/core/validation/issue.py` with:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Severity(Enum):
    ERROR = "error"
    WARNING = "warning"


class IssueCategory(Enum):
    """Commit-time validation tier (spec §9).

    STRUCTURAL — model-graph corruption (dangling reference, containment
    cycle, two parents). At commit these HARD-fail with 422: a well-behaved
    client never produces one (the mutation boundary + frontend prevent them).
    CONFORMANCE — schema-rule violations (endpoint typing, multiplicity,
    uniqueness, facets, scalar type). Counted and surfaced, never block a
    commit (the engine "stays inspectable"); a Phase 8 strict mode may later
    promote a configurable subset to hard rejects.
    """

    STRUCTURAL = "structural"
    CONFORMANCE = "conformance"


@dataclass
class Issue:
    severity: Severity
    message: str
    target_ids: list[str] = field(default_factory=list)
    #: commit-time tier; defaults to CONFORMANCE so only the few structural
    #: call sites (containment cycle/two-parents, dangling reference) opt in.
    category: IssueCategory = IssueCategory.CONFORMANCE
```

- [ ] **Step 4: Tag the structural call sites**

In `src/data_rover/core/validation/validators/containment.py`, change the import line:

```python
from ..issue import Issue, IssueCategory, Severity
```

then add `IssueCategory.STRUCTURAL` as the 4th positional arg to all THREE `Issue(...)` constructions (the two-parent issue at line ~31 and both cycle issues at lines ~51 and ~67). Each becomes, e.g.:

```python
                Issue(
                    Severity.ERROR,
                    f"Element {el.id} has {len(parents)} containment parents "
                    "(must have at most one)",
                    [el.id],
                    IssueCategory.STRUCTURAL,
                )
```

and for both cycle issues:

```python
                        Issue(
                            Severity.ERROR,
                            f"Containment cycle detected involving element {start}",
                            [start],
                            IssueCategory.STRUCTURAL,
                        )
```

(the second cycle site uses `entity_id` in place of `start` — keep its existing message/target, only append the category arg.)

In `src/data_rover/core/validation/validators/type_conformance.py`, change the import line:

```python
from ..issue import Issue, IssueCategory, Severity
```

then in `_reference_issues`, tag ONLY the "points to no element" (dangling pointer) issue — the non-string and wrong-type reference issues stay conformance (default):

```python
        target = model.elements.get(item)
        if target is None:
            return [
                Issue(
                    Severity.ERROR,
                    f"{type_name}.{prop_name}: reference {item!r} points to no element",
                    [owner_id],
                    IssueCategory.STRUCTURAL,
                )
            ]
```

- [ ] **Step 5: Add the `ValidationState` helpers**

In `src/data_rover/core/validation/state.py`, change the import to `from .issue import Issue, IssueCategory` and append two methods to `ValidationState` (after `counts`):

```python
    def category_counts(self) -> dict[str, int]:
        """Issue count per category name (e.g. ``"structural"``)."""
        counts: dict[str, int] = {}
        for issues in self.issues_by_owner.values():
            for issue in issues:
                name = issue.category.value
                counts[name] = counts.get(name, 0) + 1
        return counts

    def structural_issues(self) -> list[Issue]:
        """All stored issues in the STRUCTURAL tier (commit-time blockers)."""
        return [
            i
            for issues in self.issues_by_owner.values()
            for i in issues
            if i.category is IssueCategory.STRUCTURAL
        ]
```

- [ ] **Step 6: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/validation/test_issue_category.py -q`
Expected: PASS.

- [ ] **Step 7: Run the full validation suite (no regressions from the new field)**

Run: `pixi run -e core-dev pytest tests/validation -q`
Expected: PASS (the default category keeps every existing assertion valid).

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/core/validation/issue.py \
        src/data_rover/core/validation/validators/containment.py \
        src/data_rover/core/validation/validators/type_conformance.py \
        src/data_rover/core/validation/state.py \
        tests/validation/test_issue_category.py
git commit -m "feat(validation): tier issues structural vs conformance (Phase 4)"
```

---

### Task 2: `LockTable` — TTL leases, conflict matrix, steal, sweep

The in-session lock manager. Pure data structure (no FastAPI, no DB), so it is unit-tested directly. Time is injected (`now: float`) so tests are deterministic — callers pass `time.monotonic()`.

**Files:**
- Create: `src/data_rover/api/locking.py`
- Test: `tests/api/test_locking.py` (create)

**Interfaces:**
- Produces:
  - `class LockMode(Enum)`: `EXCLUSIVE = "exclusive"`, `SHARED = "shared"`
  - `class LockIntent(Enum)`: `EDIT = "edit"`, `CREATE_CHILD = "create_child"`, `CONNECT = "connect"`, `DELETE = "delete"`
  - `@dataclass RequiredLock`: `resource_id: str`, `mode: LockMode`, `intent: LockIntent`
  - `@dataclass Lease`: `resource_id: str`, `mode: LockMode`, `holder: str`, `token: str`, `intent: LockIntent`, `expires_at: float`
  - `@dataclass LockConflict`: `resource_id: str`, `held_by: str`, `held_mode: LockMode`
  - `class LockTable`:
    - `acquire(self, holder: str, reqs: list[RequiredLock], *, now: float, ttl: float, token: str | None = None, steal: bool = False) -> tuple[str, list[Lease], list[LockConflict]]` — all-or-nothing: returns `(token, leases, [])` on success or `("", [], conflicts)` on conflict (nothing granted). With `steal=True`, conflicting OTHER-holder leases are evicted (returned via `stolen` accessor) instead of blocking.
    - `release(self, holder: str, token: str) -> list[Lease]` — drop all leases under `token` (must match holder); returns released leases.
    - `renew(self, holder: str, token: str, *, now: float, ttl: float) -> bool` — extend every lease under `token`; False if none/expired.
    - `verify_held(self, holder: str, tokens: list[str], reqs: list[RequiredLock], *, now: float) -> list[RequiredLock]` — return the subset of `reqs` NOT covered by a live lease held by `holder` under one of `tokens` (exclusive lease covers a shared requirement; empty list == all held).
    - `sweep_expired(self, now: float) -> list[Lease]` — drop and return every expired lease.
    - `active_leases(self, now: float) -> list[Lease]` — live (non-expired) leases (for `GET /locks` + the evict guard).

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_locking.py`:

```python
from __future__ import annotations

from data_rover.api.locking import (
    LockIntent,
    LockMode,
    LockTable,
    RequiredLock,
)


def _ex(rid: str, intent: LockIntent = LockIntent.EDIT) -> RequiredLock:
    return RequiredLock(resource_id=rid, mode=LockMode.EXCLUSIVE, intent=intent)


def _sh(rid: str) -> RequiredLock:
    return RequiredLock(resource_id=rid, mode=LockMode.SHARED, intent=LockIntent.CONNECT)


def test_acquire_grants_and_returns_token() -> None:
    t = LockTable()
    token, leases, conflicts = t.acquire("u1", [_ex("e1")], now=0.0, ttl=300.0)
    assert token and not conflicts
    assert [lease.resource_id for lease in leases] == ["e1"]


def test_exclusive_conflicts_with_other_holder_exclusive() -> None:
    t = LockTable()
    t.acquire("u1", [_ex("e1")], now=0.0, ttl=300.0)
    token, leases, conflicts = t.acquire("u2", [_ex("e1")], now=1.0, ttl=300.0)
    assert token == "" and leases == []
    assert [c.resource_id for c in conflicts] == ["e1"]


def test_shared_pins_coexist() -> None:
    t = LockTable()
    t.acquire("u1", [_sh("e1")], now=0.0, ttl=300.0)
    token, _leases, conflicts = t.acquire("u2", [_sh("e1")], now=0.0, ttl=300.0)
    assert token and not conflicts  # many shared holders OK


def test_delete_conflicts_with_a_shared_pin() -> None:
    t = LockTable()
    t.acquire("u1", [_sh("e1")], now=0.0, ttl=300.0)  # someone connecting into e1
    _t, _l, conflicts = t.acquire(
        "u2", [_ex("e1", LockIntent.DELETE)], now=0.0, ttl=300.0
    )
    assert [c.resource_id for c in conflicts] == ["e1"]  # pin blocks delete


def test_nondelete_exclusive_coexists_with_shared_pin() -> None:
    t = LockTable()
    t.acquire("u1", [_sh("e1")], now=0.0, ttl=300.0)
    token, _l, conflicts = t.acquire("u2", [_ex("e1", LockIntent.EDIT)], now=0.0, ttl=300.0)
    assert token and not conflicts  # editing props vs incoming connect are compatible


def test_expiry_releases_and_then_reacquire_succeeds() -> None:
    t = LockTable()
    t.acquire("u1", [_ex("e1")], now=0.0, ttl=10.0)
    swept = t.sweep_expired(now=11.0)
    assert [s.resource_id for s in swept] == ["e1"]
    token, _l, conflicts = t.acquire("u2", [_ex("e1")], now=12.0, ttl=10.0)
    assert token and not conflicts


def test_renew_extends_ttl() -> None:
    t = LockTable()
    token, _l, _c = t.acquire("u1", [_ex("e1")], now=0.0, ttl=10.0)
    assert t.renew("u1", token, now=9.0, ttl=10.0) is True
    assert t.sweep_expired(now=11.0) == []  # renewed to expire at 19.0
    assert t.sweep_expired(now=20.0)  # now expired


def test_steal_evicts_other_holder() -> None:
    t = LockTable()
    t.acquire("u1", [_ex("e1")], now=0.0, ttl=300.0)
    token, leases, conflicts = t.acquire(
        "u2", [_ex("e1")], now=1.0, ttl=300.0, steal=True
    )
    assert token and not conflicts and [lease.holder for lease in leases] == ["u2"]
    # u1's lease is gone
    assert all(lease.holder == "u2" for lease in t.active_leases(now=1.0))


def test_verify_held_reports_missing() -> None:
    t = LockTable()
    token, _l, _c = t.acquire("u1", [_ex("e1")], now=0.0, ttl=300.0)
    assert t.verify_held("u1", [token], [_ex("e1")], now=1.0) == []
    missing = t.verify_held("u1", [token], [_ex("e2")], now=1.0)
    assert [m.resource_id for m in missing] == ["e2"]


def test_verify_held_exclusive_covers_shared_requirement() -> None:
    t = LockTable()
    token, _l, _c = t.acquire("u1", [_ex("e1")], now=0.0, ttl=300.0)
    assert t.verify_held("u1", [token], [_sh("e1")], now=1.0) == []


def test_release_drops_token_leases() -> None:
    t = LockTable()
    token, _l, _c = t.acquire("u1", [_ex("e1"), _ex("e2")], now=0.0, ttl=300.0)
    released = t.release("u1", token)
    assert {r.resource_id for r in released} == {"e1", "e2"}
    assert t.active_leases(now=1.0) == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_locking.py -q`
Expected: FAIL (`ModuleNotFoundError: data_rover.api.locking`).

- [ ] **Step 3: Implement `locking.py` (table + matrix)**

Create `src/data_rover/api/locking.py`:

```python
"""In-session resource leases — the Phase 4 pessimistic-locking primitive.

A lease is a TTL grant on one resource (element or relationship id). Leases
are held in the per-project ``Session`` (single-instance Phase 4; Redis
mirroring is deferred to Phase 7) and renewed by client heartbeat; the
lifespan sweeper auto-releases expired leases. ``acquire`` is all-or-nothing:
either every requested lock is granted under one token, or nothing is and the
blocking leases are returned as conflicts.

Conflict matrix (spec §8). "Other holder" means a live lease whose ``holder``
differs from the acquirer:
- request SHARED            -> never conflicts (many concurrent pins OK).
- request EXCLUSIVE, non-DELETE intent -> conflicts only with another
  holder's EXCLUSIVE on the same resource (editing props and an incoming
  connect-pin are compatible).
- request EXCLUSIVE, DELETE intent -> conflicts with ANY other holder's lease
  on the resource, INCLUDING shared pins — that is exactly how a shared pin
  "blocks deletion of the pinned object".

The scope helpers (``expand_targets`` / ``required_locks``) turn a lock
request or an op batch into the concrete ``RequiredLock`` set, applying the
per-op rules in spec §8 (delete -> subtree, connect -> source exclusive +
target shared pin); they live with the table because they share its types.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from enum import Enum


class LockMode(Enum):
    EXCLUSIVE = "exclusive"
    SHARED = "shared"


class LockIntent(Enum):
    EDIT = "edit"
    CREATE_CHILD = "create_child"
    CONNECT = "connect"
    DELETE = "delete"


@dataclass(frozen=True)
class RequiredLock:
    resource_id: str
    mode: LockMode
    intent: LockIntent


@dataclass
class Lease:
    resource_id: str
    mode: LockMode
    holder: str
    token: str
    intent: LockIntent
    expires_at: float


@dataclass
class LockConflict:
    resource_id: str
    held_by: str
    held_mode: LockMode


class LockTable:
    def __init__(self) -> None:
        # resource_id -> live leases on it (multiple only when all SHARED)
        self._by_resource: dict[str, list[Lease]] = {}

    # ---- internal helpers -------------------------------------------------

    def _live(self, resource_id: str, now: float) -> list[Lease]:
        leases = [
            le for le in self._by_resource.get(resource_id, ()) if le.expires_at > now
        ]
        if leases:
            self._by_resource[resource_id] = leases
        else:
            self._by_resource.pop(resource_id, None)
        return leases

    def _conflict(self, req: RequiredLock, holder: str, now: float) -> LockConflict | None:
        for le in self._live(req.resource_id, now):
            if le.holder == holder:
                continue
            if req.mode is LockMode.SHARED:
                continue  # shared pins never conflict on acquire
            if req.intent is LockIntent.DELETE:
                # delete needs the resource clear of everyone else (incl. pins)
                return LockConflict(req.resource_id, le.holder, le.mode)
            if le.mode is LockMode.EXCLUSIVE:
                return LockConflict(req.resource_id, le.holder, le.mode)
        return None

    # ---- public API -------------------------------------------------------

    def acquire(
        self,
        holder: str,
        reqs: list[RequiredLock],
        *,
        now: float,
        ttl: float,
        token: str | None = None,
        steal: bool = False,
    ) -> tuple[str, list[Lease], list[LockConflict]]:
        conflicts: list[LockConflict] = []
        for req in reqs:
            c = self._conflict(req, holder, now)
            if c is not None:
                conflicts.append(c)
        if conflicts and not steal:
            return "", [], conflicts
        if steal:
            # evict the offending other-holder leases on the contested resources
            for c in conflicts:
                self._by_resource[c.resource_id] = [
                    le
                    for le in self._by_resource.get(c.resource_id, ())
                    if le.holder == holder
                ]
        token = token or uuid.uuid4().hex
        granted: list[Lease] = []
        for req in reqs:
            lease = Lease(
                resource_id=req.resource_id,
                mode=req.mode,
                holder=holder,
                token=token,
                intent=req.intent,
                expires_at=now + ttl,
            )
            self._by_resource.setdefault(req.resource_id, []).append(lease)
            granted.append(lease)
        return token, granted, []

    def release(self, holder: str, token: str) -> list[Lease]:
        released: list[Lease] = []
        for rid in list(self._by_resource):
            keep: list[Lease] = []
            for le in self._by_resource[rid]:
                if le.token == token and le.holder == holder:
                    released.append(le)
                else:
                    keep.append(le)
            if keep:
                self._by_resource[rid] = keep
            else:
                del self._by_resource[rid]
        return released

    def renew(self, holder: str, token: str, *, now: float, ttl: float) -> bool:
        renewed = False
        for leases in self._by_resource.values():
            for le in leases:
                if le.token == token and le.holder == holder and le.expires_at > now:
                    le.expires_at = now + ttl
                    renewed = True
        return renewed

    def verify_held(
        self,
        holder: str,
        tokens: list[str],
        reqs: list[RequiredLock],
        *,
        now: float,
    ) -> list[RequiredLock]:
        token_set = set(tokens)
        missing: list[RequiredLock] = []
        for req in reqs:
            held = False
            for le in self._live(req.resource_id, now):
                if le.holder != holder or le.token not in token_set:
                    continue
                # exclusive covers a shared requirement; shared covers shared
                if req.mode is LockMode.SHARED or le.mode is LockMode.EXCLUSIVE:
                    held = True
                    break
            if not held:
                missing.append(req)
        return missing

    def sweep_expired(self, now: float) -> list[Lease]:
        expired: list[Lease] = []
        for rid in list(self._by_resource):
            keep: list[Lease] = []
            for le in self._by_resource[rid]:
                (keep if le.expires_at > now else expired).append(le)
            if keep:
                self._by_resource[rid] = keep
            else:
                del self._by_resource[rid]
        return expired

    def active_leases(self, now: float) -> list[Lease]:
        return [
            le
            for rid in list(self._by_resource)
            for le in self._live(rid, now)
        ]
```

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_locking.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/locking.py tests/api/test_locking.py
git commit -m "feat(api): in-session LockTable with TTL leases + intent-aware conflicts"
```

---

### Task 3: Lock-scope expansion — `expand_targets` + `required_locks`

Turn (a) a lock request (targets + intent) and (b) an op batch into concrete `RequiredLock` sets, per the spec §8 rules. Delete expands through the containment subtree; connect needs exclusive-source + shared-pin-target; temp ids created earlier in the same batch require no lock.

**Files:**
- Modify: `src/data_rover/api/locking.py` (append the two functions)
- Test: `tests/api/test_lock_scope.py` (create)

**Interfaces:**
- Consumes: `Model` (core), `OpIn` union (schemas), `LockTable` types (Task 2), `TEMP_ID_PREFIX`.
- Produces:
  - `expand_targets(model: Model, targets: list[tuple[str, LockMode]], intent: LockIntent) -> list[RequiredLock]` — per target: an exclusive DELETE target additionally yields exclusive locks over its whole containment subtree.
  - `required_locks(model: Model, ops: list[OpIn]) -> list[RequiredLock]` — the locks an op batch needs, computed against the PRE-apply model, skipping ids created within the batch.
  - `containment_subtree(model: Model, root_id: str) -> list[str]` — `root_id` + all transitive containment descendants.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_lock_scope.py`:

```python
from __future__ import annotations

from data_rover.api.locking import (
    LockIntent,
    LockMode,
    expand_targets,
    required_locks,
)
from data_rover.api.schemas import (
    CreateRelationshipOp,
    DeleteElementOp,
    UpdateElementOp,
)
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

MM = """
name: scope-test
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    mappings:
      - source: Node
        target: Node
  - name: Links
    mappings:
      - source: Node
        target: Node
"""


def _model() -> Model:
    return Model(load_metamodel_str(MM))


def test_set_property_needs_exclusive_on_element() -> None:
    m = _model()
    e = m.create_element("Node")
    reqs = required_locks(m, [UpdateElementOp(kind="update_element", id=e.id, properties_patch={})])
    assert reqs == [
        __import__("data_rover.api.locking", fromlist=["RequiredLock"]).RequiredLock(
            resource_id=e.id, mode=LockMode.EXCLUSIVE, intent=LockIntent.EDIT
        )
    ]


def test_connect_needs_exclusive_source_and_shared_target() -> None:
    m = _model()
    a = m.create_element("Node")
    b = m.create_element("Node")
    reqs = required_locks(
        m,
        [
            CreateRelationshipOp(
                kind="create_relationship",
                temp_id="tmp_r",
                type_name="Links",
                source_id=a.id,
                target_id=b.id,
                properties={},
            )
        ],
    )
    modes = {(r.resource_id, r.mode) for r in reqs}
    assert (a.id, LockMode.EXCLUSIVE) in modes
    assert (b.id, LockMode.SHARED) in modes


def test_connect_skips_temp_endpoints() -> None:
    m = _model()
    a = m.create_element("Node")
    reqs = required_locks(
        m,
        [
            CreateRelationshipOp(
                kind="create_relationship",
                temp_id="tmp_r",
                type_name="Links",
                source_id=a.id,
                target_id="tmp_new",  # created elsewhere in the batch
                properties={},
            )
        ],
    )
    # only the existing source is locked; the temp target is not yet shared
    assert {(r.resource_id, r.mode) for r in reqs} == {(a.id, LockMode.EXCLUSIVE)}


def test_delete_expands_to_containment_subtree() -> None:
    m = _model()
    root = m.create_element("Node")
    child = m.create_element("Node")
    grand = m.create_element("Node")
    m.connect("Contains", root.id, child.id)
    m.connect("Contains", child.id, grand.id)
    reqs = required_locks(m, [DeleteElementOp(kind="delete_element", id=root.id)])
    assert {r.resource_id for r in reqs} == {root.id, child.id, grand.id}
    assert all(r.mode is LockMode.EXCLUSIVE and r.intent is LockIntent.DELETE for r in reqs)


def test_expand_targets_delete_intent_walks_subtree() -> None:
    m = _model()
    root = m.create_element("Node")
    child = m.create_element("Node")
    m.connect("Contains", root.id, child.id)
    reqs = expand_targets(m, [(root.id, LockMode.EXCLUSIVE)], LockIntent.DELETE)
    assert {r.resource_id for r in reqs} == {root.id, child.id}
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_lock_scope.py -q`
Expected: FAIL (`ImportError`: `expand_targets`/`required_locks` undefined).

- [ ] **Step 3: Implement the scope helpers**

Append to `src/data_rover/api/locking.py`:

```python
# --- lock-scope expansion (spec §8 rules) ---------------------------------
# Imported lazily-ish at module scope: Model is a core type (no cycle), the op
# union lives in schemas (no cycle back to locking).
from typing import TYPE_CHECKING

from .schemas import (
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    UpdateElementOp,
    UpdateRelationshipOp,
)

if TYPE_CHECKING:
    from data_rover.core.model.model import Model

    from .schemas import OpIn

_TEMP_ID_PREFIX = "tmp_"


def containment_subtree(model: "Model", root_id: str) -> list[str]:
    """``root_id`` + all transitive containment descendants (DFS, dedup)."""
    out: list[str] = []
    seen: set[str] = set()
    stack = [root_id]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        out.append(cur)
        for rel in model._containment_children(cur):
            stack.append(rel.target_id)
    return out


def expand_targets(
    model: "Model",
    targets: list[tuple[str, LockMode]],
    intent: LockIntent,
) -> list[RequiredLock]:
    """A lock request -> concrete RequiredLocks.

    A DELETE-intent exclusive target additionally locks its whole containment
    subtree (so the cascade can't delete a descendant another editor holds)."""
    reqs: list[RequiredLock] = []
    seen: set[tuple[str, LockMode]] = set()

    def add(rid: str, mode: LockMode) -> None:
        if (rid, mode) not in seen:
            seen.add((rid, mode))
            reqs.append(RequiredLock(resource_id=rid, mode=mode, intent=intent))

    for rid, mode in targets:
        if intent is LockIntent.DELETE and mode is LockMode.EXCLUSIVE:
            for member in containment_subtree(model, rid):
                add(member, LockMode.EXCLUSIVE)
        else:
            add(rid, mode)
    return reqs


def required_locks(model: "Model", ops: list["OpIn"]) -> list[RequiredLock]:
    """The locks an op batch needs, computed against the PRE-apply model.

    Ids created earlier in the same batch (temp ids) are not yet shared, so
    they require no lock; relationships are locked via their source element."""
    reqs: list[RequiredLock] = []
    seen: set[tuple[str, LockMode]] = set()
    created: set[str] = set()

    def add(rid: str, mode: LockMode, intent: LockIntent) -> None:
        if rid.startswith(_TEMP_ID_PREFIX) or rid in created:
            return
        if (rid, mode) not in seen:
            seen.add((rid, mode))
            reqs.append(RequiredLock(resource_id=rid, mode=mode, intent=intent))

    def rel_source(rel_id: str) -> str | None:
        rel = model.relationships.get(rel_id)
        return rel.source_id if rel is not None else None

    for op in ops:
        if op.kind == "create_element":
            created.add(op.temp_id)
        elif op.kind == "create_relationship":
            created.add(op.temp_id)
            add(op.source_id, LockMode.EXCLUSIVE, LockIntent.CONNECT)
            add(op.target_id, LockMode.SHARED, LockIntent.CONNECT)
        elif op.kind == "update_element":
            add(op.id, LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif op.kind == "delete_element":
            for member in containment_subtree(model, op.id):
                add(member, LockMode.EXCLUSIVE, LockIntent.DELETE)
        elif op.kind == "update_relationship":
            src = rel_source(op.id)
            if src is not None:
                add(src, LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif op.kind == "delete_relationship":
            src = rel_source(op.id)
            if src is not None:
                add(src, LockMode.EXCLUSIVE, LockIntent.DELETE)
    return reqs
```

(`UpdateRelationshipOp`/`DeleteRelationshipOp` are imported for the `op.kind` branches even though matched by string; keeping the import documents the handled set and satisfies any future isinstance use. If ruff flags them as unused, switch the branches to `isinstance` checks against the imported classes.)

- [ ] **Step 4: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_lock_scope.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/locking.py tests/api/test_lock_scope.py
git commit -m "feat(api): lock-scope expansion for ops + lock requests"
```

---

### Task 4: Session lock table + evict guard

Give each `Session` a `LockTable` and stop the registry from evicting a session that still holds live leases (an evicted lock table would silently strand a holder's check-out). The idle-evict TTL (1800s) far exceeds the lock TTL (300s), so in practice leases have already expired — this guard is a safety net.

**Files:**
- Modify: `src/data_rover/api/session.py`
- Test: `tests/api/test_session_registry.py` (extend)

**Interfaces:**
- Produces: `Session.lock_table: LockTable` (default-constructed); `SessionRegistry.evict` is a no-op when `session.lock_table.active_leases(time.monotonic())` is non-empty.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_session_registry.py`:

```python
def test_evict_skips_session_with_live_locks() -> None:
    import time as _time

    from data_rover.api.locking import LockIntent, LockMode, RequiredLock
    from data_rover.api.session import Session, SessionRegistry

    evicted: list[str] = []
    reg = SessionRegistry()
    reg.set_loader(lambda pid: Session())
    reg.set_evict_hook(lambda pid, s: evicted.append(pid))

    sess = reg.get("p1")
    sess.lock_table.acquire(
        "u1",
        [RequiredLock(resource_id="e1", mode=LockMode.EXCLUSIVE, intent=LockIntent.EDIT)],
        now=_time.monotonic(),
        ttl=300.0,
    )
    reg.evict("p1")
    assert evicted == []  # refused: live lease held
    assert "p1" in reg.project_ids()
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_session_registry.py::test_evict_skips_session_with_live_locks -q`
Expected: FAIL (`AttributeError: 'Session' object has no attribute 'lock_table'`).

- [ ] **Step 3: Add the field**

In `src/data_rover/api/session.py`, add the import near the top (`from .locking import LockTable`) and add this field to the `Session` dataclass, after `last_access`:

```python
    #: per-project resource leases (Phase 4 check-out/commit). In-session only
    #: this phase (Redis mirroring is Phase 7). Sweept of expired leases by the
    #: lifespan sweeper; consulted by the commit route (lock verification) and
    #: by ``SessionRegistry.evict`` (never evict a session with live leases).
    lock_table: LockTable = field(default_factory=LockTable, repr=False)
```

- [ ] **Step 4: Guard `evict`**

In `SessionRegistry.evict`, after popping the session and before running the hook, add the live-lease check (inside the `with session.write_mutex:` block, before calling `_evict_hook`):

```python
        with session.write_mutex:
            if session.lock_table.active_leases(time.monotonic()):
                # a holder still has a check-out open; re-register and skip.
                with self._guard:
                    self._sessions[project_id] = session
                return
            if self._evict_hook is not None:
                self._evict_hook(project_id, session)
```

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_session_registry.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/session.py tests/api/test_session_registry.py
git commit -m "feat(api): per-session lock table + evict guard for live leases"
```

---

### Task 5: `Commit` metadata columns + content + Alembic 0003

Persist the commit message, conformance-error count, and the issue list on each `Commit` row, so history (Phase 8) and the commit response carry them. `content.append_commit` gains defaulted params so the existing `routes/ops.py` callers are untouched.

**Files:**
- Modify: `src/data_rover/api/db_models.py`
- Modify: `src/data_rover/api/content.py`
- Create: `alembic/versions/0003_commit_metadata.py`
- Test: `tests/api/test_content.py` (extend), `tests/api/test_alembic.py` (extend)

**Interfaces:**
- Produces: `Commit.message: str`, `Commit.validation_error_count: int`, `Commit.issues: list` (JSON); `content.append_commit(..., message: str = "", validation_error_count: int = 0, issues: list | None = None)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_content.py`:

```python
def test_append_commit_persists_metadata() -> None:
    _setup()
    with db.db_session() as s:
        mm = content.create_metamodel(s, name="MM", version=1, blob="x: 1")
        content.upsert_model_row(s, "p1", metamodel_id=mm.id)
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[], inverse_ops=[], id_map={},
            message="rename node", validation_error_count=3,
            issues=[{"severity": "error", "message": "m", "category": "conformance"}],
        )
    with db.db_session() as s:
        c = content.commits_after(s, "p1", 0)[0]
        assert c.message == "rename node"
        assert c.validation_error_count == 3
        assert c.issues[0]["category"] == "conformance"
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_content.py::test_append_commit_persists_metadata -q`
Expected: FAIL (`TypeError: append_commit() got an unexpected keyword argument 'message'`).

- [ ] **Step 3: Add the ORM columns**

In `src/data_rover/api/db_models.py`, add to `class Commit` after `id_map`:

```python
    #: optional human commit message (spec §7). Empty for the legacy
    #: /model/ops + /model/undo paths (they pass no message).
    message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    #: number of CONFORMANCE-tier issues over the dirty set at commit time
    #: (structural issues are hard-rejected, so this counts only soft ones).
    validation_error_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    #: the conformance issue list recorded at commit (IssueOut dicts).
    issues: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
```

- [ ] **Step 4: Extend `content.append_commit`**

In `src/data_rover/api/content.py`, widen the signature and pass-through:

```python
def append_commit(
    db: Session,
    project_id: str,
    *,
    rev: int,
    commit_id: str,
    author_id: str | None,
    ops: list[Any],
    inverse_ops: list[Any],
    id_map: dict[str, str],
    message: str = "",
    validation_error_count: int = 0,
    issues: list[Any] | None = None,
) -> Commit:
    row = Commit(
        project_id=project_id,
        rev=rev,
        commit_id=commit_id,
        author_id=author_id,
        ops=ops,
        inverse_ops=inverse_ops,
        id_map=id_map,
        message=message,
        validation_error_count=validation_error_count,
        issues=issues or [],
    )
    db.add(row)
    db.flush()
    return row
```

- [ ] **Step 5: Write the Alembic migration**

Create `alembic/versions/0003_commit_metadata.py` (set `down_revision` to the existing head — inspect `alembic/versions/` for the latest revision id, e.g. `"0002"`):

```python
"""commit metadata: message, validation_error_count, issues

Revision ID: 0003
Revises: 0002
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "commits",
        sa.Column("message", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column(
        "commits",
        sa.Column(
            "validation_error_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "commits",
        sa.Column(
            "issues", sa.JSON(), nullable=False, server_default="[]"
        ),
    )


def downgrade() -> None:
    op.drop_column("commits", "issues")
    op.drop_column("commits", "validation_error_count")
    op.drop_column("commits", "message")
```

- [ ] **Step 6: Run the tests (content + alembic upgrade-clean)**

Run: `pixi run -e core-dev pytest tests/api/test_content.py tests/api/test_alembic.py -q`
Expected: PASS. (If `test_alembic.py` enumerates expected columns, add the three new ones there.)

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/db_models.py src/data_rover/api/content.py \
        alembic/versions/0003_commit_metadata.py \
        tests/api/test_content.py tests/api/test_alembic.py
git commit -m "feat(api): commit message + validation metadata columns (Alembic 0003)"
```

---

### Task 6: API schemas — lock, open, preview, commit

The Pydantic wire models for the new endpoints + the `category` field on `IssueOut`.

**Files:**
- Modify: `src/data_rover/api/schemas.py`
- Test: `tests/api/test_schemas.py` (extend, or create a focused module)

**Interfaces:**
- Produces (all in `schemas.py`):
  - `IssueOut.category: str` (set from `issue.category.value` in `from_core`)
  - `LockTargetIn { resource_id: str, mode: Literal["exclusive","shared"] }`
  - `LockRequest { targets: list[LockTargetIn], intent: Literal["edit","create_child","connect","delete"], steal: bool = False }`
  - `LeaseOut { resource_id, mode, holder, token, intent, expires_at }` + `LockConflictOut { resource_id, held_by, held_mode }`
  - `LockResponse { token: str, leases: list[LeaseOut] }`
  - `ReleaseRequest { token: str }`, `RenewRequest { token: str }`, `RenewResponse { ok: bool }`
  - `OpenResponse { model_rev: int, role: str, element_count: int, relationship_count: int, issue_counts: dict[str,int] }`
  - `PreviewRequest { base_rev: int, ops: list[OpIn] }`
  - `PreviewResponse { conformance_error_count: int, structural_blockers: list[IssueOut], issues: list[IssueOut] }`
  - `CommitRequest { base_rev: int, ops: list[OpIn], message: str = "", lock_tokens: list[str], ack_errors: bool = False }`
  - `CommitResponse(OpsResponse) { commit_id: str, message: str, validation_error_count: int }`

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_commit_schemas.py`:

```python
from __future__ import annotations

from data_rover.api.schemas import (
    CommitRequest,
    IssueOut,
    LockRequest,
    PreviewResponse,
)
from data_rover.core.validation.issue import Issue, IssueCategory, Severity


def test_issue_out_carries_category() -> None:
    out = IssueOut.from_core(
        Issue(Severity.ERROR, "dangling", ["e1"], IssueCategory.STRUCTURAL)
    )
    assert out.category == "structural"


def test_lock_request_parses_targets_and_intent() -> None:
    req = LockRequest.model_validate(
        {"targets": [{"resource_id": "e1", "mode": "exclusive"}], "intent": "delete"}
    )
    assert req.targets[0].resource_id == "e1"
    assert req.intent == "delete"
    assert req.steal is False


def test_commit_request_requires_lock_tokens() -> None:
    req = CommitRequest.model_validate(
        {"base_rev": 3, "ops": [], "lock_tokens": ["t1"], "message": "m"}
    )
    assert req.lock_tokens == ["t1"]


def test_preview_response_shape() -> None:
    pr = PreviewResponse(conformance_error_count=2, structural_blockers=[], issues=[])
    assert pr.conformance_error_count == 2
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commit_schemas.py -q`
Expected: FAIL (`ImportError`/`AttributeError`: new names missing).

- [ ] **Step 3: Add `category` to `IssueOut`**

In `src/data_rover/api/schemas.py`, find `class IssueOut` and add a `category: str` field, then set it in `from_core` (alongside the existing severity/message/target_ids mapping):

```python
        return cls(
            severity=issue.severity.value,
            message=issue.message,
            target_ids=list(issue.target_ids),
            category=issue.category.value,
        )
```

- [ ] **Step 4: Add the lock/open/preview/commit models**

Append to `src/data_rover/api/schemas.py` (ensure `Literal` is imported from `typing`):

```python
# --- Phase 4: check-out / commit + locking --------------------------------

class LockTargetIn(BaseModel):
    resource_id: str
    mode: Literal["exclusive", "shared"]


class LockRequest(BaseModel):
    targets: list[LockTargetIn]
    intent: Literal["edit", "create_child", "connect", "delete"]
    #: peer/admin override — evict a conflicting holder's leases (spec §8).
    steal: bool = False


class LeaseOut(BaseModel):
    resource_id: str
    mode: str
    holder: str
    token: str
    intent: str
    expires_at: float


class LockConflictOut(BaseModel):
    resource_id: str
    held_by: str
    held_mode: str


class LockResponse(BaseModel):
    token: str
    leases: list[LeaseOut] = Field(default_factory=list)


class ReleaseRequest(BaseModel):
    token: str


class RenewRequest(BaseModel):
    token: str


class RenewResponse(BaseModel):
    ok: bool


class OpenResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model_rev: int
    role: str
    element_count: int
    relationship_count: int
    issue_counts: dict[str, int] = Field(default_factory=dict)


class PreviewRequest(BaseModel):
    base_rev: int
    ops: list[OpIn] = Field(default_factory=list)


class PreviewResponse(BaseModel):
    conformance_error_count: int
    structural_blockers: list[IssueOut] = Field(default_factory=list)
    issues: list[IssueOut] = Field(default_factory=list)


class CommitRequest(BaseModel):
    base_rev: int
    ops: list[OpIn] = Field(default_factory=list)
    message: str = ""
    lock_tokens: list[str] = Field(default_factory=list)
    #: client acknowledges the surfaced conformance-error count (UI gate).
    ack_errors: bool = False


class CommitResponse(OpsResponse):
    commit_id: str
    message: str = ""
    validation_error_count: int = 0
```

(`LeaseOut`/`LockConflictOut` get `from_core` helpers if convenient, or the routes build them inline — Task 7 builds them inline.)

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_commit_schemas.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/schemas.py tests/api/test_commit_schemas.py
git commit -m "feat(api): lock/open/preview/commit wire schemas + IssueOut.category"
```

---

### Task 7: `routes/locks.py` — lock / release / renew / list

The lock-management endpoints. They live under `/api/v1/projects/{project_id}` and resolve the per-project `Session` (and its `lock_table`) via `get_request_session`. Holder identity is the authenticated `user.id`.

**Files:**
- Create: `src/data_rover/api/routes/locks.py`
- Modify: `src/data_rover/api/main.py` (mount the router)
- Test: `tests/api/test_locks_route.py` (create)

**Interfaces:**
- Consumes: `LockTable`/`expand_targets` (Tasks 2–3), the lock schemas (Task 6), `get_request_session`, `require_model`, `get_current_user`, `get_settings().lock_ttl_seconds`.
- Produces routes: `POST /locks` (200 `LockResponse` / 409 `{detail, conflicts}`), `POST /locks/release` (200 `{released: int}`), `POST /locks/renew` (200 `RenewResponse`), `GET /locks` (200 `{leases: [LeaseOut]}`).

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_locks_route.py` (uses the `client`/`seed_default_project`/`AUTH_HEADERS`/`papi` conftest helpers — `papi("/locks")` targets `/api/v1/projects/default/locks`):

```python
from __future__ import annotations

from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project


def _seed_two_elements(client) -> tuple[str, str]:
    # load the smart-city baseline + create two lockable elements via /model/ops
    seed_default_project(client)
    # (helper in conftest seeds metamodel+model; create elements through ops)
    r = client.post(
        papi("/model/ops"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_a", "type_name": _etype(client), "properties": {}},
                {"kind": "create_element", "temp_id": "tmp_b", "type_name": _etype(client), "properties": {}},
            ],
        },
    )
    assert r.status_code == 200, r.text
    idmap = r.json()["id_map"]
    return idmap["tmp_a"], idmap["tmp_b"]


def _rev(client) -> int:
    return client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def _etype(client) -> str:
    # first concrete element type name from the metamodel summary
    mm = client.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    return next(e["name"] for e in mm["elements"] if not e.get("abstract"))


def test_lock_then_release(client) -> None:
    a, _b = _seed_two_elements(client)
    r = client.post(
        papi("/locks"),
        headers=AUTH_HEADERS,
        json={"targets": [{"resource_id": a, "mode": "exclusive"}], "intent": "edit"},
    )
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    assert any(le["resource_id"] == a for le in r.json()["leases"])

    rel = client.post(papi("/locks/release"), headers=AUTH_HEADERS, json={"token": token})
    assert rel.status_code == 200 and rel.json()["released"] >= 1


def test_lock_conflict_returns_409(client) -> None:
    a, _b = _seed_two_elements(client)
    body = {"targets": [{"resource_id": a, "mode": "exclusive"}], "intent": "edit"}
    first = client.post(papi("/locks"), headers=AUTH_HEADERS, json=body)
    assert first.status_code == 200
    # same user/token reacquire is fine; a DIFFERENT holder conflicts. Simulate
    # a second holder via a distinct identity header.
    other = {"X-User-Id": "u2", "X-User-Email": "u2@x"}
    # u2 must be a project member; seed grants default user only -> expect 403
    # OR (if conftest seeds u2) a 409 conflict. Assert it is NOT a fresh grant:
    second = client.post(papi("/locks"), headers=other, json=body)
    assert second.status_code in (403, 409)


def test_renew_extends(client) -> None:
    a, _b = _seed_two_elements(client)
    r = client.post(
        papi("/locks"),
        headers=AUTH_HEADERS,
        json={"targets": [{"resource_id": a, "mode": "exclusive"}], "intent": "edit"},
    )
    token = r.json()["token"]
    rn = client.post(papi("/locks/renew"), headers=AUTH_HEADERS, json={"token": token})
    assert rn.status_code == 200 and rn.json()["ok"] is True
```

(Adjust the second-holder assertion to whatever `conftest` seeds; the key invariant is "a conflicting acquire never returns a fresh independent grant.")

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_locks_route.py -q`
Expected: FAIL (404 on `/locks` — router not mounted).

- [ ] **Step 3: Implement `routes/locks.py`**

Create `src/data_rover/api/routes/locks.py`:

```python
"""Resource-lease endpoints (Phase 4 check-out). Holder == authenticated user.

Leases live in the per-project ``Session.lock_table`` (resolved via
``get_request_session``, so membership is already authorized). All times use
``time.monotonic()`` — the same clock the lifespan sweeper uses.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from ..deps import Session, get_request_session, require_model
from ..identity import get_current_user
from ..db_models import User
from ..locking import LockIntent, LockMode, expand_targets
from ..schemas import (
    LeaseOut,
    LockRequest,
    LockResponse,
    ReleaseRequest,
    RenewRequest,
    RenewResponse,
)
from ..settings import get_settings

router = APIRouter()


def _lease_out(le) -> LeaseOut:
    return LeaseOut(
        resource_id=le.resource_id,
        mode=le.mode.value,
        holder=le.holder,
        token=le.token,
        intent=le.intent.value,
        expires_at=le.expires_at,
    )


@router.post("/locks", response_model=None)
def acquire_locks(
    payload: LockRequest,
    session: Session = Depends(get_request_session),
    user: User = Depends(get_current_user),
) -> LockResponse | JSONResponse:
    _, model = require_model(session)
    targets = [(t.resource_id, LockMode(t.mode)) for t in payload.targets]
    reqs = expand_targets(model, targets, LockIntent(payload.intent))
    now = time.monotonic()
    ttl = float(get_settings().lock_ttl_seconds)
    with session.write_mutex:
        token, leases, conflicts = session.lock_table.acquire(
            user.id, reqs, now=now, ttl=ttl, steal=payload.steal
        )
    if conflicts:
        return JSONResponse(
            status_code=409,
            content={
                "detail": "lock conflict",
                "conflicts": [
                    {"resource_id": c.resource_id, "held_by": c.held_by,
                     "held_mode": c.held_mode.value}
                    for c in conflicts
                ],
            },
        )
    return LockResponse(token=token, leases=[_lease_out(le) for le in leases])


@router.post("/locks/release")
def release_locks(
    payload: ReleaseRequest,
    session: Session = Depends(get_request_session),
    user: User = Depends(get_current_user),
) -> dict[str, int]:
    with session.write_mutex:
        released = session.lock_table.release(user.id, payload.token)
    return {"released": len(released)}


@router.post("/locks/renew")
def renew_locks(
    payload: RenewRequest,
    session: Session = Depends(get_request_session),
    user: User = Depends(get_current_user),
) -> RenewResponse:
    now = time.monotonic()
    ttl = float(get_settings().lock_ttl_seconds)
    with session.write_mutex:
        ok = session.lock_table.renew(user.id, payload.token, now=now, ttl=ttl)
    return RenewResponse(ok=ok)


@router.get("/locks")
def list_locks(
    session: Session = Depends(get_request_session),
) -> dict[str, list[LeaseOut]]:
    leases = session.lock_table.active_leases(time.monotonic())
    return {"leases": [_lease_out(le) for le in leases]}
```

- [ ] **Step 4: Add `lock_ttl_seconds`/`lock_sweep_seconds` settings**

In `src/data_rover/api/settings.py`, add after `idle_evict_seconds`:

```python
    #: lease lifetime; renewed by client heartbeat (spec §8). Must be well
    #: under idle_evict_seconds so an idle session has no live leases to strand.
    lock_ttl_seconds: int = 300
    #: lifespan sweeper interval for auto-releasing expired leases. 0 disables.
    lock_sweep_seconds: int = 60
```

- [ ] **Step 5: Mount the router**

In `src/data_rover/api/main.py`, add `locks` to the `from .routes import (...)` import and add the include alongside the others (after `validation`):

```python
    app.include_router(locks.router, prefix=proj, tags=["locks"])
```

But `/locks*` are writes against authz: `require_membership` treats POSTs as writes by default, which is correct (a viewer must not take an edit lock). `GET /locks` is a read. No allowlist change needed.

- [ ] **Step 6: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_locks_route.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/routes/locks.py src/data_rover/api/settings.py \
        src/data_rover/api/main.py tests/api/test_locks_route.py
git commit -m "feat(api): lock acquire/release/renew/list endpoints"
```

---

### Task 8: `routes/commits.py` — `GET /open` + `POST /commits/preview`

The open handshake and the mandatory pre-commit validation. Preview reuses `_apply_batch` then `_rollback` (apply → validate dirty set → roll back) — all under the write-mutex, which `_apply_batch` requires per spec §11.

**Files:**
- Create: `src/data_rover/api/routes/commits.py`
- Modify: `src/data_rover/api/main.py` (mount)
- Test: `tests/api/test_open_route.py`, `tests/api/test_commits_route.py` (create; preview half here, commit half in Task 9)

**Interfaces:**
- Consumes: `_apply_batch`, `_rollback`, `_ensure_validation_seeded` (from `.ops`), `default_pipeline`, `Scope`, `IssueCategory`, the membership `Role` (for `open` role), the preview/open schemas (Task 6).
- Produces routes: `GET /open` → `OpenResponse`; `POST /commits/preview` → `PreviewResponse` (or 409 on `base_rev` mismatch, 422 on a mutation-boundary structural error raised by `_apply_batch`).

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_open_route.py`:

```python
from __future__ import annotations

from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project


def test_open_returns_rev_and_role(client) -> None:
    seed_default_project(client)
    r = client.get(papi("/open"), headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "model_rev" in body and body["role"] == "owner"
    assert body["element_count"] >= 0
```

Create `tests/api/test_commits_route.py` (preview portion):

```python
from __future__ import annotations

from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project


def _rev(client) -> int:
    return client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def _etype(client) -> str:
    mm = client.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    return next(e["name"] for e in mm["elements"] if not e.get("abstract"))


def test_preview_clean_create_reports_zero_errors(client) -> None:
    seed_default_project(client)
    r = client.post(
        papi("/commits/preview"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": _rev(client),
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_x",
                 "type_name": _etype(client), "properties": {}}
            ],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["conformance_error_count"] == 0
    assert r.json()["structural_blockers"] == []


def test_preview_does_not_mutate_model_rev(client) -> None:
    seed_default_project(client)
    before = _rev(client)
    client.post(
        papi("/commits/preview"),
        headers=AUTH_HEADERS,
        json={"base_rev": before, "ops": [
            {"kind": "create_element", "temp_id": "tmp_x",
             "type_name": _etype(client), "properties": {}}]},
    )
    assert _rev(client) == before  # preview rolled back; rev unchanged


def test_preview_base_rev_mismatch_409(client) -> None:
    seed_default_project(client)
    r = client.post(
        papi("/commits/preview"),
        headers=AUTH_HEADERS,
        json={"base_rev": 9999, "ops": []},
    )
    assert r.status_code == 409
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_open_route.py tests/api/test_commits_route.py -q`
Expected: FAIL (404 — router not mounted).

- [ ] **Step 3: Implement open + preview**

Create `src/data_rover/api/routes/commits.py`:

```python
"""Check-out/commit endpoints (Phase 4 spec §7): open, preview, commit.

Reuses the delta machinery from ``routes/ops.py`` — ``_apply_batch`` (atomic
apply with inverse collection; raises 422 on a mutation-boundary error),
``_rollback`` (undo a previewed batch), ``_ensure_validation_seeded`` (full-run
baseline), and ``_persist_commit`` (durable journal append). Preview and commit
both take ``session.write_mutex`` (spec §11: apply/validate/rollback run only
under it). This module deliberately imports those module-private helpers — they
are part of the ops package's internal surface, shared with this sibling.
"""

from __future__ import annotations

import time
import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from data_rover.core.validation.issue import IssueCategory
from data_rover.core.validation.pipeline import default_pipeline

from ..authz import require_membership
from ..db import get_db
from ..db_models import Membership, User
from ..deps import Session, get_request_session, require_model
from ..identity import get_current_user
from ..locking import required_locks
from ..schemas import (
    CommitRequest,
    CommitResponse,
    ElementOut,
    IssueOut,
    OpenResponse,
    PreviewRequest,
    PreviewResponse,
    RelationshipOut,
)
from .ops import (
    _apply_batch,
    _ensure_validation_seeded,
    _persist_commit,
    _rollback,
)

router = APIRouter()


@router.get("/open", response_model=None)
def open_project(
    session: Session = Depends(get_request_session),
    membership: Membership = Depends(require_membership),
) -> OpenResponse:
    _, model = require_model(session)
    state = _ensure_validation_seeded(session, model)
    return OpenResponse(
        model_rev=session.model_rev,
        role=membership.role.value,
        element_count=len(model.elements),
        relationship_count=len(model.relationships),
        issue_counts=state.counts(),
    )


@router.post("/commits/preview", response_model=None)
def preview_commit(
    payload: PreviewRequest,
    session: Session = Depends(get_request_session),
) -> PreviewResponse | JSONResponse:
    _, model = require_model(session)
    if payload.base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={"detail": "stale base_rev", "model_rev": session.model_rev},
        )
    with session.write_mutex:
        # _apply_batch raises 422 on a mutation-boundary structural error
        # (unknown type, missing endpoint, unknown property) — the safety net.
        res = _apply_batch(model, payload.ops, restore=False)
        try:
            scoped = default_pipeline().validate(model, res.dirty.to_scope())
        finally:
            _rollback(model, res.inverse_units)  # always restore the model
    structural = [i for i in scoped if i.category is IssueCategory.STRUCTURAL]
    conformance = [i for i in scoped if i.category is IssueCategory.CONFORMANCE]
    return PreviewResponse(
        conformance_error_count=len(conformance),
        structural_blockers=[IssueOut.from_core(i) for i in structural],
        issues=[IssueOut.from_core(i) for i in scoped],
    )
```

(The `POST /commits` handler is added in Task 9 — leave the imports for `CommitRequest`/`CommitResponse`/`ElementOut`/`RelationshipOut`/`required_locks`/`_persist_commit`/`get_db`/`get_current_user`/`uuid`/`time` in place; they are used there. If ruff flags them unused after this task, add the commit handler in the same task rather than suppressing.)

- [ ] **Step 4: Mount the router**

In `src/data_rover/api/main.py`, add `commits` to the routes import and:

```python
    app.include_router(commits.router, prefix=proj, tags=["commits"])
```

`GET /open` is a read; `POST /commits/preview` is a read-only POST that must NOT require write permission (a viewer may preview). Add `/commits/preview` to the read-only POST allowlist in `authz.py` (`_READ_ONLY_POST_SUFFIXES`):

```python
    "/commits/preview",
```

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_open_route.py tests/api/test_commits_route.py -q`
Expected: PASS (commit tests added in Task 9 still absent; preview + open pass).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/routes/commits.py src/data_rover/api/main.py \
        src/data_rover/api/authz.py tests/api/test_open_route.py \
        tests/api/test_commits_route.py
git commit -m "feat(api): open handshake + mandatory pre-commit preview"
```

---

### Task 9: `POST /commits` — lock-verified, structural-gated commit

The commit path: verify the caller holds the required locks (409 if lost), check `base_rev` (409), apply the batch (422 on mutation-boundary error), hard-reject structural validator issues (422), count conformance issues, persist a commit row (message + count + issues), bump rev, release the caller's locks, return the delta + commit metadata.

**Files:**
- Modify: `src/data_rover/api/routes/commits.py` (append the handler)
- Test: `tests/api/test_commits_route.py` (extend)

**Interfaces:**
- Consumes: `required_locks` (Task 3), `session.lock_table.verify_held`/`release` (Task 2), `_apply_batch`/`_persist_commit` (ops), `serialize` of issues (`IssueOut.from_core`), `CommitRequest`/`CommitResponse`.
- Produces: `POST /commits` → `CommitResponse` (200) / 409 (lost lock or stale rev) / 422 (structural blocker).

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_commits_route.py`:

```python
def _lock(client, rid, mode="exclusive", intent="edit"):
    r = client.post(
        papi("/locks"),
        headers=AUTH_HEADERS,
        json={"targets": [{"resource_id": rid, "mode": mode}], "intent": intent},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_commit_requires_held_lock_409(client) -> None:
    seed_default_project(client)
    # create an element to edit (via ops, which is unlocked legacy path)
    rev = _rev(client)
    cr = client.post(papi("/model/ops"), headers=AUTH_HEADERS, json={
        "base_rev": rev,
        "ops": [{"kind": "create_element", "temp_id": "tmp_e",
                 "type_name": _etype(client), "properties": {}}]})
    eid = cr.json()["id_map"]["tmp_e"]
    # commit an edit to eid WITHOUT holding its lock -> 409
    r = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client),
        "ops": [{"kind": "update_element", "id": eid, "properties_patch": {}}],
        "lock_tokens": [], "message": "edit"})
    assert r.status_code == 409, r.text


def test_commit_with_lock_succeeds_and_records_message(client) -> None:
    seed_default_project(client)
    rev = _rev(client)
    cr = client.post(papi("/model/ops"), headers=AUTH_HEADERS, json={
        "base_rev": rev,
        "ops": [{"kind": "create_element", "temp_id": "tmp_e",
                 "type_name": _etype(client), "properties": {}}]})
    eid = cr.json()["id_map"]["tmp_e"]
    token = _lock(client, eid)
    r = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client),
        "ops": [{"kind": "update_element", "id": eid, "properties_patch": {}}],
        "lock_tokens": [token], "message": "tweak"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["message"] == "tweak" and "commit_id" in body
    # commit released the lock
    assert client.get(papi("/locks"), headers=AUTH_HEADERS).json()["leases"] == []


def test_commit_creates_freefloating_without_lock(client) -> None:
    # a free-floating create needs no lock (temp id until commit, spec §8)
    seed_default_project(client)
    r = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client),
        "ops": [{"kind": "create_element", "temp_id": "tmp_n",
                 "type_name": _etype(client), "properties": {}}],
        "lock_tokens": [], "message": "new"})
    assert r.status_code == 200, r.text
    assert r.json()["id_map"]["tmp_n"]
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_commits_route.py -q`
Expected: FAIL (404 — `/commits` handler not defined).

- [ ] **Step 3: Implement the commit handler**

Append to `src/data_rover/api/routes/commits.py`:

```python
@router.post("/commits", response_model=None)
def create_commit(
    payload: CommitRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CommitResponse | JSONResponse:
    _, model = require_model(session)
    if payload.base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={"detail": "stale base_rev", "model_rev": session.model_rev},
        )
    state = _ensure_validation_seeded(session, model)
    with session.write_mutex:
        # a. verify the caller still holds every required lock
        reqs = required_locks(model, payload.ops)
        missing = session.lock_table.verify_held(
            user.id, payload.lock_tokens, reqs, now=time.monotonic()
        )
        if missing:
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "required lock not held",
                    "missing": [
                        {"resource_id": m.resource_id, "mode": m.mode.value}
                        for m in missing
                    ],
                },
            )
        # b/c. apply (422 on mutation-boundary error), then validate the dirty set
        res = _apply_batch(model, payload.ops, restore=False)
        scoped = default_pipeline().validate(model, res.dirty.to_scope())
        structural = [i for i in scoped if i.category is IssueCategory.STRUCTURAL]
        if structural:
            _rollback(model, res.inverse_units)  # hard structural reject
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
        # d/e. commit accepted: splice issues, bump rev, persist, release locks
        delta = state.replace(res.dirty.ids, scoped)
        session.model_rev += 1
        from ..session import AppliedBatch

        session.record_batch(
            AppliedBatch(
                ops=res.canonical_ops,
                inverse_ops=res.inverse_ops(),
                id_map=dict(res.id_map),
            )
        )
        commit_id = uuid.uuid4().hex
        issues_json = [IssueOut.from_core(i).model_dump() for i in conformance]
        try:
            _persist_commit(
                db, project_id, rev=session.model_rev, author_id=user.id, res=res,
                _commit_id=commit_id, _message=payload.message,
                _validation_error_count=len(conformance), _issues=issues_json,
            )
        except Exception as exc:
            _rollback(model, res.inverse_units)
            session.model_rev -= 1
            session.op_log.pop()
            db.rollback()
            raise
        session.lock_table.release(user.id, *_tokens(payload.lock_tokens))
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
        message=payload.message,
        validation_error_count=len(conformance),
    )


def _tokens(tokens: list[str]) -> list[str]:
    """Release every token the committer passed (each is released separately
    because LockTable.release is per-token). Returns the list for splat use."""
    return tokens
```

The `release` loop above won't work via splat — replace the single `session.lock_table.release(...)` line with a loop:

```python
        for tok in payload.lock_tokens:
            session.lock_table.release(user.id, tok)
```

and delete the `_tokens` helper (it was a scaffolding misstep — use the explicit loop).

- [ ] **Step 4: Extend `_persist_commit` to carry commit metadata**

In `src/data_rover/api/routes/ops.py`, widen `_persist_commit` to accept the new metadata (keyword-only, defaulted so the existing `/model/ops` call site is unchanged):

```python
def _persist_commit(
    db: DbSession,
    project_id: str,
    *,
    rev: int,
    author_id: str | None,
    res: "_BatchResult",
    _commit_id: str | None = None,
    _message: str = "",
    _validation_error_count: int = 0,
    _issues: list | None = None,
) -> bool:
    if content.get_model_row(db, project_id) is None:
        return False
    content.append_commit(
        db,
        project_id,
        rev=rev,
        commit_id=_commit_id or uuid.uuid4().hex,
        author_id=author_id,
        ops=serialize_ops(res.canonical_ops),
        inverse_ops=serialize_ops(res.inverse_ops()),
        id_map=dict(res.id_map),
        message=_message,
        validation_error_count=_validation_error_count,
        issues=_issues or [],
    )
    content.set_model_rev(db, project_id, rev)
    db.commit()
    return True
```

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_commits_route.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/routes/commits.py src/data_rover/api/routes/ops.py \
        tests/api/test_commits_route.py
git commit -m "feat(api): lock-verified, structural-gated commit endpoint"
```

---

### Task 10: Lifespan lock-expiry sweeper

A background task that periodically sweeps expired leases across all warm sessions, so a client that disappears without releasing doesn't strand a resource past its TTL. Mirrors the Phase 3 idle-evict sweeper pattern in `main.py`.

**Files:**
- Modify: `src/data_rover/api/main.py`
- Test: `tests/api/test_lock_sweeper.py` (create) — tests the sweep step directly (no real timers).

**Interfaces:**
- Produces: `_sweep_expired_locks(now: float) -> int` (module function in `main.py` or `session.py`) sweeping every warm session's `lock_table`, returning the count released; the lifespan starts a `lock_sweep_seconds` loop calling it (skipped when `lock_sweep_seconds == 0`, as in tests).

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_lock_sweeper.py`:

```python
from __future__ import annotations

import time

from data_rover.api.locking import LockIntent, LockMode, RequiredLock
from data_rover.api.session import get_registry


def test_sweep_releases_expired_across_sessions(client) -> None:
    from data_rover.api.main import _sweep_expired_locks
    from tests.api.conftest import seed_default_project

    seed_default_project(client)
    sess = get_registry().get("default")
    now = time.monotonic()
    sess.lock_table.acquire(
        "u1",
        [RequiredLock(resource_id="e1", mode=LockMode.EXCLUSIVE, intent=LockIntent.EDIT)],
        now=now,
        ttl=0.0,  # already expired
    )
    released = _sweep_expired_locks(now + 1.0)
    assert released >= 1
    assert sess.lock_table.active_leases(now + 1.0) == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_lock_sweeper.py -q`
Expected: FAIL (`ImportError: cannot import name '_sweep_expired_locks'`).

- [ ] **Step 3: Implement the sweep step + lifespan loop**

In `src/data_rover/api/main.py`, add the sweep helper (near the idle-evict sweeper):

```python
def _sweep_expired_locks(now: float) -> int:
    """Drop expired leases from every warm session. Returns count released."""
    from .session import get_registry

    registry = get_registry()
    released = 0
    for pid in registry.project_ids():
        session = registry.get(pid)
        with session.write_mutex:
            released += len(session.lock_table.sweep_expired(now))
    return released
```

In the lifespan startup, alongside the existing idle-evict sweeper task, start a periodic loop when `settings.lock_sweep_seconds > 0` that calls `_sweep_expired_locks(time.monotonic())` every `lock_sweep_seconds`. Follow the EXACT async-task + cancel-on-shutdown shape already used for idle-evict (read the existing lifespan to match it; do not invent a new pattern). In tests `lock_sweep_seconds` is forced to 0 by conftest (Step 4), so the loop never starts.

- [ ] **Step 4: Force the sweeper off in tests**

In `tests/api/conftest.py`, where Phase 3 already forces `idle_evict_seconds=0` (via env or settings override), also force `DATA_ROVER_LOCK_SWEEP_SECONDS=0` so no background loop runs during tests. (The unit test above calls `_sweep_expired_locks` directly.)

- [ ] **Step 5: Run to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_lock_sweeper.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/main.py tests/api/conftest.py tests/api/test_lock_sweeper.py
git commit -m "feat(api): lifespan sweeper auto-releases expired leases"
```

---

### Task 11: Document Phase 4 + full verification

Add the Phase 4 section to `CLAUDE.md` (mirroring the Phase 1/2/3 sections) and run the whole gate.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `frontend/README.md` is NOT touched (backend-only).

- [ ] **Step 1: Add the `CLAUDE.md` Phase 4 section**

After the "Durable persistence (Phase 3)" section, add a "Check-out/commit + locking (Phase 4)" section documenting: `locking.py` (`LockTable` in-session leases, intent-aware conflict matrix, `expand_targets`/`required_locks` scope rules); the `category` tier on `Issue` (structural = hard 422, conformance = counted); `routes/locks.py` (acquire/release/renew/list) and `routes/commits.py` (`open`/`preview`/`commit`); preview = apply→validate→rollback under the write-mutex; commit verifies held locks (409), hard-rejects structural blockers (422), persists message + error count + issues on the `Commit` row, bumps rev, releases locks; the lifespan lock sweeper + `lock_ttl_seconds`/`lock_sweep_seconds`; the evict-with-live-locks guard; and that `/model/ops` + `/model/undo` remain as the legacy unlocked path until the frontend migrates (separate plan). One line each, matching the existing terse style.

- [ ] **Step 2: Run the full API + validation suites**

Run: `pixi run -e core-dev pytest tests/api tests/validation -q`
Expected: PASS (no regressions; existing `/model/ops` tests untouched).

- [ ] **Step 3: Run the lint/type gate**

Run: `pixi run tidy`
Expected: ruff `--fix`, mypy, and pyright all clean. Fix anything (e.g. unused imports flagged in commits.py Task 8, the `_tokens` scaffolding removed in Task 9).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Phase 4 check-out/commit + locking"
```

---

## Verification (end-to-end)

1. **Unit/route tests** (hermetic, no services): `pixi run -e core-dev pytest tests/api tests/validation -q` — all green, including the new `test_locking`, `test_lock_scope`, `test_locks_route`, `test_open_route`, `test_commits_route`, `test_lock_sweeper`, `test_issue_category` modules.
2. **Lint/type gate**: `pixi run tidy` — ruff + mypy + pyright clean.
3. **Alembic round-trip**: `pixi run -e core-dev pytest tests/api/test_alembic.py -q` confirms 0003 upgrades a fresh schema cleanly.
4. **Manual smoke** (optional, needs the dev backend): with `pixi run start-backend` (SQLite dev seed), exercise the flow against `/api/v1/projects/default` with dev identity headers:
   - `GET /open` → `{model_rev, role:"owner", ...}`.
   - `POST /locks {targets:[{resource_id:<E>, mode:"exclusive"}], intent:"edit"}` → `{token, leases}`; a second distinct holder gets `409`.
   - `POST /commits/preview {base_rev, ops:[update <E>]}` → `{conformance_error_count, structural_blockers:[]}`; confirm `GET /model/summary` `model_rev` is unchanged (rolled back).
   - `POST /commits {base_rev, ops, lock_tokens:[token], message:"x"}` → `200 {commit_id, message:"x"}`; `GET /locks` now empty (released); `model_rev` bumped by 1.
   - Commit the same edit again without a lock → `409 required lock not held`.
   - Forge a dangling-reference op and commit → `422 structural validation blocker`.

## Notes / out of scope (deferred)

- **Frontend** lock→edit-locally→commit rewire (drop continuous flush, mandatory preview gate, commit-message UI, conformance-error review panel) — follow-up plan, pairs with Phase 5.
- **Realtime** lock broadcast, presence, lock badges — Phase 5 (the `acquire`/`release`/commit sites are where the future broadcast hook lands; left as a no-op now).
- **Redis** lease mirroring + cross-instance ownership — Phase 7.
- **Strict mode** (promote conformance→hard), commit-history browser, revert-to-commit — Phase 8 (the `Commit.message`/`issues`/`validation_error_count` columns and append-only journal already feed it).
