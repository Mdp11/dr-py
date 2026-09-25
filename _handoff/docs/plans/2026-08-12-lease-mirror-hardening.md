# Lease Mirror Hardening (B-1 → B-4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four small findings left by the Redis lock-mirroring phase: app logging that actually emits INFO (B-1), clamped restored-lease lifetime against wall-clock jumps (B-2), serialized mirror write-throughs so the mirror can't hold phantom leases from reordering (B-3), and a deployment key-prefix so two backends can share one Redis DB (B-4).

**Architecture:** All four changes live in the existing lease-mirror seam (`src/data_rover/api/lock_mirror.py`, `lock_mirror_redis.py`) plus one-line touches to `main.py`, `session.py` and `settings.py`. No new modules, no schema changes, no frontend changes. `LockTable` remains the sole conflict authority; the mirror stays best-effort and never fails a route.

**Tech Stack:** Python 3.14, FastAPI, pytest (hermetic — `MemoryLeaseMirror`; one optional `integration`-marked Redis test). Toolchain via pixi.

## Global Constraints

- Everything runs through pixi: tests are `pixi run -e core-dev pytest <path> -v`; full check is `pixi run core-test` and `pixi run dr-tidy` (ruff + mypy + pyright all must pass).
- The mirror must **never raise into a route or hydration** — every change keeps the existing two-layer catch-all posture.
- `LockTable` stays the only conflict authority; the mirror never participates in a conflict decision.
- The repo's docstrings explain *why* invariants exist — every behavior change here must update the corresponding docstring text (module docstrings in `lock_mirror.py` / `lock_mirror_redis.py` currently document the bugs B-2/B-3/B-4 as accepted caveats; those paragraphs must be rewritten, not left stale).
- Each task marks its backlog item `done` in `BACKLOG.md` **in the same commit** (per BACKLOG.md's own usage rules — keep the item, change its status to `` `done` ``).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Known pytest hazard (documented in `tests/api/test_lock_mirror.py:86`): `test_alembic.py` calls `logging.config.fileConfig`, which sets `.disabled` on pre-existing loggers. Tests must therefore assert `logger.level`, never `isEnabledFor()`, on `data_rover.*` loggers.

---

## Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Create the working branch from main**

```bash
git checkout -b fix/lease-mirror-hardening main
```

Expected: clean checkout, `git status` shows nothing to commit.

---

## Task 1: B-1 — Configure app logging so `data_rover.*` INFO surfaces

Nothing in the process configures logging (`basicConfig`/`dictConfig` appear nowhere in `src/`), and uvicorn's default log config only wires its own `uvicorn.*` loggers. So every `logger.info` in the codebase — including the mirror's two operator signals, `restore_leases`'s "restored N mirrored lease(s)" and `_mark_up`'s "Redis recovered" — falls through to `logging.lastResort`, which emits WARNING and above only.

**Files:**
- Modify: `src/data_rover/api/main.py` (new `_configure_logging()`, called first in `create_app()` ~line 223)
- Modify: `BACKLOG.md` (B-1 → done)
- Test: `tests/api/test_logging_config.py` (new)

**Interfaces:**
- Produces: `main._configure_logging() -> None` — module-private, imported by the test file.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_logging_config.py`:

```python
"""B-1: the app configures logging at create_app() so ``data_rover.*``
INFO records are actually emitted (previously they fell through to
``logging.lastResort``, which drops everything below WARNING)."""

from __future__ import annotations

import logging

from data_rover.api.main import _configure_logging


def test_configure_logging_installs_root_handler_when_absent() -> None:
    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers.clear()
    try:
        _configure_logging()
        assert root.handlers, "basicConfig must install a root handler"
    finally:
        root.handlers[:] = saved


def test_configure_logging_never_stomps_existing_root_handlers() -> None:
    # An operator-supplied config (or pytest's own capture handler) must
    # survive: basicConfig is a no-op when root already has handlers.
    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers.clear()
    marker = logging.NullHandler()
    root.addHandler(marker)
    try:
        _configure_logging()
        assert root.handlers == [marker]
    finally:
        root.handlers[:] = saved


def test_data_rover_logger_level_is_info() -> None:
    # Asserts .level, NOT isEnabledFor(): alembic's fileConfig
    # (test_alembic.py) sets .disabled on pre-existing loggers when it runs
    # earlier in the same session, which flips isEnabledFor() but never
    # .level — the same order-dependent hazard test_lock_mirror.py:86
    # documents. .level is what _configure_logging owns.
    _configure_logging()
    assert logging.getLogger("data_rover").level == logging.INFO
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_logging_config.py -v`
Expected: FAIL with `ImportError: cannot import name '_configure_logging'`

- [ ] **Step 3: Implement `_configure_logging` in `main.py`**

Add above `_ensure_dev_seed` (after the module-level `logger = logging.getLogger(__name__)`):

```python
def _configure_logging() -> None:
    """Give the app's own loggers a working INFO path (backlog B-1).

    Nothing else in the process configures logging: uvicorn's default log
    config wires only its own ``uvicorn.*`` loggers, so everything under
    ``data_rover.*`` fell through to ``logging.lastResort``, which emits
    WARNING and above only — every ``logger.info`` in the codebase (notably
    the lease mirror's operator signals: "restored N mirrored lease(s)",
    "lease mirror: Redis recovered") was silently dropped.

    ``basicConfig`` is a no-op when the root logger already has handlers, so
    an operator-supplied config (or pytest's capture handler) is never
    stomped; the ``data_rover`` level is set unconditionally either way,
    which is harmless (a level, not a handler)."""
    logging.basicConfig(format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("data_rover").setLevel(logging.INFO)
```

And make it the first line of `create_app()`:

```python
def create_app() -> FastAPI:
    _configure_logging()
    settings = get_settings()
    ...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_logging_config.py tests/api/test_lock_mirror.py -v`
Expected: all PASS (the second file guards against regressions in the logger-stubbing test).

- [ ] **Step 5: Mark B-1 done in BACKLOG.md**

Change the B-1 heading line to:

```markdown
### B-1 · The app never configures logging, so `logger.info` is invisible · `done` (2026-08-12, fix/lease-mirror-hardening)
```

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/main.py tests/api/test_logging_config.py BACKLOG.md
git commit -m "fix(api): configure logging at startup so data_rover.* INFO surfaces (B-1)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: B-2 — Clamp restored lease lifetime against wall-clock jumps

`to_leases` computes `remaining = expires_at_epoch - wall_now` with no ceiling: a backward NTP correction between mirror-write and restore yields a restored lease living longer than `lock_ttl_seconds`. Fix: a `max_remaining_s` **parameter** on `to_leases` (keeps it pure — no settings dependency, exactly why this was parked), with the settings read in `restore_leases`.

**Files:**
- Modify: `src/data_rover/api/lock_mirror.py` (`to_leases` ~line 137, `restore_leases` ~line 237, module docstring "Clock mapping" paragraph ~line 24)
- Modify: `BACKLOG.md` (B-2 → done)
- Test: `tests/api/test_lock_mirror.py`

**Interfaces:**
- Produces: `to_leases(mirrored, *, mono_now, wall_now, max_remaining_s: float | None = None) -> list[Lease]` — new keyword-only param, default preserves current behavior for every existing caller/test.

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/test_lock_mirror.py` (after `test_expired_entries_dropped_on_both_conversions`; `MirroredLease`, `to_leases`, `MemoryLeaseMirror`, `set_lease_mirror` are already imported there):

```python
def test_to_leases_clamps_remaining_to_max() -> None:
    # backward wall-clock jump between mirror-write and restore: the entry
    # claims 900s remaining but a lease can never legitimately outlive the
    # TTL it was granted with
    m = MirroredLease("e1", "exclusive", "u", "t", "edit", 5000.0 + 900.0)
    [le] = to_leases([m], mono_now=100.0, wall_now=5000.0, max_remaining_s=300.0)
    assert le.expires_at == 100.0 + 300.0


def test_to_leases_no_clamp_by_default_and_ignores_nonpositive_cap() -> None:
    m = MirroredLease("e1", "exclusive", "u", "t", "edit", 5000.0 + 900.0)
    [default] = to_leases([m], mono_now=100.0, wall_now=5000.0)
    assert default.expires_at == 100.0 + 900.0
    # a 0 TTL means "TTL disabled" elsewhere in settings — it must mean
    # "no cap" here too, never "drop every restored lease"
    [uncapped] = to_leases([m], mono_now=100.0, wall_now=5000.0, max_remaining_s=0.0)
    assert uncapped.expires_at == 100.0 + 900.0


def test_restore_leases_clamps_to_lock_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    # end-to-end wiring: restore_leases must pass settings.lock_ttl_seconds
    # as the cap
    from data_rover.api.locking import LockTable
    from data_rover.api.lock_mirror import restore_leases

    monkeypatch.setenv("DATA_ROVER_LOCK_TTL_SECONDS", "60")
    mirror = MemoryLeaseMirror()
    mirror.write(
        "p1",
        [MirroredLease("e1", "exclusive", "u", "t", "edit", time.time() + 900.0)],
    )
    set_lease_mirror(mirror)
    try:
        table = LockTable()
        restore_leases("p1", table)
        now = time.monotonic()
        [le] = table.active_leases(now)
        assert le.expires_at - now <= 60.0 + 1.0  # clamped, +1s slop
    finally:
        set_lease_mirror(None)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v -k clamp`
Expected: FAIL — `to_leases() got an unexpected keyword argument 'max_remaining_s'` (first two), unclamped 900s remaining (third).

- [ ] **Step 3: Implement the clamp**

In `src/data_rover/api/lock_mirror.py`, replace `to_leases` with:

```python
def to_leases(
    mirrored: list[MirroredLease],
    *,
    mono_now: float,
    wall_now: float,
    max_remaining_s: float | None = None,
) -> list[Lease]:
    """Wall clock → monotonic; entries that expired while we were down are
    dropped here rather than restored-then-swept, so a restored table never
    contains a lease the conflict matrix would have to re-check.

    ``max_remaining_s`` (when positive) caps each restored lease's remaining
    lifetime: the mirrored epoch was computed from a different process's wall
    clock, so a backward NTP correction between mirror-write and restore
    would otherwise restore a lease outliving ``lock_ttl_seconds``. The cap
    is a parameter, not a settings read, so this stays a pure function — the
    settings-aware call site is :func:`restore_leases`. (A forward jump
    silently shortens or drops leases; that direction is unfixable from
    here and self-heals via the client renew heartbeat.)"""
    out: list[Lease] = []
    for m in mirrored:
        remaining = m.expires_at_epoch - wall_now
        if remaining <= 0:
            continue
        if max_remaining_s is not None and max_remaining_s > 0:
            remaining = min(remaining, max_remaining_s)
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
```

In `restore_leases`, replace the `to_leases` call with (lazy settings import matches `get_lease_mirror`'s existing pattern):

```python
        from .settings import get_settings

        leases = to_leases(
            mirrored,
            mono_now=time.monotonic(),
            wall_now=time.time(),
            max_remaining_s=float(get_settings().lock_ttl_seconds),
        )
```

In the module docstring, extend the "Clock mapping" paragraph (~line 24) to:

```
Clock mapping: ``Lease.expires_at`` is ``time.monotonic()`` — meaningless
across processes. Conversion to/from wall clock (``time.time()``) happens in
:func:`to_mirrored` / :func:`to_leases` and nowhere else; on restore the
remaining lifetime is additionally clamped to ``lock_ttl_seconds`` so a
backward wall-clock jump between write and restore cannot mint a lease that
outlives the TTL it was granted with.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v`
Expected: all PASS (including the pre-existing round-trip tests — the default keeps behavior identical).

- [ ] **Step 5: Mark B-2 done in BACKLOG.md**

```markdown
### B-2 · `to_leases` doesn't clamp restored lease lifetime against clock jumps · `done` (2026-08-12, fix/lease-mirror-hardening)
```

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/lock_mirror.py tests/api/test_lock_mirror.py BACKLOG.md
git commit -m "fix(api): clamp restored mirror leases to lock_ttl_seconds (B-2)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: B-3 — Serialize snapshot+write per session (kill the reordering phantom)

Two write-throughs on one project can land out of order (acquire snapshots `{r1,r2}`; release of r2 snapshots `{r1}`; the acquire's write lands last), leaving the mirror holding a lease truth no longer has — restored as a phantom after a restart, blocking a peer for up to 300s. Fix: a dedicated per-session `mirror_mutex` (NOT `write_mutex` — the mirror does network I/O that must never sit inside a route's critical section) held across snapshot **and** write, so writes land in snapshot order.

**Files:**
- Modify: `src/data_rover/api/session.py` (new `Session.mirror_mutex` field, after `lock_table` ~line 100)
- Modify: `src/data_rover/api/lock_mirror.py` (`mirror_session_leases` ~line 210; module-docstring phantom paragraph ~lines 10–22)
- Modify: `BACKLOG.md` (B-3 → done)
- Test: `tests/api/test_lock_mirror.py`

**Interfaces:**
- Produces: `Session.mirror_mutex: threading.Lock` — used only by `lock_mirror.mirror_session_leases` and tests.
- Lock ordering rule (must hold everywhere): `mirror_mutex` is only ever acquired when `write_mutex` is NOT held. All four call sites (`routes/locks.py:115/130/146`, `routes/commits.py:1112`, `main.py:156`) already call `mirror_session_leases` after their `with session.write_mutex:` block exits — verified 2026-08-12.

- [ ] **Step 1: Write the failing test**

Add to `tests/api/test_lock_mirror.py` (uses the existing `_lease` helper at the top of the file):

```python
def test_write_throughs_are_serialized_in_snapshot_order() -> None:
    """B-3: snapshot+write are atomic w.r.t. each other, so a slow earlier
    write-through can never land AFTER a later one and leave the mirror
    holding a released lease (the restart-phantom source). Deterministic, not
    a race reproduction: the first write blocks on a gate; the second
    write-through must wait for it rather than overtake it."""
    from data_rover.api.lock_mirror import mirror_session_leases
    from data_rover.api.session import Session

    class GatedRecordingMirror:
        def __init__(self) -> None:
            self.writes: list[list[MirroredLease]] = []
            self.entered = threading.Event()
            self.gate = threading.Event()
            self._first = True

        def write(self, project_id: str, leases: list[MirroredLease]) -> None:
            if self._first:
                self._first = False
                self.entered.set()
                assert self.gate.wait(timeout=5)
            self.writes.append(list(leases))

        def load(self, project_id: str) -> list[MirroredLease]:
            return []

    mirror = GatedRecordingMirror()
    set_lease_mirror(mirror)
    try:
        session = Session()
        lease = _lease(expires_at=time.monotonic() + 60.0)
        session.lock_table.seed([lease])

        t1 = threading.Thread(
            target=mirror_session_leases, args=("p1", session), daemon=True
        )
        t1.start()
        assert mirror.entered.wait(timeout=5)  # t1 snapshotted {lease}, now gated

        # a later mutation + write-through: must queue behind t1, not overtake
        with session.write_mutex:
            session.lock_table.release("test-user", lease.token)
        t2 = threading.Thread(
            target=mirror_session_leases, args=("p1", session), daemon=True
        )
        t2.start()
        assert not mirror.gate.is_set()
        mirror.gate.set()
        t1.join(timeout=5)
        t2.join(timeout=5)
        assert not t1.is_alive() and not t2.is_alive()

        # in-order: the release's (empty) snapshot landed LAST — the mirror
        # ends holding truth, not the phantom
        assert [len(w) for w in mirror.writes] == [1, 0]
    finally:
        set_lease_mirror(None)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py::test_write_throughs_are_serialized_in_snapshot_order -v`
Expected: FAIL — without the mutex, t2's write runs through immediately while t1 is gated, so `writes == [[], [lease]]` → `[0, 1] != [1, 0]`. (Also fails on `AttributeError: mirror_mutex` — either failure mode is the point.)

- [ ] **Step 3: Add `Session.mirror_mutex` and take it in the helper**

In `src/data_rover/api/session.py`, add directly after the `lock_table` field:

```python
    #: serializes the lease-mirror write-through for THIS project (B-3):
    #: snapshot + mirror write happen atomically w.r.t. each other, so two
    #: racing write-throughs can no longer land out of order and leave a
    #: phantom lease in the mirror. Deliberately NOT write_mutex — the mirror
    #: does network I/O that must never sit inside a route's critical
    #: section. Ordering rule: only ever acquired when write_mutex is NOT
    #: held (mirror_session_leases is called after the mutating block
    #: exits), so mirror_mutex → write_mutex is the one legal nesting.
    mirror_mutex: threading.Lock = field(default_factory=threading.Lock, repr=False)
```

In `src/data_rover/api/lock_mirror.py`, replace `mirror_session_leases` with:

```python
def mirror_session_leases(project_id: str, session: Session) -> None:
    """Best-effort write-through: snapshot the live lease set and mirror it.

    Call AFTER the mutating ``with session.write_mutex:`` block has exited —
    ``session.mirror_mutex`` is acquired here, and its ordering contract is
    that it is never taken while ``write_mutex`` is held (see the field's
    docstring in session.py). The mutex pair does two jobs: ``write_mutex``
    is re-taken only briefly, for a coherent snapshot, so mirror I/O (a
    network round trip to Redis) never extends a lock route's or commit's
    critical section; ``mirror_mutex`` is held across snapshot AND write so
    two racing write-throughs land in snapshot order — the out-of-order
    phantom-lease window this helper used to document is gone.

    Never raises: a mirror failure must not fail a lock operation."""
    try:
        with session.mirror_mutex:
            mono_now = time.monotonic()
            with session.write_mutex:
                leases = session.lock_table.active_leases(mono_now)
            payload = to_mirrored(leases, mono_now=mono_now, wall_now=time.time())
            get_lease_mirror().write(project_id, payload)
    except Exception:
        logger.warning(
            "lease mirror write failed for project %s", project_id, exc_info=True
        )
```

In the module docstring (~lines 9–22), replace the sentence starting "Whole-set rewrite is idempotent and self-healing IN ONE DIRECTION" through "...deliberately deferred to a follow-up." with:

```
Whole-set
rewrite is idempotent and self-healing: a mirror that lagged truth during a
Redis outage re-converges on the next mutation, and the client renew
heartbeat guarantees one within ttl/2 for any lease still held. Write-throughs
for one project are serialized by ``Session.mirror_mutex`` (held across
snapshot AND write), so they land in snapshot order — two racing calls can
no longer leave the mirror holding a released lease. The one remaining
phantom window is an outage, not a race: a release whose write-through was
skipped during the Redis cooldown leaves the released lease mirrored until
the next mutation rewrites the set (or its own TTL expires); a restart
inside that window restores it, TTL-bounded.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py tests/api/test_locks_route.py tests/api/test_locking.py -v`
Expected: all PASS.

- [ ] **Step 5: Mark B-3 done in BACKLOG.md**

```markdown
### B-3 · Concurrent write-throughs can leave a phantom lease in the mirror · `done` (2026-08-12, fix/lease-mirror-hardening)
```

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/session.py src/data_rover/api/lock_mirror.py tests/api/test_lock_mirror.py BACKLOG.md
git commit -m "fix(api): serialize lease-mirror write-throughs per session (B-3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: B-4 — Deployment key-prefix for `dr:leases:*` keys

Two backends pointed at one Redis DB clobber each other's lease sets and cross-restore phantom leases for same-named projects (`default`). Fix: a `redis_key_prefix` setting prepended verbatim to the mirror's keys. Empty default keeps existing deployments reading their own mirrors across an upgrade.

**Files:**
- Modify: `src/data_rover/api/settings.py` (new field after `redis_url` ~line 91; amend `redis_url` docstring note (2))
- Modify: `src/data_rover/api/lock_mirror.py` (`lease_key` ~line 60; `build_mirror_from_settings` ~line 202)
- Modify: `src/data_rover/api/lock_mirror_redis.py` (constructor + `write`/`load` key computation; module-docstring data-model line ~line 21)
- Modify: `.env.example` (commented example after the `DATA_ROVER_REDIS_URL` line ~30)
- Modify: `BACKLOG.md` (B-4 → done)
- Test: `tests/api/test_lock_mirror.py`, `tests/api/test_lock_mirror_redis.py` (integration)

**Interfaces:**
- Produces: `Settings.redis_key_prefix: str = ""` (env `DATA_ROVER_REDIS_KEY_PREFIX`); `lease_key(project_id, *, prefix: str = "") -> str`; `RedisLeaseMirror(url, *, cooldown_s=30.0, socket_timeout_s=1.0, key_prefix: str = "")` with a `_key(project_id) -> str` helper.

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/test_lock_mirror.py` (import `lease_key` in the existing `from data_rover.api.lock_mirror import (...)` block):

```python
def test_lease_key_prefix() -> None:
    assert lease_key("p1") == "dr:leases:p1"
    assert lease_key("p1", prefix="site-a:") == "site-a:dr:leases:p1"


def test_build_from_settings_wires_key_prefix() -> None:
    from data_rover.api.lock_mirror_redis import RedisLeaseMirror

    s = Settings(redis_url="redis://127.0.0.1:1/0", redis_key_prefix="site-a:")
    mirror = build_mirror_from_settings(s)
    assert isinstance(mirror, RedisLeaseMirror)
    assert mirror._key("p1") == "site-a:dr:leases:p1"
```

Add to `tests/api/test_lock_mirror_redis.py` (integration; uses the existing `raw_redis` fixture and `_URL`):

```python
def test_key_prefix_namespaces_deployments(raw_redis) -> None:
    pid = f"it-{uuid.uuid4().hex[:8]}"
    a = RedisLeaseMirror(_URL, key_prefix="site-a:")
    b = RedisLeaseMirror(_URL, key_prefix="site-b:")
    lease = MirroredLease(
        resource_id="e1", mode="exclusive", holder="u1", token="tok1",
        intent="edit", expires_at_epoch=time.time() + 120.0,
    )
    try:
        a.write(pid, [lease])
        assert a.load(pid) == [lease]
        assert b.load(pid) == []  # site-b never sees site-a's leases
        assert raw_redis.get(lease_key(pid, prefix="site-a:")) is not None
        assert raw_redis.get(lease_key(pid)) is None  # unprefixed untouched
    finally:
        raw_redis.delete(lease_key(pid, prefix="site-a:"))
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v -k prefix`
Expected: FAIL — `lease_key() got an unexpected keyword argument 'prefix'` / `ValidationError: redis_key_prefix` (Settings rejects the unknown field).

- [ ] **Step 3: Implement the prefix**

`src/data_rover/api/settings.py` — add directly after `redis_url`:

```python
    #: Namespace prepended VERBATIM to every lease-mirror Redis key
    #: (``{prefix}dr:leases:{project_id}``), e.g. ``"site-a:"``. Set a
    #: distinct prefix per deployment when several backends share one Redis
    #: DB, so their lease sets can't clobber each other or cross-restore
    #: phantom leases for same-named projects (``default``). Empty (the
    #: default) keeps the historical unprefixed keys, so an existing
    #: deployment still finds its own mirror across an upgrade.
    redis_key_prefix: str = ""
```

In the `redis_url` docstring, replace the final clause of note (2) — `— give each deployment its own Redis DB or instance.` — with:

```
— set ``redis_key_prefix`` per deployment (or give each its own Redis DB
    #: or instance).
```

`src/data_rover/api/lock_mirror.py`:

```python
def lease_key(project_id: str, *, prefix: str = "") -> str:
    """``prefix`` is the deployment namespace (``settings.redis_key_prefix``),
    prepended verbatim; empty keeps the historical unprefixed key."""
    return prefix + _LEASE_KEY.format(project_id=project_id)
```

```python
def build_mirror_from_settings(settings: Settings) -> LeaseMirror:
    if not settings.redis_url:
        return NullLeaseMirror()
    from .lock_mirror_redis import RedisLeaseMirror

    return RedisLeaseMirror(settings.redis_url, key_prefix=settings.redis_key_prefix)
```

`src/data_rover/api/lock_mirror_redis.py` — constructor gains the kwarg and a `_key` helper; `write`/`load` go through it:

```python
    def __init__(
        self,
        url: str,
        *,
        cooldown_s: float = 30.0,
        socket_timeout_s: float = 1.0,
        key_prefix: str = "",
    ) -> None:
        ...existing body...
        self._key_prefix = key_prefix
```

```python
    def _key(self, project_id: str) -> str:
        return lease_key(project_id, prefix=self._key_prefix)
```

In `write`, replace `key = lease_key(project_id)` with `key = self._key(project_id)`; in `load`, replace `self._client.get(lease_key(project_id))` with `self._client.get(self._key(project_id))`.

Module docstring data-model line becomes:

```
Data model: one key per project (``dr:leases:{project_id}``, prepended by
the ``redis_key_prefix`` deployment namespace when set) holding a JSON
```

`.env.example` — after the `# DATA_ROVER_REDIS_URL=...` line add:

```
# Namespace prefix for the mirror's Redis keys — set a distinct value per
# deployment when several backends share one Redis DB.
# DATA_ROVER_REDIS_KEY_PREFIX=site-a:
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_lock_mirror.py -v`
Expected: all PASS. If the compose Redis is running (`pixi run services-start`), also run:
`pixi run -e core-dev pytest tests/api/test_lock_mirror_redis.py -v -m integration` — expected all PASS; if Redis isn't up the new test skips like its siblings.

- [ ] **Step 5: Mark B-4 done in BACKLOG.md**

```markdown
### B-4 · `dr:leases:{project_id}` has no deployment namespace · `done` (2026-08-12, fix/lease-mirror-hardening)
```

Also update the §11 Ideas bullet "**Key-prefix setting for the lease mirror** (see B-4)" — delete it (it is now shipped).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/settings.py src/data_rover/api/lock_mirror.py src/data_rover/api/lock_mirror_redis.py .env.example tests/api/test_lock_mirror.py tests/api/test_lock_mirror_redis.py BACKLOG.md
git commit -m "feat(api): deployment key-prefix for the lease mirror (B-4)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Full verification

**Files:** none new.

- [ ] **Step 1: Run the whole Python suite**

Run: `pixi run core-test`
Expected: everything passes (baseline on main was 1739 passed / 29 deselected; this branch adds ~10 tests).

- [ ] **Step 2: Lint/format/typecheck**

Run: `pixi run dr-tidy`
Expected: ruff, mypy AND pyright all clean. (Note: `test_build_from_settings_wires_key_prefix` touches the "private" `_key` — if pyright flags private usage in tests, the repo's existing tests already access `mirror._state_lock` the same way, so it should not.)

- [ ] **Step 3: If Redis is available, run the integration tests once**

Run: `pixi run services-start` (if not already up), then
`pixi run -e core-dev pytest tests/api/test_lock_mirror_redis.py -v -m integration`
Expected: 4 passed (3 pre-existing + the new prefix test). Skips cleanly if Redis is unreachable.

- [ ] **Step 4: Finish the branch**

Use the superpowers:finishing-a-development-branch skill (merge to `main` locally — this repo deliberately does not push to origin, see BACKLOG §10).

---

## Self-review notes

- **Spec coverage:** B-1 → Task 1; B-2 → Task 2; B-3 → Task 3; B-4 → Task 4. All four BACKLOG items get status flips in their own commits. ✓
- **Lock ordering (B-3):** all four production call sites of `mirror_session_leases` verified to run outside `write_mutex` (routes/locks.py three sites, routes/commits.py:1112 with an explicit comment, main.py:156 sweeper). `restore_leases` runs pre-serving inside the registry loader and takes no mutex — unaffected. ✓
- **B-2 zero-TTL guard:** `lock_ttl_seconds` is described as 0-disableable; the clamp treats a non-positive cap as "no cap" so a disabled TTL can never drop every restored lease. Conftest does not pin `DATA_ROVER_LOCK_TTL_SECONDS`, so existing tests see the 300s default — far above any test lease's 60–120s remaining, no behavior change. ✓
- **Backward compat (B-4):** empty prefix default → byte-identical keys; `MemoryLeaseMirror`/`NullLeaseMirror` key on project id and need no change. ✓
- **Type consistency:** `to_leases` keyword `max_remaining_s: float | None`; `lease_key(..., *, prefix: str = "")`; `RedisLeaseMirror(..., key_prefix: str = "")` — names used identically in tasks and tests. ✓
