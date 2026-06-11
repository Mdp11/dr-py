from __future__ import annotations

from dataclasses import dataclass, field, fields
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

    def set_model(self, model: Model | None) -> None:
        """Replace (or clear) the model and invalidate model-derived state."""
        self.model = model
        # view is intentionally untouched on model replacement
        self.validation = None  # previous full-run baseline is now stale
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


_session = Session()


def get_session() -> Session:
    return _session


def reset_session() -> None:
    """Reset the process-wide session to a fresh default state.

    Field-agnostic on purpose: every dataclass field is copied from a newly
    constructed ``Session`` so adding a field can never silently leak state
    across resets through a hand-maintained list here.
    """
    fresh = Session()
    for f in fields(Session):
        setattr(_session, f.name, getattr(fresh, f.name))
