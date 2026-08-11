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
    # lock_mirror_redis.py lands in a later task (Phase 7 Task 4); the module
    # does not exist yet, so both type checkers are told this deliberately —
    # the branch is unreachable in any checkout today (redis_url unset).
    from .lock_mirror_redis import (  # type: ignore[import-not-found]  # pyright: ignore[reportMissingImports]
        RedisLeaseMirror,
    )

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
        leases = to_leases(mirrored, mono_now=time.monotonic(), wall_now=time.time())
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
