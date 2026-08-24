"""Read-only metamodel sandbox: diff + lint.

``/metamodel/diff`` validates the live model against a CANDIDATE metamodel via
a no-copy ``build_rebind_view`` (shares the instance payload, rebuilds indexes)
and returns a conformance diff, running under the per-project ``write_mutex``
so the validation sweep can't race a concurrent commit. ``/metamodel/lint``
is a cheap parse + schema check with no session/model/mutex at all.

The non-destructive rebind itself lands through the ``metamodel.rebind`` op
family under ``POST /commits`` (``routes/commits.py`` + ``metamodel_ops.py``).
"""

from __future__ import annotations

import yaml
from fastapi import APIRouter, Depends, HTTPException, Request

from data_rover.core.metamodel.diff import diff_metamodels
from data_rover.core.metamodel.loader import MetamodelError, load_metamodel_str
from data_rover.core.model.model import build_rebind_view
from data_rover.core.validation.issue import Issue

from ..authz import require_membership
from ..db_models import Membership
from ..deps import Session, get_request_session, require_model
from ..rules import candidate_pipeline
from ..schemas import (
    IssueOut,
    LintErrorOut,
    MetamodelDiffResponse,
    MetamodelLintResponse,
)
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


def _issue_key(issue: Issue) -> tuple[str, str, str, str, tuple[str, ...]]:
    """Stable identity for diffing two validation runs (Issue has no code).

    ``check`` is part of the key: two user rules can produce the same custom
    message on the same element, and without it one of them vanishes from the
    diff. Both sides are stamped by the same pipeline, so including it only
    ever splits keys, never merges distinct issues.
    """
    return (
        issue.category.value,
        issue.severity.value,
        issue.check,
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
    current_mm, model = require_model(session)
    candidate = _load_candidate(await _read_metamodel_blob(request))
    # Both metamodels are immutable (schema.py), so the structural diff needs
    # no lock — only the sandbox validation below touches the live model and
    # must stay inside the write_mutex.
    structural = diff_metamodels(current_mm, candidate)
    with session.write_mutex:
        current = _ensure_validation_seeded(session, model).all_issues()
        # The candidate side runs the session's rule SOURCES recompiled against
        # the CANDIDATE schema, so the diff reports rule flips the swap would
        # cause. A drifted rule reports nothing here and its current issues
        # land in ``now_passing``.
        candidate_issues = candidate_pipeline(session, candidate).validate(
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
        structural=structural,
    )


@router.post("/metamodel/lint")
async def lint_metamodel(
    request: Request,
    membership: Membership = Depends(require_membership),
) -> MetamodelLintResponse:
    """Parse + metamodel-schema check ONLY — no session, no model, no
    ``write_mutex`` — cheap enough for the editor's debounced calls. It
    deliberately takes no ``Session`` dependency, so a cold project is not
    even hydrated. NOT in the read-only-POST allowlist: only the
    owner-gated editing flow calls it, and viewers have nothing to lint.

    ``_read_metamodel_blob`` itself is called INSIDE this try block, not
    before it: the helper is shared with ``diff_metamodel`` (whose contract
    is 422-on-bad-input, not always-200), so it must not be changed to
    swallow its own decode errors. An undecodable body
    (bad UTF-8, or malformed JSON under a JSON content-type) is exactly as
    much "the candidate text is bad" as a YAML/schema error, so it must land
    in the same always-200 result here.
    """
    try:
        blob = await _read_metamodel_blob(request)
        load_metamodel_str(blob)
    except ValueError as exc:
        # Covers UnicodeDecodeError (bytes.decode("utf-8")) and
        # json.JSONDecodeError (request.json()) raised by
        # _read_metamodel_blob before load_metamodel_str even runs — both
        # are ValueError subclasses, and both mean "candidate text is bad".
        return MetamodelLintResponse(ok=False, errors=[LintErrorOut(message=str(exc))])
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        return MetamodelLintResponse(
            ok=False,
            errors=[
                LintErrorOut(
                    message=str(exc),
                    line=mark.line + 1 if mark is not None else None,
                    column=mark.column + 1 if mark is not None else None,
                )
            ],
        )
    except MetamodelError as exc:
        return MetamodelLintResponse(ok=False, errors=[LintErrorOut(message=str(exc))])
    return MetamodelLintResponse(ok=True)
