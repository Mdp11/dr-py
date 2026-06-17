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
from dataclasses import dataclass
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
