"""Snippet authoring endpoints: POST /snippets/lint|format and GET /snippets/docs.

Scripts run in the browser engine; the server only lints, formats and documents
them. None of these routes touches the model."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from data_rover.core.script.docs import get_facade_docs
from data_rover.core.script.lint import derive_entry_points, lint_code

from ..authz import require_membership
from ..db_models import Membership
from ..schemas import (
    DiagnosticOut,
    FacadeDocEntryOut,
    SnippetDocsOut,
    SnippetFormatIn,
    SnippetFormatOut,
    SnippetLimitsOut,
    SnippetLintIn,
    SnippetLintOut,
)
from ..script_format import (
    FormatSyntaxError,
    FormatTimeout,
    FormatUnavailable,
    format_code,
)
from ..settings import Settings, get_settings

router = APIRouter()


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


@router.post("/snippets/format")
def format_snippet_code(
    payload: SnippetFormatIn,
    _membership: Membership = Depends(require_membership),
    settings: Settings = Depends(get_settings),
) -> SnippetFormatOut:
    """Reformat a snippet with ``ruff format``.

    Read-only (listed in ``authz._READ_ONLY_POST_SUFFIXES``): it never touches
    ``session.model``, so a viewer may format their own draft. A missing
    formatter is a 503 — degraded, never a 500.
    """
    try:
        result = format_code(payload.code, timeout_s=settings.snippet_format_timeout_s)
    except FormatSyntaxError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (FormatUnavailable, FormatTimeout) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return SnippetFormatOut(code=result.code, changed=result.changed)


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


#: The limits the browser engine's script runner enforces, shown in the docs.
_SNIPPET_LIMITS = SnippetLimitsOut(
    wall_timeout_s=10,
    memory_bytes=256 * 1024 * 1024,
    stdout_bytes=256 * 1024,
    result_repr_bytes=64 * 1024,
    max_ops=1000,
    max_op_bytes=1024 * 1024,
    page_limit=500,
)


@router.get("/snippets/docs")
def snippet_docs(
    _membership: Membership = Depends(require_membership),
) -> SnippetDocsOut:
    """Structured snippet-authoring docs: the facade reference extracted from
    the facade source itself, the engine's limits, and static notes."""
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
        limits=_SNIPPET_LIMITS,
        notes=_SNIPPET_DOC_NOTES,
    )
