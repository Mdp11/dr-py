from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.validation.state import ValidationState
from data_rover.core.view.schema import View

from .feed import FeedHub
from .locking import LockTable

if TYPE_CHECKING:
    from .schemas import OpIn
    from .validation_sweep import SweepProgress

#: Maximum number of applied batches retained for undo. Each batch holds the
#: ops, their inverses, and snapshots of deleted entities' properties, so an
#: unbounded log would grow without limit over a long editing session; 1000
#: undo steps is far more history than any UI exposes. Oldest batches are
#: dropped first. Note the cap counts BATCHES, not bytes: a single batch's
#: inverses can still be large (a cascade delete snapshots every removed
#: entity), so memory is bounded per-entry only in the typical small-batch
#: case — an accepted tradeoff for a trivial trimming rule.
OP_LOG_MAX = 1000


@dataclass
class AppliedBatch:
    """One accepted ops batch: what was applied and how to undo it.

    ``ops`` are the applied ops in canonical form (temp ids resolved to the
    generated canonical ids, both in op ids and inside reference property
    values). ``inverse_ops`` use the SAME op format and are stored in
    execution order (already reversed relative to ``ops``), so undo is
    exactly "apply ``inverse_ops`` front to back" through the restore-mode
    applier. ``id_map`` is the temp-id resolution the batch produced.
    """

    ops: "list[OpIn]"
    inverse_ops: "list[OpIn]"
    id_map: dict[str, str]


@dataclass
class Session:
    metamodel: Metamodel | None = None
    model: Model | None = None
    view: View | None = None
    #: issue store seeded by the last FULL validation of `model`; incremental
    #: paths (Phase C) delta from it via ValidationState.replace
    validation: ValidationState | None = None
    #: revision counter of the session model: bumped on every accepted ops
    #: batch / undo and on every model load-replace. Clients echo it as
    #: ``base_rev`` so stale op batches are rejected with 409.
    model_rev: int = 0
    #: applied-batch history for POST /model/undo, newest last; cleared
    #: whenever the model is replaced, capped at OP_LOG_MAX
    op_log: "list[AppliedBatch]" = field(default_factory=list)
    #: number of batches trimmed off ``op_log`` because OP_LOG_MAX was
    #: exceeded since the current model was loaded. While this is non-zero
    #: the retained log no longer reaches back to the loaded base state, so
    #: GET /model/changes reports ``complete: false``. Reset together with
    #: ``op_log`` (model replacement / out-of-protocol mutation).
    op_log_dropped: int = 0
    #: serializes commit-persist and eviction for THIS project (spec §11
    #: write-mutex). An RLock so the ops path can take it around a block that
    #: also calls helpers which assume it is held. Phase 4 widens its role
    #: (preview/commit); Phase 3 only guards "apply+persist" vs "evict".
    write_mutex: threading.RLock = field(default_factory=threading.RLock, repr=False)
    #: monotonic timestamp of the last registry access; the idle sweeper
    #: (Task 11) evicts sessions whose last_access is older than the TTL.
    last_access: float = field(default_factory=time.monotonic, repr=False)
    #: per-project resource leases (Phase 4 check-out/commit). In-session only
    #: this phase (Redis mirroring is Phase 7). Swept of expired leases by the
    #: lifespan sweeper; consulted by the commit route (lock verification) and
    #: by ``SessionRegistry.evict`` (never evict a session with live leases).
    lock_table: LockTable = field(default_factory=LockTable, repr=False)
    #: per-project realtime feed subscribers (Phase 5). Populated by the WS
    #: endpoint; broadcast to at the commit/lock sites. The eviction guard
    #: refuses to drop a session while it has connected clients.
    hub: FeedHub = field(default_factory=FeedHub, repr=False)
    #: per-project strict-mode policy (strict-mode feature). When True the
    #: commit path promotes scoped CONFORMANCE issues to a hard 422 reject.
    #: Loaded from ModelRow.validation_policy during hydration; flipped by the
    #: owner-gated PATCH /settings route under the write-mutex. Default False
    #: keeps the engine's inspectable behaviour for every untouched project.
    strict_mode: bool = False
    #: progress of the in-flight background validation sweep (spec: interactive
    #: -path hardening §3), installed by validation_sweep.start_validation_sweep;
    #: stays set after completion (running=False) so /model/status can report
    #: "ready". Replaced wholesale by the next sweep.
    validation_sweep: "SweepProgress | None" = field(default=None, repr=False)

    def set_model(
        self, model: Model | None, *, validation: ValidationState | None = None
    ) -> None:
        """Replace (or clear) the model and invalidate model-derived state.

        ``validation``: callers that already computed a fresh/spliced
        ``ValidationState`` for the NEW model (the C3 load endpoints seed at
        load time; session-mode apply-cr splices the CR's dirty set) pass it
        here so it is installed in the same step instead of cleared.
        """
        self.model = model
        # view is intentionally untouched on model replacement
        # previous full-run baseline is stale unless the caller replaced it
        self.validation = validation
        self.op_log.clear()  # recorded inverses no longer apply to this model
        self.op_log_dropped = 0
        self.model_rev += 1

    def touch_model(self) -> None:
        """Call when the model is mutated outside the ops protocol.

        Legacy mutation routes (POST/PATCH/DELETE on /model/elements and
        /model/relationships) change the model without producing an op-log
        entry, so every coherence artifact of the ops protocol is stale
        afterwards: bump ``model_rev`` (in-flight batches with the old
        ``base_rev`` get 409), clear ``op_log`` (recorded inverses would
        replay against a diverged model), and drop the validation baseline.
        """
        self.model_rev += 1
        self.op_log.clear()
        self.op_log_dropped = 0
        self.validation = None

    def set_metamodel(self, metamodel: Metamodel | None) -> None:
        """Replace (or clear) the metamodel; the model conforms to it, so the
        model and its validation baseline are cleared too."""
        self.metamodel = metamodel
        self.set_model(None)

    def record_batch(self, batch: AppliedBatch) -> None:
        """Append an accepted batch to the op log, dropping the oldest entry
        once OP_LOG_MAX is exceeded (bounds memory; see OP_LOG_MAX)."""
        self.op_log.append(batch)
        if len(self.op_log) > OP_LOG_MAX:
            del self.op_log[0]
            self.op_log_dropped += 1


