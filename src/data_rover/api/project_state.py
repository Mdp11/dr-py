"""The per-project state the server keeps in memory, and the registry that holds it.

A project's content lives in the database (head rows, the journal, snapshots);
the process keeps only what has no durable home or is read on every request:
the metamodel it is bound to, its views, the revision, the strict-mode policy,
and the three pieces of live coordination state (leases, feed subscribers, the
write mutex). It holds no model: a request that needs entities reads the rows
it needs (``commit_load``).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

from fastapi import Depends

from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.view.ids import ensure_folder_ids
from data_rover.core.view.schema import View

from . import content
from .authz import require_membership
from .db import db_session
from .db_models import Membership
from .feed import FeedHub, reset_event
from .lock_mirror import restore_leases
from .locking import LockTable

#: Project id for callers with no request context (the dev seed, tests).
#: Request-scoped routes take ``project_id`` from the URL path.
DEFAULT_PROJECT_ID = "default"


@dataclass
class ProjectState:
    project_id: str
    #: the metamodel the project's model row points at; None for a project that
    #: has none yet. Frozen once loaded: a rebind replaces it, never edits it.
    metamodel: Metamodel | None = None
    #: every view of the project by row id, loaded with the project, mutated
    #: only by the view routes and the view half of the commit and revert
    #: paths, all under ``write_mutex``.
    views: dict[str, View] = field(default_factory=dict)
    #: ``ModelRow.model_rev``, moved only by the paths that write it, under
    #: ``write_mutex``: a commit, a revert, a metamodel upload. Clients echo it
    #: as ``base_rev``.
    model_rev: int = 0
    #: the project's strict-mode policy (``ModelRow.validation_policy``): when
    #: True the commit path promotes scoped conformance issues to a hard 422.
    #: Flipped by the owner-gated PATCH /settings route under ``write_mutex``.
    strict_mode: bool = False
    #: serializes commit, revert, lock, view and settings writes for THIS
    #: project and eviction. An RLock so a block can call helpers that assume
    #: it is held.
    write_mutex: threading.RLock = field(default_factory=threading.RLock, repr=False)
    #: the project's check-out leases. In-process, written through to the lease
    #: mirror when one is configured (``lock_mirror``); consulted by the commit
    #: route and by eviction, which never drops a state with live leases.
    lock_table: LockTable = field(default_factory=LockTable, repr=False)
    #: serializes the lease-mirror write-through for THIS project, so racing
    #: write-throughs cannot land out of order and leave a released lease in the
    #: mirror. Deliberately not ``write_mutex``: the mirror does network I/O
    #: that must never sit inside a route's critical section. Only acquired
    #: while ``write_mutex`` is NOT held, so mirror_mutex then write_mutex is
    #: the one legal nesting.
    mirror_mutex: threading.Lock = field(default_factory=threading.Lock, repr=False)
    #: the project's realtime feed subscribers; eviction refuses while any is
    #: connected.
    hub: FeedHub = field(default_factory=FeedHub, repr=False)
    #: ``time.monotonic()`` of the last registry access; the idle sweeper
    #: evicts a state whose ``last_access`` is older than the TTL.
    last_access: float = field(default_factory=time.monotonic, repr=False)

    def announce_reset(self) -> None:
        """Broadcast a ``reset`` for the current ``model_rev``: the rev moved
        without a journal row, so a replica has no delta to follow."""
        self.hub.broadcast(reset_event(model_rev=self.model_rev))


def _load(project_id: str) -> ProjectState:
    """Read the project's state from the database and the lease mirror. Never
    reads a head row. A project with no model row has no metamodel and rev 0;
    one whose head rows were never written (a database from before them) loads
    like any other, and answers its own errors where rows are needed."""
    state = ProjectState(project_id=project_id)
    blob: str | None = None
    with db_session() as s:
        model_row = content.get_model_row(s, project_id)
        if model_row is not None:
            mm_row = content.get_metamodel_row(s, model_row.metamodel_id)
            assert mm_row is not None  # FK guarantees it
            blob = mm_row.blob
            state.model_rev = model_row.model_rev
            state.strict_mode = bool(
                (model_row.validation_policy or {}).get("strict", False)
            )
        for view_row in content.list_views(s, project_id):
            view = View.model_validate_json(view_row.blob)
            if ensure_folder_ids(view):
                # a blob missing folder ids gets them exactly once;
                # normalization is not an edit
                content.upsert_view(
                    s,
                    project_id,
                    view_row.id,
                    blob=view.model_dump_json(),
                    bump_rev=False,
                )
            state.views[view_row.id] = view
    if blob is not None:
        state.metamodel = load_metamodel_str(blob)
    # still-live mirrored leases keep their tokens across a restart or an
    # eviction; best-effort, a mirror failure is a cold start
    restore_leases(project_id, state.lock_table)
    return state


class ProjectStateRegistry:
    """One live :class:`ProjectState` per project id, loaded on first access.

    ``get`` loads under a per-project init-once lock, so two concurrent
    requests for a cold project load it exactly once and share the result."""

    def __init__(self) -> None:
        self._states: dict[str, ProjectState] = {}
        self._guard = threading.Lock()  # protects _states and _key_locks
        self._key_locks: dict[str, threading.Lock] = {}

    def get(self, project_id: str) -> ProjectState:
        with self._guard:
            state = self._states.get(project_id)
            if state is not None:
                state.last_access = time.monotonic()
                return state
            key_lock = self._key_locks.setdefault(project_id, threading.Lock())
        # load outside the global guard, serialized per project id
        with key_lock:
            with self._guard:
                state = self._states.get(project_id)
                if state is not None:
                    state.last_access = time.monotonic()
                    return state
            state = _load(project_id)
            state.last_access = time.monotonic()
            with self._guard:
                self._states[project_id] = state
            return state

    def peek(self, project_id: str) -> ProjectState | None:
        """The warm state, or None. Never loads and does not refresh
        ``last_access``."""
        with self._guard:
            return self._states.get(project_id)

    def evict(
        self,
        project_id: str,
        *,
        now: float | None = None,
        ttl: float | None = None,
    ) -> bool:
        """Drop the state, writing nothing: whether it was dropped.

        Refused while a lease is live or a feed client is connected. With
        ``now`` and ``ttl``, also refused when the state was used within
        ``ttl`` of ``now``: a request that got the state after the sweeper
        listed it as idle keeps it, so no request is left holding a state the
        registry no longer serves.

        The state is peeked, not popped, while it is inspected, so a concurrent
        ``get`` cannot load a second one. Takes ``write_mutex`` to serialize
        against an in-flight commit; ``get`` takes only the guard, so the order
        write_mutex then guard cannot deadlock with it."""
        with self._guard:
            state = self._states.get(project_id)
        if state is None:
            return False
        with state.write_mutex:
            if state.lock_table.active_leases(time.monotonic()):
                return False
            if state.hub.has_clients():
                return False
            with self._guard:
                if (
                    now is not None
                    and ttl is not None
                    and now - state.last_access < ttl
                ):
                    return False
                if self._states.get(project_id) is state:
                    del self._states[project_id]
        return True

    def discard(self, project_id: str) -> None:
        """Drop the state without the evict guard: for the delete-project path,
        where a live lease or a connected feed client must not keep a dead
        project's state registered forever. Feed clients of a deleted project
        are left to die on their own: the orphaned hub never broadcasts again
        and a reconnect gets 4404.

        Takes ``write_mutex`` to serialize against an in-flight commit."""
        with self._guard:
            state = self._states.get(project_id)
        if state is None:
            return
        with state.write_mutex:
            with self._guard:
                if self._states.get(project_id) is state:
                    del self._states[project_id]

    def idle(self, now: float, ttl: float) -> list[str]:
        with self._guard:
            return [
                pid for pid, s in self._states.items() if now - s.last_access >= ttl
            ]

    def reset(self) -> None:
        with self._guard:
            self._states.clear()
            self._key_locks.clear()

    def project_ids(self) -> list[str]:
        with self._guard:
            return list(self._states)

    def warm_items(self) -> list[tuple[str, ProjectState]]:
        """The warm (project_id, state) pairs, without refreshing
        ``last_access`` or loading a cold project: for the lock sweeper, which
        must not keep a state alive or resurrect an evicted one."""
        with self._guard:
            return list(self._states.items())


_registry = ProjectStateRegistry()


def get_registry() -> ProjectStateRegistry:
    """The process-wide registry."""
    return _registry


def get_project_state(
    project_id: str,
    _membership: Membership = Depends(require_membership),
) -> ProjectState:
    """The live state of the path's project.

    ``require_membership`` runs first (it resolves the identity and the DB and
    checks that the project exists and the caller is a member with a sufficient
    role), so by the time the registry is touched the access is authorized:
    unknown project 404, non-member 403, viewer writing 403."""
    return _registry.get(project_id)
