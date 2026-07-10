"""Chunked background full-model validation (spec §3).

The load/upload/hydrate paths install the model with a PRESENT-but-EMPTY
``ValidationState`` and start this sweep instead of validating inline. The
sweep walks the entity ids in fixed-size chunks; each chunk is validated with
a bounded ``Scope`` and spliced into the session's issue store via
``ValidationState.replace`` — the exact splice the ops dirty path uses — so
edits and the sweep interleave correctly in either order: whichever runs
second for an entity recomputes that entity's issues.

Locking: each chunk (validate + splice) runs under ``session.write_mutex``,
released between chunks, so an ops batch is never starved for longer than one
chunk. Abort conditions checked per chunk under the mutex: the session's model
was replaced (``session.model is not model``), the validation state was
cleared, or ``progress.cancel`` was set (eviction path).

Because a PRESENT ``ValidationState`` is installed up front,
``_ensure_validation_seeded`` (routes/ops.py) never re-runs a synchronous
full sweep mid-edit — issue counts simply grow as chunks land.

Reporting-granularity note: a scoped run reports one containment-cycle issue
PER swept element whose parent chain reaches a cycle, where the historical
full sweep reported a single representative issue (see the spec's design
deltas; cycles are pathological structural blockers).
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from data_rover.core.model.model import Model
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope

from .session import Session
from .settings import get_settings

#: entities validated (and spliced) per write_mutex acquisition. Large enough
#: to amortize lock/pipeline overhead, small enough that an interleaved ops
#: batch waits at most a few milliseconds.
CHUNK_SIZE = 2000


@dataclass
class SweepProgress:
    """Observable progress of one sweep (read by GET /model/status)."""

    total: int = 0
    done: int = 0
    running: bool = True
    cancel: threading.Event = field(default_factory=threading.Event)


def start_validation_sweep(
    session: Session, *, sync: bool | None = None
) -> SweepProgress:
    """Start (or, in sync mode, run to completion) a full-model sweep.

    ``sync=None`` reads ``settings.validation_sweep_sync`` — false in
    production (background thread), pinned true by the API test conftest so
    existing tests keep their "validation seeded after load" assumption.
    """
    model = session.model
    assert model is not None, "start_validation_sweep requires a loaded model"
    progress = SweepProgress()
    session.validation_sweep = progress
    if sync if sync is not None else get_settings().validation_sweep_sync:
        _run(session, model, progress)
    else:
        threading.Thread(
            target=_run,
            args=(session, model, progress),
            name="validation-sweep",
            daemon=True,
        ).start()
    return progress


def _run(session: Session, model: Model, progress: SweepProgress) -> None:
    try:
        ids = list(model.elements.keys()) + list(model.relationships.keys())
        progress.total = len(ids)
        # one pipeline per sweep thread (validators carry mutable memo caches)
        pipeline = default_pipeline()
        for start in range(0, len(ids), CHUNK_SIZE):
            chunk = ids[start : start + CHUNK_SIZE]
            with session.write_mutex:
                if session.model is not model or progress.cancel.is_set():
                    return
                state = session.validation
                if state is None:
                    return
                # entities deleted since the id snapshot are skipped by the
                # scoped pipeline and their (absent) issues dropped by replace
                issues = pipeline.validate(model, Scope(chunk))
                state.replace(chunk, issues)
            progress.done = min(start + CHUNK_SIZE, len(ids))
    finally:
        progress.running = False
