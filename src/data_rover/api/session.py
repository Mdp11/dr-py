from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.view.schema import View

from .feed import FeedHub, reset_event
from .locking import LockTable
from .state_digest import digest_value, fold_batch, format_digest

if TYPE_CHECKING:
    from .routes.ops import _BatchResult
    from .snapshot_job import SnapshotJob


@dataclass
class Session:
    metamodel: Metamodel | None = None
    model: Model | None = None
    #: every view of the project by row id — complete after hydration (a
    #: cold session hydrates ALL rows), mutated only by POST/DELETE /views
    #: and the view half of the commit/revert paths, all under write_mutex.
    views: dict[str, View] = field(default_factory=dict)
    #: revision counter of the session model: bumped on every accepted commit
    #: and on every model replace. Clients echo it as
    #: ``base_rev`` so stale op batches are rejected with 409.
    model_rev: int = 0
    #: serializes commit-persist and eviction for THIS project. An RLock so
    #: the ops path can take it around a block that also calls helpers which
    #: assume it is held; its role spans preview/commit as well as
    #: apply+persist vs evict.
    write_mutex: threading.RLock = field(default_factory=threading.RLock, repr=False)
    #: monotonic timestamp of the last registry access; the idle sweeper
    #: evicts sessions whose last_access is older than the TTL.
    last_access: float = field(default_factory=time.monotonic, repr=False)
    #: per-project resource leases for check-out/commit. In-session, and
    #: write-through mirrored to Redis when configured (see lock_mirror.py).
    #: Swept of expired leases by the
    #: lifespan sweeper; consulted by the commit route (lock verification) and
    #: by ``SessionRegistry.evict`` (never evict a session with live leases).
    lock_table: LockTable = field(default_factory=LockTable, repr=False)
    #: serializes the lease-mirror write-through for THIS project:
    #: snapshot + mirror write happen atomically w.r.t. each other, so two
    #: racing write-throughs can no longer land out of order and leave a
    #: phantom lease in the mirror. Deliberately NOT write_mutex — the mirror
    #: does network I/O that must never sit inside a route's critical
    #: section. Ordering rule: only ever acquired when write_mutex is NOT
    #: held (mirror_session_leases is called after the mutating block
    #: exits), so mirror_mutex → write_mutex is the one legal nesting.
    mirror_mutex: threading.Lock = field(default_factory=threading.Lock, repr=False)
    #: per-project realtime feed subscribers. Populated by the WS
    #: endpoint; broadcast to at the commit/lock sites. The eviction guard
    #: refuses to drop a session while it has connected clients.
    hub: FeedHub = field(default_factory=FeedHub, repr=False)
    #: per-project strict-mode policy (strict-mode feature). When True the
    #: commit path promotes scoped CONFORMANCE issues to a hard 422 reject.
    #: Loaded from ModelRow.validation_policy during hydration; flipped by the
    #: owner-gated PATCH /settings route under the write-mutex. Default False
    #: keeps the engine's inspectable behaviour for every untouched project.
    strict_mode: bool = False
    #: the in-flight (or last) periodic snapshot job
    #: (snapshot_job.schedule_periodic_snapshot); a trigger that finds one
    #: still running is dropped. Never blocks eviction: the job checks the
    #: registry under write_mutex and writes nothing for a dropped session.
    snapshot_job: SnapshotJob | None = field(default=None, repr=False)
    #: the state digest of ``model`` (``state_digest.py``) as an integer, or
    #: None while it is not known: on a fresh or hydrated session, and after
    #: ``set_model``. A landed batch folds into it in
    #: O(batch); a batch that is rolled back needs nothing, the rollback being
    #: exact. Read and written under ``write_mutex``.
    state_digest_value: int | None = field(default=None, repr=False)

    def state_digest(self) -> str:
        """The digest as the wire carries it, recomputed in one O(model) pass
        when it is not known. Call under ``write_mutex``."""
        if self.state_digest_value is None:
            self.state_digest_value = (
                digest_value(self.model) if self.model is not None else 0
            )
        return format_digest(self.state_digest_value)

    def advance_state_digest(self, res: _BatchResult) -> str:
        """Take a batch that has just landed on ``model`` into the digest and
        return it. A caller that may still take the batch back keeps
        ``state_digest_value`` from before the call and restores it then."""
        if self.state_digest_value is not None and self.model is not None:
            self.state_digest_value = fold_batch(
                self.state_digest_value, self.model, res
            )
        return self.state_digest()

    def announce_reset(self) -> None:
        """Broadcast a ``reset`` for the current ``model_rev``: the rev moved
        without a journal row, so a replica has no delta to follow."""
        self.hub.broadcast(reset_event(model_rev=self.model_rev))

    def set_model(self, model: Model | None, *, announce: bool = True) -> None:
        """Replace (or clear) the model; the rev moves and the digest is
        recomputed on next use.

        ``announce=False`` is for a caller that writes durable state after the
        swap and calls ``announce_reset()`` once it has: a replica told
        earlier would open from the rows the caller is about to replace.
        """
        self.model = model
        # views are intentionally untouched on model replacement
        self.model_rev += 1
        self.state_digest_value = None
        if announce:
            self.announce_reset()

    def set_metamodel(
        self, metamodel: Metamodel | None, *, announce: bool = True
    ) -> None:
        """Replace (or clear) the metamodel; the model conforms to it, so the
        model is cleared too."""
        self.metamodel = metamodel
        self.set_model(None, announce=announce)


#: Project id for the no-request-context ``get_session()`` (internal/test
#: callers, and the dev seed). Request-scoped routes resolve ``project_id`` from
#: the ``/api/v1/projects/{project_id}`` URL path instead — there is no implicit
#: header fallback.
DEFAULT_PROJECT_ID = "default"