#: Project id for the no-request-context ``get_session()`` (internal/test
#: callers, and the dev seed). Request-scoped routes resolve ``project_id`` from
#: the ``/api/v1/projects/{project_id}`` URL path instead — there is no implicit
#: header fallback (Phase 1's ``X-Project-Id`` mechanism was replaced in Phase 2).
DEFAULT_PROJECT_ID = "default"


class SessionRegistry:
    """Holds one live :class:`Session` per project id, hydrated on first access.

    On a cache-miss ``get`` calls the injected ``loader`` (Phase 3:
    ``hydration.hydrate_session``) under a per-project init-once lock so two
    concurrent requests for a cold project hydrate exactly once. ``evict`` runs
    the injected ``evict_hook`` (Phase 3: snapshot-then-drop) before removing the
    session. With no loader installed the registry falls back to an empty
    ``Session`` — the pre-Phase-3 behaviour used by unit tests that don't need
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
        # cold project is built exactly once (init-once guard, spec §11).
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

    def evict(self, project_id: str) -> None:
        # Peek (do NOT pop) under the guard so the session stays registered
        # while we inspect it. Popping first opened a window where a concurrent
        # get() could hydrate a second session and then lose either the new or
        # the re-registered live-leased session when we re-inserted.
        with self._guard:
            session = self._sessions.get(project_id)
        if session is None:
            return
        # Serialise vs an in-flight commit (spec §11 evict-during-commit guard).
        with session.write_mutex:
            if (
                session.lock_table.active_leases(time.monotonic())
                or session.hub.has_clients()
                or (
                    session.validation_sweep is not None
                    and session.validation_sweep.running
                )
            ):
                # A holder still has a check-out open, or a feed client is
                # connected. The session was never removed, so it stays
                # registered — no re-insert needed. A running validation
                # sweep also blocks eviction — evicting would snapshot fine
                # but waste the sweep; sweeps finish in seconds and the idle
                # sweeper retries.
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

    Unlike the former in-place field-copy reset, this replaces sessions by
    identity: a caller holding a reference to a pre-reset ``Session`` keeps
    seeing the old object and must call ``get_session()`` again for the live
    one. All current callers (request-scoped ``Depends``; tests that reset then
    re-fetch) already re-fetch, so this is safe.
    """
    _registry.reset()


def install_persistent_registry() -> None:
    """Wire the process-global registry to durable hydration + snapshot-evict.

    Called at app startup (and by the API test conftest). Kept here — not at
    import time — so importing ``session`` never pulls in the storage/DB stack
    (``hydration`` imports both); unit tests that want the empty-Session
    fallback simply don't call this."""
    from .hydration import hydrate_session, write_snapshot

    def _evict(project_id: str, sess: Session) -> None:
        if sess.model is not None:
            write_snapshot(project_id, sess, sess.model_rev)

    _registry.set_loader(hydrate_session)
    _registry.set_evict_hook(_evict)
