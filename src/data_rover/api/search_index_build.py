"""Chunked background build of the trigram search index.

The bulk-load path (``build_model_from_dicts`` -> ``IndexSet.rebuild``)
leaves ``search_ready`` False: building the index inline is the dominant
cost of a cold open, and ``search_candidates`` already falls back to a
byte-identical scan while it is absent. This module builds it AFTER the
session is serving, the way ``validation_sweep`` fills the issue store:
snapshot the element ids, then index ``CHUNK_SIZE`` of them per
``session.write_mutex`` acquisition so an ops batch never waits for more
than one chunk.

Correctness with concurrent edits: the IndexSet mutation hooks maintain
postings regardless of readiness, and ``index_search_chunk`` skips ids the
hooks already indexed or the model no longer holds, so the interleaving
converges on exactly what a synchronous full build produces. Readiness is
declared under the mutex only after the last chunk, and only if the session
still holds the model the build started on.

Correctness against a concurrent reset: a ``rebuild()`` (default
``keep_search=False``) on the live model clears the postings the build is
filling and drops ``search_ready`` without changing ``session.model`` or
``model.indexes`` identity, so the identity check alone would not notice.
``IndexSet._rebuild_gen`` bumps on every such reset; the build snapshots it
alongside the id list and aborts (leaving ``search_ready`` False, search on
the scan) if it ever no longer matches.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field

from data_rover.core.model.model import Model

from .session import Session
from .settings import get_settings

logger = logging.getLogger(__name__)

#: elements indexed per write_mutex acquisition (~70 ms at production
#: string sizes; a waiting ops batch is delayed by at most one chunk)
CHUNK_SIZE = 1000


@dataclass
class SearchIndexProgress:
    total: int = 0
    done: int = 0
    running: bool = True
    cancel: threading.Event = field(default_factory=threading.Event)
    #: set if the build died on an unexpected exception (logged)
    error: bool = False


def start_search_index_build(
    session: Session, *, sync: bool | None = None
) -> SearchIndexProgress:
    """Start (or, in sync mode, run to completion) the search-index build.

    A no-op that reports complete when the index is already ready (an empty
    model, or a rebind that rebuilt with ``keep_search=True``). ``sync=None``
    reads ``settings.search_index_sync``.
    """
    model = session.model
    assert model is not None, "start_search_index_build requires a loaded model"
    progress = SearchIndexProgress()
    session.search_index_build = progress
    if model.indexes.search_ready:
        progress.running = False
        return progress
    if sync if sync is not None else get_settings().search_index_sync:
        _run(session, model, progress)
    else:
        threading.Thread(
            target=_run,
            args=(session, model, progress),
            name="search-index-build",
            daemon=True,
        ).start()
    return progress


def _run(session: Session, model: Model, progress: SearchIndexProgress) -> None:
    start_time = time.monotonic()
    try:
        # list(dict) is one C-level operation, atomic under the GIL
        ids = list(model.elements.keys())
        gen = model.indexes._rebuild_gen
        progress.total = len(ids)
        for start in range(0, len(ids), CHUNK_SIZE):
            chunk = ids[start : start + CHUNK_SIZE]
            with session.write_mutex:
                if (
                    session.model is not model
                    or model.indexes._rebuild_gen != gen
                    or progress.cancel.is_set()
                ):
                    return
                model.indexes.index_search_chunk(chunk)
            progress.done = min(start + CHUNK_SIZE, len(ids))
        with session.write_mutex:
            if (
                session.model is model
                and model.indexes._rebuild_gen == gen
                and not progress.cancel.is_set()
            ):
                model.indexes.mark_search_ready()
                logger.info(
                    "search index build complete: %d elements in %.1fs",
                    len(ids),
                    time.monotonic() - start_time,
                )
    except Exception:
        logger.exception("search index build failed; search stays on the scan path")
        progress.error = True
    finally:
        progress.running = False
