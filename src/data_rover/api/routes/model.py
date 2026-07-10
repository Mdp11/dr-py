from __future__ import annotations

import json
import os
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Any, Iterator, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.validation.state import ValidationState

from .. import content
from ..authz import require_membership
from ..db import get_db
from ..db_models import Membership, User
from ..deps import (
    Session,
    get_request_session,
    require_allowed_origin,
    require_metamodel,
    require_model,
)
from ..hydration import hydration_progress, persist_baseline
from ..identity import get_current_user
from ..schemas import (
    InlineModel,
    LoadModelRequest,
    ModelOut,
    ModelSummary,
    SaveModelRequest,
    SaveModelResponse,
    SnapshotIn,
)
from ..serialize import iter_buffered, iter_model_json
from ..session import get_registry
from ..validation_sweep import start_validation_sweep
from ._snapshot import _build_model_from_payload, build_model_from_dicts
from .read import model_summary

router = APIRouter()


class ValidationStatusOut(BaseModel):
    running: bool
    done: int
    total: int


class HydrationStatusOut(BaseModel):
    phase: str
    done: int
    total: int


class ModelStatusOut(BaseModel):
    state: Literal["cold", "hydrating", "empty", "validating", "ready"]
    model_rev: int | None = None
    validation: ValidationStatusOut | None = None
    hydration: HydrationStatusOut | None = None


@router.get("/model/status")
def model_status(
    project_id: str,
    _membership: Membership = Depends(require_membership),
) -> ModelStatusOut:
    """Open/validation progress WITHOUT touching the session registry's
    hydrating ``get`` — the poller must never block on (or trigger) the very
    hydration it is reporting on. Membership is still enforced (the status
    leaks model_rev/entity progress). ``cold`` means "no warm session and no
    hydration in flight": for the poller it is indistinguishable from
    hydrating-not-yet-started, so clients keep polling through it."""
    session = get_registry().peek(project_id)
    if session is None:
        hp = hydration_progress(project_id)
        if hp is not None:
            return ModelStatusOut(
                state="hydrating",
                hydration=HydrationStatusOut(phase=hp.phase, done=hp.done, total=hp.total),
            )
        return ModelStatusOut(state="cold")
    if session.model is None:
        return ModelStatusOut(state="empty")
    sweep = session.validation_sweep
    if sweep is not None and sweep.running:
        return ModelStatusOut(
            state="validating",
            model_rev=session.model_rev,
            validation=ValidationStatusOut(running=True, done=sweep.done, total=sweep.total),
        )
    return ModelStatusOut(state="ready", model_rev=session.model_rev)


@router.post("/model", deprecated=True)
def upload_model(
    payload: InlineModel,
    session: Session = Depends(get_request_session),
) -> ModelOut:
    """Deprecated: set the session model from an inline JSON payload.

    Superseded by the streaming loaders (POST /model/load for a server-side
    path, POST /model/upload for a raw browser-streamed body), which avoid
    pydantic-validating an O(model) payload and seed validation at load time.
    """
    metamodel = require_metamodel(session)
    model = _build_model_from_payload(
        metamodel, payload.elements, payload.relationships
    )
    session.set_model(model)
    return ModelOut.from_core(model)


@router.get("/model", deprecated=True)
def get_model(session: Session = Depends(get_request_session)) -> ModelOut:
    """Deprecated: return the FULL session model in one JSON body.

    O(model) response — superseded by the paged/on-demand read endpoints
    (/model/summary, /model/elements/page, /model/search, /model/tree/*,
    /model/elements/{id}/neighborhood) and GET /model/download for export.
    Still served for small-model consumers (e.g. the compare page).
    """
    _, model = require_model(session)
    return ModelOut.from_core(model)


@router.put("/model/snapshot", deprecated=True)
def snapshot_model(
    payload: SnapshotIn,
    session: Session = Depends(get_request_session),
) -> ModelOut:
    """Deprecated: replace the session model with an inline snapshot.

    Superseded by the delta protocol: edits flow through POST /model/ops and
    loads through POST /model/load / /model/upload, so clients never ship an
    O(model) snapshot.
    """
    metamodel = require_metamodel(session)
    model = _build_model_from_payload(
        metamodel, payload.elements, payload.relationships
    )
    session.set_model(model)
    return ModelOut.from_core(model)


@router.delete("/model", status_code=204)
def clear_model(session: Session = Depends(get_request_session)) -> Response:
    session.set_model(None)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Streaming load/save endpoints (Phase C3 of the large-model overhaul)
#
# These move all heavy serialization server-side: the browser streams a file
# body up without JSON.parsing it (or just sends a path) and pipes a chunked
# download to disk without materializing the model as a JS string.
# ---------------------------------------------------------------------------


def _install_model(
    session: Session,
    metamodel: Metamodel,
    raw: Any,
    *,
    db: DbSession,
    project_id: str,
    author_id: str | None,
) -> ModelSummary:
    """Guard-check *raw*, install it as the session model, start validation.

    Shared tail of POST /model/load and POST /model/upload: build the Model
    directly from the parsed dicts (same guards as the pydantic snapshot
    routes, shared via _snapshot.py), install it with a PRESENT-but-EMPTY
    issue store via ``set_model`` (which bumps ``model_rev`` and clears the
    op log, so ``undo_depth`` is 0 afterwards) so ops batches can splice into
    it immediately, then start the chunked background validation sweep — the
    load is no longer the single O(model) validation cost; validation now
    streams in via ``validation_sweep`` and the returned summary's
    ``issue_counts`` starts at zero and grows as chunks land. Returns the same
    shape as GET /model/summary.
    """
    model = build_model_from_dicts(metamodel, raw)
    # install with a PRESENT-but-EMPTY issue store: ops batches splice into it
    # immediately (no synchronous re-seed) while the background sweep fills it
    session.set_model(model, validation=ValidationState())
    # make this uploaded model the durable baseline, but only if the project
    # has a model row (i.e. its metamodel was persisted) — pure in-memory unit
    # tests that skip the metamodel route keep working with no persistence.
    if content.get_model_row(db, project_id) is not None:
        persist_baseline(project_id, session, author_id=author_id)
    start_validation_sweep(session)
    return model_summary(session)


