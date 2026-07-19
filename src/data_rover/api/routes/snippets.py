"""Snippet execution endpoints (Task 11): POST /snippets/run|lint|cancel.

Model-access stance: matches routes/artifacts.py's ``POST /navigations/evaluate``
and routes/tables.py's ``POST /tables/evaluate`` — reads ``session.model``
WITHOUT ``session.write_mutex``. This is deliberate, not an oversight: a
runner's bridge dispatcher only ever calls read accessors on the live
``Model`` (never a mutation-boundary method — see ``core/script/bridge.py``'s
module docstring) and never applies writes; writes are *proposed* op dicts,
applied only by a later ``POST /model/ops`` or check-out/commit call. Holding
``write_mutex`` for a run's full wall-clock duration (up to
``snippet_wall_timeout_s``, default 10s) would serialize every commit/lock/
evict on the project behind a single snippet run — exactly what the ``stale``
flag exists to avoid: a run reads a point-in-time snapshot in a benign race
with concurrent commits, and the route reports whether the model moved under
it (``stale = start_rev != end_rev``) instead of blocking those commits.

Two per-process, in-memory pieces of state live at module scope (both
thread-safe, both scoped to THIS API process — not mirrored across replicas,
matching ``LockTable``'s Phase 7 deferral note):

- ``_active_runs`` — a ``(project_id, run_id) -> _ActiveRun(owner, cancel)``
  registry so ``POST /snippets/cancel`` can look up and authorize a cancel
  request. Registered just before ``runner.run(...)`` is called, deregistered
  in a ``finally``.

  **Collision semantics** (reviewer fix, see task-11 review): the key is the
  *pair* ``(project_id, run_id)``, not bare ``run_id`` — two different
  projects reusing the same client-chosen run_id no longer collide.
  Registration is last-register-wins: if the same key is registered twice
  before the first is deregistered (e.g. a client reuses a run_id while an
  earlier run with that id is still in flight), the second call silently
  replaces the first in the dict, same as an ordinary dict assignment.
  Deregistration is **token-guarded** to make that safe: ``_register_run``
  returns the ``_ActiveRun`` it just inserted as an opaque token, and
  ``_deregister_run`` only pops the slot when the value CURRENTLY stored
  there ``is`` that exact token (identity compare under the lock). So a
  stale caller — one holding an older token because its key got overwritten
  by a newer registration — can never delete an entry it doesn't own; the
  newer registration's owner keeps full cancel capability until it
  deregisters with its own token.
- ``concurrency_guard`` (``..snippet_concurrency``) — a non-blocking global +
  per-user run limiter (``snippet_concurrency`` / ``snippet_per_user_concurrency``
  settings from Task 10), shared with embedded evaluation (``script_eval.py``).
  Acquire fails fast (429) rather than queuing; released in a ``finally`` so
  an exception mid-run never leaks a permit.
"""

from __future__ import annotations

import hashlib
import logging
import threading
from dataclasses import dataclass
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session as DbSession

from data_rover.core.script.docs import get_facade_docs
from data_rover.core.script.lint import derive_entry_points, lint_code
from data_rover.core.script.runner import RunRequest, ScriptRunner

from .. import content
from ..authz import require_membership
from ..db import get_db
from ..db_models import ArtifactKind, Membership, User
from ..deps import Session, get_request_session, require_model
from ..identity import get_current_user
from ..schemas import (
    OPS_ADAPTER,
    DiagnosticOut,
    FacadeDocEntryOut,
    SnippetCancelIn,
    SnippetDocsOut,
    SnippetErrorOut,
    SnippetLimitsOut,
    SnippetLintIn,
    SnippetLintOut,
    SnippetRunIn,
    SnippetRunOut,
)
from ..script_runner import get_runner, run_limits_from_settings
from ..settings import Settings, get_settings
from ..snippet_concurrency import concurrency_guard

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Active-run registry (for POST /snippets/cancel)
# ---------------------------------------------------------------------------


@dataclass
class _ActiveRun:
    user_id: str
    cancel: Callable[[], None]


#: keyed by (project_id, run_id) -- see the module docstring's "Collision
#: semantics" note for why bare run_id was not enough and why deregistration
#: must be token-guarded rather than an unconditional pop-by-key.
_active_runs: dict[tuple[str, str], _ActiveRun] = {}
_active_runs_lock = threading.Lock()


