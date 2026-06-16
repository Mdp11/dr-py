"""POST /model/apply-cr — apply a change request.

Two request modes, selected by the OPTIONAL ``model`` field (Phase C3):

- legacy/inline mode (``model`` present): the CR is applied to the inline
  snapshot; the response carries the full result model + its issue list
  (:class:`ApplyCrResponse`). The session model is never touched. Behavior
  is byte-identical to the pre-C3 endpoint.
- session mode (``model`` absent): the CR is applied to the SESSION model
  (404 when none is loaded); on success the result REPLACES the session
  model and the response is an :class:`OpsResponse`-shaped delta
  (changed/deleted entities + validation-issue delta), so large-model
  clients never receive a full model body.

Conflict (409, ``{"conflicts": [...], "model_rev": ...}`` — same
``model_rev`` field as the ops/undo 409 envelope) and 422-gate semantics
are identical in both modes.
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.change_request import (
    ChangeRequest,
    CRConflictError,
    apply_change_request,
)
from data_rover.core.model.model import Model
from data_rover.core.validation.dirty import change_request_dirty_ids
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState

from ..deps import Session, get_request_session, require_metamodel, require_model
from ..schemas import (
    ApplyCrRequest,
    ApplyCrResponse,
    ElementOut,
    InlineModel,
    IssueOut,
    ModelOut,
    OpsResponse,
    RelationshipOut,
)
from ._snapshot import _build_model_from_payload
from .ops import _ensure_validation_seeded

router = APIRouter()


def _require_endpoint(result: Model, rid: str, role: str, element_id: str) -> None:
    """422 unless *element_id* resolves in the result model."""
    if element_id not in result.elements:
        raise HTTPException(
            status_code=422,
            detail=(f"Relationship {rid!r} references unknown {role} {element_id!r}"),
        )


def _gate_cr_result(
    metamodel: Metamodel, base: Model, result: Model, cr: ChangeRequest
) -> None:
    """422 gate for entities the CR introduced or rewired.

    The inline payload was already gated by ``_build_model_from_payload``, so
    only the CR's delta needs checking (this replaces the former full
    round-trip of the result model through a second payload build):

    - added/modified elements: type must exist and not be abstract
    - added/modified relationships: type must exist, endpoints must resolve
    - deleted elements: no surviving relationship may still reference them

    The last two checks interlock: a relationship rewired onto a deleted
    element is already caught by the added/modified endpoint checks, so the
    deleted-elements loop only needs to walk the relationships incident in
    the BASE model. Note also that the added/modified checks run on every
    listed ``after`` state, so a CR that modifies an entity invalidly AND
    deletes it in the same request is now rejected — more correct than the
    old full-rebuild gate, where the delete silently won and the invalid
    modification went unchecked.
    """
    for el in (*cr.elements_added, *(m.after for m in cr.elements_modified)):
        et = metamodel.element_type(el.type_name)
        if et is None:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown element type {el.type_name!r}",
            )
        if et.abstract:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Element type {el.type_name!r} is abstract and cannot be "
                    f"instantiated"
                ),
            )

    checked_rels = [(r.id, r) for r in cr.relationships_added]
    checked_rels += [(m.id, m.after) for m in cr.relationships_modified]
    for rid, rel in checked_rels:
        if metamodel.relationship_type(rel.type_name) is None:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown relationship type {rel.type_name!r}",
            )
        _require_endpoint(result, rid, "source", rel.source_id)
        _require_endpoint(result, rid, "target", rel.target_id)

    # CR deletes do not cascade: every relationship that touched a deleted
    # element in the base must have been deleted/re-targeted by the CR too
    for e in cr.elements_deleted:
        indexes = base.indexes
        for rid in sorted(indexes.outgoing_ids(e.id) | indexes.incoming_ids(e.id)):
            survivor = result.relationships.get(rid)
            if survivor is None:
                continue
            _require_endpoint(result, rid, "source", survivor.source_id)
            _require_endpoint(result, rid, "target", survivor.target_id)


def _apply_cr_inline(
    session: Session, inline: InlineModel, payload: ApplyCrRequest
) -> ApplyCrResponse | JSONResponse:
    """Legacy mode: apply the CR to an inline snapshot (session untouched).

    Deprecated: superseded by session mode (omit ``model`` from the request)
    — the delta path of the large-model overhaul — which applies the CR to
    the session model and returns an OpsResponse-shaped delta instead of the
    full result model.
    """
    metamodel = require_metamodel(session)
    base = _build_model_from_payload(
        metamodel,
        inline.elements,
        inline.relationships,
    )
    cr = payload.cr.to_core()

    try:
        result = apply_change_request(base, cr)
    except CRConflictError as exc:
        return JSONResponse(
            status_code=409,
            content={
                "conflicts": [asdict(c) for c in exc.conflicts],
                "model_rev": session.model_rev,
            },
        )

    # Same 422 gate as POST /model so that a CR adding an element/relationship
    # with an unknown type_name (etc.) is rejected — but checked on the CR
    # delta only, instead of rebuilding the whole result model a second time.
    _gate_cr_result(metamodel, base, result, cr)

    # Incremental validation: one full pass on the BASE model seeds the issue
    # store, then only the entities the CR could have affected are
    # re-validated on the result and spliced in. The response still carries
    # the full-equivalent issue list for the result model.
    pipeline = default_pipeline()
    state = ValidationState()
    state.set_full(pipeline.validate(base, Scope.all()))
    dirty = change_request_dirty_ids(base, result, cr)
    state.replace(dirty, pipeline.validate(result, Scope(dirty)))

    return ApplyCrResponse(
        model=ModelOut.from_core(result),
        issues=[IssueOut.from_core(i) for i in state.all_issues()],
    )


def _apply_cr_session(
    session: Session, payload: ApplyCrRequest
) -> OpsResponse | JSONResponse:
    """Session mode: apply the CR to the session model and return a delta.

    ``apply_change_request`` is pure, so the CR is applied base → result and
    on success the RESULT replaces the session model via ``set_model``. That
    bumps ``model_rev`` and clears the op log — applying a CR resets undo
    history (documented behavior: the recorded inverses describe a model
    that no longer exists, and reconstructing them from the CR is not worth
    the complexity for an action that semantically loads a new baseline).

    Validation is incremental (Phase B pattern): if the session has no
    full-run baseline yet, the BASE model is fully validated once to seed
    it (``_ensure_validation_seeded``, shared with the ops endpoints); then
    only the CR's dirty set is re-validated on the result and spliced in,
    and the splice delta is returned. The spliced store describes the
    RESULT model, so it is installed together with it via
    ``set_model(result, validation=state)``.

    Response delta: changed = CR adds + modifies in CR listing order,
    serialized in their result-model state; deleted = every base id missing
    from the result (catches anything beyond the CR's explicit deletes, in
    base insertion order). ``id_map`` is always empty — CRs carry final ids.
    """
    metamodel, base = require_model(session)
    cr = payload.cr.to_core()

    try:
        result = apply_change_request(base, cr)
    except CRConflictError as exc:
        return JSONResponse(
            status_code=409,
            content={
                "conflicts": [asdict(c) for c in exc.conflicts],
                "model_rev": session.model_rev,
            },
        )

    _gate_cr_result(metamodel, base, result, cr)

    state = _ensure_validation_seeded(session, base)
    dirty = change_request_dirty_ids(base, result, cr)
    delta = state.replace(dirty, default_pipeline().validate(result, Scope(dirty)))

    # bumps rev, clears the op log, installs the spliced store in one step
    session.set_model(result, validation=state)

    # ordered-set idiom; filtered against the result so an entity the CR
    # adds/modifies AND deletes in one request counts as deleted only
    changed_element_ids = dict.fromkeys(
        eid
        for eid in (
            *(e.id for e in cr.elements_added),
            *(m.id for m in cr.elements_modified),
        )
        if eid in result.elements
    )
    changed_relationship_ids = dict.fromkeys(
        rid
        for rid in (
            *(r.id for r in cr.relationships_added),
            *(m.id for m in cr.relationships_modified),
        )
        if rid in result.relationships
    )

    return OpsResponse(
        model_rev=session.model_rev,
        id_map={},
        changed_elements=[
            ElementOut.from_core(result.elements[eid]) for eid in changed_element_ids
        ],
        changed_relationships=[
            RelationshipOut.from_core(result.relationships[rid])
            for rid in changed_relationship_ids
        ],
        deleted_element_ids=[
            eid for eid in base.elements if eid not in result.elements
        ],
        deleted_relationship_ids=[
            rid for rid in base.relationships if rid not in result.relationships
        ],
        issues_removed_owner_ids=delta.removed_owner_ids,
        issues_added=[IssueOut.from_core(i) for i in delta.added],
        issue_counts=state.counts(),
    )


@router.post("/model/apply-cr", response_model=None)
def apply_cr(
    payload: ApplyCrRequest,
    session: Session = Depends(get_request_session),
) -> ApplyCrResponse | OpsResponse | JSONResponse:
    """Apply a change request; see the module docstring for the mode split."""
    if payload.model is not None:
        return _apply_cr_inline(session, payload.model, payload)
    return _apply_cr_session(session, payload)
