from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.validation.state import ValidationState
from data_rover.core.view.schema import View

if TYPE_CHECKING:
    from .schemas import OpIn

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
    """Holds one live :class:`Session` per project id, created on first access.

    Replaces the former process-wide singleton. Each project gets an
    independent in-memory ``Session`` (metamodel + model + view + validation
    baseline + op_log + model_rev), so mutating one project never affects
    another. Sessions are created lazily by :meth:`get`; :meth:`evict` drops a
    single project; :meth:`reset` drops them all (test isolation). Later phases
    add durable hydration-on-miss and idle eviction here without changing
    callers.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}

    def get(self, project_id: str) -> Session:
        """Return the live session for *project_id*, creating one on first access.

        Subsequent calls with the same id return the exact same ``Session``
        instance; callers must not cache the return value across evictions.
        This is the seam where later phases will hydrate a persisted session
        from durable storage on a cache-miss, without callers needing to change.
        """
        session = self._sessions.get(project_id)
        if session is None:
            session = Session()
            self._sessions[project_id] = session
        return session

    def evict(self, project_id: str) -> None:
        """Drop the session for *project_id*, if one exists.

        Idempotent: silently ignores unknown ids so callers need not guard
        against double-eviction (e.g. explicit eviction followed by an idle
        eviction that runs concurrently).
        """
        self._sessions.pop(project_id, None)

    def reset(self) -> None:
        """Drop all live sessions.

        Intended for test isolation: each test that needs a clean registry
        calls this on teardown (or constructs a fresh ``SessionRegistry``)
        rather than managing individual evictions.
        """
        self._sessions.clear()

    def project_ids(self) -> list[str]:
        """Return the ids of currently-live sessions, in insertion order.

        Insertion order matches dict iteration order (guaranteed since
        Python 3.7). Sessions that were evicted are not included.
        """
        return list(self._sessions)


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
