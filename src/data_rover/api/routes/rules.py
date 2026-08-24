"""Rules lint: parse + schema + drift check for the editor's debounced calls.

Sibling of POST /metamodel/lint: cheap (no model iteration, no write_mutex),
deliberately NOT in the read-only-POST allowlist — only the editing flow
lints, and viewers have nothing to lint.

Always-200 covers LINT RESULTS, not the request envelope: any well-formed
body (a string ``yaml``, of any content — unparseable YAML, schema-violating
YAML, drifted rules, a bare scalar, a list, an empty document) reaches
``lint_rules`` and gets a 200. A malformed envelope (missing/non-string
``yaml``, invalid JSON, an oversized ``yaml``) never reaches it — FastAPI's
request validation 422s first, because the envelope is a client contract,
not a lint candidate, unlike ``/metamodel/lint`` whose raw body IS the
candidate."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from data_rover.core.validation.rules.compile import RuleSetSource, compile_rule_sets
from data_rover.core.validation.rules.schema import RuleSetError, parse_rule_set

from ..deps import Session, get_request_session
from ..schemas import (
    LintErrorOut,
    RulesLintRequest,
    RulesLintResponse,
    RuleWarningOut,
)

router = APIRouter()


@router.post("/rules/lint")
def lint_rules(
    payload: RulesLintRequest,
    session: Session = Depends(get_request_session),
) -> RulesLintResponse:
    try:
        parse_rule_set(payload.yaml)
    except RuleSetError as exc:
        cause = exc.__cause__
        mark = getattr(cause, "problem_mark", None)
        return RulesLintResponse(
            ok=False,
            errors=[
                LintErrorOut(
                    message=str(exc),
                    line=mark.line + 1 if mark is not None else None,
                    column=mark.column + 1 if mark is not None else None,
                )
            ],
        )
    warnings: list[RuleWarningOut] = []
    if session.metamodel is not None:
        compiled = compile_rule_sets(
            [RuleSetSource("draft", "draft", payload.yaml)], session.metamodel
        )
        warnings = [
            RuleWarningOut(rule=d.rule, message=d.reason) for d in compiled.skipped
        ]
    return RulesLintResponse(ok=True, warnings=warnings)
