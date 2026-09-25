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
candidate.

``POST /rules/parse`` answers the same way for the engine: the rule set's
normalized document, or the one parse error lint gives. It reads no session
and no metamodel, so it never hydrates the project; like lint, a viewer gets
a 403."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends

from data_rover.core.validation.rules.compile import RuleSetSource, compile_rule_sets
from data_rover.core.validation.rules.schema import (
    RuleSetDefinition,
    RuleSetError,
    parse_rule_set,
)

from ..authz import require_membership
from ..db_models import Membership
from ..deps import Session, get_request_session
from ..schemas import (
    LintErrorOut,
    RulesLintRequest,
    RulesLintResponse,
    RulesParseOut,
    RulesParseRequest,
    RuleWarningOut,
)

router = APIRouter()


def _lint_error(exc: RuleSetError) -> LintErrorOut:
    mark = getattr(exc.__cause__, "problem_mark", None)
    return LintErrorOut(
        message=str(exc),
        line=mark.line + 1 if mark is not None else None,
        column=mark.column + 1 if mark is not None else None,
    )


def rules_document(defn: RuleSetDefinition) -> str:
    """The rule set as the engine reads it: aliased keys, only the fields the
    author wrote, in field order. ``Infinity`` and ``NaN`` stay bare
    literals, floats keep their ``.0`` and integers stay exact."""
    return json.dumps(
        defn.model_dump(mode="python", by_alias=True, exclude_unset=True),
        ensure_ascii=False,
        separators=(",", ":"),
    )


def parse_result(yaml: str) -> RulesParseOut:
    try:
        defn = parse_rule_set(yaml)
    except RuleSetError as exc:
        return RulesParseOut(ok=False, errors=[_lint_error(exc)])
    return RulesParseOut(ok=True, document=rules_document(defn))


@router.post("/rules/lint")
def lint_rules(
    payload: RulesLintRequest,
    session: Session = Depends(get_request_session),
) -> RulesLintResponse:
    try:
        parse_rule_set(payload.yaml)
    except RuleSetError as exc:
        return RulesLintResponse(ok=False, errors=[_lint_error(exc)])
    warnings: list[RuleWarningOut] = []
    if session.metamodel is not None:
        compiled = compile_rule_sets(
            [RuleSetSource("draft", "draft", payload.yaml)], session.metamodel
        )
        warnings = [
            RuleWarningOut(rule=d.rule, message=d.reason) for d in compiled.skipped
        ]
    return RulesLintResponse(ok=True, warnings=warnings)


@router.post("/rules/parse")
def parse_rules(
    payload: RulesParseRequest,
    _membership: Membership = Depends(require_membership),
) -> RulesParseOut:
    return parse_result(payload.yaml)