def _register_run(
    project_id: str, run_id: str, user_id: str, cancel: Callable[[], None]
) -> _ActiveRun:
    """Insert (last-register-wins) and return the inserted entry as an
    opaque deregistration token -- the caller must pass this exact object
    back to `_deregister_run` so a stale caller can never delete a newer
    registration at the same key."""
    entry = _ActiveRun(user_id=user_id, cancel=cancel)
    with _active_runs_lock:
        _active_runs[(project_id, run_id)] = entry
    return entry


def _deregister_run(project_id: str, run_id: str, token: _ActiveRun) -> None:
    """Compare-and-delete: only removes the slot if it still holds THIS
    token. A no-op if the slot was already removed or was overwritten by a
    newer `_register_run` call for the same key (see module docstring)."""
    with _active_runs_lock:
        if _active_runs.get((project_id, run_id)) is token:
            del _active_runs[(project_id, run_id)]


def _noop_cancel() -> None:
    """M1 cancel seam.

    ``WasmScriptRunner.run()`` (script_runner.py) drives its bridge loop to
    completion or to the wall-timeout with no external abort entry point
    exposed today — there is no clean per-run cancel hook to wire this to
    without changing that module, which is out of this task's scope. This
    callable documents that gap rather than papering over it: the registry,
    ownership check, and 204/404 contract ``POST /snippets/cancel`` promises
    the frontend are fully implemented and real; only the actual abort is a
    no-op for now. A run a client "cancels" today still terminates on its
    own via ``RunLimits.wall_timeout_s`` regardless — cancel just stops
    tracking it early from the caller's point of view.
    """


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/snippets/lint")
def lint_snippet(
    payload: SnippetLintIn,
    _membership: Membership = Depends(require_membership),
) -> SnippetLintOut:
    """Pure-AST lint; no model access needed, but still project-scoped +
    membership-authorized like every route under this prefix. Read-only
    (listed in authz._READ_ONLY_POST_SUFFIXES)."""
    diagnostics = lint_code(payload.code)
    entry_points = derive_entry_points(payload.code)
    return SnippetLintOut(
        diagnostics=[
            DiagnosticOut(
                line=d.line, col=d.col, severity=d.severity, message=d.message
            )
            for d in diagnostics
        ],
        entry_points=entry_points,
    )


#: Static authoring facts served alongside the generated reference. The one
#: hand-written piece of the docs payload — keep each entry a single plain
#: sentence; the panel renders them as a bullet list.
_SNIPPET_DOC_NOTES = [
    "Runs are dry-run: writes (dr.create, el.set, ...) record proposed ops; "
    "nothing changes until you stage and commit them.",
    "Execution is deterministic: the clock and random seed are pinned, so the "
    "same code against the same model produces identical output.",
    "The sandbox has no network or filesystem access; many stdlib modules "
    "(os, subprocess, socket, ...) are absent or blocked.",
    "Stopping a run is not instant: the run ends at the wall timeout, and a "
    "new run may be rejected until the slot frees.",
]


@router.get("/snippets/docs")
def snippet_docs(
    _membership: Membership = Depends(require_membership),
    settings: Settings = Depends(get_settings),
) -> SnippetDocsOut:
    """Structured snippet-authoring docs: the facade reference extracted from
    the facade source itself, the configured limits, and static notes.
    Deliberately independent of the runner — served even when /snippets/run
    would 503 (no guest binary)."""
    limits = run_limits_from_settings(settings)
    return SnippetDocsOut(
        facade=[
            FacadeDocEntryOut(
                name=e.name,
                kind=e.kind,  # type: ignore[arg-type]  # str -> Literal: pydantic validates at construction
                signature=e.signature,
                doc=e.doc,
                example=e.example,
            )
            for e in get_facade_docs()
        ],
        limits=SnippetLimitsOut(
            wall_timeout_s=limits.wall_timeout_s,
            memory_bytes=limits.memory_bytes,
            stdout_bytes=limits.stdout_bytes,
            result_repr_bytes=limits.result_repr_bytes,
            max_ops=limits.max_ops,
            max_op_bytes=limits.max_op_bytes,
            page_limit=limits.page_limit,
        ),
        notes=_SNIPPET_DOC_NOTES,
    )


