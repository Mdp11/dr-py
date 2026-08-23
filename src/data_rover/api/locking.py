"""In-session resource leases — the pessimistic-locking primitive.

A lease is a TTL grant on one resource (element or relationship id). Leases
are held in the per-project ``Session`` (single-instance in-process;
write-through mirrored to Redis when configured — see lock_mirror.py) and
renewed by client heartbeat; the lifespan sweeper auto-releases expired
leases. ``acquire`` is all-or-nothing: either every requested lock is
granted under one token, or nothing is and the blocking leases are returned
as conflicts.

Conflict matrix. "Other holder" means a live lease whose ``holder``
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
per-op rules (delete -> subtree, connect -> source exclusive +
target shared pin); they live with the table because they share its types.
"""

from __future__ import annotations

import uuid
from collections.abc import Collection
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


#: Resource-id namespace. Elements and
#: relationships keep BARE ids — the pre-existing wire format the frontend's
#: lock badges key on — so only non-model resources carry a prefix. Element
#: ids are uuid-hex / user ids that never contain ':', so prefix collision
#: is not a practical concern; all writers go through the helpers below.
ARTIFACT_PREFIX = "art:"
#: view folders — a live member of the namespace: lock requests
#: accept `type: "folder"`, `folder_resource` mints the wire id, and
#: `expand_targets`/`required_locks` both derive folder leases (see below).
FOLDER_PREFIX = "folder:"
METAMODEL_RESOURCE = "mm"  # singleton — one metamodel binding per project


def artifact_resource(artifact_id: str) -> str:
    return ARTIFACT_PREFIX + artifact_id


def folder_resource(folder_id: str) -> str:
    return FOLDER_PREFIX + folder_id


def is_model_resource(resource_id: str) -> bool:
    """True for bare element/relationship ids — the resources whose leases
    gate model mutation (and rebind quiescence)."""
    return (
        not resource_id.startswith((ARTIFACT_PREFIX, FOLDER_PREFIX))
        and resource_id != METAMODEL_RESOURCE
    )


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
    #: Display name of the holder (their email). Carried alongside ``holder``
    #: purely so peers can render "Locked by <email>" without a user lookup;
    #: never participates in the conflict matrix (which keys on ``holder``).
    holder_email: str = ""


@dataclass
class LockConflict:
    resource_id: str
    held_by: str
    held_mode: LockMode
    #: Email of the current holder (see ``Lease.holder_email``); "" if unknown.
    held_by_email: str = ""


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

    def _conflict(
        self, req: RequiredLock, holder: str, now: float
    ) -> LockConflict | None:
        for le in self._live(req.resource_id, now):
            if le.holder == holder:
                continue
            if req.mode is LockMode.SHARED:
                continue  # shared pins never conflict on acquire
            if req.intent is LockIntent.DELETE:
                # delete needs the resource clear of everyone else (incl. pins)
                return LockConflict(
                    req.resource_id, le.holder, le.mode, le.holder_email
                )
            if le.mode is LockMode.EXCLUSIVE:
                return LockConflict(
                    req.resource_id, le.holder, le.mode, le.holder_email
                )
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
        holder_email: str = "",
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
                holder_email=holder_email,
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

    def peer_leases(
        self, resource_ids: Collection[str], holder: str, *, now: float
    ) -> list[Lease]:
        """Live leases on any of *resource_ids* held by SOMEONE OTHER than
        *holder*.

        The "is a peer mid-edit on this?" question, asked by the writers that
        are NOT themselves lock-verified: the legacy artifact CRUD routes
        (``PUT``/``DELETE /artifacts/{id}``) and the legacy unlocked
        ``POST /model/undo``. A lease is only a guarantee if EVERY writer to
        the resource honours it — a writer that ignores it turns a held lease
        into a silent lost update, with no error anywhere (the holder's own
        commit still verifies, applies and wins).

        The caller's OWN lease never blocks them: they are the editor the
        lease exists for, so locking them out of their own write path would
        make check-out actively harmful. Same holder-comparison rule as the
        conflict matrix above (identity, not mode).
        """
        wanted = set(resource_ids)
        return [
            le
            for le in self.active_leases(now)
            if le.resource_id in wanted and le.holder != holder
        ]

    def active_leases(self, now: float) -> list[Lease]:
        """Return all non-expired leases as a pure read — never mutates
        ``_by_resource``. Compaction is left to ``sweep_expired`` (which runs
        under the write_mutex); this method is called from ``evict`` (which
        also holds the mutex) and from the GET /locks route (no mutex needed
        since a pure read never writes back)."""
        return [
            le
            for leases in self._by_resource.values()
            for le in leases
            if le.expires_at > now
        ]

    def seed(self, leases: list[Lease]) -> None:
        """Bulk-install restored leases (hydration-time mirror restore ONLY).

        No conflict checking on purpose: the mirror holds a snapshot of a
        table that was internally consistent when written, and seeding runs
        inside the registry loader before the session serves any request —
        there is nothing to conflict with yet."""
        for le in leases:
            self._by_resource.setdefault(le.resource_id, []).append(le)


