"""Write-through lease mirror (Phase 7, scoped): leases survive a backend
restart and are observable from outside the process (redis-cli).

``LockTable`` (locking.py) stays the ONLY authority for conflict decisions;
the mirror never participates in one. After each successful lease mutation the
caller mirrors the project's ENTIRE live lease set wholesale
(:func:`mirror_session_leases`); on session hydration the fresh table is
seeded back (:func:`restore_leases`) with the ORIGINAL tokens, so a client
that outlived the restart keeps renewing the token it already holds. Whole-set
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

Clock mapping: ``Lease.expires_at`` is ``time.monotonic()`` — meaningless
across processes. Conversion to/from wall clock (``time.time()``) happens in
:func:`to_mirrored` / :func:`to_leases` and nowhere else; on restore the
remaining lifetime is additionally clamped to ``lock_ttl_seconds`` so a
backward wall-clock jump between write and restore cannot mint a lease that
outlives the TTL it was granted with.

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


def lease_key(project_id: str, *, prefix: str = "") -> str:
    """``prefix`` is the deployment namespace (``settings.redis_key_prefix``),
    prepended verbatim; empty keeps the historical unprefixed key."""
    return prefix + _LEASE_KEY.format(project_id=project_id)


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


_mirror: LeaseMirror | None = None


def get_lease_mirror() -> LeaseMirror:
    """Process-global mirror, built from settings on first use.

    A build failure (bad ``redis_url`` scheme, unimportable ``redis``) is
    memoized as a permanent fallback to :class:`NullLeaseMirror` rather than
    retried on the next call: every lock acquire/release/renew, every commit
    release and every cold hydration calls in here, so an unmemoized failure
    would re-attempt (and re-log) the same broken construction on every one
    of those forever — degraded-but-quiet is the goal, not a warning-log
    firehose. The stickiness lives in ``_mirror`` itself (bound to the Null
    instance) rather than a separate "already failed" flag, so
    :func:`set_lease_mirror`\\ (None) — the test reset — is still free to
    force a rebuild attempt on the next call."""
    global _mirror
    if _mirror is None:
        from .settings import get_settings

        try:
            _mirror = build_mirror_from_settings(get_settings())
        except Exception:
            logger.warning(
                "lease mirror: failed to build from settings, "
                "falling back to no-op mirror for the rest of this process",
                exc_info=True,
            )
            _mirror = NullLeaseMirror()
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

    return RedisLeaseMirror(settings.redis_url, key_prefix=settings.redis_key_prefix)


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
        from .settings import get_settings

        leases = to_leases(
            mirrored,
            mono_now=time.monotonic(),
            wall_now=time.time(),
            max_remaining_s=float(get_settings().lock_ttl_seconds),
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
