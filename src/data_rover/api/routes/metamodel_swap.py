"""Phase 6B metamodel swap: read-only sandbox diff + non-destructive rebind.

``/metamodel/diff`` validates the live model against a CANDIDATE metamodel via
a no-copy ``build_rebind_view`` (shares the instance payload, rebuilds indexes)
and returns a conformance diff. ``/metamodel/rebind`` (Task 6) changes the
model's metamodel binding as a journaled commit. Both run under the per-project
``write_mutex`` so the validation sweep can't race a concurrent commit.
"""

from __future__ import annotations

import yaml
from fastapi import APIRouter, Depends, HTTPException, Request

from data_rover.core.metamodel.loader import MetamodelError, load_metamodel_str
from data_rover.core.model.model import build_rebind_view
from data_rover.core.validation.issue import Issue
from data_rover.core.validation.pipeline import default_pipeline

from ..authz import require_membership
from ..db_models import Membership
from ..deps import Session, get_request_session, require_model
from ..schemas import IssueOut, MetamodelDiffResponse
from .ops import _ensure_validation_seeded

router = APIRouter()


async def _read_metamodel_blob(request: Request) -> str:
    """Decode a metamodel request body to a YAML blob (JSON or YAML body),
    mirroring ``routes/metamodel.py``'s ``upload_metamodel`` content handling."""
    body = (await request.body()).decode("utf-8")
    if "json" in request.headers.get("content-type", ""):
        data = await request.json() if body else {}
        return yaml.safe_dump(data)
    return body


def _issue_key(issue: Issue) -> tuple[str, str, str, tuple[str, ...]]:
    """Stable identity for diffing two validation runs (Issue has no code)."""
    return (
        issue.category.value,
        issue.severity.value,
        issue.message,
        tuple(sorted(issue.target_ids)),
    )


def _load_candidate(blob: str):  # type: ignore[return]
    try:
        return load_metamodel_str(blob)
    except (MetamodelError, yaml.YAMLError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/metamodel/diff", response_model=None)
async def diff_metamodel(
    request: Request,
    session: Session = Depends(get_request_session),
    membership: Membership = Depends(require_membership),
) -> MetamodelDiffResponse:
    _, model = require_model(session)
    candidate = _load_candidate(await _read_metamodel_blob(request))
    with session.write_mutex:
        current = _ensure_validation_seeded(session, model).all_issues()
        candidate_issues = default_pipeline().validate(
            build_rebind_view(model, candidate)
        )
    cur_by_key = {_issue_key(i): i for i in current}
    cand_by_key = {_issue_key(i): i for i in candidate_issues}
    now_failing = [v for k, v in cand_by_key.items() if k not in cur_by_key]
    now_passing = [v for k, v in cur_by_key.items() if k not in cand_by_key]
    unchanged = len(cur_by_key.keys() & cand_by_key.keys())
    return MetamodelDiffResponse(
        now_failing=[IssueOut.from_core(i) for i in now_failing],
        now_passing=[IssueOut.from_core(i) for i in now_passing],
        unchanged_count=unchanged,
        current_error_count=len(current),
        candidate_error_count=len(candidate_issues),
    )
