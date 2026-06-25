from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from data_rover.core.validation.issue import Issue
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState, issue_owner

from ..deps import Session, get_request_session, require_model
from ..schemas import IssueOut, ValidateRequest
from ._snapshot import _build_model_from_payload
from .ops import _apply_batch, _ensure_validation_seeded, _rollback

router = APIRouter()


def _issue_key(issue: Issue) -> tuple[str, str, tuple[str, ...], str]:
    """Content identity used to match an issue across two validation runs.

    The pipeline emits ``target_ids`` owner-first deterministically, so the
    same rule on the same entities yields the same tuple across runs.
    """
    return (
        issue.severity.value,
        issue.message,
        tuple(issue.target_ids),
        issue.category.value,
    )


def classify_issue_origins(
    committed: list[Issue], working: list[Issue]
) -> list[IssueOut]:
    """Tag working-state issues against the committed baseline (multiset-matched).

    Every ``working`` issue is tagged ``on_server`` if it has a matching
    committed counterpart (consumed one-for-one) else ``uncommitted``; every
    committed issue with no working counterpart is appended as ``resolved``.

    Output ordering: working-state issues come first (in ``working`` order),
    then ``resolved`` issues are appended (in ``committed`` order).
    """
    committed_counts: Counter[tuple[str, str, tuple[str, ...], str]] = Counter(
        _issue_key(i) for i in committed
    )
    seen: Counter[tuple[str, str, tuple[str, ...], str]] = Counter()
    out: list[IssueOut] = []
    for issue in working:
        key = _issue_key(issue)
        seen[key] += 1
        origin = "on_server" if seen[key] <= committed_counts[key] else "uncommitted"
        out.append(IssueOut.from_core(issue, origin=origin))
    remaining = committed_counts - seen  # multiset difference keeps positives only
    for issue in committed:
        key = _issue_key(issue)
        if remaining[key] > 0:
            remaining[key] -= 1
            out.append(IssueOut.from_core(issue, origin="resolved"))
    return out


@router.post("/model/validate", response_model=None)
def validate_model(
    payload: ValidateRequest | None = None,
    session: Session = Depends(get_request_session),
) -> list[IssueOut] | JSONResponse:
    metamodel, current = require_model(session)

    # 1. Inline-snapshot path (unchanged): validate a client-provided model.
    if payload is not None and payload.inline is not None:
        model = _build_model_from_payload(
            metamodel,
            payload.inline.elements,
            payload.inline.relationships,
        )
        scope = Scope(payload.scope) if payload.scope is not None else Scope.all()
        issues = default_pipeline().validate(model, scope)
        return [IssueOut.from_core(i) for i in issues]

    # 2. Staged path: validate the committed model WITH the client's uncommitted
    #    ops applied, then tag each issue's origin against the committed baseline.
    if payload is not None and payload.ops:
        if payload.base_rev is not None and payload.base_rev != session.model_rev:
            return JSONResponse(
                status_code=409,
                content={"detail": "stale base_rev", "model_rev": session.model_rev},
            )
        # committed baseline = the session's maintained issue store (seeded on first
        # use). Reused, not recomputed: avoids a full O(model) pass per Validate and
        # avoids a racy session.validation reassignment outside the write mutex.
        state = _ensure_validation_seeded(session, current)
        committed = state.all_issues()
        # apply -> scoped re-validate -> roll back, under the write mutex. On a
        # mutation-boundary error _apply_batch self-rolls-back and raises 422.
        with session.write_mutex:
            res = _apply_batch(current, payload.ops, restore=False)
            try:
                scoped = default_pipeline().validate(current, res.dirty.to_scope())
            finally:
                _rollback(current, res.inverse_units)
        dirty_ids = set(res.dirty.ids)
        # working full set = committed issues OUTSIDE the dirty scope ∪ the fresh
        # dirty-scope issues (what state.replace would yield, computed purely).
        working = [i for i in committed if issue_owner(i) not in dirty_ids]
        working.extend(scoped)
        return classify_issue_origins(committed, working)

    # 3. No ops, no inline: full validation of the committed session model.
    scope = (
        Scope(payload.scope) if payload and payload.scope is not None else Scope.all()
    )
    issues = default_pipeline().validate(current, scope)
    if scope.is_all:
        state = ValidationState()
        state.set_full(issues)
        session.validation = state
    return [IssueOut.from_core(i) for i in issues]
