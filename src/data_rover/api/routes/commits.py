"""Check-out/commit endpoints (Phase 4 spec §7): open, preview, commit.

Reuses the delta machinery from ``routes/ops.py`` — ``_apply_batch`` (atomic
apply with inverse collection; raises 422 on a mutation-boundary error),
``_rollback`` (undo a previewed batch), and ``_ensure_validation_seeded``
(full-run baseline). Preview runs apply → validate dirty set → roll back,
all under ``session.write_mutex`` (spec §11). This module deliberately imports
those module-private helpers — they are part of the ops package's internal
surface, shared with this sibling. The artifact delta is likewise not built
here: ``artifact_ops.artifact_delta_headers`` /
``artifact_ops.broadcast_artifact_events`` are shared with POST /model/undo,
over the single ``artifact_header`` row->header projection the artifact CRUD
routes use (``routes/artifacts._header`` is an alias of it) — same fields on
created, updated AND deleted events, so no two write paths can drift.

Since the Phase 1 artefacts revamp a commit can carry artifact ops as well as
model ops (``artifact_ops.split_ops`` separates the two families). Model ops
mutate the in-memory model; artifact ops stage DB rows — see
``create_commit``'s docstring for how the two are kept atomic.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Iterable
from typing import Any, assert_never, get_args

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from data_rover.core.model.model import Model
from data_rover.core.validation.issue import IssueCategory
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.view.schema import View

from ..artifact_ops import (
    ARTIFACT_OP_KINDS,
    apply_artifact_ops,
    artifact_delta_headers,
    broadcast_artifact_events,
    split_ops,
    validate_artifact_ops,
)
from ..authz import require_membership
from ..commit_diff import diff_commit
from ..feed import commit_event, lock_event
from .. import content
from ..db import get_db
from ..db_models import Commit, Membership, User
from ..deps import Session, get_request_session, require_model
from ..hydration import deserialize_ops, reconstruct_model_at
from ..identity import get_current_user
from ..invalidation import touched_keys
from ..locking import ARTIFACT_PREFIX, required_locks
from ..settings import get_settings
from ..view_ops import (
    ViewBatchResult,
    apply_view_ops_atomic,
    load_or_create_view,
    rollback_view,
    validate_view_ops,
    view_touched_resources,
)
from ..schemas import (
    ArtifactOpIn,
    CommitDiffOut,
    CommitHistoryResponse,
    CommitRequest,
    CommitResponse,
    CommitSummaryOut,
    CreateArtifactOp,
    CreateElementOp,
    CreateFolderOp,
    CreateRelationshipOp,
    DeleteArtifactOp,
    DeleteElementOp,
    DeleteFolderOp,
    DeleteRelationshipOp,
    ElementOut,
    IssueOut,
    ModelOpIn,
    ModelOut,
    MoveArtifactOp,
    MoveElementOp,
    MoveFolderOp,
    OpenResponse,
    OpIn,
    PlaceArtifactOp,
    PlaceElementOp,
    PreviewRequest,
    PreviewResponse,
    RelationshipOut,
    RemoveArtifactOp,
    RemoveElementOp,
    RenameFolderOp,
    RevertRequest,
    UpdateArtifactOp,
    UpdateElementOp,
    UpdateRelationshipOp,
    VIEW_OP_ADAPTER,
    VIEW_OP_KINDS,
)
from ..session import AppliedBatch
from .ops import (
    TEMP_ID_PREFIX,
    _apply_batch,
    _ensure_validation_seeded,
    _maybe_periodic_snapshot,
    _persist_commit,
    _rollback,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _id_field_names(op_types: Iterable[Any]) -> frozenset[str]:
    """Field names that carry a resource id, DERIVED from the op models.

    ``_affected_ids`` scans RAW journal dicts (``Commit.ops`` JSON), so it
    cannot lean on ``assert_never`` the way the typed appliers do — and a
    hand-maintained tuple of field names is exactly the kind of list that
    silently stops covering the union: add an op kind, or an id-bearing field
    to an existing one, and the conflict backstop quietly under-reports, which
    turns a real conflict into a lost update with no test and no type error.
    Deriving from ``model_fields`` closes that gap: the union members below are
    read straight off ``ModelOpIn``/``ArtifactOpIn``, so a new op kind is
    covered the moment it joins the union.

    The naming rule (``id`` or ``*_id``) errs toward OVER-reporting, which is
    the safe direction here: a spurious key can only add ids to the touched
    set — i.e. produce a conservative 409 — never hide one.
    """
    return frozenset(
        name
        for op_type in op_types
        for name in op_type.model_fields
        if name == "id" or name.endswith("_id")
    )


#: op-dict keys that carry a resource id, per family. In CANONICAL stored ops
#: every one of these holds a real id — a create op's ``temp_id`` was rewritten
#: to the assigned canonical id at apply time (see session.py / _apply_one and
#: artifact_ops.apply_artifact_ops).
_MODEL_ID_KEYS = _id_field_names(get_args(ModelOpIn))
_ARTIFACT_ID_KEYS = _id_field_names(get_args(ArtifactOpIn))


def _affected_ids(commits: list[Commit]) -> set[str]:
    """Resource ids touched by the forward AND inverse ops of these commits.

    Used by revert's peer-lock guard (any active lease over one of these ids
    means a peer is mid-edit on something the revert would change, so the
    revert is refused (409) rather than stomping their uncommitted work) AND
    by the generalized conflict backstop in ``create_commit``, which
    intersects this against ``_batch_touched_ids``. Artifact ids are
    prefixed with the ``art:`` lease namespace so the two sets — and lease
    resource ids generally — compare directly; model ids stay bare (the
    pre-existing wire format).

    Reads BOTH ``c.ops`` and ``c.inverse_ops``, not just the forward half: a
    containment ``delete_element`` cascades to every descendant element and
    incident relationship, but its FORWARD op only names the root id — the
    cascade victims surface exclusively in the INVERSE unit's
    ``create_element``/``create_relationship`` ops (``temp_id`` = the
    original id; see ``ops.py``'s ``DeleteElementOp`` branch, which snapshots
    the closure before deleting). Skipping ``inverse_ops`` would let a stale
    batch that touches a cascade victim slip past the overlap check here (and
    fail later, at the mutation boundary, as a 422 instead of a clean 409) —
    or, for revert's guard, let a peer's lease on a cascade victim go
    unnoticed. The same argument covers ``delete_folder``: its subtree
    victims surface only via the inverse unit's ``create_folder`` ops (see
    ``view_ops._recreate_ops``).

    View ops are DESERIALIZED into typed models rather than scanned by raw
    key, unlike the model/artifact branches above: ten op kinds carry
    heterogeneous id-field namespaces (an ``element_id`` must land in the
    ``viewel:`` marker namespace, not the bare ``folder:`` one an ``id`` or
    ``folder_id`` field uses), so a single flat key-name scan would either
    conflate them or miss the placement-subject markers entirely. Tail
    commits are few and small, so the extra validation cost here is noise.
    """
    ids: set[str] = set()
    for c in commits:
        for op in (*c.ops, *c.inverse_ops):
            kind = op.get("kind")
            if kind in VIEW_OP_KINDS:
                ids |= view_touched_resources(VIEW_OP_ADAPTER.validate_python(op))
                continue
            if kind in ARTIFACT_OP_KINDS:
                for key in _ARTIFACT_ID_KEYS:
                    v = op.get(key)
                    if isinstance(v, str):
                        ids.add(ARTIFACT_PREFIX + v)
                continue
            for key in _MODEL_ID_KEYS:
                v = op.get(key)
                if isinstance(v, str):
                    ids.add(v)
    return ids


def _batch_touched_ids(model: Model, view: View | None, ops: list[OpIn]) -> set[str]:
    """Conservative touched-set for the conflict backstop (spec 2026-07-29):
    a batch conflicts with the commit tail iff their touched-id sets overlap.

    Starts from ``required_locks`` — the same per-op resource derivation the
    lock table already trusts to gate concurrent edits — then adds the raw
    ids locks deliberately abstract away: a relationship update/delete locks
    only its SOURCE element (the two are inseparable for editing purposes),
    but the journal records the relationship's OWN id, so a peer batch that
    only names that relationship id (e.g. a second delete of the same
    relationship) must still register as touching it. A create's temp id
    never appears in `_affected_ids` (canonical ops carry the assigned id),
    so temp ids are filtered out at the end rather than tracked specially.
    ``view`` is threaded straight through to ``required_locks`` (Task 6) so
    folder-op lease derivation resolves correctly; the view ops themselves
    additionally run through ``view_ops.view_touched_resources`` below, which
    contributes the placement-subject markers (``viewel:``/``viewart:``) no
    lease ever carries — two batches fighting over the SAME element's/
    artifact's placement must still conflict even when the folders they name
    are disjoint.

    MUST be conservative: under-reporting a touched resource here is exactly
    the failure mode the backstop exists to prevent (a real conflict would
    silently land instead of 409ing), so every op kind that carries an id
    that could ever collide with a peer's is covered — the two CREATE kinds
    (``CreateElementOp``, ``CreateArtifactOp``) are the only ones with no
    server-known id at all until apply time, and they say so EXPLICITLY
    below: the chain ends in ``assert_never`` so a seventh op kind is a
    type error here rather than a silent hole (same discipline
    ``_apply_one``'s ``assert_never`` gives the applier).
    """
    ids = {r.resource_id for r in required_locks(model, view, ops)}
    for op in ops:
        if isinstance(
            op,
            (
                UpdateElementOp,
                DeleteElementOp,
                UpdateRelationshipOp,
                DeleteRelationshipOp,
            ),
        ):
            ids.add(op.id)
        elif isinstance(op, CreateRelationshipOp):
            ids.add(op.source_id)
            ids.add(op.target_id)
        elif isinstance(op, (UpdateArtifactOp, DeleteArtifactOp)):
            ids.add(ARTIFACT_PREFIX + op.id)
        elif isinstance(op, (CreateElementOp, CreateArtifactOp)):
            # deliberate no-op: a create names no id a PEER could also be
            # touching (its temp id is batch-local and stripped below).
            pass
        elif isinstance(
            op,
            (
                CreateFolderOp,
                RenameFolderOp,
                MoveFolderOp,
                DeleteFolderOp,
                PlaceElementOp,
                RemoveElementOp,
                MoveElementOp,
                PlaceArtifactOp,
                RemoveArtifactOp,
                MoveArtifactOp,
            ),
        ):
            # delete_folder's subtree is already covered: required_locks
            # expanded it against the live view above.
            ids |= view_touched_resources(op)
        else:
            assert_never(op)
    # Strip batch-local temp ids: they never appear in _affected_ids (canonical
    # stored ops always carry the assigned id, never the batch-local one), so
    # a temp id here can never overlap a real journal id and only adds noise.
    # This runs AFTER the art: prefixing above, so a same-batch update/delete
    # of an artifact created earlier IN THIS batch by temp id would strip to
    # "art:tmp_x", not "tmp_x" — harmless: required_locks already exempts
    # same-batch-created artifacts from needing a lease at all (see its
    # `created` set), so that id never reaches this filter in practice, and
    # even if it did, "art:tmp_x" still can't collide with a bare canonical id.
    # A batch-local folder create similarly strips to "folder:tmp_x" /
    # "viewel:tmp_x" (a placement into a folder created earlier in the SAME
    # batch) — neither STARTS WITH tmp_ (the prefix check below looks at the
    # whole string), so they survive this filter, but for the identical
    # harmlessness reason: a namespaced batch-local id can never collide with
    # a bare canonical journal id either.
    return {i for i in ids if not i.startswith(TEMP_ID_PREFIX)}


def _conflict_response(model_rev: int, detail: str) -> JSONResponse:
    """The uniform 409 envelope every staleness/overlap fallback in
    ``create_commit`` returns — factored out so that branch structure (see
    its docstring: no-journal / short-tail / baseline-or-rebind / overlap)
    reads at a glance instead of four near-identical ``JSONResponse`` blocks.

    Single-instance assumption: the completeness reasoning behind these
    branches (one journaled batch == one rev == one row) holds because ONE
    process owns the session and its journal writes. Multi-instance
    deployment is Phase 7's debt, shared with ``LockTable``."""
    return JSONResponse(
        status_code=409,
        content={"detail": detail, "model_rev": model_rev},
    )


@router.get("/open", response_model=None)
def open_project(
    session: Session = Depends(get_request_session),
    membership: Membership = Depends(require_membership),
) -> OpenResponse:
    _, model = require_model(session)
    state = _ensure_validation_seeded(session, model)
    return OpenResponse(
        model_rev=session.model_rev,
        role=membership.role.value,
        element_count=len(model.elements),
        relationship_count=len(model.relationships),
        issue_counts=state.counts(),
        lock_ttl_seconds=get_settings().lock_ttl_seconds,
        strict_mode=session.strict_mode,
    )


@router.post("/commits/preview", response_model=None)
def preview_commit(
    payload: PreviewRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> PreviewResponse | JSONResponse:
    _, model = require_model(session)
    if payload.base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={"detail": "stale base_rev", "model_rev": session.model_rev},
        )
    model_ops, artifact_ops, view_ops = split_ops(payload.ops)
    # Artifact ops are DB rows, not model content: there is nothing to apply
    # into the model and roll back, so they are checked DRY (422 on an invalid
    # payload / unknown id / name clash, 409 on a stale artifact_rev) and
    # contribute no issues. Deliberately outside the write mutex — it writes
    # nothing and the model is untouched by it.
    validate_artifact_ops(db, project_id, artifact_ops)
    with session.write_mutex:
        # View ops are validated DRY against a deep copy (views are small):
        # nothing to roll back, and sharing the real applier means preview and
        # commit cannot disagree. Inside the mutex because a concurrent commit
        # mutates session.view in place. Guarded on view_ops: an EMPTY batch
        # would still deep-copy session.view (validate_view_ops' None-view
        # short-circuit only helps a project with no view at all) on every
        # model-only preview, which is the common case — pure overhead with
        # nothing to validate.
        if view_ops:
            # Resolve the SAME durable-vs-cached view create_commit's own
            # pre-mutex resolve now uses (final-review round 2, Finding C):
            # a None session.view does NOT mean "no durable view" — it can
            # mean a prior DELETE /view merely cleared the cache while
            # ViewRow survives (see load_or_create_view's docstring) — so
            # validating against validate_view_ops' own None-view fallback
            # (a FRESH EMPTY view) here would let preview 422 "unknown
            # folder" on a batch the real commit, which hydrates the durable
            # blob, actually accepts. Resolved into a LOCAL, never assigned
            # to session.view: preview must stay side-effect-free (no
            # persist, no rev bump, no cache mutation) — only create_commit
            # is allowed to materialize the auto-create/hydrate into the
            # session itself.
            preview_view = (
                session.view
                if session.view is not None
                else load_or_create_view(db, project_id)
            )
            validate_view_ops(preview_view, view_ops)
        # _apply_batch raises 422 on a mutation-boundary structural error
        # (unknown type, missing endpoint, unknown property) — the safety net.
        res = _apply_batch(model, model_ops, restore=False)
        try:
            scoped = default_pipeline().validate(model, res.dirty.to_scope())
        finally:
            _rollback(model, res.inverse_units)  # always restore the model
            # The in-place apply-then-rollback leaves model_rev unchanged, so a
            # concurrent lock-free /tables/evaluate could have cached rows AND
            # script cell values computed mid-preview at this rev (final-review
            # A1/I1). Invalidate both caches and the sweeps behind them.
            session.invalidate_derived_caches()
    structural = [i for i in scoped if i.category is IssueCategory.STRUCTURAL]
    conformance = [i for i in scoped if i.category is IssueCategory.CONFORMANCE]
    return PreviewResponse(
        conformance_error_count=len(conformance),
        structural_blockers=[IssueOut.from_core(i) for i in structural],
        issues=[IssueOut.from_core(i) for i in scoped],
        would_block=session.strict_mode and len(conformance) > 0,
    )


@router.get("/commits", response_model=None)
def list_commits(
    project_id: str,
    limit: int = 50,
    before_rev: int | None = None,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> CommitHistoryResponse:
    """Durable commit history, newest-first (distinct from GET /model/changes,
    which reports the capped in-memory op_log). Read endpoint — any member.

    The ``session`` dependency ensures the caller is an authenticated project
    member (``get_request_session`` depends on ``require_membership``). No
    write-allowlist entry is needed because reads are open to all roles.

    Pagination: pass ``before_rev=<last_rev_on_page>`` to fetch older commits.
    ``limit`` is clamped to [1, 200] to bound response sizes.
    """
    limit = max(1, min(limit, 200))
    rows = content.list_commits(db, project_id, before_rev=before_rev, limit=limit + 1)
    has_more = len(rows) > limit
    rows = rows[:limit]
    return CommitHistoryResponse(
        commits=[
            CommitSummaryOut(
                rev=r.rev,
                commit_id=r.commit_id,
                author_id=r.author_id,
                ts=r.ts,
                message=r.message,
                validation_error_count=r.validation_error_count,
                op_count=len(r.ops),
                is_rebind=(
                    r.from_metamodel_id is not None or r.to_metamodel_id is not None
                ),
            )
            for r in rows
        ],
        has_more=has_more,
    )


@router.get("/commits/{rev}/model", response_model=None)
def model_at_rev(
    rev: int,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ModelOut | JSONResponse:
    """Reconstruct the FULL model as it existed at ``rev`` (Phase 8 diffs).

    Read endpoint — any member (history is readable by viewers). O(model)
    response, like GET /model and the /compare page; the client diffs two of
    these with ``computeDiff``. Reconstruction reads durable content directly,
    so it is correct for cold/evicted projects.
    """
    model_row = content.get_model_row(db, project_id)
    head = model_row.model_rev if model_row is not None else 0
    if rev < 0 or rev > head:
        return JSONResponse(
            status_code=422,
            content={"detail": "rev out of range", "model_rev": head},
        )
    model = reconstruct_model_at(project_id, rev)
    if model is None:
        return ModelOut(elements=[], relationships=[])
    return ModelOut.from_core(model)


@router.get("/commits/{rev}/diff", response_model=None)
def commit_diff_endpoint(
    rev: int,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> CommitDiffOut | JSONResponse:
    """Render one commit's changes across content families (Phase 1 artefacts
    revamp).

    Read endpoint — any member (the ``session`` dependency only establishes
    membership, exactly like GET /commits above). O(model) like
    GET /commits/{rev}/model, since the model half reconstructs both sides; the
    artifact half is journal-only. The rendering itself lives in
    ``commit_diff.diff_commit`` so the future change-request workflow can point
    it at a draft instead of a commit row.
    """
    row = content.get_commit(db, project_id, rev)
    if row is None:
        return JSONResponse(
            status_code=404, content={"detail": "no commit at this rev"}
        )
    return diff_commit(db, project_id, row)


@router.post("/commits", response_model=None)
def create_commit(
    payload: CommitRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CommitResponse | JSONResponse:
    """Lock-verified, structural-gated commit (Phase 4 spec §7).

    Flow:
    1. Staleness check (before the mutex — mirrors preview and apply_ops).
       A future ``base_rev`` always 409s. A behind-head ``base_rev`` uses the
       GENERALIZED rule (spec 2026-07-29): the batch conflicts iff the
       resources it touches overlap what landed in ``(base_rev, head]`` — see
       ``_batch_touched_ids``/``_affected_ids``. Leases already prevent most
       conflicts up front; this is the backstop for the window where the
       legacy unlocked ``/model/ops`` path and this lock-verified path
       coexist, so a stale-but-non-overlapping batch lands instead of being
       rejected.

       This requires the durable journal to fully explain the gap between
       ``base_rev`` and head, so several fallbacks fail CLOSED (409 "stale
       base_rev") rather than risk a silent false negative:
         - no durable journal to inspect at all (in-memory-only project);
         - the tail is SHORTER than the rev gap — the completeness invariant
           (one journaled batch == one rev == one row, spelled out at the
           check itself below) means a short tail can only mean some rev in
           the gap advanced without a journal row (``Session.touch_model()``,
           the legacy unlocked mutation routes, or ``set_model(...)`` — model
           load/clear and CR-apply, which passes the replacement model and
           its spliced validation state in), so there is no way to know what
           it touched;
         - a rebind is in the tail (the metamodel changed under the client,
           so its element ops were computed against a schema that no longer
           exists);
         - an EMPTY-ops commit is in the tail that still consumed a rev —
           ``persist_baseline``'s marker for "the whole model was replaced
           opaquely" (model upload/clear/apply-cr baseline reset). The tail
           fully accounts for the rev gap here, but names no resources at
           all, so the overlap check alone would find nothing and let a
           stale batch land against a wholesale-replaced model.
       Only once none of these apply does the overlap check itself run.
    2. Seed the validation baseline.
    3. Under the write mutex:
       a. Verify the caller still holds every required lock (409 if any gone).
       b. Apply the model ops (422 on mutation-boundary error from
          _apply_batch), then the artifact ops (staged on this request's DB
          transaction).
       b3. Apply the view half (all-or-nothing via apply_view_ops_atomic) —
          auto-creating an empty view for a project that never had one.
       c. Hard-reject structural blockers (422; rolls back all three halves).
       d. Splice conformance issues into the issue store, bump rev, record batch.
       e. Persist to the durable journal (500 + full rollback on failure); the
          view blob (if touched) is staged on the SAME DB transaction as the
          Commit row, so both land or neither does.
       f. Periodic snapshot (mirrors apply_ops to bound replay tail).
       g. Release the caller's locks (explicit loop).
       h. Broadcast commit delta + artifact + lock-release events (inside mutex
          for enqueue-order == rev-order guarantee; broadcast is non-blocking).
    4. Return CommitResponse with full delta + commit metadata.

    Mixed-batch atomicity (Phase 1 artefacts revamp; view half added Phase 2)
    ---------------------------------------------------------------------
    A batch can span all three content families, and each lives in a
    different place: model ops mutate the in-memory model IN PLACE, artifact
    ops stage row changes on this request's DB transaction, and view ops
    mutate ``session.view`` IN PLACE plus (once accepted) stage a blob row on
    the same DB transaction as the artifact rows. So every failure path after
    an apply has to undo however many halves are live — ``_rollback(model,
    res.inverse_units)`` + ``session.invalidate_derived_caches()`` for the
    model half, ``db.rollback()`` for the artifact half (and the staged view
    row, once one exists), and ``rollback_view(session.view,
    view_res.inverse_units)`` for the view half. ``apply_artifact_ops``
    deliberately has no internal rollback path (it only flushes), so that
    ``db.rollback()`` is the ONLY thing that discards staged artifact rows;
    ``apply_view_ops_atomic`` DOES roll its own prefix back on failure (see its
    docstring), so a failure raised BY it never needs an explicit
    ``rollback_view`` call — only failures raised AFTER it succeeded do.
    """
    _, model = require_model(session)
    model_ops, artifact_ops, view_ops = split_ops(payload.ops)
    # True iff THIS request is the one that flipped session.view from None
    # to non-None via load_or_create_view — tracked so every early-return OR
    # failure path below can restore it to None rather than leaving a
    # never-committed materialization behind. A REJECTED (409/422/500)
    # request must be externally invisible: before this request GET /view
    # reported whatever it reported, and any return out of this function
    # must leave it reporting that again — for the genuinely-empty case, not
    # a materialized empty view with no ViewRow / view_rev to back it
    # (final-review Finding 1, and round 2's Finding A/B extend this same
    # guard to the resolve-view call site inside the mutex below).
    #
    # INVARIANT (final-review round 3): every ASSIGNMENT to session.view in
    # this function happens under session.write_mutex — the single point is
    # just inside the mutex below, right before required_locks. A pre-mutex
    # READ into a LOCAL (the overlap check just below needs one) is fine and
    # does NOT violate this — only writing session.view itself, or resetting
    # it, must wait for the mutex. Two concurrent view-op commits assigning
    # session.view outside the mutex could otherwise race a check-then-set
    # (a lost update: A reads ViewRow, is descheduled while B hydrates,
    # commits and persists, then A assigns its now-stale View over B's,
    # silently overwriting B's folders at A's own persist step) or have
    # one request's pre-mutex reset (on a rejected/failed early return) null
    # session.view out from under a DIFFERENT request already inside the
    # mutex, tripping its own `assert session.view is not None` mid-flight.
    created_view = False
    if payload.base_rev > session.model_rev:
        return _conflict_response(session.model_rev, "stale base_rev")
    if payload.base_rev < session.model_rev:
        # Generalized staleness (spec 2026-07-29) — see the docstring above
        # for the full rationale; branch order mirrors it: no-journal /
        # short-tail / baseline-or-rebind / overlap, cheapest-and-safest
        # first, each a fail-closed 409 before the real overlap check runs.
        if content.get_model_row(db, project_id) is None:
            return _conflict_response(session.model_rev, "stale base_rev")
        tail = content.commits_after(db, project_id, payload.base_rev)
        if len(tail) != session.model_rev - payload.base_rev:
            # Completeness invariant (db_models.Commit's own docstring: "one
            # accepted ops batch == one revision == one journal row"): every
            # journaled batch bumps model_rev by exactly 1 and writes exactly
            # 1 row (create_commit/undo/revert each do both under the same
            # mutex). So a FULL tail always has len(tail) == head - base_rev.
            # A SHORT tail means some rev in the gap moved without a journal
            # row at all — e.g. touch_model() (legacy PATCH/POST/DELETE
            # mutation routes) or set_model() (model load/clear, and CR-apply,
            # which passes the replacement model in) — so there
            # is nothing to inspect for that rev and no way to know it didn't
            # touch this batch's resources. Fail closed.
            return _conflict_response(session.model_rev, "stale base_rev")
        if any(
            c.from_metamodel_id is not None
            or c.to_metamodel_id is not None
            or not c.ops
            for c in tail
        ):
            # Two distinct always-conflict cases, same treatment: a rebind
            # changed the metamodel under the client (its element ops were
            # computed against a schema that no longer exists), and an
            # EMPTY-ops commit that still consumed a rev is
            # persist_baseline's marker for "the whole model was replaced
            # opaquely" (model upload/clear/apply-cr baseline reset — see
            # hydration.persist_baseline). Both fully account for the rev
            # gap (so the short-tail check above doesn't catch them) but
            # name no resources the overlap check could ever match against,
            # so without this branch a stale batch would silently land
            # against a metamodel/model that no longer matches what it was
            # computed against.
            return _conflict_response(session.model_rev, "stale base_rev")
        # Resolve a LOCAL view for the overlap check ONLY, immediately
        # before the one check in this block that needs it (final-review
        # round 2, Finding A) — not any earlier, so the three fail-closed
        # checks above (which never consult view content at all) can never
        # trigger an unnecessary hydration on their own return paths.
        # _batch_touched_ids -> required_locks' folder_subtree/locate_folder
        # expansion degrades to a bare single-resource id against a
        # ``None`` view, exactly like the applier itself would under-derive
        # a lock against an unresolved tree — so without resolving first, a
        # stale delete_folder/move_folder batch's conflict/touched-set here
        # would be computed against the WRONG (empty/absent) tree relative
        # to what the real, hydrated one actually contains. NEVER assigned
        # to session.view here (final-review round 3: this whole block runs
        # BEFORE the mutex, so a write here would be the exact race the
        # invariant note above create_commit's mutex now forbids) — mirrors
        # preview_commit's own local, read-only resolve.
        conflict_view = (
            session.view
            if session.view is not None
            else load_or_create_view(db, project_id)
        )
        if _affected_ids(tail) & _batch_touched_ids(model, conflict_view, payload.ops):
            return _conflict_response(
                session.model_rev, "conflicting concurrent commits"
            )
    state = _ensure_validation_seeded(session, model)
    if not payload.ops:
        # Empty batch: nothing to apply. Mirrors apply_ops' and revert's
        # no-op early returns — current state, no rev bump, no undo slot. It
        # matters MORE here than there: an empty-ops journal row is
        # persist_baseline's marker for "the whole model was replaced
        # opaquely", which the staleness guard above reads as an
        # unconditional 409 for every client below that rev. A message-only
        # "checkpoint" commit would therefore permanently disable the overlap
        # rule for the project — fail-closed, but wrong. Keeping the invariant
        # (empty ops in the journal ⟺ opaque baseline reset) true is this
        # branch's real job; the saved rev is a bonus.
        return CommitResponse(
            model_rev=session.model_rev,
            id_map={},
            changed_elements=[],
            changed_relationships=[],
            deleted_element_ids=[],
            deleted_relationship_ids=[],
            issues_removed_owner_ids=[],
            issues_added=[],
            issue_counts=state.counts(),
            commit_id="",
            message="",
            validation_error_count=0,
        )
    with session.write_mutex:
        # Resolve/auto-create session.view HERE — the ONLY place this
        # function ever ASSIGNS to it (final-review round 3), now that the
        # pre-mutex overlap check above uses its own read-only local
        # instead. required_locks just below needs it resolved for the same
        # reason that local did: against a ``None`` view, folder_subtree/
        # locate_folder degrade to a bare single-resource id, under-
        # deriving a delete_folder/move_folder's lock requirement relative
        # to the real, hydrated tree the applier goes on to mutate. No
        # try/except needed: this is still the first thing that could
        # mutate anything once the mutex is held (mirrors the reasoning in
        # created_view's docstring above — contrast undo's version of this
        # hoist, which runs after a batch has already been popped).
        if view_ops and session.view is None:
            session.view = load_or_create_view(db, project_id)
            created_view = True
        # a. verify the caller still holds every required lock. `payload.ops`
        #    (not `model_ops`) so the `art:`-namespaced leases artifact ops
        #    need are derived and checked too.
        reqs = required_locks(model, session.view, payload.ops)
        missing = session.lock_table.verify_held(
            user.id, payload.lock_tokens, reqs, now=time.monotonic()
        )
        if missing:
            if created_view:
                # this request's own hydration must not leak into a
                # REJECTED (409) response's visible state — see
                # created_view's docstring above the staleness checks. Safe
                # to reset here: still inside the mutex, so no concurrent
                # request can be mid-flight on the SAME session.view object.
                session.view = None
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "required lock not held",
                    "missing": [
                        {"resource_id": m.resource_id, "mode": m.mode.value}
                        for m in missing
                    ],
                },
            )
        # b. apply the model half (422 on mutation-boundary error — let it
        #    propagate; _apply_batch already rolled itself back and nothing
        #    artifact-side has been staged yet). created_view may already be
        #    True here (the resolve just above), so this needs its own
        #    guard too, unlike round 1's shape where hydration never
        #    happened this early (final-review round 2, Finding B).
        try:
            res = _apply_batch(model, model_ops, restore=False)
        except Exception:
            if created_view:
                session.view = None
            raise
        # b2. apply the artifact half, staged on this request's DB transaction.
        #     Seeded with the model id_map so an artifact payload may reference
        #     an element created earlier in the SAME batch. On failure both
        #     halves are undone (see the docstring's atomicity note).
        try:
            art_res = apply_artifact_ops(
                db,
                project_id,
                artifact_ops,
                user_id=user.id,
                id_map=dict(res.id_map),
                restore=False,
            )
        except Exception:
            # Broad on purpose, mirroring _apply_batch's stance: the expected
            # rejections are HTTPException 422/409, but an UNforeseen error
            # (a DB failure, a bug) must not be the one case that leaves the
            # model half-mutated. Undo both halves, then let it propagate.
            _rollback(model, res.inverse_units)
            session.invalidate_derived_caches()  # rolled back in place; A1/I1
            if created_view:
                session.view = None  # see created_view's docstring above
            db.rollback()  # discard staged artifact rows
            raise
        # b3. apply the view half to session.view IN PLACE, all-or-nothing
        #     (session.view was already resolved near the top of this SAME
        #     mutex block whenever view_ops is non-empty; created_view was
        #     set there too). Seeded with both prior id_maps so a placement
        #     may reference an element or artifact created earlier in the
        #     SAME batch.
        view_res: ViewBatchResult | None = None
        if view_ops:
            if session.view is None:
                # Defensive fallback only: the resolve near the top of this
                # SAME mutex block already hydrated/auto-created
                # session.view whenever view_ops is non-empty, so this
                # branch is dead in the ordinary case. It stays for the one
                # race that block cannot close even from inside the mutex:
                # routes/view.py's ``DELETE /view`` is deliberately out of
                # scope and takes NO lock at all (not even session.write_
                # mutex), so a peer's concurrent DELETE could null
                # session.view again between this request's own resolve and
                # here, despite this request holding the mutex the entire
                # time.
                session.view = load_or_create_view(db, project_id)
                created_view = True
            try:
                view_res = apply_view_ops_atomic(
                    session.view,
                    view_ops,
                    id_map={**res.id_map, **art_res.id_map},
                    restore=False,
                )
            except Exception:
                # mirror b2's stance: never leave the model half applied.
                _rollback(model, res.inverse_units)
                session.invalidate_derived_caches()
                if created_view:
                    # apply_view_ops_atomic already rolled its own applied
                    # prefix back (to the empty View this request created),
                    # but the auto-create itself must unwind too: the
                    # pre-batch state for THIS project was None, not "".
                    session.view = None
                db.rollback()
                raise
        # c. hard-reject structural blockers. Model content only: an artifact
        #    op's own validity was settled at apply time (b2), and an artifact
        #    row can never make the MODEL structurally invalid.
        scoped = default_pipeline().validate(model, res.dirty.to_scope())
        structural = [i for i in scoped if i.category is IssueCategory.STRUCTURAL]
        if structural:
            _rollback(model, res.inverse_units)
            session.invalidate_derived_caches()  # rolled back in place; A1/I1
            if view_res is not None:
                assert session.view is not None
                rollback_view(session.view, view_res.inverse_units)
            if created_view:
                session.view = None  # unwind the auto-create too — see b3
            db.rollback()  # discard staged artifact rows
            return JSONResponse(
                status_code=422,
                content={
                    "detail": "structural validation blocker",
                    "structural_blockers": [
                        IssueOut.from_core(i).model_dump() for i in structural
                    ],
                },
            )
        # d. commit accepted: splice issues, bump rev, record batch
        conformance = [i for i in scoped if i.category is IssueCategory.CONFORMANCE]
        # strict-mode gate: an owner-enabled project promotes scoped conformance
        # issues to a hard reject (spec: strict mode). Scoped to res.dirty only —
        # pre-existing issues elsewhere never trip this. Rebind has its own route
        # and does not pass through here, so it stays exempt by construction.
        if session.strict_mode and conformance:
            _rollback(model, res.inverse_units)
            session.invalidate_derived_caches()  # rolled back in place; A1/I1
            if view_res is not None:
                assert session.view is not None
                rollback_view(session.view, view_res.inverse_units)
            if created_view:
                session.view = None  # unwind the auto-create too — see b3
            db.rollback()  # discard staged artifact rows
            return JSONResponse(
                status_code=422,
                content={
                    "detail": "strict-mode conformance blocker",
                    "conformance_blockers": [
                        IssueOut.from_core(i).model_dump() for i in conformance
                    ],
                },
            )
        delta = state.replace(res.dirty.ids, scoped)
        session.model_rev += 1
        if get_settings().snippet_incremental_invalidation:
            # Selective eviction: cells this commit provably did not touch
            # stay warm at the new rev (spec 2026-07-21 Phase B).
            session.evict_touched_caches(touched_keys(model, model.metamodel, res))
        else:
            session.invalidate_derived_caches()  # legacy clear-all
        # ONE journal entry per commit, spanning all three families: model
        # ops first, then artifact ops, then view ops (the families are
        # independent, so relative cross-family order carries no meaning —
        # see split_ops). The view id_map is seeded with the model+artifact
        # maps (see b3), so view_res.id_map is already a superset — merging
        # it last is correct and the other two spreads are redundant but
        # harmless, kept for symmetry with undo.
        merged_id_map = {
            **res.id_map,
            **art_res.id_map,
            **(view_res.id_map if view_res else {}),
        }
        canonical_ops: list[OpIn] = [
            *res.canonical_ops,
            *art_res.canonical_ops,
            *(view_res.canonical_ops if view_res else []),
        ]
        inverse_ops: list[OpIn] = [
            *res.inverse_ops(),
            *art_res.inverse_ops(),
            *(view_res.inverse_ops() if view_res else []),
        ]
        session.record_batch(
            AppliedBatch(
                ops=canonical_ops,
                inverse_ops=inverse_ops,
                id_map=merged_id_map,
            )
        )
        # e. persist to the durable journal; mirror apply_ops 500 pattern
        #    exactly. The view blob (if touched) is staged INSIDE this same
        #    try, on the same DB transaction _persist_commit's own
        #    db.commit() will flush — so the view row and the Commit row
        #    land or roll back together. It MUST be inside the try: staging
        #    is a db.flush() (content.upsert_single_view), which can raise
        #    on its own (FK/constraint/connection error) — the same failure
        #    class this try/except exists to catch. Staging it outside would
        #    let that exception escape every rollback below with model_rev
        #    already bumped and the batch already in op_log (final-review
        #    Finding 1).
        commit_id = uuid.uuid4().hex
        issues_json = [IssueOut.from_core(i).model_dump() for i in conformance]
        new_view_rev: int | None = None
        try:
            if view_res is not None and view_res.canonical_ops:
                assert session.view is not None
                view_row = content.upsert_single_view(
                    db,
                    project_id,
                    name=session.view.name,
                    blob=session.view.model_dump_json(),
                )
                new_view_rev = view_row.view_rev
            persisted = _persist_commit(
                db,
                project_id,
                rev=session.model_rev,
                author_id=user.id,
                ops=canonical_ops,
                inverse_ops=inverse_ops,
                id_map=merged_id_map,
                _commit_id=commit_id,
                _message=payload.message,
                _validation_error_count=len(conformance),
                _issues=issues_json,
            )
        except Exception as exc:
            _rollback(model, res.inverse_units)
            session.model_rev -= 1
            session.invalidate_derived_caches()  # rolled back in place; A1/I1
            if view_res is not None:
                assert session.view is not None
                rollback_view(session.view, view_res.inverse_units)
            if created_view:
                session.view = None  # unwind the auto-create too — see b3
            session.op_log.pop()
            db.rollback()  # also discards the staged artifact + view rows
            raise HTTPException(
                status_code=500, detail="failed to persist commit"
            ) from exc
        if (artifact_ops or view_ops) and not persisted:
            # No durable model row (in-memory-only legacy project), so
            # _persist_commit skipped its db.commit() — but artifact rows are
            # real DB state that must not silently vanish when the request
            # session closes. Commit them on their own; the journal entry is
            # the only thing this project forgoes.
            db.commit()
        # f. periodic snapshot: mirrors apply_ops so a hot commit-only project
        #    doesn't accumulate an unbounded replay tail. The durable commit has
        #    already landed; a snapshot failure here is recoverable (hydration
        #    rebuilds the snapshot on the next cache-miss), so we log and proceed
        #    rather than returning a 500 that would mislead the client into
        #    thinking the commit failed.
        if persisted:
            try:
                _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
            except Exception:
                logger.warning(
                    "post-commit snapshot failed for project %s at rev %s; "
                    "commit is durable, hydration will rebuild",
                    project_id,
                    session.model_rev,
                    exc_info=True,
                )
        # f2. artifact half of the response/feed delta — shared with
        #     POST /model/undo so both write paths are wire-identical (see
        #     artifact_ops.artifact_delta_headers for the re-read rationale).
        changed_artifact_headers, created_artifact_ids = artifact_delta_headers(
            db, art_res
        )
        # g. release the caller's locks (explicit loop — no helper)
        released = []
        for tok in payload.lock_tokens:
            released.extend(session.lock_table.release(user.id, tok))
        # h. broadcast commit delta + artifact + lock-release events (inside the
        #    mutex so enqueue order == rev order across concurrent commits).
        changed_elements = [
            ElementOut.from_core(model.elements[eid]).model_dump()
            for eid in res.changed_element_ids
        ]
        changed_relationships = [
            RelationshipOut.from_core(model.relationships[rid]).model_dump()
            for rid in res.changed_relationship_ids
        ]
        # an empty batch touched no family; report it as "model" so the scope
        # list is never empty and peers keep their existing behaviour.
        scope = sorted(
            ({"model"} if model_ops else set())
            | ({"artifact"} if artifact_ops else set())
            | ({"view"} if view_ops else set())
        ) or ["model"]
        session.hub.broadcast(
            commit_event(
                rev=session.model_rev,
                commit_id=commit_id,
                author_id=user.id,
                message=payload.message,
                validation_error_count=len(conformance),
                scope=scope,
                changed_elements=changed_elements,
                changed_relationships=changed_relationships,
                deleted_element_ids=list(res.deleted_element_ids),
                deleted_relationship_ids=list(res.deleted_relationship_ids),
            )
        )
        broadcast_artifact_events(
            session.hub, changed_artifact_headers, created_artifact_ids, art_res.deleted
        )
        if released:
            session.hub.broadcast(
                lock_event(
                    "released",
                    [
                        {
                            "resource_id": le.resource_id,
                            "mode": le.mode.value,
                            "holder_id": le.holder,
                        }
                        for le in released
                    ],
                )
            )
    return CommitResponse(
        model_rev=session.model_rev,
        id_map=merged_id_map,  # both families' temp ids in one map
        changed_elements=[
            ElementOut.from_core(model.elements[eid]) for eid in res.changed_element_ids
        ],
        changed_relationships=[
            RelationshipOut.from_core(model.relationships[rid])
            for rid in res.changed_relationship_ids
        ],
        deleted_element_ids=list(res.deleted_element_ids),
        deleted_relationship_ids=list(res.deleted_relationship_ids),
        issues_removed_owner_ids=delta.removed_owner_ids,
        issues_added=[IssueOut.from_core(i) for i in delta.added],
        issue_counts=state.counts(),
        commit_id=commit_id,
        message=payload.message,
        validation_error_count=len(conformance),
        changed_artifacts=changed_artifact_headers,
        deleted_artifact_ids=[d["id"] for d in art_res.deleted],
        view_rev=new_view_rev,
    )


@router.post("/commits/revert", response_model=None)
def revert_commit(
    payload: RevertRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CommitResponse | JSONResponse:
    """Revert the model to the state at ``target_rev`` (Phase 8 spec §3.2).

    Mechanism (the proven POST /model/undo compensating-commit shape, applied
    to a *range*): apply the inverse_ops of every commit after target_rev,
    newest-first, in restore mode, recorded as ONE new forward commit. The
    journal stays append-only; model_rev only moves forward; the revert is
    itself revertible.

    Guards (Tasks 5–7) are layered on top of this core; broadcast is Task 8.
    """
    _, model = require_model(session)
    if payload.base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={"detail": "stale base_rev", "model_rev": session.model_rev},
        )
    state = _ensure_validation_seeded(session, model)
    if payload.target_rev < 0 or payload.target_rev > session.model_rev:
        return JSONResponse(
            status_code=422,
            content={
                "detail": "target_rev out of range",
                "model_rev": session.model_rev,
            },
        )
    if payload.target_rev == session.model_rev:
        # no-op: nothing to revert. Mirror the empty-batch path in apply_ops —
        # return current state WITHOUT bumping model_rev or recording a commit.
        return CommitResponse(
            model_rev=session.model_rev,
            id_map={},
            changed_elements=[],
            changed_relationships=[],
            deleted_element_ids=[],
            deleted_relationship_ids=[],
            issues_removed_owner_ids=[],
            issues_added=[],
            issue_counts=state.counts(),
            commit_id="",
            message="",
            validation_error_count=0,
        )
    with session.write_mutex:
        commits = content.commits_after(db, project_id, payload.target_rev)
        for c in commits:
            if c.from_metamodel_id is not None or c.to_metamodel_id is not None:
                return JSONResponse(
                    status_code=409,
                    content={
                        "detail": "revert across a metamodel swap is not yet supported",
                        "rebind_rev": c.rev,
                    },
                )
        for c in commits:
            # Deliberate Phase-1 boundary, not a stub: reverting an artifact
            # change means replaying row state a range of commits deep, and
            # ``ArtifactRow`` names are UNIQUE per (project, kind) — a range
            # revert can therefore collide with rows created after the target
            # rev in ways a single undo step never can. Refused as a clean 409
            # (a conflict, like the rebind and peer-lock refusals around it)
            # naming the offending commit, checked on the RAW journal dicts so
            # it fires before anything is deserialized or applied.
            if any(op.get("kind") in ARTIFACT_OP_KINDS for op in c.ops):
                return JSONResponse(
                    status_code=409,
                    content={
                        "detail": "revert across artifact changes is not yet supported",
                        "artifact_commit_rev": c.rev,
                    },
                )
        for c in commits:
            # PERMANENT refusal (not a Task-N stub, unlike the artifact one
            # above): a range revert over view changes has the same row-
            # identity collision hazard the artifact refusal exists for
            # (folder ids reused after the target rev), and the view family
            # has no plan to lift this boundary.
            if any(op.get("kind") in VIEW_OP_KINDS for op in c.ops):
                return JSONResponse(
                    status_code=409,
                    content={
                        "detail": "revert across view changes is not yet supported",
                        "view_commit_rev": c.rev,
                    },
                )
        affected = _affected_ids(commits)
        held = [
            le
            for le in session.lock_table.active_leases(time.monotonic())
            if le.resource_id in affected
        ]
        if held:
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "resource locked by a peer",
                    "conflicts": [
                        {
                            "resource_id": le.resource_id,
                            "mode": le.mode.value,
                            "holder_id": le.holder,
                        }
                        for le in held
                    ],
                },
            )
        # apply inverse_ops newest-first; deserialize the stored JSON op dicts.
        # split_ops is here as the TYPE narrowing only (deserialize_ops answers
        # the full OpIn union while _apply_batch takes model ops): the guards
        # above already proved the artifact AND view halves empty, since an
        # op's inverse is always in its own family.
        combined, artifact_combined, view_combined = split_ops(
            deserialize_ops([op for c in reversed(commits) for op in c.inverse_ops])
        )
        if artifact_combined or view_combined:
            # Unreachable while the 409 guards above stand. An explicit raise
            # rather than an assert: `python -O` strips asserts, and silently
            # dropping artifact/view ops on the floor is precisely the outcome
            # the Phase-1 boundary exists to prevent, so a narrowed guard must
            # fail loudly instead of half-reverting.
            raise HTTPException(
                status_code=500,
                detail="artifact/view ops reached the revert applier",
            )
        res = _apply_batch(model, combined, restore=True)
        scoped = default_pipeline().validate(model, res.dirty.to_scope())
        structural = [i for i in scoped if i.category is IssueCategory.STRUCTURAL]
        if structural:
            _rollback(model, res.inverse_units)
            session.invalidate_derived_caches()  # rolled back in place; A1/I1
            return JSONResponse(
                status_code=422,
                content={
                    "detail": "structural validation blocker",
                    "structural_blockers": [
                        IssueOut.from_core(i).model_dump() for i in structural
                    ],
                },
            )
        conformance = [i for i in scoped if i.category is IssueCategory.CONFORMANCE]
        delta = state.replace(res.dirty.ids, scoped)
        session.model_rev += 1
        session.invalidate_derived_caches()  # mirrors touch_model
        session.record_batch(
            AppliedBatch(
                # list displays, not the raw lists: AppliedBatch is typed over
                # the full OpIn union (mixed batches land here from
                # POST /commits) and list is invariant, so a list[ModelOpIn]
                # is not a list[OpIn].
                ops=[*res.canonical_ops],
                inverse_ops=[*res.inverse_ops()],
                id_map=dict(res.id_map),
            )
        )
        commit_id = uuid.uuid4().hex
        message = payload.message or f"Revert to rev {payload.target_rev}"
        issues_json = [IssueOut.from_core(i).model_dump() for i in conformance]
        try:
            persisted = _persist_commit(
                db,
                project_id,
                rev=session.model_rev,
                author_id=user.id,
                ops=res.canonical_ops,
                inverse_ops=res.inverse_ops(),
                id_map=dict(res.id_map),
                _commit_id=commit_id,
                _message=message,
                _validation_error_count=len(conformance),
                _issues=issues_json,
            )
        except Exception as exc:
            _rollback(model, res.inverse_units)
            session.model_rev -= 1
            session.invalidate_derived_caches()  # rolled back in place; A1/I1
            session.op_log.pop()
            db.rollback()
            raise HTTPException(
                status_code=500, detail="failed to persist commit"
            ) from exc
        if persisted:
            try:
                _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
            except Exception:
                logger.warning(
                    "post-revert snapshot failed for project %s at rev %s; "
                    "commit is durable, hydration will rebuild",
                    project_id,
                    session.model_rev,
                    exc_info=True,
                )
        # broadcast commit delta (mirrors create_commit steps g/h, minus lock
        # release — revert holds no locks and therefore releases none).
        changed_elements = [
            ElementOut.from_core(model.elements[eid]).model_dump()
            for eid in res.changed_element_ids
        ]
        changed_relationships = [
            RelationshipOut.from_core(model.relationships[rid]).model_dump()
            for rid in res.changed_relationship_ids
        ]
        session.hub.broadcast(
            commit_event(
                rev=session.model_rev,
                commit_id=commit_id,
                author_id=user.id,
                message=message,
                # revert refuses batches spanning artifact ops (below), so a
                # revert commit is model-only by construction.
                scope=["model"],
                validation_error_count=len(conformance),
                changed_elements=changed_elements,
                changed_relationships=changed_relationships,
                deleted_element_ids=list(res.deleted_element_ids),
                deleted_relationship_ids=list(res.deleted_relationship_ids),
            )
        )
    return CommitResponse(
        model_rev=session.model_rev,
        id_map=dict(res.id_map),
        changed_elements=[
            ElementOut.from_core(model.elements[eid]) for eid in res.changed_element_ids
        ],
        changed_relationships=[
            RelationshipOut.from_core(model.relationships[rid])
            for rid in res.changed_relationship_ids
        ],
        deleted_element_ids=list(res.deleted_element_ids),
        deleted_relationship_ids=list(res.deleted_relationship_ids),
        issues_removed_owner_ids=delta.removed_owner_ids,
        issues_added=[IssueOut.from_core(i) for i in delta.added],
        issue_counts=state.counts(),
        commit_id=commit_id,
        message=message,
        validation_error_count=len(conformance),
    )
