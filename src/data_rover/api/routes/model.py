from __future__ import annotations

import json
import os
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Any, Iterator

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState

from ..deps import Session, get_session, require_metamodel, require_model
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
from ._snapshot import _build_model_from_payload, build_model_from_dicts
from .read import model_summary

router = APIRouter()


@router.post("/model")
def upload_model(
    payload: InlineModel,
    session: Session = Depends(get_session),
) -> ModelOut:
    metamodel = require_metamodel(session)
    model = _build_model_from_payload(
        metamodel, payload.elements, payload.relationships
    )
    session.set_model(model)
    return ModelOut.from_core(model)


@router.get("/model")
def get_model(session: Session = Depends(get_session)) -> ModelOut:
    _, model = require_model(session)
    return ModelOut.from_core(model)


@router.put("/model/snapshot")
def snapshot_model(
    payload: SnapshotIn,
    session: Session = Depends(get_session),
) -> ModelOut:
    metamodel = require_metamodel(session)
    model = _build_model_from_payload(
        metamodel, payload.elements, payload.relationships
    )
    session.set_model(model)
    return ModelOut.from_core(model)


@router.delete("/model", status_code=204)
def clear_model(session: Session = Depends(get_session)) -> Response:
    session.set_model(None)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Streaming load/save endpoints (Phase C3 of the large-model overhaul)
#
# These move all heavy serialization server-side: the browser streams a file
# body up without JSON.parsing it (or just sends a path) and pipes a chunked
# download to disk without materializing the model as a JS string.
# ---------------------------------------------------------------------------


def _install_model(session: Session, metamodel: Metamodel, raw: Any) -> ModelSummary:
    """Guard-check *raw*, install it as the session model, seed validation.

    Shared tail of POST /model/load and POST /model/upload: build the Model
    directly from the parsed dicts (same guards as the pydantic snapshot
    routes, shared via _snapshot.py), run ONE full validation to seed the
    session issue store — making the load the single O(model) validation
    cost instead of the first ops batch — install model and seeded state
    together via ``set_model`` (which bumps ``model_rev`` and clears the op
    log, so ``undo_depth`` is 0 afterwards), and return the same shape as
    GET /model/summary.
    """
    model = build_model_from_dicts(metamodel, raw)
    state = ValidationState()
    state.set_full(default_pipeline().validate(model, Scope.all()))
    session.set_model(model, validation=state)
    return model_summary(session)


@router.post("/model/load")
def load_model(
    payload: LoadModelRequest,
    session: Session = Depends(get_session),
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
    return _install_model(session, metamodel, raw)


@router.post("/model/upload")
async def upload_model_body(
    request: Request,
    session: Session = Depends(get_session),
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
    return _install_model(session, metamodel, raw)


@router.post("/model/save")
def save_model(
    payload: SaveModelRequest,
    session: Session = Depends(get_session),
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


@router.get("/model/download")
def download_model(session: Session = Depends(get_session)) -> StreamingResponse:
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