@router.post("/model/load", dependencies=[Depends(require_allowed_origin)])
def load_model(
    payload: LoadModelRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ModelSummary:
    """Load a model JSON file from the SERVER's local filesystem.

    Trust model: data-rover is a localhost single-user tool — the backend
    and the browser run as the same user on the same machine, so a
    client-supplied path is the user pointing the tool at their own file.
    There is intentionally no path sandboxing or authentication; do not
    expose this API beyond localhost.

    Accepts the save shape the frontend writes
    (``{"elements": [...], "relationships": [...]}``); extra top-level keys
    (e.g. ``rev``) are tolerated. Non-existent / non-file paths, unreadable
    files, and invalid JSON all yield 422 with the OS/parse error as detail.
    """
    metamodel = require_metamodel(session)
    path = Path(payload.path)
    if not path.is_file():
        raise HTTPException(
            status_code=422,
            detail=f"Not a readable file: {payload.path!r}",
        )
    try:
        with path.open(encoding="utf-8") as f:
            raw = json.load(f)
    except OSError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid JSON in {payload.path!r}: {exc}",
        ) from exc
    return _install_model(
        session, metamodel, raw, db=db, project_id=project_id, author_id=user.id
    )


@router.post("/model/upload", dependencies=[Depends(require_allowed_origin)])
async def upload_model_body(
    request: Request,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ModelSummary:
    """Load a model from the raw request body (browser-streamed file).

    The D2 frontend streams a picked ``File`` straight into ``fetch``'s body
    — no JS-side parse, no string materialization in the browser. Here the
    body is buffered (``await request.body()``) and parsed in one
    ``json.loads``: at the ~80 MB target size that is one transient bytes
    buffer and a single fast C-level parse, so a true incremental streaming
    parser would add a dependency and complexity for no measured win; it can
    be slotted into this handler later without changing the contract.

    The content type is deliberately not enforced: browsers send
    ``application/octet-stream`` (or nothing) for streamed File bodies, so
    anything that parses as JSON is accepted. Same guards, validation
    seeding, and summary response as POST /model/load.
    """
    metamodel = require_metamodel(session)
    body = await request.body()
    try:
        raw = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Request body is not valid JSON: {exc}",
        ) from exc
    return _install_model(
        session, metamodel, raw, db=db, project_id=project_id, author_id=user.id
    )


@router.post("/model/save", dependencies=[Depends(require_allowed_origin)])
def save_model(
    payload: SaveModelRequest,
    session: Session = Depends(get_request_session),
) -> SaveModelResponse:
    """Write the session model to a local file in the frontend save shape.

    Same localhost trust model as POST /model/load (the path is written as
    the server user; no sandboxing — single-user tool). The bytes are
    produced by the chunked writer in ``api/serialize.py`` and are identical
    to GET /model/download, byte-shape-compatible with what the frontend's
    ``saveJsonToFile`` writes today, so old save files and new ones are
    interchangeable.

    The write is atomic with respect to the destination: chunks go to a
    temporary file in the destination's directory (same filesystem, so the
    final rename cannot fail with EXDEV), which is fsynced and
    ``os.replace``d onto the target only after a complete successful write.
    A failure mid-write (full disk, serialization error) therefore leaves a
    pre-existing save untouched, and the temp file is unlinked.
    """
    _, model = require_model(session)
    target = Path(payload.path)
    bytes_written = 0
    try:
        fd, tmp_name = tempfile.mkstemp(
            dir=target.parent, prefix=target.name + ".", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "wb") as f:
                for chunk in iter_model_json(model):
                    data = chunk.encode("utf-8")
                    f.write(data)
                    bytes_written += len(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_name, target)
        except BaseException:
            with suppress(OSError):
                os.unlink(tmp_name)
            raise
    except OSError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return SaveModelResponse(
        path=payload.path,
        element_count=len(model.elements),
        relationship_count=len(model.relationships),
        bytes_written=bytes_written,
    )


@router.get("/model/download", dependencies=[Depends(require_allowed_origin)])
def download_model(
    session: Session = Depends(get_request_session),
) -> StreamingResponse:
    """Stream the session model as an attachment (same bytes as /model/save).

    The D2 frontend pipes ``response.body`` straight into a FileSystem
    writable, so the browser never holds the serialized model as a string.
    Chunks come from the same generator as /model/save — the two outputs are
    byte-identical by construction. Unlike save (which writes in-process to a
    buffered file handle), every chunk yielded here costs a full ASGI send
    cycle, so the entity-sized chunks are re-chunked through ``iter_buffered``
    into >=64 KiB pieces (measured: ~2 MB/s unbuffered vs. disk-speed
    buffered on a 118 MB model; byte-identical output either way).

    The ``StreamingResponse`` consumes the generator AFTER this handler
    returns, interleaved with other requests; ``iter_model_json`` snapshots
    the entity sets at stream start so a concurrent ops batch cannot break
    the stream mid-download (see its docstring for the exact staleness
    semantics).
    """
    _, model = require_model(session)

    def chunks() -> Iterator[bytes]:
        for chunk in iter_buffered(iter_model_json(model)):
            yield chunk.encode("utf-8")

    return StreamingResponse(
        chunks(),
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="model.json"'},
    )