class SessionRegistry:
    """Holds one live :class:`Session` per project id, hydrated on first access.

    On a cache-miss ``get`` calls the injected ``loader`` (``hydration.
    hydrate_session`` in production) under a per-project init-once lock so
    two concurrent requests for a cold project hydrate exactly once.
    ``evict`` runs the injected ``evict_hook`` (snapshot-then-drop) before
    removing the session. With no loader installed the registry falls back
    to an empty ``Session``, used by unit tests that don't need
    persistence."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._loader: Callable[[str], Session] | None = None
        self._evict_hook: Callable[[str, Session], None] | None = None
        self._guard = threading.Lock()  # protects _sessions + per-key locks
        self._key_locks: dict[str, threading.Lock] = {}

    def set_loader(self, loader: Callable[[str], Session] | None) -> None:
        self._loader = loader

    def set_evict_hook(self, hook: Callable[[str, Session], None] | None) -> None:
        self._evict_hook = hook

    def get(self, project_id: str) -> Session:
        # fast path: already warm
        with self._guard:
            session = self._sessions.get(project_id)
            if session is not None:
                session.last_access = time.monotonic()
                return session
            key_lock = self._key_locks.setdefault(project_id, threading.Lock())
        # hydrate outside the global guard, but serialized per project id so a
        # cold project is built exactly once (init-once guard).
        with key_lock:
            with self._guard:
                session = self._sessions.get(project_id)
                if session is not None:
                    session.last_access = time.monotonic()
                    return session
            session = self._loader(project_id) if self._loader else Session()
            session.last_access = time.monotonic()
            with self._guard:
                self._sessions[project_id] = session
            return session

    def peek(self, project_id: str) -> Session | None:
        """The warm session, or None — NEVER hydrates and does not refresh
        ``last_access`` (the status poller must not keep a session alive nor
        trigger a hydration the caller isn't prepared to wait for)."""
        with self._guard:
            return self._sessions.get(project_id)

    def evict(self, project_id: str) -> None:
        # Peek (do NOT pop) under the guard so the session stays registered
        # while we inspect it. Popping first would open a window where a
        # concurrent get() could hydrate a second session and then lose
        # either the new or the re-registered live-leased session when we
        # re-inserted.
        with self._guard:
            session = self._sessions.get(project_id)
        if session is None:
            return
        # Serialise vs an in-flight commit (evict-during-commit guard).
        with session.write_mutex:
            if session.lock_table.active_leases(time.monotonic()) or (
                session.hub.has_clients()
            ):
                # A holder still has a check-out open, or a feed client is
                # connected. The session was never removed, so it stays
                # registered — no re-insert needed.
                return
            if self._evict_hook is not None:
                self._evict_hook(project_id, session)
            # Remove only after the snapshot hook completes, and only when we
            # are certain no live leases exist. Taking _guard here (after
            # write_mutex) never conflicts: get() takes _guard only (never
            # write_mutex), so there is no nested lock ordering that can
            # deadlock with the get() path.
            with self._guard:
                self._sessions.pop(project_id, None)

    def discard(self, project_id: str) -> None:
        """Drop a session WITHOUT snapshotting and WITHOUT the evict guard.

        For the delete-project path: by the time the registry is asked to
        drop the session, the project's durable rows are already deleted and
        committed, so the snapshot hook must not run — ``write_snapshot``
        would insert a ``Snapshot`` row whose project FK no longer exists
        (IntegrityError -> 500 *after* the delete succeeded). The evict
        guard must not apply either: a live lease or a connected feed client
        would otherwise keep a dead project's session registered forever
        (the guard re-checks on every idle-sweep retry and never gives up).

        Feed clients of a deleted project are deliberately left to die on
        their own: the orphaned session's hub simply never broadcasts again,
        the socket closes on client disconnect, and a reconnect gets 4404
        because the project row is gone.

        Takes ``write_mutex`` to serialise against an in-flight commit
        (same rationale — and same lock ordering vs ``_guard`` — as
        ``evict``)."""
        with self._guard:
            session = self._sessions.get(project_id)
        if session is None:
            return
        with session.write_mutex:
            with self._guard:
                self._sessions.pop(project_id, None)

    def touch(self, project_id: str) -> None:
        with self._guard:
            session = self._sessions.get(project_id)
            if session is not None:
                session.last_access = time.monotonic()

    def idle(self, now: float, ttl: float) -> list[str]:
        with self._guard:
            return [
                pid for pid, s in self._sessions.items() if now - s.last_access >= ttl
            ]

    def reset(self) -> None:
        with self._guard:
            self._sessions.clear()
            self._key_locks.clear()

    def project_ids(self) -> list[str]:
        with self._guard:
            return list(self._sessions)

    def warm_items(self) -> list[tuple[str, Session]]:
        """Snapshot of currently-warm (project_id, session) pairs WITHOUT
        refreshing last_access or hydrating cold projects — for the lock
        sweeper, which must not keep sessions alive or resurrect evicted ones."""
        with self._guard:
            return list(self._sessions.items())


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

    Replaces sessions by identity: a caller holding a reference to a
    pre-reset ``Session`` keeps seeing the old object and must call
    ``get_session()`` again for the live one. All current callers
    (request-scoped ``Depends``; tests that reset then re-fetch) already
    re-fetch, so this is safe.
    """
    _registry.reset()


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
        # Re-install still-live mirrored leases so tokens survive a restart.
        # Best-effort — a mirror failure is a cold start.
        restore_leases(project_id, sess.lock_table)
        return sess

    def _evict(project_id: str, sess: Session) -> None:
        if sess.model is not None:
            write_snapshot(project_id, sess, sess.model_rev)

    _registry.set_loader(_load)
    _registry.set_evict_hook(_evict)
