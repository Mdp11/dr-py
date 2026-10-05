"""Read-only metamodel sandbox: structural diff + lint.

``/metamodel/structural-diff`` diffs the live metamodel document against a
candidate, with no model and no mutex. ``/metamodel/lint`` is a cheap parse +
schema check with no project state, model or mutex at all.

The non-destructive rebind itself lands through the ``metamodel.rebind`` op
family under ``POST /commits`` (``routes/commits.py`` + ``metamodel_ops.py``).
"""

from __future__ import annotations

import yaml
from fastapi import APIRouter, Depends, HTTPException, Request

from data_rover.core.metamodel.diff import MetamodelStructuralDiff, diff_metamodels
from data_rover.core.metamodel.loader import MetamodelError, load_metamodel_str

from ..authz import require_membership
from ..db_models import Membership
from ..deps import require_metamodel
from ..project_state import ProjectState, get_project_state
from ..schemas import (
    LintErrorOut,
    MetamodelLintResponse,
)

router = APIRouter()


async def _read_metamodel_blob(request: Request) -> str:
    """Decode a metamodel request body to a YAML blob (JSON or YAML body),
    mirroring ``routes/metamodel.py``'s ``upload_metamodel`` content handling."""
    body = (await request.body()).decode("utf-8")
    if "json" in request.headers.get("content-type", ""):
        data = await request.json() if body else {}
        return yaml.safe_dump(data)
    return body


def _load_candidate(blob: str):  # type: ignore[return]
    try:
        return load_metamodel_str(blob)
    except (MetamodelError, yaml.YAMLError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/metamodel/structural-diff", response_model=None)
async def structural_diff_metamodel(
    request: Request,
    state: ProjectState = Depends(get_project_state),
    membership: Membership = Depends(require_membership),
) -> MetamodelStructuralDiff:
    """The document diff: no model, no mutex. NOT in the read-only-POST
    allowlist, like lint: only the
    owner-gated editing flow previews a candidate this way. An undecodable
    body or an unconstructible YAML scalar is a bad candidate, 422 like any
    other."""
    current_mm = require_metamodel(state)
    try:
        candidate = _load_candidate(await _read_metamodel_blob(request))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return diff_metamodels(current_mm, candidate)


@router.post("/metamodel/lint")
async def lint_metamodel(
    request: Request,
    membership: Membership = Depends(require_membership),
) -> MetamodelLintResponse:
    """Parse + metamodel-schema check ONLY — no project state, no model, no
    ``write_mutex`` — cheap enough for the editor's debounced calls. It
    deliberately takes no ``ProjectState`` dependency, so a cold project is not
    even loaded. NOT in the read-only-POST allowlist: only the
    owner-gated editing flow calls it, and viewers have nothing to lint.

    ``_read_metamodel_blob`` itself is called INSIDE this try block, not
    before it: the helper is shared with
    ``structural_diff_metamodel`` (whose contract is 422-on-bad-input, not
    always-200), so it must not be changed to
    swallow its own decode errors. An undecodable body
    (bad UTF-8, or malformed JSON under a JSON content-type) is exactly as
    much "the candidate text is bad" as a YAML/schema error, so it must land
    in the same always-200 result here.
    """
    try:
        blob = await _read_metamodel_blob(request)
        document = load_metamodel_str(blob)
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
    return MetamodelLintResponse(ok=True, document=document)
