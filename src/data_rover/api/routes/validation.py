from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, Depends

from data_rover.core.validation.issue import Issue
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState

from ..deps import Session, get_request_session, require_model
from ..schemas import IssueOut, ValidateRequest
from ._snapshot import _build_model_from_payload

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


@router.post("/model/validate")
def validate_model(
    payload: ValidateRequest | None = None,
    session: Session = Depends(get_request_session),
) -> list[IssueOut]:
    metamodel, current = require_model(session)
    if payload is not None and payload.inline is not None:
        model = _build_model_from_payload(
            metamodel,
            payload.inline.elements,
            payload.inline.relationships,
        )
    else:
        model = current
    scope = (
        Scope(payload.scope) if payload and payload.scope is not None else Scope.all()
    )
    issues = default_pipeline().validate(model, scope)
    if model is current and scope.is_all:
        # seed the session issue store so incremental paths (Phase C) can
        # delta from this full run instead of re-validating the whole model
        state = ValidationState()
        state.set_full(issues)
        session.validation = state
    return [IssueOut.from_core(i) for i in issues]