def _resolve_code(payload: SnippetRunIn, project_id: str, db: DbSession) -> str:
    if payload.artifact_id is not None:
        row = content.get_artifact(db, payload.artifact_id)
        if row is None or row.project_id != project_id:
            raise HTTPException(status_code=404, detail="artifact not found")
        if row.kind is not ArtifactKind.code_snippet:
            raise HTTPException(
                status_code=422,
                detail=f"artifact kind {row.kind.value!r} is not a code_snippet",
            )
        return str(row.payload.get("code", ""))
    assert payload.code is not None  # schema guarantees exactly one
    return payload.code


@router.post("/snippets/run")
def run_snippet(
    payload: SnippetRunIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> SnippetRunOut:
    """Execute a snippet against the live session model. Read-only (listed
    in authz._READ_ONLY_POST_SUFFIXES) — see the module docstring for why no
    write_mutex is held across the run.
    """
    _, model = require_model(session)
    if runner is None:
        raise HTTPException(
            status_code=503, detail="script execution runner is not available"
        )
    code = _resolve_code(payload, project_id, db)

    if not concurrency_guard.try_acquire(
        user.id,
        global_limit=settings.snippet_concurrency,
        per_user_limit=settings.snippet_per_user_concurrency,
    ):
        raise HTTPException(status_code=429, detail="too many concurrent snippet runs")

    start_rev = session.model_rev
    token: _ActiveRun | None = None
    try:
        # Registration lives INSIDE the try (not between acquire and try, as
        # a prior draft had it) so that even a freak failure in
        # `_register_run` itself can't leak the concurrency permit acquired
        # just above -- the finally below always fires once acquire
        # succeeded, no matter what happens after it. `token` gates the
        # deregister below: if `_register_run` never returned (raised before
        # assignment), `token` stays None and deregister is skipped -- there
        # is nothing of ours in the registry to remove.
        token = _register_run(project_id, payload.run_id, user.id, _noop_cancel)
        res = runner.run(
            model,
            RunRequest(code=code, entry=payload.entry, element_ids=payload.element_ids),
            run_limits_from_settings(settings),
            record_ops=(payload.entry == "script"),
            rev=start_rev,
        )
    finally:
        if token is not None:
            _deregister_run(project_id, payload.run_id, token)
        concurrency_guard.release(user.id)

    end_rev = session.model_rev
    stale = start_rev != end_rev

    try:
        validated_ops = OPS_ADAPTER.validate_python(res.ops)
    except ValidationError:
        # A runner emitting an op dict OPS_ADAPTER rejects is a server bug
        # (the bridge dispatcher/guest facade produced something the
        # frontend's own ops.ts contract wouldn't recognize either) — not a
        # client-input error, so this is a 500, and we log the raw ops for
        # diagnosis.
        logger.error(
            "snippet run %s emitted an invalid op batch: %r",
            payload.run_id,
            res.ops,
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail="runner emitted an invalid op batch"
        ) from None

    code_hash = hashlib.sha256(code.encode("utf-8")).hexdigest()[:12]
    logger.info(
        "snippet run user=%s project=%s code_sha=%s entry=%s duration_ms=%d "
        "ops=%d outcome=%s",
        user.id,
        project_id,
        code_hash,
        payload.entry,
        res.duration_ms,
        len(validated_ops),
        res.error.kind if res.error is not None else "ok",
    )

    error_out = (
        SnippetErrorOut(
            kind=res.error.kind,
            message=res.error.message,
            traceback=res.error.traceback,
        )
        if res.error is not None
        else None
    )
    return SnippetRunOut(
        run_id=payload.run_id,
        stdout=res.stdout,
        result_repr=res.result_repr,
        ops=validated_ops,
        error=error_out,
        duration_ms=res.duration_ms,
        model_rev=end_rev,
        stale=stale,
        truncated=res.truncated,
    )


@router.post("/snippets/cancel", status_code=204)
def cancel_snippet(
    payload: SnippetCancelIn,
    project_id: str,
    user: User = Depends(get_current_user),
    _membership: Membership = Depends(require_membership),
) -> Response:
    """Best-effort cancel of an active run (see ``_noop_cancel``). 404 both
    when the run_id is unknown AND when it belongs to another user — the two
    cases are indistinguishable in the response so a caller can't probe for
    other users' run ids. Looked up by ``(project_id, run_id)`` — see the
    module docstring's "Collision semantics" note."""
    with _active_runs_lock:
        entry = _active_runs.get((project_id, payload.run_id))
    if entry is None or entry.user_id != user.id:
        raise HTTPException(status_code=404, detail="run not found")
    entry.cancel()
    return Response(status_code=204)
