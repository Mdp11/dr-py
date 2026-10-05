"""Periodic snapshot, off the commit's critical section.

The journal writers trigger a snapshot every ``settings.snapshot_every``
commits. Streaming a large head takes seconds, so the trigger schedules this
job instead of writing inline: a daemon thread runs ``write_snapshot_from_rows``
for the project, which snapshots the rows at whatever rev it finds committed
there. Any rev at or past the trigger bounds the replay tail equally, and the
job needs no session, no model and no write mutex. A project without a model
row (deleted) is skipped.

One job per project at a time, held in a process-wide slot; a trigger that
finds one running is dropped (the next multiple re-triggers). Failure is
logged and dropped: the commit is durable, and a replica or hydration
rebuilds the snapshot on the next cache miss.

The snapshots that are correctness rather than bounding (the rebind's, the
baseline's, the descriptor's miss) are written synchronously by their callers.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field

from .settings import get_settings
from .snapshot_rows import write_snapshot_from_rows

logger = logging.getLogger(__name__)


@dataclass
class SnapshotJob:
    """Handle of one scheduled periodic snapshot (tests join ``done``)."""

    running: bool = True
    #: rev actually written, or None when the job wrote nothing
    written_rev: int | None = None
    done: threading.Event = field(default_factory=threading.Event)


_jobs: dict[str, SnapshotJob] = {}
_jobs_lock = threading.Lock()


def current_job(project_id: str) -> SnapshotJob | None:
    """The project's in-flight or last job."""
    with _jobs_lock:
        return _jobs.get(project_id)


def schedule_periodic_snapshot(
    project_id: str, *, sync: bool | None = None
) -> SnapshotJob | None:
    """Schedule (or, in sync mode, run inline) a snapshot of the project.

    ``sync=None`` reads ``settings.snapshot_sync``. Returns ``None`` when a job
    is already running for the project.
    """
    with _jobs_lock:
        current = _jobs.get(project_id)
        if current is not None and current.running:
            return None
        job = _jobs[project_id] = SnapshotJob()
    if sync if sync is not None else get_settings().snapshot_sync:
        _run(project_id, job)
    else:
        threading.Thread(
            target=_run, args=(project_id, job), name="snapshot-job", daemon=True
        ).start()
    return job


def _run(project_id: str, job: SnapshotJob) -> None:
    try:
        job.written_rev = write_snapshot_from_rows(project_id)
    except LookupError:
        pass  # no model row: the project was deleted
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
