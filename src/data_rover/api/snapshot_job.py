"""Periodic full-model snapshot, off the commit's critical section.

The journal writers trigger a snapshot every ``settings.snapshot_every``
commits. Encoding a large model takes seconds, so the trigger schedules
this job instead of writing inline: a daemon thread takes
``session.write_mutex`` itself and snapshots the model at whatever rev it
finds there — any rev at or past the trigger bounds the replay tail
equally. Under the mutex it also re-checks that the registry still holds
this exact session: an evicted session was already snapshotted by the
evict hook, and a discarded one belongs to a deleted project whose row
would violate the FK. One job per session at a time; a trigger that finds
one running is dropped (the next multiple re-triggers). Failure is logged
and dropped — the commit is durable, and hydration rebuilds the snapshot
on the next cache-miss.

The snapshots that are correctness rather than bounding — rebind-forced,
evict, baseline — stay synchronous in their callers and never come here.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field

from .hydration import write_snapshot
from .session import Session, get_registry
from .settings import get_settings

logger = logging.getLogger(__name__)


@dataclass
class SnapshotJob:
    """Handle of one scheduled periodic snapshot (tests join ``done``)."""

    running: bool = True
    #: rev actually written, or None when the job wrote nothing
    written_rev: int | None = None
    done: threading.Event = field(default_factory=threading.Event)


def schedule_periodic_snapshot(
    project_id: str, session: Session, *, sync: bool | None = None
) -> SnapshotJob | None:
    """Schedule (or, in sync mode, run inline) a snapshot of ``session``.

    ``sync=None`` reads ``settings.snapshot_sync``. Returns ``None`` when a
    job is already running for the session.
    """
    current = session.snapshot_job
    if current is not None and current.running:
        return None
    job = SnapshotJob()
    session.snapshot_job = job
    if sync if sync is not None else get_settings().snapshot_sync:
        _run(project_id, session, job)
    else:
        threading.Thread(
            target=_run,
            args=(project_id, session, job),
            name="snapshot-job",
            daemon=True,
        ).start()
    return job


def _run(project_id: str, session: Session, job: SnapshotJob) -> None:
    try:
        with session.write_mutex:
            if get_registry().peek(project_id) is not session or session.model is None:
                return
            rev = session.model_rev
            write_snapshot(project_id, session, rev)
            job.written_rev = rev
    except Exception:
        logger.warning(
            "periodic snapshot failed for project %s; commit is durable, "
            "hydration will rebuild",
            project_id,
            exc_info=True,
        )
    finally:
        job.running = False
        job.done.set()
