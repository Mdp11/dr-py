"""Bundle routes: export closure + stateless plan→confirm import.

Export/preview read ONLY artifact rows (never the in-memory model), so they
take no session dependency and sit in the read-only POST allowlist — viewers
may export. Import plan and confirm are advisory-then-durable halves of the
write flow, so both sit OUTSIDE that allowlist (a viewer must not be able to
kick either one off).

Confirm is STATELESS: no plan is ever stored between the two calls. It
re-derives the plan against live rows and re-checks the client's decisions
against it, so the only thing a client carries across the round trip is the
bundle plus its answers. Everything it writes goes through ONE
``create_commit`` call, which is what makes an import journaled, undoable and
diffable exactly like any other artifact commit.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from ..artifact_bundle import (
    ArtifactBundle,
    CreatedEntry,
    ExportPreviewArtifact,
    ExportPreviewResponse,
    ExportRequest,
    ImportConfirmRequest,
    ImportConfirmResponse,
    ImportPlan,
    StalePlanError,
    build_bundle,
    build_import_ops,
    compute_closure,
    derive_plan,
    derive_plan_ex,
)
from ..authz import require_membership
from ..db import get_db
from ..db_models import Membership, Project, User
from ..deps import Session, get_request_session
from ..identity import get_current_user
from ..schemas import TEMP_ID_PREFIX, CommitRequest
from .commits import create_commit

router = APIRouter()


@router.post("/artifacts/export")
def export_artifacts(
    body: ExportRequest,
    project_id: str,
    _membership: Membership = Depends(require_membership),
    db: DbSession = Depends(get_db),
) -> JSONResponse:
    project = db.get(Project, project_id)
    assert project is not None  # require_membership proved existence
    closure = compute_closure(db, project_id, body.root_ids)
    bundle = build_bundle(project, closure, body.root_ids)
    return JSONResponse(
        content=bundle.model_dump(),
        headers={"Content-Disposition": 'attachment; filename="artifacts.bundle.json"'},
    )


@router.post("/artifacts/export/preview", response_model=ExportPreviewResponse)
def export_preview(
    body: ExportRequest,
    project_id: str,
    _membership: Membership = Depends(require_membership),
    db: DbSession = Depends(get_db),
) -> ExportPreviewResponse:
    closure = compute_closure(db, project_id, body.root_ids)
    return ExportPreviewResponse(
        artifacts=[
            ExportPreviewArtifact(id=r.id, kind=r.kind.value, name=r.name)
            for r in closure.rows
        ],
        dangling_refs=closure.dangling_refs,
    )


@router.post("/artifacts/import/plan", response_model=ImportPlan)
def import_plan(
    bundle: ArtifactBundle,
    project_id: str,
    _membership: Membership = Depends(require_membership),
    db: DbSession = Depends(get_db),
) -> ImportPlan:
    """Advisory resolution plan; writes nothing. Deliberately NOT in the
    read-only allowlist — planning an import is part of the write flow."""
    return derive_plan(db, project_id, bundle)


@router.post("/artifacts/import", response_model=ImportConfirmResponse)
def import_confirm(
    body: ImportConfirmRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ImportConfirmResponse | JSONResponse:
    """Stateless confirm: re-derive the plan, honor the client's decisions,
    land ONE commit through ``create_commit``.

    No leases are taken or required: every op this route emits is a
    ``create_artifact`` on a FRESH id, and a lease exists to protect an
    identity a peer could be holding — there is no such identity yet. (Reused
    rows are read, never written.) Likewise no OCC precondition: what an
    import can actually race is the (kind, name) uniqueness the plan resolved
    against, and that is re-checked twice — here against a freshly-derived
    plan, and again inside the applier's own clash tracker.

    Both stale paths converge on 409 + the FRESH plan in the body, so the
    client always has something to re-render and re-decide against:
    - a decision the re-derived plan can't honor (``StalePlanError``);
    - the applier's 422 for a name a peer claimed between our re-derive and
      the commit's own check.
    """

    def stale_conflict(detail: str) -> JSONResponse:
        fresh = derive_plan(db, project_id, body.bundle)
        return JSONResponse(
            status_code=409,
            content={"detail": detail, "plan": fresh.model_dump()},
        )

    derived = derive_plan_ex(db, project_id, body.bundle)
    plan = derived.plan
    try:
        ops, reused, final_names = build_import_ops(
            plan,
            body.bundle,
            body.decisions,
            body.copy_names,
            # the DB-derived name pool: without it a `copy_names` rename onto a
            # row the bundle never mentions would sail past into the applier
            derived.taken_names,
        )
    except StalePlanError as exc:
        return stale_conflict(exc.detail)

    if not ops:
        # All-reuse / all-skipped. NEVER hand create_commit an empty batch:
        # its empty-ops early return is harmless in itself, but an empty-ops
        # JOURNAL row is persist_baseline's "the whole model was replaced
        # opaquely" marker, which the commit staleness guard reads as an
        # unconditional 409 for every client below that rev. Nothing was
        # written, so there is no rev to report either.
        return ImportConfirmResponse(
            rev=None, created=[], reused=reused, skipped=plan.skipped
        )

    noun = "artifact" if len(ops) == 1 else "artifacts"
    message = body.message or (
        f"Imported {len(ops)} {noun} from {body.bundle.source_project.name}"
    )
    req = CommitRequest(
        base_rev=session.model_rev,
        ops=list(ops),
        message=message,
        lock_tokens=[],
        # nothing to acknowledge: artifact ops raise no conformance issues
        ack_errors=True,
    )
    try:
        result = create_commit(req, project_id, session=session, db=db, user=user)
    except HTTPException as exc:
        if exc.status_code == 422:
            # The batch was built from a plan derived moments ago against
            # these same rows, so the only 422 expected here is the applier's
            # (kind, name) clash check firing on a name a peer claimed in
            # between — a stale plan by another name. (The DB-level
            # IntegrityError is unreachable for exactly that reason: the clash
            # check runs first, and turns it into this.) The applier's own
            # detail is CARRIED, not swallowed: it is the only description of
            # what actually happened, and if this 422 ever has a cause other
            # than the one guessed above, a flattened message would leave the
            # client re-submitting a plan that can never succeed with no hint
            # why.
            return stale_conflict(f"import plan is stale: {exc.detail}")
        raise
    if isinstance(result, JSONResponse):
        # create_commit's own conflict responses (staleness / missing lease).
        # base_rev is read off the live session and fresh-id creates overlap
        # nothing, so this is effectively unreachable — propagated verbatim
        # rather than reshaped, so a future path that does reach it surfaces
        # as itself instead of being disguised as an import-plan conflict.
        return result
    created = [
        CreatedEntry(
            bundle_id=bid,
            # every created op's temp id is in the commit's id_map by
            # construction (artifact_ops mints a uuid per TEMP_ID_PREFIX op)
            id=result.id_map[TEMP_ID_PREFIX + bid],
            name=name,
        )
        for bid, name in final_names.items()
    ]
    return ImportConfirmResponse(
        rev=result.model_rev, created=created, reused=reused, skipped=plan.skipped
    )