# --- lock-scope expansion --------------------------------------------------
# Imported lazily-ish at module scope: Model/View are core types (no cycle),
# the op union lives in schemas (no cycle back to locking). folder_subtree /
# locate_folder are called at RUNTIME (folder delete-expansion, move-folder's
# source-parent resolution), so they are real imports, not TYPE_CHECKING-only;
# Folder/VIEW_ROOT_ID are likewise needed at runtime by `_locate_container_id`.
from typing import TYPE_CHECKING  # noqa: E402

from data_rover.core.view.ids import folder_subtree, locate_folder  # noqa: E402
from data_rover.core.view.schema import VIEW_ROOT_ID, Folder  # noqa: E402

from .schemas import (  # noqa: E402
    TEMP_ID_PREFIX,
    CreateArtifactOp,
    CreateElementOp,
    CreateFolderOp,
    CreateRelationshipOp,
    DeleteArtifactOp,
    DeleteElementOp,
    DeleteFolderOp,
    DeleteRelationshipOp,
    MoveArtifactOp,
    MoveElementOp,
    MoveFolderOp,
    MoveMetamodelNodeOp,
    PlaceArtifactOp,
    PlaceElementOp,
    RebindMetamodelOp,
    RemoveArtifactOp,
    RemoveElementOp,
    RenameFolderOp,
    UpdateArtifactOp,
    UpdateElementOp,
    UpdateRelationshipOp,
)

if TYPE_CHECKING:
    from data_rover.core.model.model import Model
    from data_rover.core.view.schema import View

    from .schemas import OpIn


def containment_subtree(model: Model, root_id: str) -> list[str]:
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
    model: Model,
    view: View | None,
    targets: list[tuple[str, LockMode]],
    intent: LockIntent,
) -> list[RequiredLock]:
    """A lock request -> concrete RequiredLocks.

    A DELETE-intent exclusive target additionally locks its whole subtree:
    containment descendants for a model resource (via `containment_subtree`),
    or nested folders for a `folder:` resource (via `folder_subtree`)
    — so the cascade can't delete/reparent something another editor holds.
    `view` is consulted ONLY for the folder arm; a model-resource or
    artifact/metamodel target ignores it entirely (and a folder delete against
    a None/stale view degrades to a single-resource lock — `folder_subtree`
    is total, never raises)."""
    reqs: list[RequiredLock] = []
    seen: set[tuple[str, LockMode]] = set()

    def add(rid: str, mode: LockMode) -> None:
        if (rid, mode) not in seen:
            seen.add((rid, mode))
            reqs.append(RequiredLock(resource_id=rid, mode=mode, intent=intent))

    for rid, mode in targets:
        if intent is LockIntent.DELETE and mode is LockMode.EXCLUSIVE:
            if is_model_resource(rid):
                for member in containment_subtree(model, rid):
                    add(member, LockMode.EXCLUSIVE)
            elif rid.startswith(FOLDER_PREFIX):
                bare = rid.removeprefix(FOLDER_PREFIX)
                for member in folder_subtree(view, bare):
                    add(folder_resource(member), LockMode.EXCLUSIVE)
            else:
                add(rid, mode)
        else:
            add(rid, mode)
    return reqs


def _locate_container_id(node: View | Folder) -> str:
    """`locate_folder`'s parent node -> a lock-addressable resource id (bare,
    the `folder:` prefix is applied by the caller). The view itself IS the
    root, addressed by the reserved `VIEW_ROOT_ID`; any other node is a real
    `Folder`, addressed by its own id."""
    if isinstance(node, Folder):
        return node.id
    return VIEW_ROOT_ID


