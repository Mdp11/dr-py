"""Rules-aware validation plumbing: the ONE place the API layer builds
validation pipelines and widens dirty scopes for user-defined rules.

Thread-safety: ``CompiledRules`` is cached on the ``Session`` and swapped
atomically (never mutated in place, the ``eval_errors`` counter aside);
validators are built fresh per run because pipeline validators carry mutable
memo caches — see ``default_pipeline``'s docstring. Nothing here may raise on
a rules condition: a project with no rule artifacts must behave exactly as it
does without this module.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from data_rover.core.validation.pipeline import ValidationPipeline, default_validators
from data_rover.core.validation.rules.compile import (
    CompiledRules,
    RuleSetSource,
    applies_type_names,
    compile_rule_sets,
    empty_compiled,
)
from data_rover.core.validation.rules.reach import expand_scope
from data_rover.core.validation.rules.validator import RulesValidator

from . import content
from .db_models import ArtifactKind
from .schemas import CreateArtifactOp

if TYPE_CHECKING:
    from sqlalchemy.orm import Session as DbSession

    from data_rover.core.metamodel.schema import Metamodel
    from data_rover.core.model.model import Model
    from data_rover.core.validation.dirty import DirtyCollector

    from .artifact_ops import ArtifactBatchResult
    from .schemas import ArtifactOpIn
    from .session import Session

RULES_KIND_VALUE = ArtifactKind.validation_rules.value


def session_pipeline(session: Session) -> ValidationPipeline:
    """A fresh pipeline carrying the session's compiled rules.

    One per run — never cache the pipeline (or its validators) on the
    session.
    """
    return ValidationPipeline(
        [*default_validators(), RulesValidator(session.compiled_rules)]
    )


def rule_sources(db: DbSession, project_id: str) -> list[RuleSetSource]:
    rows = content.list_artifacts(db, project_id, ArtifactKind.validation_rules)
    return [
        RuleSetSource(row.id, row.name, str(row.payload.get("yaml", "")))
        for row in rows
    ]


def load_compiled_rules(
    db: DbSession, project_id: str, metamodel: Metamodel | None
) -> CompiledRules:
    if metamodel is None:
        return empty_compiled()
    return compile_rule_sets(rule_sources(db, project_id), metamodel)


def expand_dirty(session: Session, model: Model, dirty: DirtyCollector) -> None:
    """Widen a mutation's dirty set to the elements user rules can reach."""
    extra = expand_scope(model, session.compiled_rules, list(dirty.ids))
    if extra:
        dirty.update(extra)


def rules_touched(
    db: DbSession,
    artifact_ops: Sequence[ArtifactOpIn],
    art_res: ArtifactBatchResult | None,
) -> bool:
    """Did this artifact batch create, change, or delete a rule set?"""
    for op in artifact_ops:
        if isinstance(op, CreateArtifactOp) and op.artifact_kind == RULES_KIND_VALUE:
            return True
    if art_res is None:
        return False
    for header in art_res.deleted:
        if header.get("kind") == RULES_KIND_VALUE:
            return True
    for aid in art_res.changed_ids:
        row = content.get_artifact(db, aid)
        if row is not None and row.kind is ArtifactKind.validation_rules:
            return True
    return False


def applies_population(model: Model, *compiled: CompiledRules) -> list[str]:
    """Every element a rule in ``compiled`` applies to, deterministically
    ordered. The applies-to closures are already subtype-expanded, so each
    member is an exact ``elements_by_type`` key."""
    out: dict[str, None] = {}
    for type_name in sorted(applies_type_names(*compiled)):
        for eid in sorted(model.indexes.elements_by_type.get(type_name, ())):
            out[eid] = None
    return list(out)