def required_locks(
    model: Model, view: View | None, ops: list[OpIn]
) -> list[RequiredLock]:
    """The locks an op batch needs, computed against the PRE-apply model
    (and, for folder ops, the pre-apply view).

    Ids created earlier in the same batch (temp ids) are not yet shared, so
    they require no lock; relationships are locked via their source element.

    Folder ops: `create_folder` locks its PARENT (CREATE_CHILD, so a
    peer creating a sibling and a peer deleting the parent both get caught);
    `rename_folder`/single-folder placement ops lock the folder/containing
    folder itself (EDIT); `delete_folder` expands over the whole subtree
    (DELETE, mirrors `DeleteElementOp`); `move_folder`/move-element/
    move-artifact lock BOTH endpoints (EDIT) since the op moves membership
    between them. `move_folder`'s SOURCE parent is not named by the op at
    all — only the destination is — so it is resolved by walking the CURRENT
    `view` via `locate_folder`. A missing view or unknown folder id skips
    that half silently rather than raising: the op will 422 at apply time
    regardless (the applier re-derives the same thing against the same
    view), and lock derivation must stay total so a stale/malformed op can
    never crash the lock-verification step itself.

    Dedup key is ``(rid, mode, intent)``, not just ``(rid, mode)``: a folder
    can legitimately need TWO distinct locks in the same batch — e.g.
    creating a child under it (CREATE_CHILD) and renaming it (EDIT) — and
    ``verify_held`` checks each required lock independently, so collapsing
    them would silently drop one of two genuinely-required leases."""
    reqs: list[RequiredLock] = []
    seen: set[tuple[str, LockMode, LockIntent]] = set()
    created: set[str] = set()

    def add(rid: str, mode: LockMode, intent: LockIntent) -> None:
        if rid.startswith(TEMP_ID_PREFIX) or rid in created:
            return
        if (rid, mode, intent) not in seen:
            seen.add((rid, mode, intent))
            reqs.append(RequiredLock(resource_id=rid, mode=mode, intent=intent))

    def rel_source(rel_id: str) -> str | None:
        rel = model.relationships.get(rel_id)
        return rel.source_id if rel is not None else None

    for op in ops:
        if isinstance(op, CreateElementOp):
            created.add(op.temp_id)
        elif isinstance(op, CreateRelationshipOp):
            created.add(op.temp_id)
            add(op.source_id, LockMode.EXCLUSIVE, LockIntent.CONNECT)
            add(op.target_id, LockMode.SHARED, LockIntent.CONNECT)
        elif isinstance(op, UpdateElementOp):
            add(op.id, LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, DeleteElementOp):
            for member in containment_subtree(model, op.id):
                add(member, LockMode.EXCLUSIVE, LockIntent.DELETE)
        elif isinstance(op, UpdateRelationshipOp):
            src = rel_source(op.id)
            if src is not None:
                add(src, LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, DeleteRelationshipOp):
            src = rel_source(op.id)
            if src is not None:
                add(src, LockMode.EXCLUSIVE, LockIntent.DELETE)
        elif isinstance(op, CreateArtifactOp):
            # namespaced, to match what the update/delete branches derive
            # below for the SAME temp id (bare op.temp_id would never match
            # "art:" + op.id, leaving a same-batch update/delete-by-temp-id
            # stuck requiring a lease on a resource no one can ever hold).
            created.add(artifact_resource(op.temp_id))
        elif isinstance(op, UpdateArtifactOp):
            add(artifact_resource(op.id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, DeleteArtifactOp):
            add(artifact_resource(op.id), LockMode.EXCLUSIVE, LockIntent.DELETE)
        elif isinstance(op, CreateFolderOp):
            created.add(folder_resource(op.temp_id))
            add(
                folder_resource(op.parent_id),
                LockMode.EXCLUSIVE,
                LockIntent.CREATE_CHILD,
            )
        elif isinstance(op, RenameFolderOp):
            add(folder_resource(op.id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, MoveFolderOp):
            if view is not None:
                located = locate_folder(view, op.id)
                if located is not None:
                    add(
                        folder_resource(_locate_container_id(located[0])),
                        LockMode.EXCLUSIVE,
                        LockIntent.EDIT,
                    )
            add(folder_resource(op.to_parent_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, DeleteFolderOp):
            for member in folder_subtree(view, op.id):
                add(folder_resource(member), LockMode.EXCLUSIVE, LockIntent.DELETE)
        elif isinstance(op, (PlaceElementOp, RemoveElementOp)):
            add(folder_resource(op.folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, MoveElementOp):
            add(folder_resource(op.from_folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
            add(folder_resource(op.to_folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, (PlaceArtifactOp, RemoveArtifactOp)):
            add(folder_resource(op.folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, MoveArtifactOp):
            add(folder_resource(op.from_folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
            add(folder_resource(op.to_folder_id), LockMode.EXCLUSIVE, LockIntent.EDIT)
        elif isinstance(op, (RebindMetamodelOp, MoveMetamodelNodeOp)):
            # The whole family serializes on the singleton `mm` lease: a
            # rebind rewrites what every node/key MEANS, so per-node layout
            # granularity could never change an outcome — and the diagram +
            # YAML editor already share one surface lease.
            add(METAMODEL_RESOURCE, LockMode.EXCLUSIVE, LockIntent.EDIT)
    return reqs
